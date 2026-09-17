'use strict';

const { getBookingRecord, commitBooking } = require('./booking-repository');

const MAX_CAS_ATTEMPTS = 4;

function isCancelledBooking(booking) {
  if (!booking) return false;
  const appt = String(booking.appointmentStatus || '').toLowerCase();
  const js = String(booking.jobStatus || '').toLowerCase();
  const st = String(booking.status || '').toLowerCase();
  return appt === 'canceled' || appt === 'cancelled'
    || js === 'cancelled' || js === 'canceled'
    || st === 'cancelled' || st === 'canceled';
}

async function cancelBookingTransition({
  bookingId,
  now = new Date().toISOString(),
  by = 'admin',
  reason = 'admin_cancelled',
} = {}) {
  const id = String(bookingId || '').trim();
  if (!id) return { ok: false, error: 'missing_booking_id' };

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const current = await getBookingRecord(id);
    if (!current.exists || !current.booking) {
      return { ok: false, error: 'not_found', statusCode: 404 };
    }
    const booking = current.booking;
    if (isCancelledBooking(booking)) {
      return { ok: true, idempotent: true, transitioned: false, booking };
    }
    const canceledAt = booking.canceledAt || now;
    const expected = Math.max(0, Math.round(Number(booking.bookingVersion) || 0));
    const eventLog = Array.isArray(booking.eventLog) ? booking.eventLog.slice() : [];
    if (!eventLog.some((entry) => entry && entry.action === 'booking_cancelled')) {
      eventLog.push({ action: 'booking_cancelled', at: now, by, reason });
    }
    const next = {
      ...booking,
      jobStatus: 'cancelled',
      appointmentStatus: 'canceled',
      status: 'Cancelled',
      canceledAt,
      cancellationReason: reason || booking.cancellationReason || 'admin_cancelled',
      cancellationRequestStatus: booking.cancellationRequestStatus === 'requested'
        ? 'resolved_approved'
        : booking.cancellationRequestStatus,
      cancellationResolvedAt: now,
      cancellationResolvedNote: reason || 'Cancelled by admin',
      cancellationActor: 'admin',
      cancellationEventId: booking.cancellationEventId || `cancelled:${id}:${canceledAt}`,
      updatedAt: now,
      updatedByRole: 'admin',
      updatedBy: by,
      lastAction: 'cancel_booking',
      eventLog,
    };
    const committed = await commitBooking({
      bookingId: id,
      expectedBookingVersion: expected,
      nextAggregate: next,
    });
    if (committed.ok) {
      return {
        ok: true,
        idempotent: false,
        transitioned: true,
        booking: committed.booking,
        bookingVersion: committed.bookingVersion,
      };
    }
    if (committed.error === 'version_conflict') continue;
    return { ok: false, error: committed.error || 'cancel_failed', statusCode: committed.statusCode || 500 };
  }

  const finalRec = await getBookingRecord(id);
  if (finalRec.exists && isCancelledBooking(finalRec.booking)) {
    return { ok: true, idempotent: true, transitioned: false, booking: finalRec.booking };
  }
  return { ok: false, error: 'version_conflict', statusCode: 409 };
}

module.exports = {
  isCancelledBooking,
  cancelBookingTransition,
};
