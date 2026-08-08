'use strict';

/**
 * P0 — customer card payment from My Garage.
 *
 * The portal advertises Pay Balance from its own money projection, but the
 * PaymentIntent endpoint validates the request against the Postgres payment
 * authority. These tests pin the contract between the two so the portal can
 * never offer a quote the payment endpoint is guaranteed to reject.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const portal = require('../netlify/functions/customer-portal-data');
const { financialProjection } = require('../netlify/lib/payment-service');

const BOOKING = {
  id: 'CD1-PAY',
  bookingVersion: 4,
  schemaVersion: 1,
  // Blob mirror still says v1 while the Postgres quote lineage advanced to v2.
  quoteVersion: 1,
  status: 'Confirmed',
  jobStatus: 'completed_pending_payment',
  paymentWorkflowStatus: 'awaiting_customer_payment',
  customerApprovalStatus: 'approved',
  ledger: { approvedCents: 26000, settledCents: 0, creditedCents: 0, entries: [] },
  quote: { quoteVersion: 1, approvedCents: 26000, lineItems: [] },
  service: { vehicles: [{ vehicleId: 'v1', cat: 'cars', packageId: 'essential', addOnIds: [] }] },
};

const POSTGRES_PROJECTION = {
  bookingId: 'CD1-PAY',
  quoteVersion: 2,
  approvedCents: 26000,
  settledCents: 0,
  refundedCents: 0,
  remainingCents: 26000,
  paymentStatus: 'due',
  paymentAttemptStatus: null,
  stripeReference: null,
  paidAt: null,
  authority: 'postgres',
};

describe('P0 — payment authority contract', () => {
  it('root cause: the Blob financial projection carries no quoteVersion', () => {
    const money = financialProjection(BOOKING);
    assert.equal(Object.prototype.hasOwnProperty.call(money, 'quoteVersion'), false);
    assert.equal(money.remainingCents, 26000);
  });

  it('a healthy Postgres projection publishes the authoritative quoteVersion', () => {
    const state = portal.__test.safePaymentStateFromProjection(BOOKING, POSTGRES_PROJECTION, 'postgres');
    assert.equal(state.authority, 'postgres');
    assert.equal(state.quoteVersion, 2, 'must be the Postgres quote lineage, not the Blob mirror');
    assert.equal(state.canPay, true);
    assert.equal(state.embeddedPayAvailable, true);
    assert.equal(state.paymentAuthorityDegraded, false);
  });

  it('a degraded read does not offer the Blob mirror version as payable', () => {
    const degraded = portal.__test.safePaymentState(BOOKING, { degraded: true });
    // Blob v1 would be rejected by the endpoint's v2 authority check forever.
    assert.equal(degraded.canPay, false, 'must not advertise an unauthorizable quote');
    assert.equal(degraded.canCreatePayLink, false);
    assert.equal(degraded.embeddedPayAvailable, false);
    assert.equal(degraded.paymentAuthorityDegraded, true);
    // The balance itself is still reported truthfully.
    assert.equal(degraded.remainingCents, 26000);
    assert.equal(degraded.amountDueApproved, 260);
  });

  it('Postgres-disabled deployments keep the Blob path payable', () => {
    const blob = portal.__test.safePaymentState(BOOKING);
    assert.equal(blob.canPay, true);
    assert.equal(blob.authority, 'blob');
    assert.equal(blob.paymentAuthorityDegraded, false);
  });

  it('a paid booking is never payable on any authority', () => {
    const paid = { ...POSTGRES_PROJECTION, paymentStatus: 'paid', settledCents: 26000, remainingCents: 0 };
    const state = portal.__test.safePaymentStateFromProjection(BOOKING, paid, 'postgres');
    assert.equal(state.canPay, false);
    assert.equal(state.embeddedPayAvailable, false);
    assert.equal(state.payLink, '');
  });

  it('remaining balance is derived from the ledger projection, never the client', () => {
    const partial = { ...POSTGRES_PROJECTION, settledCents: 10000, remainingCents: 16000 };
    const state = portal.__test.safePaymentStateFromProjection(BOOKING, partial, 'postgres');
    assert.equal(state.remainingCents, 16000);
    assert.equal(state.amountPaid, 100);
    assert.equal(state.approvedCents - state.settledCents, state.remainingCents);
  });
});

describe('P0 — payment-intent conflict responses are actionable', () => {
  const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/customer-balance-payment-intent.js'), 'utf8');

  it('every 409 carries a customer-readable message', () => {
    const conflicts = src.split('json(409, {').slice(1);
    assert.equal(conflicts.length, 2, 'version_conflict + stale_quote_version');
    for (const block of conflicts) {
      assert.match(block.slice(0, 600), /message:/);
    }
  });

  it('the amount is never taken from the request body', () => {
    assert.doesNotMatch(src, /p\.amount|body\.amount|amountCents\s*=\s*Number\(p\./);
    assert.match(src, /amountCents: prepared\.amountCents/);
  });

  it('booking and quote versions are both required and compared', () => {
    assert.match(src, /expectedBookingVersion !== actualBookingVersion/);
    assert.match(src, /expectedQuoteVersion !== projection\.quoteVersion/);
  });
});

describe('P0 — duplicate-payment protections are intact', () => {
  const authority = fs.readFileSync(path.join(ROOT, 'netlify/lib/db/payment-authority-service.js'), 'utf8');
  const webhook = fs.readFileSync(path.join(ROOT, 'netlify/functions/stripe-webhook.js'), 'utf8');
  const garageJs = fs.readFileSync(path.join(ROOT, 'assets/my-garage.js'), 'utf8');

  it('PaymentIntent creation is serialized by a transaction-scoped advisory lock', () => {
    assert.match(authority, /pg_advisory_xact_lock/);
    assert.match(authority, /'Idempotency-Key': idempotencyKey/);
  });

  it('a settlement ledger entry is keyed by a unique provider event id', () => {
    assert.match(authority, /const providerEventId = `settlement_\$\{paymentIntent\.id\}`/);
    assert.match(authority, /tx\.ledgerEntry\.findUnique\(\{ where: \{ providerEventId \} \}\)/);
  });

  it('customer_balance PaymentIntents are reconciled only through Postgres', () => {
    assert.match(webhook, /if \(paymentRoute\.route === 'customer_balance'\)/);
    // Legacy Checkout can never become a second ledger writer for a balance.
    assert.match(webhook, /reason: 'legacy_checkout_isolated'/);
  });

  it('the client blocks a second Pay Balance while one is starting', () => {
    assert.match(garageJs, /if \(embeddedPay\.starting\) return;/);
    assert.match(garageJs, /el\.disabled = busy;/);
  });

  it('the portal states the degraded balance instead of claiming none is due', () => {
    assert.match(garageJs, /pay\.paymentAuthorityDegraded/);
    assert.match(garageJs, /data-pay-degraded/);
  });
});
