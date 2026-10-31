'use strict';

process.env.PRISMA_BOOKING_MIRROR = '0';
process.env.PRISMA_BOOKING_READ = '0';
process.env.CD1_POSTGRES_PAYMENT = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCasMemoryStore } = require('./helpers/cas-memory-store');
const { commitBooking, getBookingRecord, setBookingStoreOverride } = require('../netlify/lib/booking-repository');

const BOOKING_ID = 'CD1-BLOBACK1';

function booking(overrides = {}) {
  return {
    id: BOOKING_ID,
    bookingVersion: 4,
    quoteVersion: 1,
    schemaVersion: 1,
    kind: 'booking',
    jobStatus: 'confirmed',
    paymentWorkflowStatus: 'pending_admin_review',
    paymentStatus: 'unpaid',
    ledger: {
      currency: 'usd',
      approvedCents: 25000,
      settledCents: 0,
      creditedCents: 0,
      pendingCents: 0,
      entries: [],
    },
    technicianNote: 'original-note',
    ...overrides,
  };
}

test.afterEach(() => {
  setBookingStoreOverride(null);
});

test('an acknowledged write can be read back at the next version', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const result = await commitBooking({
    bookingId: BOOKING_ID,
    expectedBookingVersion: 4,
    syncSlots: false,
    storeOverride: store,
    nextAggregate: { ...booking(), technicianNote: 'saved-note' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.bookingVersion, 5);
  const seen = await getBookingRecord(BOOKING_ID, { storeOverride: store });
  assert.equal(seen.etagTrusted, true);
  assert.equal(seen.booking.bookingVersion, 5);
  assert.equal(seen.booking.technicianNote, 'saved-note');
  assert.equal(store.snapshot(BOOKING_ID).technicianNote, 'saved-note');
});

test('a landed write with an empty etag stays unacknowledged', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  store.armNextWrite('unacknowledged');
  const result = await commitBooking({
    bookingId: BOOKING_ID,
    expectedBookingVersion: 4,
    syncSlots: false,
    storeOverride: store,
    nextAggregate: { ...booking(), technicianNote: 'landed-without-ack' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'write_outcome_unknown');
  assert.equal(store.snapshot(BOOKING_ID).technicianNote, 'landed-without-ack');
});

test('a thrown write does not change the booking and is not success', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  store.armNextWrite('throw');
  const result = await commitBooking({
    bookingId: BOOKING_ID,
    expectedBookingVersion: 4,
    syncSlots: false,
    storeOverride: store,
    nextAggregate: { ...booking(), technicianNote: 'must-not-land' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'write_outcome_unknown');
  assert.equal(store.snapshot(BOOKING_ID).technicianNote, 'original-note');
  assert.equal(store.snapshot(BOOKING_ID).bookingVersion, 4);
});

test('a stale compare-and-swap cannot overwrite the newer booking', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const current = await store.getWithMetadata(BOOKING_ID, { type: 'json' });
  const stale = await store.setJSON(BOOKING_ID, booking({ technicianNote: 'stale' }), {
    onlyIfMatch: 'etag-not-current',
  });
  assert.equal(stale.modified, false);
  assert.equal(store.snapshot(BOOKING_ID).technicianNote, 'original-note');
  const fresh = await store.setJSON(BOOKING_ID, booking({ technicianNote: 'current', bookingVersion: 5 }), {
    onlyIfMatch: current.etag,
  });
  assert.equal(fresh.modified, true);
  assert.ok(fresh.etag);
  const replay = await store.setJSON(BOOKING_ID, booking({ technicianNote: 'replay', bookingVersion: 6 }), {
    onlyIfMatch: current.etag,
  });
  assert.equal(replay.modified, false);
  assert.equal(store.snapshot(BOOKING_ID).technicianNote, 'current');
});

test('a repeated commit of the old version does not write a second generation', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const first = await commitBooking({
    bookingId: BOOKING_ID,
    expectedBookingVersion: 4,
    syncSlots: false,
    storeOverride: store,
    nextAggregate: { ...booking(), technicianNote: 'once' },
  });
  assert.equal(first.ok, true);
  const retry = await commitBooking({
    bookingId: BOOKING_ID,
    expectedBookingVersion: 4,
    syncSlots: false,
    storeOverride: store,
    nextAggregate: { ...booking(), technicianNote: 'twice' },
  });
  assert.equal(retry.ok, false);
  assert.equal(retry.error, 'version_conflict');
  assert.equal(store.snapshot(BOOKING_ID).bookingVersion, 5);
  assert.equal(store.snapshot(BOOKING_ID).technicianNote, 'once');
});

test('two competing updates leave one newer booking', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  let releaseFirst;
  const firstMayContinue = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let reads = 0;
  store.installConsumeHook({
    async afterGet() {
      reads += 1;
      if (reads === 1) await firstMayContinue;
      else releaseFirst();
    },
  });
  const [left, right] = await Promise.all([
    commitBooking({
      bookingId: BOOKING_ID,
      expectedBookingVersion: 4,
      syncSlots: false,
      storeOverride: store,
      nextAggregate: { ...booking(), technicianNote: 'left' },
    }),
    commitBooking({
      bookingId: BOOKING_ID,
      expectedBookingVersion: 4,
      syncSlots: false,
      storeOverride: store,
      nextAggregate: { ...booking(), technicianNote: 'right' },
    }),
  ]);
  const results = [left, right];
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.error === 'version_conflict').length, 1);
  assert.equal(store.snapshot(BOOKING_ID).bookingVersion, 5);
  assert.ok(['left', 'right'].includes(store.snapshot(BOOKING_ID).technicianNote));
});
