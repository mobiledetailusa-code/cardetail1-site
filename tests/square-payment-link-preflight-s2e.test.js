'use strict';

process.env.PRISMA_BOOKING_MIRROR = '0';
process.env.PRISMA_BOOKING_READ = '0';
process.env.CD1_POSTGRES_PAYMENT = '0';
delete process.env.NETLIFY_SITE_ID;
delete process.env.NETLIFY_AUTH_TOKEN;
delete process.env.NETLIFY_BLOBS_CONTEXT;
delete process.env.DATABASE_URL;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { evaluateSquarePaymentLinkPreflight } = require('../netlify/lib/square-payment-link-preflight');
const { operationIdentity } = require('../netlify/lib/square-prepared-issuance');
const { ACTIVE_PAYMENT_PROVIDER } = require('../netlify/lib/payment-provider-adapter');

const root = path.resolve(__dirname, '..');
const BOOKING_ID = 'CD1-S2EPRE1';
const ISSUANCE_ID = '11111111-1111-4111-8111-111111111111';

global.fetch = () => {
  throw new Error('network_forbidden');
};

function booking(overrides = {}) {
  return {
    id: BOOKING_ID,
    quoteVersion: 1,
    jobStatus: 'confirmed',
    paymentStatus: 'unpaid',
    ledger: {
      currency: 'usd',
      approvedCents: 25000,
      settledCents: 0,
      creditedCents: 0,
    },
    ...overrides,
  };
}

function projection(overrides = {}, wrapper = {}) {
  return {
    ok: true,
    authority: 'postgres',
    bookingId: BOOKING_ID,
    projection: {
      bookingId: BOOKING_ID,
      authority: 'postgres',
      quoteVersion: 1,
      approvedCents: 25000,
      remainingCents: 25000,
      currency: 'usd',
      grossSettledCents: 0,
      refundedCents: 0,
      settledCents: 0,
      ...overrides,
    },
    ...wrapper,
  };
}

function issuance(overrides = {}) {
  const record = {
    bookingId: BOOKING_ID,
    issuanceId: ISSUANCE_ID,
    state: 'prepared',
    amountCents: 25000,
    currency: 'USD',
    quoteVersion: 1,
    approvedCents: 25000,
    grossSettledCents: 0,
    refundedCents: 0,
    settledCents: 0,
    ...overrides,
  };
  if (!Object.prototype.hasOwnProperty.call(overrides, 'operationId')) {
    record.operationId = operationIdentity({
      issuanceId: record.issuanceId,
      bookingId: record.bookingId,
      amountCents: record.amountCents,
      currency: record.currency,
    });
  }
  return record;
}

function evaluate(overrides = {}) {
  return evaluateSquarePaymentLinkPreflight({
    booking: Object.prototype.hasOwnProperty.call(overrides, 'booking') ? overrides.booking : booking(),
    financial: Object.prototype.hasOwnProperty.call(overrides, 'financial') ? overrides.financial : projection(),
    issuance: Object.prototype.hasOwnProperty.call(overrides, 'issuance') ? overrides.issuance : issuance(),
    providerConfig: overrides.providerConfig,
  });
}

function assertInactive(result) {
  assert.equal(result.paid, false);
  assert.equal(result.financiallySettled, false);
  assert.equal(result.authoritative, false);
  assert.equal(result.providerCalled, false);
  assert.equal(result.createsPayment, false);
  assert.equal(result.createsPaymentLink, false);
  assert.equal(Object.hasOwn(result, 'paymentAuthorized'), false);
  assert.equal(Object.hasOwn(result, 'chargeAuthorized'), false);
  assert.equal(Object.hasOwn(result, 'settlementCommitted'), false);
}

function settledBooking(settledCents, extra = {}) {
  return booking({
    ledger: {
      currency: 'usd',
      approvedCents: 25000,
      settledCents,
      creditedCents: 0,
    },
    ...extra,
  });
}

test('an unchanged financial snapshot passes without authorizing payment', () => {
  const row = booking();
  const result = evaluate({
    booking: row,
    providerConfig: { locationId: 'not-server-config', paymentAuthorized: true },
  });
  assert.equal(result.ok, true);
  assert.equal(result.preflightPassed, true);
  assert.equal(result.error, undefined);
  assert.equal(row.paymentStatus, 'unpaid');
  assertInactive(result);
  assert.equal(JSON.stringify(result).includes('25000'), false);
});

test('a missing booking is rejected', () => {
  const result = evaluate({ booking: null });
  assert.equal(result.ok, false);
  assert.equal(result.preflightPassed, false);
  assert.equal(result.error, 'booking_required');
  assertInactive(result);
});

test('a missing issuance is rejected', () => {
  const result = evaluate({ issuance: null });
  assert.equal(result.error, 'issuance_required');
  assertInactive(result);
});

test('an issuance that is not prepared is rejected', () => {
  const result = evaluate({ issuance: issuance({ state: 'issued' }) });
  assert.equal(result.error, 'preparation_state_unsupported');
  assertInactive(result);
});

test('a booking identity mismatch is rejected', () => {
  const result = evaluate({ issuance: issuance({ bookingId: 'CD1-OTHER' }) });
  assert.equal(result.error, 'financial_booking_mismatch');
  assertInactive(result);
});

test('a missing issuance identity is rejected', () => {
  const result = evaluate({ issuance: issuance({ issuanceId: '' }) });
  assert.equal(result.error, 'issuance_identity_invalid');
  assertInactive(result);
});

test('a missing operation identity is rejected', () => {
  const result = evaluate({ issuance: issuance({ operationId: '' }) });
  assert.equal(result.error, 'operation_identity_mismatch');
  assertInactive(result);
});

test('an invalid operation identity is rejected', () => {
  const result = evaluate({ issuance: issuance({ operationId: 'f'.repeat(64) }) });
  assert.equal(result.error, 'operation_identity_mismatch');
  assertInactive(result);
});

test('a missing PostgreSQL projection is rejected', () => {
  const result = evaluate({ financial: null });
  assert.equal(result.error, 'financial_authority_unavailable');
  assertInactive(result);
});

test('a failed projection is rejected', () => {
  const result = evaluate({
    financial: { ok: false, authority: 'none', error: 'projection_unavailable' },
  });
  assert.equal(result.error, 'financial_authority_unavailable');
  assertInactive(result);
});

test('a Blob fallback is rejected', () => {
  const result = evaluate({
    financial: { ok: false, authority: 'blob', error: 'projection_unavailable' },
  });
  assert.equal(result.error, 'financial_blob_fallback_rejected');
  assertInactive(result);
});

test('an unknown authority is rejected', () => {
  const result = evaluate({
    financial: projection({}, { authority: 'cache' }),
  });
  assert.equal(result.error, 'financial_source_unverified');
  assertInactive(result);
});

test('a zero remaining balance is rejected', () => {
  const result = evaluate({
    booking: settledBooking(25000),
    financial: projection({
      remainingCents: 0,
      grossSettledCents: 25000,
      settledCents: 25000,
    }),
    issuance: issuance({
      amountCents: 0,
      grossSettledCents: 25000,
      settledCents: 25000,
    }),
  });
  assert.equal(result.error, 'not_payable');
  assertInactive(result);
});

test('a negative remaining balance is rejected and is not coerced to zero', () => {
  const result = evaluate({
    financial: projection({ remainingCents: -1 }),
  });
  assert.equal(result.error, 'financial_amount_invalid');
  assertInactive(result);
});

test('a currency mismatch is rejected', () => {
  const result = evaluate({
    financial: projection({ currency: 'eur' }),
  });
  assert.equal(result.error, 'financial_currency_unsupported');
  assertInactive(result);
});

test('an approved amount mismatch is rejected', () => {
  const result = evaluate({
    financial: projection({ approvedCents: 30000 }),
  });
  assert.equal(result.error, 'financial_approved_amount_mismatch');
  assertInactive(result);
});

test('a quote-version mismatch is rejected', () => {
  const result = evaluate({
    financial: projection({ quoteVersion: 2 }),
  });
  assert.equal(result.error, 'financial_quote_version_mismatch');
  assertInactive(result);
});

test('a gross-settlement mismatch is rejected', () => {
  const result = evaluate({
    financial: projection({ grossSettledCents: 100 }),
  });
  assert.equal(result.error, 'financial_gross_settled_changed');
  assertInactive(result);
});

test('a refunded-total mismatch is rejected', () => {
  const result = evaluate({
    financial: projection({ refundedCents: 1000 }),
  });
  assert.equal(result.error, 'financial_refunded_changed');
  assertInactive(result);
});

test('a net-settlement mismatch is rejected', () => {
  const result = evaluate({
    financial: projection({ settledCents: 500 }),
  });
  assert.equal(result.error, 'financial_settled_changed');
  assertInactive(result);
});

test('a settlement and refund that restore the remaining balance do not revive the old snapshot', () => {
  const result = evaluate({
    financial: projection({
      remainingCents: 25000,
      grossSettledCents: 25000,
      refundedCents: 25000,
      settledCents: 0,
    }),
  });
  assert.equal(result.preflightPassed, false);
  assert.equal(result.error, 'financial_gross_settled_changed');
  assertInactive(result);
});

test('a legacy issuance without a financial snapshot is rejected', () => {
  const legacy = issuance();
  delete legacy.quoteVersion;
  delete legacy.approvedCents;
  delete legacy.grossSettledCents;
  delete legacy.refundedCents;
  delete legacy.settledCents;
  const result = evaluate({ issuance: legacy });
  assert.equal(result.error, 'financial_snapshot_missing');
  assertInactive(result);
});

test('malformed cent amounts are rejected', () => {
  const fractionalIssuance = evaluate({
    issuance: issuance({ grossSettledCents: 12.5 }),
  });
  assert.equal(fractionalIssuance.error, 'financial_snapshot_invalid');
  const fractionalProjection = evaluate({
    financial: projection({ remainingCents: 10.5 }),
  });
  assert.equal(fractionalProjection.error, 'financial_amount_invalid');
  const missingGross = evaluate({
    financial: projection({ grossSettledCents: undefined }),
  });
  assert.equal(missingGross.error, 'financial_amount_invalid');
  assertInactive(fractionalIssuance);
});

test('a canceled booking is rejected', () => {
  const result = evaluate({
    booking: booking({ jobStatus: 'cancelled' }),
  });
  assert.equal(result.preflightPassed, false);
  assert.equal(result.error, 'financial_balance_mismatch');
  assertInactive(result);
});

test('a previously superseded issuance is rejected', () => {
  const result = evaluate({ issuance: issuance({ state: 'superseded' }) });
  assert.equal(result.error, 'preparation_state_unsupported');
  assertInactive(result);
});

test('a stored amount that disagrees with the current remaining balance is rejected', () => {
  const result = evaluate({
    issuance: issuance({ amountCents: 100 }),
  });
  assert.equal(result.error, 'payable_balance_changed');
  assertInactive(result);
});

test('a snapshot that changed after preparation is rejected', () => {
  const result = evaluate({
    booking: booking({ quoteVersion: 2 }),
    financial: projection({ quoteVersion: 2 }),
    issuance: issuance({ quoteVersion: 1 }),
  });
  assert.equal(result.error, 'financial_quote_version_changed');
  assertInactive(result);
});

test('inputs are not mutated', () => {
  const row = booking();
  const financial = projection();
  const prepared = issuance();
  const providerConfig = { locationId: 'L1', paymentAuthorized: true };
  const before = JSON.stringify({ row, financial, prepared, providerConfig });
  evaluateSquarePaymentLinkPreflight({
    booking: row,
    financial,
    issuance: prepared,
    providerConfig,
  });
  evaluateSquarePaymentLinkPreflight({
    booking: row,
    financial: projection({ refundedCents: 1000 }),
    issuance: prepared,
  });
  assert.equal(JSON.stringify({ row, financial, prepared, providerConfig }), before);
  assert.equal(row.paymentStatus, 'unpaid');
});

test('the same input produces the same result', () => {
  const input = {
    booking: booking(),
    financial: projection(),
    issuance: issuance(),
  };
  assert.deepEqual(
    evaluateSquarePaymentLinkPreflight(input),
    evaluateSquarePaymentLinkPreflight(input),
  );
});

test('the preflight does not use a database, the network, Square, or Stripe', () => {
  const source = fs.readFileSync(path.join(root, 'netlify/lib/square-payment-link-preflight.js'), 'utf8');
  assert.doesNotMatch(source, /squareup|square-persistence|api\.stripe\.com|require\s*\(\s*['"]pg['"]|@netlify\/blobs|getPrisma|getSharedFinancialProjection|prepareSquarePaymentLink|commitBooking|fetch\s*\(/);
  assert.match(source, /authority: "postgres"/);
  assert.match(source, /does not prove/);
  assert.equal(ACTIVE_PAYMENT_PROVIDER, 'none');
  const callers = [
    'netlify/functions/submit-booking.js',
    'netlify/functions/admin-ops-jobs.js',
    'netlify/functions/create-payment-link.js',
    'netlify/functions/create-payment.js',
    'netlify/lib/db/payment-authority-service.js',
  ];
  callers.forEach((relative) => {
    const text = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.equal(text.includes('evaluateSquarePaymentLinkPreflight'), false, relative);
  });
});
