// Booking schedule rules — server-authoritative slot validation + duplicate lock.
const { normalizeJobStatus } = require('./ops-schema');

const ALLOWED_WEEKDAY_SLOTS = ['8:00 AM', '10:00 AM', '12:00 PM', '2:00 PM'];
const ALLOWED_SATURDAY_SLOTS = ['8:00 AM', '10:00 AM'];
/** Minimum calendar days from today before a preferred date can be booked (route planning). */
const MIN_ADVANCE_DAYS = 3;

const LEGACY_TIME_PATTERNS = [
  /^any available/i,
  /^morning\s*\(/i,
  /^midday\s*\(/i,
  /^afternoon\s*\(/i,
];

function isoDateParts(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return { y, mo, d, day: date.getDay(), iso: `${m[1]}-${m[2]}-${m[3]}` };
}

function toIsoLocal(date) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

function addLocalDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** Earliest selectable preferred date (local calendar day + MIN_ADVANCE_DAYS). */
function earliestBookableIso(now = new Date()) {
  return toIsoLocal(addLocalDays(now, MIN_ADVANCE_DAYS));
}

function computeEasterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function nthWeekdayInMonth(year, monthIndex, weekday, n) {
  let count = 0;
  for (let day = 1; day <= 31; day++) {
    const dt = new Date(year, monthIndex, day);
    if (dt.getMonth() !== monthIndex) break;
    if (dt.getDay() === weekday) {
      count++;
      if (count === n) return toIsoLocal(dt);
    }
  }
  return null;
}

function lastWeekdayInMonth(year, monthIndex, weekday) {
  for (let day = 31; day >= 1; day--) {
    const dt = new Date(year, monthIndex, day);
    if (dt.getMonth() !== monthIndex) continue;
    if (dt.getDay() === weekday) return toIsoLocal(dt);
  }
  return null;
}

function getHolidaySet(year) {
  const easter = computeEasterSunday(year);
  return new Set([
    `${year}-01-01`,
    toIsoLocal(easter),
    lastWeekdayInMonth(year, 4, 1),
    `${year}-07-04`,
    nthWeekdayInMonth(year, 8, 1, 1),
    nthWeekdayInMonth(year, 10, 4, 4),
    `${year}-12-24`,
    `${year}-12-25`,
    `${year}-12-31`,
  ]);
}

function isClosedHoliday(iso) {
  const parts = isoDateParts(iso);
  if (!parts) return false;
  return getHolidaySet(parts.y).has(parts.iso);
}

function slotsForDate(iso) {
  const parts = isoDateParts(iso);
  if (!parts) return [];
  if (parts.day === 0) return [];
  if (isClosedHoliday(parts.iso)) return [];
  if (parts.day === 6) return [...ALLOWED_SATURDAY_SLOTS];
  return [...ALLOWED_WEEKDAY_SLOTS];
}

function normalizePreferredTime(raw) {
  const t = String(raw || '').trim();
  if (!t) return null;
  if (LEGACY_TIME_PATTERNS.some(p => p.test(t))) return null;
  const found = ALLOWED_WEEKDAY_SLOTS.find(
    s => s.toLowerCase() === t.replace(/\s+/g, ' ').toLowerCase()
  );
  return found || null;
}

function validateBookingSchedule(preferredDate, preferredTime, opts = {}) {
  const parts = isoDateParts(preferredDate);
  if (!parts) return { ok: false, error: 'booking_date_unavailable' };
  if (parts.day === 0) return { ok: false, error: 'booking_date_unavailable' };
  if (isClosedHoliday(parts.iso)) return { ok: false, error: 'booking_date_unavailable' };

  const now = opts.now instanceof Date ? opts.now : new Date();
  const minIso = earliestBookableIso(now);
  if (parts.iso < minIso) {
    return { ok: false, error: 'booking_date_unavailable' };
  }

  const normalizedTime = normalizePreferredTime(preferredTime);
  if (!normalizedTime) return { ok: false, error: 'booking_time_unavailable' };

  const allowed = slotsForDate(parts.iso);
  if (!allowed.includes(normalizedTime)) {
    return { ok: false, error: 'booking_time_unavailable' };
  }

  return {
    ok: true,
    preferredDate: parts.iso,
    preferredTime: normalizedTime,
  };
}

function isActiveBookingForSlotLock(booking) {
  if (!booking || booking.isDraft) return false;
  if (booking.archived || booking.isTest) return false;

  const js = normalizeJobStatus(booking);
  if (js === 'cancelled' || js === 'archived_test') return false;

  const appt = String(booking.appointmentStatus || '').toLowerCase();
  if (appt === 'canceled' || appt === 'cancelled' || appt === 'rejected') return false;

  const legacy = String(booking.status || '').toLowerCase();
  if (legacy === 'cancelled' || legacy === 'canceled' || legacy === 'rejected') return false;

  return true;
}

function hasSlotConflict(bookings, preferredDate, preferredTime, excludeId) {
  const time = normalizePreferredTime(preferredTime);
  const parts = isoDateParts(preferredDate);
  if (!parts || !time) return false;

  return (bookings || []).some(b => {
    if (!isActiveBookingForSlotLock(b)) return false;
    if (excludeId && String(b.id) === String(excludeId)) return false;
    const bParts = isoDateParts(b.preferredDate);
    const bTime = normalizePreferredTime(b.preferredTime);
    if (!bParts || !bTime) return false;
    return bParts.iso === parts.iso && bTime === time;
  });
}

module.exports = {
  ALLOWED_WEEKDAY_SLOTS,
  ALLOWED_SATURDAY_SLOTS,
  MIN_ADVANCE_DAYS,
  earliestBookableIso,
  getHolidaySet,
  isClosedHoliday,
  slotsForDate,
  normalizePreferredTime,
  validateBookingSchedule,
  isActiveBookingForSlotLock,
  hasSlotConflict,
};
