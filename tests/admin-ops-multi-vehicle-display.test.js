/**
 * Admin Ops multi-vehicle projection + Jobs Board summary display.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const {
  projectJobForAdmin,
  projectVehiclesForAdmin,
  projectVehicleForAdmin,
} = require('../netlify/lib/ops-workflow');

const adminOps = read('admin-ops.html');

function twoVehicleBooking() {
  return {
    id: 'CD1-ADMIN-MULTI',
    firstName: 'Alex',
    lastName: 'Rivera',
    phone: '555-0100',
    email: 'alex@example.com',
    status: 'Confirmed',
    jobStatus: 'confirmed',
    appointmentStatus: 'confirmed',
    bookingVersion: 3,
    quoteVersion: 2,
    zipCode: '07102',
    package: 'Maintenance Detail',
    packageId: 'maint',
    vehicleLabel: '2020 Honda Civic',
    vehicleYear: '2020',
    vehicleMake: 'Honda',
    vehicleModel: 'Civic',
    vehicleCategory: 'cars',
    approvedFinalAmount: 400,
    totalPrice: 400,
    amountPaid: 0,
    ledger: {
      currency: 'usd',
      approvedCents: 40000,
      settledCents: 0,
      creditedCents: 0,
      entries: [],
    },
    quote: { quoteVersion: 2, approvedCents: 40000 },
    addons: [{ id: 'odor', name: 'Odor Elimination', qty: 1, price: 75 }],
    vehicles: [
      {
        vehicleId: 'veh_primary',
        year: '2020',
        make: 'Honda',
        model: 'Civic',
        vehicleLabel: '2020 Honda Civic',
        category: 'cars',
        cat: 'cars',
        packageId: 'maint',
        pkgId: 'maint',
        pkgName: 'Maintenance Detail',
        tierKey: 'small',
        tierLabel: 'Sedan / small car',
        basePrice: 175,
        addonTotal: 75,
        subtotal: 250,
        addons: [{ id: 'odor', name: 'Odor Elimination', qty: 1, price: 75 }],
      },
      {
        vehicleId: 'veh_second',
        year: '2018',
        make: 'Toyota',
        model: 'RAV4',
        vehicleLabel: '2018 Toyota RAV4',
        category: 'cars',
        cat: 'cars',
        packageId: 'full',
        pkgId: 'full',
        pkgName: 'Premium Full Detail',
        tierKey: 'suv2',
        tierLabel: 'Mid-size SUV',
        basePrice: 150,
        addonTotal: 0,
        subtotal: 150,
        addons: [],
      },
    ],
    service: {
      vehicles: [
        {
          vehicleId: 'veh_primary',
          year: '2020',
          make: 'Honda',
          model: 'Civic',
          vehicleLabel: '2020 Honda Civic',
          category: 'cars',
          packageId: 'maint',
          pkgId: 'maint',
          pkgName: 'Maintenance Detail',
          tierKey: 'small',
          basePrice: 175,
          addonTotal: 75,
          subtotal: 250,
          addons: [{ id: 'odor', name: 'Odor Elimination', qty: 1, price: 75 }],
        },
        {
          vehicleId: 'veh_second',
          year: '2018',
          make: 'Toyota',
          model: 'RAV4',
          vehicleLabel: '2018 Toyota RAV4',
          category: 'cars',
          packageId: 'full',
          pkgId: 'full',
          pkgName: 'Premium Full Detail',
          tierKey: 'suv2',
          basePrice: 150,
          addonTotal: 0,
          subtotal: 150,
          addons: [],
        },
      ],
    },
  };
}

describe('projectJobForAdmin multi-vehicle projection', () => {
  it('returns two complete vehicles with identity, package, prices, add-ons, subtotals', () => {
    const p = projectJobForAdmin(twoVehicleBooking());
    assert.equal(p.vehicles.length, 2);

    const v0 = p.vehicles[0];
    const v1 = p.vehicles[1];
    assert.equal(v0.vehicleId, 'veh_primary');
    assert.equal(v1.vehicleId, 'veh_second');
    assert.equal(v0.year, '2020');
    assert.equal(v0.make, 'Honda');
    assert.equal(v0.model, 'Civic');
    assert.equal(v0.vehicleLabel, '2020 Honda Civic');
    assert.equal(v0.category, 'cars');
    assert.equal(v0.packageId, 'maint');
    assert.equal(v0.packageName, 'Maintenance Detail');
    assert.equal(v0.pkgName, 'Maintenance Detail');
    assert.equal(v0.tierKey, 'small');
    assert.ok(v0.tierLabel === 'Sedan / small car' || v0.tier === 'small' || v0.tierKey === 'small');
    assert.equal(v0.basePrice, 175);
    assert.equal(v0.packagePrice, 175);
    assert.equal(v0.subtotal, 250);
    assert.equal(v0.addons.length, 1);
    assert.equal(v0.addons[0].name, 'Odor Elimination');
    assert.equal(v0.addons[0].qty, 1);
    assert.equal(v0.addons[0].price, 75);

    assert.equal(v1.packageId, 'full');
    assert.equal(v1.packageName, 'Premium Full Detail');
    assert.equal(v1.basePrice, 150);
    assert.equal(v1.subtotal, 150);
    assert.equal(v1.addons.length, 0);

    // Booking-level money remains server-authoritative (cents + dollars)
    assert.equal(p.approvedFinalAmount, 400);
    assert.equal(p.approvedCents, 40000);
    assert.equal(p.remainingCents, 40000);
    assert.equal(p.quoteVersion, 2);

    // Primary-vehicle compatibility fields preserved
    assert.equal(p.vehicleLabel, '2020 Honda Civic');
    assert.equal(p.vehicleMake, 'Honda');
    assert.equal(p.packageId, 'maint');
  });

  it('does not expose raw ledger entries or full Stripe payment intent IDs on vehicles', () => {
    const raw = twoVehicleBooking();
    raw.paymentIntentId = 'pi_secret_full_id_abc123';
    raw.stripeCustomerId = 'cus_secret';
    const p = projectJobForAdmin(raw);
    for (const v of p.vehicles) {
      assert.equal(v.ledger, undefined);
      assert.equal(v.paymentIntentId, undefined);
      assert.equal(v.stripeCustomerId, undefined);
      assert.equal(v.entries, undefined);
    }
    // Vehicle money stays in dollars — no *Cents mix on vehicle rows
    assert.equal(p.vehicles[0].basePriceCents, undefined);
    assert.equal(typeof p.vehicles[0].basePrice, 'number');
  });

  it('reads service.vehicles when top-level vehicles is empty', () => {
    const raw = twoVehicleBooking();
    raw.vehicles = [];
    const vehs = projectVehiclesForAdmin(raw);
    assert.equal(vehs.length, 2);
    assert.equal(vehs[1].vehicleId, 'veh_second');
    assert.equal(vehs[1].subtotal, 150);
  });

  it('preserves single-vehicle bookings', () => {
    const p = projectJobForAdmin({
      id: 'CD1-ADMIN-ONE',
      status: 'Confirmed',
      jobStatus: 'confirmed',
      package: 'Maintenance Detail',
      packageId: 'maint',
      vehicleLabel: '2021 Mazda 3',
      vehicleYear: '2021',
      vehicleMake: 'Mazda',
      vehicleModel: '3',
      vehicleCategory: 'cars',
      approvedFinalAmount: 175,
      totalPrice: 175,
      ledger: { approvedCents: 17500, settledCents: 0, creditedCents: 0, entries: [] },
      vehicles: [{
        vehicleId: 'veh_only',
        year: '2021',
        make: 'Mazda',
        model: '3',
        vehicleLabel: '2021 Mazda 3',
        category: 'cars',
        packageId: 'maint',
        pkgName: 'Maintenance Detail',
        basePrice: 175,
        addonTotal: 0,
        subtotal: 175,
        addons: [],
      }],
    });
    assert.equal(p.vehicles.length, 1);
    assert.equal(p.vehicles[0].vehicleLabel, '2021 Mazda 3');
    assert.equal(p.vehicles[0].subtotal, 175);
    assert.equal(p.approvedCents, 17500);
  });

  it('falls back to legacy primary vehicle when vehicles[] is missing', () => {
    const p = projectJobForAdmin({
      id: 'CD1-ADMIN-LEGACY',
      status: 'Confirmed',
      package: 'Maintenance Detail',
      packageId: 'maint',
      vehicleYear: '2019',
      vehicleMake: 'Ford',
      vehicleModel: 'Focus',
      vehicleLabel: '2019 Ford Focus',
      vehicleCategory: 'cars',
      totalPrice: 175,
      approvedFinalAmount: 175,
      addons: [{ id: 'odor', name: 'Odor', qty: 1, price: 75 }],
    });
    assert.ok(Array.isArray(p.vehicles));
    assert.equal(p.vehicles.length, 1);
    assert.equal(p.vehicles[0].make, 'Ford');
    assert.equal(p.vehicles[0].vehicleLabel, '2019 Ford Focus');
    assert.equal(p.vehicles[0].packageName, 'Maintenance Detail');
    assert.equal(p.vehicleMake, 'Ford');
    assert.equal(p.approvedFinalAmount, 175);
  });

  it('projects RV/boat length vehicles without requiring year/make/model', () => {
    const vehs = projectVehiclesForAdmin({
      id: 'CD1-ADMIN-RV',
      status: 'Confirmed',
      totalPrice: 538,
      approvedFinalAmount: 538,
      ledger: { approvedCents: 53800, settledCents: 0, creditedCents: 0, entries: [] },
      service: {
        vehicles: [{
          vehicleId: 'veh_rv',
          category: 'rvs',
          cat: 'rvs',
          vehicleLabel: 'Travel trailer',
          lengthFt: 28,
          packageId: 'full_basic',
          pkgId: 'full_basic',
          pkgName: 'RV Full Detail',
          tierKey: 'travel',
          basePrice: 538,
          addonTotal: 0,
          subtotal: 538,
          addons: [],
        }],
      },
    });
    assert.equal(vehs.length, 1);
    assert.equal(vehs[0].year, '');
    assert.equal(vehs[0].make, '');
    assert.equal(vehs[0].lengthFt, 28);
    assert.equal(vehs[0].pkgName, 'RV Full Detail');
    assert.equal(vehs[0].subtotal, 538);
  });

  it('projectVehicleForAdmin matches customer portal dollar units', () => {
    const v = projectVehicleForAdmin({
      vehicleId: 'v1',
      year: '2020',
      make: 'Honda',
      model: 'Civic',
      packageId: 'maint',
      pkgName: 'Maintenance Detail',
      basePrice: 175,
      addonTotal: 75,
      subtotal: 250,
      addons: [{ id: 'odor', name: 'Odor', qty: 2, price: 37.5 }],
    });
    assert.equal(v.basePrice, 175);
    assert.equal(v.packagePrice, 175);
    assert.equal(v.subtotal, 250);
    assert.equal(v.addons[0].qty, 2);
    assert.equal(v.addons[0].price, 37.5);
  });
});

describe('Admin Ops Jobs Board multi-vehicle summary + search', () => {
  it('jobsVehicleSummary shows N vehicles for multi-vehicle jobs', () => {
    assert.match(adminOps, /function jobsVehicleSummary\(/);
    assert.match(adminOps, /vehs\.length \+ ' vehicles'/);
    assert.match(adminOps, /function vehicleSearchHaystack\(/);
  });

  it('filterJobs includes secondary vehicle labels in search haystack', () => {
    assert.match(adminOps, /vehicleSearchHaystack\(j\)/);
    assert.match(adminOps, /v\.vehicleLabel/);
    assert.match(adminOps, /v\.year, v\.make, v\.model/);
  });

  it('renderJobs uses jobsVehicleSummary instead of only primary vehicle', () => {
    assert.match(adminOps, /jobsVehicleSummary\(j\)/);
    const renderStart = adminOps.indexOf('function renderJobs()');
    const renderEnd = adminOps.indexOf('function renderAssign()');
    assert.ok(renderStart > 0 && renderEnd > renderStart);
    const renderBody = adminOps.slice(renderStart, renderEnd);
    assert.match(renderBody, /jobsVehicleSummary\(j\)/);
    assert.doesNotMatch(renderBody, /j\.vehicleLabel\|\|j\.vehicle\|\|'—'/);
  });

  it('inline script still parses after multi-vehicle summary helpers', () => {
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

describe('Admin Ops inline expandable job details', () => {
  const FORMER_DRAWER_ACTIONS = [
    'dFirst', 'dLast', 'dPhone', 'dEmail', 'dSaveCustomer', 'dVehicle', 'dPackage', 'dSaveService',
    'dAssign', 'dCancelYes', 'dCancelNo', 'dApplyResched', 'dApplyAddr', 'dConfirm', 'dCancel',
    'dReopenAppt', 'dArchive', 'dTechEnRoute', 'dTechStart', 'dTechPause', 'dTechResume', 'dTechComplete',
    'dDate', 'dTime', 'dResched', 'dAddr', 'dZip', 'dSaveAddr', 'dOfferApply', 'dOfferRemove',
    'dFinalAmt', 'dTechPay', 'dSaveBal', 'dPostAuc', 'dAssignWin', 'dAddonSec', 'dPkgSec',
    'dPayPref', 'dSavePref', 'dPayLink', 'dManualPayRef', 'dGenPayLink', 'dReconcileStripe',
    'dCopyPayLink', 'dSetPayLink', 'dChargeNoShow', 'dChargeLateCancel', 'dRefundNote', 'dRefundAmt',
    'dRefund', 'dMarkRefunded', 'dMarkCash', 'dMarkCardSite', 'dApproveAdj', 'dRejectAdj',
    'dGenCompletion', 'dGenGarage', 'dCopyCustomerLink', 'dAuditSec', 'dNote', 'dSaveNote', 'dClose',
  ];

  it('uses one reusable activeJobDetailRow, not per-job detail forms', () => {
    assert.match(adminOps, /id="activeJobDetailRow"/);
    assert.match(adminOps, /id="activeJobDetailPanel"/);
    assert.match(adminOps, /function placeActiveDetailRow\(/);
    assert.match(adminOps, /function parkActiveDetailRow\(/);
    assert.match(adminOps, /let expandedJobId = null/);
    assert.equal((adminOps.match(/id="activeJobDetailRow"/g) || []).length, 1);
    assert.equal((adminOps.match(/id="dSaveNote"/g) || []).length, 1);
    assert.equal((adminOps.match(/id="dBody"/g) || []).length, 1);
  });

  it('jobs board no longer depends on side drawer backdrop', () => {
    assert.doesNotMatch(adminOps, /id="drawerBg"/);
    assert.doesNotMatch(adminOps, /id="drawer"/);
    assert.doesNotMatch(adminOps, /\$\('#drawerBg'\)/);
    assert.match(adminOps, /id="techDrawer"/);
    assert.match(adminOps, /job-detail-panel/);
    assert.match(adminOps, /job-detail-grid/);
  });

  it('summary row has chevron, balance, and expandable interaction', () => {
    assert.match(adminOps, /class="job-chevron"/);
    assert.match(adminOps, /aria-controls="activeJobDetailPanel"/);
    assert.match(adminOps, /jobsBalanceLabel\(j\)/);
    assert.match(adminOps, /function toggleJobExpand\(/);
    assert.match(adminOps, /function isInteractiveToggleTarget\(/);
    assert.match(adminOps, /e\.key !== 'Enter' && e\.key !== ' '/);
    assert.match(adminOps, /button, a, input, textarea, select/);
  });

  it('same job toggles closed; only one expansion tracked', () => {
    assert.match(adminOps, /if \(expandedJobId === jobId\) \{\s*collapseJobDetail\(\);/);
    assert.match(adminOps, /function collapseJobDetail\(/);
    assert.match(adminOps, /expandedJobId = id/);
  });

  it('renders vehicles section with package, add-ons, and server subtotals', () => {
    assert.match(adminOps, /function renderVehiclesDetailSection\(/);
    assert.match(adminOps, /Vehicles and services/);
    assert.match(adminOps, /Vehicle subtotal/);
    assert.match(adminOps, /fmtServerDollars\(v\.subtotal\)/);
    assert.match(adminOps, /v\.packageName \|\| v\.pkgName/);
    assert.match(adminOps, /a && a\.price/);
  });

  it('keeps approved/paid/remaining from server projection fields', () => {
    assert.match(adminOps, /j\.remainingCents/);
    assert.match(adminOps, /j\.approvedFinalAmount/);
    assert.match(adminOps, /j\.amountPaid/);
    assert.doesNotMatch(adminOps, /approvedFinalAmount\s*=\s*[^=].*\+.*basePrice/);
    assert.doesNotMatch(adminOps, /remainingCents\s*=\s*[^=].*basePrice/);
  });

  it('panel stays open after mutation refresh via expandedJobId', () => {
    assert.match(adminOps, /if \(expandedJobId === bookingId \|\| \(activeJob && activeJob\.id === bookingId\)\)/);
    assert.match(adminOps, /await openDrawer\(bookingId\)/);
    assert.match(adminOps, /action === 'archive_test' && expandedJobId === bookingId/);
  });

  it('escapes attribute-breaking quotes in customer and vehicle text', () => {
    assert.match(adminOps, /replace\(\/"\/g,\s*'&quot;'\)/);
    assert.match(adminOps, /replace\(\/'\/g,\s*'&#39;'\)/);
  });

  it('every former drawer action id remains reachable', () => {
    for (const id of FORMER_DRAWER_ACTIONS) {
      assert.match(adminOps, new RegExp('id="' + id + '"|' + id + '\\b'), `missing control ${id}`);
    }
    assert.match(adminOps, /jobAction\(j\.id,'update_customer'/);
    assert.match(adminOps, /jobAction\(j\.id,'update_service'/);
    assert.match(adminOps, /jobAction\(j\.id,'update_address'/);
    assert.match(adminOps, /jobAction\(j\.id,'reschedule'/);
    assert.match(adminOps, /jobAction\(activeJob\.id,'admin_note'/);
    assert.match(adminOps, /jobAction\(j\.id,'mark_cash_received'/);
    assert.match(adminOps, /action:\s*'change_package'/);
    assert.match(adminOps, /renderAddonSection/);
    assert.match(adminOps, /bindAddonSection/);
    assert.match(adminOps, /renderPackageSection/);
    assert.match(adminOps, /bindPackageSection/);
  });

  it('does not create duplicate fixed control IDs', () => {
    for (const id of ['dTitle', 'dBody', 'dNote', 'dSaveNote', 'dClose', 'activeJobDetailPanel']) {
      const re = new RegExp('id="' + id + '"', 'g');
      assert.equal((adminOps.match(re) || []).length, 1, `duplicate id ${id}`);
    }
  });

  it('openDrawer still used so other boards and tests keep feature parity entrypoint', () => {
    assert.match(adminOps, /async function openDrawer\(/);
    assert.match(adminOps, /openDrawer\(j\.id\)/);
    assert.match(adminOps, /ensureJobsTab\(/);
  });
});
