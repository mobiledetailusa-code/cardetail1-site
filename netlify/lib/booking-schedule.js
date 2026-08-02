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
/** Active card-save drafts soft-hold a slot for the draft-token TTL window. */
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
  const cof = String(booking.cardOnFileStatus || '').toLowerCase();
  // Only drafts in an active card-save session hold the slot.
  if (cof !== 'pending' && cof !== 'saved') return false;
  const ts = Date.parse(booking.updatedAt || booking.createdAt || '');
  if (!Number.isFinite(ts)) return false;
  return (nowMs - ts) <= DRAFT_SLOT_HOLD_MS;
}

function isActiveBookingForSlotLock(booking, nowMs = Date.now()) {
  if (!booking) return false;
  if (booking.archived || booking.isTest) return false;

  // Soft-hold: recent drafts with an active card-save session occupy the slot so
  // customers cannot save a card against an already-claimed time, then fail finalize.
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

function countSlotOccupancy(bookings, preferredDate, preferredTime, excludeId, nowMs = Date.now()) {
  const time = normalizePreferredTime(preferredTime);
  const parts = availability.isoDateParts(preferredDate);
  if (!parts || !time) return 0;

  let count = 0;
  for (const b of bookings || []) {
    if (!isActiveBookingForSlotLock(b, nowMs)) continue;
    if (excludeId && String(b.id) === String(excludeId)) continue;
    const bParts = availability.isoDateParts(b.preferredDate);
    const bTime = normalizePreferredTime(b.preferredTime);
    if (!bParts || !bTime) continue;
    if (bParts.iso === parts.iso && bTime === time) count += 1;
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
  const used = countSlotOccupancy(bookings, parts.iso, time, excludeId, ts);
  return used >= capacity;
}

function buildOccupancyMap(bookings, nowMs = Date.now()) {
  const map = {};
  for (const b of bookings || []) {
    if (!isActiveBookingForSlotLock(b, nowMs)) continue;
    const parts = availability.isoDateParts(b.preferredDate);
    const time = normalizePreferredTime(b.preferredTime);
    if (!parts || !time) continue;
    const key = `${parts.iso}|${time}`;
    map[key] = (map[key] || 0) + 1;
  }
  return map;
}

module.exports = {
  ALLOWED_WEEKDAY_SLOTS,
  ALLOWED_SATURDAY_SLOTS,
  MIN_ADVANCE_DAYS,
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
  capacityForSlot,
  buildOccupancyMap,
};
