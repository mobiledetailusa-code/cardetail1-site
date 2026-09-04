'use strict';

/**
 * The Admin change-request source aborts at 25s (admin-ops.html
 * SOURCE_FETCH_TIMEOUT_MS). Enriching a page of requests with their bookings
 * must therefore be bounded: a single request pointing at a bookingId that no
 * longer resolves by key cannot be allowed to trigger a full cd1-bookings
 * hydration, which measures ~10-18s on the live store.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

const { getBookingsByIds, setOpsStoreOverride } = require('../netlify/lib/ops-db');

const KNOWN = {
  id: 'CD1-KNOWN',
  status: 'Pending Review',
  finalizedAt: '2026-03-01T10:00:00.000Z',
};

function storeWith(records) {
  const byKey = new Map(records.map((r) => [r.id, r]));
  return {
    lists: 0,
    list(opts) {
      this.lists += 1;
      const blobs = [...byKey.keys()].map((key) => ({ key }));
      if (opts && opts.paginate) return (async function* pages() { yield { blobs }; })();
      return Promise.resolve({ blobs });
    },
    get(key) { return Promise.resolve(byKey.get(key) || null); },
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

describe('getBookingsByIds scan opt-out', () => {
  it('skips the full-store scan when the caller declines it', async () => {
    const store = storeWith([KNOWN]);
    setOpsStoreOverride(store);

    const resolved = await getBookingsByIds(['CD1-KNOWN', 'CD1-GONE'], { allowScan: false });

    assert.equal(resolved.get('CD1-KNOWN').id, 'CD1-KNOWN');
    assert.equal(resolved.get('CD1-GONE'), null, 'the unresolved id degrades to null');
    assert.equal(store.lists, 0, 'no full-store hydration for one missing id');
  });

  it('still scans by default so single lookups keep their fallback', async () => {
    const store = storeWith([KNOWN]);
    setOpsStoreOverride(store);

    await getBookingsByIds(['CD1-GONE']);

    assert.ok(store.lists > 0, 'default behaviour is unchanged');
  });

  it('resolves everything by key without scanning either way', async () => {
    const store = storeWith([KNOWN]);
    setOpsStoreOverride(store);

    const resolved = await getBookingsByIds(['CD1-KNOWN'], { allowScan: false });

    assert.equal(resolved.get('CD1-KNOWN').id, 'CD1-KNOWN');
    assert.equal(store.lists, 0);
  });

  it('prefers the mirror over the scan even when scanning is allowed', async () => {
    fakePrisma = {
      bookingRecord: {
        findUnique: () => Promise.resolve(null),
        findMany: ({ where }) => Promise.resolve(
          where.id.in.includes('CD1-MIRRORED')
            ? [{ id: 'CD1-MIRRORED', payload: { ...KNOWN, id: 'CD1-MIRRORED' } }]
            : []
        ),
      },
    };
    const store = storeWith([]);
    setOpsStoreOverride(store);

    const resolved = await getBookingsByIds(['CD1-MIRRORED']);

    assert.equal(resolved.get('CD1-MIRRORED').id, 'CD1-MIRRORED');
    assert.equal(store.lists, 0);
  });
});

describe('admin change-request enrichment', () => {
  it('asks for the bounded lookup and renders rows without their booking', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'netlify', 'functions', 'admin-customer-requests.js'),
      'utf8'
    );
    const call = src.slice(src.indexOf('getBookingsByIds('));
    assert.match(call.slice(0, 200), /\{\s*allowScan:\s*false\s*\}/);
    assert.match(src, /bookingUnavailable/, 'a missing booking degrades the row, not the page');
    const listStart = src.indexOf("if (action === 'list')");
    const listFn = src.slice(listStart, src.indexOf("if (action === 'decide')"));
    assert.match(listFn, /hydrateRequestRecords/);
    assert.doesNotMatch(listFn, /fetchBlobRecords/);
  });
});
