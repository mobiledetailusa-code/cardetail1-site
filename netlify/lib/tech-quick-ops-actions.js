'use strict';

const { getBookingRecord, commitBooking } = require('./booking-repository');
const { buildNextAggregate, normalizeAggregate } = require('./booking-aggregate');
const { prepareQuickOpsMoney, reloadBooking } = require('./quick-ops-amount');
const {
  mintPaymentLink,
  textCustomer,
  recordOnSitePayment,
} = require('./admin-quick-ops-actions');
const {
  projectTechQuickOpsBooking,
  moneyFromBooking,
  paidInFull,
  techJobDone,
  COMPLETABLE,
} = require('./tech-quick-ops-view');
const {
  TECH_STATUS_UPDATES,
  appendEventLog,
  isTechEligibleBooking,
  canTechTransition,
  normalizeTechJobStatus,
} = require('./ops-workflow');

const LEGACY_STATUS = {
  accepted: 'Scheduled',
  en_route: 'En Route',
  arrived: 'In Progress',
  in_progress: 'In Progress',
  paused: 'In Progress',
  issue_reported: 'Problem',
};

const FIELD_ACTIVE = new Set(['en_route', 'arrived', 'in_progress', 'paused', 'issue_reported']);
const ACTOR = 'tech_quick_ops';

async function loadProjectedBooking(bookingId) {
  const rec = await getBookingRecord(bookingId);
  if (!rec.exists || !rec.booking) return { ok: false, error: 'not_found', statusCode: 404, reads: 1 };
  let shared = null;
  try {
    const { getSharedFinancialProjection } = require('./db/operational-payment');
    shared = await getSharedFinancialProjection(rec.booking);
  } catch {
    shared = null;
  }
  return {
    ok: true,
    booking: rec.booking,
    view: projectTechQuickOpsBooking(rec.booking, shared),
    reads: 1,
    paymentAuthority: shared && shared.ok ? 'postgres' : 'blob',
  };
}

function expectedVersionFrom(booking, opts) {
  const raw = opts.expectedBookingVersion != null
    ? opts.expectedBookingVersion
    : booking.bookingVersion;
  const expected = Math.round(Number(raw));
  const actual = Math.round(Number(booking.bookingVersion) || 0);
  if (raw == null || raw === '' || !Number.isFinite(expected) || expected !== actual) {
    return {
      ok: false,
      error: 'version_conflict',
      statusCode: 409,
      expectedBookingVersion: Number.isFinite(expected) ? expected : null,
      actualBookingVersion: actual,
    };
  }
  return { ok: true, expected };
}

async function persistTechPatch(booking, updates, opts = {}) {
  const bookingId = String(booking.id || booking.bookingId || '').trim();
  const version = expectedVersionFrom(booking, opts);
  if (!version.ok) return version;
  const { ok: normOk, aggregate: base } = normalizeAggregate(booking, { allowDraft: false });
  const next = buildNextAggregate(normOk ? base : booking, updates);
  const committed = await commitBooking({
    bookingId,
    expectedBookingVersion: version.expected,
    nextAggregate: next,
  });
  if (!committed.ok) {
    return {
      ok: false,
      error: committed.error || 'version_conflict',
      statusCode: committed.statusCode || 409,
      actualBookingVersion: committed.actualBookingVersion,
    };
  }
  return {
    ok: true,
    booking: committed.booking,
    bookingVersion: committed.bookingVersion,
    jobStatus: committed.booking && committed.booking.jobStatus,
  };
}

async function updateTechFieldStatus(booking, status, opts = {}) {
  const newStatus = String(status || '').trim().toLowerCase();
  if (!TECH_STATUS_UPDATES.has(newStatus)) {
    return { ok: false, error: 'invalid_status', statusCode: 400 };
  }
  if (techJobDone(booking)) {
    return { ok: false, error: 'locked', statusCode: 409 };
  }
  const appt = String(booking.appointmentStatus || '').toLowerCase();
  const st = String(booking.status || '').toLowerCase();
  if (appt === 'canceled' || appt === 'cancelled' || st === 'cancelled') {
    return { ok: false, error: 'cancelled', statusCode: 409 };
  }
  if (!isTechEligibleBooking(booking)) {
    return { ok: false, error: 'not_confirmed_eligible', statusCode: 409 };
  }
  const fromStatus = normalizeTechJobStatus(booking);
  if (fromStatus === newStatus) {
    return { ok: true, idempotent: true, jobStatus: newStatus, booking };
  }
  if (!canTechTransition(fromStatus, newStatus)) {
    return {
      ok: false,
      error: 'invalid_status_transition',
      statusCode: 409,
      from: fromStatus || null,
      to: newStatus,
    };
  }

  const now = new Date().toISOString();
  const note = String(opts.note || '').trim().slice(0, 500);
  const updates = {
    jobStatus: newStatus,
    status: LEGACY_STATUS[newStatus] || booking.status,
    lastTechUpdate: now,
    lastTechUpdateBy: ACTOR,
    updatedAt: now,
    updatedByRole: 'technician',
    updatedBy: ACTOR,
    lastAction: 'tech_status_update',
    eventLog: appendEventLog(booking, {
      action: 'tech_status_update',
      status: newStatus,
      by: ACTOR,
      ...(note ? { note } : {}),
    }),
  };
  if (FIELD_ACTIVE.has(newStatus) && !booking.appointmentStatus) {
    updates.appointmentStatus = 'confirmed';
  }
  if (newStatus === 'en_route') updates.enRouteAt = now;
  if (newStatus === 'arrived') updates.arrivedAt = now;
  if (newStatus === 'in_progress') updates.startedAt = now;
  if (newStatus === 'paused') updates.pausedAt = now;
  if (newStatus === 'issue_reported') {
    updates.hasProblem = true;
    updates.lastProblem = note || 'Issue reported by technician';
  }
  if (note) {
    updates.techNotes = ((booking.techNotes || '') + '\n[' + now.slice(0, 16) + '] ' + note).trim();
  }
  const result = await persistTechPatch(booking, updates, opts);
  if (!result.ok) return result;
  return { ...result, jobStatus: newStatus, transitioned: true };
}

async function completeTechJob(booking, opts = {}) {
  if (techJobDone(booking)) {
    return { ok: true, idempotent: true, booking };
  }
  const appt = String(booking.appointmentStatus || '').toLowerCase();
  if (appt === 'canceled' || appt === 'cancelled' || bookingStatusCancelled(booking)) {
    return { ok: false, error: 'cancelled', statusCode: 409 };
  }
  if (!isTechEligibleBooking(booking)) {
    return { ok: false, error: 'not_confirmed_eligible', statusCode: 409 };
  }
  const fromStatus = normalizeTechJobStatus(booking);
  if (!COMPLETABLE.has(fromStatus)) {
    return { ok: false, error: 'not_ready_to_complete', statusCode: 409, from: fromStatus || null };
  }

  let shared = null;
  try {
    const { getSharedFinancialProjection } = require('./db/operational-payment');
    shared = await getSharedFinancialProjection(booking, { env: opts.env });
  } catch {
    shared = null;
  }
  const money = moneyFromBooking(booking, shared);
  const paid = paidInFull(booking, money) || !(money.remainingCents > 0);
  const now = new Date().toISOString();
  const jobStatus = paid ? 'completed_paid' : 'completed_pending_payment';
  const updates = {
    jobStatus,
    status: paid ? 'Paid' : 'Completed',
    completedAt: now,
    jobCompletedAt: now,
    techCompletedAt: now,
    completionSubmitted: true,
    lastTechUpdate: now,
    lastTechUpdateBy: ACTOR,
    updatedAt: now,
    updatedByRole: 'technician',
    updatedBy: ACTOR,
    lastAction: 'tech_quick_ops_complete',
    eventLog: appendEventLog(booking, {
      action: 'tech_quick_ops_complete',
      status: jobStatus,
      by: ACTOR,
    }),
  };
  const result = await persistTechPatch(booking, updates, opts);
  if (!result.ok) return result;
  return {
    ...result,
    jobStatus,
    transitioned: true,
    remainingCents: money.remainingCents,
  };
}

function bookingStatusCancelled(booking) {
  const st = String(booking.status || '').toLowerCase();
  const js = String(booking.jobStatus || '').toLowerCase();
  return st === 'cancelled' || js === 'cancelled' || js === 'canceled';
}

async function prepareTechMoney(booking, opts = {}) {
  return prepareQuickOpsMoney(booking, { ...opts, actor: opts.actor || ACTOR });
}

async function completeIfReady(booking, opts = {}) {
  if (techJobDone(booking)) return { ok: true, booking, idempotent: true, skipped: true };
  if (!isTechEligibleBooking(booking)) {
    return { ok: true, booking, skipped: true };
  }
  const fromStatus = normalizeTechJobStatus(booking);
  if (!COMPLETABLE.has(fromStatus)) return { ok: true, booking, skipped: true };
  return completeTechJob(booking, opts);
}

module.exports = {
  loadProjectedBooking,
  updateTechFieldStatus,
  completeTechJob,
  prepareTechMoney,
  completeIfReady,
  mintPaymentLink,
  textCustomer,
  recordOnSitePayment,
  reloadBooking,
};
