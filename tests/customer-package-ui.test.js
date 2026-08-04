/**
 * Package Stage 2 — Customer package controls aligned with Stage 1 authority.
 *
 * Proves canonical catalog sourcing, vehicle targeting contracts, settlement
 * lock, version honor, and UI wiring. Does not mutate frozen money authority.
 */
require('dotenv/config');
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { prismaConfigured, getPrisma } = require('../netlify/lib/prisma');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const { PRICING } = require('../netlify/lib/booking-price-catalog');
const { CAR_PACKAGES } = require('../netlify/lib/customer-catalog');
const {
  serializeCanonicalPackageCatalogForBooking,
  packageDescription,
} = require('../netlify/lib/canonical-package-catalog');
const {
  packageOptionsForVehicle,
  applyPackageFinancialMutation,
} = require('../netlify/lib/package-financial-mutation');
const { computeVehicleSubtotal } = require('../netlify/lib/booking-price-catalog');

const dbConfigured = prismaConfigured();
const RUN_ID = `TESTDB-CUSTPKG-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
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
  approvedCents = 17500,
  settledCents = 0,
  packageId = 'maint',
  pkgName = 'Maintenance Detail',
  addOnIds = [],
  quoteVersion = 1,
  vehicles = null,
  bookingVersion = 1,
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
    bookingVersion,
    schemaVersion: 1,
    quoteVersion,
    status: settledCents > 0 && settledCents >= approvedCents ? 'Paid' : 'Confirmed',
    appointmentStatus: 'confirmed',
    jobStatus: settledCents > 0 && settledCents >= approvedCents ? 'completed_paid' : 'confirmed',
    paymentStatus: settledCents > 0 && settledCents >= approvedCents ? 'paid' : 'due',
    paymentWorkflowStatus: settledCents > 0 && settledCents >= approvedCents
      ? 'payment_succeeded'
      : 'awaiting_customer_payment',
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
    quote: { quoteVersion, approvedCents },
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
      addons: addOnIds.map((addonId) => ({ id: addonId, name: addonId })),
    }],
    service: {
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
        addons: addOnIds.map((addonId) => ({ id: addonId, name: addonId })),
      }],
    },
    changeRequests: [],
  };
}

describe('Customer package catalog — booking-price-catalog source', () => {
  it('1) reports source booking-price-catalog', () => {
    const catalog = serializeCanonicalPackageCatalogForBooking(baseBooking('CAT-SRC'));
    assert.equal(catalog.source, 'booking-price-catalog');
    assert.ok(catalog.vehicles.length >= 1);
    assert.ok(catalog.packageCatalogByVehicle.veh_1);
  });

  it('2) canonical labels and priceCents match server catalog probes', () => {
    const booking = baseBooking('CAT-MATCH');
    const catalog = serializeCanonicalPackageCatalogForBooking(booking);
    const vehicle = catalog.vehicles[0];
    assert.equal(vehicle.category, 'cars');
    assert.equal(vehicle.tierKey, 'small');

    const full = vehicle.options.find((o) => o.packageId === 'full');
    assert.ok(full, 'full package must be present');
    assert.equal(full.priceCents, 28500);
    assert.equal(full.label, 'Premium Full Detail');
    assert.ok(full.description);

    const direct = packageOptionsForVehicle(booking.service.vehicles[0], booking);
    const directFull = direct.options.find((o) => o.id === 'full');
    assert.equal(full.priceCents, directFull.priceCents);
    assert.equal(full.label, directFull.name);
  });

  it('3) old flat customer-catalog basePrice is not the live package quote', () => {
    const catalog = serializeCanonicalPackageCatalogForBooking(baseBooking('CAT-FLAT'));
    const full = catalog.vehicles[0].options.find((o) => o.packageId === 'full');
    const flat = CAR_PACKAGES.find((p) => p.id === 'full');
    assert.ok(flat, 'fixture: customer-catalog still has flat full');
    assert.equal(flat.basePrice, 240);
    assert.equal(full.priceCents, 28500);
    assert.notEqual(full.priceCents, Math.round(flat.basePrice * 100));

    // suv3 tier would be $200 — also not the flat $240
    const suvBooking = baseBooking('CAT-SUV3', {
      vehicles: [{
        vehicleId: 'veh_suv',
        cat: 'cars',
        category: 'cars',
        tierKey: 'suv3',
        packageId: 'maint',
        pkgId: 'maint',
        pkgName: 'Maintenance Detail',
        vehicleLabel: 'SUV',
        addOnIds: [],
        addons: [],
      }],
    });
    const suvCat = serializeCanonicalPackageCatalogForBooking(suvBooking);
    const suvFull = suvCat.vehicles[0].options.find((o) => o.packageId === 'full');
    assert.equal(suvFull.priceCents, 31500);
    assert.notEqual(suvFull.priceCents, 30000);
  });

  it('multi-vehicle exposes packageCatalogByVehicle keyed by vehicleId', () => {
    const booking = baseBooking('CAT-MULTI', {
      vehicles: [
        {
          vehicleId: 'veh_a',
          cat: 'cars',
          category: 'cars',
          tierKey: 'small',
          packageId: 'maint',
          pkgId: 'maint',
          vehicleLabel: 'Sedan',
          addOnIds: [],
          addons: [],
        },
        {
          vehicleId: 'veh_b',
          cat: 'cars',
          category: 'cars',
          tierKey: 'truck',
          packageId: 'interior',
          pkgId: 'interior',
          vehicleLabel: 'Truck',
          addOnIds: [],
          addons: [],
        },
      ],
    });
    const catalog = serializeCanonicalPackageCatalogForBooking(booking);
    assert.equal(catalog.vehicles.length, 2);
    assert.ok(catalog.packageCatalogByVehicle.veh_a);
    assert.ok(catalog.packageCatalogByVehicle.veh_b);
    const smallFull = catalog.packageCatalogByVehicle.veh_a.options.find((o) => o.packageId === 'full');
    const truckFull = catalog.packageCatalogByVehicle.veh_b.options.find((o) => o.packageId === 'full');
    assert.equal(smallFull.priceCents, 28500);
    assert.equal(truckFull.priceCents, 32500);
    assert.notEqual(smallFull.priceCents, truckFull.priceCents);
  });

  it('boat/RV length-priced options remain functional', () => {
    const boat = baseBooking('CAT-BOAT', {
      vehicles: [{
        vehicleId: 'veh_boat',
        cat: 'boats',
        category: 'boats',
        packageId: 'maint',
        pkgId: 'maint',
        lengthFt: 22,
        vehicleLabel: 'Boat',
        addOnIds: [],
        addons: [],
      }],
    });
    const catalog = serializeCanonicalPackageCatalogForBooking(boat);
    const row = catalog.vehicles[0];
    assert.equal(row.category, 'boats');
    assert.equal(row.lengthPriced, true);
    assert.equal(row.lengthFt, 22);
    assert.ok(row.options.length >= 1);
    assert.ok(row.options.every((o) => o.priceCents > 0));
    const priced = computeVehicleSubtotal(boat.service.vehicles[0], boat.zipCode, boat);
    assert.equal(priced.ok, true);
  });
});

describe('Customer portal data + submit wiring', () => {
  it('customer-portal-data wires canonical package serializer', () => {
    const src = read('netlify/functions/customer-portal-data.js');
    assert.match(src, /serializeCanonicalPackageCatalogForBooking/);
    assert.match(src, /packageCatalog/);
    assert.match(src, /packageCatalogByVehicle/);
    assert.doesNotMatch(src, /admin-ops-jobs/);
  });

  it('submit-customer-action honors client expectedBookingVersion for packages', () => {
    const src = read('netlify/functions/submit-customer-action.js');
    const pkgStart = src.indexOf("action === 'package_change_request'");
    assert.ok(pkgStart >= 0);
    const pkgBlock = src.slice(pkgStart, pkgStart + 12000);
    assert.match(pkgBlock, /expectedBookingVersion is required/);
    assert.match(pkgBlock, /Math\.round\(Number\(p\.expectedBookingVersion\)\)/);
    assert.match(pkgBlock, /expectedBookingVersion,/);
    // Must not silently substitute the loaded booking version for package CAS.
    const beforeSubmit = pkgBlock.slice(0, pkgBlock.indexOf('submitChangeRequestCommand'));
    assert.doesNotMatch(beforeSubmit, /expectedBookingVersion:\s*booking\.bookingVersion/);
    assert.match(pkgBlock, /settled_package_change_denied/);
    assert.match(pkgBlock, /vehicle_target_required/);
    assert.match(pkgBlock, /package_unchanged/);
    assert.match(pkgBlock, /invalid_pricing/);
    assert.match(pkgBlock, /unknown_package_id/);
  });

  it('submit package path does not use CAR_PACKAGES basePrice as money authority', () => {
    const src = read('netlify/functions/submit-customer-action.js');
    const pkgStart = src.indexOf("action === 'package_change_request'");
    const pkgBlock = src.slice(pkgStart, pkgStart + 6500);
    assert.doesNotMatch(pkgBlock, /CAR_PACKAGES/);
    assert.match(pkgBlock, /validatePackageIdForVehicle|packageDisplayName/);
  });
});

describe('Customer My Garage package UI wiring', () => {
  const js = read('assets/my-garage.js');

  it('4–8) modal uses packageCatalog, vehicleId, version; strips money fields', () => {
    assert.match(js, /getPackageCatalog|state\.packageCatalog/);
    assert.match(js, /booking-price-catalog/);
    assert.match(js, /packageModalVehicleId|mf-package-vehicle/);
    assert.match(js, /vehicleId:\s*selected\.vehicleId/);
    assert.match(js, /newPackId/);
    assert.match(js, /expectedBookingVersion:\s*state\.booking\.bookingVersion/);
    assert.match(js, /delete body\.price/);
    assert.match(js, /delete body\.priceCents/);
    assert.match(js, /delete body\.proposedTotal/);
    assert.match(js, /delete body\.approvedCents/);
    assert.match(js, /delete body\.amount/);
    // Must not quote live package prices from customer-catalog basePrice.
    const pkgModalStart = js.indexOf('function renderPackageModal');
    const pkgModal = js.slice(pkgModalStart, pkgModalStart + 5500);
    assert.doesNotMatch(pkgModal, /basePrice/);
    assert.doesNotMatch(pkgModal, /estimateLengthPrice/);
    assert.match(pkgModal, /priceCents/);
    assert.match(js, /Current add-ons stay on the booking|compatible selected add-ons/i);
  });

  it('11) settledCents > 0 disables package changes in Customer UI', () => {
    assert.match(js, /packageChangeUnavailableReason/);
    assert.match(js, /settledCentsFromPayment\(.*\) > 0/);
    assert.match(js, /Package changes are unavailable after any payment has been recorded/);
    const syncStart = js.indexOf('function syncMoneyActionButtons');
    const syncFn = js.slice(syncStart, syncStart + 1600);
    assert.match(syncFn, /packageSettled/);
    assert.match(syncFn, /package_change_request/);
  });

  it('15–17) pending lock, package_unchanged, package-specific errors', () => {
    assert.match(js, /mutationPending/);
    assert.match(js, /setModalSubmitPending/);
    assert.match(js, /mapPackageErrorMessage/);
    assert.match(js, /settled_package_change_denied/);
    assert.match(js, /vehicle_target_required/);
    assert.match(js, /unknown_package_id/);
    assert.match(js, /invalid_pricing/);
    assert.match(js, /package_unchanged/);
    assert.match(js, /version_conflict/);
    assert.doesNotMatch(
      js.slice(js.indexOf('function mapPackageErrorMessage'), js.indexOf('function mapPackageErrorMessage') + 1800),
      /add-on is already on your booking/
    );
  });

  it('minimum accessibility: focus, Escape, restore opener', () => {
    assert.match(js, /modalOpenerEl/);
    assert.match(js, /Escape/);
    assert.match(js, /opener\.focus/);
    assert.match(js, /role=\"radiogroup\"/);
    assert.match(js, /aria-label=\"Packages\"/);
  });

  it('does not claim every package request needs admin approval', () => {
    const pkgModalStart = js.indexOf('function renderPackageModal');
    const pkgModal = js.slice(pkgModalStart, pkgModalStart + 5500);
    assert.doesNotMatch(pkgModal, /admin approval applies/i);
  });
});

describe('Customer package Stage 1 authority still enforced (settlement + version)', () => {
  let setBookingStoreOverride;
  let prisma;
  const createdBookingIds = [];

  before(() => {
    if (!dbConfigured) return;
    prisma = getPrisma();
    ({ setBookingStoreOverride } = require('../netlify/lib/booking-repository'));
  });

  after(async () => {
    if (!dbConfigured) return;
    setBookingStoreOverride(null);
    for (const id of createdBookingIds) {
      try {
        await prisma.paymentAttempt.deleteMany({ where: { bookingId: id } });
        await prisma.quote.deleteMany({ where: { bookingId: id } });
        await prisma.booking.delete({ where: { id } });
      } catch {
        // Ledger children may retain the booking.
      }
    }
  });

  beforeEach(() => {
    if (dbConfigured) setBookingStoreOverride(null);
  });

  afterEach(() => {
    if (dbConfigured) setBookingStoreOverride(null);
  });

  async function seedBlob(booking) {
    createdBookingIds.push(booking.id);
    const store = createMemoryStore({ [booking.id]: booking });
    setBookingStoreOverride(store);
    return store;
  }

  it('9–10) stale expectedBookingVersion returns 409 and creates no mutation', async (t) => {
    if (!dbConfigured) {
      t.skip('DATABASE_URL required');
      return;
    }
    const id = nextId('VER');
    const booking = baseBooking(id, { bookingVersion: 3 });
    await seedBlob(booking);
    const beforePkg = booking.service.vehicles[0].packageId;
    const result = await applyPackageFinancialMutation({
      bookingId: id,
      expectedBookingVersion: 1,
      packageId: 'full',
      target: { vehicleId: 'veh_1' },
      env: FAKE_ENV,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'version_conflict');
    assert.equal(result.statusCode, 409);
    const { getBookingRecord } = require('../netlify/lib/booking-repository');
    const after = await getBookingRecord(id);
    assert.equal(after.booking.bookingVersion, 3);
    assert.equal(after.booking.service.vehicles[0].packageId, beforePkg);
  });

  it('12) server bypass after settlement remains denied', async (t) => {
    if (!dbConfigured) {
      t.skip('DATABASE_URL required');
      return;
    }
    const id = nextId('SET');
    // Partial settlement still denies (settledCents > 0).
    await seedBlob(baseBooking(id, {
      approvedCents: 28500,
      settledCents: 10000,
      packageId: 'full',
      pkgName: 'Premium Full Detail',
    }));
    const result = await applyPackageFinancialMutation({
      bookingId: id,
      expectedBookingVersion: 1,
      packageId: 'maint',
      target: { vehicleId: 'veh_1' },
      env: FAKE_ENV,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'settled_package_change_denied');
    assert.equal(result.statusCode, 409);
  });

  it('13–14) compatible add-ons preserved; invalid path does not silently delete', async (t) => {
    if (!dbConfigured) {
      t.skip('DATABASE_URL required');
      return;
    }
    const id = nextId('ADDON');
    await seedBlob(baseBooking(id, {
      addOnIds: ['ozone'],
      approvedCents: 21500,
    }));
    const result = await applyPackageFinancialMutation({
      bookingId: id,
      expectedBookingVersion: 1,
      packageId: 'full',
      target: { vehicleId: 'veh_1' },
      env: FAKE_ENV,
    });
    assert.equal(result.ok, true, result.error);
    const ids = (result.booking.service.vehicles[0].addOnIds || [])
      .map((x) => String(x));
    assert.ok(ids.includes('ozone'), 'compatible add-on must remain');

    // Unknown package must fail without wiping add-ons.
    const bad = await applyPackageFinancialMutation({
      bookingId: id,
      expectedBookingVersion: result.booking.bookingVersion,
      packageId: 'not_a_real_package',
      target: { vehicleId: 'veh_1' },
      env: FAKE_ENV,
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'unknown_package_id');
    const { getBookingRecord } = require('../netlify/lib/booking-repository');
    const after = await getBookingRecord(id);
    assert.ok((after.booking.service.vehicles[0].addOnIds || []).includes('ozone'));
  });

  it('16) package_unchanged is a safe noop', async (t) => {
    if (!dbConfigured) {
      t.skip('DATABASE_URL required');
      return;
    }
    const id = nextId('NOOP');
    await seedBlob(baseBooking(id, { packageId: 'maint' }));
    const result = await applyPackageFinancialMutation({
      bookingId: id,
      expectedBookingVersion: 1,
      packageId: 'maint',
      target: { vehicleId: 'veh_1' },
      env: FAKE_ENV,
    });
    assert.equal(result.ok, true);
    assert.equal(result.noop, true);
    assert.equal(result.reason, 'package_unchanged');
  });
});

describe('display metadata helper', () => {
  it('packageDescription returns display-only copy without inventing prices', () => {
    assert.ok(packageDescription('cars', 'full').length > 10);
    assert.equal(packageDescription('cars', 'nope'), '');
  });

  it('canonical cars price table still has tier-aware full (not flat 240)', () => {
    assert.equal(PRICING.cars.tiers.small.full, 230);
    assert.equal(PRICING.cars.tiers.suv3.full, 200);
  });
});
