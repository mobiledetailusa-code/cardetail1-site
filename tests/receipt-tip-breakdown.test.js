'use strict';

/**
 * A technician tip rides on the customer's PaymentIntent but is deliberately
 * held outside the invoice: it is ledgered as kind:'fee' with providerEventId
 * tip_<pi>, so it never touches approvedCents, settledCents or remaining.
 *
 * That partition is correct for the ledger and wrong for the receipt. The
 * customer's card was charged balance + tip; a receipt that shows only the
 * balance understates what left their account.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { buildReceiptProjection } = require('../netlify/lib/receipt-projection');

const PI = 'pi_3KxQtipTest';

function booking(over = {}) {
  return {
    id: 'CD1-TIP-RCPT',
    bookingVersion: 4,
    quoteVersion: 1,
    schemaVersion: 1,
    status: 'Paid',
    jobStatus: 'completed_paid',
    paymentStatus: 'paid',
    paymentWorkflowStatus: 'payment_succeeded',
    completedAt: '2026-09-14T18:00:00.000Z',
    approvedFinalAmount: 400,
    amountPaid: 400,
    zipCode: '07102',
    ledger: { currency: 'usd', approvedCents: 40000, settledCents: 40000, creditedCents: 0, refundedCents: 0, entries: [] },
    service: { vehicles: [{ vehicleId: 'v1', cat: 'cars', packageId: 'maint', addOnIds: [] }] },
    ...over,
  };
}

/** Authoritative rows as the webhook writes them: balance settled, tip as fee. */
function ledgerWithTip(tipCents) {
  return [
    { kind: 'settlement', amountCents: 40000, quoteVersion: 1, providerObjectId: PI, providerEventId: `settlement_${PI}`, recordedAt: '2026-09-14T18:05:00.000Z' },
    { kind: 'fee', amountCents: tipCents, quoteVersion: 1, providerObjectId: PI, providerEventId: `tip_${PI}`, recordedAt: '2026-09-14T18:05:00.000Z' },
  ];
}

const financial = {
  approvedCents: 40000,
  grossSettledCents: 40000,
  settledCents: 40000,
  refundedCents: 0,
  remainingCents: 0,
  outstandingCreditCents: 0,
  pendingRefundCents: 0,
  paymentStatus: 'paid',
};

function receipt(opts = {}) {
  const r = buildReceiptProjection(booking(opts.bookingOver), 'payment', {
    financial,
    ledgerEntries: opts.ledgerEntries || [],
  });
  assert.equal(r.ok, true, r.error || 'receipt did not build');
  return r.receipt || r;
}

describe('receipt breaks out the technician tip', () => {
  it('shows the tip and what was actually charged', () => {
    const r = receipt({ ledgerEntries: ledgerWithTip(8000) });
    const s = r.financialSummary;
    assert.equal(s.technicianTip.cents, 8000);
    assert.equal(s.totalCharged.cents, 48000, 'balance + tip is what left the card');
  });

  it('keeps the tip out of the invoice figures', () => {
    const s = receipt({ ledgerEntries: ledgerWithTip(8000) }).financialSummary;
    assert.equal(s.approvedTotal.cents, 40000, 'a tip is not an approved service');
    assert.equal(s.amountPaid.cents, 40000, 'a tip does not settle the invoice');
    assert.equal(s.remainingBalance.cents, 0);
    assert.equal(s.creditDue.cents, 0, 'a tip must never read as an overpayment');
  });

  it('stays silent when there is no tip', () => {
    const s = receipt({
      ledgerEntries: [ledgerWithTip(0)[0]],
    }).financialSummary;
    assert.equal(s.technicianTip.cents, 0);
    assert.equal(s.totalCharged.cents, 40000);
  });

  it('only a tip_ fee counts — another fee kind is not relabelled as a tip', () => {
    const s = receipt({
      ledgerEntries: [
        ledgerWithTip(0)[0],
        { kind: 'fee', amountCents: 7500, quoteVersion: 1, providerObjectId: 'ch_x', providerEventId: 'policy_no_show_CD1', recordedAt: '2026-09-14T18:06:00.000Z' },
      ],
    }).financialSummary;
    assert.equal(s.technicianTip.cents, 0, 'a policy fee is not a tip');
  });

  it('falls back to the Blob mirror when no authoritative rows are supplied', () => {
    const s = receipt({ bookingOver: { technicianTipCents: 6000 } }).financialSummary;
    assert.equal(s.technicianTip.cents, 6000);
    assert.equal(s.totalCharged.cents, 46000);
  });

  it('the ledger wins over the mirror when both are present', () => {
    const s = receipt({
      ledgerEntries: ledgerWithTip(8000),
      bookingOver: { technicianTipCents: 999 },
    }).financialSummary;
    assert.equal(s.technicianTip.cents, 8000);
  });

  it('the renderer prints both lines, and only when there is a tip', () => {
    const js = fs.readFileSync(path.join(ROOT, 'assets/receipt.js'), 'utf8');
    assert.match(js, /fs\.technicianTip && fs\.technicianTip\.cents > 0/);
    assert.match(js, /Technician tip/);
    assert.match(js, /Total charged/);
  });
});
