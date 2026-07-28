// Authoritative booking confirmation transition with CAS + single confirmedAt.
// Both admin-ops confirm_booking and update-booking must use this path so
// concurrent confirmations produce one state transition and one notification identity.

'use strict';

const { getBookingRecord, commitBooking, setBookingStoreOverride } = require('./booking-repository');
const { portalReleasePatch } = require('./booking-visibility');

const MAX_CAS_ATTEMPTS = 4;

function isConfirmedBooking(booking) {
  if (!booking) return false;
  const appt = String(booking.appointmentStatus || '').toLowerCase();
  const js = String(booking.jobStatus || '').toLowerCase();
  const st = String(booking.status || '').toLowerCase();
  return appt === 'confirmed' || js === 'confirmed' || st === 'confirmed';
}

function appendConfirmEvent(booking, now, by) {
  const eventLog = Array.isArray(booking.eventLog) ? booking.eventLog.slice() : [];
  const already = eventLog.some((e) => e && e.action === 'booking_confirmed');
  if (!already) {
    eventLog.push({ action: 'booking_confirmed', at: now, by: by || 'admin' });
  }
  return eventLog;
}

/**
 * Atomically transition a booking to confirmed.
 * Only one concurrent caller may own the transition (transitioned:true).
 * Already-confirmed bookings return idempotent success without a second transition.
 */
async function confirmBookingTransition({
  bookingId,
  now = new Date().toISOString(),
  by = 'admin',
  extraPatch = null,
} = {}) {
  const id = String(bookingId || '').trim();
  if (!id) return { ok: false, error: 'missing_booking_id' };

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const current = await getBookingRecord(id);
    if (!current.exists || !current.booking) {
      return { ok: false, error: 'not_found', statusCode: 404 };
    }

    const booking = current.booking;
    if (isConfirmedBooking(booking)) {
      return {
        ok: true,
        idempotent: true,
        transitioned: false,
        booking,
      };
    }

    // confirmedAt is written exactly once by the winning transition.
    const confirmedAt = booking.confirmedAt || now;
    const expected = Math.max(0, Math.round(Number(booking.bookingVersion) || 0));
    const next = {
      ...booking,
      ...(extraPatch && typeof extraPatch === 'object' ? extraPatch : {}),
      ...portalReleasePatch(now),
      jobStatus: 'confirmed',
      appointmentStatus: 'confirmed',
      status: 'Confirmed',
      adminReviewed: true,
      adminReviewedAt: booking.adminReviewedAt || now,
      confirmedAt,
      // Stable confirmation identity for notification idempotency.
      confirmationEventId: booking.confirmationEventId || `confirmed:${id}:${confirmedAt}`,
      finalizedAt: booking.finalizedAt || now,
      updatedAt: now,
      updatedByRole: 'admin',
      updatedBy: by,
      lastAction: 'confirm_booking',
      eventLog: appendConfirmEvent(booking, now, by),
    };

    const committed = await commitBooking({
      bookingId: id,
      expectedBookingVersion: expected,
      nextAggregate: next,
    });

    if (committed.ok) {
      try {
        const { writeAppointmentTimelineEvent, appendEventLogEntry } = require('./customer-lifecycle/appointment-timeline');
        const { ensureAppointmentDateFoundation } = require('./customer-lifecycle/appointment-dates');
        const datePatch = ensureAppointmentDateFoundation(committed.booking || next);
        const timeline = await writeAppointmentTimelineEvent({
          booking: committed.booking || next,
          bookingId: id,
          appointmentId: id,
          siteId: 'detailing-zone',
          eventType: 'booking_approved',
          actorType: 'owner',
          actorId: by || 'admin',
          source: 'booking-confirm',
          changeSummary: 'booking_approved',
          appointmentVersion: committed.bookingVersion || next.bookingVersion,
          quoteVersion: (committed.booking || next).quoteVersion,
          idempotencyKey: `booking_approved:${id}:${confirmedAt}`,
          correlationId: next.confirmationEventId || null,
        });
        // Best-effort: merge lifecycle eventLog entry if not already present.
        void datePatch;
        void appendEventLogEntry;
        void timeline;
      } catch (_) {
        /* non-blocking */
      }
      return {
        ok: true,
        idempotent: false,
        transitioned: true,
        booking: committed.booking,
        bookingVersion: committed.bookingVersion,
      };
    }

    if (committed.error === 'version_conflict') {
      continue;
    }
    return {
      ok: false,
      error: committed.error || 'confirm_failed',
      statusCode: committed.statusCode || 500,
    };
  }

  const finalRec = await getBookingRecord(id);
  if (finalRec.exists && isConfirmedBooking(finalRec.booking)) {
    return {
      ok: true,
      idempotent: true,
      transitioned: false,
      booking: finalRec.booking,
    };
  }
  return { ok: false, error: 'version_conflict', statusCode: 409 };
}

module.exports = {
  isConfirmedBooking,
  confirmBookingTransition,
  // test seam
  setBookingStoreOverride,
};
