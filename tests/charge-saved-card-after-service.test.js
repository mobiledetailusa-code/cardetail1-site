'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCasMemoryStore } = require('./helpers/cas-memory-store');
const { setBookingStoreOverride } = require('../netlify/lib/booking-repository');
const { financialProjection } = require('../netlify/lib/payment-service');
const {
  chargeSavedCardAfterService,
  applyAfterServiceStripeEvent,
  customerRecoveryBlocked,
  PURPOSE,
  AFTER_SERVICE_CHARGE_CONSENT_VERSION,
} = require('../netlify/lib/charge-saved-card-after-service');
const { stampAfterServiceChargeConsent } = require('../netlify/lib/customer-policy');

const ENV = {
  STRIPE_SECRET_KEY: 'sk_test_after_service_isolated',
  CONTEXT: 'production',
  CD1_POSTGRES_PAYMENT: '0',
  SITE_URL: 'https://cardetail1.com',
};

function booking(extra = {}) {
  return {
    id: 'CD1-CHARGE-1',
    bookingVersion: 4,
    quoteVersion: 2,
    schemaVersion: 1,
    finalizedAt: '2026-09-20T15:00:00.000Z',
    firstName: 'Pat',
    lastName: 'Customer',
    email: 'pat-charge@example.com',
    phone: '2015550144',
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
    approvedFinalAmount: 180,
    totalPrice: 180,
    amountPaid: 30,
    balanceDue: 150,
    paymentStatus: 'partially_paid',
    paymentWorkflowStatus: 'partially_paid',
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
  };
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

function succeededIntent(amount) {
  return {
    id: 'pi_after_ok',
    object: 'payment_intent',
    status: 'succeeded',
    amount,
    amount_received: amount,
  };
}

test('success charges only the unpaid approved balance and marks paid after Stripe succeeds', async () => {
  const fetchImpl = stripeFetch(200, succeededIntent(15000));
  const current = booking();
  const result = await chargeSavedCardAfterService({
    booking: current,
    projection: financialProjection(current),
    env: ENV,
    fetchImpl,
    confirmCharge: true,
    expectedChargeCents: 15000,
  });
  assert.equal(result.charged, true);
  assert.equal(result.stripeCalled, true);
  assert.equal(result.amountCents, 15000);
  assert.equal(fetchImpl.calls.length, 1);
  const params = new URLSearchParams(fetchImpl.calls[0].body);
  assert.equal(params.get('amount'), '15000');
  assert.equal(params.get('off_session'), 'true');
  assert.equal(params.get('confirm'), 'true');
  assert.equal(params.get('metadata[purpose]'), PURPOSE);
  assert.equal(params.get('capture_method'), null);
  assert.equal(params.get('payment_method_types[0]'), null);
  assert.equal(fetchImpl.calls[0].headers['Idempotency-Key'], 'after_service_CD1-CHARGE-1_2_15000');
  assert.equal(result.booking.paymentStatus, 'paid');
  assert.equal(result.booking.jobStatus, 'completed_paid');
  assert.equal(result.booking.balanceDue, 0);
  assert.equal(result.booking.amountPaid, 180);
  const settlements = result.booking.ledger.entries.filter((entry) => entry.kind === 'settlement');
  assert.equal(settlements.length, 2);
});

test('a declined card leaves the appointment completed and the balance pending with a recovery link', async () => {
  const fetchImpl = stripeFetch(402, {
    error: {
      code: 'card_declined',
      message: 'Your card was declined.',
      payment_intent: {
        id: 'pi_after_declined',
        object: 'payment_intent',
        status: 'requires_payment_method',
        amount: 15000,
      },
    },
  });
  const current = booking({ jobStatus: 'completed_pending_payment' });
  const result = await chargeSavedCardAfterService({
    booking: current,
    projection: financialProjection(current),
    env: ENV,
    fetchImpl,
    confirmCharge: true,
    expectedChargeCents: 15000,
  });
  assert.equal(result.charged, false);
  assert.equal(result.paymentPending, true);
  assert.equal(result.stripeStatus, 'declined');
  assert.match(result.recoveryUrl, /my-garage\.html\?bookingId=CD1-CHARGE-1&pay=balance/);
  assert.notEqual(result.booking.paymentStatus, 'paid');
  assert.equal(result.booking.jobStatus, 'completed_pending_payment');
  assert.equal(result.booking.balanceDue, 150);
  assert.equal(result.booking.ledger.entries.length, 1);
});

test('additional authentication does not mark the booking paid', async () => {
  const fetchImpl = stripeFetch(200, {
    id: 'pi_after_auth',
    object: 'payment_intent',
    status: 'requires_action',
    amount: 15000,
  });
  const current = booking({ serviceFamily: 'ceramic_coating', jobStatus: 'completed_pending_payment' });
  const result = await chargeSavedCardAfterService({
    booking: current,
    projection: financialProjection(current),
    env: ENV,
    fetchImpl,
    confirmCharge: true,
    expectedChargeCents: 15000,
  });
  assert.equal(result.charged, false);
  assert.equal(result.stripeStatus, 'requires_action');
  assert.equal(result.booking.paymentStatus === 'paid', false);
  assert.equal(result.booking.jobStatus, 'completed_pending_payment');
  assert.ok(result.recoveryUrl);
});

test('repeating the charge and the webhook does not settle twice', async () => {
  const fetchImpl = stripeFetch(200, succeededIntent(15000));
  const current = booking();
  const first = await chargeSavedCardAfterService({
    booking: current,
    projection: financialProjection(current),
    env: ENV,
    fetchImpl,
    confirmCharge: true,
    expectedChargeCents: 15000,
  });
  const second = await chargeSavedCardAfterService({
    booking: first.booking,
    projection: financialProjection(first.booking),
    env: ENV,
    fetchImpl,
    confirmCharge: true,
  });
  assert.equal(second.stripeCalled, false);
  assert.equal(second.error, 'nothing_to_charge');
  assert.equal(fetchImpl.calls.length, 1);
  const replay = applyAfterServiceStripeEvent(first.booking, {
    id: 'pi_after_ok',
    status: 'succeeded',
    amount: 15000,
    amount_received: 15000,
    metadata: { purpose: PURPOSE, bookingId: 'CD1-CHARGE-1' },
  }, { eventType: 'payment_intent.succeeded', stripeEventId: 'evt_repeat' });
  assert.equal(replay.duplicate, true);
  assert.equal(first.booking.ledger.settledCents, 18000);
  const again = applyAfterServiceStripeEvent(first.booking, {
    id: 'pi_after_ok',
    status: 'succeeded',
    amount: 15000,
    amount_received: 15000,
    metadata: { purpose: PURPOSE, bookingId: 'CD1-CHARGE-1' },
  }, { eventType: 'payment_intent.succeeded', stripeEventId: 'evt_repeat' });
  assert.equal(again.duplicate, true);
  assert.equal(first.booking.ledger.entries.filter((entry) => entry.providerEventId === 'pi_after_ok').length, 1);
});

test('cash and card at service never call Stripe', async () => {
  for (const preference of ['cash_onsite', 'card_onsite']) {
    const fetchImpl = stripeFetch(200, succeededIntent(18000));
    const current = booking({
      paymentMethodPreference: preference,
      paymentMethod: preference,
      cardOnFileStatus: 'not_collected',
      acceptedCardOnFilePolicy: false,
      stripeCustomerId: '',
      stripePaymentMethodId: '',
      amountPaid: 0,
      balanceDue: 180,
      ledger: { currency: 'usd', approvedCents: 18000, settledCents: 0, creditedCents: 0, entries: [] },
    });
    const result = await chargeSavedCardAfterService({
      booking: current,
      projection: financialProjection(current),
      env: ENV,
      fetchImpl,
      confirmCharge: true,
    });
    assert.equal(result.error, 'onsite_payment_not_charged_online');
    assert.equal(result.stripeCalled, false);
    assert.equal(fetchImpl.calls.length, 0);
  }
});

test('an unapproved add-on blocks the charge', async () => {
  const fetchImpl = stripeFetch(200, succeededIntent(15000));
  const current = booking({
    adjustmentStatus: 'pending_admin',
    changeRequests: [{ id: 'cr_add', type: 'addon_request', status: 'pending_approval' }],
  });
  const result = await chargeSavedCardAfterService({
    booking: current,
    projection: financialProjection(current),
    env: ENV,
    fetchImpl,
    confirmCharge: true,
  });
  assert.equal(result.error, 'addon_approval_required');
  assert.equal(fetchImpl.calls.length, 0);
});

test('admin completion charges a saved card, and a service line does not', async () => {
  const previousPostgres = process.env.CD1_POSTGRES_PAYMENT;
  process.env.CD1_POSTGRES_PAYMENT = '0';
  const fetchImpl = stripeFetch(200, succeededIntent(15000));
  const seed = booking();
  const store = createCasMemoryStore({ [seed.id]: seed });
  setBookingStoreOverride(store);
  const { handleAdminAction } = require('../netlify/functions/admin-ops-jobs');
  try {
    const quiet = await handleAdminAction({
      action: 'approve_completion',
      bookingId: seed.id,
    }, { env: ENV, fetch: fetchImpl });
    const quietBody = JSON.parse(quiet.body);
    assert.equal(quiet.statusCode, 200, quiet.body);
    assert.equal(quietBody.charge, null);
    assert.equal(fetchImpl.calls.length, 0);
    assert.notEqual(quietBody.paymentStatus, 'paid');

    store._data.clear();
    const fresh = booking();
    const etag = 'etag-fresh';
    store._data.set(fresh.id, { value: JSON.stringify(fresh), etag });
    const charged = await handleAdminAction({
      action: 'approve_completion',
      bookingId: fresh.id,
      confirmSavedCardCharge: true,
      expectedChargeCents: 15000,
    }, { env: ENV, fetch: fetchImpl });
    const chargedBody = JSON.parse(charged.body);
    assert.equal(charged.statusCode, 200, charged.body);
    assert.equal(chargedBody.charge.charged, true);
    assert.equal(chargedBody.charge.amountCents, 15000);
    assert.equal(chargedBody.jobStatus, 'completed_paid');
    assert.equal(fetchImpl.calls.length, 1);

    const again = await handleAdminAction({
      action: 'approve_completion',
      bookingId: fresh.id,
      confirmSavedCardCharge: true,
    }, { env: ENV, fetch: fetchImpl });
    const againBody = JSON.parse(again.body);
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(againBody.charge, null);
    assert.equal(fetchImpl.calls.length, 1);

    const line = booking({
      id: 'CD1-LINE-1',
      serviceFamily: 'ceramic_coating',
      ceramic: { serviceLineItems: [{ serviceId: 'interior', completionStatus: 'pending' }] },
      vehicles: [{ serviceLineItems: [{ serviceId: 'interior', completionStatus: 'pending' }] }],
    });
    store._data.set(line.id, { value: JSON.stringify(line), etag: 'etag-line' });
    const lineRes = await handleAdminAction({
      action: 'complete_service_line',
      bookingId: line.id,
      serviceId: 'interior',
    }, { env: ENV, fetch: fetchImpl });
    const lineBody = JSON.parse(lineRes.body);
    assert.equal(lineRes.statusCode, 200, lineRes.body);
    assert.equal(lineBody.paymentStatus, 'partially_paid');
    assert.equal(fetchImpl.calls.length, 1);
    const savedLine = JSON.parse(store._data.get(line.id).value);
    assert.equal(savedLine.paymentIntentId || null, null);
    assert.equal(savedLine.balanceDue, 150);
  } finally {
    setBookingStoreOverride(null);
    if (previousPostgres == null) delete process.env.CD1_POSTGRES_PAYMENT;
    else process.env.CD1_POSTGRES_PAYMENT = previousPostgres;
  }
});

test('admin cash completion and a declined retry do not create a second charge', async () => {
  const previousPostgres = process.env.CD1_POSTGRES_PAYMENT;
  process.env.CD1_POSTGRES_PAYMENT = '0';
  const fetchImpl = stripeFetch(402, {
    error: {
      code: 'card_declined',
      payment_intent: {
        id: 'pi_after_declined',
        object: 'payment_intent',
        status: 'requires_payment_method',
        amount: 15000,
      },
    },
  });
  const cash = booking({
    id: 'CD1-CASH-1',
    paymentMethodPreference: 'cash_onsite',
    paymentMethod: 'cash_onsite',
    cardOnFileStatus: 'not_collected',
    acceptedCardOnFilePolicy: false,
    stripeCustomerId: '',
    stripePaymentMethodId: '',
  });
  const online = booking({ id: 'CD1-DECLINE-1' });
  const store = createCasMemoryStore({ [cash.id]: cash, [online.id]: online });
  setBookingStoreOverride(store);
  const { handleAdminAction } = require('../netlify/functions/admin-ops-jobs');
  try {
    const cashRes = await handleAdminAction({
      action: 'approve_completion',
      bookingId: cash.id,
      confirmSavedCardCharge: true,
    }, { env: ENV, fetch: fetchImpl });
    const cashBody = JSON.parse(cashRes.body);
    assert.equal(cashRes.statusCode, 409);
    assert.equal(cashBody.error, 'onsite_payment_not_charged_online');
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(JSON.parse(store._data.get(cash.id).value).jobStatus, 'completed_pending_admin_review');

    const declined = await handleAdminAction({
      action: 'approve_completion',
      bookingId: online.id,
      confirmSavedCardCharge: true,
      expectedChargeCents: 15000,
    }, { env: ENV, fetch: fetchImpl });
    const declinedBody = JSON.parse(declined.body);
    assert.equal(declined.statusCode, 200, declined.body);
    assert.equal(declinedBody.jobStatus, 'completed_pending_payment');
    assert.equal(declinedBody.charge.charged, false);
    assert.equal(declinedBody.charge.paymentPending, true);
    assert.match(declinedBody.charge.recoveryUrl, /pay=balance/);
    assert.notEqual(declinedBody.paymentStatus, 'paid');

    const retry = await handleAdminAction({
      action: 'approve_completion',
      bookingId: online.id,
      confirmSavedCardCharge: true,
      expectedChargeCents: 15000,
    }, { env: ENV, fetch: fetchImpl });
    const retryBody = JSON.parse(retry.body);
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retryBody.charge.duplicate, true);
    assert.equal(retryBody.charge.charged, false);
    assert.equal(fetchImpl.calls.length, 1);
    const saved = JSON.parse(store._data.get(online.id).value);
    assert.equal(saved.ledger.settledCents, 3000);
    assert.equal(saved.paymentStatus === 'paid', false);
  } finally {
    setBookingStoreOverride(null);
    if (previousPostgres == null) delete process.env.CD1_POSTGRES_PAYMENT;
    else process.env.CD1_POSTGRES_PAYMENT = previousPostgres;
  }
});

test('the admin label says it will charge, and a service line cannot', () => {
  const admin = fs.readFileSync(path.join(__dirname, '..', 'admin-ops.html'), 'utf8');
  const jobs = fs.readFileSync(path.join(__dirname, '..', 'netlify/functions/admin-ops-jobs.js'), 'utf8');
  const portal = fs.readFileSync(path.join(__dirname, '..', 'netlify/functions/customer-portal-action.js'), 'utf8');
  assert.match(admin, /Complete and charge saved card/);
  assert.match(admin, /charges the saved card/);
  assert.match(admin, /expectedChargeCents/);
  assert.match(jobs, /confirmSavedCardCharge/);
  assert.match(jobs, /expectedChargeCents/);
  const runtime = fs.readFileSync(path.join(__dirname, '..', 'assets/booking-review-runtime.js'), 'utf8');
  assert.match(runtime, /acceptedAfterServiceChargeConsent/);
  const line = jobs.slice(jobs.indexOf("action === 'complete_service_line'"), jobs.indexOf("action === 'assign_internal_coating'"));
  assert.doesNotMatch(line, /chargeSavedCardAfterService|confirmSavedCardCharge/);
  assert.doesNotMatch(portal, /chargeSavedCardAfterService|confirmSavedCardCharge/);
});

test('a cancellation-only card is not charged and keeps a payment link', async () => {
  const previousPostgres = process.env.CD1_POSTGRES_PAYMENT;
  process.env.CD1_POSTGRES_PAYMENT = '0';
  const fetchImpl = stripeFetch(200, succeededIntent(15000));
  const oldCard = booking({
    id: 'CD1-OLD-CARD',
    policyVersion: '2026-06-card-on-file',
    afterServiceChargeConsentVersion: '2026-06-card-on-file',
    afterServiceChargeConsentAt: '2026-06-01T12:00:00.000Z',
  });
  const termsOnly = booking({
    id: 'CD1-TERMS-ONLY',
    policyVersion: '2026-09-dba-booking-request',
    afterServiceChargeConsentVersion: null,
    afterServiceChargeConsentAt: null,
  });
  const store = createCasMemoryStore({ [oldCard.id]: oldCard, [termsOnly.id]: termsOnly });
  setBookingStoreOverride(store);
  const { handleAdminAction } = require('../netlify/functions/admin-ops-jobs');
  try {
    for (const current of [oldCard, termsOnly]) {
      const result = await handleAdminAction({
        action: 'approve_completion',
        bookingId: current.id,
        confirmSavedCardCharge: true,
        expectedChargeCents: 15000,
      }, { env: ENV, fetch: fetchImpl });
      const body = JSON.parse(result.body);
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(body.jobStatus, 'completed_pending_payment');
      assert.equal(body.charge.charged, false);
      assert.equal(body.charge.error, 'after_service_consent_required');
      assert.match(body.charge.recoveryUrl, /pay=balance/);
      assert.notEqual(body.paymentStatus, 'paid');
      const saved = JSON.parse(store._data.get(current.id).value);
      assert.equal(saved.ledger.settledCents, 3000);
    }
    assert.equal(fetchImpl.calls.length, 0);
    const spoofed = stampAfterServiceChargeConsent({
      paymentMethodPreference: 'online_after_service',
      acceptedCardOnFilePolicy: true,
    }, {
      acceptedAfterServiceChargeConsent: true,
      acceptedCardOnFilePolicy: true,
      afterServiceChargeConsentVersion: 'spoofed-version',
      afterServiceChargeConsentAt: '2020-01-01T00:00:00.000Z',
    }, '2026-09-28T12:00:00.000Z');
    assert.equal(spoofed.afterServiceChargeConsentVersion, AFTER_SERVICE_CHARGE_CONSENT_VERSION);
    assert.equal(spoofed.afterServiceChargeConsentAt, '2026-09-28T12:00:00.000Z');
    const missing = stampAfterServiceChargeConsent({
      paymentMethodPreference: 'online_after_service',
      acceptedCardOnFilePolicy: true,
      policyVersion: '2026-06-card-on-file',
    }, { acceptedCardOnFilePolicy: true, policyVersion: '2026-06-card-on-file' }, '2026-09-28T12:00:00.000Z');
    assert.equal(missing.afterServiceChargeConsentVersion, null);
  } finally {
    setBookingStoreOverride(null);
    if (previousPostgres == null) delete process.env.CD1_POSTGRES_PAYMENT;
    else process.env.CD1_POSTGRES_PAYMENT = previousPostgres;
  }
});

test('two simultaneous completions create at most one charge', async () => {
  const previousPostgres = process.env.CD1_POSTGRES_PAYMENT;
  process.env.CD1_POSTGRES_PAYMENT = '0';
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, headers: opts.headers });
    if (calls.length === 1) await hold;
    return { status: 200, json: async () => succeededIntent(15000) };
  };
  fetchImpl.calls = calls;
  const seed = booking({ id: 'CD1-RACE-1' });
  const store = createCasMemoryStore({ [seed.id]: seed });
  setBookingStoreOverride(store);
  const { handleAdminAction } = require('../netlify/functions/admin-ops-jobs');
  try {
    const pending = Promise.all([
      handleAdminAction({
        action: 'approve_completion',
        bookingId: seed.id,
        confirmSavedCardCharge: true,
        expectedChargeCents: 15000,
      }, { env: ENV, fetch: fetchImpl }),
      handleAdminAction({
        action: 'approve_completion',
        bookingId: seed.id,
        confirmSavedCardCharge: true,
        expectedChargeCents: 15000,
      }, { env: ENV, fetch: fetchImpl }),
    ]);
    setTimeout(release, 40);
    const results = await pending;
    const bodies = results.map((res) => JSON.parse(res.body));
    const saved = JSON.parse(store._data.get(seed.id).value);
    const settlements = saved.ledger.entries.filter((entry) => entry.providerEventId === 'pi_after_ok');
    const keys = calls.map((call) => call.headers['Idempotency-Key']);
    assert.ok(calls.length >= 1);
    assert.equal(new Set(keys).size, 1);
    assert.equal(settlements.length, 1);
    assert.equal(saved.ledger.settledCents, 18000);
    assert.equal(bodies.filter((body) => body.ok && body.charge && body.charge.charged).length, 1);
  } finally {
    setBookingStoreOverride(null);
    if (previousPostgres == null) delete process.env.CD1_POSTGRES_PAYMENT;
    else process.env.CD1_POSTGRES_PAYMENT = previousPostgres;
  }
});

test('a lost Stripe response retries the same operation', async () => {
  const byKey = new Map();
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const key = opts.headers['Idempotency-Key'];
    calls.push(key);
    if (!byKey.has(key)) byKey.set(key, succeededIntent(15000));
    return { status: 200, json: async () => byKey.get(key) };
  };
  const current = booking({ id: 'CD1-LOST-1' });
  const store = { booking: current };
  let dropResult = true;
  const persistBooking = async (next) => {
    if (next.afterServiceCharge && next.afterServiceCharge.status === 'charging') {
      store.booking = next;
      return { ok: true, booking: next };
    }
    if (dropResult) return { ok: false, error: 'lost_response' };
    store.booking = next;
    return { ok: true, booking: next };
  };
  const first = await chargeSavedCardAfterService({
    booking: store.booking,
    projection: financialProjection(store.booking),
    env: ENV,
    fetchImpl,
    confirmCharge: true,
    expectedChargeCents: 15000,
    persistBooking,
  });
  assert.equal(first.stripeCalled, true);
  assert.equal(first.persisted, false);
  assert.equal(store.booking.afterServiceCharge.status, 'charging');
  assert.equal(store.booking.ledger.settledCents, 3000);
  dropResult = false;
  const second = await chargeSavedCardAfterService({
    booking: store.booking,
    projection: financialProjection(store.booking),
    env: ENV,
    fetchImpl,
    confirmCharge: true,
    expectedChargeCents: 15000,
    persistBooking,
  });
  assert.equal(second.charged, true);
  assert.equal(second.paymentIntentId, 'pi_after_ok');
  assert.equal(calls.length, 2);
  assert.equal(calls[0], calls[1]);
  assert.equal(second.booking.ledger.entries.filter((entry) => entry.providerEventId === 'pi_after_ok').length, 1);
  assert.equal(second.booking.ledger.settledCents, 18000);
});

test('the recovery link and the admin charge cannot collect the same balance twice', async () => {
  const fetchImpl = stripeFetch(200, succeededIntent(15000));
  const openRecovery = booking({
    paymentAttempts: [{
      attemptId: 'pa_open',
      type: 'customer_balance',
      status: 'open',
      amountCents: 15000,
      providerObjectId: 'pi_customer_open',
    }],
  });
  const admin = await chargeSavedCardAfterService({
    booking: openRecovery,
    projection: financialProjection(openRecovery),
    env: ENV,
    fetchImpl,
    confirmCharge: true,
    expectedChargeCents: 15000,
  });
  assert.equal(admin.error, 'balance_charge_already_open');
  assert.equal(admin.stripeCalled, false);
  assert.equal(fetchImpl.calls.length, 0);

  const charging = booking({
    afterServiceCharge: {
      purpose: PURPOSE,
      status: 'charging',
      idempotencyKey: 'after_service_CD1-CHARGE-1_2_15000',
      amountCents: 15000,
    },
  });
  const blocked = customerRecoveryBlocked(charging);
  assert.equal(blocked.error, 'after_service_charge_in_progress');
  const { prepareEmbeddedPayment } = require('../netlify/lib/db/operational-payment');
  const prepared = await prepareEmbeddedPayment({
    booking: charging,
    env: ENV,
    fetchImpl,
  });
  assert.equal(prepared.error, 'after_service_charge_in_progress');
  assert.equal(fetchImpl.calls.length, 0);

  const declined = booking({
    afterServiceCharge: {
      purpose: PURPOSE,
      status: 'declined',
      paymentIntentId: 'pi_after_declined',
      idempotencyKey: 'after_service_CD1-CHARGE-1_2_15000',
      amountCents: 15000,
      recoveryUrl: 'https://cardetail1.com/my-garage.html?bookingId=CD1-CHARGE-1&pay=balance',
    },
  });
  assert.equal(customerRecoveryBlocked(declined), null);
  const adminRetry = await chargeSavedCardAfterService({
    booking: declined,
    projection: financialProjection(declined),
    env: ENV,
    fetchImpl,
    confirmCharge: true,
    expectedChargeCents: 15000,
  });
  assert.equal(adminRetry.duplicate, true);
  assert.equal(adminRetry.stripeCalled, false);
  assert.equal(fetchImpl.calls.length, 0);
});

test('the confirmed amount is rechecked when the balance or an add-on changes', async () => {
  const previousPostgres = process.env.CD1_POSTGRES_PAYMENT;
  process.env.CD1_POSTGRES_PAYMENT = '0';
  const fetchImpl = stripeFetch(200, succeededIntent(17000));
  const raised = booking({
    id: 'CD1-RAISED-1',
    approvedFinalAmount: 200,
    totalPrice: 200,
    balanceDue: 170,
    ledger: {
      currency: 'usd',
      approvedCents: 20000,
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
  });
  const pendingAddon = booking({
    id: 'CD1-ADDON-1',
    adjustmentStatus: 'pending_admin',
    changeRequests: [{ id: 'cr_add', type: 'addon_request', status: 'pending_approval' }],
  });
  const store = createCasMemoryStore({ [raised.id]: raised, [pendingAddon.id]: pendingAddon });
  setBookingStoreOverride(store);
  const { handleAdminAction } = require('../netlify/functions/admin-ops-jobs');
  try {
    const amount = await handleAdminAction({
      action: 'approve_completion',
      bookingId: raised.id,
      confirmSavedCardCharge: true,
      expectedChargeCents: 15000,
    }, { env: ENV, fetch: fetchImpl });
    const amountBody = JSON.parse(amount.body);
    assert.equal(amount.statusCode, 409);
    assert.equal(amountBody.error, 'charge_amount_changed');
    assert.equal(JSON.parse(store._data.get(raised.id).value).jobStatus, 'completed_pending_admin_review');

    const addon = await handleAdminAction({
      action: 'approve_completion',
      bookingId: pendingAddon.id,
      confirmSavedCardCharge: true,
      expectedChargeCents: 15000,
    }, { env: ENV, fetch: fetchImpl });
    const addonBody = JSON.parse(addon.body);
    assert.equal(addon.statusCode, 409);
    assert.equal(addonBody.error, 'addon_approval_required');
    assert.equal(JSON.parse(store._data.get(pendingAddon.id).value).jobStatus, 'completed_pending_admin_review');
    assert.equal(fetchImpl.calls.length, 0);
  } finally {
    setBookingStoreOverride(null);
    if (previousPostgres == null) delete process.env.CD1_POSTGRES_PAYMENT;
    else process.env.CD1_POSTGRES_PAYMENT = previousPostgres;
  }
});
