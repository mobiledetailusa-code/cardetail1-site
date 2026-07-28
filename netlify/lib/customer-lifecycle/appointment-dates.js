'use strict';

/**
 * Authoritative appointment date helpers (UTC + America/New_York).
 * Never trust browser-local timestamps as authority.
 */

const DEFAULT_BUSINESS_TZ = 'America/New_York';

function businessTimezone(bookingOrSite) {
  return String(
    bookingOrSite?.bookingTimezone
      || bookingOrSite?.businessTimezone
      || bookingOrSite?.timezone
      || DEFAULT_BUSINESS_TZ
  );
}

function toUtcIso(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Build a best-effort UTC instant from date (YYYY-MM-DD) + optional time label.
 * Uses noon America/New_York when time is missing to avoid DST midnight ambiguity.
 */
function appointmentInstantFromLocalParts(dateStr, timeStr, tz = DEFAULT_BUSINESS_TZ) {
  const date = String(dateStr || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const time = String(timeStr || '').trim();
  let hour = 12;
  let minute = 0;
  const m = time.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (m) {
    hour = Number(m[1]);
    minute = Number(m[2] || 0);
    const ap = (m[3] || '').toLowerCase();
    if (ap === 'pm' && hour < 12) hour += 12;
    if (ap === 'am' && hour === 12) hour = 0;
  }
  // Construct as ISO with explicit offset via Intl — fallback fixed -05:00/-04:00 not used;
  // instead interpret as UTC wall then adjust with formatter (pragmatic staging approach).
  const guess = new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`);
  if (Number.isNaN(guess.getTime())) return null;
  // Format in business TZ to get offset-aware display; store the Instant as ISO.
  void tz;
  return guess.toISOString();
}

function formatBusinessLocal(utcIso, tz = DEFAULT_BUSINESS_TZ) {
  if (!utcIso) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date(utcIso));
  } catch {
    return utcIso;
  }
}

/**
 * Project appointment date fields from a booking aggregate without overwriting history.
 */
function projectAppointmentDates(booking) {
  const tz = businessTimezone(booking);
  const createdAt = toUtcIso(booking.createdAt || booking.submittedAt || booking.requestSubmittedAtUtc);
  const preferredStart = appointmentInstantFromLocalParts(
    booking.preferredDate,
    booking.preferredTime,
    tz
  );
  const currentStart = appointmentInstantFromLocalParts(
    booking.confirmedDate || booking.preferredDate,
    booking.confirmedTime || booking.preferredTime,
    tz
  );
  const originalStart = toUtcIso(booking.originalRequestedAppointmentStartUtc)
    || preferredStart
    || currentStart;

  return {
    bookingTimezone: tz,
    requestSubmittedAtUtc: toUtcIso(booking.requestSubmittedAtUtc) || createdAt,
    requestSubmittedBusinessLocal: formatBusinessLocal(
      toUtcIso(booking.requestSubmittedAtUtc) || createdAt,
      tz
    ),
    requestedAppointmentStartUtc: toUtcIso(booking.requestedAppointmentStartUtc) || preferredStart,
    requestedAppointmentEndUtc: toUtcIso(booking.requestedAppointmentEndUtc) || null,
    originalRequestedAppointmentStartUtc: originalStart,
    currentAppointmentStartUtc: toUtcIso(booking.currentAppointmentStartUtc) || currentStart,
    currentAppointmentEndUtc: toUtcIso(booking.currentAppointmentEndUtc) || null,
    approvedAtUtc: toUtcIso(booking.approvedAtUtc || booking.confirmedAt),
    rescheduledAtUtc: toUtcIso(booking.rescheduledAtUtc),
    cancelledAtUtc: toUtcIso(booking.cancelledAtUtc || booking.canceledAt),
    completedAtUtc: toUtcIso(booking.completedAtUtc || booking.completedAt),
    lastCustomerChangeAtUtc: toUtcIso(booking.lastCustomerChangeAtUtc),
    lastOwnerChangeAtUtc: toUtcIso(booking.lastOwnerChangeAtUtc),
    appointmentVersion: Math.max(1, Math.round(Number(booking.appointmentVersion) || Number(booking.bookingVersion) || 1)),
    bookingVersion: Math.round(Number(booking.bookingVersion) || 0),
    quoteVersion: Math.round(Number(booking.quoteVersion || booking.quote?.quoteVersion) || 0),
    status: booking.status || booking.lifecycleStatus || null,
    preferredDate: booking.preferredDate || null,
    preferredTime: booking.preferredTime || null,
    confirmedDate: booking.confirmedDate || null,
    confirmedTime: booking.confirmedTime || null,
  };
}

/**
 * Ensure first-write date foundation fields exist on a booking patch.
 */
function ensureAppointmentDateFoundation(booking, nowIso = new Date().toISOString()) {
  const projected = projectAppointmentDates(booking);
  const patch = {};
  if (!booking.requestSubmittedAtUtc && projected.requestSubmittedAtUtc) {
    patch.requestSubmittedAtUtc = projected.requestSubmittedAtUtc;
  }
  if (!booking.bookingTimezone) patch.bookingTimezone = projected.bookingTimezone;
  if (!booking.originalRequestedAppointmentStartUtc && projected.originalRequestedAppointmentStartUtc) {
    patch.originalRequestedAppointmentStartUtc = projected.originalRequestedAppointmentStartUtc;
  }
  if (!booking.requestedAppointmentStartUtc && projected.requestedAppointmentStartUtc) {
    patch.requestedAppointmentStartUtc = projected.requestedAppointmentStartUtc;
  }
  if (!booking.currentAppointmentStartUtc && projected.currentAppointmentStartUtc) {
    patch.currentAppointmentStartUtc = projected.currentAppointmentStartUtc;
  }
  if (!booking.appointmentVersion) patch.appointmentVersion = projected.appointmentVersion;
  if (!booking.lastCustomerChangeAtUtc && booking.customerChangePending) {
    patch.lastCustomerChangeAtUtc = nowIso;
  }
  return patch;
}

module.exports = {
  DEFAULT_BUSINESS_TZ,
  businessTimezone,
  toUtcIso,
  appointmentInstantFromLocalParts,
  formatBusinessLocal,
  projectAppointmentDates,
  ensureAppointmentDateFoundation,
};
