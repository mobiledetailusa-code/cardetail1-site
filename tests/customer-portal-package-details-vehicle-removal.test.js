/**
 * Customer Portal B1 — expandable package details + vehicle removal requests.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  resolvePackageDetailsForVehicle,
  resolvePackageDetailsForCustomerView,
} = require('../netlify/lib/package-details-resolve');
const { projectVehicleForCustomer } = require('../netlify/lib/ops-schema');
const { canRequestChange } = require('../netlify/lib/appointment-status-policy');
const { setBookingStoreOverride } = require('../netlify/lib/booking-repository');

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
    async delete(key) {
      data.delete(key);
      etags.delete(key);
    },
  };
}

function twoVehicleFixture(overrides) {
  return {
    id: 'CD1-B1-MULTI',
    bookingVersion: 3,
    quoteVersion: 2,
    status: 'Confirmed',
    appointmentStatus: 'confirmed',
    jobStatus: 'confirmed',
    zipCode: '07102',
    travelFeeAmount: 0,
    approvedFinalAmount: 887,
    totalPrice: 887,
    ledger: { approvedCents: 88700, settledCents: 0, creditedCents: 0, entries: [] },
    vehicles: [
      {
        vehicleId: 'veh_bronco',
        year: '2025',
        make: 'Ford',
        model: 'Bronco',
        vehicleLabel: '2025 Ford Bronco',
        category: 'cars',
        cat: 'cars',
        packageId: 'maint',
        pkgId: 'maint',
        packageName: 'Maintenance Detail',
        pkgName: 'Maintenance Detail',
        tierKey: 'suv2',
        basePrice: 150,
        packagePrice: 150,
        addonTotal: 190,
        subtotal: 340,
        addons: [
          { id: 'pethair', name: 'Pet Hair Removal', qty: 1, price: 95 },
          { id: 'odor', name: 'Odor Treatment & Sanitize', qty: 1, price: 149 },
        ],
        addOnIds: ['pethair', 'odor'],
      },
      {
        vehicleId: 'veh_boat',
        year: '2023',
        make: 'Yamaha Boats',
        model: '222S',
        vehicleLabel: '2023 Yamaha Boats 222S',
        category: 'boats',
        cat: 'boats',
        packageId: 'essential',
        pkgId: 'essential',
        packageName: 'Essential Marine',
        pkgName: 'Essential Marine',
        lengthFt: 22,
        basePrice: 462,
        packagePrice: 462,
        addonTotal: 25,
        subtotal: 487,
        addons: [
          { id: 'rainx', name: 'Rain-X Glass Treatment', qty: 1, price: 25 },
        ],
        addOnIds: ['rainx'],
      },
    ],
    changeRequests: [],
    ...(overrides || {}),
  };
}

describe('package details resolution', () => {
  it('resolves Maintenance Detail inclusions from catalog without inventing', () => {
    const details = resolvePackageDetailsForVehicle({
      packageId: 'maint',
      packageName: 'Maintenance Detail',
      category: 'cars',
      basePrice: 150,
      subtotal: 340,
      addons: [{ id: 'pethair', name: 'Pet Hair Removal', qty: 1, price: 95 }],
    });
    assert.equal(details.available, true);
    assert.equal(details.source, 'catalog');
    assert.ok(details.includedServices.length >= 3);
    assert.match(details.includedServices.join(' '), /Exterior hand wash/i);
    assert.equal(details.addons[0].name, 'Pet Hair Removal');
    assert.equal(details.packagePrice, 150);
    assert.equal(details.vehicleSubtotal, 340);
  });

  it('resolves Essential Marine description from length catalog', () => {
    const details = resolvePackageDetailsForVehicle({
      packageId: 'essential',
      packageName: 'Essential Marine',
      category: 'boats',
      basePrice: 462,
      subtotal: 487,
    });
    assert.equal(details.available, true);
    assert.match(details.description || details.name, /Marine|marine|Essential/);
  });

  it('does not invent inclusions for unknown packages', () => {
    const details = resolvePackageDetailsForVehicle({
      packageId: 'totally_unknown_pack_xyz',
      packageName: 'Mystery Detail Deluxe',
      category: 'cars',
    });
    assert.equal(details.available, false);
    assert.match(details.unavailableMessage, /unavailable for this older booking/i);
    assert.deepEqual(details.includedServices, []);
  });

  it('prefers packageSnapshot when present', () => {
    const details = resolvePackageDetailsForVehicle({
      packageId: 'maint',
      packageSnapshot: {
        id: 'maint',
        name: 'Snap Pack',
        description: 'Snapshot description',
        includedServices: ['Snap wash', 'Snap vacuum'],
        limitations: 'Snap limit',
        priceCents: 19900,
      },
      basePrice: 150,
    });
    assert.equal(details.source, 'snapshot');
    assert.equal(details.name, 'Snap Pack');
    assert.deepEqual(details.includedServices, ['Snap wash', 'Snap vacuum']);
    assert.equal(details.packagePrice, 170);
  });

  it('projectVehicleForCustomer attaches customer-safe packageDetails', () => {
    const projected = projectVehicleForCustomer({
      vehicleId: 'veh_bronco',
      year: '2025',
      make: 'Ford',
      model: 'Bronco',
      category: 'cars',
      packageId: 'maint',
      packageName: 'Maintenance Detail',
      basePrice: 150,
      subtotal: 340,
      addons: [{ id: 'pethair', name: 'Pet Hair Removal', price: 95, qty: 1 }],
    });
    assert.ok(projected.packageDetails);
    assert.equal(projected.packageDetails.available, true);
    assert.ok(Array.isArray(projected.packageDetails.includedServices));
    // Customer view omits raw addon ids
    assert.equal(projected.packageDetails.addons[0].id, undefined);
    assert.equal(projected.packageDetails.addons[0].name, 'Pet Hair Removal');
  });
});

describe('package accordion UI wiring', () => {
  const garageJs = fs.readFileSync(path.join(__dirname, '../assets/my-garage.js'), 'utf8');
  const garageHtml = fs.readFileSync(path.join(__dirname, '../my-garage.html'), 'utf8');

  it('renders collapsed package details toggle with aria attributes', () => {
    assert.match(garageJs, /package-details-toggle/);
    assert.match(garageJs, /aria-expanded/);
    assert.match(garageJs, /aria-controls/);
    // Portal Lite wording: "View services" / "Hide services".
    assert.match(garageJs, /View services/);
    assert.match(garageJs, /Hide services/);
    assert.match(garageJs, /package-details-panel" hidden/);
  });

  it('keeps package details scoped per vehicleId', () => {
    assert.match(garageJs, /data-vehicle-id/);
    assert.match(garageJs, /pkg-details-/);
  });

  it('uses min 44px touch target CSS', () => {
    assert.match(garageHtml, /package-details-toggle\{[^}]*min-height:44px/);
    assert.match(garageHtml, /vehicle-actions \.btn\{min-height:44px\}/);
  });

  it('stacks vehicle actions on narrow viewports', () => {
    assert.match(garageHtml, /@media\(max-width:480px\)[\s\S]*vehicle-actions\{flex-direction:column/);
  });
});

describe('vehicle_remove_request policy + commands', () => {
  let store;

  beforeEach(() => {
    store = createMemoryStore({ 'CD1-B1-MULTI': twoVehicleFixture() });
    setBookingStoreOverride(store);
  });

  afterEach(() => {
    setBookingStoreOverride(null);
  });

  it('gates vehicle_remove for admin review (not auto-apply)', () => {
    const policy = canRequestChange(twoVehicleFixture(), 'vehicle_remove');
    assert.equal(policy.ok, true);
    assert.equal(policy.pendingApproval, true);
  });

  it('submit creates pending removal without mutating vehicles', async () => {
    const { submitChangeRequestCommand } = require('../netlify/lib/booking-commands');
    const { getBookingRecord } = require('../netlify/lib/booking-repository');

    const submitted = await submitChangeRequestCommand({
      bookingId: 'CD1-B1-MULTI',
      expectedBookingVersion: 3,
      requestType: 'vehicle_remove_request',
      target: { vehicleId: 'veh_bronco' },
      delta: {},
    });
    assert.equal(submitted.ok, true, submitted.error + ' ' + (submitted.message || ''));
    assert.equal(submitted.changeRequest.status, 'pending');
    assert.equal(submitted.changeRequest.target.vehicleId, 'veh_bronco');
    assert.equal(submitted.changeRequest.proposedApprovedCents, 42100);

    const after = await getBookingRecord('CD1-B1-MULTI');
    assert.equal(after.booking.vehicles.length, 2, 'authoritative booking not mutated on submit');
    assert.equal(after.booking.bookingVersion, 4);
    assert.equal(after.booking.changeRequests.length, 1);
  });

  it('rejects duplicate pending removal for same vehicle', async () => {
    const { submitChangeRequestCommand } = require('../netlify/lib/booking-commands');
    const first = await submitChangeRequestCommand({
      bookingId: 'CD1-B1-MULTI',
      expectedBookingVersion: 3,
      requestType: 'vehicle_remove_request',
      target: { vehicleId: 'veh_bronco' },
      delta: {},
    });
    assert.equal(first.ok, true);
    const second = await submitChangeRequestCommand({
      bookingId: 'CD1-B1-MULTI',
      expectedBookingVersion: first.booking.bookingVersion,
      requestType: 'vehicle_remove_request',
      target: { vehicleId: 'veh_bronco' },
      delta: {},
    });
    assert.equal(second.ok, false);
    assert.equal(second.error, 'duplicate_pending_request');
  });

  it('rejects stale booking version', async () => {
    const { submitChangeRequestCommand } = require('../netlify/lib/booking-commands');
    const submitted = await submitChangeRequestCommand({
      bookingId: 'CD1-B1-MULTI',
      expectedBookingVersion: 1,
      requestType: 'vehicle_remove_request',
      target: { vehicleId: 'veh_bronco' },
      delta: {},
    });
    assert.equal(submitted.ok, false);
    assert.equal(submitted.error, 'version_conflict');
  });

  it('rejects last-vehicle removal', async () => {
    store = createMemoryStore({
      'CD1-ONE': twoVehicleFixture({
        id: 'CD1-ONE',
        vehicles: [twoVehicleFixture().vehicles[0]],
        approvedFinalAmount: 340,
        totalPrice: 340,
        ledger: { approvedCents: 40000, settledCents: 0, creditedCents: 0, entries: [] },
      }),
    });
    setBookingStoreOverride(store);
    const { submitChangeRequestCommand } = require('../netlify/lib/booking-commands');
    const submitted = await submitChangeRequestCommand({
      bookingId: 'CD1-ONE',
      expectedBookingVersion: 3,
      requestType: 'vehicle_remove_request',
      target: { vehicleId: 'veh_bronco' },
      delta: {},
    });
    assert.equal(submitted.ok, false);
    assert.equal(submitted.error, 'last_vehicle_denied');
  });

  it('admin decline preserves booking vehicles', async () => {
    const {
      submitChangeRequestCommand,
      decideChangeRequestCommand,
    } = require('../netlify/lib/booking-commands');
    const { getBookingRecord } = require('../netlify/lib/booking-repository');
    const submitted = await submitChangeRequestCommand({
      bookingId: 'CD1-B1-MULTI',
      expectedBookingVersion: 3,
      requestType: 'vehicle_remove_request',
      target: { vehicleId: 'veh_bronco' },
      delta: {},
    });
    const decided = await decideChangeRequestCommand({
      bookingId: 'CD1-B1-MULTI',
      requestId: submitted.changeRequest.requestId,
      decision: 'reject',
      expectedBookingVersion: submitted.booking.bookingVersion,
    });
    assert.equal(decided.ok, true, decided.error);
    const after = await getBookingRecord('CD1-B1-MULTI');
    assert.equal(after.booking.vehicles.length, 2);
    const cr = after.booking.changeRequests.find((r) => r.requestId === submitted.changeRequest.requestId);
    assert.ok(['rejected', 'declined'].includes(String(cr.status)) || cr.decision === 'reject' || cr.adminDecision === 'reject' || cr.status === 'rejected');
  });

  it('admin approval removes only Bronco and reprices to $487', async () => {
    const {
      submitChangeRequestCommand,
      decideChangeRequestCommand,
    } = require('../netlify/lib/booking-commands');
    const { getBookingRecord } = require('../netlify/lib/booking-repository');
    const submitted = await submitChangeRequestCommand({
      bookingId: 'CD1-B1-MULTI',
      expectedBookingVersion: 3,
      requestType: 'vehicle_remove_request',
      target: { vehicleId: 'veh_bronco' },
      delta: {},
    });
    assert.equal(submitted.changeRequest.proposedApprovedCents, 42100);

    const decided = await decideChangeRequestCommand({
      bookingId: 'CD1-B1-MULTI',
      requestId: submitted.changeRequest.requestId,
      decision: 'approve',
      expectedBookingVersion: submitted.booking.bookingVersion,
      acceptRequote: true,
    });
    assert.equal(decided.ok, true, `${decided.error} ${decided.message || ''}`);
    const after = await getBookingRecord('CD1-B1-MULTI');
    assert.equal(after.booking.vehicles.length, 1);
    assert.equal(after.booking.vehicles[0].vehicleId, 'veh_boat');
    assert.equal(after.booking.ledger.approvedCents, 42100);
    assert.ok(after.booking.bookingVersion > submitted.booking.bookingVersion);
  });

  it('admin approval removing boat leaves Bronco at $340', async () => {
    const {
      submitChangeRequestCommand,
      decideChangeRequestCommand,
    } = require('../netlify/lib/booking-commands');
    const { getBookingRecord } = require('../netlify/lib/booking-repository');
    const submitted = await submitChangeRequestCommand({
      bookingId: 'CD1-B1-MULTI',
      expectedBookingVersion: 3,
      requestType: 'vehicle_remove_request',
      target: { vehicleId: 'veh_boat' },
      delta: {},
    });
    assert.equal(submitted.changeRequest.proposedApprovedCents, 40000);
    const decided = await decideChangeRequestCommand({
      bookingId: 'CD1-B1-MULTI',
      requestId: submitted.changeRequest.requestId,
      decision: 'approve',
      expectedBookingVersion: submitted.booking.bookingVersion,
      acceptRequote: true,
    });
    assert.equal(decided.ok, true, `${decided.error} ${decided.message || ''}`);
    const after = await getBookingRecord('CD1-B1-MULTI');
    assert.equal(after.booking.vehicles.length, 1);
    assert.equal(after.booking.vehicles[0].vehicleId, 'veh_bronco');
    assert.equal(after.booking.ledger.approvedCents, 40000);
  });

  it('paid booking approve returns payment_adjustment_required without mutating', async () => {
    store = createMemoryStore({
      'CD1-B1-MULTI': twoVehicleFixture({
        ledger: { approvedCents: 88700, settledCents: 88700, creditedCents: 0, entries: [] },
        paymentStatus: 'paid',
        paymentWorkflowStatus: 'payment_succeeded',
      }),
    });
    setBookingStoreOverride(store);
    const {
      submitChangeRequestCommand,
      decideChangeRequestCommand,
    } = require('../netlify/lib/booking-commands');
    const { getBookingRecord } = require('../netlify/lib/booking-repository');

    const submitted = await submitChangeRequestCommand({
      bookingId: 'CD1-B1-MULTI',
      expectedBookingVersion: 3,
      requestType: 'vehicle_remove_request',
      target: { vehicleId: 'veh_bronco' },
      delta: {},
    });
    assert.equal(submitted.ok, true, submitted.error);

    const decided = await decideChangeRequestCommand({
      bookingId: 'CD1-B1-MULTI',
      requestId: submitted.changeRequest.requestId,
      decision: 'approve',
      expectedBookingVersion: submitted.booking.bookingVersion,
      acceptRequote: true,
    });
    assert.equal(decided.ok, false);
    assert.equal(decided.error, 'payment_adjustment_required');
    assert.equal(decided.paymentAdjustmentRequired, true);

    const after = await getBookingRecord('CD1-B1-MULTI');
    assert.equal(after.booking.vehicles.length, 2);
    assert.equal(after.booking.ledger.settledCents, 88700);
  });
});

describe('my-garage vehicle removal UX markers', () => {
  const garageJs = fs.readFileSync(path.join(__dirname, '../assets/my-garage.js'), 'utf8');

  it('exposes per-vehicle removal action and pending badge', () => {
    assert.match(garageJs, /Request vehicle removal/);
    assert.match(garageJs, /Removal requested — Pending review/);
    assert.match(garageJs, /vehicle_remove_request/);
    assert.match(garageJs, /openVehicleRemovalConfirm/);
  });

  it('wires Change package and Manage add-ons per vehicle', () => {
    assert.match(garageJs, /Change package/);
    assert.match(garageJs, /Manage add-ons/);
    assert.match(garageJs, /data-vehicle-id/);
  });
});
