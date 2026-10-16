'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createCsrfToken } = require('../netlify/lib/owner-studio/authorization');
const {
  createAdminSession,
  TOKEN_PREFIX,
} = require('../netlify/lib/admin-security');
const { spawnSync } = require('node:child_process');
const {
  CLASSIFICATIONS,
  dollarsToCents,
  remainingUnclamped,
  remainingClamped,
  classifyBooking,
  findForbiddenBodyKeys,
  mergeUniverse,
  candidateFromResult,
  coverageWindow,
  FinancialAuditConfigurationError,
} = require('../netlify/lib/financial-history-audit');
const runtime = require('../netlify/lib/financial-history-audit-runtime');
const {
  encodeCursor,
  decodeCursor,
  auditRefFor,
  wrapReadOnlyPrisma,
  wrapReadOnlyStore,
  assertStripeGet,
  isSafeReadSql,
} = runtime;

const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'netlify/functions/financial-reconciliation-audit.js');
const AUDIT_LIB = path.join(ROOT, 'netlify/lib/financial-history-audit.js');
const AUDIT_RT = path.join(ROOT, 'netlify/lib/financial-history-audit-runtime.js');
const SECRET = 'test-admin-session-secret-value-32chars';
const ADMIN_KEY = 'test-admin-dash-password-key';
const FROZEN_NOW_MS = Date.parse('2026-10-16T02:15:00.000Z');
const COVERAGE_START = '2024-06-01T00:00:00.000Z';

function runDryRunPage(opts = {}) {
  return runtime.runDryRunPage({
    nowMs: FROZEN_NOW_MS,
    clock: () => FROZEN_NOW_MS,
    ...opts,
  });
}

function loadHandler(deps) {
  delete require.cache[require.resolve(FN)];
  const mod = require(FN);
  if (deps) mod.__test.setDeps(deps);
  else mod.__test.setDeps(null);
  return mod.handler;
}

async function productionEvent({
  body,
  cookie = true,
  csrf = true,
  headers = {},
  adminKey = null,
} = {}) {
  const h = {
    host: 'cardetail1.com',
    'x-nf-client-connection-ip': '203.0.113.10',
    'content-type': 'application/json',
    ...headers,
  };
  if (cookie) {
    const session = await createAdminSession('admin');
    h.cookie = `cd1_admin_session=${session.token}`;
    if (csrf) h['x-csrf-token'] = createCsrfToken(session.token, SECRET);
    h.__session = session.token;
  } else if (adminKey !== false) {
    h['x-admin-key'] = adminKey || ADMIN_KEY;
  }
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
    findMany: async ({ where } = {}) => tables[name].filter((row) => match(row, where || {})),
    findUnique: async () => null,
    findFirst: async ({ where } = {}) => tables[name].find((row) => match(row, where || {})) || null,
    create: async () => { writes.push(`${name}.create`); throw new Error('write_forbidden'); },
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
    $queryRaw: async (sql) => { writes.push('queryRaw'); return sql; },
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
  descriptor = 'CARDETAIL1',
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
    statement_descriptor: descriptor,
    metadata: bookingId || purpose ? { bookingId, booking_id: bookingId, purpose } : {},
    latest_charge: {
      id: 'ch_hidden',
      status: 'succeeded',
      amount_refunded: refunded,
      disputed,
    },
  };
}

function fetchMap(intents, listOpts = {}) {
  const calls = [];
  const listed = listOpts.list !== undefined
    ? listOpts.list
    : Object.values(intents).filter((row) => row && row.id);
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
    const parsed = new URL(String(url), 'https://api.stripe.com');
    if (parsed.pathname === '/v1/payment_intents' || parsed.pathname === '/v1/payment_intents/search') {
      if (listOpts.down) {
        return { ok: false, status: 500, json: async () => ({ error: { type: 'api_error' } }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: listed, has_more: !!listOpts.hasMore }),
      };
    }
    const id = decodeURIComponent(parsed.pathname.split('/payment_intents/')[1] || '').split('/')[0];
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
  ADMIN_DASH_PASSWORD: ADMIN_KEY,
  FINANCIAL_AUDIT_COVERAGE_START: COVERAGE_START,
};

function depsFor(handlerOpts = {}) {
  const deps = {
    env: envProd,
    enforcePublicRateLimit: async () => ({ blocked: false, allowed: true }),
    fetchImpl: handlerOpts.fetchImpl || fetchMap({}),
    storeFactory: async () => handlerOpts.store || fakeStore({}),
    prismaFactory: () => handlerOpts.prisma || fakePrisma(),
    stripeSecret: 'sk_live_not_used_in_unit_tests',
    nowMs: FROZEN_NOW_MS,
    clock: () => FROZEN_NOW_MS,
  };
  if (handlerOpts.authOk === false) {
    deps.authenticateAuditRequest = async () => ({ ok: false, error: 'unauthorized', status: 401 });
  }
  return deps;
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

  it('keeps duplicate primary when a refund is also present', () => {
    const result = classifyBooking({
      blob: blobBase({ paymentIntentId: 'pi_test_1', refundStatus: 'partial' }),
      postgres: pgPaid({
        paymentAttempts: [
          { bookingId: 'CD1-AUDIT-1', quoteVersion: 1, purpose: 'authoritative_balance', providerObjectId: 'pi_test_1', status: 'succeeded', amountCents: 5000, currency: 'usd', idempotencyKey: 'a' },
          { bookingId: 'CD1-AUDIT-1', quoteVersion: 1, purpose: 'authoritative_balance', providerObjectId: 'pi_test_2', status: 'succeeded', amountCents: 5000, currency: 'usd', idempotencyKey: 'b' },
        ],
        ledgerEntries: [
          { kind: 'settlement', amountCents: 5000, providerObjectId: 'pi_test_1', providerEventId: 'settlement_pi_test_1' },
          { kind: 'settlement', amountCents: 5000, providerObjectId: 'pi_test_2', providerEventId: 'settlement_pi_test_2' },
          { kind: 'refund', amountCents: 2000, providerObjectId: 'pi_test_1', providerEventId: 'refund_re_1' },
        ],
      }),
      stripeById: {
        pi_test_1: { id: 'pi_test_1', found: true, amountReceived: 5000, currency: 'usd', metadataBookingId: 'CD1-AUDIT-1', metadataPurpose: 'authoritative_balance', refundedAmount: 2000 },
        pi_test_2: { id: 'pi_test_2', found: true, amountReceived: 5000, currency: 'usd', metadataBookingId: 'CD1-AUDIT-1', metadataPurpose: 'authoritative_balance', refundedAmount: 0 },
      },
    });
    assert.equal(result.primaryClassification, 'duplicate_charge_confirmed');
    assert.ok(result.reasonCodes.includes('duplicate_charge_confirmed'));
    assert.ok(result.reasonCodes.includes('refunded_or_disputed'));
    assert.ok(result.reasonCodes.includes('multiple_succeeded_payment_intents'));
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
    assert.equal(CLASSIFICATIONS.length, 17);
  });
});

describe('financial history audit HTTP gates', () => {
  let savedEnv;
  beforeEach(() => {
    savedEnv = { ...process.env };
    process.env.CONTEXT = 'production';
    process.env.BRANCH = 'master';
    process.env.ADMIN_SESSION_SECRET = SECRET;
    process.env.ADMIN_DASH_PASSWORD = ADMIN_KEY;
    process.env.FINANCIAL_AUDIT_COVERAGE_START = COVERAGE_START;
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
    const handler = loadHandler(depsFor());
    const event = await productionEvent({ cookie: false, adminKey: false });
    const res = await handler(event);
    assert.equal(res.statusCode, 401);
  });

  it('rejects a session token sent as x-admin-key', async () => {
    const handler = loadHandler(depsFor());
    const session = await createAdminSession('admin');
    const event = await productionEvent({ cookie: false, adminKey: false });
    event.headers['x-admin-key'] = session.token;
    const res = await handler(event);
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error, 'admin_key_invalid');
    assert.ok(session.token.startsWith(TOKEN_PREFIX));
  });

  it('accepts a valid admin key without treating it as a cookie session', async () => {
    const handler = loadHandler(depsFor({
      store: fakeStore({
        'CD1-DUE': blobBase({
          id: 'CD1-DUE', paymentIntentId: null, amountPaid: 0, amountCapturedCents: 0,
          paymentStatus: 'due', jobStatus: 'assigned',
        }),
      }),
    }));
    const event = await productionEvent({ cookie: false, csrf: false });
    assert.equal(event.headers['x-admin-key'], ADMIN_KEY);
    assert.equal(event.headers.cookie, undefined);
    const res = await handler(event);
    assert.equal(res.statusCode, 200);
  });

  it('rejects a browser cookie without CSRF', async () => {
    const handler = loadHandler(depsFor());
    const event = await productionEvent({ csrf: false });
    const res = await handler(event);
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'csrf_invalid');
  });

  it('accepts a browser cookie with a valid CSRF token', async () => {
    const handler = loadHandler(depsFor({
      store: fakeStore({
        'CD1-DUE': blobBase({
          id: 'CD1-DUE', paymentIntentId: null, amountPaid: 0, amountCapturedCents: 0,
          paymentStatus: 'due', jobStatus: 'assigned',
        }),
      }),
    }));
    const event = await productionEvent({ cookie: true, csrf: true });
    assert.ok(event.headers.cookie.includes('cd1_admin_session='));
    assert.equal(event.headers['x-admin-key'], undefined);
    const res = await handler(event);
    assert.equal(res.statusCode, 200);
  });

  it('rejects conflicting cookie and x-admin-key credentials', async () => {
    const handler = loadHandler(depsFor());
    const event = await productionEvent({ cookie: true, csrf: true });
    event.headers['x-admin-key'] = ADMIN_KEY;
    const res = await handler(event);
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error, 'conflicting_credentials');
  });

  it('rejects invalid CSRF on a browser session', async () => {
    const handler = loadHandler(depsFor());
    const event = await productionEvent({ csrf: false });
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
    const res = await handler(await productionEvent());
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
    const res = await handler(await productionEvent());
    assert.equal(res.statusCode, 403);
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects apply/backfill/write parameters', async () => {
    const handler = loadHandler(depsFor());
    const res = await handler(await productionEvent({ body: { mode: 'dry-run', apply: true } }));
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, 'write_mode_rejected');
  });

  it('requires dry-run', async () => {
    const handler = loadHandler(depsFor());
    const res = await handler(await productionEvent({ body: { mode: 'apply' } }));
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, 'dry_run_required');
  });

  it('never logs header, cookie, or token values', () => {
    const src = fs.readFileSync(FN, 'utf8');
    assert.doesNotMatch(src, /console\.(info|warn|log)\([^)]*x-admin-key/);
    assert.doesNotMatch(src, /console\.(info|warn|log)\([^)]*cookie/);
    assert.doesNotMatch(src, /console\.(info|warn|log)\([^)]*csrf/);
    assert.doesNotMatch(src, /console\.(info|warn|log)\([^)]*ADMIN_DASH_PASSWORD/);
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
    assert.equal(second.scanComplete, true);
    assert.equal(second.partial, false);
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

  it('rejects a cursor from another coverage window', async () => {
    const cursor = encodeCursor({
      exec: 'other-exec',
      s: '2020-01-01T00:00:00.000Z',
      f: '2020-02-01T00:00:00.000Z',
      localAfter: null,
      stripeAfter: null,
      stripeDone: true,
      localDone: false,
      listed: [],
    }, envProd);
    const result = await runDryRunPage({
      env: envProd,
      cursor,
      storeFactory: async () => fakeStore({}),
      prismaFactory: () => fakePrisma(),
      fetchImpl: fetchMap({}),
      stripeSecret: 'sk_test_x',
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'cursor_execution_mismatch');
  });

  it('reports a timeout as partial, not consistent', async () => {
    const records = { 'CD1-A': blobBase({ id: 'CD1-A' }) };
    const result = await runDryRunPage({
      env: envProd,
      deadlineMs: FROZEN_NOW_MS - 1,
      storeFactory: async () => fakeStore(records),
      prismaFactory: () => fakePrisma(),
      fetchImpl: fetchMap({ pi_test_1: stripeIntent() }),
      stripeSecret: 'sk_test_x',
    });
    assert.equal(result.ok, true);
    assert.equal(result.totals.byClassification.consistent_paid.count, 0);
    assert.equal(result.scanComplete, false);
    assert.equal(result.partial, true);
  });

  it('reports Stripe, Postgres, and Blob unavailability without writing', async () => {
    const stripeDown = await runDryRunPage({
      env: envProd,
      storeFactory: async () => fakeStore({ 'CD1-A': blobBase({ id: 'CD1-A' }) }),
      prismaFactory: () => fakePrisma({
        booking: [{ id: 'CD1-A' }],
        quote: [{ bookingId: 'CD1-A', quoteVersion: 1, approvedCents: 5000, currency: 'usd' }],
      }),
      fetchImpl: fetchMap({ pi_test_1: 'down' }, { down: true }),
      stripeSecret: 'sk_test_x',
    });
    assert.equal(stripeDown.ok, true);
    assert.ok(stripeDown.totals.stripeErrors >= 1);
    assert.equal(stripeDown.totals.byClassification.consistent_paid.count, 0);
    assert.equal(stripeDown.scanComplete, false);

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

  it('examines blob-only, postgres-only, and overlapping bookings once', async () => {
    const result = await runDryRunPage({
      env: envProd,
      storeFactory: async () => fakeStore({
        'CD1-BLOB': blobBase({
          id: 'CD1-BLOB', paymentIntentId: null, amountPaid: 0, amountCapturedCents: 0,
          paymentStatus: 'due', jobStatus: 'assigned',
        }),
        'CD1-BOTH': blobBase({
          id: 'CD1-BOTH', paymentIntentId: null, amountPaid: 0, amountCapturedCents: 0,
          paymentStatus: 'due', jobStatus: 'assigned',
        }),
      }),
      prismaFactory: () => fakePrisma({
        booking: [{ id: 'CD1-PG' }, { id: 'CD1-BOTH' }],
        paymentAttempt: [{ bookingId: 'CD1-ATTEMPT', providerObjectId: 'pi_only_attempt' }],
        ledgerEntry: [{ bookingId: 'CD1-LEDGER', providerObjectId: 'pi_only_ledger', kind: 'settlement', amountCents: 1000 }],
        stripeEvent: [{ bookingId: 'CD1-EVENT' }],
      }),
      fetchImpl: fetchMap({}),
      stripeSecret: 'sk_test_x',
    });
    assert.equal(result.ok, true);
    assert.equal(result.totals.sources.blob, 2);
    assert.equal(result.totals.sources.postgresBookings, 2);
    assert.equal(result.totals.sources.paymentAttempts, 1);
    assert.equal(result.totals.sources.ledgerEntries, 1);
    assert.equal(result.totals.sources.stripeEvents, 1);
    assert.equal(result.totals.sources.union, 6);
    assert.equal(result.totals.bookingsExamined, 6);
  });

  it('detects a second succeeded PaymentIntent that exists only on Stripe', async () => {
    const extra = stripeIntent({
      id: 'pi_only_stripe',
      bookingId: 'CD1-AUDIT-1',
      received: 5000,
    });
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
      fetchImpl: fetchMap({
        pi_test_1: stripeIntent(),
        pi_only_stripe: extra,
      }),
      stripeSecret: 'sk_test_x',
    });
    assert.equal(result.totals.byClassification.duplicate_charge_confirmed.count, 1);
    assert.ok(result.totals.byReasonOverlapping.multiple_succeeded_payment_intents >= 1);
    assert.equal(result.totals.bookingsExamined, 1);
  });

  it('flags a PaymentIntent with no local booking reference', async () => {
    const orphan = stripeIntent({
      id: 'pi_orphan',
      bookingId: '',
      purpose: '',
      descriptor: 'CARDETAIL1 CD1',
      received: 4200,
    });
    const result = await runDryRunPage({
      env: envProd,
      storeFactory: async () => fakeStore({}),
      prismaFactory: () => fakePrisma(),
      fetchImpl: fetchMap({ pi_orphan: orphan }),
      stripeSecret: 'sk_test_x',
    });
    assert.ok(result.totals.byClassification.stripe_capture_without_booking.count >= 1);
    assert.equal(result.candidates.length >= 1, true);
    assert.equal(JSON.stringify(result.candidates).includes('pi_orphan'), false);
    assert.equal(JSON.stringify(result.candidates).includes('CD1-'), false);
  });

  it('marks provider coverage partial when Stripe pages remain', async () => {
    const listed = stripeIntent({ id: 'pi_page_1', bookingId: 'CD1-ORPHAN-1' });
    const result = await runDryRunPage({
      env: envProd,
      storeFactory: async () => fakeStore({
        'CD1-DUE': blobBase({
          id: 'CD1-DUE', paymentIntentId: null, amountPaid: 0, amountCapturedCents: 0,
          paymentStatus: 'due', jobStatus: 'assigned',
        }),
      }),
      prismaFactory: () => fakePrisma(),
      fetchImpl: fetchMap({ pi_page_1: listed }, { list: [listed], hasMore: true }),
      stripeSecret: 'sk_test_x',
    });
    assert.equal(result.providerCoverage, 'partial');
    assert.equal(result.partial, true);
    assert.equal(result.scanComplete, false);
    assert.equal(result.totals.byClassification.consistent_paid.count, 0);
    assert.ok(result.totals.byReasonOverlapping.provider_scan_incomplete >= 1);
  });

  it('keeps auditRef stable across pages and executions without reversing it', async () => {
    const refA = auditRefFor('CD1-AUDIT-1', envProd);
    const refB = auditRefFor('CD1-AUDIT-1', envProd);
    const refOther = auditRefFor('CD1-AUDIT-2', envProd);
    assert.equal(refA, refB);
    assert.notEqual(refA, refOther);
    assert.equal(refA.includes('CD1-AUDIT-1'), false);
    const first = await runDryRunPage({
      env: envProd,
      limit: 1,
      storeFactory: async () => fakeStore({
        'CD1-AUDIT-1': blobBase(),
        'CD1-AUDIT-2': blobBase({ id: 'CD1-AUDIT-2', paymentIntentId: 'pi_test_2' }),
      }),
      prismaFactory: () => fakePrisma(),
      fetchImpl: fetchMap({
        pi_test_1: stripeIntent(),
        pi_test_2: stripeIntent({ id: 'pi_test_2', bookingId: 'CD1-AUDIT-2' }),
      }),
      stripeSecret: 'sk_test_x',
    });
    const second = await runDryRunPage({
      env: envProd,
      limit: 1,
      cursor: first.nextCursor,
      storeFactory: async () => fakeStore({
        'CD1-AUDIT-1': blobBase(),
        'CD1-AUDIT-2': blobBase({ id: 'CD1-AUDIT-2', paymentIntentId: 'pi_test_2' }),
      }),
      prismaFactory: () => fakePrisma(),
      fetchImpl: fetchMap({
        pi_test_1: stripeIntent(),
        pi_test_2: stripeIntent({ id: 'pi_test_2', bookingId: 'CD1-AUDIT-2' }),
      }),
      stripeSecret: 'sk_test_x',
    });
    const refs = [...first.candidates, ...second.candidates].map((row) => row.auditRef);
    assert.ok(refs.includes(refA));
    assert.equal(refs.filter((value) => value === refA).length, 1);
  });

  it('fails if a Prisma, blob, or Stripe write method is used', async () => {
    const writes = [];
    const prisma = wrapReadOnlyPrisma(fakePrisma(), writes);
    await assert.rejects(() => prisma.booking.create({ data: {} }), /write_forbidden/);
    await assert.rejects(() => prisma.booking.update({ data: {} }), /write_forbidden/);
    await assert.rejects(() => prisma.booking.delete({}), /write_forbidden/);
    await assert.rejects(() => prisma.ledgerEntry.create({ data: {} }), /write_forbidden/);
    await assert.rejects(() => prisma.$executeRawUnsafe('INSERT INTO "Booking" (id) VALUES (\'x\')'), /write_forbidden/);
    await assert.rejects(() => prisma.$executeRawUnsafe('UPDATE "Booking" SET id = id'), /write_forbidden/);
    await assert.rejects(() => prisma.$executeRawUnsafe('DELETE FROM "Booking"'), /write_forbidden/);
    await assert.rejects(() => prisma.$executeRawUnsafe('ALTER TABLE "Booking" ADD COLUMN x int'), /write_forbidden/);
    await assert.rejects(() => prisma.$queryRaw('INSERT INTO "Booking" (id) VALUES (\'x\')'), /write_forbidden/);
    const store = wrapReadOnlyStore(fakeStore({}), writes);
    await assert.rejects(() => store.setJSON('x', {}), /write_forbidden/);
    assert.throws(() => assertStripeGet('https://api.stripe.com/v1/payment_intents', 'POST', writes));
    assert.throws(() => assertStripeGet('https://api.stripe.com/v1/payment_intents/pi_x/capture', 'GET', writes));
    assert.throws(() => assertStripeGet('https://api.stripe.com/v1/payment_intents/pi_x/cancel', 'POST', writes));
    assert.throws(() => assertStripeGet('https://api.stripe.com/v1/refunds', 'POST', writes));
    assert.throws(() => assertStripeGet('https://api.stripe.com/v1/charges', 'GET', writes));
    assert.throws(() => assertStripeGet('https://api.stripe.com/v1/customers', 'GET', writes));
    assert.doesNotThrow(() => assertStripeGet('https://api.stripe.com/v1/payment_intents', 'GET', writes));
    assert.doesNotThrow(() => assertStripeGet('https://api.stripe.com/v1/payment_intents/search', 'GET', writes));
    assert.ok(writes.length >= 3);
    assert.equal(isSafeReadSql('INSERT INTO t VALUES (1)'), false);
    assert.equal(isSafeReadSql('SELECT 1'), true);
    assert.equal(isSafeReadSql('SET TRANSACTION READ ONLY'), true);
  });

  it('signs auditRef with HMAC and keeps identifiers out of the HTTP body', async () => {
    process.env.CONTEXT = 'production';
    process.env.BRANCH = 'master';
    process.env.ADMIN_SESSION_SECRET = SECRET;
    process.env.ADMIN_DASH_PASSWORD = ADMIN_KEY;
    process.env.FINANCIAL_AUDIT_COVERAGE_START = COVERAGE_START;
    const ref = auditRefFor('CD1-AUDIT-1', envProd);
    assert.ok(ref);
    assert.equal(ref.includes('CD1-AUDIT-1'), false);
    const fetchImpl = fetchMap({});
    const handler = loadHandler(depsFor({
      fetchImpl,
      store: fakeStore({
        'CD1-DUE': blobBase({
          id: 'CD1-DUE', paymentIntentId: null, amountPaid: 0, amountCapturedCents: 0,
          paymentStatus: 'due', jobStatus: 'assigned', approvedFinalAmount: 50,
        }),
      }),
    }));
    const res = await handler(await productionEvent({ cookie: false, csrf: false }));
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const text = JSON.stringify(body);
    assert.equal(text.includes('CD1-'), false);
    assert.equal(text.includes('cus_'), false);
    assert.equal(text.includes('@'), false);
    assert.equal(body.dryRun, true);
    assert.equal(typeof body.byClassification.consistent_due.count, 'number');
    assert.equal(typeof body.scanComplete, 'boolean');
    assert.ok(body.coverageStartedAt);
    assert.ok(body.coverageEndedAt);
    assert.equal(body.reasonCountsOverlap, true);
  });

  it('does not persist auditRef', () => {
    const src = fs.readFileSync(AUDIT_RT, 'utf8');
    assert.doesNotMatch(src, /auditRefFor\([^)]+\)[\s\S]{0,80}(create|upsert|setJSON)/);
  });

  it('does not use the raw session secret as an AES key', () => {
    const src = fs.readFileSync(AUDIT_RT, 'utf8');
    assert.match(src, /financial-audit-v1/);
    assert.match(src, /derivePurposeKey/);
    assert.doesNotMatch(src, /createCipheriv\('aes-256-gcm', secret/);
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
    assert.doesNotMatch(src, /DEFAULT_COVERAGE_START/);
    assert.doesNotMatch(src, /2024-01-01T00:00:00\.000Z/);
    assert.match(fn, /non_production_context/);
    const coverageCall = fn.indexOf('coverageWindow(env, nowMs)');
    const runCall = fn.indexOf('runDryRunPage({');
    assert.ok(coverageCall >= 0 && runCall > coverageCall);
    assert.equal(findForbiddenBodyKeys({ apply: true, backfill: 1, reconcile: true }).length >= 3, true);
    assert.equal(findForbiddenBodyKeys({ from: '2020-01-01', to: '2026-01-01' }).length >= 2, true);
    const merged = mergeUniverse({ blob: ['A', 'B'], postgresBookings: ['B', 'C'] });
    assert.equal(merged.unionCount, 3);
    const candidate = candidateFromResult('ref', {
      primaryClassification: 'amount_mismatch',
      reasonCodes: ['amount_mismatch'],
      values: {
        approvedCents: 1, stripeGrossCapturedCents: 1, ledgerGrossSettlementsCents: 1,
        refundsCents: 0, netSettledCents: 1, remainingBalanceCents: 0,
      },
      paymentIntentCount: 1,
      settlementCount: 1,
      requiresManualReview: true,
    });
    assert.equal(candidate.auditRef, 'ref');
    assert.equal(candidate.values.approved, 1);
  });
});

function expectConfigError(fn, reason) {
  assert.throws(fn, (err) => {
    assert.equal(err.name, 'FinancialAuditConfigurationError');
    assert.equal(err.reason, reason);
    assert.equal(err.message, 'financial_audit_not_configured');
    assert.equal(JSON.stringify(err).includes(COVERAGE_START), false);
    return true;
  });
}

function countingIo() {
  const io = { blobList: 0, blobGet: 0, prisma: 0, stripe: 0 };
  const store = fakeStore({});
  return {
    io,
    storeFactory: async () => {
      io.storeFactory = (io.storeFactory || 0) + 1;
      return {
        async list() {
          io.blobList += 1;
          return store.list();
        },
        async get(key) {
          io.blobGet += 1;
          return store.get(key);
        },
        async setJSON() { throw new Error('write_forbidden'); },
      };
    },
    prismaFactory: () => {
      io.prisma += 1;
      const client = fakePrisma();
      return client;
    },
    fetchImpl: async (url, opts) => {
      io.stripe += 1;
      return fetchMap({})(url, opts);
    },
  };
}

describe('financial history audit coverage fail-closed', () => {
  const now = FROZEN_NOW_MS;

  it('coverage fail-closed: env absent', () => {
    const env = { ...envProd };
    delete env.FINANCIAL_AUDIT_COVERAGE_START;
    expectConfigError(() => coverageWindow(env, now), 'coverage_start_missing');
  });

  it('coverage fail-closed: undefined', () => {
    expectConfigError(
      () => coverageWindow({ ...envProd, FINANCIAL_AUDIT_COVERAGE_START: undefined }, now),
      'coverage_start_missing',
    );
  });

  it('coverage fail-closed: null', () => {
    expectConfigError(
      () => coverageWindow({ ...envProd, FINANCIAL_AUDIT_COVERAGE_START: null }, now),
      'coverage_start_missing',
    );
  });

  it('coverage fail-closed: empty string', () => {
    expectConfigError(
      () => coverageWindow({ ...envProd, FINANCIAL_AUDIT_COVERAGE_START: '' }, now),
      'coverage_start_missing',
    );
  });

  it('coverage fail-closed: whitespace', () => {
    expectConfigError(
      () => coverageWindow({ ...envProd, FINANCIAL_AUDIT_COVERAGE_START: '   ' }, now),
      'coverage_start_missing',
    );
  });

  it('coverage fail-closed: invalid text', () => {
    expectConfigError(
      () => coverageWindow({ ...envProd, FINANCIAL_AUDIT_COVERAGE_START: 'not-a-date' }, now),
      'coverage_start_invalid',
    );
  });

  it('coverage fail-closed: date only', () => {
    expectConfigError(
      () => coverageWindow({ ...envProd, FINANCIAL_AUDIT_COVERAGE_START: '2024-01-01' }, now),
      'coverage_start_invalid',
    );
  });

  it('coverage fail-closed: offset not Z', () => {
    expectConfigError(
      () => coverageWindow({ ...envProd, FINANCIAL_AUDIT_COVERAGE_START: '2024-06-01T00:00:00.000-04:00' }, now),
      'coverage_start_invalid',
    );
  });

  it('coverage fail-closed: impossible date', () => {
    expectConfigError(
      () => coverageWindow({ ...envProd, FINANCIAL_AUDIT_COVERAGE_START: '2024-02-30T00:00:00.000Z' }, now),
      'coverage_start_invalid',
    );
  });

  it('coverage fail-closed: future date', () => {
    expectConfigError(
      () => coverageWindow({ ...envProd, FINANCIAL_AUDIT_COVERAGE_START: '2026-10-16T03:00:00.000Z' }, now),
      'coverage_start_not_before_end',
    );
  });

  it('coverage fail-closed: equal to nowMs', () => {
    expectConfigError(
      () => coverageWindow({ ...envProd, FINANCIAL_AUDIT_COVERAGE_START: '2026-10-16T02:15:00.000Z' }, now),
      'coverage_start_not_before_end',
    );
  });

  it('coverage fail-closed: canonical UTC before nowMs', () => {
    const window = coverageWindow({ ...envProd, FINANCIAL_AUDIT_COVERAGE_START: COVERAGE_START }, now);
    assert.equal(window.coverageStartedAt, COVERAGE_START);
    assert.equal(window.coverageEndedAt, '2026-10-16T02:15:00.000Z');
    assert.equal(window.startedMs < window.endedMs, true);
  });

  it('does not use Date.parse permissive forms as valid', () => {
    expectConfigError(
      () => coverageWindow({ ...envProd, FINANCIAL_AUDIT_COVERAGE_START: 'June 1, 2024' }, now),
      'coverage_start_invalid',
    );
    expectConfigError(
      () => coverageWindow({ ...envProd, FINANCIAL_AUDIT_COVERAGE_START: '2024-06-01T00:00:00Z' }, now),
      'coverage_start_invalid',
    );
  });
});

describe('financial history audit coverage HTTP gates', () => {
  let savedEnv;
  beforeEach(() => {
    savedEnv = { ...process.env };
    process.env.CONTEXT = 'production';
    process.env.BRANCH = 'master';
    process.env.ADMIN_SESSION_SECRET = SECRET;
    process.env.ADMIN_DASH_PASSWORD = ADMIN_KEY;
    process.env.FINANCIAL_AUDIT_COVERAGE_START = COVERAGE_START;
  });
  afterEach(() => {
    process.env = savedEnv;
    delete require.cache[require.resolve(FN)];
  });

  async function assertNoIo(envOverride, extraEvent = {}, expectedStatus = 503) {
    const probe = countingIo();
    const handler = loadHandler({
      ...depsFor({ fetchImpl: probe.fetchImpl }),
      env: { ...envProd, ...envOverride },
      storeFactory: probe.storeFactory,
      prismaFactory: probe.prismaFactory,
    });
    const event = await productionEvent({ cookie: false, csrf: false, ...extraEvent.bodyWrap });
    if (extraEvent.queryStringParameters) event.queryStringParameters = extraEvent.queryStringParameters;
    if (extraEvent.headers) Object.assign(event.headers, extraEvent.headers);
    if (extraEvent.body) event.body = JSON.stringify(extraEvent.body);
    const res = await handler(event);
    assert.equal(res.statusCode, expectedStatus);
    const payload = JSON.parse(res.body);
    assert.equal(payload.error === 'financial_audit_not_configured'
      || payload.error === 'write_mode_rejected'
      || payload.error === 'invalid_cursor', true);
    assert.equal(JSON.stringify(payload).includes(COVERAGE_START), false);
    assert.equal(JSON.stringify(payload).includes('2024-01-01'), false);
    assert.equal(probe.io.blobList, 0);
    assert.equal(probe.io.blobGet, 0);
    assert.equal(probe.io.prisma, 0);
    assert.equal(probe.io.stripe, 0);
    assert.equal(probe.io.storeFactory || 0, 0);
    return payload;
  }

  it('coverage fail-closed: missing env does no financial I/O', async () => {
    const payload = await assertNoIo({ ...envProd, FINANCIAL_AUDIT_COVERAGE_START: undefined });
    assert.equal(payload.error, 'financial_audit_not_configured');
    assert.equal(payload.ok, false);
    assert.equal(payload.partial, undefined);
  });

  it('rejects payload from/to/coverageStart without I/O', async () => {
    await assertNoIo({}, { body: { mode: 'dry-run', from: '2020-01-01T00:00:00.000Z' } }, 400);
    await assertNoIo({}, { body: { mode: 'dry-run', to: '2026-01-01T00:00:00.000Z' } }, 400);
    await assertNoIo({}, { body: { mode: 'dry-run', coverageStart: COVERAGE_START } }, 400);
  });

  it('rejects query substitution of the coverage date', async () => {
    await assertNoIo({}, { queryStringParameters: { from: '2020-01-01T00:00:00.000Z' } }, 400);
    await assertNoIo({}, { queryStringParameters: { coverageStart: COVERAGE_START } }, 400);
  });

  it('rejects header substitution of the coverage date', async () => {
    await assertNoIo({}, { headers: { 'x-coverage-start': '2020-01-01T00:00:00.000Z' } }, 400);
  });

  it('rejects a cursor bound to another coverage window', async () => {
    const cursor = encodeCursor({
      exec: 'other-exec',
      s: '2020-01-01T00:00:00.000Z',
      f: '2020-02-01T00:00:00.000Z',
      localAfter: null,
      stripeAfter: null,
      stripeDone: true,
      localDone: false,
      listed: [],
    }, envProd);
    const probe = countingIo();
    const handler = loadHandler({
      ...depsFor({ fetchImpl: probe.fetchImpl }),
      storeFactory: probe.storeFactory,
      prismaFactory: probe.prismaFactory,
    });
    const res = await handler(await productionEvent({
      cookie: false,
      csrf: false,
      body: { mode: 'dry-run', cursor },
    }));
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, 'invalid_cursor');
    assert.equal(probe.io.blobList, 0);
    assert.equal(probe.io.prisma, 0);
    assert.equal(probe.io.stripe, 0);
  });

  it('rejects continuation after the env coverage start changes', async () => {
    const first = await runDryRunPage({
      env: envProd,
      limit: 1,
      storeFactory: async () => fakeStore({
        'CD1-A': blobBase({ id: 'CD1-A', paymentIntentId: null, amountPaid: 0, amountCapturedCents: 0, paymentStatus: 'due', jobStatus: 'assigned' }),
        'CD1-B': blobBase({ id: 'CD1-B', paymentIntentId: null, amountPaid: 0, amountCapturedCents: 0, paymentStatus: 'due', jobStatus: 'assigned' }),
      }),
      prismaFactory: () => fakePrisma(),
      fetchImpl: fetchMap({}),
      stripeSecret: 'sk_test_x',
    });
    assert.ok(first.nextCursor);
    const probe = countingIo();
    const changed = {
      ...envProd,
      FINANCIAL_AUDIT_COVERAGE_START: '2023-01-01T00:00:00.000Z',
    };
    const second = await runDryRunPage({
      env: changed,
      cursor: first.nextCursor,
      storeFactory: probe.storeFactory,
      prismaFactory: probe.prismaFactory,
      fetchImpl: probe.fetchImpl,
      stripeSecret: 'sk_test_x',
    });
    assert.equal(second.ok, false);
    assert.equal(second.error, 'cursor_execution_mismatch');
    assert.equal(probe.io.blobList, 0);
    assert.equal(probe.io.prisma, 0);
    assert.equal(probe.io.stripe, 0);
  });

  it('does not log the coverage value or secrets', async () => {
    const src = fs.readFileSync(FN, 'utf8');
    assert.doesNotMatch(src, /console\.(info|warn|log)\([^)]*FINANCIAL_AUDIT_COVERAGE_START/);
    assert.doesNotMatch(src, /console\.(info|warn|log)\([^)]*coverageStartedAt/);
    assert.match(src, /error: reason/);
  });
});

describe('financial history audit coverage mutations', () => {
  function applyMutation(file, find, replace) {
    const original = fs.readFileSync(file, 'utf8');
    assert.equal(original.includes(find), true, `mutation target missing: ${find.slice(0, 80)}`);
    const next = original.split(find).join(replace);
    assert.notEqual(next, original);
    fs.writeFileSync(file, next);
    return original;
  }

  function probe(script) {
    return spawnSync(process.execPath, ['-e', script], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 15_000,
    });
  }

  it('coverage mutation: default 2024-01-01 makes missing-env test fail', () => {
    const original = applyMutation(
      AUDIT_LIB,
      "throw new FinancialAuditConfigurationError('coverage_start_missing');",
      "env.FINANCIAL_AUDIT_COVERAGE_START = env.FINANCIAL_AUDIT_COVERAGE_START || '2024-01-01T00:00:00.000Z';",
    );
    try {
      const result = probe(`
        const assert = require('node:assert/strict');
        const { coverageWindow } = require('./netlify/lib/financial-history-audit');
        const now = Date.parse('2026-10-16T02:15:00.000Z');
        assert.throws(() => coverageWindow({ CONTEXT: 'production' }, now), (err) => err.reason === 'coverage_start_missing');
      `);
      assert.notEqual(result.status, 0);
    } finally {
      fs.writeFileSync(AUDIT_LIB, original);
    }
  });

  it('coverage mutation: permissive Date.parse makes date-only test fail', () => {
    const original = fs.readFileSync(AUDIT_LIB, 'utf8');
    const next = original
      .replace('if (!CANONICAL_UTC_MS.test(value))', 'if (false && !CANONICAL_UTC_MS.test(value))')
      .replace('if (new Date(startedMs).toISOString() !== value)', 'if (false && new Date(startedMs).toISOString() !== value)');
    assert.notEqual(next, original);
    fs.writeFileSync(AUDIT_LIB, next);
    try {
      const result = probe(`
        const assert = require('node:assert/strict');
        const { coverageWindow } = require('./netlify/lib/financial-history-audit');
        const now = Date.parse('2026-10-16T02:15:00.000Z');
        assert.throws(
          () => coverageWindow({ FINANCIAL_AUDIT_COVERAGE_START: '2024-01-01' }, now),
          (err) => err.reason === 'coverage_start_invalid',
        );
      `);
      assert.notEqual(result.status, 0);
    } finally {
      fs.writeFileSync(AUDIT_LIB, original);
    }
  });

  it('coverage mutation: accepting a future date makes that test fail', () => {
    const original = applyMutation(
      AUDIT_LIB,
      'if (!Number.isFinite(endedMs) || startedMs >= endedMs)',
      'if (false && (!Number.isFinite(endedMs) || startedMs >= endedMs))',
    );
    try {
      const result = probe(`
        const assert = require('node:assert/strict');
        const { coverageWindow } = require('./netlify/lib/financial-history-audit');
        const now = Date.parse('2026-10-16T02:15:00.000Z');
        assert.throws(
          () => coverageWindow({ FINANCIAL_AUDIT_COVERAGE_START: '2026-10-16T03:00:00.000Z' }, now),
          (err) => err.reason === 'coverage_start_not_before_end',
        );
      `);
      assert.notEqual(result.status, 0);
    } finally {
      fs.writeFileSync(AUDIT_LIB, original);
    }
  });

  it('coverage mutation: calling runDryRunPage before coverageWindow fails source order', () => {
    const original = applyMutation(
      FN,
      'coverageWindow(env, nowMs);',
      '/* coverageWindow delayed */',
    );
    try {
      const result = probe(`
        const assert = require('node:assert/strict');
        const fs = require('fs');
        const src = fs.readFileSync('./netlify/functions/financial-reconciliation-audit.js', 'utf8');
        const coverageCall = src.indexOf('coverageWindow(env, nowMs)');
        const runCall = src.indexOf('runDryRunPage({');
        assert.ok(coverageCall >= 0 && runCall > coverageCall);
      `);
      assert.notEqual(result.status, 0);
    } finally {
      fs.writeFileSync(FN, original);
    }
  });

  it('coverage mutation: payload from replacing env fails the from test', () => {
    const original = applyMutation(
      AUDIT_LIB,
      "'from',\n  'to',",
      "'to',",
    );
    try {
      const result = probe(`
        const assert = require('node:assert/strict');
        const { findForbiddenBodyKeys, findCoverageOverrideChannels } = require('./netlify/lib/financial-history-audit');
        assert.ok(findForbiddenBodyKeys({ mode: 'dry-run', from: '2020-01-01T00:00:00.000Z' }).length >= 1);
        assert.ok(findCoverageOverrideChannels({ __parsedBody: { from: '2020-01-01T00:00:00.000Z' } }).length >= 1);
      `);
      assert.notEqual(result.status, 0);
    } finally {
      fs.writeFileSync(AUDIT_LIB, original);
    }
  });

  it('coverage mutation: allowing another window cursor fails that test', () => {
    const original = applyMutation(
      AUDIT_RT,
      'if (coverage && payload.s !== coverage.coverageStartedAt)',
      'if (false && coverage && payload.s !== coverage.coverageStartedAt)',
    );
    try {
      const result = probe(`
        const assert = require('node:assert/strict');
        const { encodeCursor, decodeCursor } = require('./netlify/lib/financial-history-audit-runtime');
        const env = {
          ADMIN_SESSION_SECRET: 'test-admin-session-secret-value-32chars',
          FINANCIAL_AUDIT_COVERAGE_START: '2024-06-01T00:00:00.000Z',
        };
        const cursor = encodeCursor({
          exec: 'other-exec',
          s: '2020-01-01T00:00:00.000Z',
          f: '2020-02-01T00:00:00.000Z',
          listed: [],
        }, env);
        const decoded = decodeCursor(cursor, env, { coverageStartedAt: '2024-06-01T00:00:00.000Z' });
        assert.equal(decoded.ok, false);
        assert.equal(decoded.error, 'cursor_execution_mismatch');
      `);
      assert.notEqual(result.status, 0);
    } finally {
      fs.writeFileSync(AUDIT_RT, original);
    }
  });
});



