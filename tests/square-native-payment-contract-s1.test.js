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

function assertUnpaid(result) {
  assert.equal(result.ok, true);
  assert.equal(result.paid, false);
  assert.equal(result.financiallySettled, false);
  assert.equal(result.providerCalled, false);
  assert.equal(result.createsPayment, false);
  assert.equal(result.createsPaymentLink, false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'settlementCommitted'), false);
}

test('1. valid cash preference', () => {
  const result = resolveSquareNativePaymentContract({ paymentMethodPreference: 'cash_onsite' });
  assertUnpaid(result);
  assert.equal(result.preference, 'cash_onsite');
  assert.equal(result.paymentLinkRequested, false);
});

test('2. valid card-on-site preference', () => {
  const result = resolveSquareNativePaymentContract({ paymentMethodPreference: 'card_on_site' });
  assertUnpaid(result);
  assert.equal(result.preference, 'card_onsite');
});

test('3. valid payment-link preference', () => {
  const result = resolveSquareNativePaymentContract({ preference: 'payment_link' });
  assertUnpaid(result);
  assert.equal(result.preference, 'payment_link_requested');
  assert.equal(result.paymentLinkRequested, true);
});

test('4. missing optional reference', () => {
  const result = resolveSquareNativePaymentContract({ paymentMethodPreference: 'cash_onsite' });
  assertUnpaid(result);
  assert.equal(result.paymentReference, null);
});

test('5. valid opaque reference', () => {
  const result = resolveSquareNativePaymentContract({
    paymentMethodPreference: 'card_onsite',
    paymentReference: 'ref_booking_2026_abc-01',
  });
  assertUnpaid(result);
  assert.equal(result.paymentReference, 'ref_booking_2026_abc-01');
});

test('6. invalid preference', () => {
  const result = resolveSquareNativePaymentContract({ paymentMethodPreference: 'online_after_service' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_payment_preference');
});

test('7. malformed reference (URL-like)', () => {
  const result = resolveSquareNativePaymentContract({
    paymentMethodPreference: 'cash_onsite',
    paymentReference: 'https://pay.example/receipt/1',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_payment_reference');
});

test('8. oversized reference', () => {
  const result = resolveSquareNativePaymentContract({
    paymentMethodPreference: 'cash_onsite',
    paymentReference: `a${'b'.repeat(200)}`,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_payment_reference');
  assert.equal(result.reason, 'length');
});

test('9. client-supplied paid: true cannot override contract', () => {
  const input = { paymentMethodPreference: 'cash_onsite', paid: true };
  const result = resolveSquareNativePaymentContract(input);
  assertUnpaid(result);
  assert.equal(input.paid, true);
});

test('10. client-supplied completed-payment marker', () => {
  const input = {
    paymentMethodPreference: 'card_onsite',
    paymentStatus: 'COMPLETED',
  };
  const result = resolveSquareNativePaymentContract(input);
  assertUnpaid(result);
  assert.equal(result.paymentStatus, undefined);
});

test('11. client-supplied settlement marker', () => {
  const input = {
    paymentMethodPreference: 'cash_onsite',
    settlementCommitted: true,
    financiallySettled: true,
  };
  const result = resolveSquareNativePaymentContract(input);
  assertUnpaid(result);
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
  assertUnpaid(result);
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
  assert.equal(validatePaymentReference({ ok: true }).ok, false);
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
