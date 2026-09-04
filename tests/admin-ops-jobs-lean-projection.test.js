'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const {
  projectJobForAdmin,
  projectJobForAdminList,
} = require('../netlify/lib/ops-workflow');

function heavyBooking(overrides = {}) {
  const eventLog = [];
  for (let i = 0; i < 40; i += 1) {
    eventLog.push({
      at: '2026-08-0' + String((i % 9) + 1) + 'T12:00:00.000Z',
      action: 'note_' + i,
      by: 'admin',
      note: 'Long operational history line ' + i + ' ' + 'x'.repeat(80),
    });
  }
  const photosBefore = Array.from({ length: 8 }, (_, i) => ({
    id: 'ph_b_' + i,
    url: 'https://example.test/before/' + i + '.jpg',
    meta: { w: 4000, h: 3000 },
  }));
  const photosAfter = Array.from({ length: 8 }, (_, i) => ({
    id: 'ph_a_' + i,
    url: 'https://example.test/after/' + i + '.jpg',
  }));
  return {
    id: 'CD1-LEAN-TEST-1',
    bookingId: 'CD1-LEAN-TEST-1',
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-03T10:00:00.000Z',
    firstName: 'Alex',
    lastName: 'Rivera',
    email: 'alex@example.test',
    phone: '2015550100',
    address: '12 Main St',
    zipCode: '07030',
    preferredDate: '2026-08-10',
    preferredTime: 'Morning',
    confirmedDate: '2026-08-10',
    confirmedTimeWindow: '9-11am',
    jobStatus: 'confirmed',
    package: 'Interior Detail',
    vehicleLabel: '2019 Honda Civic',
    vehicle: '2019 Honda Civic',
    vehicles: [
      {
        vehicleId: 'v1',
        vehicleLabel: '2019 Honda Civic',
        year: 2019,
        make: 'Honda',
        model: 'Civic',
        packageName: 'Interior Detail',
        addons: [{ name: 'Pet hair', qty: 1, price: 25 }],
        subtotal: 189,
      },
      {
        vehicleId: 'v2',
        vehicleLabel: '2021 Tesla Model 3',
        year: 2021,
        make: 'Tesla',
        model: 'Model 3',
        packageName: 'Full Detail',
        addons: [{ name: 'Ceramic', qty: 1, price: 400 }],
        subtotal: 499,
      },
    ],
    changeRequests: [
      {
        id: 'cr_vr_1',
        requestId: 'cr_vr_1',
        requestType: 'vehicle_remove_request',
        status: 'pending',
        createdAt: '2026-08-02T12:00:00.000Z',
        target: { vehicleId: 'v2' },
        previousState: { vehicleLabel: '2021 Tesla Model 3' },
        requestedState: { reason: 'sold' },
      },
      {
        id: 'cr_done',
        requestType: 'reschedule_request',
        status: 'approved',
      },
    ],
    customerChangePending: true,
    assignedTechId: 'tech_9',
    assignedTechName: 'Jordan Tech',
    adminNotes: 'Internal ops note — must not appear in list',
    notes: 'Customer driveway gate code 1234',
    customerNote: 'Please text on arrival',
    eventLog,
    photosBefore,
    photosAfter,
    photos: photosBefore,
    ledger: {
      approvedCents: 68800,
      settledCents: 20000,
      creditedCents: 0,
      entries: [
        { kind: 'settlement', providerObjectId: 'cs_x', amountCents: 20000 },
        { kind: 'quote', amountCents: 68800 },
      ],
    },
    paymentAttempts: [{ id: 'pa_1', status: 'succeeded', amountCents: 20000 }],
    stripeCustomerId: 'cus_secret',
    paymentIntentId: 'pi_secret',
    stripeCheckoutSessionId: 'cs_secret',
    portalToken: 'portal_secret_token',
    ...overrides,
  };
}

function buildSyntheticBookings(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(heavyBooking({
      id: 'CD1-LEAN-' + String(i).padStart(4, '0'),
      bookingId: 'CD1-LEAN-' + String(i).padStart(4, '0'),
      firstName: 'Cust' + i,
      assignedTechId: i % 3 === 0 ? '' : 'tech_' + (i % 5),
      assignedTechName: i % 3 === 0 ? '' : 'Tech ' + (i % 5),
    }));
  }
  return out;
}

describe('Admin Jobs lean projection', () => {
  it('list projector returns required UI fields and marks admin_list', () => {
    const row = projectJobForAdminList(heavyBooking());
    assert.equal(row._projection, 'admin_list');
    assert.equal(row.id, 'CD1-LEAN-TEST-1');
    assert.equal(row.firstName, 'Alex');
    assert.equal(row.lastName, 'Rivera');
    assert.equal(row.email, 'alex@example.test');
    assert.equal(row.phone, '2015550100');
    assert.equal(row.jobStatus, 'confirmed');
    assert.ok(row.paymentWorkflowStatus);
    assert.equal(row.vehicleCount, 2);
    assert.match(String(row.vehicleLabel), /2 vehicles|Honda|Tesla/i);
    assert.equal(row.assignedTechId, 'tech_9');
    assert.equal(row.assignedTechName, 'Jordan Tech');
    assert.equal(row.pendingChangeRequestCount, 1);
    assert.equal(row.customerChangePending, true);
    assert.equal(row.hasPendingVehicleRemoval, true);
    assert.equal(row.remainingCents, 48800);
    assert.equal(row.approvedCents, 68800);
    assert.equal(row.settledCents, 20000);
    assert.equal(row.confirmedDate, '2026-08-10');
  });

  it('list projector excludes heavy payloads', () => {
    const row = projectJobForAdminList(heavyBooking());
    assert.equal(row.eventLog, undefined);
    assert.equal(row.photos, undefined);
    assert.equal(row.photosBefore, undefined);
    assert.equal(row.photosAfter, undefined);
    assert.equal(row.changeRequests, undefined);
    assert.equal(row.pendingChangeRequests, undefined);
    assert.equal(row.vehicles, undefined);
    assert.equal(row.ledger, undefined);
    assert.equal(row.paymentAttempts, undefined);
    assert.equal(row.adminNotes, undefined);
    assert.equal(row.notes, undefined);
    assert.equal(row.customerNote, undefined);
    assert.equal(row.stripeCustomerId, undefined);
    assert.equal(row.paymentIntentId, undefined);
    assert.equal(row.portalToken, undefined);
    assert.equal(row.address, undefined);
    const keys = Object.keys(row);
    assert.ok(!keys.includes('eventLog'));
    assert.ok(!keys.includes('ledger'));
  });

  it('get_job full projector retains detail fields', () => {
    const full = projectJobForAdmin(heavyBooking());
    assert.equal(full._projection, 'admin_full');
    assert.ok(Array.isArray(full.eventLog) && full.eventLog.length >= 40);
    assert.ok(Array.isArray(full.vehicles) && full.vehicles.length === 2);
    assert.ok(Array.isArray(full.changeRequests) && full.changeRequests.length >= 1);
    assert.ok(Array.isArray(full.pendingChangeRequests));
    assert.equal(full.pendingChangeRequestCount, 1);
    assert.ok(full.photosBefore || full.address || full.adminNotes != null);
    assert.equal(full.remainingCents, 48800);
  });

  it('listJobs source uses lean projector; get_job keeps full', () => {
    const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/admin-ops-jobs.js'), 'utf8');
    const listStart = src.indexOf('async function listJobs');
    const listEnd = src.indexOf('async function persistMutation', listStart);
    const listFn = src.slice(listStart, listEnd > 0 ? listEnd : listStart + 8000);
    assert.match(listFn, /projectJobForAdminList/);
    assert.match(listFn, /listBookingMirrors/);
    assert.match(listFn, /hydrateJobsFromBlobs/);
    assert.doesNotMatch(listFn, /projectJobForAdmin\(/);
    assert.doesNotMatch(listFn, /buildAdminCustomerAccountSummary/);
    const hydrateStart = src.indexOf('async function hydrateJobsFromBlobs');
    const hydrateFn = src.slice(hydrateStart, listStart);
    assert.match(hydrateFn, /store\.get\(blob\.key/);
    assert.doesNotMatch(hydrateFn, /getWithMetadata\s*\(/);
    assert.doesNotMatch(hydrateFn, /consistency:\s*'strong'/);
    assert.match(src, /action === 'get_job'/);
    const getJobSlice = src.slice(src.indexOf("action === 'get_job'"), src.indexOf("action === 'get_job'") + 2500);
    assert.match(getJobSlice, /projectJobForAdmin\(/);
  });

  it('Admin UI prefers pendingChangeRequestCount and preserves open full detail on poll', () => {
    const html = fs.readFileSync(path.join(ROOT, 'admin-ops.html'), 'utf8');
    assert.match(html, /pendingChangeRequestCount/);
    assert.match(html, /_projection === 'admin_full'/);
    assert.match(html, /action:'get_job'|action:\s*'get_job'/);
    assert.match(html, /Intentionally do NOT call loadTechs\(\) here/);
    assert.match(html, /Open a job to load its full detail/);
    assert.match(html, /jobsClear[\s\S]{0,400}renderJobs\(\)/);
  });

  it('payload shrinks materially vs full projection (10 and 100 bookings)', () => {
    for (const n of [10, 100]) {
      const bookings = buildSyntheticBookings(n);
      const full = bookings.map((b) => projectJobForAdmin(b));
      const lean = bookings.map((b) => projectJobForAdminList(b));
      const fullBytes = Buffer.byteLength(JSON.stringify(full));
      const leanBytes = Buffer.byteLength(JSON.stringify(lean));
      const reduction = 1 - (leanBytes / fullBytes);
      assert.equal(lean.every((r) => r._projection === 'admin_list'), true);
      assert.equal(full.every((r) => r._projection === 'admin_full'), true);
      assert.ok(leanBytes < fullBytes * 0.45, 'expected >55% payload reduction, got ' + (reduction * 100).toFixed(1) + '%');
      assert.ok(!JSON.stringify(lean).includes('"eventLog"'));
      assert.ok(!JSON.stringify(lean).includes('"photosBefore"'));
      assert.ok(!JSON.stringify(lean).includes('"changeRequests"'));
      assert.ok(!JSON.stringify(lean).includes('"ledger"'));
    }
  });

  it('vehicle-removal pending count remains visible without embedding request bodies', () => {
    const row = projectJobForAdminList(heavyBooking());
    assert.equal(row.pendingChangeRequestCount, 1);
    assert.equal(row.hasPendingVehicleRemoval, true);
    assert.equal(row.changeRequests, undefined);
  });
});
