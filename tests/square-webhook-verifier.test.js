'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  DisabledPaymentProvider,
  activePaymentProviderId,
  getActivePaymentProvider,
} = require('../netlify/lib/payment-provider-adapter');
const { customerPaymentsPolicy } = require('../netlify/lib/stripe-customer-payments');
const { legacyStripeRefundsEnabled } = require('../netlify/lib/stripe-legacy-refunds');
const {
  SIGNATURE_HEADER,
  verifySquareWebhookSignature,
} = require('../netlify/lib/square-webhook-verifier');
const {
  DOCUMENTED_PAYMENT_STATUSES,
  PERSISTENT_DEDUPLICATION_CONTRACT,
  interpretVerifiedSquareWebhook,
  reviewSquareWebhookSequence,
} = require('../netlify/lib/square-webhook-event');

const ROOT = path.join(__dirname, '..');
const URL = 'https://example.com/webhook';
const KEY = 'asdf1234';
const OFFICIAL_BODY = '{"hello":"world"}';
const OFFICIAL_SIGNATURE = '2kRE5qRU2tR+tBGlDwMEw2avJ7QM4ikPYD/PJ3bd9Og=';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function sign(url, body, key = KEY) {
  return crypto.createHmac('sha256', key).update(`${url}${body}`).digest('base64');
}

function verify(body, extra = {}) {
  const notificationUrl = Object.prototype.hasOwnProperty.call(extra, 'notificationUrl')
    ? extra.notificationUrl
    : URL;
  const signatureKey = Object.prototype.hasOwnProperty.call(extra, 'signatureKey')
    ? extra.signatureKey
    : KEY;
  const request = {
    rawBody: body,
    notificationUrl,
    signatureKey,
  };
  if (Object.prototype.hasOwnProperty.call(extra, 'signature')) request.signature = extra.signature;
  else if (typeof body === 'string' || Buffer.isBuffer(body)) request.signature = sign(notificationUrl, body, signatureKey);
  if (extra.headers) request.headers = extra.headers;
  return verifySquareWebhookSignature(request);
}

function paymentBody(overrides = {}) {
  const paymentId = overrides.paymentId || 'pay-1';
  return JSON.stringify({
    merchant_id: overrides.merchantId || 'MERCHANT_OK',
    type: overrides.type || 'payment.updated',
    event_id: overrides.eventId || 'evt-1',
    created_at: overrides.createdAt || '2026-01-02T00:00:00.000Z',
    data: {
      type: 'payment',
      id: paymentId,
      object: {
        payment: {
          id: paymentId,
          status: overrides.status || 'COMPLETED',
          amount_money: {
            amount: Object.prototype.hasOwnProperty.call(overrides, 'amount') ? overrides.amount : 100,
            currency: overrides.currency || 'USD',
          },
          card_details: { card: { fingerprint: 'fp-secret-must-not-leak' } },
        },
      },
    },
  });
}

function interpret(body, extra = {}) {
  const verification = verify(body);
  assert.equal(verification.verified, true);
  return interpretVerifiedSquareWebhook({ rawBody: body, verification, ...extra });
}

test('a signature from the Square documentation sample is valid', () => {
  const result = verifySquareWebhookSignature({
    rawBody: OFFICIAL_BODY,
    signature: OFFICIAL_SIGNATURE,
    signatureKey: KEY,
    notificationUrl: URL,
  });
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.parsed, false);
  assert.equal(result.error, null);
  assert.equal(result.financialEffect, 'none');
  assert.equal(result.paymentConfirmed, false);
  assert.equal(result.paid, false);
  assert.equal(result.header, SIGNATURE_HEADER);
  assert.equal(JSON.stringify(result).includes(KEY), false);
  assert.equal(JSON.stringify(result).includes(OFFICIAL_BODY), false);
});

test('an invalid signature is rejected', () => {
  const result = verify(OFFICIAL_BODY, { signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' });
  assert.equal(result.verified, false);
  assert.equal(result.error, 'square_webhook_signature_invalid');
  assert.equal(result.statusCode, 403);
  assert.equal(result.financialEffect, 'none');
});

test('a missing signature is rejected', () => {
  const result = verifySquareWebhookSignature({
    rawBody: OFFICIAL_BODY,
    signatureKey: KEY,
    notificationUrl: URL,
    headers: { host: 'example.com' },
  });
  assert.equal(result.error, 'square_webhook_signature_missing');
  assert.equal(result.verified, false);
});

test('the wrong key is rejected and environment keys are not read', () => {
  const previous = process.env.SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY;
  process.env.SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY = KEY;
  try {
    const wrong = verify(OFFICIAL_BODY, { signatureKey: 'different-key', signature: OFFICIAL_SIGNATURE });
    assert.equal(wrong.error, 'square_webhook_signature_invalid');
    const absent = verifySquareWebhookSignature({
      rawBody: OFFICIAL_BODY,
      signature: OFFICIAL_SIGNATURE,
      notificationUrl: URL,
    });
    assert.equal(absent.error, 'square_webhook_signature_key_missing');
    assert.equal(JSON.stringify(absent).includes(KEY), false);
  } finally {
    if (previous === undefined) delete process.env.SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY;
    else process.env.SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY = previous;
  }
});

test('a different notification URL is rejected', () => {
  const changed = verify(OFFICIAL_BODY, {
    notificationUrl: 'https://example.com/webhook-other',
    signature: OFFICIAL_SIGNATURE,
  });
  assert.equal(changed.error, 'square_webhook_signature_invalid');
  const production = verifySquareWebhookSignature({
    rawBody: OFFICIAL_BODY,
    signature: sign('https://cardetail1.com/hooks/square', OFFICIAL_BODY),
    signatureKey: KEY,
    notificationUrl: 'https://cardetail1.com/hooks/square',
    headers: { host: 'cardetail1.com' },
  });
  assert.equal(production.error, 'square_webhook_notification_url_rejected');
  const insecure = verify(OFFICIAL_BODY, { notificationUrl: 'http://example.com/webhook' });
  assert.equal(insecure.error, 'square_webhook_notification_url_rejected');
  const missing = verifySquareWebhookSignature({
    rawBody: OFFICIAL_BODY,
    signature: OFFICIAL_SIGNATURE,
    signatureKey: KEY,
    headers: { host: 'example.com', 'x-forwarded-host': URL },
  });
  assert.equal(missing.error, 'square_webhook_notification_url_missing');
});

test('a changed JSON body does not match the original signature', () => {
  const changed = verify('{"hello":"world "}', { signature: OFFICIAL_SIGNATURE });
  assert.equal(changed.verified, false);
  assert.equal(changed.error, 'square_webhook_signature_invalid');
  const spaced = verify('{"hello": "world"}', { signature: OFFICIAL_SIGNATURE });
  assert.equal(spaced.error, 'square_webhook_signature_invalid');
});

test('the raw body is not rewritten before the signature check', () => {
  const raw = Buffer.from(OFFICIAL_BODY);
  const before = Buffer.from(raw);
  const result = verifySquareWebhookSignature({
    rawBody: raw,
    signature: OFFICIAL_SIGNATURE,
    signatureKey: KEY,
    notificationUrl: URL,
  });
  assert.equal(result.verified, true);
  assert.deepEqual(raw, before);
  const objectBody = verifySquareWebhookSignature({
    rawBody: { hello: 'world' },
    signature: OFFICIAL_SIGNATURE,
    signatureKey: KEY,
    notificationUrl: URL,
  });
  assert.equal(objectBody.error, 'square_webhook_body_unusable');
  assert.equal(objectBody.parsed, false);
});

test('signature comparison uses timingSafeEqual and does not use string equality', () => {
  const source = read('netlify/lib/square-webhook-verifier.js');
  const compareFn = source.slice(
    source.indexOf('function signaturesMatch'),
    source.indexOf('function squareWebhookBodySha256'),
  );
  assert.match(compareFn, /crypto\.timingSafeEqual/);
  assert.doesNotMatch(compareFn, /(^|[^!])={2}/);
  assert.doesNotMatch(source, /JSON\.parse|console\.|process\.env|api\.stripe\.com/);
  const original = crypto.timingSafeEqual;
  const calls = [];
  crypto.timingSafeEqual = function timingSafeEqualSpy(left, right) {
    calls.push(left === right);
    return original.call(crypto, left, right);
  };
  try {
    const valid = verify(OFFICIAL_BODY, { signature: OFFICIAL_SIGNATURE });
    const invalid = verify(OFFICIAL_BODY, { signature: 'not-the-signature' });
    assert.equal(valid.verified, true);
    assert.equal(invalid.error, 'square_webhook_signature_invalid');
    assert.ok(calls.length >= 2);
    assert.equal(calls.some((sameBuffer) => sameBuffer === true), true);
    assert.equal(calls.some((sameBuffer) => sameBuffer === false), true);
  } finally {
    crypto.timingSafeEqual = original;
  }
});

test('a trusted notification URL is not replaced by a client host header', () => {
  const result = verifySquareWebhookSignature({
    rawBody: OFFICIAL_BODY,
    signature: OFFICIAL_SIGNATURE,
    signatureKey: KEY,
    notificationUrl: URL,
    headers: {
      host: 'cardetail1.com',
      'x-forwarded-host': 'cardetail1.com',
      [SIGNATURE_HEADER]: 'forged',
    },
  });
  assert.equal(result.verified, true);
});

test('payment.created and payment.updated expose the Square payment fields', () => {
  for (const type of ['payment.created', 'payment.updated']) {
    const event = interpret(paymentBody({ type, eventId: `evt-${type}` }));
    assert.equal(event.ok, true, type);
    assert.equal(event.type, type);
    assert.equal(event.eventId, `evt-${type}`);
    assert.equal(event.merchantId, 'MERCHANT_OK');
    assert.equal(event.paymentId, 'pay-1');
    assert.equal(event.status, 'COMPLETED');
    assert.equal(event.amountCents, 100);
    assert.equal(event.currency, 'USD');
    assert.equal(event.squareReportedCompleted, true);
    assert.equal(event.paymentConfirmed, false);
    assert.equal(event.financialEffect, 'none');
    assert.equal(JSON.stringify(event).includes('fp-secret-must-not-leak'), false);
  }
});

test('COMPLETED, APPROVED, FAILED, and CANCELED stay representations', () => {
  const expectations = {
    COMPLETED: { statusClass: 'completed', squareReportedCompleted: true },
    APPROVED: { statusClass: 'approved', squareReportedCompleted: false },
    PENDING: { statusClass: 'pending', squareReportedCompleted: false },
    FAILED: { statusClass: 'failed', squareReportedCompleted: false },
    CANCELED: { statusClass: 'canceled', squareReportedCompleted: false },
  };
  for (const status of DOCUMENTED_PAYMENT_STATUSES) {
    const event = interpret(paymentBody({ status, eventId: `evt-${status}` }));
    assert.equal(event.statusClass, expectations[status].statusClass, status);
    assert.equal(event.squareReportedCompleted, expectations[status].squareReportedCompleted, status);
    assert.equal(event.paymentConfirmed, false, status);
    assert.equal(event.paid, false, status);
    assert.equal(event.created, false, status);
    assert.equal(event.ledgerWrite, false, status);
  }
  const other = interpret(paymentBody({ status: 'CANCELLED', eventId: 'evt-other' }));
  assert.equal(other.statusClass, 'other');
  assert.equal(other.squareReportedCompleted, false);
  assert.equal(other.financialEffect, 'none');
});

test('the same event id is a duplicate only inside the supplied list', () => {
  const event = interpret(paymentBody());
  const review = reviewSquareWebhookSequence([event, event]);
  assert.equal(review.steps[0].apply, true);
  assert.equal(review.steps[1].duplicate, true);
  assert.equal(review.steps[1].apply, false);
  assert.equal(review.payments['pay-1'].status, 'COMPLETED');
  assert.equal(review.payments['pay-1'].paymentConfirmed, false);
  const again = reviewSquareWebhookSequence([event]);
  assert.equal(again.steps[0].apply, true);
  assert.equal(again.durable, false);
  assert.equal(again.productionSafe, false);
  assert.equal(again.memoryOnlySufficient, false);
  assert.equal(PERSISTENT_DEDUPLICATION_CONTRACT.implemented, false);
  assert.match(PERSISTENT_DEDUPLICATION_CONTRACT.statement, /memory does not protect production/i);
});

test('different events for one payment and out-of-order arrivals do not regress status', () => {
  const created = interpret(paymentBody({
    type: 'payment.created',
    eventId: 'evt-created',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'APPROVED',
  }));
  const pending = interpret(paymentBody({
    type: 'payment.updated',
    eventId: 'evt-pending',
    createdAt: '2026-01-02T00:00:00.000Z',
    status: 'PENDING',
  }));
  const completed = interpret(paymentBody({
    type: 'payment.updated',
    eventId: 'evt-completed',
    createdAt: '2026-01-03T00:00:00.000Z',
    status: 'COMPLETED',
  }));
  const forward = reviewSquareWebhookSequence([created, pending, completed]);
  assert.equal(forward.steps[1].duplicate, false);
  assert.equal(forward.steps[1].samePayment, true);
  assert.equal(forward.steps[2].statusChanged, true);
  assert.equal(forward.steps[2].paymentConfirmed, false);
  assert.equal(forward.payments['pay-1'].status, 'COMPLETED');
  assert.equal(forward.financialEffect, 'none');

  const backward = reviewSquareWebhookSequence([completed, pending, created]);
  assert.equal(backward.steps[1].reason, 'older_event_after_newer');
  assert.equal(backward.steps[1].retainedStatus, 'COMPLETED');
  assert.equal(backward.steps[2].reason, 'created_after_updated');
  assert.equal(backward.payments['pay-1'].status, 'COMPLETED');
  assert.equal(backward.ledgerWrite, false);
});

test('an unknown event, an unexpected merchant, and an incomplete payload have no financial effect', () => {
  const unknown = interpret(JSON.stringify({
    merchant_id: 'MERCHANT_OK',
    type: 'refund.created',
    event_id: 'evt-unknown',
    created_at: '2026-01-02T00:00:00.000Z',
  }));
  assert.equal(unknown.unknownEvent, true);
  assert.equal(unknown.error, 'square_webhook_event_unsupported');
  assert.equal(unknown.financialEffect, 'none');

  const merchant = interpret(paymentBody({ merchantId: 'MERCHANT_OTHER', eventId: 'evt-merchant' }), {
    expectedMerchantId: 'MERCHANT_OK',
  });
  assert.equal(merchant.error, 'square_webhook_merchant_unexpected');
  assert.equal(merchant.paymentConfirmed, false);

  const incompleteBody = JSON.stringify({
    merchant_id: 'MERCHANT_OK',
    type: 'payment.updated',
    event_id: 'evt-partial',
    created_at: '2026-01-02T00:00:00.000Z',
    data: { object: { payment: { id: 'pay-partial', status: 'COMPLETED' } } },
  });
  const incomplete = interpret(incompleteBody);
  assert.equal(incomplete.error, 'square_webhook_payload_incomplete');

  const swapped = verify(paymentBody());
  const rebound = interpretVerifiedSquareWebhook({
    rawBody: paymentBody({ status: 'FAILED', eventId: 'evt-swapped' }),
    verification: swapped,
  });
  assert.equal(rebound.error, 'square_webhook_not_verified');
  assert.equal(rebound.parsed, false);

  const review = reviewSquareWebhookSequence([unknown, merchant, incomplete, {
    ok: true,
    verified: true,
    bound: false,
    eventId: 'evt-forged',
    paymentId: 'pay-forged',
    status: 'COMPLETED',
    type: 'payment.updated',
    createdAtMs: Date.parse('2026-01-04T00:00:00.000Z'),
    financialEffect: 'none',
  }]);
  assert.equal(review.payments['pay-forged'], undefined);
  assert.equal(review.payments['pay-1'], undefined);
  assert.equal(review.steps.every((step) => step.apply === false && step.financialEffect === 'none'), true);
});

test('validation does not write money, call the network, reopen Stripe, or select a provider', async () => {
  const previousFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = () => {
    networkCalls += 1;
    throw new Error('network is forbidden');
  };
  const previousProvider = process.env.PAYMENT_PROVIDER;
  process.env.PAYMENT_PROVIDER = 'square';
  try {
    const event = interpret(paymentBody());
    const review = reviewSquareWebhookSequence([event]);
    assert.equal(networkCalls, 0);
    assert.equal(event.externalCall, false);
    assert.equal(event.ledgerWrite, false);
    assert.equal(event.chargeAuthorized, false);
    assert.equal(review.steps[0].apply, true);
    assert.equal(review.paid, false);
    assert.deepEqual(event.effectsExecuted, []);
    assert.equal(activePaymentProviderId(), 'none');
    const provider = getActivePaymentProvider();
    assert.ok(provider instanceof DisabledPaymentProvider);
    const offline = await provider.createPayment({ method: 'cash', amountCents: 100 });
    assert.equal(offline.error, 'offline_settlement_outside_adapter');
    assert.equal(offline.externalCall, false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousProvider === undefined) delete process.env.PAYMENT_PROVIDER;
    else process.env.PAYMENT_PROVIDER = previousProvider;
  }

  assert.equal(legacyStripeRefundsEnabled({}), false);
  assert.equal(customerPaymentsPolicy({
    CONTEXT: 'production',
    STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED: 'true',
  }).enabled, false);
  assert.match(read('netlify/lib/deploy-runtime-env.generated.js'), /STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED:\s*false/);

  const verifier = read('netlify/lib/square-webhook-verifier.js');
  const events = read('netlify/lib/square-webhook-event.js');
  const combined = `${verifier}\n${events}`;
  assert.doesNotMatch(combined, /require\('\.\/prisma|payment-authority|square-sandbox-provider|api\.stripe\.com|fetch\(/);
  assert.equal(verifier.includes('JSON.parse'), false);
  const commercial = [
    'netlify/functions/submit-booking.js',
    'netlify/functions/admin-ops-jobs.js',
    'netlify/functions/stripe-webhook.js',
    'netlify/functions/admin-quick-ops.js',
    'netlify/functions/tech-quick-ops.js',
    'netlify/functions/customer-portal-data.js',
    'netlify/lib/db/payment-authority-service.js',
    'netlify/lib/payment-provider-adapter.js',
    'netlify/lib/square-sandbox-provider.js',
  ];
  for (const file of commercial) {
    assert.equal(read(file).includes('square-webhook'), false, file);
  }
  const functions = fs.readdirSync(path.join(ROOT, 'netlify/functions'));
  assert.equal(functions.some((name) => /square/i.test(name)), false);
  assert.doesNotMatch(read('.github/workflows/integration.yml'), /SQUARE_SANDBOX|square-webhook/);
});
