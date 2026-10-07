'use strict';

/**
 * Pin the process clock and hand tests appointment dates that stay in the
 * future relative to that clock. Production schedule code is not involved
 * beyond reading the clock it already uses.
 */

const availability = require('../../netlify/lib/operational-availability');

const FROZEN_AT = '2026-01-05T15:00:00.000Z';

let nativeDate = null;

function installFrozenBookingClock(iso = FROZEN_AT) {
  if (!nativeDate) {
    nativeDate = Date;
    const fixedNow = nativeDate.parse(iso);
    class FrozenDate extends nativeDate {
      constructor(...args) {
        super(...(args.length ? args : [fixedNow]));
      }

      static now() {
        return fixedNow;
      }
    }
    global.Date = FrozenDate;
  }
  return frozenBookingDates();
}

function restoreFrozenBookingClock() {
  if (nativeDate) {
    global.Date = nativeDate;
    nativeDate = null;
  }
}

function addIsoDays(iso, days) {
  const parts = availability.isoDateParts(iso);
  if (!parts) throw new Error(`invalid iso date ${iso}`);
  return availability.toIsoLocal(availability.addLocalDays(new Date(parts.y, parts.mo - 1, parts.d), days));
}

function clockNow() {
  return new Date();
}

function isFullWeekday(iso) {
  const slots = availability.slotsForDate(iso, null, clockNow());
  return ['8:00 AM', '10:00 AM', '12:00 PM', '2:00 PM'].every((time) => slots.includes(time));
}

function futureFullWeekdays(count, { minLeadDays = 7 } = {}) {
  const out = [];
  let cursor = addIsoDays(availability.businessTodayIso(availability.DEFAULT_BUSINESS_TIMEZONE, clockNow()), minLeadDays);
  for (let guard = 0; out.length < count && guard < 400; guard += 1) {
    if (isFullWeekday(cursor)) out.push(cursor);
    cursor = addIsoDays(cursor, 1);
  }
  if (out.length < count) throw new Error(`needed ${count} open weekdays, found ${out.length}`);
  return out;
}

function spanStarts(count) {
  const out = [];
  let cursor = addIsoDays(availability.businessTodayIso(availability.DEFAULT_BUSINESS_TIMEZONE, clockNow()), 7);
  for (let guard = 0; out.length < count && guard < 500; guard += 1) {
    const next = addIsoDays(cursor, 1);
    if (isFullWeekday(cursor) && isFullWeekday(next)) {
      out.push(cursor);
      cursor = addIsoDays(cursor, 7);
    } else {
      cursor = addIsoDays(cursor, 1);
    }
  }
  if (out.length < count) throw new Error(`needed ${count} span starts, found ${out.length}`);
  return out;
}

function futureClosedSunday() {
  let cursor = addIsoDays(availability.businessTodayIso(availability.DEFAULT_BUSINESS_TIMEZONE, clockNow()), 1);
  for (let guard = 0; guard < 21; guard += 1) {
    const parts = availability.isoDateParts(cursor);
    const slots = availability.slotsForDate(cursor, null, clockNow());
    if (parts && parts.day === 0 && !slots.length && !availability.isClosedHoliday(cursor)) return cursor;
    cursor = addIsoDays(cursor, 1);
  }
  throw new Error('no future closed Sunday relative to the frozen clock');
}

function frozenBookingDates() {
  return { futureFullWeekdays, spanStarts, futureClosedSunday, addIsoDays };
}

module.exports = {
  FROZEN_AT,
  installFrozenBookingClock,
  restoreFrozenBookingClock,
  addIsoDays,
};
