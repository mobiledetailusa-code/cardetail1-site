/**
 * Booking conversion — compact details UX, arrival windows, alternate date,
 * utilities, recovery contract, and instrumentation.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = (() => {
  try { return { JSDOM: require('jsdom').JSDOM }; }
  catch { return { JSDOM: null }; }
})();

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const {
  slotsForDate,
  validateBookingSchedule,
  normalizeAvailabilityConfig,
  resolveActiveWeekendMode,
  findNearbyOpenings,
  capacityForSlot,
} = require('../netlify/lib/operational-availability');
const {
  hasSlotConflict,
  slotsForDate: scheduleSlots,
  validateBookingSchedule: scheduleValidate,
} = require('../netlify/lib/booking-schedule');
const {
  normalizeScheduleFlexibility,
  FLEXIBILITY_VALUES,
  scheduleFlexibilityLabel,
} = require('../netlify/lib/schedule-flexibility');
const {
  ARRIVAL_WINDOW_VALUES,
  ARRIVAL_WINDOW_LABELS,
  normalizeArrivalWindow,
  arrivalWindowLabel,
  resolveOperationalSlot,
  isValidArrivalWindow,
  eligibleOperationalSlots,
  availableArrivalWindows,
  ERROR_ARRIVAL_WINDOW_UNAVAILABLE,
} = require('../netlify/lib/arrival-windows');
const {
  formatSiteAccessLines,
  WATER_LABELS,
  ELECTRIC_LABELS,
  siteAccessForMessaging,
} = require('../netlify/lib/site-access');
const { projectBookingForCustomer } = require('../netlify/lib/ops-schema');
const { APPROVED_EVENTS, APPROVED_PROPERTIES } = require('../netlify/lib/revenue-event-schema');
const { schedulingMessageFields } = require('../netlify/lib/booking-transactional-notifications');
const {
  ALLOWED_WEEKDAY_SLOTS,
  KNOWN_OPERATIONAL_SLOTS,
  normalizePreferredTime,
} = require('../netlify/lib/operational-availability');

const FIXTURE_NOW = new Date(2026, 6, 1); // Wed Jul 1, 2026
const BOOKING_PAGES = [
  'index.html',
  'bergen-county-hub.html',
  'hudson-county-hub.html',
  'essex-county-hub.html',
  'passaic-county-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
  'new-jersey-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'template-city.html',
];

function extractBs4(html) {
  const a = html.indexOf('id="bs4"');
  const b = html.indexOf('id="bs5"', a);
  return a >= 0 ? html.slice(a, b > a ? b : a + 8000) : '';
}

// ─── Utilities ────────────────────────────────────────────────────────────

test('utilities keep yes/no/unsure enums with compact labels', () => {
  assert.match(WATER_LABELS.yes, /Yes/);
  assert.equal(WATER_LABELS.no, 'No');
  assert.match(ELECTRIC_LABELS.yes, /Yes/);
  assert.equal(ELECTRIC_LABELS.unsure, 'Not sure');
});

test('independent water/electric combinations format correctly', () => {
  const combos = [
    { waterAvailable: 'yes', electricityAvailable: 'no' },
    { waterAvailable: 'no', electricityAvailable: 'yes' },
    { waterAvailable: 'yes', electricityAvailable: 'yes' },
    { waterAvailable: 'no', electricityAvailable: 'no' },
    { waterAvailable: 'unsure', electricityAvailable: 'yes' },
    { waterAvailable: 'no', electricityAvailable: 'unsure' },
  ];
  for (const c of combos) {
    const lines = formatSiteAccessLines(c);
    assert.ok(lines.some((l) => l.startsWith('Water:')));
    assert.ok(lines.some((l) => l.startsWith('Electricity:')));
  }
});

test('existing booking without utilities remains valid in customer projection', () => {
  const p = projectBookingForCustomer({ id: 'CD1-OLD', preferredDate: '2026-07-10' });
  assert.equal(p.waterAvailable, '');
  assert.equal(p.electricityAvailable, '');
  assert.equal(p.scheduleFlexibility, 'exact');
  assert.equal(p.preferredArrivalWindow, '');
});

test('siteAccessForMessaging exposes utilities for future Twilio', () => {
  const msg = siteAccessForMessaging({ waterAvailable: 'no', electricityAvailable: 'yes' });
  assert.equal(msg.waterAvailable, 'no');
  assert.equal(msg.electricityAvailable, 'yes');
  assert.ok(msg.lines.length >= 2);
});

test('all booking pages keep compact utilities + arrival window + single notes', () => {
  for (const page of BOOKING_PAGES) {
    const html = read(page);
    const bs4 = extractBs4(html);
    assert.match(html, /id="f-water"/);
    assert.match(html, /id="f-electric"/);
    assert.match(html, /id="f-arrival-window"/);
    assert.match(html, /id="f-has-alternate"/);
    assert.match(html, /Preferred arrival window/);
    assert.match(bs4, /Additional notes — Optional/);
    assert.doesNotMatch(bs4, /id="f-access-notes"/);
    assert.equal((bs4.match(/id="f-notes"/g) || []).length, 1);
    assert.match(html, /outdoor faucet or hose connection/);
    assert.match(html, /standard outlet nearby/);
    assert.match(html, /booking-conversion-ux\.js/);
    assert.match(html, /booking-availability-client\.js/);
  }
});

// ─── Arrival windows ──────────────────────────────────────────────────────

test('every listed preferred-arrival option is valid', () => {
  for (const v of ARRIVAL_WINDOW_VALUES) {
    assert.equal(normalizeArrivalWindow(v), v);
    assert.ok(isValidArrivalWindow(v));
    assert.ok(arrivalWindowLabel(v));
    assert.ok(ARRIVAL_WINDOW_LABELS[v]);
  }
});

test('anytime selection resolves to an operational slot', () => {
  const allowed = ['8:00 AM', '10:00 AM', '12:00 PM', '2:00 PM'];
  const r = resolveOperationalSlot('2026-07-06', 'anytime', allowed);
  assert.equal(r.ok, true);
  assert.equal(r.preferredArrivalWindow, 'anytime');
  assert.equal(r.preferredTime, '8:00 AM');
  assert.deepEqual(r.eligible, allowed);
});

test('invalid arrival window rejected', () => {
  assert.equal(normalizeArrivalWindow('morning'), '');
  assert.equal(isValidArrivalWindow('8:00 AM'), false);
  const r = resolveOperationalSlot('2026-07-06', 'bogus', ['8:00 AM']);
  assert.equal(r.ok, false);
  assert.equal(r.error, ERROR_ARRIVAL_WINDOW_UNAVAILABLE);
});

test('customer window intersects operational slots per product matrix', () => {
  const inventory = ['8:00 AM', '10:00 AM', '12:00 PM', '2:00 PM', '4:00 PM'];
  const expected = {
    '08:00-11:00': ['8:00 AM', '10:00 AM'],
    '09:00-12:00': ['10:00 AM', '12:00 PM'],
    '10:00-13:00': ['10:00 AM', '12:00 PM'],
    '11:00-14:00': ['12:00 PM', '2:00 PM'],
    '12:00-15:00': ['12:00 PM', '2:00 PM'],
    '13:00-16:00': ['2:00 PM', '4:00 PM'],
    '14:00-17:00': ['2:00 PM', '4:00 PM'],
    '15:00-18:00': ['4:00 PM'],
    '16:00-19:00': ['4:00 PM'],
    anytime: inventory.slice(),
  };
  for (const [win, slots] of Object.entries(expected)) {
    assert.deepEqual(eligibleOperationalSlots(win, inventory), slots, win);
    const r = resolveOperationalSlot('2026-07-06', win, inventory);
    assert.equal(r.ok, true, win);
    assert.equal(r.preferredTime, slots[0], win);
  }
});

test('does not silently map to an incompatible operational slot', () => {
  // 8:00 only — 15:00-18:00 needs 4:00 PM
  const r = resolveOperationalSlot('2026-07-06', '15:00-18:00', ['8:00 AM', '10:00 AM']);
  assert.equal(r.ok, false);
  assert.equal(r.error, ERROR_ARRIVAL_WINDOW_UNAVAILABLE);
  // 09:00-12:00 must not pick 8:00 AM
  const morning = resolveOperationalSlot('2026-07-06', '09:00-12:00', ['8:00 AM', '10:00 AM']);
  assert.equal(morning.ok, true);
  assert.equal(morning.preferredTime, '10:00 AM');
});

test('dynamic windows only include those with eligible slots for the date', () => {
  const weekday = ['8:00 AM', '10:00 AM', '12:00 PM', '2:00 PM'];
  const avail = availableArrivalWindows(weekday);
  assert.ok(avail.includes('08:00-11:00'));
  assert.ok(avail.includes('anytime'));
  assert.ok(!avail.includes('15:00-18:00'));
  assert.ok(!avail.includes('16:00-19:00'));
  const withLate = availableArrivalWindows([...weekday, '4:00 PM']);
  assert.ok(withLate.includes('15:00-18:00'));
  assert.ok(withLate.includes('16:00-19:00'));
});

test('legacy weekday defaults omit 4:00 PM; known inventory supports it', () => {
  assert.deepEqual([...ALLOWED_WEEKDAY_SLOTS], ['8:00 AM', '10:00 AM', '12:00 PM', '2:00 PM']);
  assert.ok(KNOWN_OPERATIONAL_SLOTS.includes('4:00 PM'));
  assert.equal(normalizePreferredTime('4:00 PM'), '4:00 PM');
  assert.equal(normalizePreferredTime('16:00'), '4:00 PM');
  assert.deepEqual(slotsForDate('2026-07-06', null, FIXTURE_NOW), [...ALLOWED_WEEKDAY_SLOTS]);
});

test('helper text explains three-hour availability semantics', () => {
  const html = read('index.html');
  assert.match(html, /We may arrive at any time during this window/);
  assert.match(html, /This is not the service duration/);
  assert.match(html, /We.?ll confirm your arrival window before the appointment/);
  assert.match(html, /Best chance of confirming your preferred date/);
  assert.match(html, /Choose a 3-hour arrival window/);
  assert.match(html, /Any time that day/);
  assert.match(html, /Recommended/);
});

test('arrival window maps to operational slot without inventing capacity', () => {
  const allowed = ['8:00 AM', '10:00 AM'];
  const r = resolveOperationalSlot('2026-07-06', '08:00-11:00', allowed);
  assert.equal(r.ok, true);
  assert.equal(r.preferredTime, '8:00 AM');
  const empty = resolveOperationalSlot('2026-07-06', '08:00-11:00', []);
  assert.equal(empty.ok, false);
});

test('existing booking without preferredArrivalWindow remains readable', () => {
  const p = projectBookingForCustomer({
    id: 'CD1-LEGACY-TIME',
    preferredDate: '2026-07-10',
    preferredTime: '8:00 AM',
  });
  assert.equal(p.preferredTime, '8:00 AM');
  assert.equal(p.preferredArrivalWindow, '');
});

test('payload contract fields present in index buildBookingPayload', () => {
  const html = read('index.html');
  assert.match(html, /preferredArrivalWindow/);
  assert.match(html, /alternatePreferredDate/);
  assert.match(html, /alternateArrivalWindow/);
  assert.match(html, /scheduleFlexibility/);
});

test('arrival window does not appear in pricing / amount paths', () => {
  const submit = read('netlify/functions/submit-booking.js');
  // Window may be persisted, but must not drive travel/total math.
  assert.doesNotMatch(submit, /preferredArrivalWindow\s*\*\s*|amountCents.*preferredArrivalWindow/);
  const travel = read('netlify/lib/travel-fee.js');
  assert.doesNotMatch(travel, /preferredArrivalWindow|alternateArrivalWindow/);
});

// ─── Alternate date / flexibility ─────────────────────────────────────────

test('flexibility values normalize including alternate_date and legacy', () => {
  assert.equal(normalizeScheduleFlexibility(''), 'exact');
  assert.equal(normalizeScheduleFlexibility(null), 'exact');
  assert.equal(normalizeScheduleFlexibility('alternate_date'), 'alternate_date');
  assert.equal(normalizeScheduleFlexibility('within_3_days'), 'within_3_days');
  assert.equal(normalizeScheduleFlexibility('earliest_after_date'), 'earliest_after_date');
  assert.equal(normalizeScheduleFlexibility('bogus'), 'exact');
  assert.ok(FLEXIBILITY_VALUES.includes('exact'));
  assert.ok(FLEXIBILITY_VALUES.includes('alternate_date'));
  assert.ok(FLEXIBILITY_VALUES.includes('within_3_days'));
  assert.ok(FLEXIBILITY_VALUES.includes('earliest_after_date'));
  assert.match(scheduleFlexibilityLabel('within_3_days'), /Flexible within 3 days/);
  assert.match(scheduleFlexibilityLabel('alternate_date'), /alternate/i);
});

test('customer projection preserves flexibility and alternate fields', () => {
  const p = projectBookingForCustomer({
    id: 'CD1-FLEX',
    preferredDate: '2026-07-10',
    preferredTime: '8:00 AM',
    preferredArrivalWindow: '08:00-11:00',
    scheduleFlexibility: 'alternate_date',
    alternatePreferredDate: '2026-07-11',
    alternateArrivalWindow: 'anytime',
  });
  assert.equal(p.scheduleFlexibility, 'alternate_date');
  assert.equal(p.preferredArrivalWindow, '08:00-11:00');
  assert.equal(p.alternatePreferredDate, '2026-07-11');
  assert.equal(p.alternateArrivalWindow, 'anytime');
});

test('legacy scheduleFlexibility values remain readable', () => {
  const p = projectBookingForCustomer({
    id: 'CD1-LEGACY-FLEX',
    preferredDate: '2026-07-10',
    preferredTime: '8:00 AM',
    scheduleFlexibility: 'within_3_days',
  });
  assert.equal(p.scheduleFlexibility, 'within_3_days');
});

test('flexibility does not auto-substitute dates in schedule validation', () => {
  const r = validateBookingSchedule('2026-07-06', '8:00 AM', { now: FIXTURE_NOW });
  assert.equal(r.ok, true);
  assert.equal(r.preferredDate, '2026-07-06');
});

test('Twilio schedulingMessageFields expose arrival + alternate + notes', () => {
  const fields = schedulingMessageFields({
    preferredDate: '2026-07-10',
    preferredTime: '8:00 AM',
    preferredArrivalWindow: '08:00-11:00',
    scheduleFlexibility: 'alternate_date',
    alternatePreferredDate: '2026-07-12',
    alternateArrivalWindow: 'anytime',
    waterAvailable: 'yes',
    electricityAvailable: 'no',
    notes: 'Gate code 9',
  });
  assert.equal(fields.preferredArrivalWindow, '08:00-11:00');
  assert.match(fields.preferredArrivalWindowLabel, /8:00 AM/);
  assert.equal(fields.alternatePreferredDate, '2026-07-12');
  assert.match(fields.alternateArrivalWindowLabel, /Any time/i);
  assert.equal(fields.notes, 'Gate code 9');
  assert.equal(fields.siteAccess.waterAvailable, 'yes');
});

// ─── Weekend / availability regression ────────────────────────────────────

test('missing config preserves complete legacy Saturday open / Sunday closed', () => {
  assert.deepEqual(slotsForDate('2026-07-11', null, FIXTURE_NOW), ['8:00 AM', '10:00 AM']);
  assert.deepEqual(slotsForDate('2026-07-12', null, FIXTURE_NOW), []);
  assert.deepEqual(slotsForDate('2026-07-06', null, FIXTURE_NOW), ['8:00 AM', '10:00 AM', '12:00 PM', '2:00 PM']);
});

test('invalid config does not partially merge — falls back to legacy', () => {
  const bad = normalizeAvailabilityConfig({ version: 99, weekendMode: 'nope', dateOverrides: { x: 1 } });
  assert.equal(bad.weekendMode, 'legacy');
  assert.deepEqual(slotsForDate('2026-07-11', bad, FIXTURE_NOW), ['8:00 AM', '10:00 AM']);
});

test('supervised mode without effective date stays legacy', () => {
  const cfg = normalizeAvailabilityConfig({
    version: 1,
    weekendMode: 'supervised',
    supervisedEffectiveDate: null,
  });
  assert.equal(cfg.weekendMode, 'legacy');
});

test('supervised mode before effective date stays legacy', () => {
  const cfg = {
    version: 1,
    weekendMode: 'supervised',
    supervisedEffectiveDate: '2026-08-01',
    dateOverrides: {},
  };
  const resolved = resolveActiveWeekendMode(cfg, FIXTURE_NOW);
  assert.equal(resolved.mode, 'legacy');
  assert.deepEqual(slotsForDate('2026-07-11', cfg, FIXTURE_NOW), ['8:00 AM', '10:00 AM']);
});

test('supervised mode after effective date closes weekends by default', () => {
  const cfg = {
    version: 1,
    weekendMode: 'supervised',
    supervisedEffectiveDate: '2026-07-01',
    dateOverrides: {},
  };
  const now = new Date(2026, 6, 2);
  assert.deepEqual(slotsForDate('2026-07-11', cfg, now), []);
  assert.deepEqual(slotsForDate('2026-07-12', cfg, now), []);
  assert.ok(scheduleValidate('2026-07-06', '8:00 AM', { now, config: cfg }).ok);
});

test('specifically opened Saturday is selectable in supervised mode', () => {
  const cfg = {
    version: 1,
    weekendMode: 'supervised',
    supervisedEffectiveDate: '2026-07-01',
    dateOverrides: {
      '2026-07-11': { enabled: true, capacity: 2, arrivalWindows: ['8:00 AM', '10:00 AM'] },
    },
  };
  const now = new Date(2026, 6, 2);
  assert.deepEqual(slotsForDate('2026-07-11', cfg, now), ['8:00 AM', '10:00 AM']);
  assert.equal(validateBookingSchedule('2026-07-11', '8:00 AM', { now, config: cfg }).ok, true);
  assert.deepEqual(slotsForDate('2026-07-18', cfg, now), []);
});

test('specifically opened Sunday is selectable in supervised mode', () => {
  const cfg = {
    version: 1,
    weekendMode: 'supervised',
    supervisedEffectiveDate: '2026-07-01',
    dateOverrides: {
      '2026-07-12': { enabled: true, capacity: 1, arrivalWindows: ['8:00 AM'] },
    },
  };
  const now = new Date(2026, 6, 2);
  assert.deepEqual(slotsForDate('2026-07-12', cfg, now), ['8:00 AM']);
  assert.equal(validateBookingSchedule('2026-07-12', '8:00 AM', { now, config: cfg }).ok, true);
});

test('capacity prevents overbooking on opened weekend date', () => {
  const cfg = {
    version: 1,
    weekendMode: 'supervised',
    supervisedEffectiveDate: '2026-07-01',
    dateOverrides: {
      '2026-07-11': { enabled: true, capacity: 2, arrivalWindows: ['8:00 AM', '10:00 AM'] },
    },
  };
  const bookings = [
    { id: 'A', preferredDate: '2026-07-11', preferredTime: '8:00 AM', jobStatus: 'confirmed' },
    { id: 'B', preferredDate: '2026-07-11', preferredTime: '8:00 AM', jobStatus: 'confirmed' },
  ];
  assert.equal(capacityForSlot('2026-07-11', '8:00 AM', cfg), 2);
  assert.equal(hasSlotConflict(bookings, '2026-07-11', '8:00 AM', null, Date.now(), cfg), true);
  assert.equal(hasSlotConflict(bookings.slice(0, 1), '2026-07-11', '8:00 AM', null, Date.now(), cfg), false);
});

test('weekday availability unchanged under supervised weekends', () => {
  const cfg = {
    version: 1,
    weekendMode: 'supervised',
    supervisedEffectiveDate: '2026-07-01',
    dateOverrides: {},
  };
  const now = new Date(2026, 6, 2);
  assert.deepEqual(scheduleSlots('2026-07-06', cfg, now), ['8:00 AM', '10:00 AM', '12:00 PM', '2:00 PM']);
});

test('booking-schedule still exports legacy Saturdays without config (regression)', () => {
  assert.deepEqual(scheduleSlots('2026-07-11'), ['8:00 AM', '10:00 AM']);
  assert.equal(scheduleValidate('2026-07-11', '8:00 AM', { now: FIXTURE_NOW }).ok, true);
});

// ─── Compact form DOM structure ───────────────────────────────────────────

test('compact form collapses flexibility cards and dual notes', () => {
  const html = read('index.html');
  const bs4 = extractBs4(html);
  assert.doesNotMatch(bs4, /Exact date only/);
  assert.doesNotMatch(bs4, /Flexible within 3 days/);
  assert.doesNotMatch(bs4, /First available on or after/);
  assert.match(bs4, /I have an alternate date/);
  assert.match(bs4, /bk-alt-fields/);
  assert.doesNotMatch(bs4, /Access notes \(optional\)/);
  assert.match(bs4, /Review details/);
});

test('conversion UX preserves recovery CTAs and does not inject radio cards', () => {
  const js = read('assets/booking-conversion-ux.js');
  assert.match(js, /That time is no longer available/);
  assert.match(js, /See nearby appointments/);
  assert.match(js, /Find the earliest opening/);
  assert.match(js, /Keep my request active/);
  assert.match(js, /scheduleFlexibility/);
  assert.match(js, /preferredArrivalWindow/);
  assert.match(js, /alternatePreferredDate/);
  assert.match(js, /refreshArrivalWindowsForDates/);
  assert.match(js, /eligibleSlotsForWindow/);
  assert.doesNotMatch(js, /bk-seg-opt/);
  assert.match(js, /accessNotes = ''/);
});

test('admin-ops supports optional 4:00 PM operational windows', () => {
  const html = read('admin-ops.html');
  assert.match(html, /weekday_late/);
  assert.match(html, /4:00 PM/);
  assert.match(html, /not enabled on every date by default/i);
});

test('submit-booking returns arrival_window_unavailable when incompatible', () => {
  const js = read('netlify/functions/submit-booking.js');
  assert.match(js, /arrival_window_unavailable/);
  assert.match(js, /eligibleOperationalSlots/);
});

test('my-garage renders preferred arrival + alternate + utilities', () => {
  const js = read('assets/my-garage.js');
  assert.match(js, /preferredArrivalWindow/);
  assert.match(js, /alternatePreferredDate/);
  assert.match(js, /waterAvailable/);
  assert.match(js, /electricityAvailable/);
  assert.match(js, /Pending confirmation/);
  assert.match(js, /Additional notes/);
});

test('admin-ops displays arrival windows and alternate fields', () => {
  const html = read('admin-ops.html');
  assert.match(html, /Preferred arrival window/);
  assert.match(html, /Alternate date/);
  assert.match(html, /Alternate arrival window/);
  assert.match(html, /Confirmed arrival window/);
  assert.match(html, /Additional notes/);
  assert.match(html, /Operational availability/);
});

test('legacy accessNotes remain readable without duplicating new notes field', () => {
  const lines = formatSiteAccessLines({
    waterAvailable: 'yes',
    accessNotes: 'Gate code 1234',
  });
  assert.match(lines.join('\n'), /Access notes \(legacy\): Gate code 1234/);
  const p = projectBookingForCustomer({
    id: 'CD1-ACC',
    accessNotes: 'Metered parking',
    notes: 'Pet hair',
  });
  assert.equal(p.accessNotes, 'Metered parking');
  assert.equal(p.notes, 'Pet hair');
});

// ─── Layout heuristics (no browser required) ──────────────────────────────

test('desktop compact form significantly reduces Step-4 vertical blocks vs legacy pattern', () => {
  const bs4 = extractBs4(read('index.html'));
  // Compact: 1 textarea, arrival-preference radios (not a large window card stack), select-based utilities.
  assert.equal((bs4.match(/<textarea/g) || []).length, 1);
  const radios = (bs4.match(/type="radio"/g) || []).length;
  assert.equal(radios, 4, 'primary + alternate mode radios only');
  assert.ok((bs4.match(/<select/g) || []).length >= 4);
  assert.match(bs4, /bk-arrival-choices/);
  assert.match(bs4, /id="f-arrival-window-select"/);
  const selectChunk = bs4.slice(
    bs4.indexOf('id="f-arrival-window-select"'),
    bs4.indexOf('</select>', bs4.indexOf('id="f-arrival-window-select"')) + 9
  );
  assert.doesNotMatch(selectChunk, /value="anytime"/);
  const helpers = (bs4.match(/bk-field-help|bk-util-help|bk-flex-help/g) || []).length;
  assert.ok(helpers <= 12, 'helper count should stay bounded');
});

test('mobile overflow guards present for compact form', () => {
  const js = read('assets/booking-conversion-ux.js');
  assert.match(js, /overflow-x:\s*hidden/);
  assert.match(js, /min-height:44px/);
  assert.match(js, /grid-template-columns:1fr/);
  assert.match(js, /bk-arrival-choices/);
  assert.match(js, /\.bk-arrival-choice:focus-within/);
});

if (JSDOM) {
  test('DOM: alternate checkbox collapsed by default and reveals fields', () => {
    const html = extractBs4(read('index.html'));
    const dom = new JSDOM(`<!DOCTYPE html><html><body><div ${html}</div></body></html>`);
    const doc = dom.window.document;
    const check = doc.getElementById('f-has-alternate');
    const fields = doc.getElementById('bk-alt-fields');
    assert.ok(check);
    assert.ok(fields);
    assert.equal(check.checked, false);
    assert.equal(fields.hidden, true);
    const windows = [...doc.querySelectorAll('#f-arrival-window-select option')].map((o) => o.value).filter(Boolean);
    assert.deepEqual(windows, ARRIVAL_WINDOW_VALUES.filter((w) => w !== 'anytime'));
    assert.ok(!doc.getElementById('f-access-notes'));
    assert.ok(doc.getElementById('f-notes'));
    assert.ok(doc.querySelector('#bs4 .btn-n, .btn-n'));
    assert.equal(doc.getElementById('f-arrival-mode-anytime').checked, false);
    assert.equal(doc.getElementById('f-arrival-mode-specific').checked, false);
  });

  async function mountArrivalUx(slotsByDate) {
    const form = extractBs4(read('index.html'));
    const uxSrc = read('assets/booking-conversion-ux.js');
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body><div ${form}</div>
       <div id="c-date">—</div>
       <script>${uxSrc}</script></body></html>`,
      {
        runScripts: 'dangerously',
        url: 'https://example.com/',
        pretendToBeVisual: true,
        beforeParse(window) {
          window.bkSlotsFor = (iso) => {
            if (!iso) return [];
            if (Object.prototype.hasOwnProperty.call(slotsByDate, iso)) return slotsByDate[iso].slice();
            return ['8:00 AM', '10:00 AM', '12:00 PM', '2:00 PM'];
          };
          window.bkIsoParts = (iso) => {
            const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
            if (!m) return null;
            const d = new Date(+m[1], +m[2] - 1, +m[3]);
            return { iso, day: d.getDay() };
          };
          window.bkHolidays = () => new Set();
          window.bkEarliestBookable = () => '2026-07-04';
          window.bkShowScheduleMsg = () => {};
          window.alert = () => {};
          window.innerWidth = 1440;
        },
      }
    );
    const { window } = dom;
    const doc = window.document;
    assert.ok(window.BkConversion, 'BkConversion should load');
    await window.BkConversion.init();
    assert.ok(doc.getElementById('bk-conversion-styles'), 'styles injected');
    assert.ok(window.BkConversion.primaryArrival, 'primary controller wired');
    return { window, doc, BkConversion: window.BkConversion };
  }

  test('DOM arrival preference: neither choice preselected; anytime/specific progressive disclosure', async () => {
    const { doc, window, BkConversion } = await mountArrivalUx({});
    const anytime = doc.getElementById('f-arrival-mode-anytime');
    const specific = doc.getElementById('f-arrival-mode-specific');
    const select = doc.getElementById('f-arrival-window-select');
    const hidden = doc.getElementById('f-arrival-window');
    const specificWrap = doc.getElementById('bk-arrival-specific');
    const anytimeHelp = doc.getElementById('f-arrival-anytime-help');
    const specificHelp = doc.getElementById('f-arrival-specific-help');

    assert.equal(anytime.checked, false);
    assert.equal(specific.checked, false);
    assert.equal(hidden.value, '');
    assert.equal(specificWrap.hidden, true);

    doc.getElementById('f-date').value = '2026-07-06';
    anytime.checked = true;
    anytime.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(hidden.value, 'anytime');
    assert.equal(specificWrap.hidden, true);
    assert.equal(anytimeHelp.hidden, false);
    assert.equal(select.value, '');

    specific.checked = true;
    anytime.checked = false;
    specific.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(specificWrap.hidden, false);
    assert.equal(hidden.value, '');
    assert.equal(select.value, '');

    const visible = [...select.options].filter((o) => o.value && !o.hidden && !o.disabled).map((o) => o.value);
    assert.ok(visible.includes('08:00-11:00'));
    assert.ok(visible.includes('09:00-12:00'));
    assert.ok(!visible.includes('anytime'));
    assert.ok(!visible.includes('15:00-18:00'));
    assert.ok(!visible.includes('16:00-19:00'));

    select.value = '09:00-12:00';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(hidden.value, '09:00-12:00');
    assert.equal(specificHelp.hidden, false);

    // specific → anytime clears specific value
    anytime.checked = true;
    specific.checked = false;
    anytime.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(hidden.value, 'anytime');
    assert.equal(select.value, '');
    assert.equal(specificWrap.hidden, true);

    // anytime → specific requires a new selection
    specific.checked = true;
    anytime.checked = false;
    specific.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(hidden.value, '');
    assert.equal(select.value, '');

    const sched = window.bkValidateScheduleSelection();
    assert.equal(sched.ok, false);
    assert.match(sched.message, /arrival window/i);

    assert.ok(BkConversion);
    assert.equal(BkConversion.SPECIFIC_WINDOWS.length, 9);
    assert.ok(!BkConversion.SPECIFIC_WINDOWS.includes('anytime'));
    assert.ok(BkConversion.SPECIFIC_WINDOWS.includes('09:00-12:00'));
  });

  test('DOM arrival preference: date change preserves compatible window and clears incompatible', async () => {
    const { doc, window } = await mountArrivalUx({
      '2026-07-06': ['8:00 AM', '10:00 AM', '12:00 PM', '2:00 PM'],
      '2026-07-07': ['8:00 AM', '10:00 AM'],
      '2026-07-08': [],
    });
    const dateEl = doc.getElementById('f-date');
    const specific = doc.getElementById('f-arrival-mode-specific');
    const select = doc.getElementById('f-arrival-window-select');
    const hidden = doc.getElementById('f-arrival-window');
    const compat = doc.getElementById('f-arrival-compat-msg');
    const closed = doc.getElementById('f-arrival-closed-msg');

    dateEl.value = '2026-07-06';
    specific.checked = true;
    specific.dispatchEvent(new window.Event('change', { bubbles: true }));
    window.BkConversion.refreshArrivalWindowsForDates();
    select.value = '09:00-12:00';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(hidden.value, '09:00-12:00');

    dateEl.value = '2026-07-07';
    window.BkConversion.refreshArrivalWindowsForDates();
    assert.equal(hidden.value, '09:00-12:00');
    assert.equal(select.value, '09:00-12:00');
    assert.equal(compat.hidden, true);

    dateEl.value = '2026-07-06';
    window.BkConversion.refreshArrivalWindowsForDates();
    select.value = '14:00-17:00';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(hidden.value, '14:00-17:00');

    dateEl.value = '2026-07-07';
    window.BkConversion.refreshArrivalWindowsForDates();
    assert.equal(hidden.value, '');
    assert.equal(select.value, '');
    assert.equal(compat.hidden, false);
    assert.match(compat.textContent, /isn.?t available on the new date/i);
    assert.equal(doc.getElementById('f-arrival-mode-anytime').checked, false);
    assert.equal(specific.checked, true);

    dateEl.value = '2026-07-08';
    window.BkConversion.refreshArrivalWindowsForDates();
    assert.equal(select.disabled, true);
    assert.equal(closed.hidden, false);
    assert.match(closed.textContent, /choose another date/i);
  });

  test('DOM arrival preference: alternate reuses behavior and creates no hold side effects', async () => {
    const { doc, window } = await mountArrivalUx({});
    const check = doc.getElementById('f-has-alternate');
    check.checked = true;
    check.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(doc.getElementById('bk-alt-fields').hidden, false);

    doc.getElementById('f-alt-date').value = '2026-07-07';
    window.BkConversion.altArrival.refresh({ emit: false });
    const altAnytime = doc.getElementById('f-alt-arrival-mode-anytime');
    const altSpecific = doc.getElementById('f-alt-arrival-mode-specific');
    const altSelect = doc.getElementById('f-alt-arrival-window-select');
    const altHidden = doc.getElementById('f-alt-arrival-window');

    assert.equal(altAnytime.checked, false);
    assert.equal(altSpecific.checked, false);

    altAnytime.checked = true;
    altAnytime.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(altHidden.value, 'anytime');
    assert.equal(doc.getElementById('bk-alt-arrival-specific').hidden, true);

    doc.getElementById('f-date').value = '2026-07-06';
    doc.getElementById('f-arrival-mode-anytime').checked = true;
    doc.getElementById('f-arrival-mode-anytime').dispatchEvent(new window.Event('change', { bubbles: true }));
    window.BkConversion.syncOperationalSlot();
    const primaryTime = doc.getElementById('f-time').value;
    assert.ok(primaryTime);

    altSpecific.checked = true;
    altAnytime.checked = false;
    altSpecific.dispatchEvent(new window.Event('change', { bubbles: true }));
    altSelect.value = '08:00-11:00';
    altSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(altHidden.value, '08:00-11:00');
    assert.equal(doc.getElementById('f-time').value, primaryTime);
    assert.equal(doc.getElementById('f-arrival-window').value, 'anytime');
    assert.equal(doc.getElementById('f-flexibility').value, 'alternate_date');
  });

  test('DOM arrival preference: summary labels and preferredTime stays internal', async () => {
    const { doc, window } = await mountArrivalUx({});
    doc.getElementById('f-date').value = '2026-07-06';
    doc.getElementById('f-arrival-mode-anytime').checked = true;
    doc.getElementById('f-arrival-mode-anytime').dispatchEvent(new window.Event('change', { bubbles: true }));
    window.BkConversion.syncOperationalSlot();
    const internalTime = doc.getElementById('f-time').value;
    assert.ok(internalTime);

    const anytimeSummary = window.BkConversion.customerArrivalSummary('anytime');
    assert.equal(anytimeSummary.label, 'Arrival preference');
    assert.equal(anytimeSummary.value, 'Any time that day');

    const specificSummary = window.BkConversion.customerArrivalSummary('09:00-12:00');
    assert.equal(specificSummary.label, 'Preferred arrival window');
    assert.equal(specificSummary.value, '9:00 AM – 12:00 PM');

    const summary = window.BkConversion.customerArrivalSummary(doc.getElementById('f-arrival-window').value);
    doc.getElementById('c-date').textContent = doc.getElementById('f-date').value + ' · ' + summary.value;
    assert.doesNotMatch(doc.getElementById('c-date').textContent, new RegExp(internalTime.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(doc.getElementById('c-date').textContent, /Any time that day/);

    const anytime = doc.getElementById('f-arrival-mode-anytime');
    anytime.focus();
    assert.equal(doc.activeElement, anytime);
  });

  test('DOM arrival preference: preferredTime derivation unchanged for anytime and specific', async () => {
    const { doc, window } = await mountArrivalUx({
      '2026-07-06': ['8:00 AM', '10:00 AM', '12:00 PM', '2:00 PM', '4:00 PM'],
    });
    doc.getElementById('f-date').value = '2026-07-06';

    doc.getElementById('f-arrival-mode-anytime').checked = true;
    doc.getElementById('f-arrival-mode-anytime').dispatchEvent(new window.Event('change', { bubbles: true }));
    window.BkConversion.syncOperationalSlot();
    assert.equal(doc.getElementById('f-time').value, '8:00 AM');

    doc.getElementById('f-arrival-mode-specific').checked = true;
    doc.getElementById('f-arrival-mode-anytime').checked = false;
    doc.getElementById('f-arrival-mode-specific').dispatchEvent(new window.Event('change', { bubbles: true }));
    const select = doc.getElementById('f-arrival-window-select');
    window.BkConversion.refreshArrivalWindowsForDates();
    select.value = '15:00-18:00';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    window.BkConversion.syncOperationalSlot();
    assert.equal(doc.getElementById('f-time').value, '4:00 PM');

    const r = resolveOperationalSlot('2026-07-06', '15:00-18:00', ['8:00 AM', '10:00 AM', '12:00 PM', '2:00 PM', '4:00 PM']);
    assert.equal(r.preferredTime, '4:00 PM');
  });

  test('DOM arrival preference: mobile 390 and desktop 1440 stay compact without overflow CSS regressions', async () => {
    const { doc, window } = await mountArrivalUx({});
    const style = doc.getElementById('bk-conversion-styles');
    assert.ok(style);
    assert.match(style.textContent, /@media \(max-width:720px\)/);
    assert.match(style.textContent, /\.bk-arrival-choices\{display:grid;grid-template-columns:1fr 1fr/);
    assert.match(style.textContent, /overflow-x:\s*hidden/);
    assert.match(style.textContent, /\.bk-arrival-choice\{[^}]*min-height:44px/);

    window.innerWidth = 390;
    const choices = doc.querySelectorAll('.bk-arrival-choice');
    assert.equal(choices.length, 4);
    window.innerWidth = 1440;
    assert.ok(doc.querySelector('.bk-arrival-choices'));
  });
}

// ─── Analytics / backend wiring ───────────────────────────────────────────

test('conversion funnel events are allowlisted without PII properties', () => {
  for (const ev of [
    'utilities_completed', 'date_selected', 'flexibility_selected',
    'weekend_date_selected', 'selected_slot_unavailable', 'nearby_slots_opened',
    'booking_review_reached', 'setup_intent_started',
    'booking_submit_attempted', 'booking_submit_succeeded', 'booking_submit_failed',
    'arrival_window_selected',
  ]) {
    assert.ok(APPROVED_EVENTS.includes(ev), ev);
  }
  for (const prop of ['flexibility_mode', 'weekend_selected', 'funnel_step', 'device_type', 'error_code']) {
    assert.ok(APPROVED_PROPERTIES.includes(prop), prop);
  }
  assert.ok(!APPROVED_PROPERTIES.includes('email'));
  assert.ok(!APPROVED_PROPERTIES.includes('phone'));
});

test('submit-booking persists arrival window + alternate + flexibility', () => {
  const js = read('netlify/functions/submit-booking.js');
  assert.match(js, /scheduleFlexibility/);
  assert.match(js, /preferredArrivalWindow/);
  assert.match(js, /alternatePreferredDate/);
  assert.match(js, /alternateArrivalWindow/);
  assert.match(js, /getOperationalAvailability/);
  assert.match(js, /normalizeScheduleFlexibility/);
  assert.match(js, /resolveOperationalSlot/);
});

test('ops-settings exposes availability actions', () => {
  const js = read('netlify/functions/ops-settings.js');
  assert.match(js, /update_availability/);
  assert.match(js, /upsert_date_override/);
  assert.match(js, /remove_date_override/);
  assert.match(js, /get_availability/);
});

test('public booking-availability function is GET-only and strips private fields', () => {
  const js = read('netlify/functions/booking-availability.js');
  assert.match(js, /method_not_allowed/);
  assert.match(js, /httpMethod !== 'GET'/);
  assert.doesNotMatch(js, /require\(['"][^'"]*stripe/i);
  assert.doesNotMatch(js, /PaymentIntent/);
  assert.match(js, /no-store|jsonCors/);
  assert.match(js, /MAX_NEARBY_HORIZON_DAYS/);
  const oa = read('netlify/lib/operational-availability.js');
  assert.match(oa, /only enabled overrides/);
  const pubSlice = oa.slice(oa.indexOf('function projectPublicAvailability'), oa.indexOf('function projectAdminAvailability'));
  assert.doesNotMatch(pubSlice, /updatedBy/);
  assert.doesNotMatch(pubSlice, /ov\.note|note:/);
});

test('ops-settings availability mutations require admin auth + origin gate', () => {
  const js = read('netlify/functions/ops-settings.js');
  assert.match(js, /verifyAdminKey/);
  assert.match(js, /allowedAdminOrigin/);
  assert.match(js, /origin_not_allowed/);
  assert.match(js, /version_conflict/);
  assert.match(js, /expectedUpdatedAt/);
});

test('Owner Studio / catalog paths untouched by availability storage key', () => {
  const cfg = read('netlify/lib/ops-config.js');
  assert.match(cfg, /AVAILABILITY_KEY\s*=\s*'availability'/);
  assert.match(cfg, /not OsCatalogDraft/);
  assert.ok(!fs.existsSync(path.join(root, 'netlify/lib/owner-studio-availability.js')));
});

test('findNearbyOpenings returns later slots without inventing scarcity', () => {
  const openings = findNearbyOpenings('2026-07-06', null, { now: FIXTURE_NOW, limit: 4 });
  assert.ok(openings.length >= 1);
  assert.ok(openings.every((o) => o.preferredDate && o.preferredTime));
});

test('recovery UX preserves alternate + arrival fields in messaging', () => {
  const js = read('assets/booking-conversion-ux.js');
  assert.match(js, /alternatePreferredDate/);
  assert.match(js, /preferredArrivalWindow/);
  assert.match(js, /f-alt-date/);
  assert.match(js, /f-arrival-window/);
  assert.match(js, /Your vehicle, services, address, notes/);
});

test('mirror sync check produces no drift', () => {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, ['scripts/sync-booking-conversion-pages.js', '--check'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
