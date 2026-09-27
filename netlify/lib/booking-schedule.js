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

const EXTENDED_APPOINTMENT_MESSAGE = 'Extended appointment: this service requires multiple service days. All dates will be reserved before payment.';

function nextOpenDay(dateIso, config) {
  const parts = availability.isoDateParts(dateIso);
  if (!parts) return null;
  let cursor = new Date(parts.y, parts.mo - 1, parts.d);
  for (let i = 0; i < 21; i += 1) {
    cursor = availability.addLocalDays(cursor, 1);
    const iso = availability.toIsoLocal(cursor);
    const slots = slotsForDate(iso, config);
    if (slots.length) return { iso, slots };
  }
  return null;
}

function bookingHasInteriorCompanion(booking) {
  if (!booking || typeof booking !== 'object') return false;
  if (booking.companionInterior === true) return true;
  return (Array.isArray(booking.vehicles) ? booking.vehicles : []).some((vehicle) => (
    vehicle && (vehicle.companionInterior === true || vehicle.companionInterior === 'true')
  ));
}

/**
 * Ceramic + Interior duration that does not fit the remaining day.
 * A late start is rejected. The first slot of the day keeps the full duration
 * and spills leading slots onto the next open day. The duration is not compressed.
 */
function planCombinedAppointment(dateIso, startTime, durationMinutes, config) {
  const base = spannedSlotTimes(dateIso, startTime, durationMinutes, config);
  const daySlots = slotsForDate(dateIso, config);
  if (!base.ok) {
    const next = daySlots[0]
      ? { date: dateIso, time: daySlots[0] }
      : null;
    const later = next ? null : nextOpenDay(dateIso, config);
    return {
      ok: false,
      error: base.error || 'ceramic_duration_exceeds_day',
      slots: [],
      extendedAppointment: true,
      message: EXTENDED_APPOINTMENT_MESSAGE,
      nextValidStart: next || (later ? { date: later.iso, time: later.slots[0] } : null),
    };
  }
  if (!base.exceedsGrid) {
    return {
      ok: true,
      multiDay: false,
      exceedsGrid: false,
      extendedAppointment: false,
      days: [{ date: dateIso, slots: base.slots.slice() }],
      slots: base.slots.slice(),
    };
  }
  const needed = occupancySpanCount(durationMinutes);
  const days = [{ date: dateIso, slots: base.slots.slice() }];
  let remaining = needed - base.slots.length;
  let cursor = dateIso;
  while (remaining > 0) {
    const nxt = nextOpenDay(cursor, config);
    if (!nxt) {
      return {
        ok: false,
        error: 'ceramic_duration_exceeds_day',
        slots: [],
        extendedAppointment: true,
        message: EXTENDED_APPOINTMENT_MESSAGE,
        nextValidStart: null,
      };
    }
    const take = Math.min(remaining, nxt.slots.length);
    days.push({ date: nxt.iso, slots: nxt.slots.slice(0, take) });
    remaining -= take;
    cursor = nxt.iso;
  }
  return {
    ok: true,
    multiDay: days.length > 1,
    exceedsGrid: true,
    extendedAppointment: true,
    message: EXTENDED_APPOINTMENT_MESSAGE,
    days,
    slots: days[0].slots.slice(),
  };
}

function storedScheduleDays(booking) {
  const days = booking && booking.appointmentSchedule && booking.appointmentSchedule.days;
  if (!Array.isArray(days) || !days.length) return null;
  return days;
}

function plannedDaysForBooking(booking, config) {
  const stored = storedScheduleDays(booking);
  if (stored) return stored;
  if (!bookingHasInteriorCompanion(booking)) return null;
  const parts = availability.isoDateParts(booking.preferredDate);
  if (!parts) return null;
  const plan = planCombinedAppointment(parts.iso, booking.preferredTime, booking.appointmentDurationMinutes, config);
  if (!plan.ok || !plan.days) return null;
  return plan.days;
}

function bookingCoversSlot(booking, iso, time, config) {
  const planned = plannedDaysForBooking(booking, config);
  if (planned) {
    const day = planned.find((row) => row && row.date === iso);
    if (!day) return false;
    return (day.slots || []).includes(time);
  }
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

/**
 * Same span submit-booking reserves: interior companion may continue on the
 * next open day; every other duration stays on spannedSlotTimes.
 * Occupancy is the public map `{ 'YYYY-MM-DD|8:00 AM': count }`.
 */
function startFitsDemand(dateIso, startTime, opts = {}) {
  const minutes = Number(opts.durationMinutes);
  const companion = opts.companionInterior === true && Number.isFinite(minutes) && minutes > 120;
  const span = companion
    ? planCombinedAppointment(dateIso, startTime, minutes, opts.config)
    : spannedSlotTimes(dateIso, startTime, minutes, opts.config);
  if (!span.ok) {
    return {
      ok: false,
      error: span.error || 'ceramic_duration_exceeds_day',
      userMessage: span.message || null,
      nextValidStart: span.nextValidStart || null,
      span,
    };
  }
  const days = Array.isArray(span.days) && span.days.length
    ? span.days
    : [{ date: dateIso, slots: span.slots || [] }];
  const occupancy = opts.occupancy || {};
  const now = opts.now instanceof Date ? opts.now : new Date();
  for (const day of days) {
    for (const slot of day.slots || []) {
      const cap = capacityForSlot(day.date, slot, opts.config, now);
      const used = Number(occupancy[`${day.date}|${slot}`]) || 0;
      if (used >= cap) {
        return { ok: false, error: 'booking_slot_unavailable', span };
      }
    }
  }
  return { ok: true, span, preferredDate: dateIso, preferredTime: startTime };
}

/**
 * First eligible start whose full span fits, matching submit-booking's
 * pickFreeEligibleSlot decision: duration misses are not reported as a taken
 * slot unless some fitting start is actually occupied.
 */
function pickEligibleStart(dateIso, eligible, opts = {}) {
  let durationFailure = null;
  let occupied = false;
  for (const slot of eligible || []) {
    const fit = startFitsDemand(dateIso, slot, opts);
    if (!fit.ok && fit.error !== 'booking_slot_unavailable') {
      if (!durationFailure) durationFailure = fit;
      continue;
    }
    if (!fit.ok) {
      occupied = true;
      continue;
    }
    return { slot, durationFailure: null, span: fit.span };
  }
  if (!occupied && durationFailure) return { slot: null, durationFailure };
  return { slot: null, durationFailure: null };
}

function buildOccupancyMap(bookings, nowMs = Date.now(), config) {
  const map = {};
  for (const b of bookings || []) {
    if (!isActiveBookingForSlotLock(b, nowMs)) continue;
    const planned = plannedDaysForBooking(b, config);
    if (planned) {
      for (const day of planned) {
        for (const time of day.slots || []) {
          const key = `${day.date}|${time}`;
          map[key] = (map[key] || 0) + 1;
        }
      }
      continue;
    }
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
  nextOpenDay,
  normalizePreferredTime,
  validateBookingSchedule,
  isActiveBookingForSlotLock,
  hasSlotConflict,
  countSlotOccupancy,
  occupancySpanCount,
  spannedSlotTimes,
  planCombinedAppointment,
  bookingHasInteriorCompanion,
  bookingCoversSlot,
  capacityForSlot,
  startFitsDemand,
  pickEligibleStart,
  buildOccupancyMap,
};
