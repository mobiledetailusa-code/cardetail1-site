'use strict';

/**
 * Blob-only history may list an appointment. It is not a financial authority.
 * Reads must not seed Postgres, invent paid, or open a payment CTA.
 */

function isBlobOnlyFinancialSource(booking) {
  return !!(booking && booking.sourceAuthority === 'blob');
}

function applyBlobOnlyFinancialLock(booking) {
  if (!booking || typeof booking !== 'object') return booking;
  const next = { ...booking };
  next.paymentStatus = 'unverified';
  next.paymentWorkflowStatus = 'manual_review';
  next.amountPaid = 0;
  next.paidAmount = 0;
  next.settledCents = 0;
  next.amountDueApproved = 0;
  next.balanceDue = 0;
  next.payLink = '';
  next.payLinkAmount = null;
  if (next.ledger && typeof next.ledger === 'object') {
    next.ledger = { ...next.ledger, settledCents: 0 };
  }
  return next;
}

function blobOnlyPortalPaymentState(booking) {
  return {
    state: 'unverified',
    amountDueApproved: 0,
    approvedTotal: 0,
    amountPaid: 0,
    remainingCents: 0,
    approvedCents: 0,
    settledCents: 0,
    refundedCents: 0,
    pendingRefundCents: 0,
    refundRequestStatus: null,
    paymentStatus: 'unverified',
    paymentWorkflowStatus: 'manual_review',
    paymentAttemptStatus: null,
    stripeReference: null,
    paidAt: null,
    bookingVersion: (booking && booking.bookingVersion) || 0,
    quoteVersion: (booking && booking.quoteVersion) || 0,
    payLink: '',
    payLinkAmount: null,
    canPay: false, // blob-only-lock
    canCreatePayLink: false,
    canGeneratePayLink: false, // blob-only-lock
    embeddedPayAvailable: false,
    paymentAuthorityDegraded: false,
    authority: 'none',
    stripeCheckoutSessionIdPrefix: null,
    paymentIntentIdPrefix: null,
  };
}

function blobOnlyPaymentRefusal() {
  return {
    ok: false,
    error: 'financial_unverified',
    statusCode: 409,
    charged: false,
    stripeCalled: false,
    message: 'This appointment has no authoritative Postgres financial record.',
  };
}

function lockProjectedBlobOnlyRow(row) {
  if (!row || typeof row !== 'object') return row;
  return {
    ...row,
    paymentStatus: 'unverified',
    paymentWorkflowStatus: 'manual_review',
    amountPaid: 0,
    settledCents: 0,
    remainingCents: 0,
    amountDueApproved: 0,
    balanceDue: 0,
    payLink: '',
    payLinkAmount: null,
  };
}

module.exports = {
  isBlobOnlyFinancialSource,
  applyBlobOnlyFinancialLock,
  blobOnlyPortalPaymentState,
  blobOnlyPaymentRefusal,
  lockProjectedBlobOnlyRow,
};
