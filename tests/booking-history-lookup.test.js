'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Injected before booking-history lazily requires either module, so the mirror
// path can be exercised without a database.
const PRISMA_PATH = require.resolve('../netlify/lib/prisma');

let fakePrisma = null;
let capturedQuery = null;

function installFakePrisma() {
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
}
installFakePrisma();

const { listBookingHistoryForBooking, identityKeys } = require('../netlify/lib/booking-history');
const { setOpsStoreOverride } = require('../netlify/lib/ops-db');

const RETURNING = {
  id: 'CD1-OLD1',
  phone: '(201) 555-0147',
  email: 'Returning@Example.com',
  status: 'Paid',
  paymentStatus: 'paid',
  finalizedAt: '2026-01-05T10:00:00.000Z',
};

const OTHER_CUSTOMER = {
  id: 'CD1-OTHER',
  phone: '2015550999',
  email: 'other@example.com',
  status: 'Paid',
  paymentStatus: 'paid',
  finalizedAt: '2026-01-06T10:00:00.000Z',
};

/** Minimal Blobs store double: list() + get() over an in-memory map. */
function fakeStore(records) {
  const byKey = new Map(records.map((r) => [r.id, r]));
  return {
    calls: 0,
    list(opts) {
      this.calls += 1;
      const blobs = [...byKey.keys()].map((key) => ({ key }));
      // listAllBlobs prefers the paginated iterator and only re-lists if absent.
      if (opts && opts.paginate) {
        return (async function* pages() { yield { blobs }; })();
      }
      return Promise.resolve({ blobs });
    },
    get(key) {
      return Promise.resolve(byKey.get(key) || null);
    },
  };
}

function queryRawReturning(rows) {
  return (strings, ...values) => {
    capturedQuery = { sql: strings.join('?'), values };
    return Promise.resolve(rows.map((payload) => ({ payload })));
  };
}

beforeEach(() => {
  fakePrisma = null;
  capturedQuery = null;
  delete process.env.OFFER_HISTORY_FAST_LOOKUP;
  delete process.env.PRISMA_BOOKING_MIRROR;
  delete process.env.PRISMA_BOOKING_READ;
  process.env.DATABASE_URL = 'postgres://stub/stub';
  setOpsStoreOverride(null);
});

afterEach(() => {
  setOpsStoreOverride(null);
  delete process.env.DATABASE_URL;
});

describe('identityKeys', () => {
  it('normalizes phone digits and lowercases email', () => {
    assert.deepEqual(identityKeys(RETURNING), {
      phone: '2015550147',
      email: 'returning@example.com',
      emailHash: '',
    });
  });

  it('tolerates a payload with neither field', () => {
    assert.deepEqual(identityKeys({}), { phone: '', email: '', emailHash: '' });
  });
});

describe('listBookingHistoryForBooking', () => {
  it('never touches the store for an anonymous payload', async () => {
    const store = fakeStore([RETURNING]);
    setOpsStoreOverride(store);
    const result = await listBookingHistoryForBooking({ vehicles: [] });
    assert.equal(result.source, 'no_identity');
    assert.deepEqual(result.bookings, []);
    assert.equal(store.calls, 0);
  });

  it('reads the customer-scoped mirror instead of scanning Blobs', async () => {
    fakePrisma = { $queryRaw: queryRawReturning([RETURNING]) };
    const store = fakeStore([RETURNING, OTHER_CUSTOMER]);
    setOpsStoreOverride(store);

    const result = await listBookingHistoryForBooking(RETURNING);

    assert.equal(result.source, 'mirror');
    assert.equal(result.bookings.length, 1);
    assert.equal(result.bookings[0].id, 'CD1-OLD1');
    assert.equal(store.calls, 0, 'mirror hit must not fall through to the full scan');
  });

  it('binds normalized phone and email as query parameters', async () => {
    fakePrisma = { $queryRaw: queryRawReturning([]) };
    await listBookingHistoryForBooking(RETURNING);
    assert.ok(capturedQuery.values.includes('2015550147'));
    assert.ok(capturedQuery.values.includes('returning@example.com'));
    assert.match(capturedQuery.sql, /FROM "BookingRecord"/);
  });

  it('treats an empty mirror result as a customer with no history', async () => {
    fakePrisma = { $queryRaw: queryRawReturning([]) };
    const store = fakeStore([OTHER_CUSTOMER]);
    setOpsStoreOverride(store);

    const result = await listBookingHistoryForBooking({ phone: '2015550100' });

    assert.equal(result.source, 'mirror');
    assert.deepEqual(result.bookings, []);
    assert.equal(store.calls, 0);
  });

  it('drops mirrored rows that are not visible submitted bookings', async () => {
    fakePrisma = {
      $queryRaw: queryRawReturning([
        { id: 'CD1-DRAFT', phone: '2015550147', isDraft: true, kind: 'draft' },
        RETURNING,
      ]),
    };
    const result = await listBookingHistoryForBooking(RETURNING);
    assert.deepEqual(result.bookings.map((b) => b.id), ['CD1-OLD1']);
  });

  it('falls back to the Blobs scan when the mirror query fails', async () => {
    fakePrisma = { $queryRaw: () => Promise.reject(new Error('connection reset')) };
    const store = fakeStore([RETURNING, OTHER_CUSTOMER]);
    setOpsStoreOverride(store);

    const result = await listBookingHistoryForBooking(RETURNING);

    assert.equal(result.source, 'blobs');
    assert.equal(store.calls, 1);
    assert.equal(result.bookings.length, 2, 'scan is unfiltered; callers match identity themselves');
  });

  it('falls back to the Blobs scan when Prisma is unavailable', async () => {
    fakePrisma = null;
    const store = fakeStore([RETURNING]);
    setOpsStoreOverride(store);

    const result = await listBookingHistoryForBooking(RETURNING);

    assert.equal(result.source, 'blobs');
    assert.equal(store.calls, 1);
  });

  it('falls back to the Blobs scan when PRISMA_BOOKING_READ is off', async () => {
    fakePrisma = { $queryRaw: queryRawReturning([RETURNING]) };
    process.env.PRISMA_BOOKING_READ = '0';
    const store = fakeStore([RETURNING]);
    setOpsStoreOverride(store);

    const result = await listBookingHistoryForBooking(RETURNING);

    assert.equal(result.source, 'blobs');
    assert.equal(store.calls, 1);
  });

  it('OFFER_HISTORY_FAST_LOOKUP=0 forces the Blobs scan', async () => {
    fakePrisma = { $queryRaw: queryRawReturning([RETURNING]) };
    process.env.OFFER_HISTORY_FAST_LOOKUP = '0';
    const store = fakeStore([RETURNING]);
    setOpsStoreOverride(store);

    const result = await listBookingHistoryForBooking(RETURNING);

    assert.equal(result.source, 'blobs');
    assert.equal(capturedQuery, null);
  });

  it('degrades to an empty list when both sources are unavailable', async () => {
    fakePrisma = null;
    setOpsStoreOverride({
      list() { throw new Error('blobs unavailable'); },
      get: () => Promise.resolve(null),
    });
    const result = await listBookingHistoryForBooking(RETURNING);
    assert.deepEqual(result.bookings, []);
  });
});

describe('welcome offer eligibility over the mirror', () => {
  const newBooking = {
    zipCode: '07030',
    phone: '2015550100',
    email: 'new@example.com',
    vehicleCategory: 'cars',
    packageId: 'interior',
    vehicles: [{ cat: 'cars', pkgId: 'interior', subtotal: 225 }],
  };

  it('still grants the offer to a customer with no mirrored history', async () => {
    process.env.FIRST_BOOKING_OFFER_ENABLED = 'true';
    fakePrisma = { $queryRaw: queryRawReturning([]) };
    const { evaluateBookingOfferPreview } = require('../netlify/lib/booking-offers');
    const preview = await evaluateBookingOfferPreview(newBooking);
    assert.equal(preview.offer.eligibility_status, 'eligible');
    delete process.env.FIRST_BOOKING_OFFER_ENABLED;
  });

  it('denies the offer when the mirror shows a completed service', async () => {
    process.env.FIRST_BOOKING_OFFER_ENABLED = 'true';
    fakePrisma = {
      $queryRaw: queryRawReturning([{ ...RETURNING, phone: '2015550100', email: 'new@example.com' }]),
    };
    const { evaluateBookingOfferPreview } = require('../netlify/lib/booking-offers');
    const preview = await evaluateBookingOfferPreview(newBooking);
    assert.equal(preview.offer.eligibility_status, 'ineligible');
    assert.equal(preview.offer.eligibility_reason, 'returning_customer');
    delete process.env.FIRST_BOOKING_OFFER_ENABLED;
  });
});

describe('submit-booking no longer scans the store for offers', () => {
  it('booking-offers asks for customer-scoped history', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'netlify', 'lib', 'booking-offers.js'),
      'utf8'
    );
    assert.match(src, /listBookingHistoryForBooking/);
    assert.doesNotMatch(src, /listRawBookings/);
  });
});
