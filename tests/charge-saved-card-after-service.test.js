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
  PURPOSE,
} = require('../netlify/lib/charge-saved-card-after-service');

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
  assert.match(jobs, /confirmSavedCardCharge/);
  const line = jobs.slice(jobs.indexOf("action === 'complete_service_line'"), jobs.indexOf("action === 'assign_internal_coating'"));
  assert.doesNotMatch(line, /chargeSavedCardAfterService|confirmSavedCardCharge/);
  assert.doesNotMatch(portal, /chargeSavedCardAfterService|confirmSavedCardCharge/);
});
