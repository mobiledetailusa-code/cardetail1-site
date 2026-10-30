'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  prepareAdministrativePaymentLinkRequest,
  ORDER_REFERENCE_MAX_LENGTH,
  SQUARE_VERSION,
  SQUARE_PAYMENT_LINKS_PATH,
} = require('../netlify/lib/square-admin-payment-link-contract');
const { ACTIVE_PAYMENT_PROVIDER } = require('../netlify/lib/payment-provider-adapter');

const root = path.resolve(__dirname, '..');

function trusted(overrides = {}) {
  return {
    bookingId: 'BK1001',
    amountCents: 12500,
    currency: 'USD',
    locationId: 'L8K2LOCATION',
    correlationReference: 'cd1-BK1001-12500',
    ...overrides,
  };
}

function assertInactive(result) {
  assert.equal(result.authoritative, false);
  assert.equal(result.paid, false);
  assert.equal(result.financiallySettled, false);
  assert.equal(result.providerCalled, false);
  assert.equal(result.createsPayment, false);
  assert.equal(result.createsPaymentLink, false);
}

test('valid trusted booking data prepares an order checkout body', () => {
  const result = prepareAdministrativePaymentLinkRequest(trusted());
  assert.equal(result.ok, true);
  assertInactive(result);
  assert.equal(result.squareRequest.method, 'POST');
  assert.equal(result.squareRequest.path, SQUARE_PAYMENT_LINKS_PATH);
  assert.equal(result.squareRequest.squareVersion, SQUARE_VERSION);
  assert.equal(result.squareRequest.body.order.reference_id, 'cd1-BK1001-12500');
  assert.equal(result.squareRequest.body.order.line_items[0].base_price_money.amount, 12500);
  assert.equal(result.squareRequest.body.order.line_items[0].base_price_money.currency, 'USD');
  assert.equal(result.squareRequest.body.quick_pay, undefined);
  assert.equal(result.association.bookingId, 'BK1001');
});

test('lowercase usd is normalized and does not change the idempotency key', () => {
  const upper = prepareAdministrativePaymentLinkRequest(trusted());
  const lower = prepareAdministrativePaymentLinkRequest(trusted({ currency: 'usd' }));
  assert.equal(lower.ok, true);
  assert.equal(lower.association.currency, 'USD');
  assert.equal(lower.association.idempotencyKey, upper.association.idempotencyKey);
});

test('invalid amount is rejected', () => {
  for (const amountCents of [0, -5, 12.5, Number.NaN]) {
    const result = prepareAdministrativePaymentLinkRequest(trusted({ amountCents }));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'approved_amount_invalid');
    assertInactive(result);
  }
});

test('invalid currency is rejected', () => {
  const result = prepareAdministrativePaymentLinkRequest(trusted({ currency: 'EUR' }));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'currency_invalid');
  assertInactive(result);
});

test('missing booking identity is rejected', () => {
  const input = trusted();
  delete input.bookingId;
  const result = prepareAdministrativePaymentLinkRequest(input);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'booking_identity_invalid');
  assertInactive(result);
});

test('invalid location identity is rejected', () => {
  const result = prepareAdministrativePaymentLinkRequest(trusted({ locationId: 'not a location' }));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'location_identity_invalid');
  assertInactive(result);
});

test('the same approved operation keeps one idempotency key', () => {
  const first = prepareAdministrativePaymentLinkRequest(trusted());
  const second = prepareAdministrativePaymentLinkRequest(trusted());
  assert.deepEqual(first, second);
  assert.equal(first.association.idempotencyKey.length <= 45, true);
});

test('a different approved amount produces a different idempotency key', () => {
  const original = prepareAdministrativePaymentLinkRequest(trusted());
  const changed = prepareAdministrativePaymentLinkRequest(trusted({
    amountCents: 15000,
    priorAmountCents: 12500,
  }));
  assert.equal(changed.ok, true);
  assert.notEqual(changed.association.idempotencyKey, original.association.idempotencyKey);
  assert.equal(changed.supersedesPriorAmount, true);
  assert.equal(changed.paid, false);
  assert.equal(changed.createsPaymentLink, false);
});

test('repeating the same amount does not supersede the request', () => {
  const result = prepareAdministrativePaymentLinkRequest(trusted({ priorAmountCents: 12500 }));
  assert.equal(result.ok, true);
  assert.equal(result.supersedesPriorAmount, false);
  assert.equal(
    result.association.idempotencyKey,
    prepareAdministrativePaymentLinkRequest(trusted()).association.idempotencyKey
  );
});

test('malformed correlation references are rejected', () => {
  const tooLong = `R${'a'.repeat(ORDER_REFERENCE_MAX_LENGTH)}`;
  for (const correlationReference of ['https://pay.example/1', 'bad ref', tooLong, '']) {
    const result = prepareAdministrativePaymentLinkRequest(trusted({ correlationReference }));
    assert.equal(result.ok, false, correlationReference);
    assert.equal(result.error, 'correlation_reference_invalid');
    assertInactive(result);
  }
});

test('caller-supplied payment success markers are not accepted as authority', () => {
  const result = prepareAdministrativePaymentLinkRequest(trusted({
    paid: true,
    financiallySettled: true,
    paymentStatus: 'COMPLETED',
    settlementCommitted: true,
    paymentId: 'sq_payment_untrusted',
    paymentLinkUrl: 'https://square.link/u/untrusted',
  }));
  assert.equal(result.ok, true);
  assertInactive(result);
  assert.equal(result.paymentStatus, undefined);
  assert.equal(result.paymentId, undefined);
  assert.equal(result.paymentLinkUrl, undefined);
  assert.equal(result.squareRequest.body.order.reference_id, 'cd1-BK1001-12500');
});

test('input is not mutated', () => {
  const input = Object.freeze(trusted());
  const before = JSON.stringify(input);
  prepareAdministrativePaymentLinkRequest(input);
  assert.equal(JSON.stringify(input), before);
});

test('module source performs no network or database work and ignores Phase 7F.1', () => {
  const src = fs.readFileSync(path.join(root, 'netlify/lib/square-admin-payment-link-contract.js'), 'utf8');
  assert.doesNotMatch(src, /\bfetch\s*\(/);
  assert.doesNotMatch(src, /require\s*\(\s*['"]pg['"]/);
  assert.doesNotMatch(src, /prisma/i);
  assert.doesNotMatch(src, /square-persistence/);
  assert.doesNotMatch(src, /square-sandbox-provider/);
  assert.doesNotMatch(src, /https:\/\/connect\.squareup/);
});

test('commercial functions do not import the contract and the provider stays none', () => {
  assert.equal(ACTIVE_PAYMENT_PROVIDER, 'none');
  const env = fs.readFileSync(path.join(root, 'netlify/lib/deploy-runtime-env.generated.js'), 'utf8');
  assert.match(env, /STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED:\s*false/);
  const fnDir = path.join(root, 'netlify/functions');
  for (const name of fs.readdirSync(fnDir)) {
    if (!name.endsWith('.js')) continue;
    const full = path.join(fnDir, name);
    if (!fs.statSync(full).isFile()) continue;
    assert.equal(fs.readFileSync(full, 'utf8').includes('square-admin-payment-link-contract'), false, name);
  }
});
