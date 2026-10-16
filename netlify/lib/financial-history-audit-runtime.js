'use strict';

/**
 * Production dry-run I/O for historical financial audit.
 * Reads only: Blob list/get, Postgres SELECT in a READ ONLY transaction,
 * Stripe PaymentIntent retrieve/GET.
 */

const crypto = require('crypto');
const { getPrisma } = require('./prisma');
const { blobsStore } = require('./tech-security');
const {
  classifyBooking,
  collectPaymentIntentIds,
  emptyTotals,
  addClassification,
} = require('./financial-history-audit');

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const STRIPE_CONCURRENCY = 3;
const INTERNAL_TIMEOUT_MS = 20_000;
const BLOB_STORE = 'cd1-bookings';
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
]);

function cursorSecret(env) {
  const primary = String(env.ADMIN_SESSION_SECRET || '').trim();
  return primary;
}

function cursorKey(env) {
  const secret = cursorSecret(env);
  if (!secret) return null;
  return crypto.createHash('sha256').update(`${secret}:financial-reconciliation-audit-cursor`).digest();
}

function auditRefFor(bookingId, env) {
  const secret = cursorSecret(env);
  if (!secret || !bookingId) return null;
  return crypto.createHmac('sha256', secret).update(`audit-ref:${bookingId}`).digest('base64url');
}

function encodeCursor(lastKey, env) {
  const key = cursorKey(env);
  if (!key || lastKey == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const payload = Buffer.from(JSON.stringify({ v: 1, k: String(lastKey), t: Date.now() }), 'utf8');
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

function decodeCursor(token, env) {
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
    if (!payload || payload.v !== 1 || typeof payload.k !== 'string') {
      return { ok: false, error: 'invalid_cursor' };
    }
    return { ok: true, lastKey: payload.k };
  } catch {
    return { ok: false, error: 'invalid_cursor' };
  }
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
      if (name === '$executeRaw' || name === '$executeRawUnsafe') {
        return async (...args) => {
          const sql = String(args[0] && args[0].strings ? args[0].strings.join('?') : args[0] || '');
          if (!/^\s*SET TRANSACTION READ ONLY\s*$/i.test(sql)) {
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
  if (!/^\/v1\/payment_intents\/pi_[A-Za-z0-9_]+$/.test(parsed.pathname)) {
    writes.push('stripe.invalid_path');
    throw new Error('write_forbidden');
  }
}

async function listBookingKeys(store, afterKey) {
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
  const keys = [...new Set(blobs.map((row) => String(row.key || row)).filter(Boolean))].sort();
  if (!afterKey) return keys;
  const idx = keys.findIndex((key) => key === afterKey);
  if (idx < 0) return keys.filter((key) => key > afterKey);
  return keys.slice(idx + 1);
}

async function readPostgresBundle(prisma, bookingIds) {
  if (!bookingIds.length) {
    return { byId: new Map() };
  }
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
    const bundle = byId.get(booking.id) || { paymentAttempts: [], ledgerEntries: [], refundRequests: [], stripeEvents: [] };
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
  let decoded = { ok: true, lastKey: null };
  if (cursor) {
    decoded = decodeCursor(cursor, env);
    if (!decoded.ok) return { ok: false, error: 'invalid_cursor', statusCode: 400, writes };
  }

  let store;
  try {
    store = wrapReadOnlyStore(await storeFactory(BLOB_STORE), writes);
  } catch {
    return { ok: false, error: 'blob_unavailable', statusCode: 503, writes, partial: true };
  }

  let keys;
  try {
    keys = await listBookingKeys(store, decoded.lastKey);
  } catch {
    return { ok: false, error: 'blob_unavailable', statusCode: 503, writes, partial: true };
  }

  const seen = new Set();
  const pageKeys = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    pageKeys.push(key);
    if (pageKeys.length >= pageLimit) break;
  }

  const blobs = [];
  for (const key of pageKeys) {
    if (Date.now() >= deadlineMs) {
      totals.partial = true;
      break;
    }
    let record = null;
    try {
      record = await store.get(key, { type: 'json' });
    } catch {
      return { ok: false, error: 'blob_unavailable', statusCode: 503, writes, partial: true, totals };
    }
    if (record && typeof record === 'object') {
      if (!record.id && !record.bookingId) record = { ...record, id: key };
      blobs.push({ key, record });
    }
  }

  let prisma;
  try {
    prisma = wrapReadOnlyPrisma(prismaFactory(), writes);
  } catch {
    return { ok: false, error: 'postgres_unavailable', statusCode: 503, writes, partial: true };
  }

  let postgresById;
  try {
    const bundle = await readPostgresBundle(prisma, blobs.map((row) => String(row.record.id || row.record.bookingId || row.key)));
    postgresById = bundle.byId;
  } catch {
    return { ok: false, error: 'postgres_unavailable', statusCode: 503, writes, partial: true };
  }

  const intentIds = new Set();
  for (const row of blobs) {
    const bookingId = String(row.record.id || row.record.bookingId || row.key);
    for (const id of collectPaymentIntentIds(row.record, postgresById.get(bookingId))) {
      intentIds.add(id);
    }
  }

  const stripeById = {};
  let stripeErrors = 0;
  const ids = [...intentIds];
  if (ids.length && !stripeSecret) {
    return { ok: false, error: 'stripe_not_configured', statusCode: 503, writes, partial: true };
  }
  try {
    const retrieved = await mapPool(ids, STRIPE_CONCURRENCY, async (id) => {
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
      if (row.error) stripeErrors += 1;
    }
  } catch {
    return { ok: false, error: 'stripe_unavailable', statusCode: 503, writes, partial: true };
  }

  const processedKeys = [];
  for (const row of blobs) {
    const bookingId = String(row.record.id || row.record.bookingId || row.key);
    const postgres = postgresById.get(bookingId) || { booking: null, paymentAttempts: [], ledgerEntries: [] };
    const known = collectPaymentIntentIds(row.record, postgres);
    const subset = {};
    let localStripeErrors = 0;
    for (const id of known) {
      subset[id] = stripeById[id] || { id, found: false, missing: false, error: 'missing_lookup' };
      if (subset[id].error) localStripeErrors += 1;
    }
    const classified = classifyBooking({
      blob: row.record,
      postgres,
      stripeById: subset,
      stripeErrors: localStripeErrors,
    });
    // auditRef is derived for operator continuation tooling and is never persisted
    // or returned. Computing it here proves HMAC availability without leaking ids.
    auditRefFor(bookingId, env);
    addClassification(totals, classified, bookingAgeMs(row.record, nowMs));
    processedKeys.push(row.key);
  }

  totals.stripeErrors += stripeErrors;
  const lastKey = processedKeys.length ? processedKeys[processedKeys.length - 1] : decoded.lastKey;
  const more = keys.length > pageKeys.length || (totals.partial && processedKeys.length < pageKeys.length);
  const nextCursor = more && lastKey ? encodeCursor(lastKey, env) : null;
  return {
    ok: true,
    dryRun: true,
    writes,
    totals,
    nextCursor,
    partial: !!totals.partial || stripeErrors > 0,
    hasMore: !!nextCursor,
  };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  INTERNAL_TIMEOUT_MS,
  WRITE_METHODS,
  encodeCursor,
  decodeCursor,
  auditRefFor,
  wrapReadOnlyPrisma,
  wrapReadOnlyStore,
  assertStripeGet,
  runDryRunPage,
};
