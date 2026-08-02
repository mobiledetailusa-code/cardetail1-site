/**
 * Booking conversion production readiness — utilities, supervised weekends,
 * flexible dates, recovery contract, and instrumentation.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const {
  slotsForDate,
  validateBookingSchedule,
  normalizeAvailabilityConfig,
  resolveActiveWeekendMode,
  findNearbyOpenings,
  LEGACY_AVAILABILITY,
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
  formatSiteAccessLines,
  WATER_LABELS,
  ELECTRIC_LABELS,
  siteAccessForMessaging,
} = require('../netlify/lib/site-access');
const { projectBookingForCustomer } = require('../netlify/lib/ops-schema');
const { APPROVED_EVENTS, APPROVED_PROPERTIES } = require('../netlify/lib/revenue-event-schema');
const { schedulingMessageFields } = require('../netlify/lib/booking-transactional-notifications');

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

// ─── Utilities (labels + independent enums) ───────────────────────────────

test('utilities keep yes/no/unsure enums with updated labels', () => {
  assert.equal(WATER_LABELS.yes.includes('faucet') || WATER_LABELS.yes.includes('hose'), true);
  assert.equal(WATER_LABELS.no, 'Not available');
  assert.equal(ELECTRIC_LABELS.yes.includes('outlet'), true);
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
});

test('siteAccessForMessaging exposes utilities for future Twilio', () => {
  const msg = siteAccessForMessaging({ waterAvailable: 'no', electricityAvailable: 'yes' });
  assert.equal(msg.waterAvailable, 'no');
  assert.equal(msg.electricityAvailable, 'yes');
  assert.ok(msg.lines.length >= 2);
});

test('all booking pages keep independent water/electric fields and new labels', () => {
  for (const page of BOOKING_PAGES) {
    const html = read(page);
    assert.match(html, /id="f-water"/);
    assert.match(html, /id="f-electric"/);
    assert.match(html, /value="yes"/);
    assert.match(html, /value="no"/);
    assert.match(html, /value="unsure"/);
    assert.match(html, /outdoor faucet or hose connection/);
    assert.match(html, /standard outlet nearby/);
    assert.match(html, /booking-conversion-ux\.js/);
    assert.match(html, /booking-availability-client\.js/);
  }
});

// ─── Weekend / availability contract ──────────────────────────────────────

test('missing config preserves complete legacy Saturday open / Sunday closed', () => {
  assert.deepEqual(slotsForDate('2026-07-11', null, FIXTURE_NOW), ['8:00 AM', '10:00 AM']); // Sat
  assert.deepEqual(slotsForDate('2026-07-12', null, FIXTURE_NOW), []); // Sun
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
  const resolved = resolveActiveWeekendMode(cfg, FIXTURE_NOW); // Jul 1
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
  assert.deepEqual(slotsForDate('2026-07-11', cfg, now), []); // Sat closed
  assert.deepEqual(slotsForDate('2026-07-12', cfg, now), []); // Sun closed
  assert.ok(scheduleValidate('2026-07-06', '8:00 AM', { now, config: cfg }).ok); // weekday ok
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
  // Another Saturday remains closed
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

// ─── Flexibility ──────────────────────────────────────────────────────────

test('flexibility values normalize and default to exact', () => {
  assert.equal(normalizeScheduleFlexibility(''), 'exact');
  assert.equal(normalizeScheduleFlexibility(null), 'exact');
  assert.equal(normalizeScheduleFlexibility('within_3_days'), 'within_3_days');
  assert.equal(normalizeScheduleFlexibility('earliest_after_date'), 'earliest_after_date');
  assert.equal(normalizeScheduleFlexibility('bogus'), 'exact');
  assert.deepEqual([...FLEXIBILITY_VALUES], ['exact', 'within_3_days', 'earliest_after_date']);
  assert.match(scheduleFlexibilityLabel('within_3_days'), /Flexible within 3 days/);
});

test('customer projection defaults missing flexibility to exact', () => {
  const p = projectBookingForCustomer({ id: 'CD1-Z', preferredDate: '2026-07-10' });
  assert.equal(p.scheduleFlexibility, 'exact');
});

test('customer projection preserves flexibility preference', () => {
  const p = projectBookingForCustomer({
    id: 'CD1-FLEX',
    preferredDate: '2026-07-10',
    preferredTime: '8:00 AM',
    scheduleFlexibility: 'within_3_days',
  });
  assert.equal(p.scheduleFlexibility, 'within_3_days');
  assert.equal(p.preferredDate, '2026-07-10');
});

test('flexibility does not auto-substitute dates in schedule validation', () => {
  const r = validateBookingSchedule('2026-07-06', '8:00 AM', { now: FIXTURE_NOW });
  assert.equal(r.ok, true);
  assert.equal(r.preferredDate, '2026-07-06');
});

test('Twilio schedulingMessageFields expose flexibility + site access', () => {
  const fields = schedulingMessageFields({
    preferredDate: '2026-07-10',
    preferredTime: '8:00 AM',
    scheduleFlexibility: 'earliest_after_date',
    waterAvailable: 'yes',
    electricityAvailable: 'no',
  });
  assert.equal(fields.scheduleFlexibility, 'earliest_after_date');
  assert.equal(fields.siteAccess.waterAvailable, 'yes');
  assert.equal(fields.siteAccess.electricityAvailable, 'no');
});

// ─── Recovery helpers ─────────────────────────────────────────────────────

test('findNearbyOpenings returns later slots without inventing scarcity', () => {
  const openings = findNearbyOpenings('2026-07-06', null, { now: FIXTURE_NOW, limit: 4 });
  assert.ok(openings.length >= 1);
  assert.ok(openings.every((o) => o.preferredDate && o.preferredTime));
});

test('conversion UX asset preserves progress messaging and recovery CTAs', () => {
  const js = read('assets/booking-conversion-ux.js');
  assert.match(js, /That time is no longer available/);
  assert.match(js, /See nearby appointments/);
  assert.match(js, /Find the earliest opening/);
  assert.match(js, /Keep my request active/);
  assert.match(js, /scheduleFlexibility/);
  assert.match(js, /Help us arrive prepared/);
});

test('my-garage renders utilities and flexibility', () => {
  const js = read('assets/my-garage.js');
  assert.match(js, /waterAvailable/);
  assert.match(js, /electricityAvailable/);
  assert.match(js, /scheduleFlexibility/);
  assert.match(js, /Date flexibility/);
});

test('admin-ops includes operational availability management UI', () => {
  const html = read('admin-ops.html');
  assert.match(html, /Operational availability/);
  assert.match(html, /avWeekendMode/);
  assert.match(html, /update_availability/);
  assert.match(html, /upsert_date_override/);
  assert.match(html, /Limited weekend availability/);
  assert.match(html, /scheduleFlexibility/);
});

// ─── Analytics ────────────────────────────────────────────────────────────

test('conversion funnel events are allowlisted without PII properties', () => {
  for (const ev of [
    'utilities_completed', 'date_selected', 'flexibility_selected',
    'weekend_date_selected', 'selected_slot_unavailable', 'nearby_slots_opened',
    'booking_review_reached', 'setup_intent_started',
    'booking_submit_attempted', 'booking_submit_succeeded', 'booking_submit_failed',
  ]) {
    assert.ok(APPROVED_EVENTS.includes(ev), ev);
  }
  for (const prop of ['flexibility_mode', 'weekend_selected', 'funnel_step', 'device_type', 'error_code']) {
    assert.ok(APPROVED_PROPERTIES.includes(prop), prop);
  }
  assert.ok(!APPROVED_PROPERTIES.includes('email'));
  assert.ok(!APPROVED_PROPERTIES.includes('phone'));
});

// ─── Backend wiring ───────────────────────────────────────────────────────

test('submit-booking persists scheduleFlexibility and loads availability config', () => {
  const js = read('netlify/functions/submit-booking.js');
  assert.match(js, /scheduleFlexibility/);
  assert.match(js, /getOperationalAvailability/);
  assert.match(js, /normalizeScheduleFlexibility/);
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
