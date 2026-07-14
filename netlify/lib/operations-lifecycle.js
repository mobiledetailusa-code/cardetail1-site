// Authoritative three-dimensional operational lifecycle (service, payment, customer approval).
const crypto = require('crypto');

const SERVICE_STATUSES = [
  'requested', 'under_review', 'confirmed', 'assigned', 'en_route', 'in_progress', 'paused',
  'service_completed', 'awaiting_customer_action', 'closed', 'cancelled', 'disputed',
];

const PAYMENT_STATUSES = [
  'not_due', 'pending', 'link_pending', 'link_sent', 'paid_online', 'paid_cash',
  'paid_card_on_site', 'failed', 'refunded', 'partially_refunded',
];

const CUSTOMER_APPROVAL_STATUSES = [
  'not_required', 'pending', 'approved', 'changes_requested', 'disputed',
];

const LEGACY_JOB_TO_SERVICE = {
  pending_review: 'under_review',
  confirmed: 'confirmed',
  assigned: 'assigned',
  accepted: 'assigned',
  en_route: 'en_route',
  arrived: 'in_progress',
  in_progress: 'in_progress',
  issue_reported: 'disputed',
  completed_pending_admin_review: 'service_completed',
  completed_pending_payment: 'awaiting_customer_action',
  completed_paid: 'closed',
  reopened: 'in_progress',
  cancelled: 'cancelled',
  archived_test: 'cancelled',
};

const SERVICE_TO_LEGACY_JOB = {
  requested: 'pending_review',
  under_review: 'pending_review',
  confirmed: 'confirmed',
  assigned: 'assigned',
  en_route: 'en_route',
  in_progress: 'in_progress',
  paused: 'in_progress',
  service_completed: 'completed_pending_admin_review',
  awaiting_customer_action: 'completed_pending_payment',
  closed: 'completed_paid',
  cancelled: 'cancelled',
  disputed: 'issue_reported',
};

const LEGACY_PAYMENT_TO_PAYMENT = {
  no_payment_required_yet: 'not_due',
  pending_admin_review: 'pending',
  awaiting_customer_payment: 'link_sent',
  payment_action_required: 'link_pending',
  payment_succeeded: 'paid_online',
  payment_failed: 'failed',
  cash_paid: 'paid_cash',
};

const PAYMENT_TO_LEGACY = Object.fromEntries(
  Object.entries(LEGACY_PAYMENT_TO_PAYMENT).map(([k, v]) => [v, k])
);

const ROLE_TRANSITIONS = {
  admin: new Set([
    'confirm', 'assign', 'reassign', 'en_route', 'start', 'pause', 'resume', 'complete_service',
    'approve_adjustment', 'reject_adjustment', 'set_final_amount', 'generate_payment_link',
    'mark_cash_paid', 'mark_card_on_site', 'cancel', 'reopen', 'resolve_dispute', 'close_job',
  ]),
  technician: new Set([
    'accept', 'en_route', 'start', 'pause', 'resume', 'request_assistance', 'add_note',
    'request_adjustment', 'complete_service',
  ]),
  customer: new Set([
    'approve_completion', 'report_issue', 'request_change', 'confirm_cash_payment',
  ]),
  system: new Set([
    'auto_confirm', 'send_link', 'payment_webhook', 'expire_token', 'notify',
  ]),
};

function normalizeServiceStatus(booking) {
  if (booking?.serviceStatus && SERVICE_STATUSES.includes(booking.serviceStatus)) {
    return booking.serviceStatus;
  }
  const js = String(booking?.jobStatus || '').toLowerCase();
  if (LEGACY_JOB_TO_SERVICE[js]) return LEGACY_JOB_TO_SERVICE[js];
  return 'requested';
}

function normalizePaymentStatus(booking) {
  if (booking?.paymentStatus && PAYMENT_STATUSES.includes(booking.paymentStatus)) {
    return booking.paymentStatus;
  }
  const pw = String(booking?.paymentWorkflowStatus || '').toLowerCase();
  if (LEGACY_PAYMENT_TO_PAYMENT[pw]) return LEGACY_PAYMENT_TO_PAYMENT[pw];
  if (booking?.paymentStatus === 'paid') return 'paid_online';
  return 'not_due';
}

function normalizeCustomerApprovalStatus(booking) {
  if (booking?.customerApprovalStatus && CUSTOMER_APPROVAL_STATUSES.includes(booking.customerApprovalStatus)) {
    return booking.customerApprovalStatus;
  }
  const ss = normalizeServiceStatus(booking);
  if (ss === 'awaiting_customer_action') return 'pending';
  if (ss === 'closed') return 'approved';
  if (ss === 'disputed') return 'disputed';
  return 'not_required';
}

function syncLegacyFields(booking) {
  const serviceStatus = normalizeServiceStatus(booking);
  const paymentStatus = normalizePaymentStatus(booking);
  const customerApprovalStatus = normalizeCustomerApprovalStatus(booking);
  const jobStatus = SERVICE_TO_LEGACY_JOB[serviceStatus] || booking.jobStatus || 'pending_review';
  const paymentWorkflowStatus = PAYMENT_TO_LEGACY[paymentStatus] || booking.paymentWorkflowStatus || 'no_payment_required_yet';
  return {
    ...booking,
    serviceStatus,
    paymentStatus,
    customerApprovalStatus,
    jobStatus,
    paymentWorkflowStatus,
  };
}

const ALLOWED_SERVICE_TRANSITIONS = {
  requested: ['under_review', 'cancelled'],
  under_review: ['confirmed', 'cancelled'],
  confirmed: ['assigned', 'cancelled'],
  assigned: ['en_route', 'in_progress', 'cancelled', 'paused'],
  en_route: ['in_progress', 'paused', 'cancelled'],
  in_progress: ['paused', 'service_completed', 'disputed', 'cancelled'],
  paused: ['in_progress', 'cancelled'],
  service_completed: ['awaiting_customer_action', 'closed', 'disputed'],
  awaiting_customer_action: ['closed', 'disputed', 'cancelled'],
  closed: ['reopen'],
  cancelled: ['under_review'],
  disputed: ['in_progress', 'awaiting_customer_action', 'cancelled'],
};

function canTransitionService(from, to) {
  const allowed = ALLOWED_SERVICE_TRANSITIONS[from] || [];
  return allowed.includes(to);
}

function assertRoleAction(role, action) {
  const set = ROLE_TRANSITIONS[role];
  if (!set || !set.has(action)) {
    return { ok: false, error: 'forbidden_action', code: 'ROLE_FORBIDDEN' };
  }
  return { ok: true };
}

function makeRequestId() {
  return crypto.randomBytes(12).toString('hex');
}

function portalLabel(serviceStatus, paymentStatus, customerApprovalStatus) {
  return {
    serviceStatus,
    paymentStatus,
    customerApprovalStatus,
    serviceLabel: serviceStatus.replace(/_/g, ' '),
    paymentLabel: paymentStatus.replace(/_/g, ' '),
    approvalLabel: customerApprovalStatus.replace(/_/g, ' '),
    canModify: ['requested', 'under_review', 'confirmed'].includes(serviceStatus),
    canPay: ['link_sent', 'link_pending', 'pending'].includes(paymentStatus) &&
      customerApprovalStatus !== 'disputed',
    awaitingCustomer: serviceStatus === 'awaiting_customer_action',
  };
}

function getApprovedAmountCents(booking) {
  const dollars = booking?.approvedFinalAmount != null
    ? Number(booking.approvedFinalAmount)
    : Number(booking?.finalAmount != null ? booking.finalAmount : booking?.totalPrice || 0);
  return Math.max(0, Math.round(dollars * 100));
}

function getTechAdjustmentLimits() {
  const maxPct = Number(process.env.TECH_ADJUSTMENT_MAX_PERCENT || 10);
  const maxCents = Number(process.env.TECH_ADJUSTMENT_MAX_CENTS || 3000);
  return { maxPct: Number.isFinite(maxPct) ? maxPct : 10, maxCents: Number.isFinite(maxCents) ? maxCents : 3000 };
}

function evaluateTechAdjustment(originalCents, proposedCents) {
  const { maxPct, maxCents } = getTechAdjustmentLimits();
  const diff = proposedCents - originalCents;
  const reduction = originalCents - proposedCents;
  if (diff > 0) {
    return { ok: false, requiresAdmin: true, reason: 'increase_requires_admin' };
  }
  if (reduction <= 0) return { ok: true, requiresAdmin: false };
  const pctLimit = Math.floor(originalCents * (maxPct / 100));
  const within = reduction <= Math.min(pctLimit, maxCents);
  return { ok: within, requiresAdmin: !within, reductionCents: reduction, maxPct, maxCents };
}

module.exports = {
  SERVICE_STATUSES,
  PAYMENT_STATUSES,
  CUSTOMER_APPROVAL_STATUSES,
  LEGACY_JOB_TO_SERVICE,
  SERVICE_TO_LEGACY_JOB,
  normalizeServiceStatus,
  normalizePaymentStatus,
  normalizeCustomerApprovalStatus,
  syncLegacyFields,
  canTransitionService,
  assertRoleAction,
  makeRequestId,
  portalLabel,
  getApprovedAmountCents,
  getTechAdjustmentLimits,
  evaluateTechAdjustment,
};
