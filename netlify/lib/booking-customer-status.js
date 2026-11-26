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

function remainingCentsOf(booking) {
  if (!booking) return null;
  if (booking.remainingCents != null && booking.remainingCents !== '') {
    const n = Number(booking.remainingCents);
    return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
  }
  if (booking.ledger && (booking.ledger.approvedCents != null || booking.ledger.settledCents != null)) {
    const approved = Math.max(0, Math.round(Number(booking.ledger.approvedCents) || 0));
    const settled = Math.max(0, Math.round(Number(booking.ledger.settledCents) || 0));
    const credited = Math.max(0, Math.round(Number(booking.ledger.creditedCents) || 0));
    return Math.max(0, approved - settled - credited);
  }
  if (booking.amountDueApproved != null && booking.amountDueApproved !== '') {
    return Math.max(0, Math.round(Number(booking.amountDueApproved) * 100));
  }
  if (booking.balanceDue != null && booking.balanceDue !== '') {
    return Math.max(0, Math.round(Number(booking.balanceDue) * 100));
  }
  return null;
}

function settledCentsOf(booking) {
  if (!booking) return 0;
  if (booking.settledCents != null && booking.settledCents !== '') {
    return Math.max(0, Math.round(Number(booking.settledCents) || 0));
  }
  if (booking.ledger && booking.ledger.settledCents != null) {
    return Math.max(0, Math.round(Number(booking.ledger.settledCents) || 0));
  }
  return Math.max(0, Math.round(Number(booking.amountPaid || booking.paidAmount || 0) * 100));
}

function servicePhaseLabel(booking) {
  const js = String(booking?.jobStatus || '').toLowerCase();
  const appt = String(booking?.appointmentStatus || '').toLowerCase();
  const status = String(booking?.status || '').toLowerCase();
  if (
    js === 'cancelled' || appt === 'canceled' || appt === 'cancelled'
    || status === 'cancelled' || status === 'canceled'
  ) return 'Cancelled';
  if (
    js === 'in_progress' || js === 'arrived' || js === 'on_site'
    || js === 'en_route' || js === 'paused'
  ) return 'In progress';
  if (
    js === 'completed' || js === 'completed_paid' || js === 'closed'
    || js === 'completed_pending_payment' || js === 'completed_pending_admin_review'
    || status === 'completed' || booking?.completedAt
  ) return 'Completed';
  if (appt === 'confirmed' || js === 'confirmed' || status === 'confirmed') return 'Confirmed';
  return 'Pending';
}

function customerPaymentLabel(booking) {
  const raw = String(booking?.paymentStatus || '').toLowerCase();
  const pwf = String(booking?.paymentWorkflowStatus || '').toLowerCase();
  const remaining = remainingCentsOf(booking);
  const settled = settledCentsOf(booking);
  if (raw === 'refunded' || raw === 'partially_refunded' || pwf === 'refunded') {
    return remaining > 0 ? 'Partially refunded' : 'Refunded';
  }
  if (raw === 'failed' || pwf === 'payment_failed') return 'Payment failed';
  if (remaining > 0 && settled > 0) return 'Partially paid';
  if (remaining > 0) return 'Unpaid';
  if (
    settled > 0
    || isInvoicePaid(booking)
    || raw === 'paid' || raw === 'paid_cash' || raw === 'paid_card_on_site' || raw === 'paid_online'
    || pwf === 'cash_paid' || pwf === 'payment_succeeded'
  ) return 'Paid';
  return 'No payment due yet';
}

function customerStatusSummary(booking) {
  const service = servicePhaseLabel(booking);
  const pay = customerPaymentLabel(booking);
  if (service === 'Cancelled' && pay === 'Refunded') return 'Cancelled — Refunded';
  if (service === 'Cancelled') return 'Cancelled';
  if (service === 'Completed' && pay === 'Paid') return 'Completed — Paid';
  if (service === 'Completed' && (pay === 'Unpaid' || pay === 'Partially paid')) return 'Completed — Balance due';
  if (service === 'Confirmed' && (pay === 'Unpaid' || pay === 'No payment due yet')) return 'Confirmed — Payment pending';
  if (service === 'In progress' && pay === 'Partially paid') return 'In progress — Partially paid';
  if (service === 'In progress' && pay === 'Paid') return 'In progress — Paid';
  if (service === 'Pending' && pay === 'Unpaid') return 'Pending — Payment pending';
  return `${service} — ${pay}`;
}

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

  const remaining = remainingCentsOf(booking);
  const settled = settledCentsOf(booking);
  const owed = remaining == null || remaining > 0;
  if (!owed && settled > 0) {
    if (js === 'completed' || js === 'completed_paid' || status === 'completed' || booking?.completedAt) {
      return 'completed';
    }
    return 'paid';
  }

  if (
    owed
    && (
      paymentNeedsAttention(booking)
      || classifyStatus(booking) === 'payment_due'
    )
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
  customerPaymentLabel,
  customerStatusSummary,
  servicePhaseLabel,
  remainingCentsOf,
  settledCentsOf,
  isActionRequiredState,
  actionRequiredStateKey,
};
