'use strict';

require('dotenv/config');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { prismaConfigured } = require('../netlify/lib/prisma');

const RUN_ID = `PR4-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
const FAKE_ENV = {
  STRIPE_SECRET_KEY: 'sk_test_fake000000000000000000',
  CD1_POSTGRES_PAYMENT: '1',
};

function createMemoryStore(seed = {}) {
  const data = new Map(Object.entries(seed).map(([key, value]) => [key, structuredClone(value)]));
  const etags = new Map([...data.keys()].map((key) => [key, `etag-${key}-0`]));
  return {
    async get(key) {
      return data.has(key) ? structuredClone(data.get(key)) : null;
    },
    async getWithMetadata(key) {
      return data.has(key)
        ? { data: structuredClone(data.get(key)), etag: etags.get(key) || null }
        : null;
    },
    async setJSON(key, value, options = {}) {
      if (options.onlyIfMatch && options.onlyIfMatch !== etags.get(key)) return { modified: false };
      data.set(key, structuredClone(value));
      etags.set(key, `etag-${key}-${Date.now()}-${Math.random()}`);
      return { modified: true };
    },
    async list() {
      return { blobs: [...data.keys()].map((key) => ({ key })) };
    },
  };
}

function car({
  vehicleId = 'veh_1',
  packageId = 'maint',
  tierKey = 'small',
  year = '2022',
  make = 'Toyota',
  model = 'Corolla',
  addOnIds = [],
} = {}) {
  return {
    vehicleId,
    category: 'cars',
    cat: 'cars',
    tierKey,
    tier: tierKey,
    packageId,
    pkgId: packageId,
    year,
    make,
    model,
    vehicleLabel: `${year} ${make} ${model}`,
    addOnIds: [...addOnIds],
    addons: addOnIds.map((id) => ({ id })),
  };
}

function booking(id, {
  bookingVersion = 1,
  quoteVersion = 1,
  approvedCents = 15000,
  settledCents = 0,
  vehicles = [car()],
} = {}) {
  return {
    id,
    schemaVersion: 1,
    bookingVersion,
    quoteVersion,
    status: settledCents >= approvedCents && settledCents > 0 ? 'Paid' : 'Confirmed',
    appointmentStatus: 'confirmed',
    jobStatus: settledCents >= approvedCents && settledCents > 0 ? 'completed_paid' : 'confirmed',
    paymentStatus: settledCents >= approvedCents && settledCents > 0 ? 'paid' : 'due',
    paymentWorkflowStatus: settledCents >= approvedCents && settledCents > 0
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
      refundedCents: 0,
      entries: settledCents > 0
        ? [{
          kind: 'settlement',
          amountCents: settledCents,
          providerObjectId: `pi_test_${id}`,
          recordedAt: new Date().toISOString(),
        }]
        : [],
    },
    vehicles,
    changeRequests: [],
    operationReceipts: [],
    eventLog: [],
  };
}

describe('PR4 operation idempotency contract', () => {
  it('canonicalizes fingerprints and derives stable non-guessable identifiers', () => {
    const {
      normalizeIdempotencyKey,
      mutationFingerprint,
      requestIdFromKey,
      adjustmentIdFromKey,
      appendOperationReceipt,
    } = require('../netlify/lib/operation-idempotency');

    assert.equal(normalizeIdempotencyKey('  pr4.customer:0001  '), 'pr4.customer:0001');
    assert.equal(normalizeIdempotencyKey('short'), '');
    assert.equal(
      mutationFingerprint({ z: 1, nested: { b: 2, a: 1 } }),
      mutationFingerprint({ nested: { a: 1, b: 2 }, z: 1 })
    );
    assert.equal(
      requestIdFromKey('CD1-A', 'pr4.customer:0001'),
      requestIdFromKey('CD1-A', 'pr4.customer:0001')
    );
    assert.notEqual(
      requestIdFromKey('CD1-A', 'pr4.customer:0001'),
      requestIdFromKey('CD1-B', 'pr4.customer:0001')
    );
    assert.equal(
      adjustmentIdFromKey('vehicle', 'CD1-PR4', 'pr4.customer:0001'),
      adjustmentIdFromKey('vehicle', 'CD1-PR4', 'pr4.customer:0001')
    );

    let aggregate = {};
    for (let index = 0; index < 105; index += 1) {
      aggregate.operationReceipts = appendOperationReceipt(aggregate, {
        idempotencyKey: `pr4.receipt.${String(index).padStart(3, '0')}`,
        fingerprint: `fingerprint-${index}`,
        action: 'test',
        actor: 'test',
        bookingVersion: index,
        quoteVersion: index,
      });
    }
    assert.equal(aggregate.operationReceipts.length, 100);
    assert.equal(aggregate.operationReceipts[0].idempotencyKey, 'pr4.receipt.005');
  });
});

describe('PR4 customer/Admin optimistic concurrency', () => {
  let setBookingStoreOverride;

  before(() => {
    ({ setBookingStoreOverride } = require('../netlify/lib/booking-repository'));
  });

  afterEach(() => setBookingStoreOverride(null));

  it('customer retry replays one request; changed payload conflicts; stale new key is 409', async () => {
    const id = `${RUN_ID}-CUSTOMER-IDEMP`;
    setBookingStoreOverride(createMemoryStore({ [id]: booking(id) }));
    const { submitChangeRequestCommand } = require('../netlify/lib/booking-commands');
    const { getBookingRecord } = require('../netlify/lib/booking-repository');
    const base = {
      bookingId: id,
      expectedBookingVersion: 1,
      requestType: 'package_change_request',
      target: { vehicleId: 'veh_1' },
      delta: { packageId: 'full' },
      idempotencyKey: 'pr4.customer.package.0001',
      authorizedRef: 'customer:test',
    };

    const first = await submitChangeRequestCommand(base);
    assert.equal(first.ok, true, first.error);
    assert.equal(first.booking.bookingVersion, 2);

    const retry = await submitChangeRequestCommand(base);
    assert.equal(retry.ok, true, retry.error);
    assert.equal(retry.idempotent, true);
    assert.equal(retry.changeRequest.requestId, first.changeRequest.requestId);

    const conflicting = await submitChangeRequestCommand({
      ...base,
      delta: { packageId: 'premium' },
    });
    assert.equal(conflicting.ok, false);
    assert.equal(conflicting.statusCode, 409);
    assert.equal(conflicting.error, 'idempotency_conflict');

    const stale = await submitChangeRequestCommand({
      ...base,
      idempotencyKey: 'pr4.customer.package.0002',
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.error, 'version_conflict');

    const stored = await getBookingRecord(id);
    assert.equal(stored.booking.bookingVersion, 2);
    assert.equal(stored.booking.changeRequests.length, 1);
    assert.equal(
      stored.booking.eventLog.filter((row) => row.action === 'customer_change_requested').length,
      1
    );
  });

  it('Admin lost-response retry is idempotent and does not duplicate audit', async () => {
    assert.equal(prismaConfigured(), true, 'PostgreSQL 16 is required for PR4 Admin financial replay');
    const id = `${RUN_ID}-ADMIN-IDEMP`;
    const original = booking(id);
    setBookingStoreOverride(createMemoryStore({ [id]: original }));
    const { adminVehicleMutation } = require('../netlify/functions/admin-ops-jobs');
    const audits = [];
    const input = {
      bookingId: id,
      previousBooking: original,
      env: FAKE_ENV,
      auditFn: async (entry) => audits.push(entry),
      body: {
        vehicleOp: 'add',
        expectedBookingVersion: 1,
        idempotencyKey: 'pr4.admin.vehicle.0001',
        reason: 'Customer confirmed second vehicle',
        vehicle: car({ vehicleId: '', year: '2023', make: 'Honda', model: 'Civic' }),
      },
    };

    const first = await adminVehicleMutation(input);
    assert.equal(first.ok, true, first.error);
    assert.equal(first.bookingVersion, 2);
    assert.equal(audits.length, 1);

    const retry = await adminVehicleMutation(input);
    assert.equal(retry.ok, true, retry.error);
    assert.equal(retry.idempotent, true);
    assert.equal(retry.bookingVersion, 2);
    assert.equal(audits.length, 1, 'idempotent replay must not append a second audit entry');

    const conflict = await adminVehicleMutation({
      ...input,
      body: {
        ...input.body,
        vehicle: car({ vehicleId: '', year: '2024', make: 'Honda', model: 'Accord' }),
      },
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.error, 'idempotency_conflict');
  });
});

describe('PR4 vehicle and package/add-on rules', () => {
  let setBookingStoreOverride;

  before(() => {
    ({ setBookingStoreOverride } = require('../netlify/lib/booking-repository'));
  });

  afterEach(() => setBookingStoreOverride(null));

  it('keeps stable vehicle identity, targets explicitly, and denies final removal', () => {
    const { applyVehicleOperation } = require('../netlify/lib/vehicle-financial-mutation');
    const service = { vehicles: [car({ vehicleId: 'veh_a' }), car({ vehicleId: 'veh_b' })] };
    const replacement = applyVehicleOperation(service, {
      op: 'replace',
      target: { vehicleId: 'veh_b' },
      vehicle: car({ vehicleId: '', year: '2024', make: 'Subaru', model: 'Outback', packageId: 'full' }),
    });
    assert.equal(replacement.ok, true);
    assert.equal(replacement.vehicleId, 'veh_b');
    assert.equal(replacement.service.vehicles[0].vehicleId, 'veh_a');
    assert.equal(replacement.service.vehicles[1].vehicleId, 'veh_b');
    assert.equal(replacement.service.vehicles[1].model, 'Outback');

    const removed = applyVehicleOperation(replacement.service, {
      op: 'remove',
      target: { vehicleId: 'veh_a' },
    });
    assert.equal(removed.ok, true);
    assert.deepEqual(removed.service.vehicles.map((row) => row.vehicleId), ['veh_b']);
    assert.equal(
      applyVehicleOperation(removed.service, { op: 'remove', target: { vehicleId: 'veh_b' } }).error,
      'last_vehicle_denied'
    );
  });

  it('package-included add-ons are visible but never billed twice', () => {
    const { includedAddonIds, computeVehicleSubtotal } = require('../netlify/lib/booking-price-catalog');
    const { applyServiceDelta } = require('../netlify/lib/canonical-quote');
    assert.deepEqual(includedAddonIds('cars', 'full'), ['claybar']);

    const fullWithDuplicate = car({ packageId: 'full', addOnIds: ['claybar', 'ozone'] });
    const priced = computeVehicleSubtotal(fullWithDuplicate);
    assert.equal(priced.ok, true);
    assert.equal(priced.subtotal, 280);
    assert.deepEqual(priced.addons.map((row) => row.id), ['ozone']);

    const includedOnly = applyServiceDelta(
      { vehicles: [car({ packageId: 'full' })] },
      { vehicleId: 'veh_1' },
      { addOnIdsToAdd: ['claybar'] }
    );
    assert.equal(includedOnly.ok, true);
    assert.equal(includedOnly.noop, true);
    assert.equal(includedOnly.reason, 'addon_included_in_package');

    const upgrade = applyServiceDelta(
      { vehicles: [car({ packageId: 'maint', addOnIds: ['claybar', 'ozone'] })] },
      { vehicleId: 'veh_1' },
      { packageId: 'full' }
    );
    assert.equal(upgrade.ok, true);
    assert.deepEqual(upgrade.service.vehicles[0].addOnIds, ['ozone']);
  });

  it('paid vehicle reduction preserves settlement/history and exposes credit without refund', async () => {
    assert.equal(prismaConfigured(), true, 'PostgreSQL 16 is required for PR4 vehicle credit coverage');
    const id = `${RUN_ID}-VEH-CREDIT`;
    const seed = booking(id, {
      approvedCents: 30000,
      settledCents: 30000,
      vehicles: [car({ vehicleId: 'veh_keep' }), car({ vehicleId: 'veh_remove', make: 'Honda', model: 'Civic' })],
    });
    setBookingStoreOverride(createMemoryStore({ [id]: seed }));
    const { applyVehicleFinancialMutation } = require('../netlify/lib/vehicle-financial-mutation');

    const result = await applyVehicleFinancialMutation({
      bookingId: id,
      expectedBookingVersion: 1,
      op: 'remove',
      target: { vehicleId: 'veh_remove' },
      idempotencyKey: 'pr4.vehicle.credit.0001',
      actor: 'admin',
      env: FAKE_ENV,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.postgresProjection.approvedCents, 15000);
    assert.equal(result.postgresProjection.settledCents, 30000);
    assert.equal(result.outstandingCreditCents, 15000);
    assert.equal(result.postgresProjection.refundedCents, 0);
    assert.deepEqual(result.booking.vehicles.map((row) => row.vehicleId), ['veh_keep']);
    assert.equal(result.booking.vehicleHistory.length, 1);
    assert.equal(result.booking.vehicleHistory[0].vehicleId, 'veh_remove');
    assert.equal(result.booking.vehicleHistory[0].historyStatus, 'removed');
  });
});

describe('PR4 browser resilience and accessibility wiring', () => {
  const root = path.join(__dirname, '..');
  const garageJs = fs.readFileSync(path.join(root, 'assets/my-garage.js'), 'utf8');
  const garageHtml = fs.readFileSync(path.join(root, 'my-garage.html'), 'utf8');
  const adminLoginHtml = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
  const adminHtml = fs.readFileSync(path.join(root, 'admin-ops.html'), 'utf8');

  it('retains mutation keys across recoverable network/server failures and handles conflicts', () => {
    assert.match(garageJs, /mutationRequestKeys/);
    assert.match(garageJs, /idempotencyKey/);
    assert.match(garageJs, /expectedBookingVersion/);
    assert.match(garageJs, /version_conflict/);
    assert.match(garageJs, /too_many_requests|429/);
    assert.match(garageJs, /service_unavailable|5xx/);
    assert.match(garageJs, /offline|navigator\.onLine/);
  });

  it('enforces mobile-safe overflow, 44px touch targets, and 16px form inputs', () => {
    for (const source of [garageHtml, adminHtml]) {
      assert.match(source, /overflow-x\s*:\s*(?:auto|hidden|clip)/i);
      assert.match(source, /min-height\s*:\s*44px/i);
      assert.match(source, /font-size\s*:\s*16px/i);
    }
    assert.match(adminLoginHtml, /input\{[^}]*font-size\s*:\s*16px/i);
    assert.match(adminLoginHtml, /\.top-home\{[^}]*min-height\s*:\s*44px/i);
    assert.match(adminLoginHtml, /\.links a\{[^}]*min-height\s*:\s*44px/i);
  });

  it('targets package/add-on/vehicle changes and exposes package-included treatments', () => {
    assert.match(garageJs, /packageModalVehicleId/);
    assert.match(garageJs, /selectedAddonVehicle/);
    assert.match(garageJs, /vehicle_replace_request/);
    assert.match(garageJs, /vehicle_remove_request/);
    assert.match(garageJs, /includedInPackageIds/);
    assert.match(adminHtml, /includedInPackageIds/);
  });
});
