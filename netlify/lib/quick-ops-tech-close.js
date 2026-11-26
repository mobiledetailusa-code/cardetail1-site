'use strict';

/**
 * Paying an invoice does not by itself complete a service that has not been
 * performed. QuickOps auto-close (onsite-job-close.js) runs only after a
 * confirmed cash or card receipt when arrival or an in-progress status shows
 * the visit happened. The compatibility patch still advances
 * completed_pending_payment → completed_paid, because that visit was already done.
 */

function isCancelledBooking(booking) {
  const values = [
    booking && booking.jobStatus,
    booking && booking.appointmentStatus,
    booking && booking.status,
  ].map((value) => String(value || '').toLowerCase());
  return values.some((value) => value === 'cancelled' || value === 'canceled');
}

function isClosedJobStatus(booking) {
  const js = String(booking && booking.jobStatus || '').toLowerCase();
  return js === 'completed_paid' || js === 'completed' || js === 'closed';
}

/**
 * Kept so older callers cannot close a job from a payment event.
 * Always null: full payment updates payment fields only.
 */
function freelancePaidCloseFields() {
  return null;
}

/**
 * Payment settlement must not mark an unexecuted service complete.
 */
async function ensureFreelanceJobClosed() {
  return { ok: true, closed: false, reason: 'payment_does_not_complete_service' };
}

module.exports = {
  freelancePaidCloseFields,
  ensureFreelanceJobClosed,
  isCancelledBooking,
  isClosedJobStatus,
};
