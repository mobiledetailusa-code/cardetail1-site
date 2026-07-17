/**
 * Keep customer-visible totals and Stripe pay links in sync after money changes.
 */

function roundMoney(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function paidAmount(booking) {
  return roundMoney(booking?.amountPaid || booking?.paidAmount || 0);
}

function approvedAmount(booking) {
  if (booking?.approvedFinalAmount != null) return roundMoney(booking.approvedFinalAmount);
  return roundMoney(booking?.totalPrice || booking?.finalAmount || 0);
}

/**
 * Apply a new approved total and invalidate any stale Stripe Checkout link.
 * Due = max(0, approved − paid).
 */
function applyApprovedMoney(booking, proposedTotal, extras = {}) {
  const approved = roundMoney(proposedTotal);
  const paid = paidAmount(booking);
  const due = Math.max(0, roundMoney(approved - paid));
  return {
    totalPrice: approved,
    approvedFinalAmount: approved,
    amountDueApproved: due,
    balanceDue: due,
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

function computeDue(booking) {
  const paid = paidAmount(booking);
  const approved = approvedAmount(booking);
  if (booking?.amountDueApproved != null) return Math.max(0, roundMoney(booking.amountDueApproved));
  if (booking?.balanceDue != null) return Math.max(0, roundMoney(booking.balanceDue));
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
  if (booking?.payLink && booking?.payLinkAmount != null && Math.abs(roundMoney(booking.payLinkAmount) - due) > 0.009) {
    conflicts.push({
      code: 'stale_pay_link_amount',
      payLinkAmount: roundMoney(booking.payLinkAmount),
      due,
    });
  }
  if (booking?.payLink && (booking.payLinkAmount == null || booking.payLinkAmount === '')) {
    conflicts.push({ code: 'pay_link_without_amount', due });
  }
  return {
    ok: conflicts.length === 0,
    approved,
    due,
    paid,
    conflicts,
  };
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
