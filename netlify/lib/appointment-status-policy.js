// Server-authoritative appointment lifecycle rules for customer mutations.

// Field-active technician statuses block structural online changes (PDA-11).
const ONLINE_BLOCKED = new Set([
  'in progress', 'in_progress', 'in-progress', 'started', 'on site', 'on-site',
  'en_route', 'en route', 'arrived', 'paused', 'issue_reported',
]);

const PENDING_APPROVAL = new Set(['confirmed', 'scheduled', 'appointment confirmed', 'assigned', 'accepted', 'reopened']);

const PAYMENT_ALLOWED = new Set([
  'completed', 'payment due', 'payment_due', 'awaiting payment', 'awaiting_payment',
  'completed_pending_payment', 'completed_pending_admin_review',
]);

const PAID = new Set(['paid', 'closed', 'complete', 'completed_paid']);

const CANCELLED = new Set(['cancelled', 'canceled', 'cancellation requested']);

const DRAFT_LIKE = new Set(['draft', 'under review', 'pending review', 'pending', 'new', 'submitted', 'pending_review']);

/**
 * Derive a single lifecycle label for policy checks.
 * Active technician jobStatus overrides a stale appointmentStatus (PDA-11).
 */
function normalizeStatus(booking) {
  const job = String(booking?.jobStatus || '').trim().toLowerCase();
  const appt = String(booking?.appointmentStatus || '').trim().toLowerCase();
  const status = String(booking?.status || '').trim().toLowerCase();

  if (ONLINE_BLOCKED.has(job)) return job;
  if (CANCELLED.has(job)) return job;
  if (PAID.has(job)) return job === 'completed_paid' ? 'paid' : job;
  if (PAYMENT_ALLOWED.has(job)) {
    if (job === 'completed_pending_admin_review') return 'completed';
    if (job === 'completed_pending_payment') return 'payment_due';
    return job;
  }

  // Non-active field work: appointment / legacy status may still describe the phase.
  return String(appt || status || job || '').trim().toLowerCase();
}

function isInvoicePaid(booking) {
  const pwf = String(booking?.paymentWorkflowStatus || '').toLowerCase();
  if (pwf === 'payment_succeeded' || pwf === 'cash_paid' || pwf === 'paid') return true;
  if (String(booking?.paymentStatus || '').toLowerCase() === 'paid') return true;
  if (booking?._historicalPaidClosed) return true;
  const js = String(booking?.jobStatus || '').toLowerCase();
  if (js === 'completed_paid') return true;
  if (booking?.ledger && (booking.ledger.approvedCents != null || booking.ledger.settledCents != null)) {
    const approved = Math.max(0, Math.round(Number(booking.ledger.approvedCents) || 0));
    const settled = Math.max(0, Math.round(Number(booking.ledger.settledCents) || 0));
    const credited = Math.max(0, Math.round(Number(booking.ledger.creditedCents) || 0));
    const remaining = Math.max(0, approved - settled - credited);
    if (settled > 0 && remaining === 0) return true;
  }
  return false;
}

function classifyStatus(booking) {
  const s = normalizeStatus(booking);
  if (CANCELLED.has(s) || booking?.cancellationRequestStatus === 'approved') return 'cancelled';
  // Jobber/HCP: paid invoice closes money mutations regardless of appointment label.
  if (PAID.has(s) || isInvoicePaid(booking)) return 'paid';
  if (PAYMENT_ALLOWED.has(s) || booking?.paymentWorkflowStatus === 'due') return 'payment_due';
  if (ONLINE_BLOCKED.has(s)) return 'in_progress';
  if (PENDING_APPROVAL.has(s)) return 'confirmed';
  if (DRAFT_LIKE.has(s)) return 'draft';
  return 'draft';
}

function canRequestChange(booking, action) {
  const phase = classifyStatus(booking);
  const blocked = {
    in_progress: new Set(['reschedule', 'cancel', 'package_change', 'addon', 'address', 'vehicle_add', 'vehicle_replace', 'vehicle_remove', 'maintenance']),
    cancelled: new Set(['reschedule', 'cancel', 'package_change', 'addon', 'address', 'vehicle_add', 'vehicle_replace', 'vehicle_remove', 'maintenance']),
    // Paid catalog/vehicle changes remain requestable, but are Admin-gated below.
    // The approved change becomes a new immutable quote: increase => delta due;
    // decrease => explicit credit/refund due through the PR2 authority.
    paid: new Set(['maintenance']),
  };
  if (blocked[phase] && blocked[phase].has(action)) {
    return {
      ok: false,
      error: phase === 'paid' ? 'invoice_paid' : 'action_not_allowed',
      phase,
      requiresCall: phase === 'in_progress',
      message: phase === 'paid'
        ? 'Invoice is paid. Request a quote adjustment with Cardetail1 — pack/add-on/vehicle price changes are closed.'
        : undefined,
    };
  }
  // Ops policy: pack / add-on / address / cancel / vehicle add|replace auto-apply.
  // Reschedule, maintenance, and vehicle removal stay admin-gated (pending review).
  const needsAdminReview = new Set(['reschedule', 'maintenance', 'vehicle_remove']);
  const paidCatalogChange = phase === 'paid'
    && new Set(['package_change', 'addon', 'vehicle_add', 'vehicle_replace']).has(action);
  if (
    (phase === 'confirmed' || phase === 'draft' || phase === 'paid' || phase === 'payment_due')
    && (needsAdminReview.has(action) || paidCatalogChange)
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
  if (booking?._historicalPaidClosed) {
    return { ok: false, error: 'payment_not_due', due: 0 };
  }
  const status = String(booking?.status || '').toLowerCase();
  const js = String(booking?.jobStatus || '').toLowerCase();
  if (status === 'paid' || status === 'closed' || js === 'completed_paid' || phase === 'paid') {
    return { ok: false, error: 'payment_not_due', due: 0 };
  }

  // Prefer ledger-derived remaining; never trust stale amountDueApproved / balanceDue alone.
  let due = 0;
  if (booking?.ledger && (booking.ledger.approvedCents != null || booking.ledger.settledCents != null)) {
    const approved = Math.max(0, Math.round(Number(booking.ledger.approvedCents) || 0));
    const settled = Math.max(0, Math.round(Number(booking.ledger.settledCents) || 0));
    const credited = Math.max(0, Math.round(Number(booking.ledger.creditedCents) || 0));
    due = Math.max(0, approved - settled - credited) / 100;
  } else {
    const paid = Number(booking?.amountPaid || booking?.paidAmount || 0);
    const approved = Number(
      booking?.approvedFinalAmount != null
        ? booking.approvedFinalAmount
        : (booking?.totalPrice || booking?.finalAmount || 0)
    );
    due = Math.max(0, approved - paid);
  }

  // Stale payLink must never keep Pay Balance open after ledger remaining is 0.
  if (!(due > 0)) {
    return { ok: false, error: 'payment_not_due', due: 0 };
  }
  return { ok: true, phase, due };
}

module.exports = {
  normalizeStatus,
  classifyStatus,
  isInvoicePaid,
  canRequestChange,
  canPayBalance,
};
