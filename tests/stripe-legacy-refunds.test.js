'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  legacyStripeRefundsEnabled,
  stripeRefundAttemptEligible,
} = require('../netlify/lib/stripe-legacy-refunds');
const { createRefund } = require('../netlify/lib/db/payment-authority-service');
const { createCasMemoryStore } = require('./helpers/cas-memory-store');
const { setBookingStoreOverride } = require('../netlify/lib/booking-repository');
const {
  setBakedCustomerPaymentsSnapshot,
  clearBakedCustomerPaymentsSnapshot,
  productionCustomerPaymentsBlocked,
  customerPaymentsPolicy,
} = require('../netlify/lib/stripe-customer-payments');
const {
  chargeSavedCardAfterService,
  AFTER_SERVICE_CHARGE_CONSENT_VERSION,
} = require('../netlify/lib/charge-saved-card-after-service');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function functionSlice(source, name) {
  const start = source.indexOf(`async function ${name}`);
  assert.ok(start >= 0, name);
  const next = source.indexOf('\nasync function ', start + name.length);
  return source.slice(start, next === -1 ? source.length : next);
}

function refusingFetch() {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    throw new Error('stripe must not be called');
  };
  return { calls, fetchImpl };
}

const CLOSED_PRODUCTION_BAKE = Object.freeze({
  CONTEXT: 'production',
  BRANCH: 'master',
  URL: 'https://cardetail1.com',
  DEPLOY_URL: 'https://cardetail1.com',
  DEPLOY_PRIME_URL: 'https://cardetail1.com',
  DEPLOY_ID: 'legacy-refund-test',
  REVIEW_ID: '',
  SITE_NAME: 'cardetail1',
  STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED: false,
});

test('legacy refunds stay closed unless the env string is exactly true', () => {
  assert.equal(legacyStripeRefundsEnabled({}), false);
  assert.equal(legacyStripeRefundsEnabled({ STRIPE_LEGACY_REFUNDS_ENABLED: '' }), false);
  assert.equal(legacyStripeRefundsEnabled({ STRIPE_LEGACY_REFUNDS_ENABLED: 'false' }), false);
  assert.equal(legacyStripeRefundsEnabled({ STRIPE_LEGACY_REFUNDS_ENABLED: 'TRUE' }), false);
  assert.equal(legacyStripeRefundsEnabled({ STRIPE_LEGACY_REFUNDS_ENABLED: '1' }), false);
  assert.equal(legacyStripeRefundsEnabled({ STRIPE_LEGACY_REFUNDS_ENABLED: ' true' }), false);
  assert.equal(legacyStripeRefundsEnabled({ STRIPE_LEGACY_REFUNDS_ENABLED: true }), false);
  assert.equal(legacyStripeRefundsEnabled({ STRIPE_LEGACY_REFUNDS_ENABLED: 'true' }), true);
});

test('a closed flag refuses createRefund before Stripe and before a reservation', async () => {
  const { calls, fetchImpl } = refusingFetch();
  const result = await createRefund({
    bookingId: 'CD1-LEGACY-REFUND-OFF',
    amountCents: 1500,
    reason: 'historical goodwill',
    requestKey: 'requestkey1',
    expectedQuoteVersion: 1,
    env: { STRIPE_SECRET_KEY: 'sk_test_legacy_refund_unused' },
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'legacy_stripe_refunds_disabled');
  assert.equal(result.statusCode, 403);
  assert.equal(result.stripeCalled, false);
  assert.equal(result.refunded, false);
  assert.deepEqual(calls, []);
});

test('an enabled flag still validates the request before any Stripe call', async () => {
  const { calls, fetchImpl } = refusingFetch();
  const result = await createRefund({
    bookingId: 'CD1-LEGACY-REFUND-ON',
    amountCents: 0,
    reason: 'historical goodwill',
    requestKey: 'requestkey1',
    expectedQuoteVersion: 1,
    env: {
      STRIPE_LEGACY_REFUNDS_ENABLED: 'true',
      STRIPE_SECRET_KEY: 'sk_test_legacy_refund_unused',
    },
    fetchImpl,
  });
  assert.equal(result.error, 'invalid_refund_amount');
  assert.equal(result.stripeCalled, undefined);
  assert.deepEqual(calls, []);
});

test('Square and non-PaymentIntent attempts are not eligible for a Stripe refund', () => {
  assert.equal(stripeRefundAttemptEligible({ provider: 'square', providerObjectId: 'pi_square_shaped' }), false);
  assert.equal(stripeRefundAttemptEligible({ provider: 'square', providerObjectId: 'sq_payment' }), false);
  assert.equal(stripeRefundAttemptEligible({ provider: 'stripe', providerObjectId: 'cs_checkout' }), false);
  assert.equal(stripeRefundAttemptEligible({ provider: 'stripe', providerObjectId: 'pi_historical' }), true);
  assert.equal(stripeRefundAttemptEligible({ providerObjectId: 'pi_default_provider' }), true);
  assert.equal(stripeRefundAttemptEligible(null), false);
});

test('the refund source checks the flag before any reservation or POST /v1/refunds', () => {
  const body = functionSlice(read('netlify/lib/db/payment-authority-service.js'), 'createRefund');
  const flag = body.indexOf('legacyStripeRefundsEnabled');
  const reserve = body.indexOf('refundRequest.create');
  const guard = body.indexOf('guardStripeOrReject');
  const post = body.indexOf('https://api.stripe.com/v1/refunds');
  assert.ok(flag >= 0 && flag < reserve, 'flag check precedes RefundRequest insert');
  assert.ok(reserve < guard && guard < post, 'stripe mode guard still precedes the refund POST');
  assert.match(body, /stripeRefundAttemptEligible/);
  assert.doesNotMatch(body, /productionCustomerPaymentsBlocked/);
  assert.match(body, /Idempotency-Key/);

  const webhook = functionSlice(read('netlify/lib/db/payment-authority-service.js'), 'reconcileRefundEvent');
  assert.doesNotMatch(webhook, /legacyStripeRefundsEnabled|STRIPE_LEGACY_REFUNDS_ENABLED/);
  assert.doesNotMatch(read('netlify/functions/stripe-webhook.js'), /STRIPE_LEGACY_REFUNDS_ENABLED/);

  const admin = read('netlify/functions/admin-ops-jobs.js');
  const actionAt = admin.indexOf("if (action === 'record_refund_request')");
  const action = admin.slice(actionAt, actionAt + 2200);
  const actionFlag = action.indexOf('legacyStripeRefundsEnabled');
  const ensure = action.indexOf('ensureBookingFinancial');
  assert.ok(actionFlag >= 0 && actionFlag < ensure, 'admin refund stops before financial ensure');
  assert.match(action, /verifyAdminKey|requestedBy: 'admin'/);
  assert.doesNotMatch(read('netlify/lib/stripe-customer-payments.js'), /STRIPE_LEGACY_REFUNDS_ENABLED/);
  assert.doesNotMatch(read('netlify/lib/deploy-runtime-env.generated.js'), /STRIPE_LEGACY_REFUNDS_ENABLED/);
  assert.match(
    read('prisma/migrations/20260718181514_phase2_transactional_foundation/migration.sql'),
    /ledger_entry_no_update/
  );
});

test('admin record_refund_request returns a controlled error and does not call Stripe', async () => {
  const previousPostgres = process.env.CD1_POSTGRES_PAYMENT;
  process.env.CD1_POSTGRES_PAYMENT = '0';
  const bookingId = 'CD1-LEGACY-REFUND-OFF';
  const booking = {
    id: bookingId,
    bookingVersion: 4,
    quoteVersion: 2,
    schemaVersion: 1,
    finalizedAt: '2026-09-20T15:00:00.000Z',
    firstName: 'Pat',
    lastName: 'Customer',
    email: 'pat-refund@example.com',
    phone: '2015550144',
    jobStatus: 'completed_paid',
    paymentStatus: 'paid',
    approvedFinalAmount: 180,
    totalPrice: 180,
  };
  const store = createCasMemoryStore({ [bookingId]: booking });
  setBookingStoreOverride(store);
  const { calls, fetchImpl } = refusingFetch();
  const { handleAdminAction } = require('../netlify/functions/admin-ops-jobs');
  try {
    const res = await handleAdminAction({
      action: 'record_refund_request',
      bookingId,
      reason: 'historical goodwill',
      amount: 15,
      requestKey: 'requestkey1',
      expectedBookingVersion: 4,
      expectedQuoteVersion: 2,
    }, {
      env: { STRIPE_LEGACY_REFUNDS_ENABLED: 'false' },
      fetch: fetchImpl,
    });
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 403);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'legacy_stripe_refunds_disabled');
    assert.equal(body.stripeCalled, false);
    assert.equal(body.refunded, false);
    assert.equal(body.refundStatus, undefined);
    assert.deepEqual(calls, []);
    const saved = JSON.parse(store._data.get(bookingId).value);
    assert.equal(saved.paymentStatus, 'paid');
    assert.equal(saved.bookingVersion, 4);
  } finally {
    setBookingStoreOverride(null);
    if (previousPostgres == null) delete process.env.CD1_POSTGRES_PAYMENT;
    else process.env.CD1_POSTGRES_PAYMENT = previousPostgres;
  }
});

test('an unauthenticated admin refund request is refused before a refund status', async () => {
  const { handler } = require('../netlify/functions/admin-ops-jobs');
  const res = await handler({
    httpMethod: 'POST',
    headers: {},
    body: JSON.stringify({
      action: 'record_refund_request',
      bookingId: 'CD1-LEGACY-REFUND-OFF',
      reason: 'historical goodwill',
      amount: 15,
      requestKey: 'requestkey1',
      expectedBookingVersion: 1,
    }),
  });
  const body = JSON.parse(res.body);
  assert.notEqual(res.statusCode, 202);
  assert.ok(res.statusCode === 401 || res.statusCode === 503);
  assert.equal(body.ok, false);
  assert.equal(body.refundStatus, undefined);
});

test('enabling legacy refunds does not reopen customer Stripe payments', async () => {
  setBakedCustomerPaymentsSnapshot(CLOSED_PRODUCTION_BAKE);
  const env = {
    CONTEXT: 'production',
    SITE_URL: 'https://cardetail1.com',
    STRIPE_SECRET_KEY: 'sk_test_legacy_refund_unused',
    STRIPE_LEGACY_REFUNDS_ENABLED: 'true',
  };
  const { calls, fetchImpl } = refusingFetch();
  try {
    assert.equal(customerPaymentsPolicy(env).enabled, false);
    assert.equal(customerPaymentsPolicy(env).error, 'customer_payments_unavailable');
    assert.equal(productionCustomerPaymentsBlocked(env), true);
    const charge = await chargeSavedCardAfterService({
      booking: {
        id: 'CD1-LEGACY-REFUND-CHARGE',
        bookingVersion: 4,
        quoteVersion: 2,
        paymentMethodPreference: 'online_after_service',
        cardOnFileStatus: 'saved',
        stripeCustomerId: 'cus_test_saved',
        stripePaymentMethodId: 'pm_test_saved',
        acceptedCardOnFilePolicy: true,
        afterServiceChargeConsentVersion: AFTER_SERVICE_CHARGE_CONSENT_VERSION,
        afterServiceChargeConsentAt: '2026-09-27T15:00:00.000Z',
        ledger: {
          currency: 'usd',
          approvedCents: 18000,
          settledCents: 3000,
          creditedCents: 0,
          entries: [],
        },
      },
      projection: { remainingCents: 15000, paymentStatus: 'partially_paid' },
      env,
      fetchImpl,
      confirmCharge: true,
      expectedChargeCents: 15000,
    });
    assert.equal(charge.error, 'customer_payments_unavailable');
    assert.equal(charge.stripeCalled, false);
    assert.equal(charge.charged, false);
    assert.deepEqual(calls, []);

    const intent = await require('../netlify/functions/create-payment-intent').handler({
      httpMethod: 'POST',
      body: '{}',
    });
    const capture = await require('../netlify/functions/capture-payment').handler({
      httpMethod: 'POST',
      body: '{}',
    });
    const portal = await require('../netlify/functions/customer-portal-pay').handler({
      httpMethod: 'POST',
      body: '{}',
    });
    const square = await require('../netlify/functions/create-payment').handler({
      httpMethod: 'POST',
      body: '{}',
    });
    assert.equal(intent.statusCode, 410);
    assert.equal(capture.statusCode, 410);
    assert.equal(portal.statusCode, 410);
    assert.equal(square.statusCode, 403);
    for (const res of [intent, capture, portal, square]) {
      assert.equal(JSON.parse(res.body).ok, false);
    }
  } finally {
    clearBakedCustomerPaymentsSnapshot();
  }
});
