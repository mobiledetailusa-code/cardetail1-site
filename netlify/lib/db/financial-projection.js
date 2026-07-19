/**
 * Phase 3 — authoritative financial projection over the Phase 2 relational
 * tables. Pure computation only (no I/O) so Admin, Customer, and the
 * reconciler can all derive the identical projection from the same rows.
 *
 * Not consumed by any live endpoint yet — see
 * docs/audit/phase1-delta-audit-2026-07-18.md. netlify/lib/payment-service.js
 * (Blob-based) remains the live authority for Release A.
 *
 * settledCents/refundedCents are summed across the WHOLE booking (every
 * quoteVersion, not just the current one) — money paid under an earlier
 * quote counts toward a later adjustment quote's obligation. This is what
 * makes "charge only the remaining delta" correct after a post-payment
 * adjustment: remainingCents = newApprovedCents - cumulativeSettledCents.
 */

const ACTIVE_ATTEMPT_STATUSES = new Set(['creating', 'open', 'requires_action']);

function computeFinancialProjection({ booking, quote, paymentAttempts = [], ledgerEntries = [] }) {
  const approvedCents = Math.max(0, Math.round(Number(quote?.approvedCents) || 0));

  const settledCents = ledgerEntries
    .filter((e) => e.kind === 'settlement')
    .reduce((sum, e) => sum + Math.max(0, Math.round(Number(e.amountCents) || 0)), 0);
  const adjustmentCents = ledgerEntries
    .filter((e) => e.kind === 'adjustment')
    .reduce((sum, e) => sum + Math.round(Number(e.amountCents) || 0), 0); // adjustments can be negative
  const refundedCents = ledgerEntries
    .filter((e) => e.kind === 'refund')
    .reduce((sum, e) => sum + Math.max(0, Math.round(Number(e.amountCents) || 0)), 0);

  const netSettledCents = Math.max(0, settledCents + adjustmentCents - refundedCents);
  const remainingCents = Math.max(0, approvedCents - netSettledCents);

  const activeAttempt = paymentAttempts.find((a) => ACTIVE_ATTEMPT_STATUSES.has(a.status));
  const lastSucceeded = [...paymentAttempts].reverse().find((a) => a.status === 'succeeded');

  let paymentStatus;
  if (approvedCents > 0 && refundedCents >= settledCents + adjustmentCents && refundedCents > 0) {
    paymentStatus = 'refunded';
  } else if (netSettledCents > 0 && remainingCents === 0) {
    paymentStatus = 'paid';
  } else if (activeAttempt) {
    paymentStatus = 'processing';
  } else if (remainingCents > 0) {
    paymentStatus = 'due';
  } else {
    paymentStatus = 'not_due';
  }

  const lastSettlement = [...ledgerEntries].reverse().find((e) => e.kind === 'settlement');

  return {
    bookingId: booking?.id || null,
    quoteVersion: quote?.quoteVersion ?? null,
    approvedCents,
    settledCents: netSettledCents,
    refundedCents,
    remainingCents,
    paymentStatus,
    paymentAttemptStatus: activeAttempt?.status || lastSucceeded?.status || null,
    stripeReference: activeAttempt?.providerObjectId || lastSucceeded?.providerObjectId || null,
    paidAt: paymentStatus === 'paid' ? (lastSettlement?.recordedAt || null) : null,
    refundableCents: paymentStatus === 'paid' ? netSettledCents : 0,
  };
}

module.exports = { computeFinancialProjection, ACTIVE_ATTEMPT_STATUSES };
