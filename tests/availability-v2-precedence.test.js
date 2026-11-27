'use strict';

/**
 * Operational Availability V2 — Phase 1: rule precedence, holiday openings,
 * public closed dates, effective calendar, timezone / DST boundaries, and
 * backward compatibility with the pre-Phase-1 resolver.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const a = require('../netlify/lib/operational-availability');

const {
  slotsForDate,
  capacityForSlot,
  validateBookingSchedule,
  resolveDateAvailability,
  resolveActiveWeekendMode,
  projectPublicAvailability,
  projectEffectiveCalendar,
  inspectAvailabilityConfig,
  normalizeDateOverride,
  findNearbyOpenings,
  businessTodayIso,
  RULE_SOURCES,
} = a;

const WEEKDAY = ['8:00 AM', '10:00 AM', '12:00 PM', '2:00 PM'];
const WEEKEND = ['8:00 AM', '10:00 AM'];
// 10:00 AM New York, Friday 2026-11-27.
const NOW = new Date('2026-11-27T15:00:00.000Z');

function cfg(extra = {}) {
  return {
    version: 1,
    businessTimezone: 'America/New_York',
    weekendMode: 'legacy',
    supervisedEffectiveDate: null,
    dateOverrides: {},
    ...extra,
  };
}

/** The production configuration as read (keys only, no notes) on 2026-11-27. */
const PROD_2026_11_27 = cfg({
  weekendMode: 'supervised',
  supervisedEffectiveDate: '2026-12-27',
  dateOverrides: {
    '2026-11-25': { enabled: false, capacity: 1 },
    '2026-11-26': { enabled: false, capacity: 1 },
    '2026-11-28': { enabled: true, capacity: 1, arrivalWindows: WEEKEND },
    '2026-11-29': { enabled: true, capacity: 1, arrivalWindows: WEEKEND },
    '2026-12-05': { enabled: true, capacity: 1, arrivalWindows: WEEKEND },
    '2026-12-06': { enabled: true, capacity: 1, arrivalWindows: WEEKEND },
    '2026-12-12': { enabled: true, capacity: 1, arrivalWindows: WEEKEND },
    '2026-12-13': { enabled: true, capacity: 1, arrivalWindows: WEEKEND },
    '2026-12-19': { enabled: true, capacity: 1, arrivalWindows: WEEKEND },
    '2026-12-20': { enabled: true, capacity: 1, arrivalWindows: WEEKEND },
    '2026-12-26': { enabled: true, capacity: 1, arrivalWindows: WEEKEND },
    '2026-12-27': { enabled: true, capacity: 1, arrivalWindows: WEEKEND },
  },
});

/** Verbatim copy of the pre-Phase-1 resolver (master 7d392e05). */
function legacySlotsForDate(iso, config, now) {
  const parts = a.isoDateParts(iso);
  if (!parts) return [];
  if (a.isClosedHoliday(parts.iso)) return [];
  const resolved = resolveActiveWeekendMode(config, now);
  const c = resolved.config;
  const override = c.dateOverrides[parts.iso];
  let slots = [];
  if (override) {
    if (!override.enabled) return [];
    if (override.arrivalWindows && override.arrivalWindows.length) slots = [...override.arrivalWindows];
    else if (parts.day === 0 || parts.day === 6) slots = [...a.ALLOWED_SATURDAY_SLOTS];
    else slots = [...a.ALLOWED_WEEKDAY_SLOTS];
  } else if (parts.day >= 1 && parts.day <= 5) {
    slots = [...a.ALLOWED_WEEKDAY_SLOTS];
  } else if (resolved.mode === 'supervised') {
    slots = [];
  } else if (parts.day === 0) {
    slots = [];
  } else if (parts.day === 6) {
    slots = [...a.ALLOWED_SATURDAY_SLOTS];
  }
  return a.filterSameDaySlots(parts.iso, slots, now, c.businessTimezone);
}

function* isoRange(from, days) {
  for (const iso of a.horizonIsoDates(from, days)) yield iso;
}

// ─── Every weekday in both modes ───────────────────────────────────────────

test('every day of the week: legacy mode', () => {
  // 2027-01-04 is a Monday.
  const expect = [WEEKDAY, WEEKDAY, WEEKDAY, WEEKDAY, WEEKDAY, WEEKEND, []];
  const sources = ['weekday', 'weekday', 'weekday', 'weekday', 'weekday', 'legacy_saturday', 'legacy_sunday_closed'];
  [...isoRange('2027-01-04', 7)].forEach((iso, i) => {
    assert.deepEqual(slotsForDate(iso, cfg(), NOW), expect[i], iso);
    assert.equal(resolveDateAvailability(iso, cfg(), NOW).source, sources[i], iso);
  });
});

test('every day of the week: supervised mode once active, closed weekends', () => {
  const c = cfg({ weekendMode: 'supervised', supervisedEffectiveDate: '2026-11-01' });
  const expect = [WEEKDAY, WEEKDAY, WEEKDAY, WEEKDAY, WEEKDAY, [], []];
  [...isoRange('2027-01-04', 7)].forEach((iso, i) => {
    assert.deepEqual(slotsForDate(iso, c, NOW), expect[i], iso);
  });
  assert.equal(resolveDateAvailability('2027-01-09', c, NOW).source, RULE_SOURCES.SUPERVISED_WEEKEND);
});

test('supervised mode before its activation date keeps legacy weekends', () => {
  const c = cfg({ weekendMode: 'supervised', supervisedEffectiveDate: '2026-12-27' });
  assert.deepEqual(slotsForDate('2027-01-02', c, NOW), WEEKEND, 'Saturday after activation date, booked today');
  assert.deepEqual(slotsForDate('2027-01-03', c, NOW), []);
});

// ─── Overrides and holidays ────────────────────────────────────────────────

test('explicit opening and closure overrides win over the base rule', () => {
  const c = cfg({
    weekendMode: 'supervised',
    supervisedEffectiveDate: '2026-11-01',
    dateOverrides: {
      '2027-01-09': { enabled: true, capacity: 2, arrivalWindows: ['8:00 AM', '4:00 PM'] },
      '2027-01-05': { enabled: false },
      '2027-01-10': { enabled: true },
    },
  });
  assert.deepEqual(slotsForDate('2027-01-09', c, NOW), ['8:00 AM', '4:00 PM']);
  assert.equal(capacityForSlot('2027-01-09', '8:00 AM', c, NOW), 2);
  assert.deepEqual(slotsForDate('2027-01-05', c, NOW), [], 'closed Tuesday');
  assert.equal(resolveDateAvailability('2027-01-05', c, NOW).source, RULE_SOURCES.OVERRIDE_CLOSED);
  assert.deepEqual(slotsForDate('2027-01-10', c, NOW), WEEKEND, 'opened Sunday uses weekend defaults');
  assert.equal(capacityForSlot('2027-01-05', '8:00 AM', c, NOW), 1, 'closed date never reports capacity above 1');
});

test('holidays stay closed unless explicitly opened as a holiday', () => {
  const holidays2026 = ['2026-01-01', '2026-04-05', '2026-05-25', '2026-07-04', '2026-09-07', '2026-11-26', '2026-12-24', '2026-12-25', '2026-12-31'];
  for (const h of holidays2026) assert.ok(a.isClosedHoliday(h), h);
  const c = cfg({
    dateOverrides: {
      '2026-12-24': { enabled: true, holidayOpening: true, capacity: 2, arrivalWindows: ['8:00 AM'] },
      '2026-12-25': { enabled: true, capacity: 1 }, // plain open override — holiday still wins
      '2026-12-31': { enabled: false, holidayOpening: true }, // closed stays closed
    },
  });
  assert.deepEqual(slotsForDate('2026-12-24', c, NOW), ['8:00 AM']);
  assert.equal(capacityForSlot('2026-12-24', '8:00 AM', c, NOW), 2);
  assert.equal(resolveDateAvailability('2026-12-24', c, NOW).source, RULE_SOURCES.HOLIDAY_OPENING);
  assert.deepEqual(slotsForDate('2026-12-25', c, NOW), []);
  assert.equal(resolveDateAvailability('2026-12-25', c, NOW).source, RULE_SOURCES.HOLIDAY);
  assert.deepEqual(slotsForDate('2026-12-31', c, NOW), []);
  assert.equal(resolveDateAvailability('2026-12-31', c, NOW).source, RULE_SOURCES.OVERRIDE_CLOSED);
  assert.equal(validateBookingSchedule('2026-12-24', '8:00 AM', { config: c, now: NOW }).ok, true);
  assert.equal(validateBookingSchedule('2026-12-25', '8:00 AM', { config: c, now: NOW }).error, 'booking_date_unavailable');
});

test('holidayOpening is only stored on an enabled override', () => {
  assert.deepEqual(normalizeDateOverride({ enabled: true, holidayOpening: true }), { enabled: true, capacity: 1, holidayOpening: true });
  assert.deepEqual(normalizeDateOverride({ enabled: false, holidayOpening: true }), { enabled: false, capacity: 1 });
  assert.deepEqual(normalizeDateOverride({ enabled: true, holidayOpening: 'yes' }), { enabled: true, capacity: 1 });
});

// ─── Activation boundaries, timezone and DST ───────────────────────────────

test('supervised activation flips at New York midnight, including on a DST day', () => {
  const c = cfg({ weekendMode: 'supervised', supervisedEffectiveDate: '2027-03-14' });
  // 2027-03-14 starts at 05:00Z (EST, before the 2 AM spring-forward).
  assert.equal(resolveActiveWeekendMode(c, new Date('2027-03-14T04:59:59Z')).mode, 'legacy');
  assert.equal(resolveActiveWeekendMode(c, new Date('2027-03-14T05:00:00Z')).mode, 'supervised');
  const fall = cfg({ weekendMode: 'supervised', supervisedEffectiveDate: '2026-11-01' });
  // 2026-11-01 starts at 04:00Z (EDT, before the 2 AM fall-back).
  assert.equal(resolveActiveWeekendMode(fall, new Date('2026-11-01T03:59:59Z')).mode, 'legacy');
  assert.equal(resolveActiveWeekendMode(fall, new Date('2026-11-01T04:00:00Z')).mode, 'supervised');
});

test('business date and same-day lead time follow America/New_York across DST', () => {
  assert.equal(businessTodayIso('America/New_York', new Date('2027-03-14T04:30:00Z')), '2027-03-13');
  assert.equal(businessTodayIso('America/New_York', new Date('2027-03-14T05:30:00Z')), '2027-03-14');
  assert.equal(businessTodayIso('America/New_York', new Date('2026-11-01T03:30:00Z')), '2026-10-31');
  assert.equal(businessTodayIso('America/New_York', new Date('2026-11-01T04:30:00Z')), '2026-11-01');
  // Spring-forward Sunday opened: 09:00 EDT (13:00Z) → lead 2h → 12 PM onward.
  const spring = cfg({ dateOverrides: { '2027-03-14': { enabled: true, arrivalWindows: WEEKDAY } } });
  assert.deepEqual(slotsForDate('2027-03-14', spring, new Date('2027-03-14T13:00:00Z')), ['12:00 PM', '2:00 PM']);
  // Fall-back Sunday opened: 09:00 EST (14:00Z) → same answer one UTC hour later.
  const fall = cfg({ dateOverrides: { '2026-11-01': { enabled: true, arrivalWindows: WEEKDAY } } });
  assert.deepEqual(slotsForDate('2026-11-01', fall, new Date('2026-11-01T14:00:00Z')), ['12:00 PM', '2:00 PM']);
  // Monday after spring-forward is a normal weekday all day.
  assert.deepEqual(slotsForDate('2027-03-15', cfg(), new Date('2027-03-14T13:00:00Z')), WEEKDAY);
});

// ─── Public projection ─────────────────────────────────────────────────────

test('public snapshot lists closed dates and only applicable openings, without notes', () => {
  const c = cfg({
    weekendMode: 'supervised',
    supervisedEffectiveDate: '2026-12-27',
    dateOverrides: {
      '2026-12-01': { enabled: false, note: 'private' },
      '2026-12-05': { enabled: true, note: 'private', arrivalWindows: WEEKEND },
      '2026-12-24': { enabled: true, holidayOpening: true, note: 'private' },
      '2026-12-25': { enabled: true },
    },
  });
  const snap = projectPublicAvailability(c, { now: NOW });
  assert.equal(snap.status, 'available');
  assert.ok(snap.closedDates.includes('2026-12-01'), 'explicit closure');
  assert.ok(snap.closedDates.includes('2026-12-25'), 'holiday with a plain override');
  assert.ok(snap.closedDates.includes('2026-12-31'), 'holiday');
  assert.ok(snap.closedDates.includes('2027-01-01'), 'holiday');
  assert.ok(!snap.closedDates.includes('2026-12-24'), 'opened holiday');
  assert.ok(!snap.closedDates.includes('2026-12-06'), 'ordinary closed Sunday is a base rule, not listed');
  assert.deepEqual(Object.keys(snap.dateOverrides).sort(), ['2026-12-05', '2026-12-24']);
  assert.equal(snap.dateOverrides['2026-12-24'].holidayOpening, true);
  assert.doesNotMatch(JSON.stringify(snap), /private|updatedBy|note/);
  assert.equal(snap.horizonStart, '2026-11-27');
  assert.equal(snap.horizonEnd, '2027-02-24');
  assert.ok(snap.closedDates.every((d) => d >= snap.horizonStart && d <= snap.horizonEnd));
});

test('nearby openings never land on a closed or holiday date', () => {
  const c = cfg({ dateOverrides: { '2026-12-28': { enabled: false }, '2026-12-24': { enabled: true } } });
  const openings = findNearbyOpenings('2026-12-24', c, { now: NOW, limit: 20, horizonDays: 10 });
  const dates = new Set(openings.map((o) => o.preferredDate));
  for (const closed of ['2026-12-24', '2026-12-25', '2026-12-27', '2026-12-28', '2026-12-31']) {
    assert.ok(!dates.has(closed), closed);
  }
  assert.ok(dates.has('2026-12-26'), 'legacy Saturday still offered');
});

// ─── Effective calendar ────────────────────────────────────────────────────

test('effective calendar shows the January weekend cliff of the production config', () => {
  const cal = projectEffectiveCalendar(PROD_2026_11_27, {
    now: NOW,
    from: '2026-12-26',
    days: 9,
    occupancy: { '2026-12-26|8:00 AM': 1 },
  });
  assert.equal(cal.activeMode, 'legacy');
  assert.equal(cal.pendingActivation, '2026-12-27');
  const by = Object.fromEntries(cal.days.map((d) => [d.date, d]));
  assert.equal(by['2026-12-26'].open, true);
  assert.equal(by['2026-12-26'].booked, 1);
  assert.equal(by['2026-12-27'].open, true, 'explicitly opened Sunday');
  assert.equal(by['2026-12-27'].afterActivation, undefined, 'override keeps it open after activation');
  assert.equal(by['2027-01-02'].open, true, 'legacy Saturday today');
  assert.deepEqual(by['2027-01-02'].afterActivation && by['2027-01-02'].afterActivation.open, false, 'closes once supervised activates');
  assert.equal(by['2026-12-31'].source, RULE_SOURCES.HOLIDAY);
  assert.equal(by['2027-01-03'].afterActivation, undefined, 'Sunday closed either way');
});

// ─── Structural inspection (loader uses this to fail closed) ───────────────

test('inspectAvailabilityConfig separates never-configured from invalid', () => {
  assert.deepEqual(inspectAvailabilityConfig(null), { valid: true, reason: 'not_configured' });
  assert.equal(inspectAvailabilityConfig(PROD_2026_11_27).valid, true);
  assert.equal(inspectAvailabilityConfig('x').reason, 'not_an_object');
  assert.equal(inspectAvailabilityConfig([]).reason, 'not_an_object');
  assert.equal(inspectAvailabilityConfig(cfg({ version: 9 })).reason, 'unsupported_version');
  assert.equal(inspectAvailabilityConfig(cfg({ weekendMode: 'x' })).reason, 'invalid_weekend_mode');
  assert.equal(inspectAvailabilityConfig(cfg({ weekendMode: 'supervised' })).reason, 'supervised_missing_effective_date');
  assert.equal(inspectAvailabilityConfig(cfg({ supervisedEffectiveDate: '2026-13-40' })).reason, 'invalid_effective_date');
  assert.equal(inspectAvailabilityConfig(cfg({ businessTimezone: 'Mars/Base' })).reason, 'invalid_timezone');
  assert.equal(inspectAvailabilityConfig(cfg({ dateOverrides: [] })).reason, 'invalid_date_overrides');
});

// ─── Backward compatibility ────────────────────────────────────────────────

test('production configuration resolves exactly as before Phase 1 (400 days, several clocks)', () => {
  const clocks = [
    NOW,
    new Date('2026-12-26T15:00:00Z'),
    new Date('2026-12-27T15:00:00Z'),
    new Date('2027-01-15T20:30:00Z'),
  ];
  let compared = 0;
  for (const now of clocks) {
    for (const iso of isoRange('2026-11-20', 400)) {
      assert.deepEqual(slotsForDate(iso, PROD_2026_11_27, now), legacySlotsForDate(iso, PROD_2026_11_27, now), `${iso} @ ${now.toISOString()}`);
      compared += 1;
    }
  }
  assert.equal(compared, 1600);
});

test('legacy, null and test configs resolve exactly as before Phase 1', () => {
  const configs = [
    null,
    cfg(),
    cfg({ weekendMode: 'supervised', supervisedEffectiveDate: '2026-11-24', dateOverrides: { '2026-12-05': { enabled: false }, '2026-12-06': { enabled: true, capacity: 3 } } }),
    cfg({ dateOverrides: { '2026-12-25': { enabled: true }, '2026-12-01': { enabled: true, arrivalWindows: ['4:00 PM'] } } }),
  ];
  for (const c of configs) {
    for (const iso of isoRange('2026-11-27', 120)) {
      const now = NOW;
      const before = legacySlotsForDate(iso, c, now);
      assert.deepEqual(slotsForDate(iso, c, now), before, `${iso}`);
      if (before.length) {
        const ov = c && c.dateOverrides && c.dateOverrides[iso];
        const oldCap = ov && ov.enabled ? Math.max(1, Number(ov.capacity) || 1) : 1;
        assert.equal(capacityForSlot(iso, before[0], c, now), Math.min(oldCap, 20), `${iso} capacity`);
      }
    }
  }
});
