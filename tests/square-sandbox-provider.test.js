'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  DisabledPaymentProvider,
  getActivePaymentProvider,
  activePaymentProviderId,
} = require('../netlify/lib/payment-provider-adapter');
const {
  SANDBOX_ORIGIN,
  PRODUCTION_ORIGIN,
  SQUARE_VERSION,
  LOCAL_CONFIRMATION,
  createSquareSandboxProvider,
  isProductionSquareUrl,
  sandboxRequestUrl,
} = require('../netlify/lib/square-sandbox-provider');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'EAAA_sandbox_mock_token_not_a_real_credential_00';
const KEY = 'sandbox-idem-001';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function localEnv(extra = {}) {
  return { SQUARE_SANDBOX_ACCESS_TOKEN: TOKEN, ...extra };
}

function paymentBody(overrides = {}) {
  const id = overrides.id || 'sandboxPay12345';
  return {
    payment: {
      id,
      status: overrides.status || 'COMPLETED',
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

function provider(fetchImpl, env = localEnv(), extra = {}) {
  return createSquareSandboxProvider({
    env,
    fetchImpl,
    confirmation: LOCAL_CONFIRMATION,
    timeoutMs: 50,
    ...extra,
  });
}

function request(overrides = {}) {
  return {
    amountCents: 100,
    currency: 'USD',
    sourceId: 'cnon:card-nonce-ok',
    idempotencyKey: KEY,
    ...overrides,
  };
}

function assertNoTokenLeak(value) {
  assert.equal(JSON.stringify(value).includes(TOKEN), false);
}

test('the active provider remains none when the sandbox client exists', () => {
  process.env.PAYMENT_PROVIDER = 'square';
  process.env.SQUARE_SANDBOX_ACCESS_TOKEN = TOKEN;
  try {
    assert.equal(activePaymentProviderId(), 'none');
    const active = getActivePaymentProvider();
    assert.ok(active instanceof DisabledPaymentProvider);
    assert.equal(active.id, 'none');
  } finally {
    delete process.env.PAYMENT_PROVIDER;
    delete process.env.SQUARE_SANDBOX_ACCESS_TOKEN;
  }
});

test('a completed sandbox payment is accepted only when the status is COMPLETED', async () => {
  const network = mockFetch(async () => jsonResponse(200, paymentBody()));
  const result = await provider(network.fetchImpl).createPayment(request());
  assert.equal(result.ok, true);
  assert.equal(result.completed, true);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.paymentId, 'sandboxPay12345');
  assert.equal(result.amountCents, 100);
  assert.equal(result.currency, 'USD');
  assert.equal(result.provider, 'square_sandbox');
  assert.equal(result.activeProvider, 'none');
  assert.equal(result.paid, false);
  assert.equal(result.created, false);
  assert.equal(result.sandboxReceiptConfirmed, true);
  assert.equal(result.definitiveFinancialFailure, false);
  const call = network.calls[0];
  const url = new URL(call.url);
  assert.equal(url.origin, SANDBOX_ORIGIN);
  assert.equal(url.pathname, '/v2/payments');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['Square-Version'], SQUARE_VERSION);
  assert.equal(call.init.headers.Authorization, `Bearer ${TOKEN}`);
  const body = JSON.parse(call.init.body);
  assert.deepEqual(body, {
    source_id: 'cnon:card-nonce-ok',
    idempotency_key: KEY,
    amount_money: { amount: 100, currency: 'USD' },
    autocomplete: true,
  });
  assertNoTokenLeak(result);
  assert.equal(JSON.stringify(result).includes('1111'), false);
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
});

test('HTTP 200 with a non-completed status is not a completed payment', async () => {
  const network = mockFetch(async () => jsonResponse(200, paymentBody({ status: 'APPROVED' })));
  const result = await provider(network.fetchImpl).createPayment(request());
  assert.equal(result.completed, false);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'APPROVED');
  assert.equal(result.outcome, 'pending');
  assert.equal(result.paid, false);
});

test('a declined sandbox source returns a decline and does not complete', async () => {
  const network = mockFetch(async () => jsonResponse(400, {
    errors: [{ category: 'PAYMENT_METHOD_ERROR', code: 'GENERIC_DECLINE', detail: 'Card declined' }],
  }));
  const result = await provider(network.fetchImpl).createPayment(request({
    sourceId: 'cnon:card-nonce-declined',
  }));
  assert.equal(result.error, 'square_sandbox_declined');
  assert.equal(result.declined, true);
  assert.equal(result.completed, false);
  assert.equal(result.squareCode, 'GENERIC_DECLINE');
  assert.equal(result.definitiveFinancialFailure, false);
  assert.equal(JSON.stringify(result).includes('Card declined'), false);
});

test('missing, malformed, and production credentials never call Square', async () => {
  const network = mockFetch(async () => {
    throw new Error('fetch must not run');
  });
  const missing = await provider(network.fetchImpl, {}).createPayment(request());
  assert.equal(missing.error, 'square_sandbox_credentials_missing');
  const invalid = await provider(network.fetchImpl, {
    SQUARE_SANDBOX_ACCESS_TOKEN: 'sk_live_not_a_sandbox_token_000000000000',
  }).createPayment(request());
  assert.equal(invalid.error, 'square_sandbox_credentials_invalid');
  const reused = await provider(network.fetchImpl, {
    SQUARE_SANDBOX_ACCESS_TOKEN: TOKEN,
    SQUARE_ACCESS_TOKEN: TOKEN,
  }).createPayment(request());
  assert.equal(reused.error, 'square_sandbox_credentials_invalid');
  const onlyProduction = await provider(network.fetchImpl, {
    SQUARE_ACCESS_TOKEN: TOKEN,
  }).createPayment(request());
  assert.equal(onlyProduction.error, 'square_sandbox_credentials_missing');
  assert.equal(network.calls.length, 0);
});

test('Square 401 is an invalid credential and does not echo the token', async () => {
  const network = mockFetch(async () => jsonResponse(401, {
    errors: [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED', detail: `bad ${TOKEN}` }],
  }));
  const result = await provider(network.fetchImpl).createPayment(request());
  assert.equal(result.error, 'square_sandbox_credentials_invalid');
  assert.equal(result.statusCode, 401);
  assert.equal(result.completed, false);
  assertNoTokenLeak(result);
});

test('HTTP 400, 429, and 500 stay controlled and are not completed payments', async () => {
  const cases = [
    [400, { errors: [{ code: 'BAD_REQUEST', category: 'INVALID_REQUEST_ERROR' }] }, 'square_sandbox_bad_request', false],
    [429, { errors: [{ code: 'RATE_LIMITED', category: 'RATE_LIMIT_ERROR' }] }, 'square_sandbox_rate_limited', true],
    [500, { errors: [{ code: 'INTERNAL_SERVER_ERROR', category: 'API_ERROR' }] }, 'square_sandbox_unknown', true],
  ];
  for (const [status, body, error, unknown] of cases) {
    const network = mockFetch(async () => jsonResponse(status, body));
    const result = await provider(network.fetchImpl).createPayment(request());
    assert.equal(result.error, error, String(status));
    assert.equal(result.completed, false, String(status));
    assert.equal(result.outcomeUnknown, unknown, String(status));
    assert.equal(result.definitiveFinancialFailure, false, String(status));
    assert.equal(result.idempotencyKey, KEY, String(status));
  }
});

test('an invalid payload and a missing payment are not completed', async () => {
  const invalid = mockFetch(async () => ({
    status: 200,
    async text() { return 'not-json'; },
  }));
  const invalidResult = await provider(invalid.fetchImpl).createPayment(request());
  assert.equal(invalidResult.error, 'square_sandbox_invalid_response');
  assert.equal(invalidResult.outcomeUnknown, true);
  assert.equal(invalidResult.completed, false);

  const missing = mockFetch(async () => jsonResponse(404, {
    errors: [{ code: 'NOT_FOUND', category: 'INVALID_REQUEST_ERROR', detail: 'missing payment' }],
  }));
  const missingResult = await provider(missing.fetchImpl).getPayment({ paymentId: 'missingPay123' });
  assert.equal(missingResult.error, 'square_sandbox_not_found');
  assert.equal(missingResult.completed, false);
  assert.equal(missing.calls[0].init.method, 'GET');
  assert.equal(new URL(missing.calls[0].url).pathname, '/v2/payments/missingPay123');
});

test('retries keep the same idempotency key and a changed amount is not another charge', async () => {
  const network = mockFetch(async (_n, _url, init) => {
    const body = JSON.parse(init.body);
    if (body.amount_money.amount !== 100) {
      return jsonResponse(400, {
        errors: [{ code: 'IDEMPOTENCY_KEY_REUSED', category: 'INVALID_REQUEST_ERROR' }],
      });
    }
    return jsonResponse(200, paymentBody());
  });
  const client = provider(network.fetchImpl);
  const first = await client.createPayment(request());
  const second = await client.createPayment(request());
  const changed = await client.createPayment(request({ amountCents: 250 }));
  assert.equal(first.paymentId, 'sandboxPay12345');
  assert.equal(second.paymentId, first.paymentId);
  assert.equal(second.completed, true);
  assert.equal(changed.error, 'square_sandbox_idempotency_conflict');
  assert.equal(changed.additionalCharge, false);
  assert.equal(changed.completed, false);
  assert.equal(changed.idempotencyKey, KEY);
  assert.equal(network.calls.length, 3);
  const keys = network.calls.map((call) => JSON.parse(call.init.body).idempotency_key);
  assert.deepEqual(keys, [KEY, KEY, KEY]);
});

test('a timeout is unknown, keeps the original key, and is not a definitive failure', async () => {
  const network = mockFetch((_n, _url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  }));
  const result = await provider(network.fetchImpl).createPayment(request());
  assert.equal(result.error, 'square_sandbox_unknown');
  assert.equal(result.outcomeUnknown, true);
  assert.equal(result.definitiveFinancialFailure, false);
  assert.equal(result.completed, false);
  assert.equal(result.idempotencyKey, KEY);
  assert.equal(network.calls.length, 1);
});

test('the production host cannot be selected and hosted runtimes cannot call Square', async () => {
  assert.equal(isProductionSquareUrl(`${PRODUCTION_ORIGIN}/v2/payments`), true);
  assert.equal(isProductionSquareUrl(`${SANDBOX_ORIGIN}/v2/payments`), false);
  assert.equal(sandboxRequestUrl('/v2/payments'), `${SANDBOX_ORIGIN}/v2/payments`);
  const network = mockFetch(async () => {
    throw new Error('fetch must not run');
  });
  const hosted = [
    { CONTEXT: 'production' },
    { CONTEXT: 'deploy-preview' },
    { CONTEXT: 'branch-deploy' },
    { NETLIFY: 'true' },
    { AWS_LAMBDA_FUNCTION_NAME: 'square-sandbox-provider' },
  ];
  for (const extra of hosted) {
    const result = await provider(network.fetchImpl, localEnv(extra)).createPayment(request({
      baseUrl: PRODUCTION_ORIGIN,
      url: `${PRODUCTION_ORIGIN}/v2/payments`,
    }));
    assert.equal(result.error, 'square_sandbox_context_forbidden', JSON.stringify(extra));
    assert.equal(result.externalCall, false);
  }
  const unconfirmed = createSquareSandboxProvider({
    env: localEnv(),
    fetchImpl: network.fetchImpl,
    confirmation: 'yes',
  });
  const refused = await unconfirmed.createPayment(request());
  assert.equal(refused.error, 'square_sandbox_confirmation_required');
  assert.equal(network.calls.length, 0);
});

test('getPayment reads the sandbox payment and rejects a production receipt', async () => {
  const network = mockFetch(async () => jsonResponse(200, paymentBody()));
  const result = await provider(network.fetchImpl).getPayment({ paymentId: 'sandboxPay12345' });
  assert.equal(result.completed, true);
  assert.equal(result.paymentId, 'sandboxPay12345');
  assert.equal(result.amountCents, 100);
  assert.equal(result.currency, 'USD');
  assert.equal(result.provider, 'square_sandbox');
  assert.equal(result.paid, false);

  const productionReceipt = mockFetch(async () => jsonResponse(200, paymentBody({
    receiptUrl: 'https://squareup.com/receipt/preview/sandboxPay12345',
  })));
  const rejected = await provider(productionReceipt.fetchImpl).getPayment({ paymentId: 'sandboxPay12345' });
  assert.equal(rejected.completed, false);
  assert.equal(rejected.error, 'square_sandbox_identity_unconfirmed');
  const stripeId = await provider(network.fetchImpl).getPayment({ paymentId: 'pi_historical' });
  assert.equal(stripeId.error, 'square_sandbox_payment_id_invalid');
  assert.equal(stripeId.externalCall, false);
});

test('disabled operations, offline settlement, and bookings do not call Square', async () => {
  const network = mockFetch(async () => {
    throw new Error('fetch must not run');
  });
  const client = provider(network.fetchImpl);
  for (const name of ['refundPayment', 'saveCard', 'chargeSavedCard', 'createPaymentLink']) {
    const result = await client[name](request());
    assert.equal(result.error, 'payment_provider_disabled', name);
    assert.equal(result.externalCall, false, name);
  }
  for (const method of ['cash', 'card_on_site', 'cash_onsite', 'card_onsite', 'external_manual']) {
    const result = await client.createPayment(request({ method }));
    assert.equal(result.error, 'offline_settlement_outside_adapter', method);
  }
  const booking = await client.createPayment(request({ bookingId: 'CD1-SQUARE' }));
  assert.equal(booking.error, 'square_sandbox_booking_not_connected');
  const realCard = await client.createPayment(request({ sourceId: 'cnon:customer-card-token' }));
  assert.equal(realCard.error, 'square_sandbox_source_rejected');
  const missingKey = await client.createPayment(request({ idempotencyKey: '' }));
  assert.equal(missingKey.error, 'square_sandbox_idempotency_key_required');
  assert.equal(network.calls.length, 0);
});

test('the sandbox client is not wired to commercial endpoints or CI', () => {
  const commercial = [
    'netlify/functions/submit-booking.js',
    'netlify/functions/admin-ops-jobs.js',
    'netlify/functions/stripe-webhook.js',
    'netlify/functions/admin-quick-ops.js',
    'netlify/functions/tech-quick-ops.js',
    'netlify/functions/customer-portal-data.js',
    'netlify/lib/db/payment-authority-service.js',
    'netlify/lib/payment-provider-adapter.js',
  ];
  for (const file of commercial) {
    assert.doesNotMatch(read(file), /square-sandbox-provider/, file);
  }
  const workflow = read('.github/workflows/integration.yml');
  assert.doesNotMatch(workflow, /SQUARE_SANDBOX_ACCESS_TOKEN/);
  assert.doesNotMatch(workflow, /square-sandbox-smoke-test/);
  const pkg = JSON.parse(read('package.json'));
  assert.doesNotMatch(pkg.scripts.test, /square-sandbox-smoke-test/);
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  assert.equal(names.some((name) => /square/i.test(name)), false);
  const src = read('netlify/lib/square-sandbox-provider.js');
  assert.doesNotMatch(src, /prisma|PaymentAttempt|LedgerEntry/);
  assert.match(src, /connect\.squareupsandbox\.com/);
  assert.doesNotMatch(src, /SQUARE_ACCESS_TOKEN\]/);
});

test('the manual smoke script blocks before any Square call when credentials are absent', () => {
  const result = spawnSync(process.execPath, [
    'scripts/square-sandbox-smoke-test.js',
    '--confirm-square-sandbox',
  ], {
    cwd: ROOT,
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /BLOCKED — SANDBOX CREDENTIALS NOT CONFIGURED/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /Bearer|sk_live_|EAAA/);
  const ci = spawnSync(process.execPath, [
    'scripts/square-sandbox-smoke-test.js',
    '--confirm-square-sandbox',
  ], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, CI: 'true', SQUARE_SANDBOX_ACCESS_TOKEN: TOKEN },
    encoding: 'utf8',
  });
  assert.equal(ci.status, 2);
  assert.match(ci.stdout, /BLOCKED — CI MUST NOT CALL SQUARE SANDBOX/);
  assert.doesNotMatch(ci.stdout, /same_payment/);
});
