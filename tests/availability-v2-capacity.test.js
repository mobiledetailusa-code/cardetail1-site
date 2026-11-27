'use strict';

/**
 * Operational Availability V2 — Phase 1: configured capacity is enforced by
 * the atomic slot reservation (it used to be hard-coded to 1 there, so a
 * capacity-2 date accepted the second booking in validation and then refused
 * it at finalize). Without a configuration the reservation stays at the
 * conservative historical capacity of 1.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { reserveBookedSpan, setSlotIndexStoreOverride, slotIndexKey } = require('../netlify/lib/slot-index');
const { validateBookingSchedule } = require('../netlify/lib/operational-availability');

const NOW = new Date('2026-11-27T15:00:00.000Z');
const DATE = '2027-01-09'; // Saturday

function memoryIndexStore() {
  const data = new Map();
  return {
    data,
    list({ prefix = '' } = {}) {
      const blobs = [...data.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key }));
      return (async function* pages() { yield { blobs }; })();
    },
    async set(key, value, opts = {}) {
      if (opts.onlyIfNew && data.has(key)) return { modified: false };
      data.set(key, value);
      return { modified: true };
    },
    async setJSON(key, value, opts = {}) { return this.set(key, JSON.stringify(value), opts); },
    async get(key) { return data.has(key) ? data.get(key) : null; },
    async delete(key) { data.delete(key); },
  };
}

function config(capacity, enabled = true) {
  return {
    version: 1,
    weekendMode: 'supervised',
    supervisedEffectiveDate: '2026-11-01',
    dateOverrides: { [DATE]: { enabled, capacity, arrivalWindows: ['8:00 AM', '10:00 AM'] } },
  };
}

function booking(id) {
  return { id, preferredDate: DATE, preferredTime: '8:00 AM', appointmentStatus: 'pending_review', status: 'Pending Review' };
}

function bookedKeys(store) {
  return [...store.data.keys()].filter((k) => k.startsWith(`${DATE}/`) && k.includes('/booked/'));
}

test.beforeEach(() => { process.env.SLOT_INDEX_READS = '1'; });
test.afterEach(() => setSlotIndexStoreOverride(null));

test('capacity 2: the second booking is accepted, the third refused', async () => {
  const store = memoryIndexStore();
  setSlotIndexStoreOverride(store);
  const cfg = config(2);
  assert.equal(validateBookingSchedule(DATE, '8:00 AM', { config: cfg, now: NOW }).capacity, 2);
  assert.equal((await reserveBookedSpan(booking('CD1-A'), NOW.getTime(), { config: cfg })).ok, true);
  assert.equal((await reserveBookedSpan(booking('CD1-B'), NOW.getTime(), { config: cfg })).ok, true);
  const third = await reserveBookedSpan(booking('CD1-C'), NOW.getTime(), { config: cfg });
  assert.deepEqual(third, { ok: false, error: 'booking_slot_unavailable' });
  assert.equal(bookedKeys(store).length, 2);
});

test('concurrent finalizes on a capacity-2 window: exactly two win', async () => {
  const store = memoryIndexStore();
  setSlotIndexStoreOverride(store);
  const cfg = config(2);
  const results = await Promise.all(['CD1-P', 'CD1-Q', 'CD1-R', 'CD1-S'].map((id) => (
    reserveBookedSpan(booking(id), NOW.getTime(), { config: cfg })
  )));
  assert.equal(results.filter((r) => r.ok).length, 2);
  assert.equal(results.filter((r) => r.error === 'booking_slot_unavailable').length, 2);
  assert.equal(bookedKeys(store).length, 2);
});

test('without a configuration the reservation stays at capacity 1 (never over-admits)', async () => {
  const store = memoryIndexStore();
  setSlotIndexStoreOverride(store);
  assert.equal((await reserveBookedSpan(booking('CD1-A'), NOW.getTime())).ok, true);
  const second = await reserveBookedSpan(booking('CD1-B'), NOW.getTime());
  assert.equal(second.ok, false);
});

test('closing a date never removes an existing reservation and admits no new one', async () => {
  const store = memoryIndexStore();
  setSlotIndexStoreOverride(store);
  assert.equal((await reserveBookedSpan(booking('CD1-A'), NOW.getTime(), { config: config(2) })).ok, true);
  const closed = config(2, false);
  assert.equal(validateBookingSchedule(DATE, '8:00 AM', { config: closed, now: NOW }).error, 'booking_date_unavailable');
  const next = await reserveBookedSpan(booking('CD1-B'), NOW.getTime(), { config: closed });
  assert.equal(next.ok, false);
  assert.ok(store.data.has(slotIndexKey({ slotDate: DATE, slotTime: '8:00 AM', state: 'booked', expiresAtMs: 0, bookingId: 'CD1-A' })));
});
