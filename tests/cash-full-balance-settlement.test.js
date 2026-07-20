/**
 * Full-balance cash settlement enforcement.
 * Admin mark_cash_received must settle exactly remainingCents — never partial close.
 * Blob-authoritative; no live Stripe; Postgres optional for parity checks.
 */
'use strict';

require('dotenv/config');
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const RUN_ID = `CASH-FB-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
let idCounter = 0;
function nextId(label) {
  idCounter += 1;
  return `${RUN_ID}-${label}-${idCounter}`;
}

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
  approvedCents = 17500,
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
    paymentStatus: paymentStatus
      || (fullyPaid ? 'paid' : 'due'),
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

function financialSnapshot(booking) {
  const { financialProjection } = require('../netlify/lib/payment-service');
  const fp = financialProjection(booking);
  return {
    bookingVersion: Math.round(Number(booking.bookingVersion) || 0),
    quoteVersion: Math.round(Number(booking.quoteVersion || booking.quote?.quoteVersion) || 0),
    approvedCents: fp.approvedCents,
    settledCents: fp.settledCents,
    creditedCents: Math.max(0, Math.round(Number(booking.ledger?.creditedCents) || 0)),
    remainingCents: fp.remainingCents,
    paymentStatus: fp.paymentStatus,
    jobStatus: booking.jobStatus,
    serviceStatus: booking.serviceStatus,
    ledgerEntryCount: Array.isArray(booking.ledger?.entries) ? booking.ledger.entries.length : 0,
    paymentAttemptCount: Array.isArray(booking.paymentAttempts) ? booking.paymentAttempts.length : 0,
    cashReceivedAmount: booking.cashReceivedAmount,
  };
}

describe('full-balance cash settlement', () => {
  let setBookingStoreOverride;
  let adminMarkCashReceived;
  let resolveAdminCashSettlement;
  let financialProjection;
  let projectJobForAdmin;

  before(() => {
    ({ setBookingStoreOverride } = require('../netlify/lib/booking-repository'));
    ({
      adminMarkCashReceived,
      resolveAdminCashSettlement,
    } = require('../netlify/functions/admin-ops-jobs'));
    ({ financialProjection } = require('../netlify/lib/payment-service'));
    ({ projectJobForAdmin } = require('../netlify/lib/ops-workflow'));
  });

  after(() => {
    setBookingStoreOverride(null);
  });

  beforeEach(() => {
    setBookingStoreOverride(null);
  });

  afterEach(() => {
    setBookingStoreOverride(null);
  });

  async function seed(booking) {
    const store = createMemoryStore({ [booking.id]: booking });
    setBookingStoreOverride(store);
    return store;
  }

  async function settle(store, booking, body = {}) {
    return adminMarkCashReceived({
      bookingId: booking.id,
      body,
      previousBooking: store._snapshot(booking.id),
      store,
    });
  }

  it('1) omitted amount: 17500/0/17500 → 17500/17500/0 closed/paid', async () => {
    const id = nextId('OMIT');
    const booking = baseBooking(id);
    const store = await seed(booking);

    const result = await settle(store, booking, {});
    assert.equal(result.ok, true, result.error);
    assert.equal(result.projection.approvedCents, 17500);
    assert.equal(result.projection.settledCents, 17500);
    assert.equal(result.projection.remainingCents, 0);
    assert.equal(result.projection.paymentStatus, 'paid');
    assert.equal(result.jobStatus, 'completed_paid');
    assert.equal(result.serviceStatus, 'closed');
    assert.equal(result.paymentStatus, 'paid_cash');

    const after = store._snapshot(id);
    const settlements = (after.ledger.entries || []).filter((e) => e.kind === 'settlement');
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0].amountCents, 17500);
  });

  it('2) amount 175 (exact dollars): settles full balance once', async () => {
    const id = nextId('EXACT');
    const booking = baseBooking(id);
    const store = await seed(booking);

    const result = await settle(store, booking, { amount: 175 });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.projection.settledCents, 17500);
    assert.equal(result.projection.remainingCents, 0);
    assert.equal(result.paymentStatus, 'paid_cash');

    const after = store._snapshot(id);
    const settlements = (after.ledger.entries || []).filter((e) => e.kind === 'settlement');
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0].amountCents, 17500);
  });

  it('3) amount 50 (partial): cash_amount_mismatch and no mutation', async () => {
    const id = nextId('PARTIAL');
    const booking = baseBooking(id);
    const store = await seed(booking);
    const before = financialSnapshot(store._snapshot(id));

    const result = await settle(store, booking, { amount: 50 });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'cash_amount_mismatch');
    assert.equal(result.statusCode, 400);
    assert.equal(result.expectedAmountCents, 17500);
    assert.equal(result.receivedAmountCents, 5000);

    const after = financialSnapshot(store._snapshot(id));
    assert.deepEqual(after, before);
  });

  it('4) amount greater than remaining is rejected', async () => {
    const id = nextId('OVER');
    const booking = baseBooking(id);
    const store = await seed(booking);
    const before = financialSnapshot(store._snapshot(id));

    const result = await settle(store, booking, { amount: 200 });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'cash_amount_mismatch');
    assert.equal(result.expectedAmountCents, 17500);
    assert.equal(result.receivedAmountCents, 20000);
    assert.deepEqual(financialSnapshot(store._snapshot(id)), before);
  });

  it('5) amount 0, negative, malformed, NaN-like, excessive precision rejected', async () => {
    const cases = [
      { amount: 0 },
      { amount: -10 },
      { amount: 'abc' },
      { amount: 'NaN' },
      { amount: 'Infinity' },
      { amount: true },
      { amount: {} },
      { amount: '175.001' },
      { amount: 175.001 },
      { amount: '1e2' },
    ];
    for (const body of cases) {
      const id = nextId('BAD');
      const booking = baseBooking(id);
      const store = await seed(booking);
      const before = financialSnapshot(store._snapshot(id));
      const result = await settle(store, booking, body);
      assert.equal(result.ok, false, `expected reject for ${JSON.stringify(body)}`);
      assert.equal(result.error, 'cash_amount_mismatch');
      assert.deepEqual(financialSnapshot(store._snapshot(id)), before, JSON.stringify(body));
    }
  });

  it('6) amountCents and ambiguous duplicate amount fields rejected', async () => {
    const cases = [
      { amountCents: 17500 },
      { amount: 175, amountCents: 17500 },
      { cashAmountCents: 17500 },
      { cashCents: 17500 },
      { settlementCents: 17500 },
    ];
    for (const body of cases) {
      const id = nextId('AMB');
      const booking = baseBooking(id);
      const store = await seed(booking);
      const before = financialSnapshot(store._snapshot(id));
      const result = await settle(store, booking, body);
      assert.equal(result.ok, false, JSON.stringify(body));
      assert.equal(result.error, 'cash_amount_mismatch');
      assert.deepEqual(financialSnapshot(store._snapshot(id)), before);
    }
  });

  it('7) remaining delta 4000 + amount 40 settles exactly 4000', async () => {
    const id = nextId('DELTA40');
    const booking = baseBooking(id, {
      approvedCents: 21500,
      settledCents: 17500,
      paymentStatus: 'due',
      paymentWorkflowStatus: 'awaiting_customer_payment',
      jobStatus: 'confirmed',
      serviceStatus: 'confirmed',
    });
    const store = await seed(booking);
    assert.equal(financialProjection(booking).remainingCents, 4000);

    const result = await settle(store, booking, { amount: 40 });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.projection.approvedCents, 21500);
    assert.equal(result.projection.settledCents, 21500);
    assert.equal(result.projection.remainingCents, 0);

    const after = store._snapshot(id);
    const cashEntries = (after.ledger.entries || []).filter(
      (e) => e.kind === 'settlement' && e.actor === 'admin_mark_cash_received'
    );
    assert.equal(cashEntries.length, 1);
    assert.equal(cashEntries[0].amountCents, 4000);
    assert.equal(after.cashReceivedAmount, 40);
  });

  it('8) remaining delta 4000 + omitted amount settles exactly 4000', async () => {
    const id = nextId('DELTAOMIT');
    const booking = baseBooking(id, {
      approvedCents: 21500,
      settledCents: 17500,
      paymentStatus: 'due',
      jobStatus: 'confirmed',
      serviceStatus: 'confirmed',
    });
    const store = await seed(booking);

    const result = await settle(store, booking, {});
    assert.equal(result.ok, true, result.error);
    assert.equal(result.projection.settledCents, 21500);
    assert.equal(result.projection.remainingCents, 0);
    assert.equal(store._snapshot(id).cashReceivedAmount, 40);

    const cashEntries = (store._snapshot(id).ledger.entries || []).filter(
      (e) => e.kind === 'settlement' && e.actor === 'admin_mark_cash_received'
    );
    assert.equal(cashEntries.length, 1);
    assert.equal(cashEntries[0].amountCents, 4000);
  });

  it('9) repeated full settlement creates no second credit (already_paid)', async () => {
    const id = nextId('IDEMP');
    const booking = baseBooking(id);
    const store = await seed(booking);

    const first = await settle(store, booking, {});
    assert.equal(first.ok, true, first.error);
    const mid = store._snapshot(id);
    const settledAfterFirst = mid.ledger.settledCents;
    const entryCount = mid.ledger.entries.length;

    const second = await settle(store, mid, {});
    assert.equal(second.ok, false);
    assert.equal(second.error, 'already_paid');
    assert.equal(second.statusCode, 409);

    const after = store._snapshot(id);
    assert.equal(after.ledger.settledCents, settledAfterFirst);
    assert.equal(after.ledger.entries.length, entryCount);
    assert.equal(after.bookingVersion, mid.bookingVersion);
  });

  it('10) stale bookingVersion creates no mutation', async () => {
    const id = nextId('STALE');
    const booking = baseBooking(id, { bookingVersion: 3 });
    const store = await seed(booking);
    const before = financialSnapshot(store._snapshot(id));

    const result = await settle(store, booking, {
      amount: 175,
      expectedBookingVersion: 2,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'version_conflict');
    assert.equal(result.statusCode, 409);
    assert.deepEqual(financialSnapshot(store._snapshot(id)), before);
  });

  it('11) Customer/Admin projections agree after success', async () => {
    const id = nextId('PARITY');
    const booking = baseBooking(id);
    const store = await seed(booking);

    const result = await settle(store, booking, { amount: 175 });
    assert.equal(result.ok, true, result.error);
    const after = store._snapshot(id);
    const fp = financialProjection(after);
    const admin = projectJobForAdmin(after);

    assert.equal(fp.remainingCents, 0);
    assert.equal(fp.settledCents, 17500);
    assert.equal(fp.paymentStatus, 'paid');
    assert.equal(admin.remainingCents, fp.remainingCents);
    assert.equal(admin.settledCents, fp.settledCents);
    assert.equal(result.projection.remainingCents, fp.remainingCents);
    assert.equal(result.financialProjection.remainingCents, fp.remainingCents);
  });

  it('12) Admin empty-payload button contract remains supported', () => {
    const src = read('admin-ops.html');
    assert.match(src, /mark_cash_received',\s*\{\}/);
    assert.doesNotMatch(src, /mark_cash_received',\s*\{[^}]*amount/);

    const booking = baseBooking(nextId('UI'));
    const resolved = resolveAdminCashSettlement(booking, {});
    assert.equal(resolved.ok, true);
    assert.equal(resolved.amountCents, 17500);
  });

  it('13) Technician exact-cash mismatch contract remains green', () => {
    const tech = read('netlify/functions/tech-complete-job.js');
    assert.match(tech, /cash_amount_mismatch/);
    assert.match(tech, /cashCollectedCents !== approved/);
    assert.match(tech, /cash_amount_required/);
  });
});
