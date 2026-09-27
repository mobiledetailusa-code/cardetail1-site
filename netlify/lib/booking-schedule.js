/**
 * Booking schedule rules — server-authoritative slot validation + duplicate lock.
 *
 * Schedule/weekend resolution delegates to operational-availability (canonical
 * contract). Slot occupancy / draft soft-holds remain here.
 */
const { normalizeJobStatus } = require('./ops-schema');
const availability = require('./operational-availability');

const ALLOWED_WEEKDAY_SLOTS = availability.ALLOWED_WEEKDAY_SLOTS;
const ALLOWED_SATURDAY_SLOTS = availability.ALLOWED_SATURDAY_SLOTS;
const MIN_ADVANCE_DAYS = availability.MIN_ADVANCE_DAYS;
const SAME_DAY_LEAD_MINUTES = availability.SAME_DAY_LEAD_MINUTES;
const SAME_DAY_LATE_SLOT = availability.SAME_DAY_LATE_SLOT;
/** Dated drafts soft-hold a slot for the draft-token TTL window. */
const DRAFT_SLOT_HOLD_MS = 2 * 60 * 60 * 1000;

const earliestBookableIso = availability.earliestBookableIso;
const getHolidaySet = availability.getHolidaySet;
const isClosedHoliday = availability.isClosedHoliday;
const normalizePreferredTime = availability.normalizePreferredTime;

/** Legacy-compatible: optional config; missing/invalid → complete legacy behavior. */
function slotsForDate(iso, config, now) {
  return availability.slotsForDate(iso, config, now);
}

function validateBookingSchedule(preferredDate, preferredTime, opts = {}) {
  return availability.validateBookingSchedule(preferredDate, preferredTime, opts);
}

function capacityForSlot(iso, preferredTime, config, now) {
  return availability.capacityForSlot(iso, preferredTime, config, now);
}

function isActiveDraftSlotHold(booking, nowMs = Date.now()) {
  if (!booking || booking.isDraft !== true) return false;
  if (booking.archived || booking.isTest) return false;
  if (!availability.isoDateParts(booking.preferredDate) || !normalizePreferredTime(booking.preferredTime)) {
    return false;
  }
  const ts = Date.parse(booking.updatedAt || booking.createdAt || '');
  if (!Number.isFinite(ts)) return false;
  return (nowMs - ts) <= DRAFT_SLOT_HOLD_MS;
}

function isActiveBookingForSlotLock(booking, nowMs = Date.now()) {
  if (!booking) return false;
  if (booking.archived || booking.isTest) return false;

  // Soft-hold: a recent dated draft occupies the slot, including cash and
  // card-at-service requests that never open a card-save session.
  if (booking.isDraft === true || String(booking.kind || '').toLowerCase() === 'draft') {
    return isActiveDraftSlotHold(booking, nowMs);
  }

  const js = normalizeJobStatus(booking);
  if (js === 'cancelled' || js === 'archived_test') return false;

  const appt = String(booking.appointmentStatus || '').toLowerCase();
  if (appt === 'canceled' || appt === 'cancelled' || appt === 'rejected') return false;

  const legacy = String(booking.status || '').toLowerCase();
  if (legacy === 'cancelled' || legacy === 'canceled' || legacy === 'rejected') return false;

  return true;
}

/**
 * How many 2-hour grid slots a stored duration occupies.
 * Missing or short durations stay on the historical single-slot hold so
 * existing services do not change capacity.
 */
function occupancySpanCount(durationMinutes) {
  const minutes = Number(durationMinutes);
  if (!Number.isFinite(minutes) || minutes <= 120) return 1;
  return Math.ceil(minutes / 120);
}

/**
 * Consecutive slots a booking holds, starting at preferredTime.
 * A duration longer than the remaining day is an all-day hold only when it
 * starts on the first slot. That keeps a 10-hour ceramic job from being
 * stacked on a shorter grid without opening a second slot model.
 */
function spannedSlotTimes(dateIso, startTime, durationMinutes, config) {
  const slots = slotsForDate(dateIso, config);
  const time = normalizePreferredTime(startTime);
  if (!time) return { ok: false, error: 'booking_time_unavailable', slots: [] };
  if (!slots.length || !slots.includes(time)) {
    return { ok: false, error: 'booking_time_unavailable', slots: [] };
  }
  const minutes = Number(durationMinutes);
  if (!Number.isFinite(minutes) || minutes <= 120) {
    return { ok: true, slots: [time] };
  }
  const needed = occupancySpanCount(minutes);
  const idx = slots.indexOf(time);
  const available = slots.length - idx;
  if (needed <= available) {
    return { ok: true, slots: slots.slice(idx, idx + needed) };
  }
  if (idx === 0) {
    return { ok: true, slots: slots.slice(), exceedsGrid: true };
  }
  return { ok: false, error: 'ceramic_duration_exceeds_day', slots: [] };
}

function bookingCoversSlot(booking, iso, time, config) {
  const parts = availability.isoDateParts(booking && booking.preferredDate);
  if (!parts || parts.iso !== iso) return false;
  const span = spannedSlotTimes(iso, booking.preferredTime, booking.appointmentDurationMinutes, config);
  if (!span.ok) {
    const start = normalizePreferredTime(booking.preferredTime);
    return start === time;
  }
  return span.slots.includes(time);
}

function countSlotOccupancy(bookings, preferredDate, preferredTime, excludeId, nowMs = Date.now(), config) {
  const time = normalizePreferredTime(preferredTime);
  const parts = availability.isoDateParts(preferredDate);
  if (!parts || !time) return 0;

  let count = 0;
  for (const b of bookings || []) {
    if (!isActiveBookingForSlotLock(b, nowMs)) continue;
    if (excludeId && String(b.id) === String(excludeId)) continue;
    if (bookingCoversSlot(b, parts.iso, time, config)) count += 1;
  }
  return count;
}

/**
 * Slot conflict respecting per-date override capacity (default 1).
 * Signature remains backward compatible; optional config is 6th arg or opts object.
 */
function hasSlotConflict(bookings, preferredDate, preferredTime, excludeId, nowMs = Date.now(), config) {
  let cfg = config;
  let ts = nowMs;
  if (nowMs && typeof nowMs === 'object' && !(nowMs instanceof Date) && !Array.isArray(nowMs)) {
    // hasSlotConflict(bookings, date, time, excludeId, { nowMs, config })
    cfg = nowMs.config;
    ts = nowMs.nowMs != null ? nowMs.nowMs : Date.now();
  }
  const time = normalizePreferredTime(preferredTime);
  const parts = availability.isoDateParts(preferredDate);
  if (!parts || !time) return false;
  const capacity = capacityForSlot(parts.iso, time, cfg, new Date(ts));
  const used = countSlotOccupancy(bookings, parts.iso, time, excludeId, ts, cfg);
  return used >= capacity;
}

function buildOccupancyMap(bookings, nowMs = Date.now(), config) {
  const map = {};
  for (const b of bookings || []) {
    if (!isActiveBookingForSlotLock(b, nowMs)) continue;
    const parts = availability.isoDateParts(b.preferredDate);
    if (!parts) continue;
    const span = spannedSlotTimes(parts.iso, b.preferredTime, b.appointmentDurationMinutes, config);
    const times = span.ok ? span.slots : [normalizePreferredTime(b.preferredTime)].filter(Boolean);
    for (const time of times) {
      const key = `${parts.iso}|${time}`;
      map[key] = (map[key] || 0) + 1;
    }
  }
  return map;
}

module.exports = {
  ALLOWED_WEEKDAY_SLOTS,
  ALLOWED_SATURDAY_SLOTS,
  MIN_ADVANCE_DAYS,
  SAME_DAY_LEAD_MINUTES,
  SAME_DAY_LATE_SLOT,
  DRAFT_SLOT_HOLD_MS,
  earliestBookableIso,
  isActiveDraftSlotHold,
  getHolidaySet,
  isClosedHoliday,
  slotsForDate,
  normalizePreferredTime,
  validateBookingSchedule,
  isActiveBookingForSlotLock,
  hasSlotConflict,
  countSlotOccupancy,
  occupancySpanCount,
  spannedSlotTimes,
  bookingCoversSlot,
  capacityForSlot,
  buildOccupancyMap,
};
