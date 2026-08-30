/**
 * Receipt authorization — Phase 9 release blockers (Gate B integration).
 *
 * These are NOT mocked-authorization tests. The real customer-receipt handler is
 * invoked with the real validateCustomerSession (real HMAC signing and
 * verification) and the real authorizeBookingAccess ownership check. Only the
 * blob storage is swapped for memory, which is the established pattern in
 * tests/customer-identity-security-prerequisites.test.js and six other suites.
 *
 * Two customers, two bookings, real cross-access denial.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SESSION_PATH = require.resolve('../netlify/lib/customer-session');
const RATE_PATH = require.resolve('../netlify/lib/public-rate-limit');
const OPS_DB_PATH = require.resolve('../netlify/lib/ops-db');
const AUTH_PATH = require.resolve('../netlify/lib/booking-customer-auth');
const RECEIPT_FN_PATH = require.resolve('../netlify/functions/customer-receipt');
const ADMIN_SEC_PATH = require.resolve('../netlify/lib/admin-security');

const TEST_SESSION_SECRET = 'test-customer-session-secret-32chars!!';

function createMemoryStore(seed = {}) {
  const data = new Map(Object.entries(seed).map(([k, v]) => [k, structuredClone(v)]));
  return {
    data,
    async get(key, opts) {
      if (!data.has(key)) return null;
      const v = data.get(key);
      return opts && opts.type === 'json' ? structuredClone(v) : v;
    },
    async getWithMetadata(key, { type } = {}) {
      if (!data.has(key)) return null;
      const value = data.get(key);
      return { data: type === 'json' ? structuredClone(value) : value, etag: `etag-${key}`, metadata: {} };
    },
    async setJSON(key, value) { data.set(key, structuredClone(value)); return { modified: true, etag: `etag-${key}` }; },
    async list() { return { blobs: [...data.keys()].map((key) => ({ key })) }; },
    async delete(key) { data.delete(key); },
  };
}

function createConditionalMemoryStore() {
  const data = new Map();
  let n = 0;
  return {
    async getWithMetadata(key, { type } = {}) {
      if (!data.has(key)) return null;
      const e = data.get(key);
      return { data: type === 'json' ? JSON.parse(e.value) : e.value, etag: e.etag, metadata: {} };
    },
    async setJSON(key, value, options = {}) {
      const exists = data.has(key);
      if (options.onlyIfNew && exists) return { modified: false };
      if (options.onlyIfMatch && (!exists || data.get(key).etag !== options.onlyIfMatch)) return { modified: false };
      const etag = `etag-${++n}`;
      data.set(key, { value: JSON.stringify(value), etag });
      return { modified: true, etag };
    },
  };
}

/** A completed, fully-settled booking for customer A. */
function bookingA() {
  return {
    id: 'CD1-AAAA1111',
    isDraft: false,
    status: 'Completed',
    jobStatus: 'completed',
    completedAt: '2026-09-15T18:00:00.000Z',
    confirmedDate: '2026-09-14',
    firstName: 'Alice', lastName: 'Anders',
    phone: '2015550177',
    email: 'alice@example.com',
    customerAccountId: 'acct-A',
    address: '1 Test Way, Newark NJ',
    paymentWorkflowStatus: 'payment_succeeded',
    paymentStatus: 'paid',
    approvedFinalAmount: 887,
    totalPrice: 887,
    vehicles: [
      {
        vehicleId: 'veh-bronco', vehicleLabel: '2025 Ford Bronco',
        year: 2025, make: 'Ford', model: 'Bronco',
        packageName: 'Maintenance Detail', basePrice: 215,
        addons: [
          { id: 'pet', name: 'Pet Hair Removal', qty: 1, price: 95 },
          { id: 'odor', name: 'Odor Treatment & Sanitize', qty: 1, price: 90 },
        ],
        addonTotal: 185, subtotal: 400,
      },
      {
        vehicleId: 'veh-yamaha', vehicleLabel: '2023 Yamaha Boats 222S',
        year: 2023, make: 'Yamaha Boats', model: '222S',
        packageName: 'Essential Marine', basePrice: 462,
        addons: [{ id: 'rainx', name: 'Rain-X Glass Treatment', qty: 1, price: 25 }],
        addonTotal: 25, subtotal: 487,
      },
    ],
    ledger: {
      approvedCents: 88700,
      settledCents: 88700,
      creditedCents: 0,
      entries: [
        { kind: 'settlement', amountCents: 88700, recordedAt: '2026-09-15T17:30:00.000Z', providerObjectId: 'cs_test_A1' },
      ],
    },
    paymentAttempts: [
      { attemptId: 'att-A1', status: 'settled', amountCents: 88700, settledAt: '2026-09-15T17:30:00.000Z', providerObjectId: 'cs_test_A1' },
    ],
    adminNotes: 'INTERNAL: customer haggled, do not repeat discount',
    stripeCheckoutSessionId: 'cs_test_SECRET_FULL_A1',
    paymentIntentId: 'pi_test_SECRET_A1',
  };
}

/** A separate customer, separate booking, separate account. */
function bookingB() {
  return {
    id: 'CD1-BBBB2222',
    isDraft: false,
    status: 'Completed',
    jobStatus: 'completed',
    completedAt: '2026-09-20T18:00:00.000Z',
    confirmedDate: '2026-09-19',
    firstName: 'Bob', lastName: 'Baker',
    phone: '2125550147',
    email: 'bob@example.com',
    customerAccountId: 'acct-B',
    paymentWorkflowStatus: 'payment_succeeded',
    approvedFinalAmount: 250,
    totalPrice: 250,
    vehicles: [{
      vehicleId: 'veh-b1', vehicleLabel: '2020 Honda Civic',
      packageName: 'Interior Detail', basePrice: 250, addons: [], addonTotal: 0, subtotal: 250,
    }],
    ledger: {
      approvedCents: 25000, settledCents: 25000, creditedCents: 0,
      entries: [{ kind: 'settlement', amountCents: 25000, recordedAt: '2026-09-20T17:00:00.000Z', providerObjectId: 'cs_test_B1' }],
    },
    paymentAttempts: [{ attemptId: 'att-B1', status: 'settled', amountCents: 25000, settledAt: '2026-09-20T17:00:00.000Z', providerObjectId: 'cs_test_B1' }],
  };
}

function cookieEvent(token, body) {
  return {
    httpMethod: 'POST',
    headers: {
      cookie: token ? `cd1_customer_session=${encodeURIComponent(token)}` : '',
      'x-nf-client-connection-ip': '203.0.113.10',
    },
    body: JSON.stringify(body || {}),
  };
}

describe('receipt authorization (real middleware, two customers)', () => {
  let sessionStore;
  let prevSecret;
  let prevAdminSecret;

  function freshModules() {
    for (const p of [SESSION_PATH, RATE_PATH, OPS_DB_PATH, AUTH_PATH, RECEIPT_FN_PATH, ADMIN_SEC_PATH]) {
      delete require.cache[p];
    }
  }

  beforeEach(() => {
    prevSecret = process.env.CUSTOMER_SESSION_SECRET;
    prevAdminSecret = process.env.ADMIN_SESSION_SECRET;
    process.env.CUSTOMER_SESSION_SECRET = TEST_SESSION_SECRET;
    process.env.ADMIN_SESSION_SECRET = 'a'.repeat(32);
    sessionStore = createMemoryStore();
    freshModules();

    const { setOpsStoreOverride } = require('../netlify/lib/ops-db');
    setOpsStoreOverride(createMemoryStore({
      'CD1-AAAA1111': bookingA(),
      'CD1-BBBB2222': bookingB(),
    }));

    const rl = require('../netlify/lib/public-rate-limit');
    if (rl.setPublicRateLimitStoreFactory) rl.setPublicRateLimitStoreFactory(() => createConditionalMemoryStore());
  });

  afterEach(() => {
    try {
      const { setOpsStoreOverride } = require('../netlify/lib/ops-db');
      setOpsStoreOverride(null);
    } catch (_) { /* ignore */ }
    try {
      const rl = require('../netlify/lib/public-rate-limit');
      if (rl.resetPublicRateLimitStoreFactory) rl.resetPublicRateLimitStoreFactory();
    } catch (_) { /* ignore */ }
    if (prevSecret === undefined) delete process.env.CUSTOMER_SESSION_SECRET;
    else process.env.CUSTOMER_SESSION_SECRET = prevSecret;
    if (prevAdminSecret === undefined) delete process.env.ADMIN_SESSION_SECRET;
    else process.env.ADMIN_SESSION_SECRET = prevAdminSecret;
    freshModules();
  });

  async function sessionFor({ phoneDigits, email, bookingIds, customerAccountId }) {
    const cs = require('../netlify/lib/customer-session');
    cs.setCustomerSessionStoreFactory(() => sessionStore);
    const { token } = await cs.createAccountSession({ phoneDigits, email, bookingIds, customerAccountId });
    return token;
  }

  function handler() { return require('../netlify/functions/customer-receipt').handler; }

  const A = { phoneDigits: '2015550177', email: 'alice@example.com', bookingIds: ['CD1-AAAA1111'], customerAccountId: 'acct-A' };
  const B = { phoneDigits: '2125550147', email: 'bob@example.com', bookingIds: ['CD1-BBBB2222'], customerAccountId: 'acct-B' };

  it('1. Customer A can access Booking A payment receipt', async () => {
    const token = await sessionFor(A);
    const res = await handler()(cookieEvent(token, { bookingId: 'CD1-AAAA1111', receiptType: 'payment' }));
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(body.receipt.bookingReference, 'CD1-AAAA1111');
    assert.equal(body.receipt.financialSummary.amountPaid.display, '$887.00');
  });

  it('2. Customer A cannot access Booking B receipt', async () => {
    const token = await sessionFor(A);
    const res = await handler()(cookieEvent(token, { bookingId: 'CD1-BBBB2222', receiptType: 'payment' }));
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false, 'cross-customer access must be denied');
    assert.ok([401, 403, 200].includes(res.statusCode));
    assert.ok(!body.receipt, 'no receipt payload may leak');
    assert.ok(!JSON.stringify(body).includes('Bob'), 'no other customer data may leak');
  });

  it('3. Customer B cannot access Booking A receipt', async () => {
    const token = await sessionFor(B);
    const res = await handler()(cookieEvent(token, { bookingId: 'CD1-AAAA1111', receiptType: 'final' }));
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.ok(!body.receipt);
    assert.ok(!JSON.stringify(body).includes('Alice'));
  });

  it('4. changing bookingId in the request does not bypass authorization', async () => {
    const token = await sessionFor(B);
    for (const id of ['CD1-AAAA1111', 'cd1-aaaa1111', ' CD1-AAAA1111 ', 'CD1-AAAA1111#']) {
      const res = await handler()(cookieEvent(token, { bookingId: id, receiptType: 'payment' }));
      const body = JSON.parse(res.body);
      assert.equal(body.ok, false, `id variant ${id} must not bypass ownership`);
      assert.ok(!body.receipt);
    }
  });

  it('5. unauthenticated access is denied', async () => {
    const res = await handler()(cookieEvent(null, { bookingId: 'CD1-AAAA1111', receiptType: 'payment' }));
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.ok(!body.receipt);
  });

  it('6. a revoked session is denied', async () => {
    const token = await sessionFor(A);
    const cs = require('../netlify/lib/customer-session');
    cs.setCustomerSessionStoreFactory(() => sessionStore);
    await cs.revokeCustomerSession(cookieEvent(token, {}));
    const res = await handler()(cookieEvent(token, { bookingId: 'CD1-AAAA1111', receiptType: 'payment' }));
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false, 'revoked session must not read a receipt');
    assert.ok(!body.receipt);
  });

  it('6b. a tampered session token is denied', async () => {
    const token = await sessionFor(A);
    const tampered = `${String(token).split('.')[0]}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const res = await handler()(cookieEvent(tampered, { bookingId: 'CD1-AAAA1111', receiptType: 'payment' }));
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.ok(!body.receipt);
  });

  it('7. an admin session cookie grants no customer receipt access', async () => {
    const res = await handler()({
      httpMethod: 'POST',
      headers: { cookie: 'cd1_admin_session=whatever', 'x-admin-key': 'whatever', 'x-nf-client-connection-ip': '203.0.113.11' },
      body: JSON.stringify({ bookingId: 'CD1-AAAA1111', receiptType: 'payment' }),
    });
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false, 'admin authority must not satisfy customer ownership');
    assert.ok(!body.receipt);
  });

  it('8-13. an authorized receipt leaks no sensitive field', async () => {
    const token = await sessionFor(A);
    const res = await handler()(cookieEvent(token, { bookingId: 'CD1-AAAA1111', receiptType: 'final' }));
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    const raw = JSON.stringify(body);

    // 8 portal/session tokens
    assert.ok(!/cd1_customer_session|sessionId|"sid"/.test(raw), 'no session token or id');
    assert.ok(!raw.includes(token), 'the session token must never be echoed');
    // 9 Stripe ids and secrets
    assert.ok(!/cs_test_|pi_test_|client_secret|stripeCheckoutSessionId|paymentIntentId/.test(raw), 'no Stripe identifiers');
    // 10 raw ledger
    assert.ok(!/"ledger"|providerObjectId|"entries"|approvedCents|settledCents/.test(raw), 'no raw ledger internals');
    // 11 admin notes
    assert.ok(!/adminNotes|INTERNAL:/.test(raw), 'no admin notes');
    // 12/13 card data — only a method type, never a PAN or masked digits we do not hold
    assert.ok(!/\b\d{13,19}\b/.test(raw), 'no full card number');
    assert.equal(body.receipt.paymentMethod, 'Card');
  });

  it('14. a malformed receipt type is rejected with 400', async () => {
    const token = await sessionFor(A);
    for (const t of ['', 'FINAL_ADMIN', '../final', 'payment;drop', null]) {
      const res = await handler()(cookieEvent(token, { bookingId: 'CD1-AAAA1111', receiptType: t }));
      assert.equal(res.statusCode, 400, `type ${String(t)} must be rejected`);
      assert.equal(JSON.parse(res.body).ok, false);
    }
  });

  it('15. a nonexistent booking fails safely', async () => {
    const token = await sessionFor(A);
    const res = await handler()(cookieEvent(token, { bookingId: 'CD1-NOPE0000', receiptType: 'payment' }));
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.ok(!body.receipt);
    assert.ok(!/stack|at Object|\.js:\d+/.test(JSON.stringify(body)), 'no stack trace');
  });

  it('16. an unavailable final receipt fails safely, not as an error', async () => {
    const { setOpsStoreOverride } = require('../netlify/lib/ops-db');
    const incomplete = bookingA();
    incomplete.jobStatus = 'in_progress';
    incomplete.status = 'Confirmed';
    delete incomplete.completedAt;
    setOpsStoreOverride(createMemoryStore({ 'CD1-AAAA1111': incomplete }));

    const token = await sessionFor(A);
    const res = await handler()(cookieEvent(token, { bookingId: 'CD1-AAAA1111', receiptType: 'final' }));
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'receipt_unavailable');
    assert.ok(!body.receipt);

    // ...while the payment receipt for the same booking is still available.
    const paid = await handler()(cookieEvent(token, { bookingId: 'CD1-AAAA1111', receiptType: 'payment' }));
    assert.equal(JSON.parse(paid.body).ok, true);
  });

  it('17. malformed JSON is rejected without a stack trace', async () => {
    const token = await sessionFor(A);
    const res = await handler()({
      httpMethod: 'POST',
      headers: { cookie: `cd1_customer_session=${encodeURIComponent(token)}`, 'x-nf-client-connection-ip': '203.0.113.12' },
      body: '{not json',
    });
    assert.equal(res.statusCode, 400);
    const raw = res.body;
    assert.ok(!/stack|SyntaxError|\.js:\d+/.test(raw), 'no internals leaked');
  });

  it('non-POST methods are rejected', async () => {
    const res = await handler()({ httpMethod: 'GET', headers: {}, body: '' });
    assert.equal(res.statusCode, 405);
  });
});
