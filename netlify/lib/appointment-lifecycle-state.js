'use strict';

const { isConfirmedBooking } = require('./booking-confirm');
const { scheduleFingerprint } = require('./sms-templates');

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function isAppointmentCancelled(booking) {
  if (!booking) return false;
  const appt = normalizeStatus(booking.appointmentStatus);
  const job = normalizeStatus(booking.jobStatus);
  const status = normalizeStatus(booking.status);
  return appt === 'canceled'
    || appt === 'cancelled'
    || job === 'cancelled'
    || job === 'canceled'
    || status === 'cancelled'
    || status === 'canceled';
}

function isAppointmentCompleted(booking) {
  if (!booking) return false;
  const job = normalizeStatus(booking.jobStatus);
  const status = normalizeStatus(booking.status);
  return job.startsWith('completed')
    || job === 'service_completed'
    || status === 'completed'
    || status === 'completed_paid';
}

function smsSafeEventPart(value) {
  return String(value || '')
    .replace(/[^A-Za-z0-9_.:-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

function buildRescheduleEventId(bookingId, date, time) {
  return [
    'rescheduled',
    smsSafeEventPart(bookingId),
    smsSafeEventPart(date),
    smsSafeEventPart(time),
  ].filter(Boolean).join(':').slice(0, 100);
}

/**
 * Reminder eligibility is a gate for any future reminder engine.
 * Cancelled and completed appointments are never eligible. Rescheduled
 * appointments remain eligible only against the current confirmed schedule.
 */
function appointmentReminderEligible(booking) {
  if (!booking) return false;
  if (isAppointmentCancelled(booking) || isAppointmentCompleted(booking)) return false;
  return isConfirmedBooking(booking);
}

function currentScheduleFingerprint(booking) {
  return scheduleFingerprint(booking || {});
}

const SUPERSEDED_TEMPLATE_KEYS = new Set([
  'booking.confirmed',
  'booking.rescheduled',
  'booking.request_received',
  'booking.safe_confirmation',
  'booking.change_requested',
  'booking.customer_action_required',
]);

async function shouldSuppressStaleLifecycleSms(row) {
  const templateKey = String(row?.templateKey || '');
  const bookingId = String(row?.bookingId || '').trim();
  if (!bookingId || !SUPERSEDED_TEMPLATE_KEYS.has(templateKey)) return false;
  let booking = null;
  try {
    const { getBookingRecord } = require('./booking-repository');
    const rec = await getBookingRecord(bookingId);
    booking = rec && rec.booking;
  } catch {
    return false;
  }
  if (!booking) return false;
  if (isAppointmentCancelled(booking) || isAppointmentCompleted(booking)) return true;
  if (templateKey === 'booking.confirmed' || templateKey === 'booking.rescheduled') {
    const snap = String((row.templateData || {}).scheduleFingerprint || '').trim();
    if (snap && snap !== currentScheduleFingerprint(booking)) return true;
  }
  return false;
}

module.exports = {
  isAppointmentCancelled,
  isAppointmentCompleted,
  smsSafeEventPart,
  buildRescheduleEventId,
  appointmentReminderEligible,
  currentScheduleFingerprint,
  shouldSuppressStaleLifecycleSms,
};
