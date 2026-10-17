'use strict';

const crypto = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { getPrisma } = require('../netlify/lib/prisma');
const { financialProjection } = require('../netlify/lib/payment-service');
const { chargeSavedCardAfterService, PURPOSE } = require('../netlify/lib/charge-saved-card-after-service');
const { observeProviderPaymentIntent } = require('../netlify/lib/db/payment-authority-service');
const {
  SANDBOX_BAKE,
  setBakedCustomerPaymentsSnapshot,
  clearBakedCustomerPaymentsSnapshot,
} = require('../netlify/lib/stripe-customer-payments');

const secret = 'whsec_capture_idempotency_test_only';
const ENV = {
  STRIPE_SECRET_KEY: 'sk_test_capture_idempotency',
  CONTEXT: 'production',
  SITE_URL: 'https://cardetail1.com',
  CD1_POSTGRES_PAYMENT: '1',
  STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED: 'true',
};

function memoryStore(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    values,
    async get(key) { return values.get(key) || null; },
    async setJSON(key, value) { values.set(key, structuredClone(value)); },
    async list() { return { blobs: [...values.keys()].map((key) => ({ key })) }; },
  };
}

const stores = { 'cd1-bookings': memoryStore() };
let webhook;
let seq = 0;

function id(prefix) {
  seq += 1;
  return `${prefix}-${seq}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function signedRequest(event) {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
  return {
    httpMethod: 'POST',
    headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` },
    body,
  };
}

function legacyEvent(type, bookingId, piId, extra = {}) {
  return {
    id: extra.eventId || id('evt'),
    type,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: piId,
        object: 'payment_intent',
        amount: 5000,
        amount_received: type === 'payment_intent.succeeded' ? 5000 : 0,
        currency: 'usd',
        status: {
          'payment_intent.succeeded': 'succeeded',
          'payment_intent.payment_failed': 'requires_payment_method',
          'payment_intent.canceled': 'canceled',
          'payment_intent.requires_action': 'requires_action',
        }[type],
        metadata: {
          booking_id: bookingId,
          bookingId,
          purpose: 'authoritative_balance',
          ...(extra.metadata || {}),
        },
        ...extra.intent,
      },
    },
  };
}

function booking(extra = {}) {
  const bookingId = extra.id || id('CD1-CAP');
  return {
    id: bookingId,
    bookingVersion: 4,
    quoteVersion: 1,
    finalizedAt: '2026-09-20T15:00:00.000Z',
    jobStatus: 'completed_pending_admin_review',
    appointmentStatus: 'confirmed',
    status: 'Confirmed',
    paymentMethodPreference: 'online_after_service',
    paymentMethod: 'online_after_service',
    cardOnFileStatus: 'saved',
    acceptedCardOnFilePolicy: true,
    afterServiceChargeConsentVersion: '2026-09-after-service-charge',
    afterServiceChargeConsentAt: '2026-09-27T15:00:00.000Z',
    stripeCustomerId: 'cus_test_saved',
    stripePaymentMethodId: 'pm_test_saved',
    setupIntentId: 'seti_test_saved',
    approvedFinalAmount: 50,
    totalPrice: 50,
    amountPaid: 0,
    balanceDue: 50,
    paymentStatus: 'due',
    ledger: {
      currency: 'usd',
      approvedCents: 5000,
      settledCents: 0,
      creditedCents: 0,
      entries: [],
    },
    ...extra,
    id: bookingId,
  };
}

function partialBooking(extra = {}) {
  return booking({
    quoteVersion: 2,
    approvedFinalAmount: 180,
    totalPrice: 180,
    amountPaid: 30,
    balanceDue: 150,
    paymentStatus: 'partially_paid',
    ledger: {
      currency: 'usd',
      approvedCents: 18000,
      settledCents: 3000,
      creditedCents: 0,
      entries: [{
        entryId: 'le_prior',
        kind: 'settlement',
        amountCents: 3000,
        providerEventId: 'cs_prior',
        currency: 'usd',
      }],
    },
    ...extra,
  });
}

function stripeFetch(httpStatus, body) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, body: String(opts.body || ''), headers: opts.headers });
    return { status: httpStatus, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

function succeededIntent(amount, piId) {
  return {
    id: piId,
    object: 'payment_intent',
    status: 'succeeded',
    currency: 'usd',
    amount,
    amount_received: amount,
  };
}

async function rows(bookingId) {
  const prisma = getPrisma();
  const [attempts, ledger, events] = await Promise.all([
    prisma.paymentAttempt.findMany({ where: { bookingId }, orderBy: { createdAt: 'asc' } }),
    prisma.ledgerEntry.findMany({ where: { bookingId }, orderBy: { recordedAt: 'asc' } }),
    prisma.stripeEvent.findMany({ where: { bookingId }, orderBy: { createdAt: 'asc' } }),
  ]);
  return { attempts, ledger, events };
}

function captureRows(ledger, piId) {
  return ledger.filter((entry) => entry.kind === 'settlement' && entry.providerEventId === `settlement_${piId}`);
}

before(() => {
  setBakedCustomerPaymentsSnapshot(SANDBOX_BAKE);
  process.env.STRIPE_WEBHOOK_SECRET = secret;
  delete process.env.ADMIN_EMAIL;
  delete process.env.RESEND_API_KEY;
  delete require.cache[require.resolve('../netlify/functions/stripe-webhook')];
  webhook = require('../netlify/functions/stripe-webhook');
  webhook.__test.setBlobsStoreOverride((name) => stores[name] || memoryStore());
});

after(() => {
  clearBakedCustomerPaymentsSnapshot();
  webhook.__test.setBlobsStoreOverride(null);
  delete process.env.STRIPE_WEBHOOK_SECRET;
});

test('a saved-card after-service capture is recorded once and a refresh does not capture again', async () => {
  const current = partialBooking();
  const piId = id('pi_saved');
  const fetchImpl = stripeFetch(200, succeededIntent(15000, piId));
  const first = await chargeSavedCardAfterService({
    booking: current,
    projection: financialProjection(current),
    env: ENV,
    fetchImpl,
    confirmCharge: true,
    expectedChargeCents: 15000,
  });
  assert.equal(first.charged, true, first.error);
  assert.equal(first.booking.paymentStatus, 'paid');
  assert.equal(first.booking.ledger.settledCents, 18000);
  const params = new URLSearchParams(fetchImpl.calls[0].body);
  assert.equal(params.get('amount'), '15000');
  assert.equal(params.get('currency'), 'usd');
  assert.equal(params.get('customer'), 'cus_test_saved');
  assert.equal(params.get('payment_method'), 'pm_test_saved');
  assert.equal(fetchImpl.calls[0].headers['Idempotency-Key'], `after_service_${current.id}_2_15000`);

  const second = await chargeSavedCardAfterService({
    booking: first.booking,
    projection: financialProjection(first.booking),
    env: ENV,
    fetchImpl,
    confirmCharge: true,
    expectedChargeCents: 15000,
  });
  assert.equal(second.stripeCalled, false);
  assert.equal(fetchImpl.calls.length, 1);

  const stored = await rows(current.id);
  const captures = captureRows(stored.ledger, piId);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].amountCents, 15000);
  assert.equal(captures[0].currency, 'usd');
  assert.equal(stored.attempts.length, 1);
  assert.equal(stored.attempts[0].purpose, PURPOSE);
  assert.equal(stored.attempts[0].status, 'succeeded');
  assert.equal(stored.attempts[0].amountCents, 15000);
  assert.equal(stored.attempts[0].providerObjectId, piId);
  assert.equal(stored.attempts[0].idempotencyKey, `after_service_${current.id}_2_15000`);
  assert.equal(stored.ledger.filter((entry) => entry.providerEventId === `blob_seed_${current.id}_3000`).length, 1);
  assert.equal(stored.events.filter((event) => event.status === 'processed').length, 1);
});

test('a timeout retry reuses the same Stripe idempotency key and one ledger credit', async () => {
  const current = partialBooking();
  const piId = id('pi_timeout');
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(opts.headers['Idempotency-Key']);
    return { status: 200, json: async () => succeededIntent(15000, piId) };
  };
  let dropResult = true;
  const persistBooking = async (next) => {
    if (next.afterServiceCharge && next.afterServiceCharge.status === 'charging') {
      return { ok: true, booking: next };
    }
    if (dropResult) return { ok: false, error: 'lost_response' };
    return { ok: true, booking: next };
  };
  const first = await chargeSavedCardAfterService({
    booking: current,
    projection: financialProjection(current),
    env: ENV,
    fetchImpl,
    confirmCharge: true,
    expectedChargeCents: 15000,
    persistBooking,
  });
  assert.equal(first.persisted, false);
  assert.notEqual(first.booking.paymentStatus, 'paid');
  dropResult = false;
  const second = await chargeSavedCardAfterService({
    booking: first.booking,
    projection: financialProjection(first.booking),
    env: ENV,
    fetchImpl,
    confirmCharge: true,
    expectedChargeCents: 15000,
    persistBooking,
  });
  assert.equal(second.charged, true, second.error);
  assert.equal(calls.length, 2);
  assert.equal(calls[0], calls[1]);
  const stored = await rows(current.id);
  assert.equal(captureRows(stored.ledger, piId).length, 1);
});

test('requires_action and a declined card do not become a payment', async () => {
  for (const [label, httpStatus, intent, expectedStatus] of [
    ['requires_action', 200, {
      status: 'requires_action',
      amount: 15000,
    }, 'requires_action'],
    ['declined', 402, {
      status: 'requires_payment_method',
      amount: 15000,
      last_payment_error: { code: 'card_declined', message: 'Your card was declined.' },
    }, 'failed'],
  ]) {
    const current = partialBooking({ jobStatus: 'completed_pending_payment' });
    const piId = id(`pi_${label}`);
    const fetchImpl = stripeFetch(httpStatus, {
      id: piId,
      object: 'payment_intent',
      currency: 'usd',
      ...intent,
    });
    const result = await chargeSavedCardAfterService({
      booking: current,
      projection: financialProjection(current),
      env: ENV,
      fetchImpl,
      confirmCharge: true,
      expectedChargeCents: 15000,
    });
    assert.equal(result.charged, false, label);
    assert.notEqual(result.booking.paymentStatus, 'paid', label);
    assert.equal(result.booking.ledger.settledCents, 3000, label);
    assert.equal(result.booking.jobStatus, 'completed_pending_payment', label);
    assert.match(result.recoveryUrl, /pay=balance/, label);
    const stored = await rows(current.id);
    assert.equal(captureRows(stored.ledger, piId).length, 0, label);
    assert.equal(stored.attempts.length, 1, label);
    assert.equal(stored.attempts[0].status, expectedStatus, label);
    assert.equal(fetchImpl.calls.length, 1, label);
  }
});

test('postgres disabled refuses to mark a succeeded saved-card charge paid', async () => {
  const current = partialBooking();
  const piId = id('pi_off');
  const fetchImpl = stripeFetch(200, succeededIntent(15000, piId));
  const result = await chargeSavedCardAfterService({
    booking: current,
    projection: financialProjection(current),
    env: { ...ENV, CD1_POSTGRES_PAYMENT: '0' },
    fetchImpl,
    confirmCharge: true,
    expectedChargeCents: 15000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.charged, false);
  assert.equal(result.error, 'postgres_payment_disabled');
  assert.notEqual(result.booking.paymentStatus, 'paid');
  assert.equal(fetchImpl.calls.length, 1);
  const stored = await rows(current.id);
  assert.equal(stored.attempts.length, 0);
  assert.equal(stored.ledger.length, 0);
});

test('a repeated legacy webhook and two concurrent deliveries credit one settlement', async () => {
  const bookingId = id('BK-LEGACY');
  const piId = id('pi_legacy');
  stores['cd1-bookings'].values.set(bookingId, booking({ id: bookingId }));
  const event = legacyEvent('payment_intent.succeeded', bookingId, piId);
  const first = await webhook.handler(signedRequest(event));
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(JSON.parse(first.body).settled, true);
  assert.equal(stores['cd1-bookings'].values.get(bookingId).paymentStatus, 'paid');
  assert.equal(stores['cd1-bookings'].values.get(bookingId).ledger.settledCents, 5000);

  const second = await webhook.handler(signedRequest(event));
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(JSON.parse(second.body).duplicate, true);
  assert.equal(stores['cd1-bookings'].values.get(bookingId).ledger.entries
    .filter((entry) => entry.providerEventId === piId).length, 1);

  const otherId = id('BK-CONCURRENT');
  const otherPi = id('pi_concurrent');
  stores['cd1-bookings'].values.set(otherId, booking({ id: otherId }));
  const concurrent = legacyEvent('payment_intent.succeeded', otherId, otherPi);
  const responses = await Promise.all([
    webhook.handler(signedRequest(concurrent)),
    webhook.handler(signedRequest(concurrent)),
  ]);
  assert.ok(responses.every((response) => response.statusCode === 200 || response.statusCode === 500));
  assert.ok(responses.some((response) => response.statusCode === 200));
  const stored = await rows(otherId);
  assert.equal(captureRows(stored.ledger, otherPi).length, 1);
  assert.equal(stored.attempts.length, 1);
  assert.equal(stored.attempts[0].purpose, 'authoritative_balance');
  assert.equal(stored.attempts[0].idempotencyKey, `legacy_authoritative_balance_${otherId}_1_${otherPi}`);
  assert.equal(stores['cd1-bookings'].values.get(otherId).paymentStatus, 'paid');
});

test('a blob capture missing its ledger is repaired once and does not charge', async () => {
  const bookingId = id('BK-NLEDGER');
  const piId = id('pi_nledger');
  const current = booking({
    id: bookingId,
    paymentStatus: 'paid',
    paymentIntentId: piId,
    ledger: {
      currency: 'usd',
      approvedCents: 5000,
      settledCents: 5000,
      creditedCents: 0,
      entries: [{
        entryId: `le_${piId}`,
        kind: 'settlement',
        amountCents: 5000,
        currency: 'usd',
        providerObjectId: piId,
        providerEventId: piId,
      }],
    },
  });
  stores['cd1-bookings'].values.set(bookingId, current);
  const previousFetch = global.fetch;
  global.fetch = () => { throw new Error('stripe_called'); };
  try {
    const response = await webhook.handler(signedRequest(
      legacyEvent('payment_intent.succeeded', bookingId, piId)
    ));
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(JSON.parse(response.body).settled, true);
  } finally {
    global.fetch = previousFetch;
  }
  const stored = await rows(bookingId);
  assert.equal(captureRows(stored.ledger, piId).length, 1);
  assert.equal(stored.ledger.filter((entry) => entry.actor === 'blob_import_seed').length, 0);
  assert.equal(stores['cd1-bookings'].values.get(bookingId).ledger.entries
    .filter((entry) => entry.providerEventId === piId).length, 1);
});

test('an existing ledger row finishes the blob mirror without a second credit', async () => {
  const bookingId = id('BK-NOBLOB');
  const piId = id('pi_noblob');
  const current = booking({ id: bookingId });
  const previousFetch = global.fetch;
  global.fetch = () => { throw new Error('stripe_called'); };
  try {
    const observed = await observeProviderPaymentIntent({
      booking: current,
      paymentIntent: {
        id: piId,
        object: 'payment_intent',
        amount: 5000,
        amount_received: 5000,
        currency: 'usd',
        status: 'succeeded',
        metadata: { bookingId, booking_id: bookingId, purpose: 'authoritative_balance' },
      },
      stripeEventId: id('evt_direct'),
      type: 'payment_intent.succeeded',
    });
    assert.equal(observed.ok, true, observed.error);
    assert.equal(current.paymentStatus, 'due');
    stores['cd1-bookings'].values.set(bookingId, current);
    const response = await webhook.handler(signedRequest(
      legacyEvent('payment_intent.succeeded', bookingId, piId)
    ));
    assert.equal(response.statusCode, 200, response.body);
  } finally {
    global.fetch = previousFetch;
  }
  const saved = stores['cd1-bookings'].values.get(bookingId);
  assert.equal(saved.paymentStatus, 'paid');
  assert.equal(saved.ledger.settledCents, 5000);
  const stored = await rows(bookingId);
  assert.equal(captureRows(stored.ledger, piId).length, 1);
});

test('amount, currency, and purpose divergence are quarantined and do not mark paid', async () => {
  const amountId = id('BK-AMOUNT');
  const amountPi = id('pi_amount');
  stores['cd1-bookings'].values.set(amountId, booking({ id: amountId }));
  const amount = await webhook.handler(signedRequest(legacyEvent(
    'payment_intent.succeeded',
    amountId,
    amountPi,
    { intent: { amount: 1000, amount_received: 1000 } }
  )));
  assert.equal(amount.statusCode, 200, amount.body);
  assert.equal(JSON.parse(amount.body).quarantined, true);
  assert.equal(JSON.parse(amount.body).error, 'payment_amount_mismatch');
  assert.equal(stores['cd1-bookings'].values.get(amountId).paymentStatus, 'due');
  assert.equal(captureRows((await rows(amountId)).ledger, amountPi).length, 0);

  const currencyId = id('BK-CURRENCY');
  const currencyPi = id('pi_currency');
  stores['cd1-bookings'].values.set(currencyId, booking({ id: currencyId }));
  const currency = await webhook.handler(signedRequest(legacyEvent(
    'payment_intent.succeeded',
    currencyId,
    currencyPi,
    { intent: { currency: 'eur' } }
  )));
  assert.equal(JSON.parse(currency.body).quarantined, true);
  assert.equal(JSON.parse(currency.body).error, 'payment_currency_mismatch');
  assert.equal(stores['cd1-bookings'].values.get(currencyId).paymentStatus, 'due');
  assert.equal((await rows(currencyId)).ledger.length, 0);

  const purposeId = id('BK-PURPOSE');
  const purposePi = id('pi_purpose');
  stores['cd1-bookings'].values.set(purposeId, booking({ id: purposeId }));
  const seeded = await observeProviderPaymentIntent({
    booking: stores['cd1-bookings'].values.get(purposeId),
    paymentIntent: {
      id: purposePi,
      amount: 5000,
      amount_received: 5000,
      currency: 'usd',
      status: 'succeeded',
      metadata: { bookingId: purposeId, purpose: 'authoritative_balance' },
    },
    stripeEventId: id('evt_purpose_seed'),
    type: 'payment_intent.succeeded',
  });
  assert.equal(seeded.ok, true, seeded.error);
  const divergent = await observeProviderPaymentIntent({
    booking: stores['cd1-bookings'].values.get(purposeId),
    paymentIntent: {
      id: purposePi,
      amount: 5000,
      amount_received: 5000,
      currency: 'usd',
      status: 'succeeded',
      metadata: { bookingId: purposeId, purpose: 'approved_balance_after_service' },
    },
    stripeEventId: id('evt_purpose_bad'),
    type: 'payment_intent.succeeded',
  });
  assert.equal(divergent.quarantined, true);
  assert.equal(divergent.error, 'payment_attempt_divergence');
  assert.equal(stores['cd1-bookings'].values.get(purposeId).paymentStatus, 'due');
  assert.equal(captureRows((await rows(purposeId)).ledger, purposePi).length, 1);

  const unmarkedId = id('BK-UNMARKED');
  stores['cd1-bookings'].values.set(unmarkedId, booking({ id: unmarkedId }));
  const unmarked = await webhook.handler(signedRequest(legacyEvent(
    'payment_intent.succeeded',
    unmarkedId,
    id('pi_unmarked'),
    { metadata: { purpose: undefined } }
  )));
  const unmarkedBody = JSON.parse(unmarked.body);
  assert.equal(unmarkedBody.route, 'legacy_operational_unmarked');
  assert.equal(unmarkedBody.quarantined, true);
  assert.equal(unmarkedBody.error, 'legacy_purpose_missing');
  assert.equal(stores['cd1-bookings'].values.get(unmarkedId).paymentStatus, 'due');
});

test('legacy failure and authentication events stay unpaid', async () => {
  for (const [type, expected] of [
    ['payment_intent.payment_failed', 'authorization_failed'],
    ['payment_intent.requires_action', 'authorization_pending'],
    ['payment_intent.canceled', 'canceled'],
  ]) {
    const bookingId = id(`BK-${expected}`);
    const piId = id('pi_ops');
    stores['cd1-bookings'].values.set(bookingId, booking({ id: bookingId, paymentStatus: 'authorization_pending' }));
    const response = await webhook.handler(signedRequest(legacyEvent(type, bookingId, piId)));
    assert.equal(response.statusCode, 200, `${type}: ${response.body}`);
    assert.equal(stores['cd1-bookings'].values.get(bookingId).paymentStatus, expected);
    const stored = await rows(bookingId);
    assert.equal(captureRows(stored.ledger, piId).length, 0);
    assert.equal(stored.attempts.length, 1);
    assert.notEqual(stored.attempts[0].status, 'succeeded');
  }
});
