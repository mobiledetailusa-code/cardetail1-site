'use strict';

/**
 * Freelance Quick Ops jobs close themselves once the balance is actually paid.
 * Registered technicians keep the full portal completion path (photos, checklist).
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
 * Fields to merge when a freelance magic-link job is fully paid.
 * Returns null when this booking should not auto-close.
 */
function freelancePaidCloseFields(booking, paidAt) {
  if (!booking || booking.quickOpsTechClose !== true) return null;
  if (isCancelledBooking(booking) || isClosedJobStatus(booking)) return null;
  const at = typeof paidAt === 'string' && paidAt ? paidAt : new Date().toISOString();
  const eventLog = Array.isArray(booking.eventLog) ? booking.eventLog.slice() : [];
  eventLog.push({
    action: 'tech_quick_ops_auto_completed',
    by: 'payment',
    at,
  });
  return {
    jobStatus: 'completed_paid',
    status: 'Completed',
    serviceStatus: 'completed',
    completedAt: booking.completedAt || at,
    jobCompletedAt: booking.jobCompletedAt || at,
    completionSource: booking.completionSource || 'tech_quick_ops_payment',
    eventLog,
  };
}

/**
 * Backup close when a settlement wrote payment status but left the job open.
 * The payment compatibility patch is the primary path.
 */
async function ensureFreelanceJobClosed(bookingId) {
  const { getBookingRecord, commitBooking } = require('./booking-repository');
  const { buildNextAggregate } = require('./booking-aggregate');
  const { moneyFromBooking } = require('./admin-quick-ops-view');
  const rec = await getBookingRecord(bookingId);
  if (!rec.exists || !rec.booking) return { ok: false, error: 'not_found' };
  const booking = rec.booking;
  const close = freelancePaidCloseFields(booking);
  if (!close) return { ok: true, closed: false };
  let shared = null;
  try {
    const { getSharedFinancialProjection } = require('./db/operational-payment');
    shared = await getSharedFinancialProjection(booking);
  } catch {
    shared = null;
  }
  const money = moneyFromBooking(booking, shared);
  if (money.remainingCents > 0) return { ok: true, closed: false };
  const pay = String(booking.paymentStatus || '').toLowerCase();
  const settled = Math.max(0, Math.round(Number(money.settledCents) || 0));
  const markedPaid = ['paid', 'paid_cash', 'paid_card_on_site'].includes(pay);
  if (!markedPaid && settled <= 0) return { ok: true, closed: false };
  const next = buildNextAggregate(booking, close);
  const committed = await commitBooking({
    bookingId,
    expectedBookingVersion: booking.bookingVersion,
    nextAggregate: next,
  });
  if (!committed.ok) return committed;
  return { ok: true, closed: true, booking: committed.booking };
}

module.exports = {
  freelancePaidCloseFields,
  ensureFreelanceJobClosed,
  isCancelledBooking,
  isClosedJobStatus,
};
