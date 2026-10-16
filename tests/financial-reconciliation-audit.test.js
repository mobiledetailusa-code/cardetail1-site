'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createCsrfToken } = require('../netlify/lib/owner-studio/authorization');
const {
  CLASSIFICATIONS,
  dollarsToCents,
  remainingUnclamped,
  remainingClamped,
  classifyBooking,
  findForbiddenBodyKeys,
} = require('../netlify/lib/financial-history-audit');
const {
  encodeCursor,
  decodeCursor,
  auditRefFor,
  runDryRunPage,
  wrapReadOnlyPrisma,
  wrapReadOnlyStore,
  assertStripeGet,
} = require('../netlify/lib/financial-history-audit-runtime');

const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'netlify/functions/financial-reconciliation-audit.js');
const AUDIT_LIB = path.join(ROOT, 'netlify/lib/financial-history-audit.js');
const AUDIT_RT = path.join(ROOT, 'netlify/lib/financial-history-audit-runtime.js');
const SECRET = 'test-admin-session-secret-value-32chars';
const SESSION = 'sess-token-abcdef0123456789abcd';

function loadHandler(deps) {
  delete require.cache[require.resolve(FN)];
  const mod = require(FN);
  if (deps) mod.__test.setDeps(deps);
  else mod.__test.setDeps(null);
  return mod.handler;
}

function productionEvent({ body, cookie = true, csrf = true, headers = {} } = {}) {
  const h = {
    host: 'cardetail1.com',
    'x-nf-client-connection-ip': '203.0.113.10',
    'content-type': 'application/json',
    ...headers,
  };
  if (cookie) h.cookie = `cd1_admin_session=${SESSION}`;
  if (!cookie) h['x-admin-key'] = SESSION;
  if (csrf) h['x-csrf-token'] = createCsrfToken(SESSION, SECRET);
  return {
    httpMethod: 'POST',
    headers: h,
    body: JSON.stringify(body || { mode: 'dry-run', limit: 10 }),
  };
}

function fakePrisma(seed = {}) {
  const tables = {
    booking: seed.booking || [],
    quote: seed.quote || [],
    paymentAttempt: seed.paymentAttempt || [],
    ledgerEntry: seed.ledgerEntry || [],
    refundRequest: seed.refundRequest || [],
    stripeEvent: seed.stripeEvent || [],
  };
  const writes = [];
  const match = (row, where = {}) => Object.entries(where).every(([key, value]) => {
    if (value && typeof value === 'object' && Array.isArray(value.in)) return value.in.includes(row[key]);
    return row[key] === value;
  });
  const model = (name) => ({
    findMany: async ({ where } = {}) => tables[name].filter((row) => match(row, where)),
    findUnique: async () => null,
    findFirst: async ({ where } = {}) => tables[name].find((row) => match(row, where)) || null,
    create: async (args) => { writes.push(`${name}.create`); throw new Error('write_forbidden'); },
    update: async () => { writes.push(`${name}.update`); throw new Error('write_forbidden'); },
    updateMany: async () => { writes.push(`${name}.updateMany`); throw new Error('write_forbidden'); },
    upsert: async () => { writes.push(`${name}.upsert`); throw new Error('write_forbidden'); },
    delete: async () => { writes.push(`${name}.delete`); throw new Error('write_forbidden'); },
    deleteMany: async () => { writes.push(`${name}.deleteMany`); throw new Error('write_forbidden'); },
  });
  const client = {
    booking: model('booking'),
    quote: model('quote'),
    paymentAttempt: model('paymentAttempt'),
    ledgerEntry: model('ledgerEntry'),
    refundRequest: model('refundRequest'),
    stripeEvent: model('stripeEvent'),
    $executeRawUnsafe: async (sql) => ({ sql }),
    $transaction: async (fn) => fn(client),
    __writes: writes,
  };
  return client;
}

function fakeStore(records) {
  const writes = [];
  return {
    async list() {
      return { blobs: Object.keys(records).sort().map((key) => ({ key })) };
    },
    async get(key) {
      return records[key] || null;
    },
    async setJSON() { writes.push('setJSON'); throw new Error('write_forbidden'); },
    async set() { writes.push('set'); throw new Error('write_forbidden'); },
    async delete() { writes.push('delete'); throw new Error('write_forbidden'); },
    __writes: writes,
  };
}

function stripeIntent({
  id = 'pi_test_1',
  amount = 5000,
  received = 5000,
  status = 'succeeded',
  bookingId = 'CD1-AUDIT-1',
  purpose = 'authoritative_balance',
  currency = 'usd',
  refunded = 0,
  disputed = false,
} = {}) {
  return {
    id,
    livemode: true,
    status,
    amount,
    amount_received: received,
    amount_capturable: 0,
    currency,
    customer: 'cus_hidden_should_not_return',
    metadata: { bookingId, booking_id: bookingId, purpose },
    latest_charge: {
      id: 'ch_hidden',
      status: 'succeeded',
      amount_refunded: refunded,
      disputed,
    },
  };
}

function fetchMap(intents) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: (opts && opts.method) || 'GET' });
    const id = String(url).split('/payment_intents/')[1].split('?')[0];
    if (intents[id] === 'missing') {
      return { ok: false, status: 404, json: async () => ({ error: { type: 'invalid_request_error' } }) };
    }
    if (intents[id] === 'down') {
      return { ok: false, status: 500, json: async () => ({ error: { type: 'api_error' } }) };
    }
    if (!intents[id]) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => intents[id] };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const envProd = {
  CONTEXT: 'production',
  BRANCH: 'master',
  ADMIN_SESSION_SECRET: SECRET,
  STRIPE_SECRET_KEY: 'sk_live_not_used_in_unit_tests',
  ADMIN_DASH_PASSWORD: 'pw',
};

function depsFor(handlerOpts = {}) {
  return {
    env: envProd,
    verifyAdminRequest: async () => (handlerOpts.authOk === false
      ? { ok: false, error: 'unauthorized' }
      : { ok: true, username: 'admin', token: SESSION }),
    enforcePublicRateLimit: async () => ({ blocked: false, allowed: true }),
    fetchImpl: handlerOpts.fetchImpl || fetchMap({}),
    storeFactory: async () => handlerOpts.store || fakeStore({}),
    prismaFactory: () => handlerOpts.prisma || fakePrisma(),
    stripeSecret: 'sk_live_not_used_in_unit_tests',
  };
}

function blobBase(over = {}) {
  return {
    id: 'CD1-AUDIT-1',
    approvedFinalAmount: 50,
    amountPaid: 50,
    amountCapturedCents: 5000,
    paymentStatus: 'paid',
    paymentWorkflowStatus: 'payment_succeeded',
    jobStatus: 'completed_paid',
    paymentIntentId: 'pi_test_1',
    currency: 'usd',
    packageSnapshot: { pkg: 'full' },
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function pgPaid(over = {}) {
  return {
    booking: { id: 'CD1-AUDIT-1' },
    quote: { bookingId: 'CD1-AUDIT-1', quoteVersion: 1, approvedCents: 5000, currency: 'usd' },
    paymentAttempts: [{
      bookingId: 'CD1-AUDIT-1',
      quoteVersion: 1,
      purpose: 'authoritative_balance',
      providerObjectId: 'pi_test_1',
      status: 'succeeded',
      amountCents: 5000,
      currency: 'usd',
      idempotencyKey: 'legacy_authoritative_balance_CD1-AUDIT-1_1_pi_test_1',
    }],
    ledgerEntries: [{
      bookingId: 'CD1-AUDIT-1',
      kind: 'settlement',
      amountCents: 5000,
      currency: 'usd',
      providerObjectId: 'pi_test_1',
      providerEventId: 'settlement_pi_test_1',
    }],
    refundRequests: [],
    stripeEvents: [{ stripeEventId: 'evt_1', bookingId: 'CD1-AUDIT-1', type: 'payment_intent.succeeded' }],
    ...over,
  };
}

describe('financial history audit classification', () => {
  it('uses integer cents and remaining = max(0, approved - net)', () => {
    assert.equal(dollarsToCents('180.50'), 18050);
    assert.equal(dollarsToCents(40), 4000);
    assert.equal(remainingUnclamped(5000, 3000), 2000);
    assert.equal(remainingClamped(5000, 8000), 0);
    assert.equal(remainingUnclamped(5000, 8000), -3000);
  });

  it('never treats missing proof as consistent_paid', () => {
    const result = classifyBooking({
      blob: blobBase({ paymentStatus: 'paid', amountPaid: 50, paymentIntentId: null, amountCapturedCents: 0 }),
      postgres: { booking: null },
      stripeById: {},
    });
    assert.notEqual(result.classification, 'consistent_paid');
  });

  it('classifies consistent_paid', () => {
    const result = classifyBooking({
      blob: blobBase(),
      postgres: pgPaid(),
      stripeById: {
        pi_test_1: {
          id: 'pi_test_1',
          found: true,
          amountReceived: 5000,
          currency: 'usd',
          metadataBookingId: 'CD1-AUDIT-1',
          metadataPurpose: 'authoritative_balance',
          refundedAmount: 0,
        },
      },
    });
    assert.equal(result.classification, 'consistent_paid');
    assert.equal(result.values.remainingBalanceCents, 0);
  });

  it('classifies consistent_partial', () => {
    const result = classifyBooking({
      blob: blobBase({
        approvedFinalAmount: 180,
        amountPaid: 30,
        amountCapturedCents: 3000,
        paymentStatus: 'partially_paid',
        jobStatus: 'assigned',
      }),
      postgres: pgPaid({
        quote: { bookingId: 'CD1-AUDIT-1', quoteVersion: 1, approvedCents: 18000, currency: 'usd' },
        paymentAttempts: [{
          bookingId: 'CD1-AUDIT-1', quoteVersion: 1, purpose: 'customer_balance',
          providerObjectId: 'pi_test_1', status: 'succeeded', amountCents: 3000, currency: 'usd',
          idempotencyKey: 'k1',
        }],
        ledgerEntries: [{
          bookingId: 'CD1-AUDIT-1', kind: 'settlement', amountCents: 3000, currency: 'usd',
          providerObjectId: 'pi_test_1', providerEventId: 'settlement_pi_test_1',
        }],
      }),
      stripeById: {
        pi_test_1: {
          id: 'pi_test_1', found: true, amountReceived: 3000, currency: 'usd',
          metadataBookingId: 'CD1-AUDIT-1', metadataPurpose: 'customer_balance', refundedAmount: 0,
        },
      },
    });
    assert.equal(result.classification, 'consistent_partial');
    assert.equal(result.values.remainingBalanceCents, 15000);
  });

  it('classifies consistent_due', () => {
    const result = classifyBooking({
      blob: blobBase({
        amountPaid: 0, amountCapturedCents: 0, paymentStatus: 'due',
        paymentWorkflowStatus: 'awaiting_customer_payment', jobStatus: 'assigned',
        paymentIntentId: null,
      }),
      postgres: {
        booking: { id: 'CD1-AUDIT-1' },
        quote: { bookingId: 'CD1-AUDIT-1', quoteVersion: 1, approvedCents: 5000, currency: 'usd' },
        paymentAttempts: [],
        ledgerEntries: [],
      },
      stripeById: {},
    });
    assert.equal(result.classification, 'consistent_due');
  });

  it('classifies blob_paid_ledger_missing', () => {
    const result = classifyBooking({
      blob: blobBase(),
      postgres: { booking: { id: 'CD1-AUDIT-1' }, quote: { approvedCents: 5000, currency: 'usd' }, paymentAttempts: [], ledgerEntries: [] },
      stripeById: {
        pi_test_1: {
          id: 'pi_test_1', found: true, amountReceived: 5000, currency: 'usd',
          metadataBookingId: 'CD1-AUDIT-1', metadataPurpose: 'authoritative_balance', refundedAmount: 0,
        },
      },
    });
    assert.equal(result.classification, 'blob_paid_ledger_missing');
  });

  it('classifies stripe_paid_blob_due', () => {
    const result = classifyBooking({
      blob: blobBase({
        paymentStatus: 'due', paymentWorkflowStatus: 'awaiting_customer_payment',
        jobStatus: 'assigned', amountPaid: 0, amountCapturedCents: 0,
      }),
      postgres: pgPaid(),
      stripeById: {
        pi_test_1: {
          id: 'pi_test_1', found: true, amountReceived: 5000, currency: 'usd',
          metadataBookingId: 'CD1-AUDIT-1', metadataPurpose: 'authoritative_balance', refundedAmount: 0,
        },
      },
    });
    assert.equal(result.classification, 'stripe_paid_blob_due');
  });

  it('classifies captured_without_purpose', () => {
    const result = classifyBooking({
      blob: blobBase(),
      postgres: pgPaid(),
      stripeById: {
        pi_test_1: {
          id: 'pi_test_1', found: true, amountReceived: 5000, currency: 'usd',
          metadataBookingId: 'CD1-AUDIT-1', metadataPurpose: '', refundedAmount: 0,
        },
      },
    });
    assert.equal(result.classification, 'captured_without_purpose');
  });

  it('classifies amount_mismatch for overpayment', () => {
    const result = classifyBooking({
      blob: blobBase({ approvedFinalAmount: 50 }),
      postgres: pgPaid({
        quote: { bookingId: 'CD1-AUDIT-1', quoteVersion: 1, approvedCents: 5000, currency: 'usd' },
        ledgerEntries: [{
          bookingId: 'CD1-AUDIT-1', kind: 'settlement', amountCents: 8000, currency: 'usd',
          providerObjectId: 'pi_test_1', providerEventId: 'settlement_pi_test_1',
        }],
      }),
      stripeById: {
        pi_test_1: {
          id: 'pi_test_1', found: true, amountReceived: 8000, currency: 'usd',
          metadataBookingId: 'CD1-AUDIT-1', metadataPurpose: 'authoritative_balance', refundedAmount: 0,
        },
      },
    });
    assert.equal(result.classification, 'amount_mismatch');
    assert.ok(result.values.remainingUnclampedCents < 0);
  });

  it('classifies currency_mismatch', () => {
    const result = classifyBooking({
      blob: blobBase({ currency: 'cad' }),
      postgres: pgPaid(),
      stripeById: {
        pi_test_1: {
          id: 'pi_test_1', found: true, amountReceived: 5000, currency: 'cad',
          metadataBookingId: 'CD1-AUDIT-1', metadataPurpose: 'authoritative_balance', refundedAmount: 0,
        },
      },
    });
    assert.equal(result.classification, 'currency_mismatch');
  });

  it('classifies booking_mismatch', () => {
    const result = classifyBooking({
      blob: blobBase(),
      postgres: pgPaid(),
      stripeById: {
        pi_test_1: {
          id: 'pi_test_1', found: true, amountReceived: 5000, currency: 'usd',
          metadataBookingId: 'CD1-OTHER', metadataPurpose: 'authoritative_balance', refundedAmount: 0,
        },
      },
    });
    assert.equal(result.classification, 'booking_mismatch');
  });

  it('classifies duplicate_charge_confirmed', () => {
    const result = classifyBooking({
      blob: blobBase({ paymentIntentId: 'pi_test_1' }),
      postgres: pgPaid({
        paymentAttempts: [
          { bookingId: 'CD1-AUDIT-1', quoteVersion: 1, purpose: 'authoritative_balance', providerObjectId: 'pi_test_1', status: 'succeeded', amountCents: 5000, currency: 'usd', idempotencyKey: 'a' },
          { bookingId: 'CD1-AUDIT-1', quoteVersion: 1, purpose: 'authoritative_balance', providerObjectId: 'pi_test_2', status: 'succeeded', amountCents: 5000, currency: 'usd', idempotencyKey: 'b' },
        ],
        ledgerEntries: [
          { kind: 'settlement', amountCents: 5000, providerObjectId: 'pi_test_1', providerEventId: 'settlement_pi_test_1' },
          { kind: 'settlement', amountCents: 5000, providerObjectId: 'pi_test_2', providerEventId: 'settlement_pi_test_2' },
        ],
      }),
      stripeById: {
        pi_test_1: { id: 'pi_test_1', found: true, amountReceived: 5000, currency: 'usd', metadataBookingId: 'CD1-AUDIT-1', metadataPurpose: 'authoritative_balance', refundedAmount: 0 },
        pi_test_2: { id: 'pi_test_2', found: true, amountReceived: 5000, currency: 'usd', metadataBookingId: 'CD1-AUDIT-1', metadataPurpose: 'authoritative_balance', refundedAmount: 0 },
      },
    });
    assert.equal(result.classification, 'duplicate_charge_confirmed');
  });

  it('classifies duplicate_settlement_risk', () => {
    const result = classifyBooking({
      blob: blobBase(),
      postgres: pgPaid({
        paymentAttempts: [
          { bookingId: 'CD1-AUDIT-1', quoteVersion: 1, purpose: 'authoritative_balance', providerObjectId: 'pi_test_1', status: 'succeeded', amountCents: 5000, currency: 'usd', idempotencyKey: 'a' },
          { bookingId: 'CD1-AUDIT-1', quoteVersion: 1, purpose: 'authoritative_balance', providerObjectId: 'pi_test_1', status: 'open', amountCents: 5000, currency: 'usd', idempotencyKey: 'b' },
        ],
      }),
      stripeById: {
        pi_test_1: { id: 'pi_test_1', found: true, amountReceived: 5000, currency: 'usd', metadataBookingId: 'CD1-AUDIT-1', metadataPurpose: 'authoritative_balance', refundedAmount: 0 },
      },
    });
    assert.equal(result.classification, 'duplicate_settlement_risk');
  });

  it('classifies refunded_or_disputed for partial and total refunds', () => {
    const partial = classifyBooking({
      blob: blobBase(),
      postgres: pgPaid({
        ledgerEntries: [
          { kind: 'settlement', amountCents: 5000, providerObjectId: 'pi_test_1', providerEventId: 'settlement_pi_test_1' },
          { kind: 'refund', amountCents: 2000, providerObjectId: 'pi_test_1', providerEventId: 'refund_re_1' },
        ],
      }),
      stripeById: {
        pi_test_1: { id: 'pi_test_1', found: true, amountReceived: 5000, currency: 'usd', metadataBookingId: 'CD1-AUDIT-1', metadataPurpose: 'authoritative_balance', refundedAmount: 2000 },
      },
    });
    const full = classifyBooking({
      blob: blobBase({ refundStatus: 'refunded', paymentStatus: 'refunded' }),
      postgres: pgPaid({
        ledgerEntries: [
          { kind: 'settlement', amountCents: 5000, providerObjectId: 'pi_test_1', providerEventId: 'settlement_pi_test_1' },
          { kind: 'refund', amountCents: 5000, providerObjectId: 'pi_test_1', providerEventId: 'refund_re_2' },
        ],
      }),
      stripeById: {
        pi_test_1: { id: 'pi_test_1', found: true, amountReceived: 5000, currency: 'usd', metadataBookingId: 'CD1-AUDIT-1', metadataPurpose: 'authoritative_balance', refundedAmount: 5000, disputed: true },
      },
    });
    assert.equal(partial.classification, 'refunded_or_disputed');
    assert.equal(full.classification, 'refunded_or_disputed');
  });

  it('classifies cash_conflict', () => {
    const result = classifyBooking({
      blob: blobBase({ paymentStatus: 'paid_cash' }),
      postgres: pgPaid({
        ledgerEntries: [
          { kind: 'settlement', amountCents: 5000, providerObjectId: 'cash', providerEventId: 'cash_full_balance:CD1-AUDIT-1:1:0:5000' },
          { kind: 'settlement', amountCents: 5000, providerObjectId: 'pi_test_1', providerEventId: 'settlement_pi_test_1' },
        ],
      }),
      stripeById: {
        pi_test_1: { id: 'pi_test_1', found: true, amountReceived: 5000, currency: 'usd', metadataBookingId: 'CD1-AUDIT-1', metadataPurpose: 'authoritative_balance', refundedAmount: 0 },
      },
    });
    assert.equal(result.classification, 'cash_conflict');
  });

  it('classifies provider_missing', () => {
    const result = classifyBooking({
      blob: blobBase(),
      postgres: pgPaid(),
      stripeById: { pi_test_1: { id: 'pi_test_1', found: false, missing: true } },
    });
    assert.equal(result.classification, 'provider_missing');
  });

  it('classifies manual_review when Stripe is unavailable', () => {
    const result = classifyBooking({
      blob: blobBase(),
      postgres: pgPaid(),
      stripeById: { pi_test_1: { id: 'pi_test_1', found: false, missing: false, error: 'stripe_unavailable' } },
      stripeErrors: 1,
    });
    assert.equal(result.classification, 'manual_review');
  });

  it('covers every classification name', () => {
    assert.equal(CLASSIFICATIONS.length, 15);
  });
});

describe('financial history audit HTTP gates', () => {
  let savedEnv;
  beforeEach(() => {
    savedEnv = { ...process.env };
    process.env.CONTEXT = 'production';
    process.env.BRANCH = 'master';
    process.env.ADMIN_SESSION_SECRET = SECRET;
    process.env.ADMIN_DASH_PASSWORD = 'pw';
  });
  afterEach(() => {
    process.env = savedEnv;
    delete require.cache[require.resolve(FN)];
  });

  it('rejects methods other than POST', async () => {
    const handler = loadHandler(depsFor());
    const res = await handler({ httpMethod: 'GET', headers: { host: 'cardetail1.com' } });
    assert.equal(res.statusCode, 405);
  });

  it('rejects missing authentication', async () => {
    const handler = loadHandler(depsFor({ authOk: false }));
    const res = await handler(productionEvent());
    assert.equal(res.statusCode, 401);
  });

  it('rejects invalid CSRF on a browser session', async () => {
    const handler = loadHandler(depsFor());
    const event = productionEvent({ csrf: false });
    event.headers['x-csrf-token'] = 'forged';
    const res = await handler(event);
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'csrf_invalid');
  });

  it('blocks deploy-preview before Stripe or Postgres', async () => {
    const fetchImpl = fetchMap({ pi_test_1: stripeIntent() });
    const handler = loadHandler({
      ...depsFor({ fetchImpl }),
      env: { ...envProd, CONTEXT: 'deploy-preview', BRANCH: 'cursor/financial-history-readonly-audit-48bc' },
    });
    const res = await handler(productionEvent());
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'non_production_context');
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('blocks branch-deploy before Stripe or Postgres', async () => {
    const fetchImpl = fetchMap({ pi_test_1: stripeIntent() });
    const handler = loadHandler({
      ...depsFor({ fetchImpl }),
      env: { ...envProd, CONTEXT: 'branch-deploy', BRANCH: 'cursor/x' },
    });
    const res = await handler(productionEvent());
    assert.equal(res.statusCode, 403);
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects apply/backfill/write parameters', async () => {
    const handler = loadHandler(depsFor());
    const res = await handler(productionEvent({ body: { mode: 'dry-run', apply: true } }));
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, 'write_mode_rejected');
  });

  it('requires dry-run', async () => {
    const handler = loadHandler(depsFor());
    const res = await handler(productionEvent({ body: { mode: 'apply' } }));
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, 'dry_run_required');
  });
});

describe('financial history audit runtime', () => {
  it('paginates with an opaque cursor and never repeats a key', async () => {
    const records = {
      'CD1-A': blobBase({ id: 'CD1-A', paymentIntentId: null, amountPaid: 0, amountCapturedCents: 0, paymentStatus: 'due', jobStatus: 'assigned' }),
      'CD1-B': blobBase({ id: 'CD1-B', paymentIntentId: null, amountPaid: 0, amountCapturedCents: 0, paymentStatus: 'due', jobStatus: 'assigned' }),
      'CD1-C': blobBase({ id: 'CD1-C', paymentIntentId: null, amountPaid: 0, amountCapturedCents: 0, paymentStatus: 'due', jobStatus: 'assigned' }),
    };
    const first = await runDryRunPage({
      env: envProd,
      limit: 2,
      storeFactory: async () => fakeStore(records),
      prismaFactory: () => fakePrisma(),
      fetchImpl: fetchMap({}),
      stripeSecret: 'sk_test_x',
    });
    assert.equal(first.ok, true);
    assert.ok(first.nextCursor);
    assert.equal(first.nextCursor.includes('CD1-A'), false);
    assert.equal(first.nextCursor.includes('CD1-B'), false);
    const second = await runDryRunPage({
      env: envProd,
      cursor: first.nextCursor,
      limit: 2,
      storeFactory: async () => fakeStore(records),
      prismaFactory: () => fakePrisma(),
      fetchImpl: fetchMap({}),
      stripeSecret: 'sk_test_x',
    });
    assert.equal(second.ok, true);
    assert.equal(first.totals.bookingsExamined + second.totals.bookingsExamined, 3);
  });

  it('rejects a tampered cursor', async () => {
    const result = await runDryRunPage({
      env: envProd,
      cursor: 'not-a-cursor',
      storeFactory: async () => fakeStore({}),
      prismaFactory: () => fakePrisma(),
      fetchImpl: fetchMap({}),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'invalid_cursor');
  });

  it('reports a timeout as partial, not consistent', async () => {
    const records = { 'CD1-A': blobBase({ id: 'CD1-A' }) };
    const result = await runDryRunPage({
      env: envProd,
      deadlineMs: Date.now() - 1,
      storeFactory: async () => fakeStore(records),
      prismaFactory: () => fakePrisma(),
      fetchImpl: fetchMap({ pi_test_1: stripeIntent() }),
      stripeSecret: 'sk_test_x',
    });
    assert.equal(result.ok, true);
    assert.equal(result.totals.byClassification.consistent_paid.count, 0);
  });

  it('reports Stripe, Postgres, and Blob unavailability without writing', async () => {
    const stripeDown = await runDryRunPage({
      env: envProd,
      storeFactory: async () => fakeStore({ 'CD1-A': blobBase({ id: 'CD1-A' }) }),
      prismaFactory: () => fakePrisma({
        booking: [{ id: 'CD1-A' }],
        quote: [{ bookingId: 'CD1-A', quoteVersion: 1, approvedCents: 5000, currency: 'usd' }],
      }),
      fetchImpl: fetchMap({ pi_test_1: 'down' }),
      stripeSecret: 'sk_test_x',
    });
    assert.equal(stripeDown.ok, true);
    assert.ok(stripeDown.totals.stripeErrors >= 1);
    assert.equal(stripeDown.totals.byClassification.consistent_paid.count, 0);

    const pgDown = await runDryRunPage({
      env: envProd,
      storeFactory: async () => fakeStore({ 'CD1-A': blobBase({ id: 'CD1-A' }) }),
      prismaFactory: () => { throw new Error('no db'); },
      fetchImpl: fetchMap({}),
      stripeSecret: 'sk_test_x',
    });
    assert.equal(pgDown.ok, false);
    assert.equal(pgDown.error, 'postgres_unavailable');

    const blobDown = await runDryRunPage({
      env: envProd,
      storeFactory: async () => { throw new Error('no blobs'); },
      prismaFactory: () => fakePrisma(),
      fetchImpl: fetchMap({}),
      stripeSecret: 'sk_test_x',
    });
    assert.equal(blobDown.ok, false);
    assert.equal(blobDown.error, 'blob_unavailable');
  });

  it('records a missing PaymentIntent as provider_missing', async () => {
    const result = await runDryRunPage({
      env: envProd,
      storeFactory: async () => fakeStore({ 'CD1-AUDIT-1': blobBase() }),
      prismaFactory: () => fakePrisma({
        booking: [{ id: 'CD1-AUDIT-1' }],
        quote: [{ bookingId: 'CD1-AUDIT-1', quoteVersion: 1, approvedCents: 5000, currency: 'usd' }],
        paymentAttempt: [{
          bookingId: 'CD1-AUDIT-1', quoteVersion: 1, purpose: 'authoritative_balance',
          providerObjectId: 'pi_test_1', status: 'succeeded', amountCents: 5000, currency: 'usd',
          idempotencyKey: 'k',
        }],
        ledgerEntry: [{
          bookingId: 'CD1-AUDIT-1', kind: 'settlement', amountCents: 5000, currency: 'usd',
          providerObjectId: 'pi_test_1', providerEventId: 'settlement_pi_test_1',
        }],
      }),
      fetchImpl: fetchMap({ pi_test_1: 'missing' }),
      stripeSecret: 'sk_test_x',
    });
    assert.equal(result.totals.byClassification.provider_missing.count, 1);
  });

  it('fails if a Prisma, blob, or Stripe write method is used', async () => {
    const writes = [];
    const prisma = wrapReadOnlyPrisma(fakePrisma(), writes);
    await assert.rejects(() => prisma.booking.create({ data: {} }), /write_forbidden/);
    const store = wrapReadOnlyStore(fakeStore({}), writes);
    await assert.rejects(() => store.setJSON('x', {}), /write_forbidden/);
    assert.throws(() => assertStripeGet('https://api.stripe.com/v1/payment_intents', 'POST', writes));
    assert.ok(writes.length >= 3);
  });

  it('signs auditRef with HMAC and keeps it out of the HTTP body', async () => {
    const ref = auditRefFor('CD1-AUDIT-1', envProd);
    assert.ok(ref);
    assert.equal(ref.includes('CD1-AUDIT-1'), false);
    const fetchImpl = fetchMap({});
    const handler = loadHandler(depsFor({
      fetchImpl,
      store: fakeStore({ 'CD1-DUE': blobBase({ id: 'CD1-DUE', paymentIntentId: null, amountPaid: 0, amountCapturedCents: 0, paymentStatus: 'due', jobStatus: 'assigned', approvedFinalAmount: 50 }) }),
    }));
    const res = await handler(productionEvent({ cookie: false, csrf: false }));
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const text = JSON.stringify(body);
    assert.equal(text.includes('CD1-'), false);
    assert.equal(text.includes('cus_'), false);
    assert.equal(text.includes('@'), false);
    assert.equal(body.dryRun, true);
    assert.equal(typeof body.byClassification.consistent_due.count, 'number');
  });

  it('does not persist auditRef', () => {
    const src = fs.readFileSync(AUDIT_RT, 'utf8');
    assert.doesNotMatch(src, /auditRefFor\([^)]+\)[\s\S]{0,80}(create|upsert|setJSON)/);
  });
});

describe('financial history audit source contract', () => {
  it('imports no writers and forbids mutating Stripe verbs', () => {
    const fn = fs.readFileSync(FN, 'utf8');
    const lib = fs.readFileSync(AUDIT_LIB, 'utf8');
    const rt = fs.readFileSync(AUDIT_RT, 'utf8');
    const src = `${fn}\n${lib}\n${rt}`;
    assert.doesNotMatch(src, /observeProviderPaymentIntent/);
    assert.doesNotMatch(src, /ensureBookingFinancial/);
    assert.doesNotMatch(src, /payment-authority-service/);
    assert.doesNotMatch(src, /messages\.create/);
    assert.doesNotMatch(src, /paymentIntents['"`].*create|\/cancel|\/capture|\/confirm/);
    assert.doesNotMatch(src, /store\.setJSON\(/);
    assert.doesNotMatch(src, /observeProviderPaymentIntent\(/);
    assert.match(src, /SET TRANSACTION READ ONLY/);
    assert.match(fn, /non_production_context/);
    assert.equal(findForbiddenBodyKeys({ apply: true, backfill: 1, reconcile: true }).length >= 3, true);
  });
});
