'use strict';

/**
 * Operational Availability V2 — Phase 1 bulk scheduling (pure planner and the
 * real ops-settings handler with in-memory stores).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCasMemoryStore } = require('./helpers/cas-memory-store');
const { planBulkAvailability, MAX_BULK_DAYS } = require('../netlify/lib/availability-bulk');
const { slotIndexKey, setSlotIndexStoreOverride } = require('../netlify/lib/slot-index');
const opsConfig = require('../netlify/lib/ops-config');

// 10:00 AM New York, Friday 2026-11-27.
const NOW = new Date('2026-11-27T15:00:00.000Z');
const WEEKEND = ['8:00 AM', '10:00 AM'];

const PROD = {
  version: 1,
  businessTimezone: 'America/New_York',
  weekendMode: 'supervised',
  supervisedEffectiveDate: '2026-12-27',
  dateOverrides: {
    '2026-12-05': { enabled: true, capacity: 1, arrivalWindows: WEEKEND },
    '2026-12-06': { enabled: true, capacity: 1, arrivalWindows: WEEKEND },
    '2026-12-13': { enabled: false, capacity: 1, note: 'family event' },
  },
  revision: 7,
};

function weekendsRequest(extra = {}) {
  return { action: 'open', from: '2026-12-01', to: '2027-01-31', weekdays: [0, 6], ...extra };
}

// ─── Pure planner ──────────────────────────────────────────────────────────

test('open all weekends: creates bounded overrides, skips protected dates', () => {
  const plan = planBulkAvailability(PROD, weekendsRequest(), { now: NOW });
  assert.equal(plan.ok, true);
  const by = Object.fromEntries(plan.dates.map((d) => [d.date, d]));
  assert.equal(plan.summary.matchedDates, 18);
  assert.equal(by['2026-12-05'].change, 'unchanged', 'existing identical opening');
  assert.equal(by['2026-12-13'].change, 'protected_skipped', 'explicit closure is protected');
  assert.equal(by['2026-12-13'].protected, 'closure_exception');
  assert.equal(by['2027-01-02'].change, 'create');
  assert.equal(by['2027-01-02'].after.open, true);
  assert.equal(by['2027-01-02'].before.open, true, 'legacy Saturday open today…');
  assert.equal(plan.nextOverrides['2027-01-02'].enabled, true, '…but pinned open before the 12-27 activation');
  assert.ok(plan.dates.every((d) => d.date >= '2026-12-01' && d.date <= '2027-01-31'));
  assert.ok(plan.dates.every((d) => [0, 6].includes(new Date(`${d.date}T12:00:00Z`).getUTCDay())));
  assert.equal(plan.nextOverrides['2026-12-13'].enabled, false, 'closure untouched');
  assert.equal(plan.nextOverrides['2026-12-13'].note, 'family event');
});

test('a holiday inside a bulk opening is protected until explicitly included', () => {
  const req = { action: 'open', from: '2026-12-21', to: '2026-12-31', weekdays: [1, 2, 3, 4, 5] };
  const skipped = planBulkAvailability(PROD, req, { now: NOW });
  const hol = skipped.dates.filter((d) => d.holiday).map((d) => [d.date, d.change, d.protected]);
  assert.deepEqual(hol, [
    ['2026-12-24', 'protected_skipped', 'holiday'],
    ['2026-12-25', 'protected_skipped', 'holiday'],
    ['2026-12-31', 'protected_skipped', 'holiday'],
  ]);
  assert.equal(skipped.summary.create, 0, 'ordinary weekdays are already open — no override bloat');
  const included = planBulkAvailability(PROD, { ...req, includeProtected: ['2026-12-24'] }, { now: NOW });
  const eve = included.dates.find((d) => d.date === '2026-12-24');
  assert.equal(eve.change, 'create');
  assert.equal(eve.after.open, true);
  assert.equal(included.nextOverrides['2026-12-24'].holidayOpening, true);
  assert.equal(included.dates.find((d) => d.date === '2026-12-25').after.open, false);
  assert.notEqual(included.planHash, skipped.planHash);
});

test('closing a range protects explicit openings and flags dates that hold bookings', () => {
  const req = { action: 'close', from: '2026-12-01', to: '2026-12-07', weekdays: [0, 1, 2, 3, 4, 5, 6] };
  const plan = planBulkAvailability(PROD, req, { now: NOW, reservationsByDate: { '2026-12-02': 2 } });
  const by = Object.fromEntries(plan.dates.map((d) => [d.date, d]));
  assert.equal(by['2026-12-05'].protected, 'opening_exception');
  assert.equal(by['2026-12-05'].change, 'protected_skipped');
  assert.equal(by['2026-12-02'].closesWithReservations, true);
  assert.equal(by['2026-12-02'].reservations, 2);
  assert.equal(plan.requiresReservationAck, true);
  assert.equal(plan.summary.closingWithReservations, 1);
  assert.equal(by['2026-12-02'].after.open, false);
});

test('custom windows and capacity apply to every included date', () => {
  const plan = planBulkAvailability(PROD, weekendsRequest({
    from: '2027-01-09', to: '2027-01-17', arrivalWindows: ['4:00 PM', '8:00 AM'], capacity: 2,
  }), { now: NOW });
  for (const d of plan.dates) {
    assert.deepEqual(d.after.windows, ['8:00 AM', '4:00 PM'], d.date);
    assert.equal(d.after.capacity, 2, d.date);
  }
});

test('requests are validated and bounded', () => {
  const bad = (req) => planBulkAvailability(PROD, req, { now: NOW }).error;
  assert.equal(bad(weekendsRequest({ from: '2026-11-01' })), 'date_range_in_past');
  assert.equal(bad(weekendsRequest({ to: '2026-11-30' })), 'invalid_date_range');
  assert.equal(bad(weekendsRequest({ weekdays: [] })), 'weekdays_required');
  assert.equal(bad(weekendsRequest({ action: 'delete' })), 'invalid_bulk_action');
  assert.equal(bad(weekendsRequest({ capacity: 0 })), 'invalid_capacity');
  assert.equal(bad(weekendsRequest({ capacity: 21 })), 'invalid_capacity');
  assert.equal(bad(weekendsRequest({ arrivalWindows: ['9:00 AM'] })), 'invalid_arrival_windows');
  assert.equal(bad(weekendsRequest({ arrivalWindows: [] })), 'invalid_arrival_windows');
  // 120 days inclusive is allowed, 121 is not.
  assert.equal(planBulkAvailability(PROD, { action: 'open', from: '2026-12-01', to: '2027-03-30', weekdays: [0] }, { now: NOW }).ok, true);
  assert.equal(bad({ action: 'open', from: '2026-12-01', to: '2027-03-31', weekdays: [0] }), 'date_range_too_long');
  assert.equal(MAX_BULK_DAYS, 120);
});

test('preview is deterministic and changes when configuration or reservations change', () => {
  const p1 = planBulkAvailability(PROD, weekendsRequest(), { now: NOW });
  const p2 = planBulkAvailability(PROD, weekendsRequest(), { now: NOW });
  assert.equal(p1.planHash, p2.planHash);
  const p3 = planBulkAvailability({ ...PROD, revision: 8 }, weekendsRequest(), { now: NOW });
  assert.notEqual(p1.planHash, p3.planHash);
  const p4 = planBulkAvailability(PROD, weekendsRequest(), { now: NOW, reservationsByDate: { '2027-01-02': 1 } });
  assert.notEqual(p1.planHash, p4.planHash);
});

// ─── Real handler ──────────────────────────────────────────────────────────

function fakeIndexStore(keys) {
  const store = new Set(keys);
  return {
    _keys: store,
    list(opts) {
      const prefix = (opts && opts.prefix) || '';
      const blobs = [...store].filter((key) => key.startsWith(prefix)).map((key) => ({ key }));
      if (opts && opts.paginate) return (async function* pages() { yield { blobs }; })();
      return Promise.resolve({ blobs });
    },
    setJSON() { throw new Error('bulk availability must never write the slot index'); },
    delete() { throw new Error('bulk availability must never delete reservations'); },
  };
}

function booked(date, time, id) {
  return slotIndexKey({ slotDate: date, slotTime: time, state: 'booked', expiresAtMs: 0, bookingId: id });
}

function loadHandler() {
  const security = require('../netlify/lib/tech-security');
  security.verifyAdminKey = async () => ({ ok: true, username: 'owner-test' });
  delete require.cache[require.resolve('../netlify/functions/ops-settings')];
  return require('../netlify/functions/ops-settings').handler;
}

function post(handler, body) {
  return handler({
    httpMethod: 'POST',
    headers: { origin: 'https://cardetail1.com', 'x-admin-key': 't' },
    body: JSON.stringify(body),
  }).then((res) => ({ status: res.statusCode, body: JSON.parse(res.body) }));
}

test('handler: preview → apply writes exactly the previewed overrides and never touches bookings', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW.getTime() });
  process.env.SLOT_INDEX_READS = '1';
  const avail = createCasMemoryStore({ availability: PROD });
  opsConfig.setAvailabilityStoreOverride(avail);
  const index = fakeIndexStore([booked('2027-01-02', '8:00 AM', 'CD1-A'), booked('2027-01-02', '10:00 AM', 'CD1-A')]);
  setSlotIndexStoreOverride(index);
  const keysBefore = [...index._keys].sort();
  t.after(() => { opsConfig.setAvailabilityStoreOverride(null); setSlotIndexStoreOverride(null); });
  const handler = loadHandler();

  const preview = await post(handler, { action: 'preview_bulk_availability', request: weekendsRequest() });
  assert.equal(preview.status, 200);
  const jan2 = preview.body.preview.dates.find((d) => d.date === '2027-01-02');
  assert.equal(jan2.reservations, 1, 'one booking spanning two windows counts once');

  const stale = await post(handler, { action: 'apply_bulk_availability', request: weekendsRequest(), planHash: 'nope' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'preview_stale');

  const applied = await post(handler, {
    action: 'apply_bulk_availability',
    request: weekendsRequest(),
    planHash: preview.body.preview.planHash,
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const expected = preview.body.preview.changes.length;
  assert.equal(applied.body.applied, expected);
  const saved = (await avail.getWithMetadata('availability', { type: 'json' })).data;
  assert.equal(saved.revision, 8);
  assert.equal(saved.updatedBy, 'owner-test');
  for (const c of preview.body.preview.changes) {
    assert.deepEqual(saved.dateOverrides[c.date], c.override, c.date);
  }
  assert.equal(saved.dateOverrides['2026-12-13'].enabled, false, 'protected closure kept');
  assert.equal(saved.dateOverrides['2026-12-13'].note, 'family event');
  assert.deepEqual([...index._keys].sort(), keysBefore, 'reservations untouched');

  // The same preview cannot be applied twice: the revision moved on.
  const again = await post(handler, {
    action: 'apply_bulk_availability',
    request: weekendsRequest(),
    planHash: preview.body.preview.planHash,
  });
  assert.equal(again.status, 409);
});

test('handler: closing dates with bookings requires acknowledgement and keeps the bookings', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW.getTime() });
  process.env.SLOT_INDEX_READS = '1';
  const avail = createCasMemoryStore({ availability: PROD });
  opsConfig.setAvailabilityStoreOverride(avail);
  const index = fakeIndexStore([booked('2026-12-02', '8:00 AM', 'CD1-B')]);
  setSlotIndexStoreOverride(index);
  t.after(() => { opsConfig.setAvailabilityStoreOverride(null); setSlotIndexStoreOverride(null); });
  const handler = loadHandler();
  const req = { action: 'close', from: '2026-12-01', to: '2026-12-03', weekdays: [1, 2, 3, 4, 5] };
  const preview = await post(handler, { action: 'preview_bulk_availability', request: req });
  assert.equal(preview.body.preview.requiresReservationAck, true);
  const refused = await post(handler, { action: 'apply_bulk_availability', request: req, planHash: preview.body.preview.planHash });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'reservation_ack_required');
  const ok = await post(handler, {
    action: 'apply_bulk_availability', request: req, planHash: preview.body.preview.planHash, acknowledgeReservations: true,
  });
  assert.equal(ok.status, 200);
  assert.ok(index._keys.has(booked('2026-12-02', '8:00 AM', 'CD1-B')), 'booking still holds its slot');
});

test('handler: two tabs applying at once — one wins, the other gets a conflict', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW.getTime() });
  process.env.SLOT_INDEX_READS = '1';
  const avail = createCasMemoryStore({ availability: PROD });
  opsConfig.setAvailabilityStoreOverride(avail);
  setSlotIndexStoreOverride(fakeIndexStore([]));
  t.after(() => { opsConfig.setAvailabilityStoreOverride(null); setSlotIndexStoreOverride(null); });
  const handler = loadHandler();
  const reqA = weekendsRequest();
  const reqB = { action: 'close', from: '2027-01-04', to: '2027-01-08', weekdays: [1, 2, 3, 4, 5] };
  const [pa, pb] = await Promise.all([
    post(handler, { action: 'preview_bulk_availability', request: reqA }),
    post(handler, { action: 'preview_bulk_availability', request: reqB }),
  ]);
  const results = await Promise.all([
    post(handler, { action: 'apply_bulk_availability', request: reqA, planHash: pa.body.preview.planHash }),
    post(handler, { action: 'apply_bulk_availability', request: reqB, planHash: pb.body.preview.planHash }),
  ]);
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 409]);
  const saved = (await avail.getWithMetadata('availability', { type: 'json' })).data;
  assert.equal(saved.revision, 8, 'exactly one write landed');
});

test('handler: single-date holiday opening needs the explicit flag', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW.getTime() });
  const avail = createCasMemoryStore({ availability: PROD });
  opsConfig.setAvailabilityStoreOverride(avail);
  t.after(() => opsConfig.setAvailabilityStoreOverride(null));
  const handler = loadHandler();
  const refused = await post(handler, { action: 'upsert_date_override', date: '2026-12-24', override: { enabled: true } });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'holiday_opening_confirmation_required');
  const ok = await post(handler, {
    action: 'upsert_date_override', date: '2026-12-24', expectedRevision: 7,
    override: { enabled: true, holidayOpening: true, arrivalWindows: ['8:00 AM'] },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.availability.dateOverrides['2026-12-24'].holidayOpening, true);
  const stale = await post(handler, { action: 'remove_date_override', date: '2026-12-24', expectedRevision: 7 });
  assert.equal(stale.status, 409, 'stale tab cannot remove');
  assert.equal(stale.body.error, 'version_conflict');
});

test('handler: unreadable configuration → admin sees an error, never legacy defaults', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(global, 'setTimeout', (fn) => { fn(); return 0; });
  opsConfig.setAvailabilityStoreOverride({ async getWithMetadata() { throw new Error('blobs down'); } });
  t.after(() => opsConfig.setAvailabilityStoreOverride(null));
  const handler = loadHandler();
  const ops = require('../netlify/lib/ops-config');
  t.mock.method(ops, 'getOpsSettings', async () => ({}));
  for (const action of ['get_availability', 'effective_calendar', 'preview_bulk_availability', 'update_availability', 'upsert_date_override']) {
    const res = await post(handler, { action, date: '2026-12-05', override: { enabled: true }, request: weekendsRequest() });
    assert.equal(res.status, 503, action);
    assert.equal(res.body.error, 'availability_unavailable', action);
    assert.equal(res.body.availability, undefined, action);
  }
});

test('handler: effective calendar reports bookings and the activation cliff', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW.getTime() });
  process.env.SLOT_INDEX_READS = '1';
  opsConfig.setAvailabilityStoreOverride(createCasMemoryStore({ availability: PROD }));
  setSlotIndexStoreOverride(fakeIndexStore([booked('2026-12-05', '8:00 AM', 'CD1-C')]));
  t.after(() => { opsConfig.setAvailabilityStoreOverride(null); setSlotIndexStoreOverride(null); });
  const handler = loadHandler();
  const res = await post(handler, { action: 'effective_calendar', days: 56 });
  assert.equal(res.status, 200);
  assert.equal(res.body.reservationsVerified, true);
  const by = Object.fromEntries(res.body.calendar.days.map((d) => [d.date, d]));
  assert.equal(by['2026-12-05'].reservations, 1);
  assert.equal(by['2026-12-13'].open, false);
  assert.equal(by['2027-01-02'].afterActivation.open, false);
  assert.equal(res.body.calendar.pendingActivation, '2026-12-27');
});

test('handler: bulk preview fails closed when reservations cannot be checked', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW.getTime() });
  t.mock.method(console, 'warn', () => {});
  process.env.SLOT_INDEX_READS = '1';
  opsConfig.setAvailabilityStoreOverride(createCasMemoryStore({ availability: PROD }));
  setSlotIndexStoreOverride({ list() { throw new Error('index down'); } });
  t.after(() => { opsConfig.setAvailabilityStoreOverride(null); setSlotIndexStoreOverride(null); });
  const handler = loadHandler();
  const res = await post(handler, { action: 'preview_bulk_availability', request: weekendsRequest() });
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'reservations_unverified');
});
