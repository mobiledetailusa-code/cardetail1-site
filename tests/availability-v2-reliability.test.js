'use strict';

/**
 * Operational Availability V2 — Phase 1 reliability:
 *   - a configuration that cannot be read never becomes the legacy calendar;
 *   - never-configured is distinguished from unreadable / invalid;
 *   - admin writes are compare-and-swap (two tabs cannot overwrite each other);
 *   - the public endpoint answers 503 with a recovery message instead of dates.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCasMemoryStore } = require('./helpers/cas-memory-store');
const opsConfig = require('../netlify/lib/ops-config');

const {
  loadOperationalAvailability,
  getOperationalAvailability,
  saveOperationalAvailability,
  setAvailabilityStoreOverride,
  isAvailabilityUnavailable,
  AVAILABILITY_READ_ATTEMPTS,
} = opsConfig;

const noSleep = async () => {};
const STORED = {
  version: 1,
  businessTimezone: 'America/New_York',
  weekendMode: 'supervised',
  supervisedEffectiveDate: '2026-12-27',
  dateOverrides: { '2026-12-05': { enabled: false, capacity: 1 } },
  revision: 4,
  updatedAt: '2026-11-27T03:17:45.570Z',
};

function failingStore(failures = Infinity) {
  let calls = 0;
  const inner = createCasMemoryStore({ availability: STORED });
  return {
    get calls() { return calls; },
    async getWithMetadata(key, opts) {
      calls += 1;
      if (calls <= failures) throw new Error('Netlify Blobs has generated an internal error (500 status code)');
      return inner.getWithMetadata(key, opts);
    },
    async get(key, opts) { return inner.get(key, opts); },
    async setJSON(...args) { return inner.setJSON(...args); },
  };
}

function quietConsole(t) {
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  t.mock.method(console, 'warn', () => {});
  return logs;
}

test.afterEach(() => setAvailabilityStoreOverride(null));

// ─── Loader ────────────────────────────────────────────────────────────────

test('never configured resolves to the legacy defaults, marked as default', async () => {
  setAvailabilityStoreOverride(createCasMemoryStore());
  const loaded = await loadOperationalAvailability({ sleep: noSleep });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.source, 'default');
  assert.equal(loaded.config.weekendMode, 'legacy');
  assert.equal(loaded.revision, 0);
});

test('a stored configuration is returned with its etag and revision', async () => {
  setAvailabilityStoreOverride(createCasMemoryStore({ availability: STORED }));
  const loaded = await loadOperationalAvailability({ sleep: noSleep });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.source, 'stored');
  assert.ok(loaded.etag);
  assert.equal(loaded.revision, 4);
  assert.equal(loaded.config.supervisedEffectiveDate, '2026-12-27');
});

test('a read failure is retried, then reported unavailable — never legacy', async (t) => {
  const logs = quietConsole(t);
  const store = failingStore();
  setAvailabilityStoreOverride(store);
  const loaded = await loadOperationalAvailability({ sleep: noSleep });
  assert.equal(store.calls, AVAILABILITY_READ_ATTEMPTS);
  assert.deepEqual(
    { ok: loaded.ok, error: loaded.error, reason: loaded.reason, retryable: loaded.retryable },
    { ok: false, error: 'availability_unavailable', reason: 'read_failed', retryable: true },
  );
  assert.equal(loaded.config, undefined, 'no calendar is handed out');
  assert.ok(logs.some((l) => String(l[0]).includes('[availability] read_failed')), 'actionable log line');
  await assert.rejects(getOperationalAvailability({ sleep: noSleep }), (err) => isAvailabilityUnavailable(err));
});

test('a transient failure recovers on retry with the real configuration', async (t) => {
  quietConsole(t);
  const store = failingStore(1);
  setAvailabilityStoreOverride(store);
  const loaded = await loadOperationalAvailability({ sleep: noSleep });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.source, 'stored');
  assert.equal(store.calls, 2);
});

test('a stored but invalid configuration fails closed without retrying', async (t) => {
  const logs = quietConsole(t);
  for (const bad of [
    { ...STORED, version: 7 },
    { ...STORED, weekendMode: 'supervised', supervisedEffectiveDate: null },
    { ...STORED, businessTimezone: 'Nowhere/Zone' },
    'not-json-object',
  ]) {
    setAvailabilityStoreOverride(createCasMemoryStore({ availability: bad }));
    const loaded = await loadOperationalAvailability({ sleep: noSleep });
    assert.equal(loaded.ok, false, JSON.stringify(bad));
    assert.equal(loaded.retryable, false);
    assert.match(loaded.reason, /^invalid_config:/);
  }
  assert.ok(logs.some((l) => String(l[0]).includes('[availability] invalid_config')));
});

test('the store itself failing to open is unavailable, not legacy', async (t) => {
  quietConsole(t);
  setAvailabilityStoreOverride({
    async getWithMetadata() { throw new Error('MissingBlobsEnvironmentError'); },
  });
  const loaded = await loadOperationalAvailability({ sleep: noSleep });
  assert.equal(loaded.ok, false);
  assert.equal(loaded.reason, 'read_failed');
});

// ─── Compare-and-swap writes ───────────────────────────────────────────────

test('two concurrent admin edits: the second write is refused, nothing is lost', async () => {
  const store = createCasMemoryStore({ availability: STORED });
  setAvailabilityStoreOverride(store);
  const tabA = await loadOperationalAvailability({ sleep: noSleep });
  const tabB = await loadOperationalAvailability({ sleep: noSleep });
  const savedA = await saveOperationalAvailability(
    { ...tabA.config, dateOverrides: { ...tabA.config.dateOverrides, '2026-12-12': { enabled: true } } },
    { etag: tabA.etag, baseRevision: tabA.revision, updatedBy: 'a' },
  );
  assert.equal(savedA.ok, true);
  assert.equal(savedA.config.revision, 5);
  const savedB = await saveOperationalAvailability(
    { ...tabB.config, dateOverrides: {} },
    { etag: tabB.etag, baseRevision: tabB.revision, updatedBy: 'b' },
  );
  assert.deepEqual(savedB, { ok: false, error: 'version_conflict' });
  const after = await loadOperationalAvailability({ sleep: noSleep });
  assert.deepEqual(Object.keys(after.config.dateOverrides).sort(), ['2026-12-05', '2026-12-12']);
  assert.equal(after.config.updatedBy, 'a');
});

test('first save on an empty store uses create-only semantics', async () => {
  const store = createCasMemoryStore();
  setAvailabilityStoreOverride(store);
  const first = await saveOperationalAvailability({ version: 1, weekendMode: 'legacy' }, { expectNew: true });
  assert.equal(first.ok, true);
  const second = await saveOperationalAvailability({ version: 1, weekendMode: 'legacy' }, { expectNew: true });
  assert.deepEqual(second, { ok: false, error: 'version_conflict' });
});

// ─── Public endpoint ───────────────────────────────────────────────────────

test('booking-availability answers 503 with a recovery message for every action', async (t) => {
  quietConsole(t);
  setAvailabilityStoreOverride(failingStore());
  // Keep the loader fast: no real backoff in tests.
  t.mock.method(global, 'setTimeout', (fn) => { fn(); return 0; });
  delete require.cache[require.resolve('../netlify/functions/booking-availability')];
  const { handler } = require('../netlify/functions/booking-availability');
  const actions = [
    {},
    { action: 'slots_for_date', date: '2026-12-05' },
    { action: 'validate', preferredDate: '2026-12-05', preferredTime: '8:00 AM' },
    { action: 'nearby', fromDate: '2026-12-05' },
    { action: 'selection', preferredDate: '2026-12-05', preferredArrivalWindow: 'anytime' },
    { action: 'check_slot', preferredDate: '2026-12-05', preferredTime: '8:00 AM' },
  ];
  for (const q of actions) {
    const res = await handler({ httpMethod: 'GET', headers: { 'x-forwarded-for': '203.0.113.9' }, queryStringParameters: q });
    assert.equal(res.statusCode, 503, JSON.stringify(q));
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'availability_unavailable');
    assert.equal(body.status, 'unavailable');
    assert.match(body.userMessage, /\(551\) 389-3986/);
    assert.equal(body.slots, undefined);
    assert.equal(body.dateOverrides, undefined);
  }
});

test('booking-availability publishes closed dates when the configuration reads', async () => {
  setAvailabilityStoreOverride(createCasMemoryStore({ availability: STORED }));
  delete require.cache[require.resolve('../netlify/functions/booking-availability')];
  const { handler } = require('../netlify/functions/booking-availability');
  const res = await handler({ httpMethod: 'GET', headers: { 'x-forwarded-for': '203.0.113.10' }, queryStringParameters: {} });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.status, 'available');
  assert.ok(Array.isArray(body.closedDates));
  assert.ok(body.horizonEnd >= body.horizonStart);
});
