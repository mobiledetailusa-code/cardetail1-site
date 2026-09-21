'use strict';

/**
 * Technician Quick Ops projection — same customer / vehicle / service / money
 * terms as Admin Quick Ops, with field-only actions.
 */

const {
  projectQuickOpsBooking,
  moneyFromBooking,
  bookingStatus,
  jobCompleted,
  paidInFull,
  dollarsFromCents,
  onSiteMethodLabel,
} = require('./admin-quick-ops-view');
const {
  normalizeTechJobStatus,
  isTechEligibleBooking,
  canTechTransition,
  TECH_STATUS_UPDATES,
} = require('./ops-workflow');

const FIELD_LABELS = {
  pending_review: 'Pending review',
  confirmed: 'Confirmed',
  assigned: 'Assigned',
  accepted: 'Accepted',
  en_route: 'En route',
  arrived: 'Arrived',
  in_progress: 'In progress',
  paused: 'Paused',
  issue_reported: 'Issue reported',
  reopened: 'Reopened',
  completed_pending_payment: 'Done — payment pending',
  completed_paid: 'Done — paid',
  cancelled: 'Cancelled',
  canceled: 'Cancelled',
};

const COMPLETABLE = new Set(['arrived', 'in_progress', 'paused', 'issue_reported']);
const DONE_JOB_STATUSES = new Set([
  'completed',
  'completed_paid',
  'completed_pending_payment',
  'completed_pending_admin_review',
  'closed',
]);

function fieldStatusLabel(status) {
  const key = String(status || '').trim().toLowerCase();
  return FIELD_LABELS[key] || key || 'Job';
}

function techJobDone(booking) {
  if (jobCompleted(booking)) return true;
  const js = String(booking && booking.jobStatus || '').toLowerCase();
  return DONE_JOB_STATUSES.has(js);
}

function projectTechQuickOpsBooking(booking, shared = null) {
  const base = projectQuickOpsBooking(booking, shared);
  const fieldStatus = normalizeTechJobStatus(booking);
  const cancelled = base.status === 'cancelled';
  const done = techJobDone(booking);
  const eligible = !cancelled && !done && isTechEligibleBooking(booking);
  const locked = cancelled || done;

  const fieldActions = {};
  for (const status of TECH_STATUS_UPDATES) {
    fieldActions[status] = eligible && canTechTransition(fieldStatus, status);
  }

  return {
    ...base,
    role: 'technician',
    fieldStatus,
    fieldStatusLabel: fieldStatusLabel(fieldStatus || base.status),
    assignedTech: String(booking.assignedTechName || booking.assignedTech || '').trim(),
    actions: {
      accept: !!fieldActions.accepted,
      en_route: !!fieldActions.en_route,
      arrived: !!fieldActions.arrived,
      in_progress: !!fieldActions.in_progress,
      paused: !!fieldActions.paused,
      issue_reported: !!fieldActions.issue_reported,
      complete: eligible && COMPLETABLE.has(fieldStatus),
      call: !!base.actions.call,
      map: !!base.actions.map,
      confirm: false,
      cancel: false,
      approve: false,
      reject: false,
      reschedule: false,
      adjust: !cancelled,
      payment: !cancelled && !base.paid && base.money.remainingCents > 0,
      cash: !cancelled && !base.paid && base.money.remainingCents > 0,
      card: !cancelled && !base.paid && base.money.remainingCents > 0,
      text: !!base.actions.call && !cancelled && !base.paid && base.money.remainingCents > 0,
    },
    completed: done,
    locked,
    photosHint: 'Photos stay on the technician portal.',
  };
}

module.exports = {
  projectTechQuickOpsBooking,
  fieldStatusLabel,
  techJobDone,
  moneyFromBooking,
  bookingStatus,
  jobCompleted,
  paidInFull,
  dollarsFromCents,
  onSiteMethodLabel,
  COMPLETABLE,
};
