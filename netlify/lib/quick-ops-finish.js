'use strict';

/**
 * Admin QuickOps "Finish job".
 *
 * Runs the exact two steps the Jobs Board uses, through the same handler:
 *   1. admin_tech_status / complete_service  -> completed_pending_admin_review
 *   2. approve_completion (never charges a saved card from here)
 *
 * approve_completion is what asks the customer for a review. That send is
 * gated by SMS consent / opt-out and keyed `booking.review_requested:<id>`
 * (unique in the outbox), so finishing here, on the Jobs Board, or by the
 * technician can never send a second invite. If the customer still owes a
 * balance, approve_completion also sends the usual "payment due" notice,
 * the same as the Jobs Board.
 */

const FINISHED = new Set(['completed_pending_payment', 'completed_paid', 'closed']);

let runAdminActionOverride = null;

function setFinishAdminActionRunner(fn) {
  runAdminActionOverride = typeof fn === 'function' ? fn : null;
}

async function runAdminAction(body, opts) {
  if (runAdminActionOverride) return runAdminActionOverride(body, opts);
  const { handleAdminAction } = require('../functions/admin-ops-jobs');
  return handleAdminAction(body, opts);
}

function parse(response) {
  let body = {};
  try { body = JSON.parse(response && response.body || '{}'); } catch { body = {}; }
  return { statusCode: Number(response && response.statusCode) || 500, body };
}

function cancelled(booking) {
  const values = [booking.appointmentStatus, booking.jobStatus, booking.status]
    .map((v) => String(v || '').toLowerCase());
  return values.some((v) => v === 'cancelled' || v === 'canceled');
}

function reviewMessage(review) {
  if (!review) return 'Review request was not sent';
  if (review.queued) return 'Review request sent';
  const reason = String(review.reason || '');
  if (reason === 'booking_sms_consent_required' || reason === 'suppressed') {
    return 'Review request not sent (customer has not allowed texts)';
  }
  if (reason === 'review_not_available') return 'Review request not sent (customer already reviewed)';
  if (reason === 'customer_sms_not_enabled') return 'Review request not sent (customer texts are turned off)';
  if (reason === 'invalid_sms_recipient') return 'Review request not sent (no valid mobile number)';
  return 'Review request was already sent or is not available';
}

async function finishJobQuickOps(booking, opts = {}) {
  const bookingId = String(booking && (booking.id || booking.bookingId) || '');
  if (!bookingId) return { ok: false, statusCode: 400, error: 'booking_required' };
  if (cancelled(booking)) return { ok: false, statusCode: 409, error: 'cancelled' };
  const js = String(booking.jobStatus || '').toLowerCase();
  if (FINISHED.has(js)) {
    return { ok: true, idempotent: true, jobStatus: js, message: 'Job is already finished' };
  }
  const runOpts = { event: opts.event, prisma: opts.prisma, env: opts.env };
  if (js !== 'completed_pending_admin_review') {
    const step = parse(await runAdminAction({
      action: 'admin_tech_status',
      bookingId,
      statusAction: 'complete_service',
    }, runOpts));
    if (step.statusCode !== 200 || !step.body.ok) {
      return { ok: false, statusCode: step.statusCode, error: step.body.error || 'complete_failed' };
    }
  }
  const approved = parse(await runAdminAction({
    action: 'approve_completion',
    bookingId,
    confirmSavedCardCharge: false,
  }, runOpts));
  if (approved.statusCode !== 200 || !approved.body.ok) {
    return { ok: false, statusCode: approved.statusCode, error: approved.body.error || 'approve_failed' };
  }
  const review = approved.body.reviewRequest || null;
  return {
    ok: true,
    jobStatus: approved.body.jobStatus,
    reviewRequest: review,
    message: `Job finished. ${reviewMessage(review)}.`,
  };
}

module.exports = {
  finishJobQuickOps,
  reviewMessage,
  setFinishAdminActionRunner,
};
