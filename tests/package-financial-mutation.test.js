/**
 * Package Stage 1 — authoritative pre-settlement package mutations.
 * Requires Postgres (PaymentAuthorityService.createAdjustment).
 * Stripe is always fake — never a live network call.
 */
require('dotenv/config');
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { prismaConfigured, getPrisma } = require('../netlify/lib/prisma');

const dbConfigured = prismaConfigured();
const RUN_ID = `TESTDB-PKG-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
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
        if (!current || current !== opts.onlyIfMatch) return { modified: false };
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

// Small car (tierKey 'small', zip 07102 — non-rich): maint 15000, interior 19000,
// full 24000, refresh 32000, premium 38500. Add-on ozone: 4000.
function baseBooking(id, {
  approvedCents = 15000,
  settledCents = 0,
  packageId = 'maint',
  pkgName = 'Maintenance Detail',
  paymentWorkflowStatus = null,
  addOnIds = [],
  quoteVersion = 1,
  vehicles = null,
  paymentAttempts = [],
  payLink = '',
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
    payLink,
    paymentAttempts,
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
      addOnIds: [...addOnIds],
      addons: addOnIds.map((addonId) => ({ id: addonId })),
    }],
    changeRequests: [],
  };
}

describe('Package Stage 1 financial mutations (pre-settlement)', () => {
  let prisma;
  let setBookingStoreOverride;
  const createdBookingIds = [];

  before(() => {
    // Hard fail — never soft-skip Stage 1 financial invariants when DB is missing.
    assert.equal(
      dbConfigured,
      true,
      'DATABASE_URL/DIRECT_URL required for Package Stage 1 financial mutations'
    );
    prisma = getPrisma();
    ({ setBookingStoreOverride } = require('../netlify/lib/booking-repository'));
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

  it('1) before-pay upgrade: maint 15000/0/15000 → full 24000/0/24000', async () => {
    const { applyPackageFinancialMutation } = require('../netlify/lib/package-financial-mutation');
    const { financialProjection } = require('../netlify/lib/payment-service');
    const id = nextId('BP-UP');
    await seedBlob(baseBooking(id));

    const result = await applyPackageFinancialMutation({
      bookingId: id,
      expectedBookingVersion: 1,
      target: { vehicleId: 'veh_1' },
      packageId: 'full',
      env: FAKE_ENV,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.noop, false);
    assert.equal(result.priorPackageId, 'maint');
    assert.equal(result.packageId, 'full');
    assert.equal(result.packageName, 'Premium Full Detail');
    assert.equal(result.postgresProjection.approvedCents, 24000);
    assert.equal(result.postgresProjection.settledCents, 0);
    assert.equal(result.postgresProjection.remainingCents, 24000);
    assert.equal(result.financialProjection.approvedCents, 24000);
    assert.equal(result.financialProjection.remainingCents, 24000);
    assert.equal(financialProjection(result.booking).remainingCents, 24000);
    assert.equal(
      result.quoteVersion,
      result.priorQuoteVersion + 1,
      'createAdjustment must advance quoteVersion by exactly 1'
    );
    assert.equal(result.adjustment.ok, true);
    // Canonical service reflects the new package on the target vehicle.
    const veh = result.booking.service.vehicles.find((v) => v.vehicleId === 'veh_1');
    assert.equal(veh.pkgId, 'full');
    assert.equal(veh.pkgName, 'Premium Full Detail');
  });

  it('2) before-pay downgrade: full 24000/0/24000 → maint 15000/0/15000', async () => {
    const { applyPackageFinancialMutation } = require('../netlify/lib/package-financial-mutation');
    const id = nextId('BP-DOWN');
    await seedBlob(baseBooking(id, {
      approvedCents: 24000,
      packageId: 'full',
      pkgName: 'Premium Full Detail',
      quoteVersion: 2,
    }));

    const result = await applyPackageFinancialMutation({
      bookingId: id,
      expectedBookingVersion: 1,
      target: { vehicleId: 'veh_1' },
      packageId: 'maint',
      env: FAKE_ENV,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.postgresProjection.approvedCents, 15000);
    assert.equal(result.postgresProjection.settledCents, 0);
    assert.equal(result.postgresProjection.remainingCents, 15000);
    assert.equal(result.financialProjection.remainingCents, 15000);
  });

  it('3) add-ons are preserved across a package change (maint+ozone → full+ozone)', async () => {
    const { applyPackageFinancialMutation } = require('../netlify/lib/package-financial-mutation');
    const id = nextId('KEEP-ADDON');
    await seedBlob(baseBooking(id, {
      approvedCents: 19000,
      addOnIds: ['ozone'],
    }));

    const result = await applyPackageFinancialMutation({
      bookingId: id,
      expectedBookingVersion: 1,
      target: { vehicleId: 'veh_1' },
      packageId: 'full',
      env: FAKE_ENV,
    });
    assert.equal(result.ok, true, result.error);
    // 24000 package + 4000 ozone
    assert.equal(result.postgresProjection.approvedCents, 28000);
    const veh = result.booking.service.vehicles.find((v) => v.vehicleId === 'veh_1');
    assert.deepEqual(veh.addOnIds, ['ozone'], 'add-on selection must survive the package change');
    const kinds = result.booking.quote.lineItems.map((li) => `${li.kind}:${li.packageId || li.addonId}`);
    assert.ok(kinds.includes('package:full'), `missing package line item in ${kinds}`);
    assert.ok(kinds.includes('addon:ozone'), `missing addon line item in ${kinds}`);
  });

  it('4) a fully settled upgrade creates only the unpaid delta', async () => {
    const { applyPackageFinancialMutation } = require('../netlify/lib/package-financial-mutation');
    const id = nextId('SETTLED');
    const store = await seedBlob(baseBooking(id, {
      approvedCents: 15000,
      settledCents: 15000,
      paymentWorkflowStatus: 'payment_succeeded',
    }));

    const result = await applyPackageFinancialMutation({
      bookingId: id,
      expectedBookingVersion: 1,
      target: { vehicleId: 'veh_1' },
      packageId: 'full',
      env: FAKE_ENV,
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

  it('5) a partial-settlement downgrade preserves settlement and reduces the due amount', async () => {
    const { applyPackageFinancialMutation } = require('../netlify/lib/package-financial-mutation');
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
    await seedBlob(seeded);

    const result = await applyPackageFinancialMutation({
      bookingId: id,
      expectedBookingVersion: 1,
      target: { vehicleId: 'veh_1' },
      packageId: 'maint',
      env: FAKE_ENV,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.postgresProjection.approvedCents, 15000);
    assert.equal(result.postgresProjection.settledCents, 5000);
    assert.equal(result.postgresProjection.remainingCents, 10000);
    assert.equal(result.outstandingCreditCents, 0);
  });

  it('6) expectedBookingVersion conflict creates no mutation', async () => {
    const { applyPackageFinancialMutation } = require('../netlify/lib/package-financial-mutation');
    const id = nextId('VER');
    const store = await seedBlob(baseBooking(id));

    const result = await applyPackageFinancialMutation({
      bookingId: id,
      expectedBookingVersion: 7,
      target: { vehicleId: 'veh_1' },
      packageId: 'full',
      env: FAKE_ENV,
    });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 409);
    assert.equal(result.error, 'version_conflict');
    assert.equal(result.actualBookingVersion, 1);
    const after = await store.get(id);
    assert.equal(after.vehicles[0].pkgId, 'maint');
  });

  it('7) unknown package id is rejected with the valid catalog ids', async () => {
    const { applyPackageFinancialMutation } = require('../netlify/lib/package-financial-mutation');
    const id = nextId('UNKNOWN');
    const store = await seedBlob(baseBooking(id));

    const result = await applyPackageFinancialMutation({
      bookingId: id,
      expectedBookingVersion: 1,
      target: { vehicleId: 'veh_1' },
      packageId: 'mega_deluxe',
      env: FAKE_ENV,
    });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 400);
    assert.equal(result.error, 'unknown_package_id');
    assert.deepEqual(
      [...result.validPackageIds].sort(),
      ['full', 'interior', 'maint', 'premium', 'refresh'],
      'cars catalog ids expected'
    );
    const after = await store.get(id);
    assert.equal(after.bookingVersion, 1);
  });

  it('8) same package is a noop — no quote bump, no PG adjustment', async () => {
    const { applyPackageFinancialMutation } = require('../netlify/lib/package-financial-mutation');
    const id = nextId('NOOP');
    await seedBlob(baseBooking(id));

    const result = await applyPackageFinancialMutation({
      bookingId: id,
      expectedBookingVersion: 1,
      target: { vehicleId: 'veh_1' },
      packageId: 'maint',
      env: FAKE_ENV,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.noop, true);
    assert.equal(result.reason, 'package_unchanged');
    assert.equal(result.quoteVersion, 1, 'noop must not advance quoteVersion');
    const pgQuotes = await prisma.quote.findMany({ where: { bookingId: id } });
    assert.equal(pgQuotes.length, 0, 'noop must not create PG rows');
  });

  it('9) empty package id is rejected', async () => {
    const { applyPackageFinancialMutation } = require('../netlify/lib/package-financial-mutation');
    const result = await applyPackageFinancialMutation({
      bookingId: 'irrelevant',
      expectedBookingVersion: 1,
      packageId: '',
      env: FAKE_ENV,
    });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 400);
    assert.equal(result.error, 'package_id_required');
  });

  it('10) multi-vehicle booking requires an explicit vehicleId', async () => {
    const { applyPackageFinancialMutation } = require('../netlify/lib/package-financial-mutation');
    const id = nextId('MULTI');
    await seedBlob(baseBooking(id, {
      vehicles: [
        {
          vehicleId: 'veh_1', cat: 'cars', category: 'cars', tierKey: 'small',
          packageId: 'maint', pkgId: 'maint', pkgName: 'Maintenance Detail', addOnIds: [], addons: [],
        },
        {
          vehicleId: 'veh_2', cat: 'cars', category: 'cars', tierKey: 'truck',
          packageId: 'full', pkgId: 'full', pkgName: 'Premium Full Detail', addOnIds: [], addons: [],
        },
      ],
    }));

    const result = await applyPackageFinancialMutation({
      bookingId: id,
      expectedBookingVersion: 1,
      packageId: 'full',
      env: FAKE_ENV,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'vehicle_target_required');
  });

  it('11) open payment attempt is superseded and payLink cleared', async () => {
    const { applyPackageFinancialMutation } = require('../netlify/lib/package-financial-mutation');
    const id = nextId('ATTEMPT');
    await seedBlob(baseBooking(id, {
      payLink: 'https://checkout.stripe.example/old',
      paymentAttempts: [{
        attemptId: 'pa_1',
        status: 'open',
        amountCents: 15000,
        quoteVersion: 1,
        providerObjectId: `cs_${id}`,
      }],
    }));

    const result = await applyPackageFinancialMutation({
      bookingId: id,
      expectedBookingVersion: 1,
      target: { vehicleId: 'veh_1' },
      packageId: 'interior',
      env: FAKE_ENV,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.postgresProjection.approvedCents, 19000);
    assert.equal(result.booking.payLink, '', 'stale pay link must be invalidated');
    const open = (result.booking.paymentAttempts || []).filter((a) => a.status === 'open');
    assert.equal(open.length, 0, 'no open attempt may survive a package reprice');
  });

  it('12) operator-supplied price/name/total fields are ignored — catalog price wins', async () => {
    const { applyPackageFinancialMutation } = require('../netlify/lib/package-financial-mutation');
    const id = nextId('NOPRICE');
    await seedBlob(baseBooking(id));

    const result = await applyPackageFinancialMutation({
      bookingId: id,
      expectedBookingVersion: 1,
      target: { vehicleId: 'veh_1' },
      packageId: 'full',
      // Hostile extras a caller might smuggle — the signature has no price
      // inputs, but assert catalog authority end-to-end anyway.
      packageName: 'Free Package',
      price: 1,
      priceCents: 1,
      totalPrice: 0.01,
      env: FAKE_ENV,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.postgresProjection.approvedCents, 24000, 'catalog price must win');
    assert.equal(result.packageName, 'Premium Full Detail', 'display name resolves server-side');
  });

  it('13) postgres disabled → 503, no blob mutation', async () => {
    const { applyPackageFinancialMutation } = require('../netlify/lib/package-financial-mutation');
    const id = nextId('NOPG');
    const store = await seedBlob(baseBooking(id));

    const result = await applyPackageFinancialMutation({
      bookingId: id,
      expectedBookingVersion: 1,
      target: { vehicleId: 'veh_1' },
      packageId: 'full',
      env: { STRIPE_SECRET_KEY: 'sk_test_fake000000000000000000', CD1_POSTGRES_PAYMENT: '0' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 503);
    assert.equal(result.error, 'postgres_payment_disabled');
    const after = await store.get(id);
    assert.equal(after.bookingVersion, 1);
    assert.equal(after.vehicles[0].pkgId, 'maint');
  });

  it('14) length-priced RV package change uses per-foot catalog pricing', async () => {
    const { applyPackageFinancialMutation } = require('../netlify/lib/package-financial-mutation');
    const id = nextId('RV');
    // Travel trailer 24 ft: maint = 130 + 9*24 = 346 → 34600;
    // full_basic = 255 + 21*24 = 759 → 75900 (multiplier 1 for travel).
    await seedBlob(baseBooking(id, {
      approvedCents: 34600,
      vehicles: [{
        vehicleId: 'veh_rv', cat: 'rvs', category: 'rvs', rvType: 'travel',
        lengthFt: 24, packageId: 'maint', pkgId: 'maint', pkgName: 'Maintenance Wash',
        addOnIds: [], addons: [],
      }],
    }));

    const result = await applyPackageFinancialMutation({
      bookingId: id,
      expectedBookingVersion: 1,
      target: { vehicleId: 'veh_rv' },
      packageId: 'full_basic',
      env: FAKE_ENV,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.postgresProjection.approvedCents, 75900);
    assert.equal(result.packageName, 'Full RV Detail');
  });
});
