// Authoritative booking confirmation transition with CAS + single confirmedAt.
// Both admin-ops confirm_booking and update-booking must use this path so
// concurrent confirmations produce one state transition and one notification identity.

'use strict';

const { getBookingRecord, commitBooking, setBookingStoreOverride } = require('./booking-repository');
const { portalReleasePatch } = require('./booking-visibility');
const { settleAuthoritativeConfirmation } = require('./revenue-authoritative-confirm');

const MAX_CAS_ATTEMPTS = 4;

function isConfirmedBooking(booking) {
  if (!booking) return false;
  const appt = String(booking.appointmentStatus || '').toLowerCase();
  const js = String(booking.jobStatus || '').toLowerCase();
  const st = String(booking.status || '').toLowerCase();
  return appt === 'confirmed' || js === 'confirmed' || st === 'confirmed';
}

function explicitApprovedDollars(raw) {
  if (!raw || typeof raw !== 'object' || !Object.prototype.hasOwnProperty.call(raw, 'approvedFinalAmount')) {
    return null;
  }
  if (raw.approvedFinalAmount == null || raw.approvedFinalAmount === '') return null;
  const amount = Number(raw.approvedFinalAmount);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Math.round(amount * 100) / 100;
}

function confirmationMarker(booking, eventId, raw) {
  const existing = booking && booking.confirmationAnalytics;
  if (existing && existing.required === true && existing.eventId) return existing;
  // Capture the pre-normalize amount. Later reads of the stored aggregate can
  // derive approvedFinalAmount from totalPrice, and that derived number is not
  // an approved amount.
  return {
    required: true,
    eventId,
    storedApprovedDollars: explicitApprovedDollars(raw),
  };
}

async function settleConfirmationAnalytics(booking) {
  try {
    await settleAuthoritativeConfirmation(booking);
  } catch (err) {
    console.warn('[booking-confirm] analytics_emit_failed', String(err && err.message || err).slice(0, 120));
  }
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
      await settleConfirmationAnalytics(booking);
      return {
        ok: true,
        idempotent: true,
        transitioned: false,
        booking,
      };
    }

    // confirmedAt is written exactly once by the winning transition.
    const confirmedAt = booking.confirmedAt || now;
    const confirmationEventId = booking.confirmationEventId || `confirmed:${id}:${confirmedAt}`;
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
      // Stable confirmation identity for notification idempotency and for the
      // revenue event. The analytics write is not part of this CAS.
      confirmationEventId,
      confirmationAnalytics: confirmationMarker(booking, confirmationEventId, current.raw),
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
      await settleConfirmationAnalytics(committed.booking);
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
    await settleConfirmationAnalytics(finalRec.booking);
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
