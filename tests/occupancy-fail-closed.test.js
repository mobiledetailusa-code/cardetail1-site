'use strict';

/**
 * Public recovery suggestions must never treat unavailable occupancy as empty.
 * booking-availability nearby / selection / check_slot answer 503
 * booking_verification_unavailable when neither the slot index nor a complete,
 * bounded store scan can establish occupancy. Calendar-only actions keep
 * working, and healthy-index behavior is unchanged.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { useDefaultAvailabilityStore } = require('./helpers/availability-store');
const { slotIndexKey, setSlotIndexStoreOverride } = require('../netlify/lib/slot-index');
const { setOpsStoreOverride } = require('../netlify/lib/ops-db');

// 10:00 AM New York, Friday 2026-11-27.
const NOW_MS = Date.parse('2026-11-27T15:00:00.000Z');
const WEEKEND = ['8:00 AM', '10:00 AM'];
const WEEKDAY = ['8:00 AM', '10:00 AM', '12:00 PM', '2:00 PM'];
const CONFIG = {
  version: 1,
  businessTimezone: 'America/New_York',
  weekendMode: 'supervised',
  supervisedEffectiveDate: '2026-11-01',
  dateOverrides: {
    '2026-12-06': { enabled: true, capacity: 1, arrivalWindows: WEEKEND }, // opened Sunday
    '2026-12-08': { enabled: false, capacity: 1 }, // closed Tuesday
  },
};

function booked(date, time, id) {
  return slotIndexKey({ slotDate: date, slotTime: time, state: 'booked', expiresAtMs: 0, bookingId: id });
}

/** Slot index fake; `failPrefixes` makes listing a date fail (partial read). */
function indexStore(keys, { failAll = false, failPrefixes = [] } = {}) {
  const set = new Set(keys);
  return {
    list({ prefix = '' } = {}) {
      if (failAll || failPrefixes.some((p) => prefix.startsWith(p))) throw new Error('index unavailable');
      const blobs = [...set].filter((k) => k.startsWith(prefix)).map((key) => ({ key }));
      return (async function* pages() { yield { blobs }; })();
    },
  };
}

/** cd1-bookings fake for the strict scan fallback. */
function bookingStore(records, { listFails = false, unreadable = [] } = {}) {
  const data = new Map(records.map((r) => [r.id, r]));
  return {
    list() {
      if (listFails) throw new Error('store list failed');
      const blobs = [...data.keys()].map((key) => ({ key }));
      return (async function* pages() { yield { blobs }; })();
    },
    async getWithMetadata(key) {
      if (unreadable.includes(key)) throw new Error('read failed');
      return data.has(key) ? { data: data.get(key), etag: 'e' } : null;
    },
    async get(key) { return data.has(key) ? data.get(key) : null; },
  };
}

function bookingRecord(id, date, time) {
  return {
    id, bookingId: id, kind: 'booking', isDraft: false,
    preferredDate: date, preferredTime: time,
    appointmentStatus: 'confirmed', jobStatus: 'confirmed', status: 'Confirmed',
    createdAt: '2026-11-20T15:00:00.000Z', updatedAt: '2026-11-20T15:00:00.000Z',
  };
}

function loadHandler() {
  delete require.cache[require.resolve('../netlify/functions/booking-availability')];
  return require('../netlify/functions/booking-availability').handler;
}

async function call(handler, q) {
  const res = await handler({ httpMethod: 'GET', headers: { 'x-forwarded-for': '198.51.100.7' }, queryStringParameters: q });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

function setup(t, { index, store } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW_MS });
  t.mock.method(console, 'warn', () => {});
  process.env.SLOT_INDEX_READS = '1';
  useDefaultAvailabilityStore(CONFIG);
  setSlotIndexStoreOverride(index || indexStore([]));
  setOpsStoreOverride(store || bookingStore([]));
  t.after(() => {
    setSlotIndexStoreOverride(null);
    setOpsStoreOverride(null);
    useDefaultAvailabilityStore();
    delete process.env.SLOT_SCAN_TIMEOUT_MS;
  });
  return loadHandler();
}

// Thursday 2026-12-03 fully booked; Friday 12-04 has 8 AM booked.
const FULL_THU = WEEKDAY.map((t, i) => booked('2026-12-03', t, `CD1-THU-${i}`));
const FRI_8 = booked('2026-12-04', '8:00 AM', 'CD1-FRI-8');

const openingsKey = (body) => body.openings.map((o) => `${o.preferredDate} ${o.preferredTime}`);

// ─── Healthy index (behavior unchanged) ────────────────────────────────────

test('healthy index: suggestions skip full dates, booked windows, closed dates and holidays', async (t) => {
  const handler = setup(t, { index: indexStore([...FULL_THU, FRI_8]) });
  const r = await call(handler, { action: 'nearby', fromDate: '2026-12-03', limit: '8', horizonDays: '7' });
  assert.equal(r.status, 200);
  const got = openingsKey(r.body);
  assert.ok(!got.some((x) => x.startsWith('2026-12-03')), 'fully booked Thursday is not suggested');
  assert.ok(!got.includes('2026-12-04 8:00 AM'), 'booked window is not suggested');
  assert.ok(got.includes('2026-12-04 10:00 AM'), 'free window on the same day is suggested');
  assert.ok(got.includes('2026-12-06 8:00 AM'), 'opened Sunday is suggested');
  assert.ok(!got.some((x) => x.startsWith('2026-12-05')), 'supervised Saturday stays closed');
});

test('healthy index: selection and check_slot report the true state', async (t) => {
  const handler = setup(t, { index: indexStore([...FULL_THU, FRI_8]) });
  const full = await call(handler, { action: 'selection', preferredDate: '2026-12-03', preferredArrivalWindow: 'anytime' });
  assert.deepEqual([full.status, full.body.available, full.body.error], [200, false, 'booking_slot_unavailable']);
  const free = await call(handler, { action: 'selection', preferredDate: '2026-12-04', preferredArrivalWindow: 'anytime' });
  assert.deepEqual([free.status, free.body.available, free.body.preferredTime], [200, true, '10:00 AM']);
  const taken = await call(handler, { action: 'check_slot', preferredDate: '2026-12-04', preferredTime: '8:00 AM' });
  assert.deepEqual([taken.status, taken.body.available], [200, false]);
  const open = await call(handler, { action: 'check_slot', preferredDate: '2026-12-06', preferredTime: '8:00 AM' });
  assert.deepEqual([open.status, open.body.available], [200, true]);
  const closed = await call(handler, { action: 'selection', preferredDate: '2026-12-08', preferredArrivalWindow: 'anytime' });
  assert.equal(closed.body.available, false, 'closed override');
  const holiday = await call(handler, { action: 'selection', preferredDate: '2026-12-24', preferredArrivalWindow: 'anytime' });
  assert.equal(holiday.body.available, false, 'holiday');
});

// ─── Index down, complete scan available ───────────────────────────────────

test('index unavailable but a complete scan succeeds: same answers as the index', async (t) => {
  const records = [
    ...WEEKDAY.map((time, i) => bookingRecord(`CD1-THU-${i}`, '2026-12-03', time)),
    bookingRecord('CD1-FRI-8', '2026-12-04', '8:00 AM'),
  ];
  const handler = setup(t, { index: indexStore([], { failAll: true }), store: bookingStore(records) });
  const r = await call(handler, { action: 'nearby', fromDate: '2026-12-03', limit: '8', horizonDays: '7' });
  assert.equal(r.status, 200);
  const got = openingsKey(r.body);
  assert.ok(!got.some((x) => x.startsWith('2026-12-03')));
  assert.ok(!got.includes('2026-12-04 8:00 AM'));
  assert.ok(got.includes('2026-12-04 10:00 AM'));
  const sel = await call(handler, { action: 'selection', preferredDate: '2026-12-04', preferredArrivalWindow: '08:00-11:00' });
  assert.equal(sel.body.preferredTime, '10:00 AM', 'occupied 8 AM is skipped');
});

// ─── Occupancy cannot be established → fail closed ─────────────────────────

const UNVERIFIABLE = [
  ['index and store listing both fail', { index: indexStore([], { failAll: true }), store: bookingStore([], { listFails: true }) }],
  ['index fails and one record is unreadable (partial scan)', {
    index: indexStore([], { failAll: true }),
    store: bookingStore([bookingRecord('CD1-A', '2026-12-04', '8:00 AM'), bookingRecord('CD1-B', '2026-12-04', '10:00 AM')], { unreadable: ['CD1-B'] }),
  }],
  ['index fails for a single date (partial index) and the scan fails', {
    index: indexStore([FRI_8], { failPrefixes: ['2026-12-04/'] }),
    store: bookingStore([], { listFails: true }),
  }],
];

for (const [name, stores] of UNVERIFIABLE) {
  test(`${name}: nearby, selection and check_slot answer 503 and suggest nothing`, async (t) => {
    const handler = setup(t, stores);
    for (const q of [
      { action: 'nearby', fromDate: '2026-12-03', limit: '8', horizonDays: '7' },
      { action: 'selection', preferredDate: '2026-12-04', preferredArrivalWindow: 'anytime' },
      { action: 'check_slot', preferredDate: '2026-12-04', preferredTime: '10:00 AM' },
    ]) {
      const r = await call(handler, q);
      assert.equal(r.status, 503, q.action);
      assert.equal(r.body.ok, false);
      assert.equal(r.body.error, 'booking_verification_unavailable');
      assert.equal(r.body.retryable, true);
      assert.match(r.body.userMessage, /could not check which times are still open/);
      assert.match(r.body.userMessage, /\(551\) 389-3986/);
      assert.equal(r.body.openings, undefined);
      assert.equal(r.body.available, undefined);
    }
  });
}

test('a hung store scan times out into 503 instead of hanging the function', async (t) => {
  // The production timeout timer is unref()'d (it must never keep a function
  // alive). In this test nothing else holds the event loop while the fake
  // store hangs, so keep one referenced handle until the request settles.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const handler = setup(t, {
    index: indexStore([], { failAll: true }),
    store: { list() { return new Promise(() => {}); } },
  });
  process.env.SLOT_SCAN_TIMEOUT_MS = '40';
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ['Date'], now: NOW_MS });
  const r = await call(loadHandler(), { action: 'nearby', fromDate: '2026-12-03', limit: '4', horizonDays: '7' });
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'booking_verification_unavailable');
  void handler;
});

test('calendar-only actions keep working while occupancy is unavailable', async (t) => {
  const handler = setup(t, { index: indexStore([], { failAll: true }), store: bookingStore([], { listFails: true }) });
  const snap = await call(handler, {});
  assert.equal(snap.status, 200);
  assert.equal(snap.body.status, 'available');
  assert.ok(snap.body.closedDates.includes('2026-12-08'));
  const slots = await call(handler, { action: 'slots_for_date', date: '2026-12-06' });
  assert.deepEqual(slots.body.slots, WEEKEND);
  const v = await call(handler, { action: 'validate', preferredDate: '2026-12-24', preferredTime: '8:00 AM' });
  assert.equal(v.body.validation.error, 'booking_date_unavailable');
});

// ─── Concurrent activity ───────────────────────────────────────────────────

test('concurrent requests while the index flaps never suggest an occupied window', async (t) => {
  let n = 0;
  const flapping = {
    list(opts) {
      n += 1;
      if (n % 17 === 0) throw new Error('index flap');
      return indexStore([...FULL_THU, FRI_8]).list(opts);
    },
  };
  const handler = setup(t, { index: flapping, store: bookingStore([], { listFails: true }) });
  const results = await Promise.all(Array.from({ length: 12 }, () => (
    call(handler, { action: 'nearby', fromDate: '2026-12-03', limit: '8', horizonDays: '7' })
  )));
  let answered = 0;
  for (const r of results) {
    assert.ok(r.status === 200 || r.status === 503, String(r.status));
    if (r.status === 503) { assert.equal(r.body.error, 'booking_verification_unavailable'); continue; }
    answered += 1;
    const got = openingsKey(r.body);
    assert.ok(!got.some((x) => x.startsWith('2026-12-03')));
    assert.ok(!got.includes('2026-12-04 8:00 AM'));
  }
  assert.ok(answered >= 1, 'healthy reads still answer');
});

test('source guard: no public path converts a failed scan into an empty booking list', () => {
  const src = require('node:fs').readFileSync(require.resolve('../netlify/functions/booking-availability'), 'utf8');
  assert.doesNotMatch(src, /listBookingsForSlotLock\(\)\.catch\(\(\) => \[\]\)/);
  assert.doesNotMatch(src, /catch \(_\) \{ \/\* soft \*\/ \}/);
  assert.doesNotMatch(src, /recovery still works without occupancy/);
});
