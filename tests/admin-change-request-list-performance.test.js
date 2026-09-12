/**
 * Admin customer-requests list — N+1 / query-order performance guarantees.
 *
 * Booking enrichment must happen LAST and only for the rows actually returned.
 * These tests measure real booking-store reads rather than trusting call shape.
 */
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const HANDLER = path.join(root, 'netlify/functions/admin-customer-requests.js');

const opsDb = require('../netlify/lib/ops-db');
const adminSecurity = require('../netlify/lib/admin-security');

const MAX_LIST = 50;
const UNIQUE_BOOKINGS = 40;
const MISSING_BOOKING_ID = 'CD1-MISSING-0000';

/** Memory store that records every key read, so lookups can be counted exactly. */
function createCountingStore(seed = {}, counters) {
  const data = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const note = (kind, key) => {
    if (!counters) return;
    counters.reads += 1;
    counters.keys.push(String(key));
    counters[kind] = (counters[kind] || 0) + 1;
  };
  return {
    async get(key) {
      note('get', key);
      return data.has(key) ? JSON.parse(JSON.stringify(data.get(key))) : null;
    },
    async getWithMetadata(key) {
      note('get', key);
      return data.has(key)
        ? { data: JSON.parse(JSON.stringify(data.get(key))), etag: `etag-${key}` }
        : null;
    },
    async setJSON(key, value, opts) {
      if (opts && opts.onlyIfMatch) {
        const expected = `etag-${key}`;
        if (data.has(key) && opts.onlyIfMatch !== expected) {
          return { modified: false };
        }
      }
      data.set(key, JSON.parse(JSON.stringify(value)));
      return { modified: true };
    },
    async delete(key) {
      data.delete(key);
    },
    async list() {
      if (counters) {
        // Everything read before the first list() is a direct-key lookup; anything
        // after belongs to the shared scan pass.
        if (counters.directReads === null) counters.directReads = counters.reads;
        if (counters.directKeys === null) counters.directKeys = [...counters.keys];
        counters.lists += 1;
      }
      return { blobs: [...data.keys()].map((key) => ({ key })) };
    },
  };
}

function newCounters() {
  return { reads: 0, lists: 0, keys: [], directReads: null, directKeys: null };
}

/** Direct-key reads only — excludes the shared scan pass. */
function directLookupIds(counters) {
  const keys = counters.directKeys === null ? counters.keys : counters.directKeys;
  return new Set(keys.map((k) => k.trim().toUpperCase()));
}

const STATUSES = ['pending', 'pending_approval', 'applied', 'rejected', 'needs_clarification'];
const TYPES = ['vehicle_remove_request', 'reschedule_request', 'addon_request', 'package_change_request'];

function buildRequests(n) {
  const seed = {};
  for (let i = 0; i < n; i += 1) {
    const id = `cr_perf${String(i).padStart(4, '0')}`;
    seed[id] = {
      id,
      bookingId: i % 37 === 0
        ? MISSING_BOOKING_ID
        : `CD1-PERF-${String(i % UNIQUE_BOOKINGS).padStart(3, '0')}`,
      requestType: TYPES[i % TYPES.length],
      status: STATUSES[i % STATUSES.length],
      createdAt: new Date(Date.UTC(2026, 0, 1 + (i % 300), i % 24, i % 60)).toISOString(),
      previousState: {},
      requestedState: { target: { vehicleId: `veh_${i % 7}` } },
      authorizedRef: 'booking',
    };
  }
  return seed;
}

function buildBookings() {
  const seed = {};
  for (let i = 0; i < UNIQUE_BOOKINGS; i += 1) {
    const id = `CD1-PERF-${String(i).padStart(3, '0')}`;
    seed[id] = {
      id,
      bookingId: id,
      firstName: 'Perf',
      lastName: `Customer${i}`,
      bookingVersion: 3,
      approvedFinalAmount: 400 + i,
      ledger: { approvedCents: (400 + i) * 100, settledCents: i % 5 === 0 ? 10000 : 0 },
      vehicles: [{ vehicleId: `veh_${i % 7}`, make: 'Ford', model: 'Bronco' }],
    };
  }
  return seed;
}

let handler;
let realVerify;
let bookingCounters;

function loadHandler() {
  delete require.cache[require.resolve(HANDLER)];
  return require(HANDLER);
}

async function list(fn, { status = 'pending', cursor = '' } = {}) {
  const qs = { action: 'list', status };
  if (cursor) qs.cursor = cursor;
  const res = await fn.handler({
    httpMethod: 'GET',
    headers: { 'x-admin-key': 'k'.repeat(32) },
    queryStringParameters: qs,
  });
  return { statusCode: res.statusCode, body: JSON.parse(res.body || '{}') };
}

function setup(requestCount) {
  bookingCounters = newCounters();
  opsDb.setOpsStoreOverride(createCountingStore(buildBookings(), bookingCounters));
  handler = loadHandler();
  handler.setRequestStoreOverride(createCountingStore(buildRequests(requestCount), null));
}

/** Booking ids resolved by direct key lookup (excludes the shared scan pass). */
function bookingIdsRead() {
  return directLookupIds(bookingCounters);
}

describe('admin customer-requests list — query order and N+1', () => {
  beforeEach(() => {
    realVerify = adminSecurity.verifyAdminRequest;
    adminSecurity.verifyAdminRequest = async (headers) => {
      const token = ((headers && headers['x-admin-key']) || '').trim();
      if (!token || token.length < 16) return { ok: false, error: 'unauthorized' };
      return { ok: true, username: 'test-admin' };
    };
  });

  afterEach(() => {
    adminSecurity.verifyAdminRequest = realVerify;
    opsDb.setOpsStoreOverride(null);
    if (handler) handler.setRequestStoreOverride(null);
  });

  it('1. applies the status filter before any booking enrichment', async () => {
    setup(1000);
    const { body } = await list(handler, { status: 'approved' });
    // 'applied'/'approved' is 1/5 of the fixture; enrichment must not touch the rest
    assert.ok(body.totalFiltered > 0);
    assert.ok(
      bookingIdsRead().size <= new Set(body.requests.map((r) => r.bookingId)).size,
      `read ${bookingIdsRead().size} bookings for a ${body.requests.length}-row page`
    );
  });

  it('2. paginates before booking enrichment', async () => {
    setup(1000);
    const { body } = await list(handler);
    assert.equal(body.requests.length, MAX_LIST);
    assert.ok(body.totalFiltered > MAX_LIST, 'fixture must exceed one page');
    assert.ok(bookingIdsRead().size <= MAX_LIST);
  });

  it('3. enriches only page records for 1000 requests', async () => {
    setup(1000);
    const { body } = await list(handler);
    const onPage = new Set(body.requests.map((r) => r.bookingId).filter(Boolean));
    assert.ok(
      bookingIdsRead().size <= onPage.size,
      `bookings read (${bookingIdsRead().size}) must not exceed unique ids on page (${onPage.size})`
    );
  });

  it('4. fetches each unique booking id exactly once', async () => {
    setup(1000);
    await list(handler);
    const counts = new Map();
    const direct = bookingCounters.directKeys === null ? bookingCounters.keys : bookingCounters.directKeys;
    for (const k of direct) {
      const n = k.trim().toUpperCase();
      counts.set(n, (counts.get(n) || 0) + 1);
    }
    // one direct read per unique id (a miss may try lowercase/raw variants of the SAME id)
    const overFetched = [...counts.entries()].filter(([id, n]) => n > 1 && id !== MISSING_BOOKING_ID);
    assert.deepEqual(overFetched, [], `ids fetched more than once: ${JSON.stringify(overFetched)}`);
    // misses share ONE scan pass rather than one scan each
    assert.ok(bookingCounters.lists <= 2, `expected a single shared scan, saw ${bookingCounters.lists} list() calls`);
  });

  it('5. many requests sharing one booking cause one booking lookup', async () => {
    bookingCounters = newCounters();
    opsDb.setOpsStoreOverride(createCountingStore({
      'CD1-SHARED-1': { id: 'CD1-SHARED-1', firstName: 'One', lastName: 'Booking', ledger: {} },
    }, bookingCounters));
    handler = loadHandler();
    const seed = {};
    for (let i = 0; i < 30; i += 1) {
      seed[`cr_shared${i}`] = {
        id: `cr_shared${i}`,
        bookingId: 'CD1-SHARED-1',
        requestType: 'vehicle_remove_request',
        status: 'pending',
        createdAt: `2026-03-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
      };
    }
    handler.setRequestStoreOverride(createCountingStore(seed, null));
    const { body } = await list(handler);
    assert.equal(body.requests.length, 30);
    assert.equal(bookingIdsRead().size, 1, 'one shared booking must be read once');
  });

  it('6. second page fetches only second-page booking ids', async () => {
    setup(1000);
    const first = await list(handler);
    assert.ok(first.body.nextCursor, 'first page must expose a cursor');

    setup(1000);
    const second = await list(handler, { cursor: first.body.nextCursor });
    const secondIds = new Set(second.body.requests.map((r) => r.bookingId).filter(Boolean));
    assert.ok(bookingIdsRead().size <= secondIds.size);
    const firstIds = first.body.requests.map((r) => r.id);
    assert.ok(
      second.body.requests.every((r) => !firstIds.includes(r.id)),
      'second page must not repeat first-page rows'
    );
  });

  it('7. a missing booking does not fail the whole response', async () => {
    setup(1000);
    const { statusCode, body } = await list(handler, { status: 'all' });
    assert.equal(statusCode, 200);
    assert.equal(body.ok, true);
    assert.ok(body.requests.length > 0);
  });

  it('8. a missing booking still produces a safe projected row', async () => {
    setup(1000);
    const { body } = await list(handler, { status: 'all' });
    const orphan = body.requests.find((r) => r.bookingId === MISSING_BOOKING_ID);
    assert.ok(orphan, 'fixture must place an orphan request on the first page');
    assert.equal(orphan.bookingUnavailable, true);
    assert.equal(orphan.customerName, '');
    assert.ok(orphan.id && orphan.requestType && orphan.status);
    const serialized = JSON.stringify(orphan);
    assert.ok(!/\/netlify\/|node_modules|at Object\.|Error:/.test(serialized),
      'row must not leak storage internals or stack traces');
  });

  it('9. preserves stable createdAt-desc ordering', async () => {
    setup(1000);
    const { body } = await list(handler);
    const stamps = body.requests.map((r) => String(r.createdAt || ''));
    const sorted = [...stamps].sort((a, b) => b.localeCompare(a));
    assert.deepEqual(stamps, sorted);
  });

  it('10. reports the correct total filtered count', async () => {
    setup(1000);
    const { body } = await list(handler, { status: 'all' });
    assert.equal(body.totalFiltered, 1000);
    const pending = await list(handler, { status: 'pending' });
    // open statuses are 3 of the 5 cycled values
    assert.equal(pending.body.totalPending, 600);
    assert.equal(pending.body.totalFiltered, 600);
  });

  it('11. keeps the response schema backward compatible', async () => {
    setup(100);
    const { body } = await list(handler);
    for (const k of ['ok', 'requests', 'bounded', 'max', 'totalPending', 'totalFiltered', 'statusFilter', 'nextCursor']) {
      assert.ok(k in body, `missing response key: ${k}`);
    }
    assert.equal(body.bounded, true);
    assert.equal(body.max, MAX_LIST);
    const row = body.requests[0];
    for (const k of ['id', 'requestId', 'bookingId', 'requestType', 'status', 'createdAt', 'typeLabel', 'paymentImpact', 'previousState', 'requestedState']) {
      assert.ok(k in row, `missing row key: ${k}`);
    }
  });

  it('12. leaves authentication and authorization unchanged', async () => {
    setup(10);
    const res = await handler.handler({
      httpMethod: 'GET', headers: {}, queryStringParameters: { action: 'list' },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error, 'unauthorized');
    assert.equal(bookingCounters.reads, 0, 'unauthorized request must not read bookings');
  });

  it('13. keeps vehicle-removal requests visible', async () => {
    setup(1000);
    const { body } = await list(handler, { status: 'all' });
    assert.ok(body.requests.some((r) => r.requestType === 'vehicle_remove_request'));
    const row = body.requests.find((r) => r.requestType === 'vehicle_remove_request');
    assert.equal(row.typeLabel, 'Vehicle removal');
  });

  it('14. keeps approved and declined requests visible under their filters', async () => {
    setup(1000);
    const approved = await list(handler, { status: 'approved' });
    assert.ok(approved.body.requests.length > 0);
    assert.ok(approved.body.requests.every((r) => ['applied', 'approved'].includes(String(r.status).toLowerCase())));

    setup(1000);
    const declined = await list(handler, { status: 'declined' });
    assert.ok(declined.body.requests.length > 0);
    assert.ok(declined.body.requests.every((r) => ['rejected', 'declined'].includes(String(r.status).toLowerCase())));
  });

  it('15b. a booking-store outage degrades rows instead of failing the page', async () => {
    // No booking-store override at all — bookingStore() throws MissingBlobsEnvironmentError,
    // exactly as it does for callers that only stub the request store.
    opsDb.setOpsStoreOverride(null);
    handler = loadHandler();
    handler.setRequestStoreOverride(createCountingStore(buildRequests(60), null));

    const { statusCode, body } = await list(handler);
    assert.equal(statusCode, 200);
    assert.equal(body.ok, true);
    assert.ok(body.requests.length > 0, 'rows must still render');
    assert.ok(body.requests.every((r) => r.bookingUnavailable === true));
    assert.ok(body.totalPending > 0);
  });

  it('15. introduces no Stripe, ledger or pricing imports', () => {
    const forbidden = /require\(['"][^'"]*(stripe|ledger|pricing-catalog|price-catalog)[^'"]*['"]\)/i;
    for (const rel of ['netlify/functions/admin-customer-requests.js', 'netlify/lib/ops-db.js']) {
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      assert.equal(forbidden.test(src), false, `${rel} must not import Stripe/ledger/pricing`);
    }
  });

  it('16. pending list with an open catalog GETs only catalog ids, not closed history', async () => {
    bookingCounters = newCounters();
    opsDb.setOpsStoreOverride(createCountingStore(buildBookings(), bookingCounters));
    handler = loadHandler();
    const requests = buildRequests(1000);
    const openIds = Object.values(requests)
      .filter((r) => ['pending', 'pending_approval', 'needs_clarification'].includes(r.status))
      .slice(0, 8)
      .map((r) => r.id);
    requests._open_catalog = { v: 1, ids: openIds, updatedAt: '2026-01-01T00:00:00.000Z' };
    const requestCounters = newCounters();
    handler.setRequestStoreOverride(createCountingStore(requests, requestCounters));

    const { statusCode, body } = await list(handler, { status: 'pending' });
    assert.equal(statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(requestCounters.lists, 0, 'catalog hit must not list the request store');
    const got = new Set(requestCounters.keys);
    assert.ok(got.has('_open_catalog'), 'must read the catalog key');
    for (const id of openIds) {
      assert.ok(got.has(id), `must GET catalog id ${id}`);
    }
    const extra = [...got].filter((k) => k !== '_open_catalog' && !openIds.includes(k));
    assert.deepEqual(extra, [], `must not GET closed/history keys: ${extra.join(',')}`);
    assert.equal(body.requests.length, 8);
    assert.ok(body.requests.every((r) => openIds.includes(r.id)));
    assert.equal(body.totalPending, 8);
  });

  it('17. status=all still scans the store so closed history remains visible', async () => {
    bookingCounters = newCounters();
    opsDb.setOpsStoreOverride(createCountingStore(buildBookings(), bookingCounters));
    handler = loadHandler();
    const requests = buildRequests(200);
    const openIds = Object.values(requests)
      .filter((r) => r.status === 'pending')
      .slice(0, 3)
      .map((r) => r.id);
    requests._open_catalog = { v: 1, ids: openIds, updatedAt: '2026-01-01T00:00:00.000Z' };
    const requestCounters = newCounters();
    handler.setRequestStoreOverride(createCountingStore(requests, requestCounters));

    const { body } = await list(handler, { status: 'all' });
    assert.equal(body.totalFiltered, 200);
    assert.ok(requestCounters.lists >= 1, 'closed/all must still list blobs');
    assert.ok(body.requests.some((r) => r.status === 'applied' || r.status === 'rejected'));
  });
});

describe('open-request catalog helpers', () => {
  const {
    hydrateRequestRecords,
    syncOpenCatalog,
    OPEN_CATALOG_KEY,
  } = require('../netlify/lib/customer-change-requests');

  it('hydrateRequestRecords skips underscore catalog keys', async () => {
    const counters = newCounters();
    const store = createCountingStore({
      [OPEN_CATALOG_KEY]: { v: 1, ids: ['cr_open'] },
      _other: { id: '_other', status: 'pending' },
      cr_open: { id: 'cr_open', status: 'pending' },
      cr_closed: { id: 'cr_closed', status: 'applied' },
    }, counters);
    const rows = await hydrateRequestRecords(store, [
      OPEN_CATALOG_KEY,
      '_other',
      'cr_open',
      'cr_closed',
    ]);
    assert.deepEqual(rows.map((r) => r.id).sort(), ['cr_closed', 'cr_open']);
    assert.ok(!counters.keys.includes(OPEN_CATALOG_KEY));
    assert.ok(!counters.keys.includes('_other'));
  });

  it('syncOpenCatalog adds open ids and removes closed ids', async () => {
    const store = createCountingStore({
      [OPEN_CATALOG_KEY]: { v: 1, ids: ['cr_keep', 'cr_done'], updatedAt: '2026-01-01T00:00:00.000Z' },
    });
    await syncOpenCatalog(store, { id: 'cr_new', status: 'pending' });
    await syncOpenCatalog(store, { id: 'cr_done', status: 'applied' });
    const catalog = await store.get(OPEN_CATALOG_KEY);
    assert.ok(catalog.ids.includes('cr_keep'));
    assert.ok(catalog.ids.includes('cr_new'));
    assert.ok(!catalog.ids.includes('cr_done'));
  });
});

describe('getBookingsByIds — batch helper', () => {
  afterEach(() => opsDb.setOpsStoreOverride(null));

  it('deduplicates repeated ids and tolerates unknown ids', async () => {
    const counters = newCounters();
    opsDb.setOpsStoreOverride(createCountingStore({
      'CD1-A': { id: 'CD1-A', firstName: 'A' },
      'CD1-B': { id: 'CD1-B', firstName: 'B' },
    }, counters));

    const map = await opsDb.getBookingsByIds(['CD1-A', 'CD1-A', 'CD1-B', 'CD1-A', 'CD1-NOPE']);
    assert.equal(map.get('CD1-A').firstName, 'A');
    assert.equal(map.get('CD1-B').firstName, 'B');
    assert.equal(map.get('CD1-NOPE'), null);

    const direct = counters.directKeys === null ? counters.keys : counters.directKeys;
    const perId = direct.filter((k) => k.toUpperCase() === 'CD1-A').length;
    assert.equal(perId, 1, 'repeated id must be read once');
    assert.ok(counters.lists <= 2, 'the unknown id must not trigger more than one scan');
  });

  it('resolves misses with a single shared scan, not one scan per id', async () => {
    const counters = newCounters();
    // blob keys deliberately differ from payload ids — forces the scan path
    opsDb.setOpsStoreOverride(createCountingStore({
      'listkey-1': { id: 'CD1-X1', firstName: 'X1' },
      'listkey-2': { id: 'CD1-X2', firstName: 'X2' },
      'listkey-3': { id: 'CD1-X3', firstName: 'X3' },
    }, counters));

    const map = await opsDb.getBookingsByIds(['CD1-X1', 'CD1-X2', 'CD1-X3']);
    assert.equal(map.get('CD1-X1').firstName, 'X1');
    assert.equal(map.get('CD1-X3').firstName, 'X3');
    // listAllBlobs probes paginated then plain — one scan pass, not one per id
    assert.ok(counters.lists <= 2, `expected a single shared scan, saw ${counters.lists} list() calls`);
  });

  it('returns an empty map without touching the store for an empty id set', async () => {
    const counters = newCounters();
    opsDb.setOpsStoreOverride(createCountingStore({}, counters));
    const map = await opsDb.getBookingsByIds([]);
    assert.equal(map.size, 0);
    assert.equal(counters.reads, 0);
    assert.equal(counters.lists, 0);
  });
});
