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

function computeFinancialProjection({
  booking,
  quote,
  paymentAttempts = [],
  ledgerEntries = [],
  refundRequests = [],
}) {
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
  const pendingRefunds = refundRequests.filter((request) => (
    ['creating', 'pending_webhook', 'requires_action'].includes(request.status)
  ));
  const pendingRefundCents = pendingRefunds
    .reduce((sum, request) => sum + Math.max(0, Math.round(Number(request.amountCents) || 0)), 0);
  const latestRefundRequest = refundRequests[refundRequests.length - 1] || null;

  const netSettledCents = Math.max(0, settledCents + adjustmentCents - refundedCents);
  const remainingCents = Math.max(0, approvedCents - netSettledCents);
  const outstandingCreditCents = Math.max(0, netSettledCents - approvedCents);

  const activeAttempt = [...paymentAttempts].reverse()
    .find((a) => ACTIVE_ATTEMPT_STATUSES.has(a.status));
  const lastSucceeded = [...paymentAttempts].reverse().find((a) => a.status === 'succeeded');

  let paymentStatus;
  if (refundedCents >= settledCents && refundedCents > 0) {
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
    // Actual money received before refunds. Quote/ledger adjustments may affect
    // the obligation, but they are never customer funds and must not inflate a
    // receipt's "amount paid" or the amount Stripe can refund.
    grossSettledCents: settledCents,
    settledCents: netSettledCents,
    refundedCents,
    pendingRefundCents,
    refundRequestStatus: latestRefundRequest?.status || null,
    remainingCents,
    outstandingCreditCents,
    paymentStatus,
    paymentAttemptStatus: activeAttempt?.status || lastSucceeded?.status || null,
    paymentAttemptUpdatedAt: activeAttempt?.updatedAt || lastSucceeded?.updatedAt || null,
    stripeReference: activeAttempt?.providerObjectId || lastSucceeded?.providerObjectId || null,
    paidAt: paymentStatus === 'paid' ? (lastSettlement?.recordedAt || null) : null,
    refundableCents: Math.max(0, settledCents - refundedCents),
  };
}

module.exports = { computeFinancialProjection, ACTIVE_ATTEMPT_STATUSES };
