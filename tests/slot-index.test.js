'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const slotIndex = require('../netlify/lib/slot-index');
const {
  slotIndexKey,
  parseSlotIndexKey,
  slotHoldForBooking,
  readSlotHolds,
  indexedSlotConflict,
  indexedOccupancyForDates,
  syncSlotIndex,
  setSlotIndexStoreOverride,
} = slotIndex;
const { isActiveBookingForSlotLock, DRAFT_SLOT_HOLD_MS } = require('../netlify/lib/booking-schedule');

const DATE = '2026-09-15';
const TIME = '10:00 AM';

/** In-memory Blobs double with prefix listing and a call counter. */
function fakeIndexStore(keys = []) {
  const store = new Set(keys);
  return {
    lists: 0,
    writes: 0,
    deletes: 0,
    keys: () => [...store],
    list(opts) {
      this.lists += 1;
      const prefix = (opts && opts.prefix) || '';
      const blobs = [...store].filter((k) => k.startsWith(prefix)).map((key) => ({ key }));
      if (opts && opts.paginate) {
        return (async function* pages() { yield { blobs }; })();
      }
      return Promise.resolve({ blobs });
    },
    setJSON(key) { this.writes += 1; store.add(key); return Promise.resolve({ modified: true }); },
    delete(key) { this.deletes += 1; store.delete(key); return Promise.resolve(); },
  };
}

function draftBooking(overrides = {}) {
  return {
    id: 'CD1-DRAFT1',
    isDraft: true,
    cardOnFileStatus: 'pending',
    preferredDate: DATE,
    preferredTime: TIME,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function submittedBooking(overrides = {}) {
  return {
    id: 'CD1-BOOKED1',
    status: 'Pending Review',
    finalizedAt: new Date().toISOString(),
    preferredDate: DATE,
    preferredTime: TIME,
    ...overrides,
  };
}

beforeEach(() => {
  process.env.SLOT_INDEX_READS = '1';
  setSlotIndexStoreOverride(null);
});

afterEach(() => {
  delete process.env.SLOT_INDEX_READS;
  setSlotIndexStoreOverride(null);
});

describe('slot index keys', () => {
  it('round-trips every field through the key', () => {
    const key = slotIndexKey({
      slotDate: DATE, slotTime: TIME, state: 'draft', expiresAtMs: 1789459200000, bookingId: 'CD1-ABC',
    });
    assert.equal(key, '2026-09-15/10:00 AM/draft/1789459200000/CD1-ABC');
    assert.deepEqual(parseSlotIndexKey(key), {
      key,
      slotDate: DATE,
      slotTime: TIME,
      state: 'draft',
      expiresAtMs: 1789459200000,
      bookingId: 'CD1-ABC',
    });
  });

  it('rejects keys that are not index entries', () => {
    assert.equal(parseSlotIndexKey('CD1-SOMETHING'), null);
    assert.equal(parseSlotIndexKey('2026-09-15/10:00 AM/bogus/0/CD1-A'), null);
    assert.equal(parseSlotIndexKey('2026-09-15/10:00 AM/draft/notanumber/CD1-A'), null);
  });
});

describe('slotHoldForBooking matches the scan definition of an active hold', () => {
  const cases = [
    ['pending card-save draft', draftBooking()],
    ['saved card-on-file draft', draftBooking({ cardOnFileStatus: 'saved' })],
    ['draft with no card session', draftBooking({ cardOnFileStatus: '' })],
    ['expired draft', draftBooking({ updatedAt: new Date(Date.now() - DRAFT_SLOT_HOLD_MS - 1000).toISOString() })],
    ['submitted booking', submittedBooking()],
    ['cancelled booking', submittedBooking({ status: 'Cancelled' })],
    ['rejected appointment', submittedBooking({ appointmentStatus: 'rejected' })],
    ['archived booking', submittedBooking({ archived: true })],
    ['test booking', submittedBooking({ isTest: true })],
  ];

  for (const [label, booking] of cases) {
    it(label, () => {
      assert.equal(
        slotHoldForBooking(booking).active,
        isActiveBookingForSlotLock(booking),
        `${label} must classify the same in both paths`
      );
    });
  }

  it('has no hold without a usable date or time', () => {
    assert.equal(slotHoldForBooking(submittedBooking({ preferredTime: '25:00' })).active, false);
    assert.equal(slotHoldForBooking(submittedBooking({ preferredDate: '' })).active, false);
  });
});

describe('reading occupancy', () => {
  it('counts only the requested slot, by prefix', async () => {
    const store = fakeIndexStore([
      slotIndexKey({ slotDate: DATE, slotTime: TIME, state: 'booked', expiresAtMs: 0, bookingId: 'A' }),
      slotIndexKey({ slotDate: DATE, slotTime: '8:00 AM', state: 'booked', expiresAtMs: 0, bookingId: 'B' }),
      slotIndexKey({ slotDate: '2026-09-16', slotTime: TIME, state: 'booked', expiresAtMs: 0, bookingId: 'C' }),
    ]);
    setSlotIndexStoreOverride(store);
    const holds = await readSlotHolds(DATE, TIME);
    assert.deepEqual(holds.map((h) => h.bookingId), ['A']);
  });

  it('ignores expired draft holds and honours excludeId', async () => {
    const store = fakeIndexStore([
      slotIndexKey({ slotDate: DATE, slotTime: TIME, state: 'draft', expiresAtMs: Date.now() - 1, bookingId: 'STALE' }),
      slotIndexKey({ slotDate: DATE, slotTime: TIME, state: 'draft', expiresAtMs: Date.now() + 60000, bookingId: 'LIVE' }),
      slotIndexKey({ slotDate: DATE, slotTime: TIME, state: 'booked', expiresAtMs: 0, bookingId: 'MINE' }),
    ]);
    setSlotIndexStoreOverride(store);
    const holds = await readSlotHolds(DATE, TIME, { excludeId: 'MINE' });
    assert.deepEqual(holds.map((h) => h.bookingId), ['LIVE']);
  });

  it('reports a conflict at capacity and none below it', async () => {
    setSlotIndexStoreOverride(fakeIndexStore([
      slotIndexKey({ slotDate: DATE, slotTime: TIME, state: 'booked', expiresAtMs: 0, bookingId: 'A' }),
    ]));
    assert.deepEqual(await indexedSlotConflict(DATE, TIME), { ok: true, conflict: true });

    setSlotIndexStoreOverride(fakeIndexStore([]));
    assert.deepEqual(await indexedSlotConflict(DATE, TIME), { ok: true, conflict: false });
  });

  it('declines to answer when reads are disabled', async () => {
    delete process.env.SLOT_INDEX_READS;
    const store = fakeIndexStore([]);
    setSlotIndexStoreOverride(store);
    const result = await indexedSlotConflict(DATE, TIME);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'reads_disabled');
    assert.equal(store.lists, 0, 'must not touch the store while gated off');
  });

  it('declines to answer — never "free" — when the store fails', async () => {
    setSlotIndexStoreOverride({
      list() { throw new Error('blobs down'); },
      setJSON: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    });
    const result = await indexedSlotConflict(DATE, TIME);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'read_failed');
  });

  it('builds a day occupancy map with one list per date', async () => {
    const store = fakeIndexStore([
      slotIndexKey({ slotDate: DATE, slotTime: TIME, state: 'booked', expiresAtMs: 0, bookingId: 'A' }),
      slotIndexKey({ slotDate: DATE, slotTime: TIME, state: 'draft', expiresAtMs: Date.now() + 60000, bookingId: 'B' }),
      slotIndexKey({ slotDate: DATE, slotTime: '8:00 AM', state: 'booked', expiresAtMs: 0, bookingId: 'C' }),
    ]);
    setSlotIndexStoreOverride(store);
    const result = await indexedOccupancyForDates([DATE, '2026-09-16']);
    assert.deepEqual(result.occupancy, { [`${DATE}|${TIME}`]: 2, [`${DATE}|8:00 AM`]: 1 });
    assert.equal(store.lists, 2);
  });
});

describe('keeping the index in sync', () => {
  it('writes one entry for a new draft hold', async () => {
    const store = fakeIndexStore([]);
    setSlotIndexStoreOverride(store);
    const result = await syncSlotIndex(draftBooking());
    assert.equal(result.ok, true);
    assert.equal(store.keys().length, 1);
    assert.match(store.keys()[0], /^2026-09-15\/10:00 AM\/draft\/\d+\/CD1-DRAFT1$/);
  });

  it('replaces rather than duplicates when a draft is refreshed', async () => {
    const store = fakeIndexStore([]);
    setSlotIndexStoreOverride(store);
    const first = draftBooking({ updatedAt: new Date(Date.now() - 60000).toISOString() });
    await syncSlotIndex(first);
    await syncSlotIndex(draftBooking());
    assert.equal(store.keys().length, 1, 'a refreshed hold must not stack entries');
  });

  it('moves the entry when the booking is rescheduled', async () => {
    const store = fakeIndexStore([]);
    setSlotIndexStoreOverride(store);
    const before = submittedBooking();
    await syncSlotIndex(before);
    const after = { ...before, preferredDate: '2026-09-16', preferredTime: '8:00 AM' };
    await syncSlotIndex(after, { previous: before });
    assert.deepEqual(store.keys(), ['2026-09-16/8:00 AM/booked/0/CD1-BOOKED1']);
  });

  it('promotes a draft hold to a booked hold on finalize', async () => {
    const store = fakeIndexStore([]);
    setSlotIndexStoreOverride(store);
    const draft = draftBooking({ id: 'CD1-X' });
    await syncSlotIndex(draft);
    const finalized = { ...draft, isDraft: false, status: 'Pending Review', finalizedAt: new Date().toISOString() };
    await syncSlotIndex(finalized, { previous: draft });
    assert.deepEqual(store.keys(), [`${DATE}/${TIME}/booked/0/CD1-X`]);
  });

  it('releases the slot when the booking is cancelled', async () => {
    const store = fakeIndexStore([]);
    setSlotIndexStoreOverride(store);
    const booked = submittedBooking();
    await syncSlotIndex(booked);
    assert.equal(store.keys().length, 1);
    const cancelled = { ...booked, status: 'Cancelled' };
    await syncSlotIndex(cancelled, { previous: booked });
    assert.deepEqual(store.keys(), []);
  });

  it('never throws when the index store is broken', async () => {
    setSlotIndexStoreOverride({
      list() { throw new Error('blobs down'); },
      setJSON() { throw new Error('blobs down'); },
      delete() { throw new Error('blobs down'); },
    });
    const result = await syncSlotIndex(draftBooking());
    assert.equal(result.ok, false);
    assert.match(result.error, /blobs down/);
  });

  it('logs a ref, never the raw booking id, when the store fails', async () => {
    // appointment-persistence-and-resend asserts no raw booking id reaches
    // console during a portal flow, and commitBooking calls this on that path.
    const lines = [];
    const originalWarn = console.warn;
    console.warn = (...args) => lines.push(JSON.stringify(args));
    try {
      setSlotIndexStoreOverride({
        list() { throw new Error('blobs down'); },
        setJSON() { throw new Error('blobs down'); },
        delete() { throw new Error('blobs down'); },
      });
      await syncSlotIndex(draftBooking({ id: 'CD1-PRIVAT001' }));
    } finally {
      console.warn = originalWarn;
    }
    const logged = lines.join('\n');
    assert.ok(logged.includes('sync_failed'), 'the failure is still reported');
    assert.ok(!logged.includes('CD1-PRIVAT001'), 'raw booking id must not reach console');
    assert.match(logged, /bookingRef/);
  });

  it('rejects a record with no id instead of writing a bad key', async () => {
    const store = fakeIndexStore([]);
    setSlotIndexStoreOverride(store);
    const result = await syncSlotIndex({ preferredDate: DATE, preferredTime: TIME, status: 'Pending Review' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'missing_booking_id');
    assert.equal(store.writes, 0);
  });
});

describe('checkout wiring', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  it('submit-booking prefers the index and keeps the scan as fallback', () => {
    const src = read('netlify/functions/submit-booking.js');
    assert.match(src, /indexedSlotConflict/);
    assert.match(src, /listBookingsForSlotLock\(\)\.catch/, 'fallback scan must remain');
  });

  it('submit-booking indexes the draft hold before writing the draft record', () => {
    const src = read('netlify/functions/submit-booking.js');
    const sync = src.indexOf('await syncSlotIndex(draft,');
    const write = src.indexOf('await store.setJSON(draftId, draft)');
    assert.ok(sync > -1 && write > -1);
    assert.ok(sync < write, 'draft holds must be fail-closed: index first, record second');
  });

  it('commitBooking syncs the index for Admin and portal mutations', () => {
    const src = read('netlify/lib/booking-repository.js');
    assert.match(src, /syncSlotIndex/);
  });
});
