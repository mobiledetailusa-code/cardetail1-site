/**
 * PostgreSQL-authoritative Admin full-balance cash settlement.
 * Proves cash amount comes from PG remaining — never stale Blob.
 */
'use strict';

require('dotenv/config');

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { prismaConfigured, getPrisma } = require('../netlify/lib/prisma');

const dbConfigured = prismaConfigured();
const RUN_ID = `TESTDB-CASHPG-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
let idCounter = 0;
function nextId(label) {
  idCounter += 1;
  return `${RUN_ID}-${label}-${idCounter}`;
}

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const PG_ENV = { ...process.env, CD1_POSTGRES_PAYMENT: '1' };
const BLOB_ENV = { ...process.env, CD1_POSTGRES_PAYMENT: '0' };

function createMemoryStore(seed = {}) {
  const data = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const etags = new Map();
  for (const [k] of data) etags.set(k, `etag-${k}-0`);
  return {
    async get(key) {
      if (!data.has(key)) return null;
      return JSON.parse(JSON.stringify(data.get(key)));
    },
    async getWithMetadata(key) {
      if (!data.has(key)) return null;
      return {
        data: JSON.parse(JSON.stringify(data.get(key))),
        etag: etags.get(key) || null,
      };
    },
    async setJSON(key, value, opts = {}) {
      if (opts.onlyIfMatch) {
        const current = etags.get(key);
        if (!current || current !== opts.onlyIfMatch) return { modified: false };
      }
      data.set(key, JSON.parse(JSON.stringify(value)));
      etags.set(key, `etag-${key}-${Date.now()}-${Math.random()}`);
      return { modified: true };
    },
    async list() {
      return { blobs: [...data.keys()].map((key) => ({ key })) };
    },
    _snapshot(key) {
      return data.has(key) ? JSON.parse(JSON.stringify(data.get(key))) : null;
    },
  };
}

function baseBooking(id, {
  approvedCents = 15000,
  settledCents = 0,
  creditedCents = 0,
  bookingVersion = 1,
  quoteVersion = 1,
  paymentStatus = null,
  paymentWorkflowStatus = null,
  jobStatus = null,
  serviceStatus = null,
} = {}) {
  const remaining = Math.max(0, approvedCents - settledCents - creditedCents);
  const fullyPaid = remaining === 0 && settledCents > 0;
  return {
    id,
    bookingVersion,
    schemaVersion: 1,
    quoteVersion,
    status: fullyPaid ? 'Paid' : 'Confirmed',
    appointmentStatus: 'confirmed',
    jobStatus: jobStatus || (fullyPaid ? 'completed_paid' : 'confirmed'),
    serviceStatus: serviceStatus || (fullyPaid ? 'closed' : 'confirmed'),
    paymentStatus: paymentStatus || (fullyPaid ? 'paid' : 'due'),
    paymentWorkflowStatus: paymentWorkflowStatus
      || (fullyPaid ? 'payment_succeeded' : 'awaiting_customer_payment'),
    zipCode: '07102',
    travelFeeAmount: 0,
    approvedFinalAmount: approvedCents / 100,
    totalPrice: approvedCents / 100,
    amountPaid: settledCents / 100,
    paidAmount: settledCents / 100,
    ledger: {
      currency: 'usd',
      approvedCents,
      settledCents,
      creditedCents,
      entries: settledCents > 0
        ? [{
          kind: 'settlement',
          amountCents: settledCents,
          providerObjectId: `pi_seed_${id}`,
          recordedAt: new Date().toISOString(),
        }]
        : [],
    },
    paymentAttempts: [],
    vehicles: [{
      vehicleId: 'veh_1',
      cat: 'cars',
      category: 'cars',
      tierKey: 'small',
      packageId: 'maint',
      pkgId: 'maint',
      pkgName: 'Maintenance Detail',
      addOnIds: [],
      addons: [],
    }],
    changeRequests: [],
  };
}

describe('PostgreSQL cash settlement authority', {
  skip: !dbConfigured && 'DATABASE_URL not configured',
}, () => {
  let prisma;
  let setBookingStoreOverride;
  let adminMarkCashReceived;
  let financialProjection;
  let projectJobForAdmin;
  let authority;
  const createdBookingIds = [];

  before(() => {
    prisma = getPrisma();
    ({ setBookingStoreOverride } = require('../netlify/lib/booking-repository'));
    ({ adminMarkCashReceived } = require('../netlify/functions/admin-ops-jobs'));
    ({ financialProjection } = require('../netlify/lib/payment-service'));
    ({ projectJobForAdmin } = require('../netlify/lib/ops-workflow'));
    authority = require('../netlify/lib/db/payment-authority-service');
  });

  after(async () => {
    setBookingStoreOverride(null);
    for (const id of createdBookingIds) {
      try {
        await prisma.paymentAttempt.deleteMany({ where: { bookingId: id } });
        await prisma.quote.deleteMany({ where: { bookingId: id } });
        await prisma.booking.delete({ where: { id } });
      } catch { /* ledger FK residue by design */ }
    }
  });

  beforeEach(() => {
    setBookingStoreOverride(null);
  });

  afterEach(() => {
    setBookingStoreOverride(null);
  });

  async function seed(booking) {
    createdBookingIds.push(booking.id);
    const store = createMemoryStore({ [booking.id]: booking });
    setBookingStoreOverride(store);
    const { ensureBookingFinancial } = require('../netlify/lib/db/ensure-booking-financial');
    const ensured = await ensureBookingFinancial(booking);
    assert.equal(ensured.ok, true, ensured.error);
    return store;
  }

  async function settle(store, booking, body = {}, extra = {}) {
    return adminMarkCashReceived({
      bookingId: booking.id,
      body,
      previousBooking: store._snapshot(booking.id),
      store,
      env: PG_ENV,
      ...extra,
    });
  }

  async function pgSnapshot(bookingId) {
    return authority.getFinancialProjection(bookingId);
  }

  async function cashEntries(bookingId) {
    const rows = await prisma.ledgerEntry.findMany({
      where: { bookingId },
      orderBy: { recordedAt: 'asc' },
    });
    return rows.filter((e) => authority.isCashSettlementEntry(e));
  }

  it('1) omitted amount: PG 15000/0/15000 → 15000/15000/0', async () => {
    const id = nextId('OMIT');
    const booking = baseBooking(id);
    const store = await seed(booking);
    const before = await pgSnapshot(id);
    assert.equal(before.approvedCents, 15000);
    assert.equal(before.settledCents, 0);
    assert.equal(before.remainingCents, 15000);

    const result = await settle(store, booking, {});
    assert.equal(result.ok, true, result.error);
    assert.equal(result.authority, 'postgres');
    assert.equal(result.postgresProjection.approvedCents, 15000);
    assert.equal(result.postgresProjection.settledCents, 15000);
    assert.equal(result.postgresProjection.remainingCents, 0);
    assert.equal(result.settledAmountCents, 15000);
    assert.equal(result.paymentStatus, 'paid_cash');
    assert.equal(result.jobStatus, 'completed_paid');
    assert.equal(result.serviceStatus, 'closed');

    const after = await pgSnapshot(id);
    assert.equal(after.remainingCents, 0);
    assert.equal(after.settledCents, 15000);
  });

  it('2) amount 150 dollars succeeds once', async () => {
    const id = nextId('EXACT');
    const booking = baseBooking(id);
    const store = await seed(booking);

    const result = await settle(store, booking, { amount: 150 });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.settledAmountCents, 15000);
    assert.equal((await cashEntries(id)).length, 1);
  });

  it('3) amount 50 rejected — no PG or Blob mutation', async () => {
    const id = nextId('PARTIAL');
    const booking = baseBooking(id);
    const store = await seed(booking);
    const beforePg = await pgSnapshot(id);
    const beforeBlob = store._snapshot(id);

    const result = await settle(store, booking, { amount: 50 });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'cash_amount_mismatch');
    assert.equal(result.statusCode, 400);
    assert.equal(result.expectedAmountCents, 15000);
    assert.equal(result.receivedAmountCents, 5000);

    const afterPg = await pgSnapshot(id);
    assert.equal(afterPg.settledCents, beforePg.settledCents);
    assert.equal(afterPg.remainingCents, beforePg.remainingCents);
    assert.equal((await cashEntries(id)).length, 0);

    const afterBlob = store._snapshot(id);
    assert.equal(afterBlob.bookingVersion, beforeBlob.bookingVersion);
    assert.equal(afterBlob.paymentStatus, beforeBlob.paymentStatus);
    assert.equal(afterBlob.ledger.settledCents, beforeBlob.ledger.settledCents);
  });

  it('4+5) stale Blob remaining ignored — PG delta 4000 settles exactly 4000; portals agree', async () => {
    const id = nextId('DELTA');
    const booking = baseBooking(id, {
      approvedCents: 15000,
      settledCents: 15000,
      paymentStatus: 'paid',
      paymentWorkflowStatus: 'payment_succeeded',
      jobStatus: 'completed_paid',
      serviceStatus: 'closed',
    });
    const store = await seed(booking);

    // Authoritative post-pay add-on delta on Postgres (approved 19000, remaining 4000).
    const adjusted = await authority.createAdjustment({
      bookingId: id,
      newApprovedCents: 19000,
      reason: 'addon_add',
    });
    assert.equal(adjusted.ok, true, adjusted.error);
    const pgMid = await pgSnapshot(id);
    assert.equal(pgMid.approvedCents, 19000);
    assert.equal(pgMid.settledCents, 15000);
    assert.equal(pgMid.remainingCents, 4000);
    const quoteBeforeCash = pgMid.quoteVersion;

    // Intentionally stale Blob — looks like full unpaid 19000, not 4000 remaining.
    const stale = store._snapshot(id);
    stale.ledger = {
      currency: 'usd',
      approvedCents: 19000,
      settledCents: 0,
      creditedCents: 0,
      entries: [],
    };
    stale.approvedFinalAmount = 215;
    stale.totalPrice = 215;
    stale.amountPaid = 0;
    stale.paidAmount = 0;
    stale.paymentStatus = 'due';
    stale.paymentWorkflowStatus = 'awaiting_customer_payment';
    stale.jobStatus = 'confirmed';
    stale.serviceStatus = 'confirmed';
    stale.quoteVersion = quoteBeforeCash;
    await store.setJSON(id, stale);
    assert.equal(financialProjection(store._snapshot(id)).remainingCents, 19000);

    const result = await settle(store, stale, { amount: 40 });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.authority, 'postgres');
    assert.equal(result.settledAmountCents, 4000);
    assert.equal(result.postgresProjection.remainingCents, 0);
    assert.equal(result.postgresProjection.settledCents, 19000);
    assert.equal(result.postgresProjection.approvedCents, 19000);

    const pgAfter = await pgSnapshot(id);
    assert.equal(pgAfter.remainingCents, 0);
    assert.equal(pgAfter.settledCents, 19000);
    assert.equal(pgAfter.quoteVersion, quoteBeforeCash, 'cash must not bump quoteVersion');

    const blobAfter = store._snapshot(id);
    const blobFp = financialProjection(blobAfter);
    assert.equal(blobFp.remainingCents, 0);
    assert.equal(blobFp.settledCents, 19000);
    assert.equal(blobFp.approvedCents, 19000);

    const admin = projectJobForAdmin(blobAfter);
    assert.equal(admin.remainingCents, 0);
    assert.equal(admin.settledCents, 19000);
    assert.equal(result.financialProjection.remainingCents, 0);

    const cash = await cashEntries(id);
    assert.equal(cash.length, 1);
    assert.equal(cash[0].amountCents, 4000);
    assert.equal(cash[0].providerObjectId, 'cash');
  });

  it('6) cash settlement entry uses provider cash', async () => {
    const id = nextId('PROV');
    const booking = baseBooking(id);
    const store = await seed(booking);
    await settle(store, booking, {});
    const cash = await cashEntries(id);
    assert.equal(cash.length, 1);
    assert.equal(cash[0].providerObjectId, 'cash');
    assert.equal(cash[0].actor, 'admin_mark_cash_received');
    assert.match(String(cash[0].providerEventId), /^cash_full_balance:/);
  });

  it('7) cash does not create package/add-on quote adjustment', async () => {
    const id = nextId('NOQ');
    const booking = baseBooking(id);
    const store = await seed(booking);
    const before = await pgSnapshot(id);
    const quotesBefore = await prisma.quote.count({ where: { bookingId: id } });

    await settle(store, booking, {});
    const after = await pgSnapshot(id);
    const quotesAfter = await prisma.quote.count({ where: { bookingId: id } });
    assert.equal(after.quoteVersion, before.quoteVersion);
    assert.equal(quotesAfter, quotesBefore);
  });

  it('8) concurrent requests create one positive cash settlement only', async () => {
    const id = nextId('CONC');
    const booking = baseBooking(id);
    const store = await seed(booking);

    const [a, b] = await Promise.all([
      authority.recordFullBalanceCashSettlement({ bookingId: id, body: {} }),
      authority.recordFullBalanceCashSettlement({ bookingId: id, body: {} }),
    ]);

    assert.ok(a.ok && b.ok, JSON.stringify({ a, b }));
    assert.equal([a, b].filter((r) => r.created).length, 1);
    assert.equal([a, b].filter((r) => r.duplicate || r.noop).length, 1);

    const cash = await cashEntries(id);
    assert.equal(cash.length, 1);
    assert.equal(cash[0].amountCents, 15000);
    const pg = await pgSnapshot(id);
    assert.equal(pg.settledCents, 15000);
    assert.equal(pg.remainingCents, 0);

    // Compatibility close once after concurrent money settle.
    const closed = await settle(store, store._snapshot(id), {});
    assert.ok(closed.ok || closed.error === 'already_paid', closed.error);
    assert.equal(financialProjection(store._snapshot(id)).remainingCents, 0);
    assert.equal((await cashEntries(id)).length, 1);
  });

  it('9) retry after success is idempotent — no second settlement', async () => {
    const id = nextId('IDEM');
    const booking = baseBooking(id);
    const store = await seed(booking);

    const first = await settle(store, booking, {});
    assert.equal(first.ok, true, first.error);
    const mid = store._snapshot(id);

    const second = await settle(store, mid, {});
    assert.equal(second.ok, false);
    assert.equal(second.error, 'already_paid');
    assert.equal((await cashEntries(id)).length, 1);
  });

  it('10) Blob sync failure keeps PG settlement; retry syncs without duplicate', async () => {
    const id = nextId('SYNC');
    const booking = baseBooking(id);
    const store = await seed(booking);
    let syncCalls = 0;
    const failingSync = async () => {
      syncCalls += 1;
      return { ok: false, error: 'simulated_blob_sync_failure' };
    };

    const first = await settle(store, booking, {}, { syncBlob: failingSync });
    assert.equal(first.ok, false);
    assert.equal(first.error, 'blob_sync_failed');
    assert.equal(first.settlementRecorded, true);
    assert.equal(first.postgresProjection.remainingCents, 0);
    assert.equal((await cashEntries(id)).length, 1);
    assert.equal(financialProjection(store._snapshot(id)).remainingCents, 15000);

    const second = await settle(store, store._snapshot(id), {});
    assert.equal(second.ok, true, second.error);
    assert.equal(second.noop, true);
    assert.equal((await cashEntries(id)).length, 1);
    assert.equal(financialProjection(store._snapshot(id)).remainingCents, 0);
    assert.equal(store._snapshot(id).paymentStatus, 'paid_cash');
    assert.ok(syncCalls >= 1);
  });

  it('11) stale expectedBookingVersion creates no settlement', async () => {
    const id = nextId('STALE');
    const booking = baseBooking(id, { bookingVersion: 3 });
    const store = await seed(booking);

    const result = await settle(store, booking, {
      amount: 150,
      expectedBookingVersion: 2,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'version_conflict');
    assert.equal((await cashEntries(id)).length, 0);
    assert.equal((await pgSnapshot(id)).remainingCents, 15000);
  });

  it('12) rejected amount changes no PG quote/settlement/PaymentAttempt/Blob status', async () => {
    const id = nextId('REJ');
    const booking = baseBooking(id);
    const store = await seed(booking);
    const beforePg = await pgSnapshot(id);
    const beforeAttempts = await prisma.paymentAttempt.count({ where: { bookingId: id } });
    const beforeQuotes = await prisma.quote.count({ where: { bookingId: id } });
    const beforeBlob = store._snapshot(id);

    const result = await settle(store, booking, { amount: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'cash_amount_mismatch');

    const afterPg = await pgSnapshot(id);
    assert.deepEqual(
      {
        approved: afterPg.approvedCents,
        settled: afterPg.settledCents,
        remaining: afterPg.remainingCents,
        quote: afterPg.quoteVersion,
      },
      {
        approved: beforePg.approvedCents,
        settled: beforePg.settledCents,
        remaining: beforePg.remainingCents,
        quote: beforePg.quoteVersion,
      }
    );
    assert.equal(await prisma.paymentAttempt.count({ where: { bookingId: id } }), beforeAttempts);
    assert.equal(await prisma.quote.count({ where: { bookingId: id } }), beforeQuotes);
    assert.equal((await cashEntries(id)).length, 0);

    const afterBlob = store._snapshot(id);
    assert.equal(afterBlob.bookingVersion, beforeBlob.bookingVersion);
    assert.equal(afterBlob.paymentStatus, beforeBlob.paymentStatus);
    assert.equal(afterBlob.jobStatus, beforeBlob.jobStatus);
  });

  it('13) PostgreSQL-disabled fallback retains Blob full-balance path', async () => {
    const id = nextId('BLOB');
    const booking = baseBooking(id);
    const store = createMemoryStore({ [id]: booking });
    setBookingStoreOverride(store);

    const result = await adminMarkCashReceived({
      bookingId: id,
      body: {},
      previousBooking: booking,
      store,
      env: BLOB_ENV,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.authority, 'blob');
    assert.equal(result.projection.remainingCents, 0);
    assert.equal(result.settledAmountCents, 15000);
  });

  it('14) Admin submits the entered amount with booking-version CAS', () => {
    const src = read('admin-ops.html');
    assert.match(src, /mark_cash_received',\s*\{\s*amount:\s*String\(amt\)\.trim\(\),\s*expectedBookingVersion:\s*j\.bookingVersion/);
  });

  it('15) omitted amount also works after stale-blob delta (no amount field)', async () => {
    const id = nextId('OMITD');
    const booking = baseBooking(id, {
      approvedCents: 15000,
      settledCents: 15000,
      paymentStatus: 'paid',
      paymentWorkflowStatus: 'payment_succeeded',
    });
    const store = await seed(booking);
    await authority.createAdjustment({ bookingId: id, newApprovedCents: 19000 });
    const stale = store._snapshot(id);
    stale.ledger = {
      currency: 'usd',
      approvedCents: 99999,
      settledCents: 0,
      creditedCents: 0,
      entries: [],
    };
    stale.paymentStatus = 'due';
    await store.setJSON(id, stale);

    const result = await settle(store, stale, {});
    assert.equal(result.ok, true, result.error);
    assert.equal(result.settledAmountCents, 4000);
    assert.equal((await pgSnapshot(id)).remainingCents, 0);
  });
});
