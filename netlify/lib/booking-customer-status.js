// Authoritative customer-facing appointment status labels for the portal.
'use strict';

const { classifyStatus, isInvoicePaid } = require('./appointment-status-policy');

const STATUS_LABELS = {
  pending_review: 'Pending Review',
  confirmed: 'Confirmed',
  needs_attention: 'Needs Your Attention',
  payment_due: 'Payment Due',
  paid: 'Paid',
  rescheduled: 'Rescheduled',
  cancelled: 'Cancelled',
  completed: 'Completed',
};

function paymentNeedsAttention(booking) {
  const pwf = String(booking?.paymentWorkflowStatus || '').toLowerCase();
  return pwf === 'awaiting_customer_payment'
    || pwf === 'payment_action_required'
    || pwf === 'awaiting_customer_action';
}

function customerFacingStatusKey(booking) {
  const js = String(booking?.jobStatus || '').toLowerCase();
  const appt = String(booking?.appointmentStatus || '').toLowerCase();
  const status = String(booking?.status || '').toLowerCase();

  if (
    js === 'cancelled'
    || appt === 'canceled'
    || appt === 'cancelled'
    || status === 'cancelled'
    || status === 'canceled'
    || booking?.cancellationRequestStatus === 'approved'
  ) {
    return 'cancelled';
  }

  if (js === 'completed_paid' || js === 'completed' || status === 'completed') {
    return 'completed';
  }

  if (booking?.rescheduledByClient || booking?.rescheduleRequestedDate) {
    // Still show rescheduled when admin has not re-confirmed a new window.
    if (appt !== 'confirmed' && js !== 'confirmed') return 'rescheduled';
  }

  if (isInvoicePaid(booking) || status === 'paid') return 'paid';

  if (
    paymentNeedsAttention(booking)
    || classifyStatus(booking) === 'payment_due'
  ) {
    return 'payment_due';
  }

  if (
    booking?.customerApprovalStatus === 'pending'
    || js === 'completed_pending_payment'
    || js === 'awaiting_customer_action'
    || booking?.serviceStatus === 'awaiting_customer_action'
  ) {
    return 'needs_attention';
  }

  if (appt === 'confirmed' || js === 'confirmed' || status === 'confirmed') {
    return 'confirmed';
  }

  // Explicit: pending_review / Pending Review must never read as Confirmed.
  return 'pending_review';
}

function customerFacingStatusLabel(booking) {
  const key = customerFacingStatusKey(booking);
  return STATUS_LABELS[key] || STATUS_LABELS.pending_review;
}

function isActionRequiredState(booking) {
  const key = customerFacingStatusKey(booking);
  return key === 'needs_attention' || key === 'payment_due';
}

function actionRequiredStateKey(booking) {
  const key = customerFacingStatusKey(booking);
  if (key === 'payment_due') {
    const remaining = Math.max(
      0,
      Math.round(Number(booking?.remainingCents != null
        ? booking.remainingCents
        : (Number(booking?.amountDueApproved || 0) * 100)))
    );
    return `payment_due:${remaining}`;
  }
  if (key === 'needs_attention') {
    const reason = String(
      booking?.customerApprovalStatus
      || booking?.jobStatus
      || booking?.serviceStatus
      || 'action'
    ).toLowerCase();
    const version = booking?.bookingVersion || booking?.quoteVersion || 0;
    return `needs_attention:${reason}:v${version}`;
  }
  return null;
}

module.exports = {
  STATUS_LABELS,
  customerFacingStatusKey,
  customerFacingStatusLabel,
  isActionRequiredState,
  actionRequiredStateKey,
};
