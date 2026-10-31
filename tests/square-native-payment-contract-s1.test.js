'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const {
  resolveSquareNativePaymentContract,
  validatePaymentReference,
  FINANCIAL_AUTHORITY_KEYS,
} = require('../netlify/lib/square-native-payment-contract');
const { ACTIVE_PAYMENT_PROVIDER } = require('../netlify/lib/payment-provider-adapter');

function assertUnpaidSuccess(result) {
  assert.equal(result.ok, true);
  assert.equal(result.paid, false);
  assert.equal(result.financiallySettled, false);
  assert.equal(result.providerCalled, false);
  assert.equal(result.createsPayment, false);
  assert.equal(result.createsPaymentLink, false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'settlementCommitted'), false);
}

function assertExplicitUnpaidError(result) {
  assert.equal(result.ok, false);
  assert.equal(result.paid, false);
  assert.equal(result.financiallySettled, false);
  assert.equal(result.providerCalled, false);
  assert.equal(result.createsPayment, false);
  assert.equal(result.createsPaymentLink, false);
}

test('1. valid cash preference', () => {
  const result = resolveSquareNativePaymentContract({ paymentMethodPreference: 'cash_onsite' });
  assertUnpaidSuccess(result);
  assert.equal(result.preference, 'cash_onsite');
  assert.equal(result.paymentLinkRequested, false);
});

test('2. valid card-on-site preference', () => {
  const result = resolveSquareNativePaymentContract({ paymentMethodPreference: 'card_on_site' });
  assertUnpaidSuccess(result);
  assert.equal(result.preference, 'card_onsite');
});

test('3. valid payment-link preference', () => {
  const result = resolveSquareNativePaymentContract({ preference: 'payment_link' });
  assertUnpaidSuccess(result);
  assert.equal(result.preference, 'payment_link_requested');
  assert.equal(result.paymentLinkRequested, true);
});

test('4. missing optional reference', () => {
  const result = resolveSquareNativePaymentContract({ paymentMethodPreference: 'cash_onsite' });
  assertUnpaidSuccess(result);
  assert.equal(result.paymentReference, null);
});

test('5. valid opaque reference', () => {
  const result = resolveSquareNativePaymentContract({
    paymentMethodPreference: 'card_onsite',
    paymentReference: 'ref_booking_2026_abc-01',
  });
  assertUnpaidSuccess(result);
  assert.equal(result.paymentReference, 'ref_booking_2026_abc-01');
});

test('6. invalid preference', () => {
  const result = resolveSquareNativePaymentContract({ paymentMethodPreference: 'online_after_service' });
  assertExplicitUnpaidError(result);
  assert.equal(result.error, 'invalid_payment_preference');
});

test('7. malformed reference (URL-like)', () => {
  const result = resolveSquareNativePaymentContract({
    paymentMethodPreference: 'cash_onsite',
    paymentReference: 'https://pay.example/receipt/1',
  });
  assertExplicitUnpaidError(result);
  assert.equal(result.error, 'invalid_payment_reference');
});

test('8. oversized reference', () => {
  const result = resolveSquareNativePaymentContract({
    paymentMethodPreference: 'cash_onsite',
    paymentReference: `a${'b'.repeat(200)}`,
  });
  assertExplicitUnpaidError(result);
  assert.equal(result.error, 'invalid_payment_reference');
  assert.equal(result.reason, 'length');
});

test('9. client-supplied paid: true cannot override contract', () => {
  const input = { paymentMethodPreference: 'cash_onsite', paid: true };
  const result = resolveSquareNativePaymentContract(input);
  assertUnpaidSuccess(result);
  assert.equal(input.paid, true);
});

test('10. client-supplied completed-payment marker', () => {
  const input = {
    paymentMethodPreference: 'card_onsite',
    paymentStatus: 'COMPLETED',
  };
  const result = resolveSquareNativePaymentContract(input);
  assertUnpaidSuccess(result);
  assert.equal(result.paymentStatus, undefined);
});

test('11. client-supplied settlement marker', () => {
  const input = {
    paymentMethodPreference: 'cash_onsite',
    settlementCommitted: true,
    financiallySettled: true,
  };
  const result = resolveSquareNativePaymentContract(input);
  assertUnpaidSuccess(result);
});

test('12. unexpected financial authority fields are not echoed', () => {
  const input = {
    paymentMethodPreference: 'payment_link_requested',
    providerPaymentId: 'sq_fake',
    settlementId: 'stl_fake',
    evidenceId: 'evd_fake',
    commitId: 'commit_fake',
    financiallyAuthorized: true,
  };
  const result = resolveSquareNativePaymentContract(input);
  assertUnpaidSuccess(result);
  for (const key of FINANCIAL_AUTHORITY_KEYS) {
    if (key === 'paid' || key === 'financiallySettled') continue;
    assert.equal(result[key], undefined);
  }
});

test('13. input immutability', () => {
  const input = Object.freeze({
    paymentMethodPreference: 'cash_onsite',
    paymentReference: 'opaque_1',
  });
  const before = JSON.stringify(input);
  resolveSquareNativePaymentContract(input);
  assert.equal(JSON.stringify(input), before);
});

test('14. deterministic output', () => {
  const input = { paymentMethodPreference: 'card_onsite', paymentReference: 'same_ref' };
  const a = resolveSquareNativePaymentContract(input);
  const b = resolveSquareNativePaymentContract(input);
  assert.deepEqual(a, b);
});

test('15. no provider calls in module source', () => {
  const src = read('netlify/lib/square-native-payment-contract.js');
  assert.doesNotMatch(src, /\bfetch\s*\(/);
  assert.doesNotMatch(src, /require\s*\(\s*['"]pg['"]\s*\)/);
  assert.doesNotMatch(src, /square-persistence/);
  assert.doesNotMatch(src, /square-settlement/);
  assert.doesNotMatch(src, /square-reconciliation/);
  assert.doesNotMatch(src, /api\.stripe\.com/);
  assert.doesNotMatch(src, /connect\.squareup/);
});

test('16. no database calls in module source', () => {
  const src = read('netlify/lib/square-native-payment-contract.js');
  assert.doesNotMatch(src, /require\s*\(\s*['"]@prisma/);
  assert.doesNotMatch(src, /require\s*\(\s*['"].*prisma/);
  assert.doesNotMatch(src, /Client\s*\(/);
});

test('validatePaymentReference rejects non-string types', () => {
  const result = validatePaymentReference({ ok: true });
  assertExplicitUnpaidError(result);
  assert.equal(result.error, 'invalid_payment_reference');
});

test('commercial isolation: provider remains none and Stripe customer gate false', () => {
  assert.equal(ACTIVE_PAYMENT_PROVIDER, 'none');
  const env = read('netlify/lib/deploy-runtime-env.generated.js');
  assert.match(env, /STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED:\s*false/);
});

test('module is not wired into commercial functions (static scan)', () => {
  const fnDir = path.join(root, 'netlify/functions');
  for (const name of fs.readdirSync(fnDir)) {
    if (!name.endsWith('.js')) continue;
    const full = path.join(fnDir, name);
    if (!fs.statSync(full).isFile()) continue;
    assert.equal(
      read(path.join('netlify/functions', name)).includes('square-native-payment-contract'),
      false,
      full
    );
  }
});

test('S1.1 inherited valid preference is ignored', () => {
  const input = Object.create({ paymentMethodPreference: 'cash_onsite' });
  const result = resolveSquareNativePaymentContract(input);
  assertExplicitUnpaidError(result);
  assert.equal(result.error, 'payment_preference_required');
});

test('S1.1 inherited invalid preference is ignored', () => {
  const input = Object.create({ paymentMethodPreference: 'online_after_service' });
  const result = resolveSquareNativePaymentContract(input);
  assertExplicitUnpaidError(result);
  assert.equal(result.error, 'payment_preference_required');
});

test('S1.1 inherited payment reference is ignored', () => {
  const input = Object.create({
    paymentMethodPreference: 'cash_onsite',
    paymentReference: 'inherited_ref',
  });
  Object.assign(input, { paymentMethodPreference: 'cash_onsite' });
  const result = resolveSquareNativePaymentContract(input);
  assertUnpaidSuccess(result);
  assert.equal(result.paymentReference, null);
});

test('S1.1 null-prototype object with own preference', () => {
  const input = Object.assign(Object.create(null), {
    paymentMethodPreference: 'card_onsite',
  });
  const result = resolveSquareNativePaymentContract(input);
  assertUnpaidSuccess(result);
  assert.equal(result.preference, 'card_onsite');
});

test('S1.1 empty object requires preference', () => {
  const result = resolveSquareNativePaymentContract({});
  assertExplicitUnpaidError(result);
  assert.equal(result.error, 'payment_preference_required');
});

test('S1.1 valid string preference input', () => {
  const result = resolveSquareNativePaymentContract('cash_onsite');
  assertUnpaidSuccess(result);
  assert.equal(result.preference, 'cash_onsite');
});

test('S1.1 invalid string preference input', () => {
  const result = resolveSquareNativePaymentContract('online_after_service');
  assertExplicitUnpaidError(result);
  assert.equal(result.error, 'invalid_payment_preference');
});

test('S1.1 array input is rejected', () => {
  const result = resolveSquareNativePaymentContract(['cash_onsite']);
  assertExplicitUnpaidError(result);
  assert.equal(result.error, 'payment_preference_required');
});

test('S1.1 null input is rejected', () => {
  const result = resolveSquareNativePaymentContract(null);
  assertExplicitUnpaidError(result);
  assert.equal(result.error, 'payment_preference_required');
});

test('S1.1 unsupported numeric primitive is rejected', () => {
  const result = resolveSquareNativePaymentContract(42);
  assertExplicitUnpaidError(result);
  assert.equal(result.error, 'payment_preference_required');
});

test('S1.1 own accessor preference is rejected without invoking getter', () => {
  let invoked = false;
  const input = {};
  Object.defineProperty(input, 'paymentMethodPreference', {
    configurable: true,
    enumerable: true,
    get() {
      invoked = true;
      return 'cash_onsite';
    },
  });
  const result = resolveSquareNativePaymentContract(input);
  assert.equal(invoked, false);
  assertExplicitUnpaidError(result);
  assert.equal(result.error, 'invalid_contract_input');
  assert.equal(result.reason, 'unsupported_property_descriptor');
});

test('S1.1 malformed reference charset', () => {
  const result = resolveSquareNativePaymentContract({
    paymentMethodPreference: 'cash_onsite',
    paymentReference: 'bad ref space',
  });
  assertExplicitUnpaidError(result);
  assert.equal(result.reason, 'charset');
});

test('S1.1 explicit unpaid fields on preference errors', () => {
  const result = resolveSquareNativePaymentContract({ paymentMethodPreference: 'not_real' });
  assertExplicitUnpaidError(result);
});

test('S1.1 string card and payment-link compatibility', () => {
  assert.equal(resolveSquareNativePaymentContract('card_onsite').preference, 'card_onsite');
  assert.equal(
    resolveSquareNativePaymentContract('payment_link_requested').preference,
    'payment_link_requested'
  );
});

test('S1.1 own non-string preference field is rejected', () => {
  const result = resolveSquareNativePaymentContract({ paymentMethodPreference: 123 });
  assertExplicitUnpaidError(result);
  assert.equal(result.error, 'invalid_contract_input');
  assert.equal(result.reason, 'invalid_property_type');
});
