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

function trustedSandbox(overrides = {}) {
  return {
    configuredBy: 'server',
    merchantId: MERCHANT_ID,
    locationId: LOCATION_ID,
    locationMerchantId: MERCHANT_ID,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    testContext: TEST_CONTEXT,
    confirmation: LOCAL_CONFIRMATION,
    purpose: PURPOSE,
    serverBookingRef: BOOKING_REF,
    trustedSandbox: trustedSandbox(),
    amountCents: 100,
    currency: 'USD',
    sourceId: 'cnon:card-nonce-ok',
    idempotencyKey: KEY,
    env: { SQUARE_SANDBOX_ACCESS_TOKEN: TOKEN },
    timeoutMs: 50,
    ...overrides,
  };
}

function v2Payment(overrides = {}) {
  const id = overrides.id === undefined ? PAYMENT_ID : overrides.id;
  const payment = {
    id,
    status: overrides.status || 'COMPLETED',
    location_id: overrides.locationId === undefined ? LOCATION_ID : overrides.locationId,
    amount_money: {
      amount: overrides.amount == null ? 100 : overrides.amount,
      currency: overrides.currency || 'USD',
    },
    card_details: { card: { last_4: '1111', fingerprint: 'must-not-leak' } },
  };
  if (overrides.receiptUrl != null) payment.receipt_url = overrides.receiptUrl;
  if (overrides.referenceId != null) payment.reference_id = overrides.referenceId;
  assert.equal(Object.hasOwn(payment, 'merchant_id'), false);
  return { payment };
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
  assert.equal(encoded.includes('receipt_url'), false);
  assert.equal(encoded.includes('squareupsandbox.com/receipt'), false);
}

function assertNoFinancialEffect(result) {
  assert.equal(result.paid, false);
  assert.equal(result.financiallySettled, false);
  assert.equal(result.settled, false);
  assert.equal(result.ledgerWrite, false);
  assert.equal(result.bookingWrite, false);
  assert.equal(result.bookingAssociationPersisted, false);
  assert.equal(result.notificationSent, false);
  assert.equal(result.databaseWrite, false);
  assert.equal(result.additionalCharge, false);
  assert.equal(result.idempotencyDurable, false);
  assert.equal(result.liveMerchantVerification, false);
  assert.equal(result.activeProvider, 'none');
  assert.equal(result.contract, CONTRACT_VERSION);
}

function assertNotEligible(result) {
  assertNoFinancialEffect(result);
  assert.equal(result.providerCompleted, false);
  assert.equal(result.eligibleForReconciliation, false);
}

test('Square statuses stay financially unsettled', () => {
  assert.deepEqual(normalizeSquarePaymentStatus('APPROVED'), {
    status: 'APPROVED',
    recognized: true,
    authorized: true,
    providerCompleted: false,
    eligibleForReconciliation: false,
    financiallySettled: false,
  });
  assert.equal(normalizeSquarePaymentStatus('PENDING').providerCompleted, false);
  assert.equal(normalizeSquarePaymentStatus('COMPLETED').providerCompleted, true);
  assert.equal(normalizeSquarePaymentStatus('COMPLETED').eligibleForReconciliation, true);
  assert.equal(normalizeSquarePaymentStatus('COMPLETED').financiallySettled, false);
  assert.equal(normalizeSquarePaymentStatus('CANCELED').providerCompleted, false);
  assert.equal(normalizeSquarePaymentStatus('FAILED').eligibleForReconciliation, false);
  const unknown = normalizeSquarePaymentStatus('CAPTURED');
  assert.equal(unknown.recognized, false);
  assert.equal(unknown.providerCompleted, false);
  assert.equal(unknown.eligibleForReconciliation, false);
  assert.equal(unknown.financiallySettled, false);
});

test('a completed V2 payment without a merchant field can be retrieved', async () => {
  const body = v2Payment({ referenceId: 'CD1-REAL-NOT-SENT' });
  const network = mockFetch(async () => jsonResponse(200, body));
  const created = await createSimulatedPayment(request({ fetchImpl: network.fetchImpl }));
  assert.equal(created.ok, true);
  assert.equal(created.status, 'COMPLETED');
  assert.equal(created.providerCompleted, true);
  assert.equal(created.eligibleForReconciliation, true);
  assert.equal(created.receiptMetadata, 'absent');
  assert.equal(created.paymentId, PAYMENT_ID);
  assert.equal(created.amountCents, 100);
  assert.equal(created.currency, 'USD');
  assert.equal(created.locationAccepted, true);
  assert.equal(created.merchantAccepted, true);
  assert.equal(created.trustedMerchantId, MERCHANT_ID);
  assert.equal(created.trustedLocationId, LOCATION_ID);
  assert.equal(created.serverBookingRef, BOOKING_REF);
  assert.equal(created.purpose, PURPOSE);
  assert.equal(created.idempotencyKey, KEY);
  assertNoFinancialEffect(created);
  assert.equal(JSON.stringify(created).includes('CD1-REAL-NOT-SENT'), false);
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
  assert.equal(again.providerCompleted, true);
  assert.equal(again.eligibleForReconciliation, true);
  assertNoFinancialEffect(again);
  assert.equal(network.calls.filter((call) => call.init.method === 'POST').length, 1);
  assert.equal(network.calls.filter((call) => call.init.method === 'GET').length, 2);
  assertNoSecret(again);
});

test('APPROVED and PENDING are not provider completions', async () => {
  for (const status of ['APPROVED', 'PENDING']) {
    const network = mockFetch(async () => jsonResponse(200, v2Payment({ status })));
    const result = await createSimulatedPayment(request({ fetchImpl: network.fetchImpl }));
    assert.equal(result.ok, true, status);
    assert.equal(result.status, status, status);
    assert.equal(result.providerCompleted, false, status);
    assert.equal(result.authorized, status === 'APPROVED', status);
    assertNotEligible(result);
  }
});

test('CANCELED and FAILED are not settlements', async () => {
  for (const status of ['CANCELED', 'FAILED']) {
    const network = mockFetch(async () => jsonResponse(200, v2Payment({ status })));
    const result = await createSimulatedPayment(request({ fetchImpl: network.fetchImpl }));
    assert.equal(result.ok, false, status);
    assert.equal(result.error, 'square_sandbox_not_settled', status);
    assert.equal(result.status, status, status);
    assertNotEligible(result);
  }
});

test('an unknown status is not successful', async () => {
  const network = mockFetch(async () => jsonResponse(200, v2Payment({ status: 'CAPTURED' })));
  const result = await createSimulatedPayment(request({ fetchImpl: network.fetchImpl }));
  assert.equal(result.error, 'square_sandbox_status_unknown');
  assert.equal(result.ok, false);
  assertNotEligible(result);
});

test('wrong location, amount, currency, and a missing payment id are rejected', async () => {
  const cases = [
    [v2Payment({ locationId: 'LOC_TEST_OTHER' }), 'square_sandbox_location_mismatch'],
    [v2Payment({ amount: 250 }), 'square_sandbox_amount_mismatch'],
    [v2Payment({ currency: 'EUR' }), 'square_sandbox_currency_mismatch'],
    [v2Payment({ id: '' }), 'square_sandbox_payment_id_missing'],
  ];
  for (const [body, error] of cases) {
    const network = mockFetch(async () => jsonResponse(200, body));
    const result = await createSimulatedPayment(request({ fetchImpl: network.fetchImpl }));
    assert.equal(result.error, error, error);
    assertNotEligible(result);
  }
});

test('merchant and location identity come only from the injected server configuration', async () => {
  const network = mockFetch(async () => {
    throw new Error('fetch must not run');
  });
  const untrusted = await createSimulatedPayment(request({
    fetchImpl: network.fetchImpl,
    trustedSandbox: {
      configuredBy: 'request',
      merchantId: MERCHANT_ID,
      locationId: LOCATION_ID,
      locationMerchantId: MERCHANT_ID,
    },
  }));
  assert.equal(untrusted.error, 'square_sandbox_merchant_untrusted');
  const missingLocation = await createSimulatedPayment(request({
    fetchImpl: network.fetchImpl,
    trustedSandbox: {
      configuredBy: 'server',
      merchantId: MERCHANT_ID,
      locationMerchantId: MERCHANT_ID,
    },
  }));
  assert.equal(missingLocation.error, 'square_sandbox_trusted_location_missing');
  const unpaired = await createSimulatedPayment(request({
    fetchImpl: network.fetchImpl,
    trustedSandbox: trustedSandbox({ locationMerchantId: 'MERCHANT_TEST_OTHER' }),
  }));
  assert.equal(unpaired.error, 'square_sandbox_merchant_untrusted');
  const spoofedMerchant = await createSimulatedPayment(request({
    fetchImpl: network.fetchImpl,
    merchantId: 'MERCHANT_TEST_SPOOF',
  }));
  assert.equal(spoofedMerchant.error, 'square_sandbox_merchant_not_caller_controlled');
  const spoofedLocation = await createSimulatedPayment(request({
    fetchImpl: network.fetchImpl,
    expectedLocationId: 'LOC_TEST_SPOOF',
  }));
  assert.equal(spoofedLocation.error, 'square_sandbox_location_not_caller_controlled');
  for (const result of [untrusted, missingLocation, unpaired, spoofedMerchant, spoofedLocation]) {
    assertNotEligible(result);
  }
  assert.equal(network.calls.length, 0);
});

test('a sandbox receipt is metadata and a misleading receipt is not proof', async () => {
  const accepted = mockFetch(async () => jsonResponse(200, v2Payment({
    receiptUrl: `https://squareupsandbox.com/receipt/preview/${PAYMENT_ID}`,
  })));
  const withReceipt = await createSimulatedPayment(request({ fetchImpl: accepted.fetchImpl }));
  assert.equal(withReceipt.providerCompleted, true);
  assert.equal(withReceipt.eligibleForReconciliation, true);
  assert.equal(withReceipt.receiptMetadata, 'sandbox-url-accepted');
  assertNoFinancialEffect(withReceipt);
  assertNoSecret(withReceipt);
  assert.equal(accepted.calls.length, 1);

  const misleading = [
    'https://squareup.com/receipt/preview/sandboxPay7cOnly',
    'https://squareupsandbox.com.attacker.example/receipt/preview/sandboxPay7cOnly',
    'https://evil.example/receipt?token=secret',
    'http://squareupsandbox.com/receipt/preview/sandboxPay7cOnly',
  ];
  for (const receiptUrl of misleading) {
    const network = mockFetch(async () => jsonResponse(200, v2Payment({ receiptUrl })));
    const result = await createSimulatedPayment(request({ fetchImpl: network.fetchImpl }));
    assert.equal(result.error, 'square_sandbox_receipt_rejected', receiptUrl);
    assert.equal(result.receiptMetadata, 'rejected');
    assertNotEligible(result);
    assert.equal(JSON.stringify(result).includes(receiptUrl), false);
    assert.equal(network.calls.length, 1);
    assert.equal(network.calls[0].init.method, 'POST');
  }
});

test('a caller cannot choose the host, environment, booking, or browser price', async () => {
  const network = mockFetch(async () => {
    throw new Error('fetch must not run');
  });
  const hosted = await createSimulatedPayment(request({
    fetchImpl: network.fetchImpl,
    host: 'https://connect.squareup.com',
  }));
  assert.equal(hosted.error, 'square_sandbox_production_host_forbidden');
  const selected = await createSimulatedPayment(request({
    fetchImpl: network.fetchImpl,
    squareHost: 'https://connect.squareupsandbox.com',
  }));
  assert.equal(selected.error, 'square_sandbox_host_not_caller_controlled');
  const environment = await createSimulatedPayment(request({
    fetchImpl: network.fetchImpl,
    squareEnv: 'production',
  }));
  assert.equal(environment.error, 'square_sandbox_environment_not_caller_controlled');
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
  const price = await createSimulatedPayment(request({
    fetchImpl: network.fetchImpl,
    amountCents: '100',
  }));
  assert.equal(price.error, 'square_sandbox_amount_invalid');
  const currency = await createSimulatedPayment(request({
    fetchImpl: network.fetchImpl,
    currency: 'EUR',
  }));
  assert.equal(currency.error, 'square_sandbox_currency_invalid');
  for (const result of [hosted, selected, environment, disabled, booking, price, currency]) {
    assertNotEligible(result);
  }
  assert.equal(network.calls.length, 0);
});

test('the sandbox client amount cap is not a contract price rule', async () => {
  const network = mockFetch(async () => {
    throw new Error('fetch must not run');
  });
  const over = await createSimulatedPayment(request({
    fetchImpl: network.fetchImpl,
    amountCents: 100001,
  }));
  assert.equal(over.error, 'square_sandbox_amount_invalid');
  assert.equal(over.providerCalled, false);
  assertNotEligible(over);
  assert.equal(network.calls.length, 0);
  const src = read('netlify/lib/square-sandbox-adapter-contract.js');
  assert.doesNotMatch(src, /amountCents > 100000/);
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
    assertNotEligible(result);
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
  assert.equal(timed.idempotencyDurable, false);
  assertNotEligible(timed);
});

test('the same idempotency key is replayed by the mock and a changed amount is not another charge', async () => {
  const network = mockFetch(async (_n, _url, init) => {
    const body = JSON.parse(init.body);
    if (body.amount_money.amount !== 100 || body.amount_money.currency !== 'USD') {
      return jsonResponse(400, {
        errors: [{ code: 'IDEMPOTENCY_KEY_REUSED', category: 'INVALID_REQUEST_ERROR' }],
      });
    }
    return jsonResponse(200, v2Payment());
  });
  const first = await createSimulatedPayment(request({ fetchImpl: network.fetchImpl }));
  const second = await createSimulatedPayment(request({ fetchImpl: network.fetchImpl }));
  const changed = await createSimulatedPayment(request({
    fetchImpl: network.fetchImpl,
    amountCents: 250,
  }));
  assert.equal(first.paymentId, PAYMENT_ID);
  assert.equal(first.idempotencyDurable, false);
  assert.equal(second.paymentId, first.paymentId);
  assert.equal(changed.error, 'square_sandbox_idempotency_conflict');
  assertNotEligible(changed);
  assert.equal(changed.idempotencyKey, KEY);
  const keys = network.calls.map((call) => JSON.parse(call.init.body).idempotency_key);
  assert.deepEqual(keys, [KEY, KEY, KEY]);
});

test('the active provider stays disabled and commercial code does not import the contract', async () => {
  assert.equal(ACTIVE_PAYMENT_PROVIDER, 'none');
  assert.match(
    read('netlify/lib/deploy-runtime-env.generated.js'),
    /STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED:\s*false/,
  );
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
  assert.doesNotMatch(src, /require\(['"][^'"]*prisma|require\(['"]stripe|api\.stripe\.com|PaymentAttempt|LedgerEntry|prisma\.|console\.(log|info|debug|warn)/);
  assert.doesNotMatch(src, /https:\/\/connect\.squareup\.com\/v2\//);
  assert.doesNotMatch(src, /payment\.merchant_id|\.merchant_id/);
  assert.match(src, /square_sandbox_production_host_forbidden/);
  assert.match(src, /liveMerchantVerification: false/);
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const networkOk = mockFetch(async () => jsonResponse(200, v2Payment()));
    await createSimulatedPayment(request({ fetchImpl: networkOk.fetchImpl }));
  } finally {
    console.log = original;
  }
  assert.equal(logs.length, 0);
});
