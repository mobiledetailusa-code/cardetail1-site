'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ACTIVE_PAYMENT_PROVIDER,
  DISABLED_ERROR,
  OFFLINE_ERROR,
  MONEY_MOVING_OPERATIONS,
  OPERATIONS,
  DisabledPaymentProvider,
  getActivePaymentProvider,
  activePaymentProviderId,
  describeProviderRoles,
  classifySettlementMethod,
} = require('../netlify/lib/payment-provider-adapter');
const {
  legacyStripeRefundsEnabled,
} = require('../netlify/lib/stripe-legacy-refunds');
const { createRefund, isOnSiteSettlementEntry } = require('../netlify/lib/db/payment-authority-service');
const {
  setBakedCustomerPaymentsSnapshot,
  clearBakedCustomerPaymentsSnapshot,
  customerPaymentsPolicy,
} = require('../netlify/lib/stripe-customer-payments');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const CLOSED_PRODUCTION_BAKE = Object.freeze({
  CONTEXT: 'production',
  BRANCH: 'master',
  URL: 'https://cardetail1.com',
  DEPLOY_URL: 'https://cardetail1.com',
  DEPLOY_PRIME_URL: 'https://cardetail1.com',
  DEPLOY_ID: 'provider-adapter-test',
  REVIEW_ID: '',
  SITE_NAME: 'cardetail1',
  STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED: false,
});

function refusingFetch() {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    throw new Error('external call is forbidden');
  };
  return {
    calls,
    restore() {
      globalThis.fetch = previous;
    },
  };
}

function ledgerProxy() {
  const touches = [];
  const trap = {
    get(_target, prop) {
      touches.push(String(prop));
      throw new Error(`ledger touched: ${String(prop)}`);
    },
  };
  return { touches, db: new Proxy({}, trap) };
}

test('the active provider is none and cannot be selected by the environment', () => {
  const previous = {
    PAYMENT_PROVIDER: process.env.PAYMENT_PROVIDER,
    SQUARE_ACCESS_TOKEN: process.env.SQUARE_ACCESS_TOKEN,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED: process.env.STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED,
    STRIPE_LEGACY_REFUNDS_ENABLED: process.env.STRIPE_LEGACY_REFUNDS_ENABLED,
  };
  process.env.PAYMENT_PROVIDER = 'square';
  process.env.SQUARE_ACCESS_TOKEN = 'sandbox-not-a-live-credential';
  process.env.STRIPE_SECRET_KEY = 'sk_test_adapter_unused';
  process.env.STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED = 'true';
  process.env.STRIPE_LEGACY_REFUNDS_ENABLED = 'true';
  try {
    assert.equal(activePaymentProviderId(), 'none');
    assert.equal(ACTIVE_PAYMENT_PROVIDER, 'none');
    const provider = getActivePaymentProvider();
    assert.ok(provider instanceof DisabledPaymentProvider);
    assert.equal(provider.id, 'none');
    assert.equal(describeProviderRoles({}).selectedProvider, 'none');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('disabled money operations return payment_provider_disabled and do not call out', async () => {
  const network = refusingFetch();
  const { touches, db } = ledgerProxy();
  const provider = getActivePaymentProvider();
  const historical = Object.freeze({
    provider: 'stripe',
    providerObjectId: 'pi_historical',
    providerObjectType: 'payment_intent',
    stripePaymentIntentId: 'pi_historical',
    stripeCustomerId: 'cus_historical',
    status: 'succeeded',
  });
  try {
    for (const name of OPERATIONS) {
      const result = await provider[name]({
        bookingId: 'CD1-ADAPTER-OFF',
        amountCents: 12500,
        attempt: historical,
        prisma: db,
        db,
      });
      assert.equal(result.ok, false, name);
      assert.equal(result.error, DISABLED_ERROR, name);
      assert.equal(result.statusCode, 403, name);
      assert.equal(result.provider, 'none', name);
      assert.equal(result.providerCalled, false, name);
      assert.equal(result.externalCall, false, name);
      assert.equal(result.paid, false, name);
      assert.equal(result.created, false, name);
    }
    assert.deepEqual(network.calls, []);
    assert.deepEqual(touches, []);
    assert.deepEqual(historical, {
      provider: 'stripe',
      providerObjectId: 'pi_historical',
      providerObjectType: 'payment_intent',
      stripePaymentIntentId: 'pi_historical',
      stripeCustomerId: 'cus_historical',
      status: 'succeeded',
    });
  } finally {
    network.restore();
  }
});

test('each required money-moving operation is present and stays inside the process', async () => {
  const network = refusingFetch();
  const provider = new DisabledPaymentProvider();
  try {
    assert.deepEqual(MONEY_MOVING_OPERATIONS, [
      'createPayment',
      'refundPayment',
      'saveCard',
      'chargeSavedCard',
      'createPaymentLink',
    ]);
    const created = await provider.createPayment({ amountCents: 100 });
    const refunded = await provider.refundPayment({ providerObjectId: 'pi_historical' });
    const saved = await provider.saveCard({ customerId: 'cus_historical' });
    const charged = await provider.chargeSavedCard({ amountCents: 100 });
    const linked = await provider.createPaymentLink({ amountCents: 100 });
    for (const result of [created, refunded, saved, charged, linked]) {
      assert.equal(result.error, DISABLED_ERROR);
      assert.equal(result.externalCall, false);
      assert.equal(result.created, false);
    }
    const lookedUp = await provider.getPayment({ providerObjectId: 'pi_historical' });
    assert.equal(lookedUp.error, DISABLED_ERROR);
    assert.deepEqual(network.calls, []);
  } finally {
    network.restore();
  }
});

test('offline cash and card at service stay outside the adapter and unpaid', async () => {
  const network = refusingFetch();
  const provider = getActivePaymentProvider();
  try {
    assert.deepEqual(classifySettlementMethod('cash'), {
      kind: 'offline_settlement',
      method: 'cash',
      adapter: false,
      paid: false,
    });
    assert.deepEqual(classifySettlementMethod('card_on_site'), {
      kind: 'offline_settlement',
      method: 'card_on_site',
      adapter: false,
      paid: false,
    });
    assert.equal(classifySettlementMethod('cash_onsite').kind, 'offline_preference');
    assert.equal(classifySettlementMethod('card_onsite').kind, 'offline_preference');
    assert.equal(classifySettlementMethod('external_manual').kind, 'manual_handling');
    assert.equal(classifySettlementMethod('online_after_service').paid, false);

    for (const method of ['cash', 'card_on_site', 'cash_onsite', 'card_onsite', 'external_manual']) {
      const result = await provider.createPayment({ method, amountCents: 16000 });
      assert.equal(result.error, OFFLINE_ERROR, method);
      assert.equal(result.paid, false, method);
      assert.equal(result.providerCalled, false, method);
      assert.equal(result.created, false, method);
    }

    const cashEntry = { kind: 'settlement', providerObjectId: 'cash', providerEventId: '' };
    const cardEntry = {
      kind: 'settlement',
      providerObjectId: '',
      providerEventId: 'card_on_site_full_balance:CD1:1:16000:16000',
    };
    assert.equal(isOnSiteSettlementEntry(cashEntry, 'cash'), true);
    assert.equal(isOnSiteSettlementEntry(cardEntry, 'card_on_site'), true);
    assert.deepEqual(network.calls, []);
  } finally {
    network.restore();
  }
});

test('an online preference is not a completed payment and does not create a paid booking', async () => {
  const provider = getActivePaymentProvider();
  const booking = { id: 'CD1-ADAPTER-PREF', status: 'requested', paymentWorkflowStatus: '' };
  const result = await provider.createPayment({
    paymentMethodPreference: 'online_after_service',
    booking,
  });
  assert.equal(result.error, DISABLED_ERROR);
  assert.equal(result.paid, false);
  assert.equal(booking.status, 'requested');
  assert.equal(booking.paymentWorkflowStatus, '');
  assert.equal(classifySettlementMethod('card_on_file').paid, false);
});

test('historical Stripe identity stays distinct from the disabled selection', () => {
  const absent = describeProviderRoles({});
  assert.equal(absent.historicalProvider, 'stripe');
  assert.equal(absent.selectedProvider, 'none');
  assert.equal(absent.effectiveProvider, 'none');

  const historical = describeProviderRoles({
    provider: 'stripe',
    providerObjectId: 'pi_historical',
    selectedProvider: 'square',
  });
  assert.equal(historical.historicalProvider, 'stripe');
  assert.equal(historical.selectedProvider, 'none');
  assert.equal(historical.effectiveProvider, 'stripe');

  const explicit = describeProviderRoles({ historicalProvider: 'stripe' });
  assert.deepEqual(explicit, {
    historicalProvider: 'stripe',
    selectedProvider: 'none',
    effectiveProvider: 'stripe',
  });
});

test('the adapter module has no processor client, fetch, or ledger import', () => {
  const src = read('netlify/lib/payment-provider-adapter.js');
  assert.doesNotMatch(src, /require\(/);
  assert.doesNotMatch(src, /api\.stripe\.com/);
  assert.doesNotMatch(src, /squareup/);
  assert.doesNotMatch(src, /\bfetch\s*\(/);
  assert.doesNotMatch(src, /sk_live_|sq0atp-|sq0idp-/);
  const commercial = [
    'netlify/functions/submit-booking.js',
    'netlify/functions/admin-ops-jobs.js',
    'netlify/functions/stripe-webhook.js',
    'netlify/functions/admin-quick-ops.js',
    'netlify/functions/tech-quick-ops.js',
    'netlify/functions/customer-portal-data.js',
    'netlify/lib/db/payment-authority-service.js',
  ];
  for (const file of commercial) {
    assert.doesNotMatch(read(file), /payment-provider-adapter/, file);
  }
  const pkg = JSON.parse(read('package.json'));
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  assert.equal(names.some((name) => /square|stripe/i.test(name)), false);
});

test('the Stripe customer-payment gate and the legacy refund gate stay closed', async () => {
  setBakedCustomerPaymentsSnapshot(CLOSED_PRODUCTION_BAKE);
  const network = refusingFetch();
  try {
    const policy = customerPaymentsPolicy({
      CONTEXT: 'production',
      STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED: 'false',
    });
    assert.equal(policy.enabled, false);
    assert.equal(legacyStripeRefundsEnabled({}), false);
    const refund = await createRefund({
      bookingId: 'CD1-ADAPTER-REFUND',
      amountCents: 1500,
      reason: 'adapter must not refund',
      requestKey: 'adapterrequest1',
      expectedQuoteVersion: 1,
      env: { STRIPE_SECRET_KEY: 'sk_test_adapter_unused' },
      fetchImpl: globalThis.fetch,
    });
    assert.equal(refund.ok, false);
    assert.equal(refund.error, 'legacy_stripe_refunds_disabled');
    assert.equal(refund.stripeCalled, false);
    assert.equal(refund.refunded, false);
    assert.deepEqual(network.calls, []);
  } finally {
    network.restore();
    clearBakedCustomerPaymentsSnapshot();
  }
});

test('booking still accepts cash and card on site while online card preference stays closed', () => {
  setBakedCustomerPaymentsSnapshot(CLOSED_PRODUCTION_BAKE);
  const previous = process.env.STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED;
  process.env.CONTEXT = 'production';
  process.env.STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED = 'false';
  try {
    const { __test } = require('../netlify/functions/submit-booking');
    assert.equal(__test.rejectClosedOnlinePreference('cash_onsite'), null);
    assert.equal(__test.rejectClosedOnlinePreference('card_onsite'), null);
    const online = __test.rejectClosedOnlinePreference('online_after_service');
    const onlineBody = JSON.parse(online.body);
    assert.equal(online.statusCode, 403);
    assert.equal(onlineBody.error, 'customer_payments_unavailable');
    assert.equal(onlineBody.bookingCreated, false);
  } finally {
    clearBakedCustomerPaymentsSnapshot();
    if (previous == null) delete process.env.STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED;
    else process.env.STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED = previous;
  }
});
