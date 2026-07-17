// Server-authoritative appointment lifecycle rules for customer mutations.

const ONLINE_BLOCKED = new Set(['in progress', 'in_progress', 'in-progress', 'started', 'on site', 'on-site']);

const PENDING_APPROVAL = new Set(['confirmed', 'scheduled', 'appointment confirmed']);

const PAYMENT_ALLOWED = new Set(['completed', 'payment due', 'payment_due', 'awaiting payment', 'awaiting_payment']);

const PAID = new Set(['paid', 'closed', 'complete']);

const CANCELLED = new Set(['cancelled', 'canceled', 'cancellation requested']);

const DRAFT_LIKE = new Set(['draft', 'under review', 'pending review', 'pending', 'new', 'submitted']);

function normalizeStatus(booking) {
  const raw = String(
    booking?.appointmentStatus || booking?.status || booking?.jobStatus || ''
  ).trim().toLowerCase();
  return raw;
}

function classifyStatus(booking) {
  const s = normalizeStatus(booking);
  if (CANCELLED.has(s) || booking?.cancellationRequestStatus === 'approved') return 'cancelled';
  if (PAID.has(s) || booking?.paymentWorkflowStatus === 'paid') return 'paid';
  if (PAYMENT_ALLOWED.has(s) || booking?.paymentWorkflowStatus === 'due') return 'payment_due';
  if (ONLINE_BLOCKED.has(s)) return 'in_progress';
  if (PENDING_APPROVAL.has(s)) return 'confirmed';
  if (DRAFT_LIKE.has(s)) return 'draft';
  return 'draft';
}

function canRequestChange(booking, action) {
  const phase = classifyStatus(booking);
  const blocked = {
    in_progress: new Set(['reschedule', 'cancel', 'package_change', 'addon', 'address', 'vehicle_add', 'vehicle_replace']),
    cancelled: new Set(['reschedule', 'cancel', 'package_change', 'addon', 'address', 'vehicle_add', 'vehicle_replace']),
    paid: new Set(['cancel', 'package_change', 'addon', 'address', 'vehicle_replace']),
  };
  if (blocked[phase] && blocked[phase].has(action)) {
    return { ok: false, error: 'action_not_allowed', phase, requiresCall: phase === 'in_progress' };
  }
  // Pending Review / draft-like and confirmed appointments always need admin review for structural changes.
  if (
    (phase === 'confirmed' || phase === 'draft') &&
    ['package_change', 'addon', 'address', 'vehicle_add', 'vehicle_replace', 'reschedule', 'maintenance'].includes(action)
  ) {
    return { ok: true, pendingApproval: true, phase };
  }
  return { ok: true, pendingApproval: false, phase };
}

function canPayBalance(booking) {
  const phase = classifyStatus(booking);
  if (phase === 'cancelled' || phase === 'in_progress') {
    return { ok: false, error: 'action_not_allowed' };
  }
  const paid = Number(booking?.amountPaid || booking?.paidAmount || 0);
  const approved = Number(
    booking?.approvedFinalAmount != null
      ? booking.approvedFinalAmount
      : (booking?.totalPrice || booking?.finalAmount || 0)
  );
  const due = Number(
    booking?.amountDueApproved != null
      ? booking.amountDueApproved
      : (booking?.balanceDue != null ? booking.balanceDue : Math.max(0, approved - paid))
  );
  // Prepaid / balance pay allowed from Pending Review onward whenever a balance exists or admin issued a link.
  if (!(due > 0) && !booking?.payLink) {
    return { ok: false, error: 'payment_not_due', due: 0 };
  }
  return { ok: true, phase, due: due > 0 ? due : Number(booking?.amountDueApproved || approved || 0) };
}

module.exports = {
  normalizeStatus,
  classifyStatus,
  canRequestChange,
  canPayBalance,
};
