'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const {
  FLAG,
  CUSTOMER_BOOKING_COPY,
  GARAGE_COPY,
  customerPaymentsPolicy,
  productionCustomerPaymentsBlocked,
  annotateAdminPaymentHandling,
} = require('../netlify/lib/stripe-customer-payments');
const { guardStripeOrReject } = require('../netlify/lib/stripe-mode');
const Review = require('../assets/booking-review-runtime.js');

const ORIGINAL_ENV = {
  CONTEXT: process.env.CONTEXT,
  NETLIFY_CONTEXT: process.env.NETLIFY_CONTEXT,
  [FLAG]: process.env[FLAG],
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  DRAFT_TOKEN_SECRET: process.env.DRAFT_TOKEN_SECRET,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

function productionEnv(flag) {
  process.env.CONTEXT = 'production';
  delete process.env.NETLIFY_CONTEXT;
  if (flag == null) delete process.env[FLAG];
  else process.env[FLAG] = flag;
}

test.afterEach(() => {
  restoreEnv();
});

test('production customer payments stay closed when the flag is absent', () => {
  productionEnv(undefined);
  const policy = customerPaymentsPolicy(process.env);
  assert.equal(policy.enabled, false);
  assert.equal(policy.reason, 'flag_absent');
  assert.equal(policy.error, 'customer_payments_unavailable');
  assert.equal(productionCustomerPaymentsBlocked(process.env), true);
});

test('empty and invalid flag values stay closed', () => {
  for (const value of ['', '1', 'yes', 'TRUE', 'false', ' true ', 'on']) {
    productionEnv(value);
    const policy = customerPaymentsPolicy(process.env);
    assert.equal(policy.enabled, false, value);
    assert.equal(policy.reason, value === '' ? 'flag_absent' : 'flag_invalid');
  }
});

test('browser query, body, host, and cookie cannot enable production payments', () => {
  productionEnv(undefined);
  const policy = customerPaymentsPolicy({
    ...process.env,
    CONTEXT: 'production',
    query: { [FLAG]: 'true' },
    body: { customerPaymentsEnabled: true, [FLAG]: 'true' },
    headers: { host: 'cardetail1.com', cookie: `${FLAG}=true` },
    HOST: 'cardetail1.com',
  });
  assert.equal(policy.enabled, false);
  assert.equal(productionCustomerPaymentsBlocked({
    CONTEXT: 'production',
    [FLAG]: 'true',
  }), false);
  productionEnv(undefined);
  assert.equal(customerPaymentsPolicy({
    CONTEXT: 'production',
    HOST: 'localhost',
    cookie: 'customerPaymentsEnabled=true',
  }).enabled, false);
});

test('only the exact production flag re-enables customer payments', () => {
  productionEnv('true');
  assert.equal(customerPaymentsPolicy(process.env).enabled, true);
  assert.equal(productionCustomerPaymentsBlocked(process.env), false);
});

test('preview and branch-deploy stay isolated from live customer payments', () => {
  for (const context of ['deploy-preview', 'branch-deploy']) {
    const env = {
      CONTEXT: context,
      [FLAG]: 'true',
      STRIPE_SECRET_KEY: 'sk_live_should_not_run',
      HOST: 'cardetail1.com',
    };
    const policy = customerPaymentsPolicy(env);
    assert.equal(policy.enabled, false);
    assert.equal(policy.reason, 'preview_isolated');
    assert.equal(productionCustomerPaymentsBlocked(env), false);
    const guard = guardStripeOrReject(env, { purpose: 'setup_intent' });
    assert.equal(guard.blocked, true);
    assert.equal(guard.body.error, 'stripe_test_mode_required');
  }
});

test('new booking offers only card at service and cash while payments are closed', () => {
  Review.setCustomerPaymentsEnabled(false);
  const offered = Review.offeredRequestPreferences();
  assert.deepEqual(Object.keys(offered).sort(), ['card_onsite', 'cash_onsite']);
  assert.equal(offered.online_after_service, undefined);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://cardetail1.com/', runScripts: 'outside-only' });
  const ctx = dom.getInternalVMContext();
  vm.runInContext(fs.readFileSync(path.join(root, 'assets/booking-review-runtime.js'), 'utf8'), ctx);
  const w = dom.window;
  w.ST = { payMethod: '' };
  w.Cardetail1BookingReview.install(w);
  const online = w.document.getElementById('pc-online');
  const note = w.document.getElementById('bk-customer-pay-note');
  assert.equal(online.hidden, true);
  assert.equal(w.document.getElementById('pc-onsite').hidden, false);
  assert.equal(w.document.getElementById('pc-cash').hidden, false);
  assert.equal(note.textContent, CUSTOMER_BOOKING_COPY);
  assert.doesNotMatch(note.textContent, /stripe|blocked|investigation/i);
  w.Cardetail1BookingReview.selectRequestPaymentPreference('online_after_service');
  assert.notEqual(w.ST.payMethod, 'online_after_service');
  assert.equal(w.document.getElementById('bk-online-card-wrap').hidden, true);
  assert.equal(w.document.getElementById('card-container').innerHTML, '');
});

test('an old card_online resume cannot remount the card form', () => {
  Review.setCustomerPaymentsEnabled(false);
  const resumed = Review.normalizeResumedPreference('card_online');
  assert.deepEqual(resumed, { preference: '', mustChoose: true, remountCardForm: false });
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://cardetail1.com/', runScripts: 'outside-only' });
  vm.runInContext(fs.readFileSync(path.join(root, 'assets/booking-review-runtime.js'), 'utf8'), dom.getInternalVMContext());
  const w = dom.window;
  w.ST = { payMethod: 'card_online', cardOnFileSaved: true, cardSetupConfirmed: true };
  w.Cardetail1BookingReview.install(w);
  assert.equal(w.ST.payMethod, '');
  assert.equal(w.ST.cardOnFileSaved, false);
  assert.equal(w.document.getElementById('bk-online-card-wrap').hidden, true);
  assert.equal(w.document.getElementById('cof-policy-ok').checked, false);
});

test('explicit enable is what shows the card again', () => {
  Review.setCustomerPaymentsEnabled(false);
  assert.equal(Review.customerPaymentsEnabled(), false);
  Review.setCustomerPaymentsEnabled('true');
  assert.equal(Review.customerPaymentsEnabled(), false);
  Review.setCustomerPaymentsEnabled(true);
  assert.equal(Review.customerPaymentsEnabled(), true);
  assert.ok(Review.offeredRequestPreferences().online_after_service);
  Review.setCustomerPaymentsEnabled(false);
});

test('My Garage hides the pay CTA without rewriting the balance', async () => {
  productionEnv(undefined);
  process.env.CD1_POSTGRES_PAYMENT = '0';
  const portalPath = require.resolve('../netlify/functions/customer-portal-data');
  delete require.cache[portalPath];
  const portal = require('../netlify/functions/customer-portal-data');
  const due = {
    id: 'CD1-GARAGE-DUE',
    status: 'Confirmed',
    jobStatus: 'confirmed',
    appointmentStatus: 'confirmed',
    paymentStatus: 'due',
    isDraft: false,
    totalPrice: 180,
    approvedFinalAmount: 180,
    amountPaid: 0,
    ledger: { currency: 'usd', approvedCents: 18000, settledCents: 0, creditedCents: 0, entries: [] },
  };
  const before = JSON.stringify(due);
  const pay = await portal.__test.safePaymentStateAsync(due);
  assert.equal(JSON.stringify(due), before);
  assert.equal(pay.state, 'due');
  assert.equal(pay.paymentStatus, 'due');
  assert.equal(pay.remainingCents, 18000);
  assert.equal(pay.canPay, false);
  assert.equal(pay.canCreatePayLink, false);
  assert.equal(pay.canGeneratePayLink, false);
  assert.equal(pay.customerPaymentsUnavailable, true);
  assert.equal(pay.customerPaymentsMessage, GARAGE_COPY);

  const html = fs.readFileSync(path.join(root, 'my-garage.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://cardetail1.com/my-garage.html', runScripts: 'outside-only' });
  vm.runInContext(fs.readFileSync(path.join(root, 'assets/my-garage.js'), 'utf8'), dom.getInternalVMContext());
  const w = dom.window;
  w.cd1MyGarage.state.booking = {
    id: due.id,
    service: 'Interior Detail',
    status: 'Confirmed',
    jobStatus: 'confirmed',
  };
  w.cd1MyGarage.state.bookings = [w.cd1MyGarage.state.booking];
  w.cd1MyGarage.renderDashboard({ payment: pay, bookings: w.cd1MyGarage.state.bookings });
  assert.equal(w.document.getElementById('btn-pay-balance'), null);
  assert.equal(w.document.getElementById('pay-sticky-bar').hidden, true);
  const note = w.document.querySelector('[data-customer-payments-unavailable]');
  assert.ok(note);
  assert.equal(note.textContent, GARAGE_COPY);
  assert.doesNotMatch(note.textContent, /stripe|blocked|investigation/i);
  delete process.env.CD1_POSTGRES_PAYMENT;
});

test('SetupIntent is refused before any Stripe call when production payments are closed', async () => {
  productionEnv(undefined);
  process.env.DRAFT_TOKEN_SECRET = 'test-draft-token-secret-32chars!!';
  process.env.STRIPE_SECRET_KEY = 'sk_live_must_not_be_used';
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    throw new Error('stripe must not be called');
  };
  const setupPath = require.resolve('../netlify/functions/create-setup-intent');
  delete require.cache[setupPath];
  const { handler } = require('../netlify/functions/create-setup-intent');
  try {
    const res = await handler({
      httpMethod: 'POST',
      headers: {
        host: 'cardetail1.com',
        cookie: `${FLAG}=true`,
        'x-forwarded-for': '203.0.113.50',
      },
      queryStringParameters: { [FLAG]: 'true' },
      body: JSON.stringify({
        bookingId: 'CD1-CLOSED',
        draftSaveToken: 'v1.1.x',
        [FLAG]: 'true',
        customerPaymentsEnabled: true,
      }),
    });
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'customer_payments_unavailable');
    assert.equal(calls.length, 0);
  } finally {
    global.fetch = original;
  }
});

test('balance PaymentIntent and payment resume do not call Stripe when closed', async () => {
  productionEnv(undefined);
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    throw new Error('stripe must not be called');
  };
  const balancePath = require.resolve('../netlify/functions/customer-balance-payment-intent');
  const resumePath = require.resolve('../netlify/functions/payment-resume');
  delete require.cache[balancePath];
  delete require.cache[resumePath];
  const balance = require('../netlify/functions/customer-balance-payment-intent');
  const resume = require('../netlify/functions/payment-resume');
  try {
    const balanceRes = await balance.handler({
      httpMethod: 'POST',
      headers: { host: 'evil.example', cookie: 'enable=1' },
      body: JSON.stringify({ bookingId: 'CD1-1', customerPaymentsEnabled: true }),
    });
    const resumeRes = await resume.handler({
      httpMethod: 'POST',
      headers: { host: 'cardetail1.com' },
      body: JSON.stringify({ action: 'intent', token: 'abc', [FLAG]: 'true' }),
    });
    assert.equal(balanceRes.statusCode, 403);
    assert.equal(JSON.parse(balanceRes.body).error, 'customer_payments_unavailable');
    assert.equal(resumeRes.statusCode, 403);
    assert.equal(JSON.parse(resumeRes.body).error, 'customer_payments_unavailable');
    assert.equal(calls.length, 0);
  } finally {
    global.fetch = original;
  }
});

test('saved-card charge is refused before Stripe and does not change the booking', async () => {
  const { chargeSavedCardAfterService } = require('../netlify/lib/charge-saved-card-after-service');
  const booking = {
    id: 'CD1-SAVED',
    paymentMethodPreference: 'online_after_service',
    paymentMethod: 'online_after_service',
    cardOnFileStatus: 'saved',
    stripeCustomerId: 'cus_keep',
    stripePaymentMethodId: 'pm_keep',
    acceptedCardOnFilePolicy: true,
    afterServiceChargeConsentVersion: '2026-09-after-service-charge',
    afterServiceChargeConsentAt: '2026-09-27T15:00:00.000Z',
    paymentStatus: 'due',
    ledger: { approvedCents: 10000, settledCents: 0, creditedCents: 0 },
  };
  const before = JSON.stringify(booking);
  const calls = [];
  const result = await chargeSavedCardAfterService({
    booking,
    projection: { remainingCents: 10000, paymentStatus: 'due' },
    confirmCharge: true,
    expectedChargeCents: 10000,
    env: { CONTEXT: 'production', STRIPE_SECRET_KEY: 'sk_live_nope' },
    fetchImpl: async (url) => {
      calls.push(String(url));
      throw new Error('stripe must not be called');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'customer_payments_unavailable');
  assert.equal(result.stripeCalled, false);
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(booking), before);
  assert.equal(booking.paymentMethodPreference, 'online_after_service');
  const note = annotateAdminPaymentHandling(booking, { CONTEXT: 'production' });
  assert.equal(note.customerPaymentHandling, 'external_manual');
  assert.match(note.customerPaymentHandlingLabel, /not reclassified as cash/i);
  assert.equal(booking.paymentMethodPreference, 'online_after_service');
});

test('cash and card at service are not refused by the customer-payment gate', () => {
  productionEnv(undefined);
  const submit = require('../netlify/functions/submit-booking');
  assert.equal(submit.__test.rejectClosedOnlinePreference('cash_onsite'), null);
  assert.equal(submit.__test.rejectClosedOnlinePreference('card_onsite'), null);
  const closed = submit.__test.rejectClosedOnlinePreference('online_after_service');
  assert.equal(closed.statusCode, 403);
  assert.equal(JSON.parse(closed.body).error, 'customer_payments_unavailable');
  assert.match(JSON.parse(closed.body).userMessage, /Pay by card or cash at your appointment/);
});

test('stripe-config returns no key and no secret while customer payments are closed', async () => {
  productionEnv(undefined);
  process.env.STRIPE_SECRET_KEY = 'sk_live_hidden';
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_live_hidden';
  const configPath = require.resolve('../netlify/functions/stripe-config');
  delete require.cache[configPath];
  const { handler } = require('../netlify/functions/stripe-config');
  const res = await handler();
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.customerPaymentsEnabled, false);
  assert.equal(body.publishableKey, '');
  assert.equal(JSON.stringify(body).includes('sk_'), false);
});

test('the explicit flag lets SetupIntent reach Stripe in the isolated path', async () => {
  productionEnv('true');
  process.env.DRAFT_TOKEN_SECRET = 'test-draft-token-secret-32chars!!';
  process.env.STRIPE_SECRET_KEY = 'sk_test_isolated_customer_pay';
  const { issueDraftSaveToken } = require('../netlify/lib/draft-save-token');
  const issued = issueDraftSaveToken({ bookingId: 'CD1-OPEN', phone: '2015550177', now: Date.now() });
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/v1/customers')) {
      return { ok: true, json: async () => ({ id: 'cus_test' }) };
    }
    if (String(url).includes('/v1/setup_intents')) {
      return {
        ok: true,
        json: async () => ({ id: 'seti_test', customer: 'cus_test', client_secret: 'seti_test_secret' }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const setupPath = require.resolve('../netlify/functions/create-setup-intent');
  delete require.cache[setupPath];
  const { handler, __test } = require('../netlify/functions/create-setup-intent');
  __test.setBlobsStoreOverride(() => ({
    async get() {
      return {
        id: 'CD1-OPEN',
        isDraft: true,
        phone: '2015550177',
        email: 'a@example.com',
        firstName: 'Ada',
        cardOnFileRequired: true,
        cardOnFileStatus: 'pending',
        acceptedCardOnFilePolicy: true,
        bookingVersion: 0,
        zipCode: '07601',
        vehicleCategory: 'cars',
        vehicles: [{ cat: 'cars', vehicleLabel: 'Honda Civic' }],
      };
    },
    async set() {},
  }));
  try {
    const res = await handler({
      httpMethod: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.77' },
      body: JSON.stringify({
        bookingId: 'CD1-OPEN',
        draftSaveToken: issued.token,
        expectedBookingVersion: 0,
      }),
    });
    const body = JSON.parse(res.body);
    assert.equal(
      calls.some((url) => url.includes('api.stripe.com/v1/setup_intents')),
      true,
      `stripe was not called (${body.error || res.statusCode})`,
    );
    assert.notEqual(body.error, 'customer_payments_unavailable');
  } finally {
    __test.setBlobsStoreOverride(null);
    global.fetch = original;
  }
});
