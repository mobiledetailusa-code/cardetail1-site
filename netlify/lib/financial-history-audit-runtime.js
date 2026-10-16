'use strict';

/**
 * Production dry-run I/O for historical financial audit.
 * Reads only: Blob list/get, Postgres SELECT in a READ ONLY transaction,
 * Stripe PaymentIntent GET list/retrieve/search.
 */

const crypto = require('crypto');
const { getPrisma } = require('./prisma');
const { blobsStore } = require('./tech-security');
const {
  classifyBooking,
  classifyOrphanProviderIntent,
  collectPaymentIntentIds,
  emptyTotals,
  addClassification,
  candidateFromResult,
  mergeUniverse,
  pageSortedIds,
  coverageWindow,
  looksLikeCardetail1BookingId,
  OBSERVED_PURPOSES,
} = require('./financial-history-audit');

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const STRIPE_CONCURRENCY = 3;
const STRIPE_LIST_LIMIT = 100;
const MAX_STRIPE_PAGES_PER_REQUEST = 3;
const MAX_STORED_INTENTS = 400;
const INTERNAL_TIMEOUT_MS = 20_000;
const BLOB_STORE = 'cd1-bookings';
const PURPOSE_REF = 'financial-audit-v1';
const PURPOSE_CURSOR = 'financial-audit-v1-cursor';
const WRITE_METHODS = new Set([
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
  'setJSON',
  'set',
  'compareAndSwap',
  'append',
]);

function cursorSecret(env) {
  return String((env && env.ADMIN_SESSION_SECRET) || '').trim();
}

function derivePurposeKey(secret, purpose) {
  if (!secret) return null;
  return crypto.createHmac('sha256', String(secret)).update(String(purpose)).digest();
}

function cursorKey(env) {
  return derivePurposeKey(cursorSecret(env), PURPOSE_CURSOR);
}

function auditRefFor(internalId, env) {
  const key = derivePurposeKey(cursorSecret(env), PURPOSE_REF);
  if (!key || !internalId) return null;
  return crypto.createHmac('sha256', key).update(String(internalId)).digest('base64url');
}

function newExecutionId() {
  return crypto.randomUUID();
}

function encodeCursor(state, env) {
  const key = cursorKey(env);
  if (!key || !state) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const payload = Buffer.from(JSON.stringify({
    v: 2,
    exec: String(state.exec || ''),
    s: String(state.s || ''),
    f: String(state.f || ''),
    localAfter: state.localAfter == null ? null : String(state.localAfter),
    stripeAfter: state.stripeAfter == null ? null : String(state.stripeAfter),
    stripeDone: !!state.stripeDone,
    localDone: !!state.localDone,
    listed: Array.isArray(state.listed) ? state.listed : [],
  }), 'utf8');
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

function decodeCursor(token, env, coverage) {
  const key = cursorKey(env);
  if (!key || !token) return { ok: false, error: 'invalid_cursor' };
  try {
    const buf = Buffer.from(String(token), 'base64url');
    if (buf.length < 29) return { ok: false, error: 'invalid_cursor' };
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const encrypted = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    const payload = JSON.parse(plain);
    if (!payload || payload.v !== 2 || !payload.exec || !payload.s || !payload.f) {
      return { ok: false, error: 'invalid_cursor' };
    }
    if (coverage && payload.s !== coverage.coverageStartedAt) {
      return { ok: false, error: 'cursor_execution_mismatch' };
    }
    return {
      ok: true,
      state: {
        exec: payload.exec,
        s: payload.s,
        f: payload.f,
        localAfter: payload.localAfter || null,
        stripeAfter: payload.stripeAfter || null,
        stripeDone: !!payload.stripeDone,
        localDone: !!payload.localDone,
        listed: Array.isArray(payload.listed) ? payload.listed : [],
      },
    };
  } catch {
    return { ok: false, error: 'invalid_cursor' };
  }
}

function isSafeReadSql(sql) {
  const text = String(sql || '').replace(/^\s+/, '');
  if (!text) return false;
  if (/^\s*SET\s+TRANSACTION\s+READ\s+ONLY\s*;?\s*$/i.test(text)) return true;
  if (/^\s*SELECT\b/i.test(text)) {
    return !/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE|GRANT|COPY|DO)\b/i.test(text);
  }
  if (/^\s*WITH\b/i.test(text)) {
    return !/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE|GRANT|COPY|DO)\b/i.test(text);
  }
  return false;
}

function sqlFromRawArgs(args) {
  const first = args && args[0];
  if (first && Array.isArray(first.strings)) return first.strings.join('?');
  return String(first || '');
}

function wrapReadOnlyPrisma(prisma, writes) {
  const wrapModel = (model) => new Proxy(model, {
    get(target, prop) {
      if (WRITE_METHODS.has(String(prop))) {
        return async () => {
          writes.push(`prisma.${String(prop)}`);
          throw new Error('write_forbidden');
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const wrapClient = (client) => new Proxy(client, {
    get(target, prop) {
      const name = String(prop);
      if (WRITE_METHODS.has(name)) {
        writes.push(`prisma.${name}`);
        throw new Error('write_forbidden');
      }
      if (
        name === '$executeRaw'
        || name === '$executeRawUnsafe'
        || name === '$queryRaw'
        || name === '$queryRawUnsafe'
      ) {
        return async (...args) => {
          const sql = sqlFromRawArgs(args);
          if (!isSafeReadSql(sql)) {
            writes.push(`prisma.${name}`);
            throw new Error('write_forbidden');
          }
          if (typeof target[name] === 'function') return target[name](...args);
          return { ok: true };
        };
      }
      if (name === '$transaction') {
        return async (fn, opts) => {
          if (typeof fn !== 'function') {
            writes.push('prisma.$transaction');
            throw new Error('write_forbidden');
          }
          return target.$transaction((tx) => fn(wrapClient(tx)), opts);
        };
      }
      const value = target[prop];
      if (value && typeof value === 'object' && !name.startsWith('$')) {
        return wrapModel(value);
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return wrapClient(prisma);
}

function wrapReadOnlyStore(store, writes) {
  return new Proxy(store, {
    get(target, prop) {
      const name = String(prop);
      if (WRITE_METHODS.has(name) || name === 'setJSON') {
        return async () => {
          writes.push(`blob.${name}`);
          throw new Error('write_forbidden');
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function assertStripeGet(url, method, writes) {
  const verb = String(method || 'GET').toUpperCase();
  if (verb !== 'GET') {
    writes.push(`stripe.${verb}`);
    throw new Error('write_forbidden');
  }
  let parsed;
  try { parsed = new URL(String(url || '')); } catch {
    writes.push('stripe.invalid_url');
    throw new Error('write_forbidden');
  }
  if (parsed.origin !== 'https://api.stripe.com') {
    writes.push('stripe.invalid_host');
    throw new Error('write_forbidden');
  }
  const path = parsed.pathname;
  const list = path === '/v1/payment_intents';
  const search = path === '/v1/payment_intents/search';
  const retrieve = /^\/v1\/payment_intents\/pi_[A-Za-z0-9_]+$/.test(path);
  if (!list && !search && !retrieve) {
    writes.push('stripe.invalid_path');
    throw new Error('write_forbidden');
  }
}

function compactListed(row) {
  return {
    i: row.id,
    b: String(row.metadataBookingId || ''),
    a: Math.round(Number(row.amountReceived) || 0),
    s: String(row.status || ''),
    p: String(row.metadataPurpose || ''),
    r: Math.round(Number(row.refundedAmount) || 0),
    c: String(row.currency || ''),
    d: !!row.disputed,
    f: !!row.found,
    m: !!row.missing,
    e: row.error ? String(row.error) : '',
  };
}

function expandListed(row) {
  return {
    id: row.i,
    found: row.f !== false,
    missing: !!row.m,
    status: row.s,
    amountReceived: row.a,
    currency: row.c,
    metadataBookingId: row.b,
    metadataPurpose: row.p,
    refundedAmount: row.r,
    disputed: !!row.d,
    error: row.e || undefined,
  };
}

function isCardetail1Intent(payload) {
  const metadata = payload && payload.metadata && typeof payload.metadata === 'object'
    ? payload.metadata
    : {};
  const bookingId = String(metadata.bookingId || metadata.booking_id || '').trim();
  const purpose = String(metadata.purpose || '').trim();
  const desc = [
    payload && payload.statement_descriptor,
    payload && payload.statement_descriptor_suffix,
    payload && payload.description,
  ].filter(Boolean).join(' ');
  if (looksLikeCardetail1BookingId(bookingId)) return true;
  if (OBSERVED_PURPOSES.has(purpose)) return true;
  if (/cardetail1|\bcd1[-_]/i.test(desc)) return true;
  return false;
}

async function listBookingKeys(store) {
  const blobs = [];
  if (!store || typeof store.list !== 'function') {
    throw new Error('blob_unavailable');
  }
  const paged = store.list({ paginate: true });
  if (paged && typeof paged[Symbol.asyncIterator] === 'function') {
    for await (const page of paged) {
      blobs.push(...((page && page.blobs) || []));
    }
  } else {
    const listing = await store.list();
    blobs.push(...((listing && listing.blobs) || []));
  }
  return [...new Set(blobs.map((row) => String(row.key || row)).filter(Boolean))].sort();
}

async function readLocalUniverse(prisma) {
  const run = async (tx) => {
    if (typeof tx.$executeRawUnsafe === 'function') {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    } else if (typeof tx.$executeRaw === 'function') {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    }
    const bookings = await tx.booking.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
    const paymentAttempts = await tx.paymentAttempt.findMany({
      select: { bookingId: true, providerObjectId: true },
    });
    const ledgerEntries = await tx.ledgerEntry.findMany({
      select: { bookingId: true, providerObjectId: true },
    });
    const stripeEvents = await tx.stripeEvent.findMany({ select: { bookingId: true } });
    return { bookings, paymentAttempts, ledgerEntries, stripeEvents };
  };
  return typeof prisma.$transaction === 'function'
    ? prisma.$transaction(run, { timeout: 15_000, isolationLevel: 'RepeatableRead' })
    : run(prisma);
}

async function readPostgresBundle(prisma, bookingIds) {
  if (!bookingIds.length) return { byId: new Map() };
  const run = async (tx) => {
    if (typeof tx.$executeRawUnsafe === 'function') {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    } else if (typeof tx.$executeRaw === 'function') {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    }
    const bookings = await tx.booking.findMany({ where: { id: { in: bookingIds } } });
    const quotes = await tx.quote.findMany({ where: { bookingId: { in: bookingIds } } });
    const paymentAttempts = await tx.paymentAttempt.findMany({ where: { bookingId: { in: bookingIds } } });
    const ledgerEntries = await tx.ledgerEntry.findMany({ where: { bookingId: { in: bookingIds } } });
    const refundRequests = await tx.refundRequest.findMany({ where: { bookingId: { in: bookingIds } } });
    const stripeEvents = await tx.stripeEvent.findMany({ where: { bookingId: { in: bookingIds } } });
    return { bookings, quotes, paymentAttempts, ledgerEntries, refundRequests, stripeEvents };
  };

  const rows = typeof prisma.$transaction === 'function'
    ? await prisma.$transaction(run, { timeout: 15_000, isolationLevel: 'RepeatableRead' })
    : await run(prisma);

  const byId = new Map();
  for (const id of bookingIds) {
    byId.set(id, {
      booking: null,
      quote: null,
      paymentAttempts: [],
      ledgerEntries: [],
      refundRequests: [],
      stripeEvents: [],
    });
  }
  for (const booking of rows.bookings || []) {
    const bundle = byId.get(booking.id) || {
      paymentAttempts: [], ledgerEntries: [], refundRequests: [], stripeEvents: [],
    };
    bundle.booking = booking;
    byId.set(booking.id, bundle);
  }
  for (const quote of rows.quotes || []) {
    const bundle = byId.get(quote.bookingId);
    if (!bundle) continue;
    if (!bundle.quote || Number(quote.quoteVersion) > Number(bundle.quote.quoteVersion)) {
      bundle.quote = quote;
    }
  }
  for (const attempt of rows.paymentAttempts || []) {
    const bundle = byId.get(attempt.bookingId);
    if (bundle) bundle.paymentAttempts.push(attempt);
  }
  for (const entry of rows.ledgerEntries || []) {
    const bundle = byId.get(entry.bookingId);
    if (bundle) bundle.ledgerEntries.push(entry);
  }
  for (const request of rows.refundRequests || []) {
    const bundle = byId.get(request.bookingId);
    if (bundle) bundle.refundRequests.push(request);
  }
  for (const event of rows.stripeEvents || []) {
    const bundle = byId.get(event.bookingId);
    if (bundle) bundle.stripeEvents.push(event);
  }
  return { byId };
}

function summarizeStripeBody(id, payload) {
  const charge = payload.latest_charge && typeof payload.latest_charge === 'object'
    ? payload.latest_charge
    : null;
  const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
  return {
    id,
    found: true,
    missing: false,
    livemode: !!payload.livemode,
    status: String(payload.status || ''),
    amount: Math.round(Number(payload.amount) || 0),
    amountReceived: Math.round(Number(
      payload.amount_received != null ? payload.amount_received : 0
    ) || 0),
    amountCapturable: Math.round(Number(payload.amount_capturable) || 0),
    currency: String(payload.currency || '').toLowerCase(),
    metadataBookingId: String(metadata.bookingId || metadata.booking_id || '').trim(),
    metadataPurpose: String(metadata.purpose || '').trim(),
    hasCustomer: !!payload.customer,
    latestChargeStatus: charge ? String(charge.status || '') : '',
    refundedAmount: Math.round(Number(
      charge && charge.amount_refunded != null ? charge.amount_refunded : payload.amount_refunded
    ) || 0),
    disputed: !!(charge && (charge.disputed || charge.dispute)),
  };
}

async function retrievePaymentIntent({ id, secret, fetchImpl, writes }) {
  const url = `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(id)}?expand[]=latest_charge`;
  assertStripeGet(url, 'GET', writes);
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (response.status === 404) {
    return { id, found: false, missing: true };
  }
  if (!response.ok) {
    return { id, found: false, missing: false, error: 'stripe_unavailable', status: response.status };
  }
  const payload = await response.json();
  return summarizeStripeBody(id, payload);
}

async function listPaymentIntentsPage({
  secret,
  fetchImpl,
  writes,
  createdGte,
  createdLte,
  startingAfter,
  limit = STRIPE_LIST_LIMIT,
}) {
  const url = new URL('https://api.stripe.com/v1/payment_intents');
  url.searchParams.set('limit', String(Math.min(100, Math.max(1, limit))));
  url.searchParams.set('created[gte]', String(Math.floor(createdGte / 1000)));
  url.searchParams.set('created[lte]', String(Math.floor(createdLte / 1000)));
  if (startingAfter) url.searchParams.set('starting_after', startingAfter);
  assertStripeGet(url.toString(), 'GET', writes);
  const response = await fetchImpl(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (!response.ok) {
    const err = new Error('stripe_unavailable');
    err.status = response.status;
    throw err;
  }
  const payload = await response.json();
  const data = Array.isArray(payload.data) ? payload.data : [];
  return {
    data,
    hasMore: !!payload.has_more,
    lastId: data.length ? String(data[data.length - 1].id || '') : startingAfter,
  };
}

async function mapPool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  async function pump() {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await worker(items[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) || 0 }, () => pump());
  await Promise.all(workers);
  return out;
}

function bookingAgeMs(blob, nowMs) {
  const stamp = Date.parse(blob && (blob.capturedAt || blob.updatedAt || blob.createdAt) || '');
  if (!Number.isFinite(stamp)) return 0;
  return Math.max(0, nowMs - stamp);
}

function coverageFlags({
  localDone,
  stripeDone,
  stripeErrors,
  postgresErrors,
  blobErrors,
  hasMore,
}) {
  const localCoverageComplete = !!localDone;
  const providerCoverageComplete = !!stripeDone && stripeErrors === 0;
  const partial = !localCoverageComplete || !providerCoverageComplete
    || stripeErrors > 0 || postgresErrors > 0 || blobErrors > 0 || !!hasMore;
  const scanComplete = localCoverageComplete && providerCoverageComplete
    && stripeErrors === 0 && postgresErrors === 0 && blobErrors === 0 && !hasMore;
  return {
    localCoverageComplete,
    providerCoverageComplete,
    providerCoverage: providerCoverageComplete ? 'complete' : 'partial',
    localCoverage: localCoverageComplete ? 'complete' : 'partial',
    partial,
    scanComplete,
  };
}

async function collectListedIntents({
  envState,
  secret,
  fetchImpl,
  writes,
  coverage,
  deadlineMs,
}) {
  const listed = Array.isArray(envState.listed) ? envState.listed.slice() : [];
  const seen = new Set(listed.map((row) => row.i));
  let stripeAfter = envState.stripeAfter || null;
  let stripeDone = !!envState.stripeDone;
  let stripeErrors = 0;
  if (stripeDone) {
    return { listed, stripeAfter, stripeDone, stripeErrors, pages: 0 };
  }
  if (!secret) {
    return { listed, stripeAfter, stripeDone: false, stripeErrors: 1, pages: 0, missingSecret: true };
  }
  let pages = 0;
  while (pages < MAX_STRIPE_PAGES_PER_REQUEST && Date.now() < deadlineMs) {
    pages += 1;
    try {
      const page = await listPaymentIntentsPage({
        secret,
        fetchImpl,
        writes,
        createdGte: Date.parse(envState.s || coverage.coverageStartedAt),
        createdLte: Date.parse(envState.f || coverage.coverageEndedAt),
        startingAfter: stripeAfter,
      });
      for (const payload of page.data) {
        if (!payload || !payload.id) continue;
        if (!isCardetail1Intent(payload)) continue;
        const summary = summarizeStripeBody(payload.id, payload);
        if (seen.has(summary.id)) continue;
        seen.add(summary.id);
        if (listed.length < MAX_STORED_INTENTS) listed.push(compactListed(summary));
      }
      stripeAfter = page.lastId || stripeAfter;
      if (!page.hasMore) {
        stripeDone = listed.length < MAX_STORED_INTENTS;
        break;
      }
      if (listed.length >= MAX_STORED_INTENTS) {
        stripeDone = false;
        break;
      }
    } catch {
      stripeErrors += 1;
      stripeDone = false;
      break;
    }
  }
  return { listed, stripeAfter, stripeDone, stripeErrors, pages };
}

async function runDryRunPage({
  env = process.env,
  cursor = null,
  limit = DEFAULT_LIMIT,
  nowMs = Date.now(),
  deadlineMs = nowMs + INTERNAL_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  storeFactory = blobsStore,
  prismaFactory = getPrisma,
  stripeSecret = env.STRIPE_SECRET_KEY,
} = {}) {
  const writes = [];
  const totals = emptyTotals();
  totals.pagesProcessed = 1;
  const pageLimit = Math.min(MAX_LIMIT, Math.max(1, Math.round(Number(limit) || DEFAULT_LIMIT)));
  const coverage = coverageWindow(env, nowMs);
  let state;
  if (cursor) {
    const decoded = decodeCursor(cursor, env, coverage);
    if (!decoded.ok) return { ok: false, error: decoded.error, statusCode: 400, writes };
    state = decoded.state;
  } else {
    state = {
      exec: newExecutionId(),
      s: coverage.coverageStartedAt,
      f: coverage.coverageEndedAt,
      localAfter: null,
      stripeAfter: null,
      stripeDone: false,
      localDone: false,
      listed: [],
    };
  }

  const candidates = [];
  let store;
  try {
    store = wrapReadOnlyStore(await storeFactory(BLOB_STORE), writes);
  } catch {
    return { ok: false, error: 'blob_unavailable', statusCode: 503, writes, partial: true };
  }

  let prisma;
  try {
    prisma = wrapReadOnlyPrisma(prismaFactory(), writes);
  } catch {
    return { ok: false, error: 'postgres_unavailable', statusCode: 503, writes, partial: true };
  }

  let blobKeys = [];
  try {
    blobKeys = await listBookingKeys(store);
  } catch {
    totals.blobErrors += 1;
    return { ok: false, error: 'blob_unavailable', statusCode: 503, writes, partial: true, totals };
  }

  let localRows;
  try {
    localRows = await readLocalUniverse(prisma);
  } catch {
    totals.postgresErrors += 1;
    return { ok: false, error: 'postgres_unavailable', statusCode: 503, writes, partial: true, totals };
  }

  const listedResult = await collectListedIntents({
    envState: state,
    secret: stripeSecret,
    fetchImpl,
    writes,
    coverage,
    deadlineMs,
  });
  if (listedResult.missingSecret && blobKeys.length) {
    return { ok: false, error: 'stripe_not_configured', statusCode: 503, writes, partial: true };
  }
  totals.stripeErrors += listedResult.stripeErrors;
  state.listed = listedResult.listed;
  state.stripeAfter = listedResult.stripeAfter;
  state.stripeDone = listedResult.stripeDone && listedResult.stripeErrors === 0;

  const stripeMetaIds = [];
  const listedById = {};
  const listedByBooking = new Map();
  for (const row of state.listed) {
    const expanded = expandListed(row);
    listedById[expanded.id] = expanded;
    if (expanded.metadataBookingId) {
      stripeMetaIds.push(expanded.metadataBookingId);
      const bucket = listedByBooking.get(expanded.metadataBookingId) || [];
      bucket.push(expanded);
      listedByBooking.set(expanded.metadataBookingId, bucket);
    }
  }

  const merged = mergeUniverse({
    blob: blobKeys,
    postgresBookings: (localRows.bookings || []).map((row) => row.id),
    paymentAttempts: (localRows.paymentAttempts || []).map((row) => row.bookingId),
    ledgerEntries: (localRows.ledgerEntries || []).map((row) => row.bookingId),
    stripeEvents: (localRows.stripeEvents || []).map((row) => row.bookingId),
    stripeMetadata: stripeMetaIds,
  });
  totals.sources = {
    blob: merged.counts.blob || 0,
    postgresBookings: merged.counts.postgresBookings || 0,
    paymentAttempts: merged.counts.paymentAttempts || 0,
    ledgerEntries: merged.counts.ledgerEntries || 0,
    stripeEvents: merged.counts.stripeEvents || 0,
    stripeMetadata: merged.counts.stripeMetadata || 0,
    union: merged.unionCount,
  };

  const providerScanIncomplete = !state.stripeDone;
  const pageIds = state.localDone
    ? []
    : pageSortedIds(merged.union, state.localAfter, pageLimit);

  let postgresById = new Map();
  try {
    const bundle = await readPostgresBundle(prisma, pageIds);
    postgresById = bundle.byId;
  } catch {
    totals.postgresErrors += 1;
    return { ok: false, error: 'postgres_unavailable', statusCode: 503, writes, partial: true, totals };
  }

  const blobsById = new Map();
  const examinedIds = [];
  for (const bookingId of pageIds) {
    if (Date.now() >= deadlineMs) {
      totals.partial = true;
      break;
    }
    try {
      const record = await store.get(bookingId, { type: 'json' });
      if (record && typeof record === 'object') {
        blobsById.set(bookingId, record.id || record.bookingId ? record : { ...record, id: bookingId });
      }
      examinedIds.push(bookingId);
    } catch {
      totals.blobErrors += 1;
      return { ok: false, error: 'blob_unavailable', statusCode: 503, writes, partial: true, totals };
    }
  }

  const intentIds = new Set();
  for (const bookingId of examinedIds) {
    const blob = blobsById.get(bookingId) || null;
    const postgres = postgresById.get(bookingId);
    for (const id of collectPaymentIntentIds(blob, postgres)) intentIds.add(id);
    for (const row of listedByBooking.get(bookingId) || []) intentIds.add(row.id);
  }

  const stripeById = { ...listedById };
  const retrieveIds = [...intentIds].filter((id) => !stripeById[id]);
  if (retrieveIds.length && !stripeSecret) {
    return { ok: false, error: 'stripe_not_configured', statusCode: 503, writes, partial: true };
  }
  try {
    const retrieved = await mapPool(retrieveIds, STRIPE_CONCURRENCY, async (id) => {
      if (Date.now() >= deadlineMs) return { id, found: false, missing: false, error: 'timeout' };
      return retrievePaymentIntent({
        id,
        secret: stripeSecret,
        fetchImpl,
        writes,
      });
    });
    for (const row of retrieved) {
      stripeById[row.id] = row;
      if (row.error) totals.stripeErrors += 1;
    }
  } catch {
    totals.stripeErrors += 1;
    return { ok: false, error: 'stripe_unavailable', statusCode: 503, writes, partial: true, totals };
  }

  const processedIds = [];
  for (const bookingId of examinedIds) {
    const blob = blobsById.get(bookingId) || null;
    const postgres = postgresById.get(bookingId) || {
      booking: null, paymentAttempts: [], ledgerEntries: [], stripeEvents: [],
    };
    const known = collectPaymentIntentIds(blob, postgres);
    const subset = {};
    let localStripeErrors = 0;
    const extraFromProvider = listedByBooking.get(bookingId) || [];
    for (const id of new Set([...known, ...extraFromProvider.map((row) => row.id)])) {
      subset[id] = stripeById[id] || { id, found: false, missing: false, error: 'missing_lookup' };
      if (subset[id].error) localStripeErrors += 1;
    }
    const classified = classifyBooking({
      blob,
      postgres,
      stripeById: subset,
      stripeErrors: localStripeErrors,
      providerScanIncomplete,
      extraSucceededFromProvider: extraFromProvider.filter((row) => (
        String(row.status) === 'succeeded' || roundSafe(row.amountReceived) > 0
      )).length,
    });
    const ref = auditRefFor(bookingId, env);
    const candidate = candidateFromResult(ref, classified);
    if (candidate) candidates.push(candidate);
    addClassification(totals, classified, bookingAgeMs(blob, nowMs));
    processedIds.push(bookingId);
  }

  if (processedIds.length) state.localAfter = processedIds[processedIds.length - 1];
  const localRemaining = !state.localDone && pageSortedIds(merged.union, state.localAfter, 1).length > 0;
  if (!localRemaining) state.localDone = true;

  if (state.localDone && state.stripeDone) {
    const unionSet = new Set(merged.union);
    const seenPi = new Set();
    for (const bookingId of merged.union) {
      // Already counted during local pages; skip re-add.
      seenPi.add(bookingId);
    }
    for (const row of state.listed) {
      const expanded = expandListed(row);
      if (expanded.metadataBookingId && unionSet.has(expanded.metadataBookingId)) continue;
      if (seenPi.has(expanded.id)) continue;
      seenPi.add(expanded.id);
      const classified = classifyOrphanProviderIntent(expanded, {
        knownLocally: false,
        providerScanIncomplete,
      });
      const ref = auditRefFor(`pi:${expanded.id}`, env);
      const candidate = candidateFromResult(ref, classified);
      if (candidate) candidates.push(candidate);
      addClassification(totals, classified, 0);
    }
  }

  const hasMore = !state.localDone || !state.stripeDone;
  const flags = coverageFlags({
    localDone: state.localDone,
    stripeDone: state.stripeDone,
    stripeErrors: totals.stripeErrors,
    postgresErrors: totals.postgresErrors,
    blobErrors: totals.blobErrors,
    hasMore,
  });
  const nextCursor = hasMore ? encodeCursor(state, env) : null;

  return {
    ok: true,
    dryRun: true,
    writes,
    totals,
    candidates,
    nextCursor,
    hasMore: !!nextCursor,
    coverageStartedAt: state.s,
    coverageEndedAt: state.f,
    ...flags,
  };
}

function roundSafe(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  INTERNAL_TIMEOUT_MS,
  MAX_STRIPE_PAGES_PER_REQUEST,
  WRITE_METHODS,
  PURPOSE_REF,
  PURPOSE_CURSOR,
  encodeCursor,
  decodeCursor,
  auditRefFor,
  derivePurposeKey,
  wrapReadOnlyPrisma,
  wrapReadOnlyStore,
  assertStripeGet,
  isSafeReadSql,
  isCardetail1Intent,
  runDryRunPage,
};
