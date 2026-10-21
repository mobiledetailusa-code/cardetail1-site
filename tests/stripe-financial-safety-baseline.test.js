'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const {
  FLAG,
  productionCustomerPaymentsBlocked,
  clearBakedCustomerPaymentsSnapshot,
} = require('../netlify/lib/stripe-customer-payments');
const { guardStripeOrReject } = require('../netlify/lib/stripe-mode');

const WRITE_OPERATIONS = new Set([
  'CREATE PAYMENT',
  'CAPTURE PAYMENT',
  'REFUND',
  'CANCEL',
  'SAVE CARD',
  'SUBSCRIPTION',
  'OTHER FINANCIAL WRITE',
]);

const READ_OPERATIONS = new Set(['READ ONLY', 'NOT A CALL']);

/**
 * Every api.stripe.com line under netlify/ and the CI proof script.
 * `nth` is the 1-based occurrence in that file, top to bottom.
 * A new line fails this list until someone classifies it.
 */
const EXPECTED = [
  {
    file: 'netlify/functions/admin-ops-jobs.js',
    nth: 1,
    operation: 'CREATE PAYMENT',
    policies: ['tombstone_410'],
    action: 'generate_stripe_pay_link',
  },
  {
    file: 'netlify/functions/admin-ops-jobs.js',
    nth: 2,
    operation: 'CANCEL',
    policies: ['tombstone_410'],
    action: 'generate_stripe_pay_link',
  },
  {
    file: 'netlify/functions/admin-ops-jobs.js',
    nth: 3,
    operation: 'CREATE PAYMENT',
    policies: ['tombstone_410'],
    action: 'charge_policy_fee',
  },
  {
    file: 'netlify/functions/create-setup-intent.js',
    nth: 1,
    operation: 'SAVE CARD',
    policies: ['customer_payments_gate', 'stripe_mode_guard'],
    fn: 'handler',
  },
  {
    file: 'netlify/functions/create-setup-intent.js',
    nth: 2,
    operation: 'SAVE CARD',
    policies: ['customer_payments_gate', 'stripe_mode_guard'],
    fn: 'handler',
  },
  {
    file: 'netlify/functions/customer-subscription-checkout.js',
    nth: 1,
    operation: 'READ ONLY',
    policies: ['customer_payments_gate', 'stripe_mode_guard'],
    fn: 'handler',
  },
  {
    file: 'netlify/functions/customer-subscription-checkout.js',
    nth: 2,
    operation: 'SUBSCRIPTION',
    policies: ['customer_payments_gate', 'stripe_mode_guard'],
    fn: 'handler',
  },
  {
    file: 'netlify/lib/card-on-file.js',
    nth: 1,
    operation: 'READ ONLY',
    policies: ['customer_payments_gate', 'stripe_mode_guard'],
    fn: 'reconcileCardOnFileFromStripe',
  },
  {
    file: 'netlify/lib/charge-saved-card-after-service.js',
    nth: 1,
    operation: 'CREATE PAYMENT',
    policies: ['customer_payments_gate', 'stripe_mode_guard'],
    fn: 'chargeSavedCardAfterService',
    immediateCapture: true,
  },
  {
    file: 'netlify/lib/db/payment-authority-service.js',
    nth: 1,
    operation: 'CREATE PAYMENT',
    policies: ['stripe_mode_guard'],
    fn: 'reserveAndCreatePaymentIntentLocked',
    customerGateInFunction: false,
  },
  {
    file: 'netlify/lib/db/payment-authority-service.js',
    nth: 2,
    operation: 'CREATE PAYMENT',
    policies: ['stripe_mode_guard'],
    fn: 'reserveCeramicPaymentIntentLocked',
    customerGateInFunction: false,
  },
  {
    file: 'netlify/lib/db/payment-authority-service.js',
    nth: 3,
    operation: 'READ ONLY',
    policies: ['stripe_mode_guard'],
    fn: 'retrievePaymentIntentClientSecret',
    customerGateInFunction: false,
  },
  {
    file: 'netlify/lib/db/payment-authority-service.js',
    nth: 4,
    operation: 'CANCEL',
    policies: ['stripe_mode_guard'],
    fn: 'cancelPaymentIntentAtStripe',
    customerGateInFunction: false,
  },
  {
    file: 'netlify/lib/db/payment-authority-service.js',
    nth: 5,
    operation: 'OTHER FINANCIAL WRITE',
    policies: ['stripe_mode_guard'],
    fn: 'createCustomerSession',
    customerGateInFunction: false,
  },
  {
    file: 'netlify/lib/db/payment-authority-service.js',
    nth: 6,
    operation: 'REFUND',
    policies: ['stripe_mode_guard'],
    fn: 'createRefund',
    customerGateInFunction: false,
  },
  {
    file: 'netlify/lib/financial-history-audit-runtime.js',
    nth: 1,
    operation: 'NOT A CALL',
    policies: ['financial_audit_get_only'],
    fn: 'assertStripeGet',
  },
  {
    file: 'netlify/lib/financial-history-audit-runtime.js',
    nth: 2,
    operation: 'READ ONLY',
    policies: ['financial_audit_get_only'],
    fn: 'retrievePaymentIntent',
  },
  {
    file: 'netlify/lib/financial-history-audit-runtime.js',
    nth: 3,
    operation: 'READ ONLY',
    policies: ['financial_audit_get_only'],
    fn: 'listPaymentIntentsPage',
  },
  {
    file: 'netlify/lib/payment-service.js',
    nth: 1,
    operation: 'CANCEL',
    policies: ['caller_stripe_mode_guard'],
    fn: 'expireStripeCheckoutSessions',
    customerGateInFunction: false,
  },
  {
    file: 'netlify/lib/payment-service.js',
    nth: 2,
    operation: 'READ ONLY',
    policies: ['stripe_mode_guard'],
    fn: 'reconcileOpenCheckoutFromProvider',
  },
  {
    file: 'netlify/lib/subscription-checkout.js',
    nth: 1,
    operation: 'READ ONLY',
    policies: ['caller_stripe_mode_guard'],
    fn: 'validateStripePriceAmount',
  },
  {
    file: 'scripts/isolated-balance-proof.js',
    nth: 1,
    operation: 'CAPTURE PAYMENT',
    policies: ['ci_test_key_and_localhost'],
    fn: 'stripeRequest',
    customerGateInFunction: false,
  },
];

const ORIGINAL_ENV = {
  CONTEXT: process.env.CONTEXT,
  NETLIFY_CONTEXT: process.env.NETLIFY_CONTEXT,
  [FLAG]: process.env[FLAG],
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  clearBakedCustomerPaymentsSnapshot();
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function walkJs(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJs(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
}

function stripeLines() {
  const files = [];
  walkJs(path.join(root, 'netlify'), files);
  files.push(path.join(root, 'scripts/isolated-balance-proof.js'));
  const found = [];
  for (const full of files.sort()) {
    const rel = path.relative(root, full);
    const lines = fs.readFileSync(full, 'utf8').split('\n');
    let nth = 0;
    lines.forEach((line, index) => {
      if (!line.includes('api.stripe.com')) return;
      nth += 1;
      found.push({ file: rel, nth, line: index + 1, text: line.trim() });
    });
  }
  return found;
}

function functionBody(src, name) {
  const patterns = name === 'handler'
    ? [/exports\.handler\s*=\s*async\s*(?:function)?\s*\(/]
    : [new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`)];
  let start = -1;
  for (const pattern of patterns) {
    const match = pattern.exec(src);
    if (match) start = match.index;
  }
  if (start < 0) return '';
  const paren = src.indexOf('(', start);
  if (paren < 0) return '';
  let parens = 0;
  let paramsEnd = -1;
  for (let i = paren; i < src.length; i += 1) {
    if (src[i] === '(') parens += 1;
    else if (src[i] === ')') {
      parens -= 1;
      if (parens === 0) {
        paramsEnd = i;
        break;
      }
    }
  }
  const brace = src.indexOf('{', paramsEnd);
  if (brace < 0) return '';
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

function actionSlice(src, action) {
  const marker = `action === '${action}'`;
  const start = src.indexOf(marker);
  if (start < 0) return '';
  const next = src.indexOf('if (action ===', start + marker.length);
  return src.slice(start, next < 0 ? start + 2500 : next);
}

test.afterEach(() => {
  restoreEnv();
});

test('every Stripe URL is classified and every write names its real authorization', () => {
  const found = stripeLines();
  const foundKey = found.map((row) => `${row.file}#${row.nth}`).join('\n');
  const expectedKey = EXPECTED.map((row) => `${row.file}#${row.nth}`).join('\n');
  assert.equal(foundKey, expectedKey, `Stripe URL inventory drifted.\nfound:\n${found.map((row) => `${row.file}:${row.line} #${row.nth} ${row.text}`).join('\n')}`);

  for (const entry of EXPECTED) {
    assert.ok(WRITE_OPERATIONS.has(entry.operation) || READ_OPERATIONS.has(entry.operation), entry.file);
    if (WRITE_OPERATIONS.has(entry.operation)) {
      assert.ok(entry.policies.length > 0, `${entry.file}#${entry.nth} write has no authorization policy`);
    }
    const src = read(entry.file);
    const body = entry.fn ? functionBody(src, entry.fn) : '';
    if (entry.fn) assert.ok(body.length > 0, `missing function ${entry.fn} in ${entry.file}`);
    if (entry.policies.includes('stripe_mode_guard')) {
      assert.match(body, /guardStripeOrReject/);
    }
    if (entry.policies.includes('customer_payments_gate')) {
      assert.match(body, /productionCustomerPaymentsBlocked/);
    }
    if (entry.customerGateInFunction === false) {
      assert.doesNotMatch(body, /productionCustomerPaymentsBlocked/);
    }
    if (entry.policies.includes('tombstone_410')) {
      const slice = actionSlice(src, entry.action);
      const ret = slice.indexOf('return jsonCors(410');
      const call = slice.indexOf('api.stripe.com');
      assert.ok(ret >= 0 && call > ret, `${entry.action} must return 410 before Stripe`);
    }
    if (entry.policies.includes('financial_audit_get_only')) {
      assert.match(body, /assertStripeGet/);
    }
    if (entry.policies.includes('caller_stripe_mode_guard')) {
      assert.doesNotMatch(body, /guardStripeOrReject/);
    }
    if (entry.policies.includes('ci_test_key_and_localhost')) {
      assert.match(src, /live_stripe_key_refused/);
      assert.match(src, /database_host_refused/);
      assert.doesNotMatch(src, /sk_live_[A-Za-z0-9]{8,}/);
    }
  }

  const calls = read('scripts/isolated-balance-proof.js');
  const methods = [...calls.matchAll(/stripeRequest\('([A-Z]+)'/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(methods)].sort(), ['GET', 'POST']);
  assert.match(calls, /payment_intents\/\$\{paymentIntentId\}\/confirm/);
  assert.doesNotMatch(calls, /stripeRequest\('POST', `[^`]*refunds/);

  const netlify = found.map((row) => read(row.file)).join('\n');
  assert.equal(netlify.includes('/capture'), false);
});

test('expire and price reads are authorized by a guarded caller, not by the customer gate', () => {
  const payment = read('netlify/lib/payment-service.js');
  const caller = functionBody(payment, 'expireSupersededAttempts');
  assert.match(caller, /guardStripeOrReject/);
  assert.ok(caller.indexOf('guardStripeOrReject') < caller.indexOf('expireStripeCheckoutSessions'));
  const productionCallers = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        const text = fs.readFileSync(full, 'utf8');
        if (text.includes('expireStripeCheckoutSessions(')) productionCallers.push(path.relative(root, full));
      }
    }
  }
  walk(path.join(root, 'netlify'));
  assert.deepEqual(productionCallers, ['netlify/lib/payment-service.js']);

  const subscription = read('netlify/functions/customer-subscription-checkout.js');
  const handler = functionBody(subscription, 'handler');
  assert.ok(handler.indexOf('productionCustomerPaymentsBlocked') < handler.indexOf('validateStripePriceAmount'));
  assert.ok(handler.indexOf("action === 'list_catalog'") < handler.indexOf('productionCustomerPaymentsBlocked'));
});

test('a closed customer-payment gate does not authorize or block an admin refund', () => {
  process.env.CONTEXT = 'production';
  delete process.env[FLAG];
  process.env.STRIPE_SECRET_KEY = 'sk_test_inventory_not_a_network_call';
  assert.equal(productionCustomerPaymentsBlocked(process.env), true);
  const guard = guardStripeOrReject(process.env, { purpose: 'refund_create' });
  assert.equal(guard.blocked, false);
  assert.equal(guard.body, undefined);

  const refund = functionBody(read('netlify/lib/db/payment-authority-service.js'), 'createRefund');
  assert.match(refund, /guardStripeOrReject\(env, \{ purpose: 'refund_create' \}\)/);
  assert.doesNotMatch(refund, /productionCustomerPaymentsBlocked/);
  assert.ok(refund.indexOf('guardStripeOrReject') < refund.indexOf("https://api.stripe.com/v1/refunds"));
  assert.match(refund, /only a signed refund webhook is financial authority|webhook/);

  const action = actionSlice(read('netlify/functions/admin-ops-jobs.js'), 'record_refund_request');
  assert.match(action, /authority\.createRefund\(/);
  assert.doesNotMatch(action, /productionCustomerPaymentsBlocked/);
  assert.doesNotMatch(action, /fetchImpl/);
  assert.doesNotMatch(action, /api\.stripe\.com/);
});

test('customer session still reaches Stripe when customer payments are closed, and a live preview key does not', async () => {
  process.env.CONTEXT = 'production';
  delete process.env[FLAG];
  process.env.STRIPE_SECRET_KEY = 'sk_test_inventory_not_a_network_call';
  assert.equal(productionCustomerPaymentsBlocked(process.env), true);
  const { createCustomerSession } = require('../netlify/lib/db/payment-authority-service');
  const calls = [];
  const result = await createCustomerSession({
    stripeCustomerId: 'cus_inventory',
    env: process.env,
    fetchImpl: async (url, opts) => {
      calls.push({ url: String(url), method: opts && opts.method });
      return { ok: true, json: async () => ({ client_secret: 'not-a-provider-secret' }) };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://api.stripe.com/v1/customer_sessions');

  process.env.CONTEXT = 'deploy-preview';
  process.env.STRIPE_SECRET_KEY = 'sk_live_inventory_unused';
  const liveCalls = [];
  const live = await createCustomerSession({
    stripeCustomerId: 'cus_inventory',
    env: process.env,
    fetchImpl: async () => {
      liveCalls.push('called');
      return { ok: true, json: async () => ({}) };
    },
  });
  assert.equal(live.ok, false);
  assert.equal(live.error, 'stripe_test_mode_required');
  assert.equal(liveCalls.length, 0);
});

test('saved-card charge and card reconcile do not call Stripe while the customer gate is closed', async () => {
  process.env.CONTEXT = 'production';
  delete process.env[FLAG];
  process.env.STRIPE_SECRET_KEY = 'sk_test_inventory_not_a_network_call';
  assert.equal(productionCustomerPaymentsBlocked(process.env), true);

  const { chargeSavedCardAfterService, AFTER_SERVICE_CHARGE_CONSENT_VERSION } = require('../netlify/lib/charge-saved-card-after-service');
  const calls = [];
  const charge = await chargeSavedCardAfterService({
    confirmCharge: true,
    expectedChargeCents: 15000,
    env: process.env,
    fetchImpl: async () => {
      calls.push('stripe');
      throw new Error('stripe must not be called');
    },
    booking: {
      id: 'CD1-INVENTORY-CHARGE',
      quoteVersion: 2,
      paymentMethodPreference: 'online_after_service',
      cardOnFileStatus: 'saved',
      acceptedCardOnFilePolicy: true,
      afterServiceChargeConsentVersion: AFTER_SERVICE_CHARGE_CONSENT_VERSION,
      afterServiceChargeConsentAt: '2026-09-27T15:00:00.000Z',
      stripeCustomerId: 'cus_inventory',
      stripePaymentMethodId: 'pm_inventory',
      approvedFinalAmount: 180,
      totalPrice: 180,
      amountPaid: 30,
      changeRequests: [],
    },
    projection: {
      remainingCents: 15000,
      paymentStatus: 'due',
      approvedCents: 18000,
      settledCents: 3000,
    },
  });
  assert.equal(charge.ok, false);
  assert.equal(charge.error, 'customer_payments_unavailable');
  assert.equal(charge.stripeCalled, false);
  assert.equal(calls.length, 0);

  const { reconcileCardOnFileFromStripe } = require('../netlify/lib/card-on-file');
  const existing = {
    id: 'CD1-INVENTORY-CARD',
    cardOnFileStatus: 'pending',
    setupIntentId: 'seti_inventory_not_real',
  };
  const updated = await reconcileCardOnFileFromStripe(null, existing, process.env, async () => {
    calls.push('stripe');
    throw new Error('stripe must not be called');
  });
  assert.equal(updated, existing);
  assert.equal(updated.cardOnFileStatus, 'pending');
  assert.equal(calls.length, 0);
});

test('booking still finalizes without a processor and does not treat preference as payment', () => {
  process.env.CONTEXT = 'production';
  delete process.env[FLAG];
  const submit = require('../netlify/functions/submit-booking');
  const online = submit.__test.rejectClosedOnlinePreference('online_after_service');
  assert.equal(online.statusCode, 403);
  assert.equal(JSON.parse(online.body).error, 'customer_payments_unavailable');
  assert.equal(JSON.parse(online.body).stripeCalled, false);
  assert.equal(submit.__test.rejectClosedOnlinePreference('cash_onsite'), null);
  assert.equal(submit.__test.rejectClosedOnlinePreference('card_onsite'), null);
  const historical = submit.__test.rejectClosedOnlinePreference('card_online');
  assert.equal(historical.statusCode, 403);
  assert.equal(JSON.parse(historical.body).error, 'customer_payments_unavailable');

  const src = read('netlify/functions/submit-booking.js');
  assert.doesNotMatch(src, /api\.stripe\.com/);
  assert.match(src, /paymentStatus:\s+'no_payment_required_yet'/);
  assert.match(src, /paymentStatus can only be set by stripe-webhook\.js/);
  const prefs = src.slice(src.indexOf('const PAYMENT_PREFERENCES'), src.indexOf('const CARD_ON_FILE_VERIFY_MSG'));
  assert.match(prefs, /cash_onsite/);
  assert.match(prefs, /card_onsite/);
  assert.match(prefs, /online_after_service/);
  assert.doesNotMatch(prefs, /secure_invoice/);
});

test('historical Stripe rows and the ledger contract stay intact', () => {
  const schema = read('prisma/schema.prisma');
  assert.match(schema, /provider\s+String\s+@default\("stripe"\)/);
  assert.match(schema, /enum ProviderObjectType \{\s*payment_intent\s*checkout_session\s*setup_intent\s*\}/);
  assert.match(schema, /model StripeEvent \{/);
  assert.match(schema, /model LedgerEntry \{/);
  assert.match(schema, /enum PaymentAttemptStatus \{\s*creating\s*open\s*requires_action\s*succeeded\s*failed\s*canceled\s*expired\s*superseded\s*\}/);
  const migration = read('prisma/migrations/20260718181514_phase2_transactional_foundation/migration.sql');
  assert.match(migration, /LedgerEntry rows are immutable/);
  assert.match(migration, /CREATE TRIGGER ledger_entry_no_update/);
  assert.match(migration, /CREATE TRIGGER ledger_entry_no_delete/);
  assert.doesNotMatch(read('tests/stripe-financial-safety-baseline.test.js'), /sk_live_[A-Za-z0-9]{20,}/);
  assert.doesNotMatch(read('docs/audit/stripe-financial-safety-baseline.md'), /sk_live_[A-Za-z0-9]/);
});

test('the committed customer-payment snapshot stays closed', () => {
  const stub = read('netlify/lib/deploy-runtime-env.generated.js');
  assert.match(stub, /STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED:\s*false/);
  assert.doesNotMatch(stub, /sk_|pk_|whsec_/);
  delete process.env[FLAG];
  process.env.CONTEXT = 'production';
  assert.equal(productionCustomerPaymentsBlocked(process.env), true);
});
