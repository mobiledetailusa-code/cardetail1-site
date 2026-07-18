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
    in_progress: new Set(['reschedule', 'cancel', 'package_change', 'addon', 'address', 'vehicle_add', 'vehicle_replace', 'maintenance']),
    cancelled: new Set(['reschedule', 'cancel', 'package_change', 'addon', 'address', 'vehicle_add', 'vehicle_replace', 'maintenance']),
    // Paid invoice (Jobber): allow address / reschedule / cancel message; block money/catalog mutations.
    paid: new Set(['package_change', 'addon', 'vehicle_add', 'vehicle_replace', 'maintenance']),
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
  // Structural / schedule changes always need admin review (including after invoice paid).
  if (
    (phase === 'confirmed' || phase === 'draft' || phase === 'paid' || phase === 'payment_due') &&
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
