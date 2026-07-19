/**
 * Keep customer-visible totals and Stripe pay links in sync after money changes.
 * Remaining due is derived from ledger inputs — stored due is never authoritative.
 */

const { dollarsToCents, centsToDollars } = require('./historical-adapter');
const { remainingCents: ledgerRemaining } = require('./booking-aggregate');

function roundMoney(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function paidAmount(booking) {
  if (booking?.ledger && booking.ledger.settledCents != null) {
    return centsToDollars(booking.ledger.settledCents);
  }
  return roundMoney(booking?.amountPaid || booking?.paidAmount || 0);
}

function approvedAmount(booking) {
  if (booking?.ledger && booking.ledger.approvedCents != null) {
    return centsToDollars(booking.ledger.approvedCents);
  }
  if (booking?.approvedFinalAmount != null) return roundMoney(booking.approvedFinalAmount);
  return roundMoney(booking?.totalPrice || booking?.finalAmount || 0);
}

/**
 * Apply a new approved total and invalidate any stale Stripe Checkout link.
 * Due = max(0, approved − paid). Also writes ledger cents when possible.
 */
function applyApprovedMoney(booking, proposedTotal, extras = {}) {
  const approved = roundMoney(proposedTotal);
  const paid = paidAmount(booking);
  const due = Math.max(0, roundMoney(approved - paid));
  const approvedCents = dollarsToCents(approved);
  const settledCents = dollarsToCents(paid);
  return {
    totalPrice: approved,
    approvedFinalAmount: approved,
    amountDueApproved: due,
    balanceDue: due,
    ledger: {
      currency: 'usd',
      approvedCents,
      settledCents,
      creditedCents: Number(booking?.ledger?.creditedCents) || 0,
      pendingCents: 0,
      entries: Array.isArray(booking?.ledger?.entries) ? booking.ledger.entries : [],
      lastReconciledAt: booking?.ledger?.lastReconciledAt || null,
    },
    // Invalidate checkout so customer/admin never open a stale Stripe amount.
    payLink: '',
    stripeCheckoutSessionId: '',
    payLinkAmount: null,
    payLinkInvalidatedAt: new Date().toISOString(),
    proposedTotal: approved,
    ...extras,
  };
}

/**
 * Sync money fields when minting a new Stripe Checkout session.
 */
function applyPayLinkMoney(booking, dueAmount, payLink, sessionId) {
  const due = roundMoney(dueAmount);
  const approved = Math.max(approvedAmount(booking), roundMoney(due + paidAmount(booking)));
  return {
    approvedFinalAmount: approved,
    totalPrice: approved,
    amountDueApproved: due,
    balanceDue: due,
    payLink: payLink || '',
    stripeCheckoutSessionId: sessionId || '',
    payLinkAmount: due,
    paymentWorkflowStatus: 'awaiting_customer_payment',
  };
}

function canReusePayLink(booking, due) {
  const link = booking?.payLink;
  if (!link) return false;
  const linkedAmount = booking?.payLinkAmount;
  if (linkedAmount == null || linkedAmount === '') return false;
  return Math.abs(roundMoney(linkedAmount) - roundMoney(due)) < 0.009;
}

/**
 * Derive due from approved − paid (ledger when present).
 * Never trust stale amountDueApproved / balanceDue ahead of the ledger.
 */
function computeDue(booking) {
  if (booking?._historicalPaidClosed) return 0;
  const status = String(booking?.status || '').toLowerCase();
  const js = String(booking?.jobStatus || '').toLowerCase();
  if (status === 'paid' || status === 'closed' || js === 'completed_paid') return 0;

  if (booking?.ledger && (booking.ledger.approvedCents != null || booking.ledger.settledCents != null)) {
    return centsToDollars(ledgerRemaining(booking.ledger));
  }
  const paid = paidAmount(booking);
  const approved = approvedAmount(booking);
  return Math.max(0, roundMoney(approved - paid));
}

/**
 * Detect portal/Stripe money conflicts for smoke tests and ops diagnostics.
 */
function detectMoneyConflict(booking) {
  const approved = approvedAmount(booking);
  const due = computeDue(booking);
  const paid = paidAmount(booking);
  const expectedDue = Math.max(0, roundMoney(approved - paid));
  const conflicts = [];
  if (Math.abs(due - expectedDue) > 0.009) {
    conflicts.push({
      code: 'due_mismatch_approved_minus_paid',
      approved,
      paid,
      amountDueApproved: due,
      expectedDue,
    });
  }
  // Stale stored due vs derived
  if (booking?.amountDueApproved != null
    && Math.abs(roundMoney(booking.amountDueApproved) - expectedDue) > 0.009
    && !booking?._historicalPaidClosed) {
    conflicts.push({
      code: 'stale_stored_due',
      storedDue: roundMoney(booking.amountDueApproved),
      expectedDue,
    });
  }
  if (booking?.payLink && booking?.payLinkAmount != null && Math.abs(roundMoney(booking.payLinkAmount) - due) > 0.009) {
    conflicts.push({
      code: 'stale_pay_link_amount',
      payLinkAmount: roundMoney(booking.payLinkAmount),
      due,
    });
  }
  if (booking?.payLink && (booking.payLinkAmount == null || booking.payLinkAmount === '')) {
    conflicts.push({ code: 'pay_link_missing_amount' });
  }
  return { ok: conflicts.length === 0, conflicts };
}

module.exports = {
  roundMoney,
  paidAmount,
  approvedAmount,
  applyApprovedMoney,
  applyPayLinkMoney,
  canReusePayLink,
  computeDue,
  detectMoneyConflict,
};
