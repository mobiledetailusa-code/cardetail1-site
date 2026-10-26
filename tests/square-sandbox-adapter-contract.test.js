'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');
const {
  ACTIVE_PAYMENT_PROVIDER,
  DisabledPaymentProvider,
  getActivePaymentProvider,
} = require('../netlify/lib/payment-provider-adapter');
const { LOCAL_CONFIRMATION, SANDBOX_ORIGIN } = require('../netlify/lib/square-sandbox-provider');
const {
  CONTRACT_VERSION,
  PURPOSE,
  TEST_CONTEXT,
  createSimulatedPayment,
  normalizeSquarePaymentStatus,
  retrieveSimulatedPayment,
} = require('../netlify/lib/square-sandbox-adapter-contract');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'EAAA_sandbox_mock_token_not_a_real_credential_00';
const KEY = 'sandbox-adapter-7c-001';
const PAYMENT_ID = 'sandboxPay7cOnly';
const LOCATION_ID = 'LOC_TEST_7C_ONLY';
const MERCHANT_ID = 'MERCHANT_TEST_7C_ONLY';
const BOOKING_REF = 'TEST-SQ-7C';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function request(overrides = {}) {
  return {
    testContext: TEST_CONTEXT,
    confirmation: LOCAL_CONFIRMATION,
    purpose: PURPOSE,
    serverBookingRef: BOOKING_REF,
    expectedLocationId: LOCATION_ID,
    expectedMerchantId: MERCHANT_ID,
    amountCents: 100,
    currency: 'USD',
    sourceId: 'cnon:card-nonce-ok',
    idempotencyKey: KEY,
    env: { SQUARE_SANDBOX_ACCESS_TOKEN: TOKEN },
    timeoutMs: 50,
    ...overrides,
  };
}

function paymentBody(overrides = {}) {
  const id = overrides.id === undefined ? PAYMENT_ID : overrides.id;
  return {
    payment: {
      id,
      status: overrides.status || 'COMPLETED',
      location_id: overrides.locationId === undefined ? LOCATION_ID : overrides.locationId,
      merchant_id: overrides.merchantId === undefined ? MERCHANT_ID : overrides.merchantId,
      amount_money: {
        amount: overrides.amount == null ? 100 : overrides.amount,
        currency: overrides.currency || 'USD',
      },
      receipt_url: overrides.receiptUrl === undefined
        ? `https://squareupsandbox.com/receipt/preview/${id}`
        : overrides.receiptUrl,
      card_details: { card: { last_4: '1111', fingerprint: 'must-not-leak' } },
    },
  };
}

function jsonResponse(status, body) {
  return {
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

function mockFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(calls.length, url, init);
  };
  return { calls, fetchImpl };
}

function assertNoSecret(value) {
  const encoded = JSON.stringify(value);
  assert.equal(encoded.includes(TOKEN), false);
  assert.equal(encoded.includes('1111'), false);
  assert.equal(encoded.includes('must-not-leak'), false);
  assert.equal(encoded.includes('card_details'), false);
}

function assertNotSettled(result) {
  assert.equal(result.paid, false);
  assert.equal(result.settled, false);
  assert.equal(result.eligibleForReconciliation, false);
  assert.equal(result.ledgerWrite, false);
  assert.equal(result.bookingWrite, false);
  assert.equal(result.notificationSent, false);
  assert.equal(result.databaseWrite, false);
  assert.equal(result.additionalCharge, false);
  assert.equal(result.activeProvider, 'none');
  assert.equal(result.contract, CONTRACT_VERSION);
}

test('Square statuses normalize without treating an unknown status as settled', () => {
  assert.deepEqual(normalizeSquarePaymentStatus('APPROVED'), {
    status: 'APPROVED', recognized: true, authorized: true, settled: false, eligibleForReconciliation: false,
  });
  assert.equal(normalizeSquarePaymentStatus('PENDING').settled, false);
  assert.equal(normalizeSquarePaymentStatus('COMPLETED').settled, true);
  assert.equal(normalizeSquarePaymentStatus('COMPLETED').eligibleForReconciliation, true);
  assert.equal(normalizeSquarePaymentStatus('CANCELED').settled, false);
  assert.equal(normalizeSquarePaymentStatus('FAILED').settled, false);
  const unknown = normalizeSquarePaymentStatus('CAPTURED');
  assert.equal(unknown.recognized, false);
  assert.equal(unknown.settled, false);
  assert.equal(unknown.eligibleForReconciliation, false);
});

test('a completed mock payment can be retrieved and is not a ledger settlement', async () => {
  const network = mockFetch(async () => jsonResponse(200, paymentBody()));
  const created = await createSimulatedPayment(request({ fetchImpl: network.fetchImpl }));
  assert.equal(created.ok, true);
  assert.equal(created.status, 'COMPLETED');
  assert.equal(created.settled, true);
  assert.equal(created.eligibleForReconciliation, true);
  assert.equal(created.paid, false);
  assert.equal(created.paymentId, PAYMENT_ID);
  assert.equal(created.amountCents, 100);
  assert.equal(created.currency, 'USD');
  assert.equal(created.locationAccepted, true);
  assert.equal(created.merchantAccepted, true);
  assert.equal(created.serverBookingRef, BOOKING_REF);
  assert.equal(created.purpose, PURPOSE);
  assert.equal(created.idempotencyKey, KEY);
  assert.equal(created.ledgerWrite, false);
  assert.equal(created.bookingWrite, false);
  const sent = JSON.parse(network.calls[0].init.body);
  assert.deepEqual(sent, {
    source_id: 'cnon:card-nonce-ok',
    idempotency_key: KEY,
    amount_money: { amount: 100, currency: 'USD' },
    autocomplete: true,
  });
  assert.equal(new URL(network.calls[0].url).origin, SANDBOX_ORIGIN);
  assertNoSecret(created);

  const readBack = await retrieveSimulatedPayment(request({
    fetchImpl: network.fetchImpl,
    paymentId: PAYMENT_ID,
  }));
  const again = await retrieveSimulatedPayment(request({
    fetchImpl: network.fetchImpl,
    paymentId: PAYMENT_ID,
  }));
  assert.equal(readBack.paymentId, PAYMENT_ID);
  assert.equal(again.paymentId, readBack.paymentId);
  assert.equal(again.settled, true);
  assert.equal(again.paid, false);
  assert.equal(network.calls.filter((call) => call.init.method === 'POST').length, 1);
  assert.equal(network.calls.filter((call) => call.init.method === 'GET').length, 2);
  assertNoSecret(again);
});

test('recognized non-completed statuses are not settlements', async () => {
  for (const status of ['APPROVED', 'PENDING', 'CANCELED', 'FAILED']) {
    const network = mockFetch(async () => jsonResponse(200, paymentBody({ status })));
    const result = await createSimulatedPayment(request({ fetchImpl: network.fetchImpl }));
    assert.equal(result.status, status, status);
    assert.equal(result.normalized.recognized, true, status);
    assertNotSettled(result);
    if (status === 'APPROVED') {
      assert.equal(result.authorized, true, status);
      assert.equal(result.ok, true, status);
    } else {
      assert.equal(result.authorized, false, status);
    }
    if (status === 'FAILED' || status === 'CANCELED') assert.equal(result.ok, false, status);
    if (status === 'PENDING') assert.equal(result.ok, true, status);
  }
});

test('an unknown status is not successful', async () => {
  const network = mockFetch(async () => jsonResponse(200, paymentBody({ status: 'CAPTURED' })));
  const result = await createSimulatedPayment(request({ fetchImpl: network.fetchImpl }));
  assert.equal(result.error, 'square_sandbox_status_unknown');
  assert.equal(result.ok, false);
  assert.equal(result.normalized.recognized, false);
  assertNotSettled(result);
});

test('missing payment identity, currency, amount, location, and merchant are rejected', async () => {
  const cases = [
    [paymentBody({ id: '' }), 'square_sandbox_payment_id_missing'],
    [paymentBody({ currency: 'EUR' }), 'square_sandbox_currency_mismatch'],
    [paymentBody({ amount: 250 }), 'square_sandbox_amount_mismatch'],
    [paymentBody({ locationId: 'LOC_TEST_OTHER' }), 'square_sandbox_location_mismatch'],
    [paymentBody({ merchantId: 'MERCHANT_TEST_OTHER' }), 'square_sandbox_merchant_mismatch'],
  ];
  for (const [body, error] of cases) {
    const network = mockFetch(async () => jsonResponse(200, body));
    const result = await createSimulatedPayment(request({ fetchImpl: network.fetchImpl }));
    assert.equal(result.error, error, error);
    assertNotSettled(result);
  }
});

test('a caller cannot choose the production host or skip the test context', async () => {
  const network = mockFetch(async () => {
    throw new Error('fetch must not run');
  });
  const hosted = await createSimulatedPayment(request({
    fetchImpl: network.fetchImpl,
    host: 'https://connect.squareup.com',
  }));
  assert.equal(hosted.error, 'square_sandbox_production_host_forbidden');
  const disabled = await createSimulatedPayment(request({
    fetchImpl: network.fetchImpl,
    testContext: 'production',
  }));
  assert.equal(disabled.error, 'square_sandbox_test_context_required');
  const booking = await createSimulatedPayment(request({
    fetchImpl: network.fetchImpl,
    bookingId: 'CD1-REAL',
  }));
  assert.equal(booking.error, 'square_sandbox_booking_not_connected');
  const purpose = await createSimulatedPayment(request({
    fetchImpl: network.fetchImpl,
    purpose: 'customer_balance',
  }));
  assert.equal(purpose.error, 'square_sandbox_purpose_unrecognized');
  const source = await createSimulatedPayment(request({
    fetchImpl: network.fetchImpl,
    sourceId: 'cnon:customer-card-token',
  }));
  assert.equal(source.error, 'square_sandbox_source_rejected');
  const price = await createSimulatedPayment(request({
    fetchImpl: network.fetchImpl,
    amountCents: '100',
  }));
  assert.equal(price.error, 'square_sandbox_amount_invalid');
  for (const result of [hosted, disabled, booking, purpose, source, price]) assertNotSettled(result);
  assert.equal(network.calls.length, 0);
});

test('Square HTTP failures and timeouts do not settle', async () => {
  const cases = [
    [400, 'square_sandbox_bad_request', false],
    [401, 'square_sandbox_credentials_invalid', false],
    [403, 'square_sandbox_forbidden', false],
    [429, 'square_sandbox_rate_limited', true],
    [500, 'square_sandbox_unknown', true],
  ];
  for (const [status, error, unknown] of cases) {
    const network = mockFetch(async () => jsonResponse(status, {
      errors: [{ category: 'API_ERROR', code: 'ERROR', detail: TOKEN }],
    }));
    const result = await createSimulatedPayment(request({ fetchImpl: network.fetchImpl }));
    assert.equal(result.error, error, String(status));
    assert.equal(result.outcomeUnknown, unknown, String(status));
    assert.equal(result.statusCode, status, String(status));
    assertNotSettled(result);
    assertNoSecret(result);
  }

  const timeout = mockFetch((_n, _url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  }));
  const timed = await createSimulatedPayment(request({ fetchImpl: timeout.fetchImpl }));
  assert.equal(timed.error, 'square_sandbox_unknown');
  assert.equal(timed.outcomeUnknown, true);
  assert.equal(timed.idempotencyKey, KEY);
  assertNotSettled(timed);
});

test('the same idempotency key is reused and a changed amount is not another charge', async () => {
  const network = mockFetch(async (_n, _url, init) => {
    const body = JSON.parse(init.body);
    if (body.amount_money.amount !== 100) {
      return jsonResponse(400, {
        errors: [{ code: 'IDEMPOTENCY_KEY_REUSED', category: 'INVALID_REQUEST_ERROR' }],
      });
    }
    return jsonResponse(200, paymentBody());
  });
  const first = await createSimulatedPayment(request({ fetchImpl: network.fetchImpl }));
  const second = await createSimulatedPayment(request({ fetchImpl: network.fetchImpl }));
  const changed = await createSimulatedPayment(request({
    fetchImpl: network.fetchImpl,
    amountCents: 250,
  }));
  assert.equal(first.paymentId, PAYMENT_ID);
  assert.equal(second.paymentId, first.paymentId);
  assert.equal(changed.error, 'square_sandbox_idempotency_conflict');
  assertNotSettled(changed);
  assert.equal(changed.idempotencyKey, KEY);
  const keys = network.calls.map((call) => JSON.parse(call.init.body).idempotency_key);
  assert.deepEqual(keys, [KEY, KEY, KEY]);
});

test('the active provider stays disabled and commercial code does not import the contract', async () => {
  assert.equal(ACTIVE_PAYMENT_PROVIDER, 'none');
  const network = mockFetch(async () => {
    throw new Error('fetch must not run');
  });
  const active = getActivePaymentProvider();
  assert.ok(active instanceof DisabledPaymentProvider);
  const refused = await active.createPayment(request({ fetchImpl: network.fetchImpl }));
  assert.equal(refused.error, 'payment_provider_disabled');
  assert.equal(refused.providerCalled, false);
  assert.equal(network.calls.length, 0);

  const commercial = [
    'netlify/functions/submit-booking.js',
    'netlify/functions/admin-ops-jobs.js',
    'netlify/functions/stripe-webhook.js',
    'netlify/lib/payment-provider-adapter.js',
    'netlify/lib/db/payment-authority-service.js',
    'sandbox/square-webhook/netlify/functions/square-sandbox-webhook.js',
  ];
  for (const file of commercial) {
    assert.doesNotMatch(read(file), /square-sandbox-adapter-contract/, file);
  }
  const src = read('netlify/lib/square-sandbox-adapter-contract.js');
  assert.doesNotMatch(src, /require\(['"][^'"]*prisma|prisma\.|console\.(log|info|debug|warn)/);
  assert.doesNotMatch(src, /https:\/\/connect\.squareup\.com\/v2\//);
  assert.match(src, /square_sandbox_production_host_forbidden/);
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const networkOk = mockFetch(async () => jsonResponse(200, paymentBody()));
    await createSimulatedPayment(request({ fetchImpl: networkOk.fetchImpl }));
  } finally {
    console.log = original;
  }
  assert.equal(logs.length, 0);
});
