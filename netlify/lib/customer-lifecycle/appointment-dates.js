'use strict';

/**
 * Authoritative appointment date helpers (UTC + site IANA timezone).
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

function assertValidTimeZone(tz) {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * Read calendar parts of an instant as observed in `timeZone`.
 */
function zonedParts(ms, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(ms));
  const get = (type) => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') === 24 ? 0 : get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

function partsEqual(a, b) {
  return a.year === b.year
    && a.month === b.month
    && a.day === b.day
    && a.hour === b.hour
    && a.minute === b.minute
    && a.second === b.second;
}

/**
 * Convert local wall-clock (date + hour:minute in `tz`) → UTC ISO.
 *
 * DST policy:
 * - Spring-forward gap (nonexistent local time): return null (caller treats as invalid).
 * - Fall-back overlap (ambiguous): prefer the EARLIER occurrence (still on DST).
 */
function appointmentInstantFromLocalParts(dateStr, timeStr, tz = DEFAULT_BUSINESS_TZ) {
  const timeZone = String(tz || DEFAULT_BUSINESS_TZ).trim() || DEFAULT_BUSINESS_TZ;
  if (!assertValidTimeZone(timeZone)) return null;

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
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }

  const [y, mo, d] = date.split('-').map(Number);
  const want = { year: y, month: mo, day: d, hour, minute, second: 0 };

  // Initial guess: treat wall time as UTC, then correct by observed TZ offset twice.
  let guess = Date.UTC(y, mo - 1, d, hour, minute, 0);
  for (let i = 0; i < 3; i += 1) {
    const got = zonedParts(guess, timeZone);
    const asUtc = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute, got.second);
    const wantUtc = Date.UTC(want.year, want.month - 1, want.day, want.hour, want.minute, want.second);
    guess += wantUtc - asUtc;
  }

  if (partsEqual(zonedParts(guess, timeZone), want)) {
    return new Date(guess).toISOString();
  }

  // Ambiguous fall-back: probe ±1h around guess; prefer EARLIER (DST) occurrence.
  const candidates = [];
  for (const delta of [-3600000, 0, 3600000, -7200000, 7200000]) {
    const ms = guess + delta;
    if (partsEqual(zonedParts(ms, timeZone), want)) candidates.push(ms);
  }
  const unique = [...new Set(candidates)].sort((a, b) => a - b);
  if (unique.length >= 1) {
    // Prefer earlier occurrence on overlap.
    return new Date(unique[0]).toISOString();
  }

  // Nonexistent spring-forward local time.
  return null;
}

function formatBusinessLocal(utcIso, tz = DEFAULT_BUSINESS_TZ) {
  if (!utcIso) return null;
  const timeZone = String(tz || DEFAULT_BUSINESS_TZ);
  if (!assertValidTimeZone(timeZone)) return utcIso;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
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
  assertValidTimeZone,
  appointmentInstantFromLocalParts,
  formatBusinessLocal,
  projectAppointmentDates,
  ensureAppointmentDateFoundation,
};
