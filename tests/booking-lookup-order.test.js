'use strict';

/**
 * The resolution order in ops-db is a production-availability property, not a
 * style choice: with the mirror consulted after the scan, any booking whose
 * Blob key differs from payload.id sent stripe-webhook and booking-card-status
 * through a full-store hydration that no longer fits in a function timeout.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const PRISMA_PATH = require.resolve('../netlify/lib/prisma');

let fakePrisma = null;

require.cache[PRISMA_PATH] = {
  id: PRISMA_PATH,
  filename: PRISMA_PATH,
  loaded: true,
  exports: {
    prismaConfigured: () => !!fakePrisma,
    tryGetPrisma: () => fakePrisma,
    getPrisma: () => fakePrisma,
  },
};

const { getBooking, getBookingsByIds, setOpsStoreOverride } = require('../netlify/lib/ops-db');

const BOOKING = {
  id: 'CD1-KEYMISMATCH',
  phone: '2015550147',
  status: 'Pending Review',
  finalizedAt: '2026-03-01T10:00:00.000Z',
  preferredDate: '2026-09-15',
  preferredTime: '10:00 AM',
};

/** Store whose blob KEY differs from payload.id — the case that triggered the scan. */
function mismatchedStore() {
  const byKey = new Map([['legacy-key-001', BOOKING]]);
  return {
    lists: 0,
    gets: 0,
    list(opts) {
      this.lists += 1;
      const blobs = [...byKey.keys()].map((key) => ({ key }));
      if (opts && opts.paginate) return (async function* pages() { yield { blobs }; })();
      return Promise.resolve({ blobs });
    },
    get(key) { this.gets += 1; return Promise.resolve(byKey.get(key) || null); },
  };
}

function mirrorWith(rows) {
  return {
    bookingRecord: {
      findUnique: ({ where }) => Promise.resolve(rows[where.id] ? { id: where.id, payload: rows[where.id] } : null),
      findMany: ({ where }) => Promise.resolve(
        where.id.in.filter((id) => rows[id]).map((id) => ({ id, payload: rows[id] }))
      ),
    },
  };
}

beforeEach(() => {
  fakePrisma = null;
  delete process.env.PRISMA_BOOKING_READ;
  process.env.DATABASE_URL = 'postgres://stub/stub';
  setOpsStoreOverride(null);
});

afterEach(() => {
  setOpsStoreOverride(null);
  delete process.env.DATABASE_URL;
});

describe('getBooking resolution order', () => {
  it('answers from the mirror without scanning the store', async () => {
    fakePrisma = mirrorWith({ 'CD1-KEYMISMATCH': BOOKING });
    const store = mismatchedStore();
    setOpsStoreOverride(store);

    const booking = await getBooking('CD1-KEYMISMATCH');

    assert.equal(booking.id, 'CD1-KEYMISMATCH');
    assert.equal(store.lists, 0, 'the mirror must answer before any full-store scan');
  });

  it('still finds the booking by scanning when the mirror is unavailable', async () => {
    fakePrisma = null;
    const store = mismatchedStore();
    setOpsStoreOverride(store);

    const booking = await getBooking('CD1-KEYMISMATCH');

    assert.equal(booking.id, 'CD1-KEYMISMATCH');
    assert.ok(store.lists > 0, 'Blobs remain authoritative when Postgres cannot answer');
  });

  it('prefers the direct Blob key over the mirror', async () => {
    const fresh = { ...BOOKING, id: 'CD1-DIRECT', status: 'Confirmed' };
    fakePrisma = mirrorWith({ 'CD1-DIRECT': { ...fresh, status: 'STALE' } });
    setOpsStoreOverride({
      lists: 0,
      list() { this.lists += 1; return Promise.resolve({ blobs: [] }); },
      get: (key) => Promise.resolve(key === 'CD1-DIRECT' ? fresh : null),
    });

    const booking = await getBooking('CD1-DIRECT');
    assert.equal(booking.status, 'Confirmed', 'Blobs stay authoritative when the key hits');
  });

  it('returns null when neither source knows the booking', async () => {
    fakePrisma = mirrorWith({});
    setOpsStoreOverride(mismatchedStore());
    assert.equal(await getBooking('CD1-UNKNOWN'), null);
  });
});

describe('getBookingsByIds resolution order', () => {
  it('resolves key-mismatched ids in one batched mirror query', async () => {
    let findManyCalls = 0;
    const rows = { 'CD1-KEYMISMATCH': BOOKING, 'CD1-OTHER': { ...BOOKING, id: 'CD1-OTHER' } };
    fakePrisma = {
      bookingRecord: {
        findUnique: () => Promise.resolve(null),
        findMany: ({ where }) => {
          findManyCalls += 1;
          return Promise.resolve(where.id.in.filter((id) => rows[id]).map((id) => ({ id, payload: rows[id] })));
        },
      },
    };
    const store = mismatchedStore();
    setOpsStoreOverride(store);

    const resolved = await getBookingsByIds(['CD1-KEYMISMATCH', 'CD1-OTHER']);

    assert.equal(resolved.get('CD1-KEYMISMATCH').id, 'CD1-KEYMISMATCH');
    assert.equal(resolved.get('CD1-OTHER').id, 'CD1-OTHER');
    assert.equal(findManyCalls, 1, 'one query for every missed id, not one per id');
    assert.equal(store.lists, 0, 'no full-store scan once the mirror answered');
  });

  it('falls back to the shared scan for ids the mirror does not have', async () => {
    fakePrisma = mirrorWith({});
    const store = mismatchedStore();
    setOpsStoreOverride(store);

    const resolved = await getBookingsByIds(['CD1-KEYMISMATCH']);

    assert.equal(resolved.get('CD1-KEYMISMATCH').id, 'CD1-KEYMISMATCH');
    assert.ok(store.lists > 0);
  });
});
