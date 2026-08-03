/**
 * Admin Ops — vehicle removal request pipeline + compact appointment workspace.
 */
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const {
  projectChangeRequestForAdmin,
  projectChangeRequestsForAdmin,
  mergeAdminRequestLists,
  isOpenStatus,
} = require('../netlify/lib/admin-change-request-projection');
const { projectJobForAdmin } = require('../netlify/lib/ops-workflow');

const adminOps = read('admin-ops.html');
const adminRequests = read('netlify/functions/admin-customer-requests.js');

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
      return { data: JSON.parse(JSON.stringify(data.get(key))), etag: etags.get(key) || null };
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

function twoVehicleFixture(overrides) {
  return {
    id: 'CD1-MSC8D3IS-9NPP',
    bookingVersion: 5,
    schemaVersion: 1,
    quoteVersion: 2,
    status: 'Confirmed',
    appointmentStatus: 'confirmed',
    jobStatus: 'confirmed',
    zipCode: '07102',
    travelFeeAmount: 0,
    approvedFinalAmount: 887,
    amountPaid: 0,
    ledger: { approvedCents: 88700, settledCents: 0, creditedCents: 0, entries: [] },
    rescheduledByClient: true,
    rescheduleRequestedDate: '2026-12-19',
    vehicles: [
      {
        vehicleId: 'veh_bronco',
        year: '2025',
        make: 'Ford',
        model: 'Bronco',
        vehicleLabel: '2025 Ford Bronco',
        cat: 'cars',
        category: 'cars',
        tierKey: 'suv2',
        packageId: 'maint',
        pkgId: 'maint',
        pkgName: 'Maintenance Detail',
        packageName: 'Maintenance Detail',
        basePrice: 175,
        packagePrice: 175,
        addonTotal: 225,
        subtotal: 400,
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
        cat: 'boats',
        category: 'boats',
        packageId: 'essential',
        pkgId: 'essential',
        pkgName: 'Essential Marine',
        packageName: 'Essential Marine',
        lengthFt: 22,
        basePrice: 462,
        packagePrice: 462,
        addonTotal: 25,
        subtotal: 487,
        addons: [{ id: 'rainx', name: 'Rain-X Glass Treatment', qty: 1, price: 25 }],
        addOnIds: ['rainx'],
      },
    ],
    changeRequests: [],
    ...(overrides || {}),
  };
}

describe('admin change-request projection', () => {
  it('projects vehicle_remove_request with vehicleId and proposed totals', () => {
    const booking = twoVehicleFixture({
      changeRequests: [{
        requestId: 'cr_test_remove',
        requestType: 'vehicle_remove_request',
        status: 'pending',
        baseBookingVersion: 5,
        proposedApprovedCents: 48700,
        target: { vehicleId: 'veh_bronco' },
        delta: {
          operation: 'vehicle_remove',
          vehicleSnapshot: {
            vehicleId: 'veh_bronco',
            vehicleLabel: '2025 Ford Bronco',
            packageName: 'Maintenance Detail',
            addons: [{ name: 'Pet Hair Removal' }],
            subtotal: 400,
          },
          currentApprovedCents: 88700,
          proposedApprovedCents: 48700,
        },
        submittedAt: '2026-08-03T12:00:00.000Z',
      }],
    });
    const { pendingChangeRequests, pendingChangeRequestCount } = projectChangeRequestsForAdmin(booking);
    assert.equal(pendingChangeRequestCount, 1);
    assert.equal(pendingChangeRequests[0].requestType, 'vehicle_remove_request');
    assert.equal(pendingChangeRequests[0].vehicleId, 'veh_bronco');
    assert.equal(pendingChangeRequests[0].proposedApprovedCents, 48700);
    assert.equal(pendingChangeRequests[0].requestedState.proposedTotal, 487);
  });

  it('projectJobForAdmin surfaces pendingChangeRequests (not only legacy flags)', () => {
    const job = projectJobForAdmin(twoVehicleFixture({
      changeRequests: [{
        requestId: 'cr_visible',
        requestType: 'vehicle_remove_request',
        status: 'pending',
        target: { vehicleId: 'veh_boat' },
        proposedApprovedCents: 40000,
        delta: {
          vehicleSnapshot: { vehicleId: 'veh_boat', packageName: 'Essential Marine', subtotal: 487 },
          currentApprovedCents: 88700,
        },
      }],
    }));
    assert.ok(Array.isArray(job.pendingChangeRequests));
    assert.equal(job.pendingChangeRequestCount, 1);
    assert.equal(job.customerChangePending, true);
    assert.equal(job.pendingChangeRequests[0].requestType, 'vehicle_remove_request');
  });

  it('merge prefers booking authority over index', () => {
    const merged = mergeAdminRequestLists(
      [{ id: 'cr_1', status: 'pending', requestType: 'vehicle_remove_request' }],
      [{ id: 'cr_1', status: 'rejected', requestType: 'vehicle_remove_request' }]
    );
    assert.equal(merged[0].status, 'rejected');
  });
});

describe('admin-ops renderer wiring', () => {
  it('renders embedded change requests, not only legacy reschedule flags', () => {
    assert.match(adminOps, /renderEmbeddedChangeRequestCards/);
    assert.match(adminOps, /pendingChangeRequestsOf/);
    assert.match(adminOps, /Approve removal/);
    assert.match(adminOps, /job-req-badge/);
    assert.match(adminOps, /pendingRequestCountOf/);
  });

  it('uses compact appointment panels with one open at a time', () => {
    assert.match(adminOps, /appt-panel-tabs/);
    // Admin Lite panel set: Summary · Services · Schedule · Payment · Notes · More.
    // The requests panel is retained but reached from the pending alert / More.
    assert.match(adminOps, /data-appt-panel="summary"/);
    assert.match(adminOps, /data-appt-panel="requests"/);
    assert.match(adminOps, /data-appt-panel="services"/);
    assert.match(adminOps, /data-appt-panel="schedule"/);
    assert.match(adminOps, /data-appt-panel="payment"/);
    assert.match(adminOps, /data-appt-panel="notes"/);
    assert.match(adminOps, /data-appt-panel="more"/);
    assert.match(adminOps, /function setApptPanel/);
    assert.match(adminOps, /\.appt-panel\.on|classList\.toggle\('on'/);
  });

  it('defaults to Requests panel when pending requests exist', () => {
    assert.match(adminOps, /defaultPanel = \(openDrawerFocusRequests \|\| pendingCRs\.length \|\| legacyPending\) \? 'requests' : 'summary'/);
  });

  it('global requests tab has filters and pending badge', () => {
    assert.match(adminOps, /requestsFilters/);
    assert.match(adminOps, /needs_payment_adjustment/);
    assert.match(adminOps, /requestsPendingBadge/);
    assert.match(adminOps, /mergeRequestsWithJobs/);
    assert.match(adminOps, /openDrawerFocusRequests = true/);
  });

  it('keeps destructive actions separated and advanced sections collapsed by default', () => {
    assert.match(adminOps, /appt-danger-zone/);
    assert.match(adminOps, /Resolved request history/);
    assert.match(adminOps, /Operational audit<\/summary>/);
  });

  it('admin-customer-requests list supports status filters including payment adjustment', () => {
    assert.match(adminRequests, /needs_payment_adjustment/);
    assert.match(adminRequests, /projectChangeRequestForAdmin/);
    assert.match(adminRequests, /vehicle_remove_request: 'Vehicle removal'/);
  });

  it('inline script still parses', () => {
    const m = adminOps.match(/<script>\s*\(function\(\)\{[\s\S]*\}\)\(\);\s*<\/script>/);
    assert.ok(m, 'inline script missing');
    const src = m[0].replace(/<\/?script>/g, '');
    assert.doesNotThrow(() => {
      vm.compileFunction(src, [
        'CD1AdminSession', 'SiteAccess', 'document', 'window', 'location',
        'fetch', 'prompt', 'confirm', 'alert', 'navigator', 'setTimeout',
        'clearTimeout', 'FormData', 'CSS',
      ]);
    });
  });
});

describe('vehicle_remove approval path (server)', () => {
  let setBookingStoreOverride;
  let store;

  beforeEach(() => {
    ({ setBookingStoreOverride } = require('../netlify/lib/booking-repository'));
    store = createMemoryStore({ 'CD1-MSC8D3IS-9NPP': twoVehicleFixture() });
    setBookingStoreOverride(store);
  });

  afterEach(() => {
    setBookingStoreOverride(null);
  });

  it('submit + admin projection + approve Bronco → $487; boat path → $400', async () => {
    const {
      submitChangeRequestCommand,
      decideChangeRequestCommand,
    } = require('../netlify/lib/booking-commands');
    const { getBookingRecord } = require('../netlify/lib/booking-repository');

    const submitted = await submitChangeRequestCommand({
      bookingId: 'CD1-MSC8D3IS-9NPP',
      expectedBookingVersion: 5,
      requestType: 'vehicle_remove_request',
      target: { vehicleId: 'veh_bronco' },
      delta: {},
    });
    assert.equal(submitted.ok, true, submitted.error);
    assert.ok(submitted.changeRequest.requestId);
    assert.equal(submitted.changeRequest.proposedApprovedCents, 48700);
    assert.equal((await getBookingRecord('CD1-MSC8D3IS-9NPP')).booking.vehicles.length, 2);

    const job = projectJobForAdmin((await getBookingRecord('CD1-MSC8D3IS-9NPP')).booking);
    assert.equal(job.pendingChangeRequestCount, 1);
    assert.equal(job.pendingChangeRequests[0].vehicleId, 'veh_bronco');

    const declined = await decideChangeRequestCommand({
      bookingId: 'CD1-MSC8D3IS-9NPP',
      requestId: submitted.changeRequest.requestId,
      decision: 'reject',
      expectedBookingVersion: submitted.booking.bookingVersion,
    });
    assert.equal(declined.ok, true, declined.error);
    assert.equal((await getBookingRecord('CD1-MSC8D3IS-9NPP')).booking.vehicles.length, 2);

    // Fresh fixture for approve path
    store = createMemoryStore({ 'CD1-MSC8D3IS-9NPP': twoVehicleFixture() });
    setBookingStoreOverride(store);
    const sub2 = await submitChangeRequestCommand({
      bookingId: 'CD1-MSC8D3IS-9NPP',
      expectedBookingVersion: 5,
      requestType: 'vehicle_remove_request',
      target: { vehicleId: 'veh_bronco' },
      delta: {},
    });
    const approved = await decideChangeRequestCommand({
      bookingId: 'CD1-MSC8D3IS-9NPP',
      requestId: sub2.changeRequest.requestId,
      decision: 'approve',
      expectedBookingVersion: sub2.booking.bookingVersion,
      acceptRequote: true,
    });
    assert.equal(approved.ok, true, `${approved.error} ${approved.message || ''}`);
    const after = await getBookingRecord('CD1-MSC8D3IS-9NPP');
    assert.equal(after.booking.vehicles.length, 1);
    assert.equal(after.booking.vehicles[0].vehicleId, 'veh_boat');
    assert.equal(after.booking.ledger.approvedCents, 48700);

    store = createMemoryStore({ 'CD1-MSC8D3IS-9NPP': twoVehicleFixture() });
    setBookingStoreOverride(store);
    const subBoat = await submitChangeRequestCommand({
      bookingId: 'CD1-MSC8D3IS-9NPP',
      expectedBookingVersion: 5,
      requestType: 'vehicle_remove_request',
      target: { vehicleId: 'veh_boat' },
      delta: {},
    });
    assert.equal(subBoat.changeRequest.proposedApprovedCents, 40000);
  });

  it('paid booking approve returns payment_adjustment_required', async () => {
    store = createMemoryStore({
      'CD1-MSC8D3IS-9NPP': twoVehicleFixture({
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
    const sub = await submitChangeRequestCommand({
      bookingId: 'CD1-MSC8D3IS-9NPP',
      expectedBookingVersion: 5,
      requestType: 'vehicle_remove_request',
      target: { vehicleId: 'veh_bronco' },
      delta: {},
    });
    const decided = await decideChangeRequestCommand({
      bookingId: 'CD1-MSC8D3IS-9NPP',
      requestId: sub.changeRequest.requestId,
      decision: 'approve',
      expectedBookingVersion: sub.booking.bookingVersion,
      acceptRequote: true,
    });
    assert.equal(decided.ok, false);
    assert.equal(decided.error, 'payment_adjustment_required');
  });
});
