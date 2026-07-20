/**
 * Stage 3 — Admin add-on controls.
 * Admin mutations must ride the exact Stage 1 authoritative path:
 * booking-price-catalog → applyAddonFinancialMutation → Postgres
 * createAdjustment → compatibility projection → shared FinancialProjection.
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
const RUN_ID = `TESTDB-ADMADDON-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
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

function baseBooking(id, {
  approvedCents = 17500,
  settledCents = 0,
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
  const defaultVehicles = [{
    vehicleId: 'veh_1',
    cat: 'cars',
    category: 'cars',
    tierKey: 'small',
    packageId: 'maint',
    pkgId: 'maint',
    pkgName: 'Maintenance Detail',
    vehicleLabel: 'Sedan',
    addOnIds: [...addOnIds],
    addons: addOnIds.map((addonId) => ({ id: addonId })),
  }];
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
    vehicles: vehicles || defaultVehicles,
    changeRequests: [],
  };
}

describe('Stage 3 Admin add-on controls (authoritative path)', () => {
  let prisma;
  let setBookingStoreOverride;
  let adminAddonMutation;
  let adminAddonCatalogForBooking;
  let freeFormAddonBodyRejected;
  const createdBookingIds = [];
  let auditLog = [];
  const captureAudit = (entry) => { auditLog.push(entry); return entry; };

  before(() => {
    // Hard fail — never soft-skip Stage 3 financial invariants when DB is missing.
    assert.equal(
      dbConfigured,
      true,
      'DATABASE_URL/DIRECT_URL required for Stage 3 admin add-on controls'
    );
    prisma = getPrisma();
    ({ setBookingStoreOverride } = require('../netlify/lib/booking-repository'));
    ({
      adminAddonMutation,
      adminAddonCatalogForBooking,
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
    return adminAddonMutation({
      bookingId,
      body,
      env: FAKE_ENV,
      auditFn: captureAudit,
    });
  }

  it('1) Admin add before payment: 17500/0/17500 → 21500/0/21500', async () => {
    const id = nextId('BP-ADD');
    await seedBlob(baseBooking(id));

    const result = await mutate(id, {
      addOnIdsToAdd: ['ozone'],
      expectedBookingVersion: 1,
      vehicleId: 'veh_1',
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.noop, false);
    assert.equal(result.projection.approvedCents, 21500);
    assert.equal(result.projection.settledCents, 0);
    assert.equal(result.projection.remainingCents, 21500);
    assert.equal(result.financialProjection.approvedCents, 21500);
    assert.equal(result.financialProjection.remainingCents, 21500);
    assert.equal(result.quoteVersion, result.priorQuoteVersion + 1);
    assert.deepEqual(result.selectedAddonIds, ['ozone']);
  });

  it('2) Admin remove before payment: 21500/0/21500 → 17500/0/17500', async () => {
    const id = nextId('BP-RM');
    await seedBlob(baseBooking(id, {
      approvedCents: 21500,
      addOnIds: ['ozone'],
      quoteVersion: 2,
    }));

    const result = await mutate(id, {
      addOnIdsToRemove: ['ozone'],
      expectedBookingVersion: 1,
      vehicleId: 'veh_1',
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.noop, false);
    assert.equal(result.projection.approvedCents, 17500);
    assert.equal(result.projection.settledCents, 0);
    assert.equal(result.projection.remainingCents, 17500);
    assert.equal(result.financialProjection.remainingCents, 17500);
    assert.deepEqual(result.selectedAddonIds, []);
  });

  it('3) Admin add after payment: 17500/17500/0 → 21500/17500/4000 (unpaid delta only)', async () => {
    const { financialProjection } = require('../netlify/lib/payment-service');
    const id = nextId('AP-ADD');
    await seedBlob(baseBooking(id, {
      approvedCents: 17500,
      settledCents: 17500,
      paymentWorkflowStatus: 'payment_succeeded',
    }));

    const result = await mutate(id, {
      addOnIdsToAdd: ['ozone'],
      expectedBookingVersion: 1,
      vehicleId: 'veh_1',
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.projection.approvedCents, 21500);
    assert.equal(result.projection.settledCents, 17500);
    assert.equal(result.projection.remainingCents, 4000);
    assert.equal(result.financialProjection.approvedCents, 21500);
    assert.equal(result.financialProjection.settledCents, 17500);
    assert.equal(result.financialProjection.remainingCents, 4000);
    assert.equal(result.financialProjection.invoicePaid, false);

    // No new $175 obligation — only the 4000-cent delta remains payable.
    const { getBookingRecord } = require('../netlify/lib/booking-repository');
    const refreshed = await getBookingRecord(id);
    assert.equal(financialProjection(refreshed.booking).remainingCents, 4000);
  });

  it('4) Customer immediately receives the same projection (PG ↔ Blob ↔ Admin parity)', async () => {
    const authority = require('../netlify/lib/db/payment-authority-service');
    const { financialProjection } = require('../netlify/lib/payment-service');
    const { getBookingRecord } = require('../netlify/lib/booking-repository');
    const id = nextId('PARITY');
    await seedBlob(baseBooking(id, {
      approvedCents: 17500,
      settledCents: 17500,
      paymentWorkflowStatus: 'payment_succeeded',
    }));

    const result = await mutate(id, {
      addOnIdsToAdd: ['ozone'],
      expectedBookingVersion: 1,
      vehicleId: 'veh_1',
    });
    assert.equal(result.ok, true, result.error);

    const pg = await authority.getFinancialProjection(id);
    const refreshed = await getBookingRecord(id);
    const blob = financialProjection(refreshed.booking);
    // Postgres authority, Blob compatibility, and the Admin response all agree.
    assert.equal(pg.approvedCents, 21500);
    assert.equal(pg.approvedCents, blob.approvedCents);
    assert.equal(pg.settledCents, blob.settledCents);
    assert.equal(pg.remainingCents, blob.remainingCents);
    assert.equal(result.projection.approvedCents, pg.approvedCents);
    assert.equal(result.projection.remainingCents, pg.remainingCents);
    assert.equal(pg.quoteVersion, refreshed.booking.quoteVersion);

    // Wiring: Customer portal and Admin get_job consume the same shared projection.
    const customerSrc = read('netlify/functions/customer-portal-data.js');
    const adminSrc = read('netlify/functions/admin-ops-jobs.js');
    assert.match(customerSrc, /getSharedFinancialProjection/);
    assert.match(adminSrc, /getSharedFinancialProjection/);
  });

  it('5) duplicate add is a noop: no quote, ledger, or PaymentIntent mutation', async () => {
    const repo = require('../netlify/lib/db/repositories');
    const { ensureBookingFinancial } = require('../netlify/lib/db/ensure-booking-financial');
    const { getBookingRecord } = require('../netlify/lib/booking-repository');
    const id = nextId('DUP');
    await seedBlob(baseBooking(id, {
      approvedCents: 21500,
      addOnIds: ['ozone'],
      quoteVersion: 2,
    }));

    const rec = await getBookingRecord(id);
    await ensureBookingFinancial(rec.booking);
    const quotesBefore = await prisma.quote.count({ where: { bookingId: id } });
    const ledgerBefore = await repo.listLedgerEntries(id);
    const attemptsBefore = await repo.listPaymentAttempts(id);

    const dup = await mutate(id, {
      addOnIdsToAdd: ['ozone'],
      expectedBookingVersion: 1,
      vehicleId: 'veh_1',
    });
    assert.equal(dup.ok, true, dup.error);
    assert.equal(dup.noop, true);

    assert.equal(await prisma.quote.count({ where: { bookingId: id } }), quotesBefore,
      'duplicate must not create another quote version');
    assert.equal((await repo.listLedgerEntries(id)).length, ledgerBefore.length,
      'duplicate must not mutate ledger');
    assert.equal((await repo.listPaymentAttempts(id)).length, attemptsBefore.length,
      'duplicate must not create PaymentIntent');

    const after = await getBookingRecord(id);
    const veh = (after.booking.service?.vehicles || after.booking.vehicles || [])[0] || {};
    const ids = veh.addOnIds || (veh.addons || []).map((a) => a.id);
    assert.deepEqual(ids.filter((x) => x === 'ozone'), ['ozone']);
  });

  it('6) absent remove is a noop with no quote bump', async () => {
    const id = nextId('RM-ABSENT');
    await seedBlob(baseBooking(id));

    const result = await mutate(id, {
      addOnIdsToRemove: ['rainx'],
      expectedBookingVersion: 1,
      vehicleId: 'veh_1',
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.noop, true);
    assert.equal(result.reason, 'addon_not_present');
    assert.equal(result.quoteVersion, 1, 'noop must not advance quoteVersion');
    assert.equal(await prisma.quote.count({ where: { bookingId: id } }), 0,
      'noop must not create Postgres quote rows');
  });

  it('7) removal after settlement is denied (server rule, no refund implied)', async () => {
    const { getBookingRecord } = require('../netlify/lib/booking-repository');
    const id = nextId('RM-DENY');
    const seeded = baseBooking(id, {
      approvedCents: 21500,
      settledCents: 17500,
      addOnIds: ['ozone'],
      paymentWorkflowStatus: 'awaiting_customer_payment',
      quoteVersion: 2,
    });
    seeded.status = 'Confirmed';
    seeded.jobStatus = 'confirmed';
    seeded.paymentStatus = 'due';
    seeded._historicalPaidClosed = false;
    await seedBlob(seeded);

    const denied = await mutate(id, {
      addOnIdsToRemove: ['ozone'],
      expectedBookingVersion: 1,
      vehicleId: 'veh_1',
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.statusCode, 409);
    assert.equal(denied.error, 'settled_addon_remove_denied');

    const after = await getBookingRecord(id);
    assert.equal(after.booking.ledger.approvedCents, 21500);
    assert.equal(after.booking.ledger.settledCents, 17500);
    assert.equal(after.booking.bookingVersion, 1, 'denied removal must not mutate booking');
    assert.equal(auditLog.length, 1);
    assert.equal(auditLog[0].action, 'admin_addon_denied');
    assert.equal(JSON.parse(auditLog[0].reason).error, 'settled_addon_remove_denied');
  });

  it('8) unknown add-on id is rejected server-side', async () => {
    const id = nextId('UNK');
    await seedBlob(baseBooking(id));
    const result = await mutate(id, {
      addOnIdsToAdd: ['not_a_real_addon'],
      expectedBookingVersion: 1,
      vehicleId: 'veh_1',
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'unknown_addon_id');
  });

  it('9) browser-supplied price/name/total fields are ignored — catalog price wins', async () => {
    const id = nextId('PRICE');
    await seedBlob(baseBooking(id));

    const result = await mutate(id, {
      addOnIdsToAdd: ['ozone'],
      expectedBookingVersion: 1,
      vehicleId: 'veh_1',
      // Hostile browser payload — must never influence money.
      price: 1,
      priceCents: 1,
      amount: 0.01,
      proposedTotal: 1,
      approvedFinalAmount: 1,
      addon: { id: 'ozone', name: 'Cheap', price: 0.01 },
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.projection.approvedCents, 21500, 'catalog ozone=$40 must win over any client price');
    assert.equal(result.projection.remainingCents, 21500);
  });

  it('10) expectedBookingVersion conflict creates no mutation', async () => {
    const repo = require('../netlify/lib/db/repositories');
    const { getBookingRecord } = require('../netlify/lib/booking-repository');
    const id = nextId('VER');
    await seedBlob(baseBooking(id));

    const denied = await mutate(id, {
      addOnIdsToAdd: ['ozone'],
      expectedBookingVersion: 99,
      vehicleId: 'veh_1',
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.statusCode, 409);
    assert.equal(denied.error, 'version_conflict');
    assert.equal(denied.actualBookingVersion, 1);

    const after = await getBookingRecord(id);
    assert.equal(after.booking.bookingVersion, 1);
    assert.equal(after.booking.ledger.approvedCents, 17500);
    assert.equal(await prisma.quote.count({ where: { bookingId: id } }), 0);
    assert.equal((await repo.listLedgerEntries(id)).length, 0);
    assert.equal((await repo.listPaymentAttempts(id)).length, 0);
    assert.equal(auditLog[0].action, 'admin_addon_denied');
    assert.equal(JSON.parse(auditLog[0].reason).error, 'version_conflict');
  });

  it('10b) expectedBookingVersion is mandatory', async () => {
    const id = nextId('VER-REQ');
    await seedBlob(baseBooking(id));
    const denied = await mutate(id, { addOnIdsToAdd: ['ozone'], vehicleId: 'veh_1' });
    assert.equal(denied.ok, false);
    assert.equal(denied.statusCode, 400);
    assert.equal(denied.error, 'expected_booking_version_required');
  });

  it('11) multi-vehicle booking requires explicit vehicleId', async () => {
    const id = nextId('MULTI');
    await seedBlob(baseBooking(id, {
      vehicles: [
        {
          vehicleId: 'veh_a',
          cat: 'cars',
          category: 'cars',
          tierKey: 'small',
          packageId: 'maint',
          pkgId: 'maint',
          pkgName: 'Maintenance Detail',
          vehicleLabel: 'Sedan A',
          addOnIds: [],
          addons: [],
        },
        {
          vehicleId: 'veh_b',
          cat: 'cars',
          category: 'cars',
          tierKey: 'small',
          packageId: 'maint',
          pkgId: 'maint',
          pkgName: 'Maintenance Detail',
          vehicleLabel: 'Sedan B',
          addOnIds: [],
          addons: [],
        },
      ],
    }));

    const missing = await mutate(id, {
      addOnIdsToAdd: ['ozone'],
      expectedBookingVersion: 1,
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.error, 'vehicle_target_required');

    const ok = await mutate(id, {
      addOnIdsToAdd: ['ozone'],
      expectedBookingVersion: 1,
      vehicleId: 'veh_b',
    });
    assert.equal(ok.ok, true, ok.error);
    assert.equal(ok.vehicleId, 'veh_b');
    assert.deepEqual(ok.selectedAddonIds, ['ozone']);
  });

  it('12) legacy free-form update_service add-on fields are rejected', () => {
    assert.equal(freeFormAddonBodyRejected({ addonOp: 'add', addon: { id: 'x', price: 1 } }), true);
    assert.equal(freeFormAddonBodyRejected({ addonOp: 'remove', addonId: 'x' }), true);
    assert.equal(freeFormAddonBodyRejected({ addon: { id: 'x' } }), true);
    assert.equal(freeFormAddonBodyRejected({ addons: [] }), true);
    assert.equal(freeFormAddonBodyRejected({ addOnIdsToAdd: ['ozone'] }), true);
    assert.equal(freeFormAddonBodyRejected({ addOnIdsToRemove: ['ozone'] }), true);
    assert.equal(freeFormAddonBodyRejected({ addonIds: ['ozone'] }), true);
    assert.equal(freeFormAddonBodyRejected({ package: 'Premium', vehicleLabel: 'Sedan' }), false);

    const src = read('netlify/functions/admin-ops-jobs.js');
    const marker = "if (action === 'update_service')";
    const idx = src.indexOf(marker);
    assert.ok(idx >= 0, 'update_service handler must exist');
    const updateService = src.slice(idx, idx + 600);
    assert.match(updateService, /freeFormAddonBodyRejected/);
    assert.match(updateService, /addon_mutation_required/);
    assert.match(src, /action === 'addon_mutation'/);
    assert.match(src, /adminAddonCatalogForBooking\(booking\)/);
  });

  it('13) audit contains required non-PII facts', async () => {
    const id = nextId('AUDIT');
    await seedBlob(baseBooking(id));

    const result = await mutate(id, {
      addOnIdsToAdd: ['ozone'],
      expectedBookingVersion: 1,
      vehicleId: 'veh_1',
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(auditLog.length, 1);
    const entry = auditLog[0];
    assert.equal(entry.booking_id, id);
    assert.equal(entry.actor_type, 'admin');
    assert.equal(entry.actor_id, 'admin');
    assert.equal(entry.action, 'admin_addon_add');
    assert.equal(entry.source_portal, 'admin_ops');
    assert.ok(entry.timestamp);
    const facts = JSON.parse(entry.reason);
    assert.equal(facts.op, 'add');
    assert.equal(facts.vehicleId, 'veh_1');
    assert.deepEqual(facts.addOnIdsToAdd, ['ozone']);
    assert.equal(facts.priorBookingVersion, 1);
    assert.equal(facts.bookingVersion, result.bookingVersion);
    assert.equal(facts.quoteVersion, facts.priorQuoteVersion + 1);
    assert.equal(facts.approvedCents, 21500);
    assert.equal(facts.settledCents, 0);
    assert.equal(facts.remainingCents, 21500);
    assert.equal(facts.result, 'ok');
    assert.equal(facts.noop, false);
    const raw = JSON.stringify(entry);
    assert.doesNotMatch(raw, /stripeCustomerId|stripePaymentMethodId|paymentIntentId/);
    assert.ok(!entry.previous_state.email && !entry.previous_state.phone);
  });

  it('14) pending/double-click control produces one effective request (UI wiring)', () => {
    const html = read('admin-ops.html');
    assert.match(html, /addonPending/);
    assert.match(html, /double-click → one effective mutation/);
    assert.match(html, /if \(addonPending\) return/);
    assert.match(html, /expectedBookingVersion/);
    assert.match(html, /version_conflict/);
    assert.match(html, /openDrawer\(j\.id\)/);
  });

  it('15) package-only update_service remains functional (bypass closed without blocking package)', async () => {
    assert.equal(freeFormAddonBodyRejected({
      package: 'Premium Detail',
      vehicleLabel: 'SUV',
    }), false);

    const { updateServicePackage } = require('../netlify/lib/admin-booking-mutations');
    const booking = baseBooking(nextId('PKG-ONLY'));
    const result = await updateServicePackage(booking, {
      package: 'Premium Detail',
      vehicleLabel: 'SUV',
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.booking.package, 'Premium Detail');
  });

  it('empty body is rejected with addon_ids_required', async () => {
    const id = nextId('EMPTY');
    await seedBlob(baseBooking(id));
    const result = await mutate(id, { expectedBookingVersion: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 400);
    assert.equal(result.error, 'addon_ids_required');
  });

  it('admin catalog exposure comes from the canonical serializer (no second catalog)', () => {
    const { serializeCategoryAddons } = require('../netlify/lib/canonical-addon-catalog');
    const payload = adminAddonCatalogForBooking(baseBooking('CATALOG-SHAPE', { addOnIds: ['ozone'] }));
    assert.equal(payload.addonCatalog.source, 'booking-price-catalog');
    assert.equal(payload.addonCatalog.category, 'cars');
    assert.deepEqual(payload.addonCatalog.addons, serializeCategoryAddons('cars'));
    const ozone = payload.addonCatalog.addons.find((a) => a.id === 'ozone');
    assert.ok(ozone);
    assert.equal(ozone.priceCents, 4000);
    assert.deepEqual(payload.selectedAddonIds, ['ozone']);
    assert.equal(payload.vehicles.length, 1);
    assert.equal(payload.vehicles[0].vehicleId, 'veh_1');
    assert.equal(payload.bookingVersion, 1);
    assert.equal(payload.quoteVersion, 1);
  });

  it('admin-ops.html drawer wires canonical controls without copying the catalog', () => {
    const html = read('admin-ops.html');
    assert.match(html, /renderAddonSection/);
    assert.match(html, /dAddonSelect/);
    assert.match(html, /dAddonVehicle/);
    assert.match(html, /action:\s*'addon_mutation'/);
    assert.match(html, /addOnIdsToAdd:\s*\[id\]/);
    assert.match(html, /addOnIdsToRemove:\s*\[b\.dataset\.removeAddon\]/);
    assert.match(html, /data-remove-addon/);
    assert.match(html, /expectedBookingVersion/);
    assert.match(html, /Paid — removal unavailable/);
    assert.doesNotMatch(html, /Ozone Odor Treatment|Pet Hair Removal|Rain-X Glass Treatment/);
    assert.doesNotMatch(html, /priceCents\s*:\s*\d/);
    assert.doesNotMatch(html, /addonOp/);
  });
});
