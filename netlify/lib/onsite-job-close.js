'use strict';

/**
 * Full cash or confirmed card-on-site closes a job only when the service was
 * actually performed. Arrival and "in progress" are not that proof: taking
 * the money at the curb, or while the job is still underway, leaves the job
 * open. A future appointment can be prepaid and stays open.
 *
 * Performed means an existing completion marker: the technician completed the
 * service, or the job is already in a completed / pending-payment / closed
 * state. No new status is added.
 *
 * One explicit request can confirm both facts at once
 * (confirmServicePerformed). Manual finish with a balance still uses
 * finishJobQuickOps and does not require payment.
 */

const { finishJobQuickOps } = require('./quick-ops-finish');
const { financialProjection } = require('./payment-service');

const PROVEN_JOB = new Set([
  'completed_pending_admin_review',
  'completed_pending_payment',
  'completed',
  'completed_paid',
  'closed',
]);

const PROVEN_SERVICE = new Set([
  'service_completed',
  'awaiting_customer_action',
  'closed',
]);

const ALREADY_FINISHED = new Set([
  'completed_pending_payment',
  'completed',
  'completed_paid',
  'closed',
]);

const PENDING_REQUEST = new Set(['pending', 'requested', 'open', 'submitted', 'awaiting_review']);

function todayIso(now) {
  const clock = now instanceof Date ? now : new Date(now || Date.now());
  return clock.toISOString().slice(0, 10);
}

function serviceDate(booking) {
  const date = String(booking && (booking.confirmedDate || booking.preferredDate) || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
}

function cancelled(booking) {
  const values = [booking && booking.jobStatus, booking && booking.appointmentStatus, booking && booking.status]
    .map((value) => String(value || '').toLowerCase());
  return values.some((value) => value === 'cancelled' || value === 'canceled');
}

function pendingApproval(booking) {
  const adjustments = Array.isArray(booking && booking.priceAdjustments) ? booking.priceAdjustments : [];
  if (adjustments.some((row) => {
    const status = String(row && row.status || '').toLowerCase();
    return status === 'pending_customer' || status === 'draft';
  })) return true;
  const requests = Array.isArray(booking && booking.changeRequests) ? booking.changeRequests : [];
  return requests.some((row) => PENDING_REQUEST.has(String(row && (row.status || row.requestStatus) || '').toLowerCase()));
}

/**
 * Existing completion evidence. arrivedAt, jobStatus in_progress / arrived /
 * on_site, and serviceStatus in_progress are deliberately absent.
 */
function serviceProvenExecuted(booking) {
  if (!booking) return false;
  if (booking.techCompletedAt || booking.completedAt || booking.jobCompletedAt) return true;
  const js = String(booking.jobStatus || '').toLowerCase();
  const svc = String(booking.serviceStatus || '').toLowerCase();
  const status = String(booking.status || '').toLowerCase();
  return PROVEN_JOB.has(js) || PROVEN_SERVICE.has(svc)
    || status === 'completed' || status === 'completed_paid';
}

function depositStillOpen(booking) {
  const plan = String(
    (booking && booking.ceramicPaymentPlan)
    || (booking && booking.ceramic && booking.ceramic.paymentPlan)
    || ''
  ).toLowerCase();
  if (plan !== 'deposit') return false;
  return !serviceProvenExecuted(booking);
}

/**
 * Whether this booking may be closed because the visit was performed and the
 * invoice is fully settled by a confirmed on-site receipt.
 * confirmServicePerformed is the operator's explicit "done and paid" on this
 * same request. It does not override a future date, a short payment, a
 * pending extra, or a cancelled job.
 */
function serviceReadyToAutoClose(booking, opts = {}) {
  if (!booking) return { ok: false, reason: 'booking_required' };
  if (cancelled(booking)) return { ok: false, reason: 'cancelled' };
  if (pendingApproval(booking)) return { ok: false, reason: 'pending_approval' };
  const explicit = opts.confirmServicePerformed === true;
  if (depositStillOpen(booking) && !explicit) return { ok: false, reason: 'deposit' };

  const pay = String(booking.paymentStatus || '').toLowerCase();
  const pwf = String(booking.paymentWorkflowStatus || '').toLowerCase();
  const cardConfirmed = pay === 'paid_card_on_site' || !!booking.cardOnSiteAt;
  const cashConfirmed = pay === 'paid_cash' || pwf === 'cash_paid' || !!booking.cashReceivedAt;
  if (cardConfirmed) {
    const reference = String(booking.cardOnSiteReference || '').trim();
    if (!reference) return { ok: false, reason: 'card_not_confirmed' };
    if (reference.replace(/\D/g, '').length >= 12) return { ok: false, reason: 'unsafe_card_reference' };
  } else if (!cashConfirmed) {
    return { ok: false, reason: 'not_confirmed' };
  }

  const money = financialProjection(booking);
  const remaining = Math.max(0, Math.round(Number(money.remainingCents) || 0));
  const settled = Math.max(0, Math.round(Number(money.settledCents) || 0));
  const approved = Math.max(0, Math.round(Number(money.approvedCents) || 0));
  if (remaining > 0) return { ok: false, reason: 'partial' };
  if (!(settled > 0) || (approved > 0 && settled < approved)) {
    return { ok: false, reason: 'amount_mismatch' };
  }

  const date = serviceDate(booking);
  const today = todayIso(opts.now);
  if (date && date > today) return { ok: false, reason: 'future_service' };
  if (!serviceProvenExecuted(booking) && !explicit) return { ok: false, reason: 'not_executed' };
  return { ok: true, reason: null, explicit };
}

async function maybeAutoCloseAfterOnSitePayment(booking, opts = {}) {
  const ready = serviceReadyToAutoClose(booking, opts);
  if (!ready.ok) return { ok: true, closed: false, reason: ready.reason };
  const js = String(booking.jobStatus || '').toLowerCase();
  if (ALREADY_FINISHED.has(js)) {
    const { notifyIfServiceClosedAndPaid } = require('./service-completion-notice');
    const notice = await notifyIfServiceClosedAndPaid(booking, opts);
    return { ok: true, closed: false, alreadyFinished: true, reason: null, notice };
  }
  let finish;
  try {
    finish = await finishJobQuickOps(booking, opts);
  } catch (err) {
    console.warn('[onsite-close] finish_failed', String(err && err.message || err).slice(0, 80));
    return { ok: true, closed: false, reason: 'finish_failed' };
  }
  if (!finish || !finish.ok) {
    return { ok: true, closed: false, reason: (finish && finish.error) || 'finish_failed', finish };
  }
  return { ok: true, closed: true, reason: null, explicit: ready.explicit === true, finish };
}

module.exports = {
  serviceReadyToAutoClose,
  maybeAutoCloseAfterOnSitePayment,
  serviceProvenExecuted,
  executionSignal: serviceProvenExecuted,
};
