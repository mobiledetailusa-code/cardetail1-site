/**
 * Package Stage 1 — Admin package routing repair.
 *
 * Both Admin actions (change_package and package-bearing update_service) must
 * share one adapter that calls applyPackageFinancialMutation → Postgres
 * createAdjustment. Neither may use persistMutation as package money authority.
 *
 * Requires Postgres; Stripe is always fake — never a live network call.
 */
require('dotenv/config');
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { prismaConfigured, getPrisma } = require('../netlify/lib/prisma');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const dbConfigured = prismaConfigured();
const RUN_ID = `TESTDB-ADMPKG-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
let idCounter = 0;
function nextId(label) {
  idCounter += 1;
  return `${RUN_ID}-${label}-${idCounter}`;
}

const FAKE_ENV = {
  STRIPE_SECRET_KEY: 'sk_test_fake000000000000000000',
  CD1_POSTGRES_PAYMENT: '1',
};

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
        if (current == null || current !== opts.onlyIfMatch) return { modified: false };
      }
      data.set(key, JSON.parse(JSON.stringify(value)));
      etags.set(key, `etag-${key}-${Date.now()}-${Math.random()}`);
      return { modified: true };
    },
    async list() {
      return { blobs: [...data.keys()].map((key) => ({ key })) };
    },
  };
}

function baseBooking(id, {
  approvedCents = 15000,
  settledCents = 0,
  packageId = 'maint',
  pkgName = 'Maintenance Detail',
  paymentWorkflowStatus = null,
  addOnIds = [],
  quoteVersion = 1,
  vehicles = null,
} = {}) {
  const entries = settledCents > 0
    ? [{
      kind: 'settlement',
      amountCents: settledCents,
      providerObjectId: `pi_seed_${id}`,
      recordedAt: new Date().toISOString(),
    }]
    : [];
  return {
    id,
    bookingVersion: 1,
    schemaVersion: 1,
    quoteVersion,
    status: settledCents > 0 ? 'Paid' : 'Confirmed',
    appointmentStatus: 'confirmed',
    jobStatus: settledCents > 0 ? 'completed_paid' : 'confirmed',
    paymentStatus: settledCents > 0 && settledCents >= approvedCents ? 'paid' : 'due',
    paymentWorkflowStatus: paymentWorkflowStatus
      || (settledCents > 0 && settledCents >= approvedCents ? 'payment_succeeded' : 'awaiting_customer_payment'),
    zipCode: '07102',
    travelFeeAmount: 0,
    approvedFinalAmount: approvedCents / 100,
    amountPaid: settledCents / 100,
    ledger: {
      currency: 'usd',
      approvedCents,
      settledCents,
      creditedCents: 0,
      entries,
    },
    vehicles: vehicles || [{
      vehicleId: 'veh_1',
      cat: 'cars',
      category: 'cars',
      tierKey: 'small',
      packageId,
      pkgId: packageId,
      pkgName,
      vehicleLabel: 'Sedan',
      addOnIds: [...addOnIds],
      addons: addOnIds.map((addonId) => ({ id: addonId })),
    }],
    changeRequests: [],
  };
}

describe('Admin package controls — Postgres-authoritative routing', () => {
  let prisma;
  let setBookingStoreOverride;
  let adminChangePackage;
  let bodyHasPackageMutation;
  let freeFormAddonBodyRejected;
  const createdBookingIds = [];
  let auditLog = [];
  const captureAudit = (entry) => { auditLog.push(entry); return entry; };

  before(() => {
    assert.equal(
      dbConfigured,
      true,
      'DATABASE_URL/DIRECT_URL required for Admin package routing tests'
    );
    prisma = getPrisma();
    ({ setBookingStoreOverride } = require('../netlify/lib/booking-repository'));
    ({
      adminChangePackage,
      bodyHasPackageMutation,
      freeFormAddonBodyRejected,
    } = require('../netlify/functions/admin-ops-jobs'));
  });

  after(async () => {
    setBookingStoreOverride(null);
    for (const id of createdBookingIds) {
      try {
        await prisma.paymentAttempt.deleteMany({ where: { bookingId: id } });
        await prisma.quote.deleteMany({ where: { bookingId: id } });
        await prisma.booking.delete({ where: { id } });
      } catch {
        // Ledger children (FK RESTRICT) keep the booking alive by design.
      }
    }
  });

  beforeEach(() => {
    setBookingStoreOverride(null);
    auditLog = [];
  });

  afterEach(() => {
    setBookingStoreOverride(null);
  });

  async function seedBlob(booking) {
    createdBookingIds.push(booking.id);
    const store = createMemoryStore({ [booking.id]: booking });
    setBookingStoreOverride(store);
    return store;
  }

  function mutate(bookingId, body) {
    const operationBody = {
      ...body,
      reason: body.reason || 'PR4 automated package operation',
      idempotencyKey: body.idempotencyKey
        || `pr4-package-${bookingId}-${Date.now()}-${Math.random().toString(16).slice(2)}`.slice(0, 96),
    };
    return adminChangePackage({
      bookingId,
      body: operationBody,
      env: FAKE_ENV,
      auditFn: captureAudit,
    });
  }

  it('1) Admin change_package unpaid upgrade uses PostgreSQL createAdjustment', async () => {
    const id = nextId('UP');
    await seedBlob(baseBooking(id));
    const result = await mutate(id, {
      packageId: 'full',
      expectedBookingVersion: 1,
      vehicleId: 'veh_1',
      // Hostile browser money — must be ignored
      price: 1,
      amount: 1,
      total: 1,
      proposedTotal: 999,
      approvedCents: 1,
      approvedFinalAmount: 0.01,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.noop, false);
    assert.equal(result.packageId, 'full');
    assert.equal(result.postgresProjection.approvedCents, 24000);
    assert.equal(result.postgresProjection.settledCents, 0);
    assert.equal(result.financialProjection.approvedCents, 24000);
    assert.equal(result.financialProjection.remainingCents, 24000);
    assert.equal(result.quoteVersion, result.priorQuoteVersion + 1);
    const pgQuotes = await prisma.quote.findMany({ where: { bookingId: id }, orderBy: { quoteVersion: 'asc' } });
    assert.ok(pgQuotes.length >= 1, 'createAdjustment must create PG quote rows');
  });

  it('2) Admin change_package unpaid downgrade uses PostgreSQL createAdjustment', async () => {
    const id = nextId('DOWN');
    await seedBlob(baseBooking(id, {
      approvedCents: 24000,
      packageId: 'full',
      pkgName: 'Premium Full Detail',
      quoteVersion: 2,
    }));
    const result = await mutate(id, {
      packageId: 'maint',
      expectedBookingVersion: 1,
      vehicleId: 'veh_1',
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.postgresProjection.approvedCents, 15000);
    assert.equal(result.financialProjection.approvedCents, 15000);
    assert.equal(result.quoteVersion, result.priorQuoteVersion + 1);
  });

  it('3) Admin update_service package change uses the same mutator', async () => {
    const src = read('netlify/functions/admin-ops-jobs.js');
    const marker = "if (action === 'update_service')";
    const idx = src.indexOf(marker);
    assert.ok(idx >= 0);
    const block = src.slice(idx, idx + 1200);
    assert.match(block, /bodyHasPackageMutation\(body\)/);
    assert.match(block, /adminChangePackage\(\{/);
    assert.match(block, /notifyOpts:\s*testOpts/);
    // Package branch returns before the legacy non-package path.
    const pkgIf = block.indexOf('if (bodyHasPackageMutation(body))');
    const legacyCall = block.indexOf('updateServicePackage(booking, body)');
    assert.ok(pkgIf >= 0 && legacyCall > pkgIf);
    const pkgBranch = block.slice(pkgIf, legacyCall);
    assert.match(pkgBranch, /adminChangePackage/);
    assert.doesNotMatch(pkgBranch, /updateServicePackage\(/);
    assert.doesNotMatch(pkgBranch, /persistMutation\(/);

    const id = nextId('USVC');
    await seedBlob(baseBooking(id));
    const result = await mutate(id, {
      packageId: 'interior',
      expectedBookingVersion: 1,
      vehicleId: 'veh_1',
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.postgresProjection.approvedCents, 19000);
    assert.ok(result.postgresProjection);
    assert.ok(result.financialProjection);
    assert.equal(result.postgresProjection.approvedCents, result.financialProjection.approvedCents);
  });

  it('4) neither Admin package path calls persistMutation as package financial authority', () => {
    const src = read('netlify/functions/admin-ops-jobs.js');
    const adapterStart = src.indexOf('async function adminChangePackage');
    const adapterEnd = src.indexOf('async function adminAddonMutation', adapterStart);
    assert.ok(adapterStart >= 0 && adapterEnd > adapterStart);
    const adapter = src.slice(adapterStart, adapterEnd);
    assert.match(adapter, /applyPackageFinancialMutation/);
    assert.doesNotMatch(adapter, /persistMutation\(/);
    assert.doesNotMatch(adapter, /ledger\.approvedCents\s*=/);
    assert.doesNotMatch(adapter, /approvedCents:\s*quoted\.quote\.approvedCents/);

    const usStart = src.indexOf("if (action === 'update_service')");
    const usEnd = src.indexOf("if (action === 'admin_tech_status')", usStart);
    const usBlock = src.slice(usStart, usEnd);
    const pkgIf = usBlock.indexOf('if (bodyHasPackageMutation(body))');
    const legacyCall = usBlock.indexOf('updateServicePackage(booking, body)');
    assert.ok(pkgIf >= 0 && legacyCall > pkgIf);
    const pkgBranch = usBlock.slice(pkgIf, legacyCall);
    assert.match(pkgBranch, /adminChangePackage/);
    assert.doesNotMatch(pkgBranch, /persistMutation\(/);
  });

  it('5) both return matching Postgres and Blob compatibility projections', async () => {
    const id = nextId('PROJ');
    await seedBlob(baseBooking(id));
    const result = await mutate(id, {
      packageId: 'full',
      expectedBookingVersion: 1,
      vehicleId: 'veh_1',
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.postgresProjection.approvedCents, result.financialProjection.approvedCents);
    assert.equal(result.postgresProjection.settledCents, result.financialProjection.settledCents);
    assert.equal(result.postgresProjection.remainingCents, result.financialProjection.remainingCents);
    assert.equal(result.postgresProjection.quoteVersion, result.quoteVersion);
  });

  it('6) browser price/amount/total/proposedTotal are ignored', async () => {
    const id = nextId('IGN');
    await seedBlob(baseBooking(id));
    const result = await mutate(id, {
      packageId: 'full',
      expectedBookingVersion: 1,
      vehicleId: 'veh_1',
      price: 0.01,
      amount: 0.01,
      total: 0.01,
      totalPrice: 0.01,
      proposedTotal: 9999,
      approvedCents: 1,
      approvedFinalAmount: 0.01,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.postgresProjection.approvedCents, 24000, 'catalog/Postgres price must win');
  });

  it('7) full settlement allows an upgrade and exposes only the delta due', async () => {
    const id = nextId('FULLPAY');
    const store = await seedBlob(baseBooking(id, {
      approvedCents: 15000,
      settledCents: 15000,
      paymentWorkflowStatus: 'payment_succeeded',
    }));
    const result = await mutate(id, {
      packageId: 'full',
      expectedBookingVersion: 1,
      vehicleId: 'veh_1',
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.postgresProjection.approvedCents, 24000);
    assert.equal(result.postgresProjection.settledCents, 15000);
    assert.equal(result.postgresProjection.remainingCents, 9000);
    const after = await store.get(id);
    assert.equal(after.bookingVersion, 2);
    assert.equal(after.vehicles[0].pkgId, 'full');
    const pgQuotes = await prisma.quote.findMany({ where: { bookingId: id } });
    assert.ok(pgQuotes.length >= 2);
  });

  it('8) partial settlement allows downgrade and keeps settled money immutable', async () => {
    const id = nextId('PARTIAL');
    const seeded = baseBooking(id, {
      approvedCents: 24000,
      settledCents: 5000,
      packageId: 'full',
      pkgName: 'Premium Full Detail',
    });
    seeded.status = 'Confirmed';
    seeded.jobStatus = 'confirmed';
    seeded.paymentStatus = 'due';
    seeded._historicalPaidClosed = false;
    const store = await seedBlob(seeded);
    const result = await mutate(id, {
      packageId: 'maint',
      expectedBookingVersion: 1,
      vehicleId: 'veh_1',
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.postgresProjection.approvedCents, 15000);
    assert.equal(result.postgresProjection.settledCents, 5000);
    assert.equal(result.postgresProjection.remainingCents, 10000);
    assert.equal(result.outstandingCreditCents, 0);
    const after = await store.get(id);
    assert.equal(after.bookingVersion, 2);
    assert.equal(after.vehicles[0].pkgId, 'maint');
    const pgQuotes = await prisma.quote.findMany({ where: { bookingId: id } });
    assert.ok(pgQuotes.length >= 2);
  });

  it('9) post-payment changes preserve settled cents and create an immutable quote', async () => {
    const id = nextId('DENY');
    const seeded = baseBooking(id, {
      approvedCents: 15000,
      settledCents: 100,
    });
    seeded.status = 'Confirmed';
    seeded.jobStatus = 'confirmed';
    seeded.paymentStatus = 'due';
    seeded._historicalPaidClosed = false;
    const store = await seedBlob(seeded);
    const result = await mutate(id, {
      packageId: 'full',
      expectedBookingVersion: 1,
      vehicleId: 'veh_1',
    });
    assert.equal(result.ok, true, result.error);
    const after = await store.get(id);
    assert.equal(after.ledger.approvedCents, 24000);
    assert.equal(after.ledger.settledCents, 100);
    assert.equal(after.bookingVersion, 2);
    assert.equal(after.vehicles[0].pkgId, 'full');
    assert.ok((await prisma.quote.findMany({ where: { bookingId: id } })).length >= 2);
    assert.equal((await prisma.paymentAttempt.findMany({ where: { bookingId: id } })).length, 0);
  });

  it('10) stale expectedBookingVersion creates no mutation', async () => {
    const id = nextId('VER');
    const store = await seedBlob(baseBooking(id));
    const result = await mutate(id, {
      packageId: 'full',
      expectedBookingVersion: 99,
      vehicleId: 'veh_1',
    });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 409);
    assert.equal(result.error, 'version_conflict');
    assert.equal(result.actualBookingVersion, 1);
    const after = await store.get(id);
    assert.equal(after.vehicles[0].pkgId, 'maint');
    assert.equal((await prisma.quote.findMany({ where: { bookingId: id } })).length, 0);
  });

  it('11) duplicate request does not create a second PG quoteVersion', async () => {
    const id = nextId('DUP');
    await seedBlob(baseBooking(id));
    const first = await mutate(id, {
      packageId: 'full',
      expectedBookingVersion: 1,
      vehicleId: 'veh_1',
    });
    assert.equal(first.ok, true, first.error);
    const q1 = first.quoteVersion;

    // Same package again at the new version → noop, no second quote bump.
    const second = await mutate(id, {
      packageId: 'full',
      expectedBookingVersion: first.bookingVersion,
      vehicleId: 'veh_1',
    });
    assert.equal(second.ok, true, second.error);
    assert.equal(second.noop, true);
    assert.equal(second.reason, 'package_unchanged');
    assert.equal(second.quoteVersion, q1);

    const quotes = await prisma.quote.findMany({ where: { bookingId: id } });
    const versions = [...new Set(quotes.map((q) => q.quoteVersion))];
    assert.equal(versions.filter((v) => v === q1).length >= 1, true);
    assert.ok(!versions.some((v) => v > q1), 'noop must not advance quoteVersion');
  });

  it('12) add-on mutation fields on update_service still return addon_mutation_required', () => {
    assert.equal(freeFormAddonBodyRejected({
      packageId: 'full',
      addOnIdsToAdd: ['ozone'],
    }), true);
    assert.equal(freeFormAddonBodyRejected({ packageId: 'full' }), false);

    const src = read('netlify/functions/admin-ops-jobs.js');
    const marker = "if (action === 'update_service')";
    const idx = src.indexOf(marker);
    const updateService = src.slice(idx, idx + 700);
    assert.match(updateService, /freeFormAddonBodyRejected/);
    assert.match(updateService, /addon_mutation_required/);
  });

  it('13) non-package update_service behavior remains unchanged', () => {
    assert.equal(bodyHasPackageMutation({ vehicleLabel: 'SUV' }), false);
    assert.equal(bodyHasPackageMutation({ packageId: 'full' }), true);
    assert.equal(bodyHasPackageMutation({ package: 'Premium Detail' }), true);
    assert.equal(bodyHasPackageMutation({ pkgId: 'maint' }), true);

    const src = read('netlify/functions/admin-ops-jobs.js');
    const marker = "if (action === 'update_service')";
    const idx = src.indexOf(marker);
    const block = src.slice(idx, idx + 1400);
    const pkgIf = block.indexOf('if (bodyHasPackageMutation(body))');
    const legacyCall = block.indexOf('updateServicePackage(booking, body)');
    assert.ok(pkgIf >= 0 && legacyCall > pkgIf);
    assert.match(block, /persistMutation\(store, bookingId, result\.booking/);
  });

  it('14) admin-ops.html sends canonical packageId (not free-form price authority)', () => {
    const html = read('admin-ops.html');
    assert.match(html, /action:\s*'change_package'/);
    assert.match(html, /packageId:\s*packageId/);
    assert.match(html, /expectedBookingVersion/);
    // update_service Save Service sends packageId from canonical select.
    assert.match(html, /jobAction\(j\.id,'update_service',\s*body\)/);
    assert.match(html, /body\.packageId|packageId:\s*packageId/);
    assert.doesNotMatch(html, /update_service',\{package:\$\('#dPackage'\)\.value/);
  });

  it('15) missing expectedBookingVersion is rejected', async () => {
    const id = nextId('NOVER');
    await seedBlob(baseBooking(id));
    const result = await mutate(id, { packageId: 'full', vehicleId: 'veh_1' });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 400);
    assert.equal(result.error, 'expected_booking_version_required');
  });

  it('16) free-form package display name without packageId is rejected', async () => {
    const id = nextId('LABEL');
    await seedBlob(baseBooking(id));
    assert.equal(bodyHasPackageMutation({ package: 'Premium Full Detail' }), true);
    const result = await mutate(id, {
      package: 'Premium Full Detail',
      expectedBookingVersion: 1,
      vehicleId: 'veh_1',
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'package_id_required');
  });
});
