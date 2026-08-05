'use strict';

const crypto = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const ENV_KEYS = [
  'STRIPE_WEBHOOK_SECRET',
  'BID_SECRET',
  'ADMIN_EMAIL',
  'RESEND_API_KEY',
  'TWILIO_SID',
  'TWILIO_TOKEN',
  'TWILIO_FROM',
];
const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const secret = 'whsec_routing_test_only';

function memoryStore(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    values,
    async get(key) { return values.get(key) || null; },
    async setJSON(key, value) { values.set(key, structuredClone(value)); },
    async list() { return { blobs: [...values.keys()].map((key) => ({ key })) }; },
  };
}

const stores = {
  'cd1-bookings': memoryStore(),
  'cd1-auctions': memoryStore(),
  'cd1-techs': memoryStore({ roster: [] }),
};

function signedRequest(event) {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`, 'utf8')
    .digest('hex');
  return {
    httpMethod: 'POST',
    headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` },
    body,
  };
}

function paymentEvent(type, bookingId, purpose = 'authoritative_balance', extra = {}) {
  return {
    id: `evt_${type.replace(/[^a-z]/gi, '_')}_${bookingId}`,
    type,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: `pi_${bookingId}`,
        amount: 5000,
        amount_received: type === 'payment_intent.succeeded' ? 5000 : 0,
        currency: 'usd',
        status: type.split('.').pop(),
        metadata: {
          booking_id: bookingId,
          ...(purpose == null ? {} : { purpose }),
        },
        ...extra,
      },
    },
  };
}

let webhook;

before(() => {
  process.env.STRIPE_WEBHOOK_SECRET = secret;
  process.env.BID_SECRET = 'bid_test_only';
  delete process.env.ADMIN_EMAIL;
  delete process.env.RESEND_API_KEY;
  delete process.env.TWILIO_SID;
  delete process.env.TWILIO_TOKEN;
  delete process.env.TWILIO_FROM;
  delete require.cache[require.resolve('../netlify/functions/stripe-webhook')];
  webhook = require('../netlify/functions/stripe-webhook');
  webhook.__test.setBlobsStoreOverride((name) => stores[name] || memoryStore());
});

after(() => {
  webhook.__test.setBlobsStoreOverride(null);
  for (const key of ENV_KEYS) {
    if (previousEnv[key] == null) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  delete require.cache[require.resolve('../netlify/functions/stripe-webhook')];
});

test('PaymentIntent purpose routing is explicit and mutually exclusive', () => {
  const classify = webhook.__test.classifyPaymentIntentRoute;
  assert.equal(classify(
    { type: 'payment_intent.succeeded' },
    { metadata: { purpose: 'customer_balance' } }
  ).route, 'customer_balance');
  assert.equal(classify(
    { type: 'payment_intent.amount_capturable_updated' },
    { metadata: { purpose: 'authoritative_balance' } }
  ).route, 'legacy_operational');
  assert.equal(classify(
    { type: 'payment_intent.succeeded' },
    { metadata: {} }
  ).route, 'legacy_operational_unmarked');
  assert.equal(classify(
    { type: 'payment_intent.succeeded' },
    { metadata: { purpose: 'unrecognized_flow' } }
  ).route, 'unknown_purpose');
  assert.equal(classify(
    { type: 'payment_intent.processing' },
    { metadata: { purpose: 'customer_balance' } }
  ).route, 'unsupported_customer_balance_event');
});

test('legacy amount_capturable_updated still authorizes and dispatches exactly one auction on replay', async () => {
  const bookingId = 'BK-AUCTION';
  stores['cd1-bookings'].values.set(bookingId, {
    id: bookingId,
    status: 'Confirmed',
    jobStatus: 'confirmed',
    totalPrice: 50,
  });
  const event = paymentEvent('payment_intent.amount_capturable_updated', bookingId);
  const first = await webhook.handler(signedRequest(event));
  const second = await webhook.handler(signedRequest(event));
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(JSON.parse(first.body).route, 'legacy_operational');
  assert.equal(stores['cd1-bookings'].values.get(bookingId).paymentStatus, 'authorized');
  assert.equal(stores['cd1-auctions'].values.size, 1);
  assert.equal(stores['cd1-auctions'].values.get(bookingId).status, 'open');
});

test('legacy succeeded, failed, canceled, and requires_action events remain operationally reachable', async () => {
  const cases = [
    ['payment_intent.succeeded', 'paid'],
    ['payment_intent.payment_failed', 'authorization_failed'],
    ['payment_intent.canceled', 'canceled'],
    ['payment_intent.requires_action', 'authorization_pending'],
  ];
  for (const [type, expected] of cases) {
    const bookingId = `BK-${expected.toUpperCase()}`;
    stores['cd1-bookings'].values.set(bookingId, { id: bookingId, paymentStatus: 'authorization_pending' });
    const response = await webhook.handler(signedRequest(paymentEvent(type, bookingId)));
    assert.equal(response.statusCode, 200, `${type}: ${response.body}`);
    assert.equal(JSON.parse(response.body).route, 'legacy_operational');
    assert.equal(stores['cd1-bookings'].values.get(bookingId).paymentStatus, expected);
  }
});

test('missing purpose uses bounded legacy compatibility; unknown purpose is ignored without mutation', async () => {
  const legacyId = 'BK-NO-PURPOSE';
  stores['cd1-bookings'].values.set(legacyId, { id: legacyId, paymentStatus: 'authorization_pending' });
  const legacy = await webhook.handler(signedRequest(paymentEvent('payment_intent.succeeded', legacyId, null)));
  assert.equal(legacy.statusCode, 200);
  assert.equal(JSON.parse(legacy.body).route, 'legacy_operational_unmarked');
  assert.equal(stores['cd1-bookings'].values.get(legacyId).paymentStatus, 'paid');

  const unknownId = 'BK-UNKNOWN-PURPOSE';
  stores['cd1-bookings'].values.set(unknownId, { id: unknownId, paymentStatus: 'authorization_pending' });
  const unknown = await webhook.handler(signedRequest(
    paymentEvent('payment_intent.succeeded', unknownId, 'other_product')
  ));
  assert.equal(unknown.statusCode, 200);
  assert.equal(JSON.parse(unknown.body).reason, 'unknown_purpose');
  assert.equal(stores['cd1-bookings'].values.get(unknownId).paymentStatus, 'authorization_pending');
});

test('dead reconciliation footguns are absent from the runtime', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const webhookSource = fs.readFileSync(path.join(root, 'netlify/functions/stripe-webhook.js'), 'utf8');
  const authoritySource = fs.readFileSync(path.join(root, 'netlify/lib/db/payment-authority-service.js'), 'utf8');
  assert.doesNotMatch(webhookSource, /reconcilePostgresPaymentIntentLegacy/);
  assert.doesNotMatch(authoritySource, /reconcilePaymentIntentEventLegacy/);
});
