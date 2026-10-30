'use strict';

process.env.PRISMA_BOOKING_MIRROR = '0';
process.env.PRISMA_BOOKING_READ = '0';
process.env.CD1_POSTGRES_PAYMENT = '0';
delete process.env.NETLIFY_SITE_ID;
delete process.env.NETLIFY_AUTH_TOKEN;
delete process.env.NETLIFY_BLOBS_CONTEXT;
delete process.env.DATABASE_URL;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createCasMemoryStore } = require('./helpers/cas-memory-store');
const { commitBooking, getBookingRecord } = require('../netlify/lib/booking-repository');
const { upsertBookingMirror, MIRROR_UPSERT_SQL } = require('../netlify/lib/booking-prisma-mirror');

function loadCashEventIdBuilder() {
  const src = fs.readFileSync(path.join(root, 'netlify/lib/db/payment-authority-service.js'), 'utf8');
  const start = src.indexOf('function buildOnSiteFullBalanceProviderEventId');
  const end = src.indexOf('function buildCashFullBalanceProviderEventId');
  return new Function(`${src.slice(start, end)}; return buildOnSiteFullBalanceProviderEventId;`)();
}

const root = path.resolve(__dirname, '..');
const BOOKING_ID = 'CD1-S2CINTEG1';

global.fetch = () => {
  throw new Error('network_forbidden');
};

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
    paymentMethodPreference: 'cash_onsite',
    manualPayLink: 'https://pay.example.test/manual',
    manualPayLinkAt: '2026-10-01T00:00:00.000Z',
    technicianNote: 'original-note',
    ledger: {
      currency: 'usd',
      approvedCents: 25000,
      settledCents: 0,
      creditedCents: 0,
      pendingCents: 0,
      entries: [{ entryId: 'le_existing', kind: 'quote', amountCents: 25000, currency: 'usd' }],
    },
    squareLinkPreparation: {
      bookingId: BOOKING_ID,
      issuanceId: '55555555-5555-4555-8555-555555555555',
      state: 'prepared',
      amountCents: 25000,
      currency: 'USD',
      correlationReference: '55555555-5555-4555-8555-555555555555',
      preparedAt: '2026-10-30T21:00:00.000Z',
      operationId: require('crypto').createHash('sha256').update(JSON.stringify([
        '55555555-5555-4555-8555-555555555555',
        BOOKING_ID,
        25000,
        'USD',
      ]), 'utf8').digest('hex'),
    },
    squareLinkPreparationHistory: [],
    ...overrides,
  };
}

function saved(store) {
  return JSON.parse(store._data.get(BOOKING_ID).value);
}

function paidLedger() {
  return {
    currency: 'usd',
    approvedCents: 25000,
    settledCents: 25000,
    creditedCents: 0,
    pendingCents: 0,
    entries: [
      { entryId: 'le_existing', kind: 'quote', amountCents: 25000, currency: 'usd' },
      { entryId: 'le_cash', kind: 'settlement', method: 'cash', amountCents: 25000, currency: 'usd' },
    ],
  };
}

test('a new booking is created with onlyIfNew and does not need a prior etag', async () => {
  const store = createCasMemoryStore();
  let options = null;
  const original = store.setJSON.bind(store);
  store.setJSON = async (key, value, opts) => {
    options = opts;
    return original(key, value, opts);
  };
  const created = await commitBooking({
    bookingId: BOOKING_ID,
    expectedBookingVersion: 0,
    createIfMissing: true,
    syncSlots: false,
    storeOverride: store,
    nextAggregate: booking({ bookingVersion: 1 }),
  });
  assert.equal(created.ok, true);
  assert.equal(created.booking.bookingVersion, 1);
  assert.equal(options.onlyIfNew, true);
  assert.equal(options.onlyIfMatch, undefined);
  const again = await commitBooking({
    bookingId: BOOKING_ID,
    expectedBookingVersion: 0,
    createIfMissing: true,
    syncSlots: false,
    storeOverride: store,
    nextAggregate: booking({ bookingVersion: 1, technicianNote: 'second' }),
  });
  assert.equal(again.ok, false);
  assert.equal(again.error, 'version_conflict');
  assert.equal(saved(store).technicianNote, 'original-note');
});

test('an existing update requires a trusted etag and a non-empty success etag', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  let match = null;
  let consistency = null;
  const originalGet = store.getWithMetadata.bind(store);
  const originalSet = store.setJSON.bind(store);
  store.getWithMetadata = async (key, opts) => {
    consistency = opts && opts.consistency;
    return originalGet(key, opts);
  };
  store.setJSON = async (key, value, opts) => {
    match = opts && opts.onlyIfMatch;
    return originalSet(key, value, opts);
  };
  const updated = await commitBooking({
    bookingId: BOOKING_ID,
    expectedBookingVersion: 4,
    syncSlots: false,
    storeOverride: store,
    nextAggregate: { ...booking(), technicianNote: 'kept-with-money' },
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.booking.bookingVersion, 5);
  assert.equal(typeof match, 'string');
  assert.ok(match.length > 0);
  assert.equal(consistency, 'strong');
  assert.equal(saved(store).ledger.entries[0].entryId, 'le_existing');
  assert.equal(saved(store).manualPayLink, 'https://pay.example.test/manual');
  const seen = await getBookingRecord(BOOKING_ID, { storeOverride: store });
  assert.equal(seen.etagTrusted, true);
});

test('a missing etag does not write and an empty acknowledgement is not success', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  let writes = 0;
  const original = store.setJSON.bind(store);
  store.getWithMetadata = async (key) => {
    if (!store._data.has(key)) return null;
    return { data: JSON.parse(store._data.get(key).value), etag: null };
  };
  store.setJSON = async (...args) => {
    writes += 1;
    return original(...args);
  };
  const missing = await commitBooking({
    bookingId: BOOKING_ID,
    expectedBookingVersion: 4,
    syncSlots: false,
    storeOverride: store,
    nextAggregate: { ...booking(), technicianNote: 'should-not-land' },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'cas_precondition_missing');
  assert.equal(writes, 0);
  assert.equal(saved(store).technicianNote, 'original-note');

  store.getWithMetadata = async (key) => {
    if (!store._data.has(key)) return null;
    const entry = store._data.get(key);
    return { data: JSON.parse(entry.value), etag: entry.etag };
  };
  store.setJSON = async () => undefined;
  const empty = await commitBooking({
    bookingId: BOOKING_ID,
    expectedBookingVersion: 4,
    syncSlots: false,
    storeOverride: store,
    nextAggregate: { ...booking(), ledger: paidLedger(), paymentStatus: 'paid_cash' },
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'write_outcome_unknown');
  assert.equal(saved(store).paymentStatus, 'unpaid');
  assert.equal(saved(store).ledger.settledCents, 0);
});

test('modified true with an empty etag and a malformed acknowledgement stay unknown', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  store.setJSON = async (key, value) => {
    store._data.set(key, { value: JSON.stringify(value), etag: 'etag-landed' });
    return { modified: true, etag: '' };
  };
  const emptyEtag = await commitBooking({
    bookingId: BOOKING_ID,
    expectedBookingVersion: 4,
    syncSlots: false,
    storeOverride: store,
    nextAggregate: { ...booking(), paymentStatus: 'paid_cash', ledger: paidLedger() },
  });
  assert.equal(emptyEtag.ok, false);
  assert.equal(emptyEtag.error, 'write_outcome_unknown');

  store.setJSON = async () => ({ modified: 'yes' });
  const malformed = await commitBooking({
    bookingId: BOOKING_ID,
    expectedBookingVersion: saved(store).bookingVersion,
    syncSlots: false,
    storeOverride: store,
    nextAggregate: { ...booking(), technicianNote: 'nope' },
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error, 'write_outcome_unknown');
});

test('a confirmed etag conflict leaves the newer ledger in place', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const original = store.setJSON.bind(store);
  let calls = 0;
  store.setJSON = async (...args) => {
    calls += 1;
    if (calls === 1) return { modified: false };
    return original(...args);
  };
  const conflict = await commitBooking({
    bookingId: BOOKING_ID,
    expectedBookingVersion: 4,
    syncSlots: false,
    storeOverride: store,
    nextAggregate: { ...booking(), technicianNote: 'stale-note', ledger: { ...booking().ledger, settledCents: 1 } },
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, 'version_conflict');
  assert.equal(saved(store).technicianNote, 'original-note');
  assert.equal(saved(store).ledger.settledCents, 0);
  assert.equal(saved(store).ledger.entries.length, 1);
});

test('a stale note does not overwrite a newer settlement, and the retry rereads first', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const paid = await commitBooking({
    bookingId: BOOKING_ID,
    expectedBookingVersion: 4,
    syncSlots: false,
    storeOverride: store,
    nextAggregate: {
      ...booking(),
      paymentStatus: 'paid_cash',
      ledger: paidLedger(),
    },
  });
  assert.equal(paid.ok, true);
  assert.equal(saved(store).squareLinkPreparation, null);
  assert.equal(saved(store).squareLinkPreparationHistory[0].issuanceId, booking().squareLinkPreparation.issuanceId);
  assert.equal(saved(store).squareLinkPreparationHistory[0].amountCents, 25000);

  let writes = 0;
  const original = store.setJSON.bind(store);
  store.setJSON = async (...args) => {
    writes += 1;
    return original(...args);
  };
  const stale = await commitBooking({
    bookingId: BOOKING_ID,
    expectedBookingVersion: 4,
    syncSlots: false,
    storeOverride: store,
    nextAggregate: { ...booking(), technicianNote: 'late-note' },
  });
  assert.equal(stale.error, 'version_conflict');
  assert.equal(writes, 0);
  assert.equal(saved(store).ledger.settledCents, 25000);
  assert.equal(saved(store).manualPayLink, 'https://pay.example.test/manual');

  const fresh = saved(store);
  const retried = await commitBooking({
    bookingId: BOOKING_ID,
    expectedBookingVersion: fresh.bookingVersion,
    syncSlots: false,
    storeOverride: store,
    nextAggregate: { ...fresh, technicianNote: 'late-note' },
  });
  assert.equal(retried.ok, true);
  const row = saved(store);
  assert.equal(row.technicianNote, 'late-note');
  assert.equal(row.ledger.settledCents, 25000);
  assert.equal(row.ledger.entries.some((entry) => entry.entryId === 'le_cash'), true);
  assert.equal(row.squareLinkPreparation, null);
  assert.equal(row.squareLinkPreparationHistory.length, 1);
});

test('overlapping note and settlement commits cannot both win', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const base = booking();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let writes = 0;
  const original = store.setJSON.bind(store);
  store.setJSON = async (...args) => {
    writes += 1;
    if (writes === 1) await gate;
    else release();
    return original(...args);
  };
  const [note, payment] = await Promise.all([
    commitBooking({
      bookingId: BOOKING_ID,
      expectedBookingVersion: 4,
      syncSlots: false,
      storeOverride: store,
      nextAggregate: { ...base, technicianNote: 'from-note' },
    }),
    commitBooking({
      bookingId: BOOKING_ID,
      expectedBookingVersion: 4,
      syncSlots: false,
      storeOverride: store,
      nextAggregate: { ...base, paymentStatus: 'paid_cash', ledger: paidLedger() },
    }),
  ]);
  assert.equal(note.ok !== payment.ok, true);
  if (!note.ok) {
    const fresh = saved(store);
    const retry = await commitBooking({
      bookingId: BOOKING_ID,
      expectedBookingVersion: fresh.bookingVersion,
      syncSlots: false,
      storeOverride: store,
      nextAggregate: { ...fresh, technicianNote: 'from-note' },
    });
    assert.equal(retry.ok, true);
  }
  if (!payment.ok) {
    const fresh = saved(store);
    const retry = await commitBooking({
      bookingId: BOOKING_ID,
      expectedBookingVersion: fresh.bookingVersion,
      syncSlots: false,
      storeOverride: store,
      nextAggregate: { ...fresh, paymentStatus: 'paid_cash', ledger: paidLedger() },
    });
    assert.equal(retry.ok, true);
  }
  const row = saved(store);
  assert.equal(row.ledger.settledCents, 25000);
  assert.equal(row.ledger.entries.filter((entry) => entry.entryId === 'le_cash').length, 1);
  assert.equal(row.technicianNote, 'from-note');
  assert.notEqual(row.squareLinkPreparation && row.squareLinkPreparation.state, 'prepared');
  assert.equal(row.squareLinkPreparationHistory[0].state, 'superseded');
});

test('the mirror keeps a newer version when an older write arrives later', async () => {
  const rows = new Map();
  async function queryRaw(sql, params) {
    assert.match(sql, /ON CONFLICT \("id"\) DO UPDATE/);
    assert.match(sql, /"bookingVersion" <= EXCLUDED\."bookingVersion"/);
    const [id, bookingVersion] = params;
    const payload = JSON.parse(params[11]);
    const current = rows.get(id);
    if (current && current.bookingVersion > bookingVersion) return [];
    rows.set(id, { id, bookingVersion, payload });
    return [{ id }];
  }
  const newer = await upsertBookingMirror({
    id: BOOKING_ID,
    kind: 'booking',
    isDraft: false,
    bookingVersion: 11,
    paymentStatus: 'paid_cash',
    ledger: { settledCents: 25000 },
  }, { queryRaw });
  assert.equal(newer.ok, true);
  assert.equal(newer.ignored, false);
  const older = await upsertBookingMirror({
    id: BOOKING_ID,
    kind: 'booking',
    isDraft: false,
    bookingVersion: 10,
    paymentStatus: 'unpaid',
    ledger: { settledCents: 0 },
  }, { queryRaw });
  assert.equal(older.ok, true);
  assert.equal(older.ignored, true);
  assert.equal(older.reason, 'stale_mirror_version');
  assert.equal(rows.get(BOOKING_ID).bookingVersion, 11);
  assert.equal(rows.get(BOOKING_ID).payload.paymentStatus, 'paid_cash');
  const same = await upsertBookingMirror({
    id: BOOKING_ID,
    kind: 'booking',
    isDraft: false,
    bookingVersion: 11,
    paymentStatus: 'paid_cash',
    technicianNote: 'same-version-retry',
  }, { queryRaw });
  assert.equal(same.ok, true);
  assert.equal(same.ignored, false);
  assert.equal(rows.get(BOOKING_ID).bookingVersion, 11);
  assert.equal(rows.get(BOOKING_ID).payload.technicianNote, 'same-version-retry');
  const forward = await upsertBookingMirror({
    id: BOOKING_ID,
    kind: 'booking',
    isDraft: false,
    bookingVersion: 12,
    paymentStatus: 'paid_cash',
  }, { queryRaw });
  assert.equal(forward.ignored, false);
  assert.equal(rows.get(BOOKING_ID).bookingVersion, 12);
});

test('a mirror failure does not reverse a confirmed booking commit', async () => {
  const store = createCasMemoryStore({ [BOOKING_ID]: booking() });
  const committed = await commitBooking({
    bookingId: BOOKING_ID,
    expectedBookingVersion: 4,
    syncSlots: false,
    storeOverride: store,
    nextAggregate: { ...booking(), technicianNote: 'blob-wins' },
  });
  assert.equal(committed.ok, true);
  const failed = await upsertBookingMirror({
    id: BOOKING_ID,
    kind: 'booking',
    isDraft: false,
    bookingVersion: 5,
  }, {
    queryRaw: async () => {
      throw new Error('mirror_down');
    },
  });
  assert.equal(failed.ok, false);
  assert.equal(saved(store).technicianNote, 'blob-wins');
  assert.equal(saved(store).bookingVersion, 5);
  assert.match(MIRROR_UPSERT_SQL, /WHERE "BookingRecord"\."bookingVersion" <= EXCLUDED\."bookingVersion"/);
});

test('the cash and card HTTP handlers settle in Postgres before any blob copy', () => {
  const admin = fs.readFileSync(path.join(root, 'netlify/functions/admin-ops-jobs.js'), 'utf8');
  const cashStart = admin.indexOf('async function adminMarkCashReceived');
  const cardStart = admin.indexOf('async function adminMarkCardOnSite');
  const cashFn = admin.slice(cashStart, cardStart);
  const cardFn = admin.slice(cardStart, admin.indexOf('exports.adminAddonMutation'));
  assert.match(cashFn, /postgres_payment_disabled/);
  assert.ok(cashFn.indexOf("error: 'postgres_payment_disabled'") < cashFn.indexOf('settleAdminCashFullBalance({'));
  assert.match(cardFn, /postgres_payment_disabled/);
  assert.ok(cardFn.indexOf("error: 'postgres_payment_disabled'") < cardFn.indexOf('settleAdminOnSiteFullBalance({'));
  const buildOnSiteFullBalanceProviderEventId = loadCashEventIdBuilder();
  const key = buildOnSiteFullBalanceProviderEventId({
    method: 'cash',
    bookingId: BOOKING_ID,
    quoteVersion: 1,
    settledCents: 0,
    remainingCents: 25000,
  });
  assert.equal(key, 'cash_full_balance:' + [BOOKING_ID, 1, 0, 25000].join(':'));
  assert.equal(key, buildOnSiteFullBalanceProviderEventId({
    method: 'cash',
    bookingId: BOOKING_ID,
    quoteVersion: 1,
    settledCents: 0,
    remainingCents: 25000,
  }));
  const settlement = fs.readFileSync(path.join(root, 'netlify/lib/db/payment-authority-service.js'), 'utf8');
  const fn = settlement.slice(
    settlement.indexOf('async function recordFullBalanceOnSiteSettlement'),
    settlement.indexOf('async function recordFullBalanceCashSettlement')
  );
  assert.match(fn, /FOR UPDATE/);
  assert.match(fn, /providerEventId/);
  assert.match(fn, /amountCents !== remainingCents/);
  const sync = fs.readFileSync(path.join(root, 'netlify/lib/db/operational-payment.js'), 'utf8');
  const settle = sync.slice(sync.indexOf('async function settleAdminOnSiteFullBalance'), sync.indexOf('async function settleAdminCashFullBalance'));
  assert.ok(settle.indexOf('recordFullBalanceOnSiteSettlement') < settle.indexOf('syncBlob('));
});
