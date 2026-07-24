/**
 * Customer Portal multi-vehicle itemization — projection + UI regression.
 */
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const { projectBookingForCustomer } = require('../netlify/lib/ops-schema');

const myGarageJs = read('assets/my-garage.js');
const myGarageHtml = read('my-garage.html');

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

/** Brace-aware function extractor from my-garage.js */
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} must exist`);
  let i = src.indexOf('{', start);
  assert.ok(i >= 0, `function ${name} body`);
  let depth = 0;
  for (; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed function ${name}`);
}

function buildRenderSandbox() {
  const ctx = {};
  vm.createContext(ctx);
  for (const name of [
    'esc',
    'fmtMoney',
    'hasUsableVehicleProjection',
    'projectedVehicleLabel',
    'safeMoneyOrNull',
    'renderVehicleBreakdownHtml',
    'vehicleLine',
    'addonLines',
  ]) {
    vm.runInContext(extractFn(myGarageJs, name), ctx);
  }
  return ctx;
}

function twoVehicleBooking() {
  return {
    id: 'CD1-MULTI-VEH',
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
          cat: 'cars',
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
          cat: 'cars',
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

describe('projectBookingForCustomer multi-vehicle itemization', () => {
  it('projects both vehicles with identity, package, prices, add-ons, subtotals', () => {
    const p = projectBookingForCustomer(twoVehicleBooking());
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
    assert.equal(v0.pkgName, 'Maintenance Detail');
    assert.equal(v0.packageName, 'Maintenance Detail');
    assert.equal(v0.tierKey, 'small');
    assert.equal(v0.basePrice, 175);
    assert.equal(v0.packagePrice, 175);
    assert.equal(v0.subtotal, 250);
    assert.equal(v0.addons.length, 1);
    assert.equal(v0.addons[0].name, 'Odor Elimination');
    assert.equal(v0.addons[0].qty, 1);
    assert.equal(v0.addons[0].price, 75);

    assert.equal(v1.packageId, 'full');
    assert.equal(v1.pkgName, 'Premium Full Detail');
    assert.equal(v1.basePrice, 150);
    assert.equal(v1.subtotal, 150);
    assert.equal(v1.addons.length, 0);

    // Booking-level money remains dollars for legacy + cents from ledger
    assert.equal(p.approvedFinalAmount, 400);
    assert.equal(p.approvedCents, 40000);
    assert.equal(p.quoteVersion, 2);
  });

  it('reads service.vehicles when top-level vehicles is empty', () => {
    const raw = twoVehicleBooking();
    raw.vehicles = [];
    const p = projectBookingForCustomer(raw);
    assert.equal(p.vehicles.length, 2);
    assert.equal(p.vehicles[1].vehicleId, 'veh_second');
    assert.equal(p.vehicles[1].subtotal, 150);
  });

  it('preserves legacy single-vehicle top-level fields without crashing', () => {
    const p = projectBookingForCustomer({
      id: 'CD1-LEGACY',
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
    assert.equal(p.vehicleMake, 'Ford');
    assert.equal(p.package, 'Maintenance Detail');
    assert.ok(Array.isArray(p.vehicles));
    assert.equal(p.approvedFinalAmount, 175);
  });

  it('projects RV/boat length vehicles without requiring year/make/model', () => {
    const p = projectBookingForCustomer({
      id: 'CD1-RV',
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
    assert.equal(p.vehicles.length, 1);
    assert.equal(p.vehicles[0].year, '');
    assert.equal(p.vehicles[0].make, '');
    assert.equal(p.vehicles[0].lengthFt, 28);
    assert.equal(p.vehicles[0].pkgName, 'RV Full Detail');
    assert.equal(p.vehicles[0].subtotal, 538);
  });
});

describe('vehicle_add_request then customer projection', () => {
  let setBookingStoreOverride;

  beforeEach(() => {
    ({ setBookingStoreOverride } = require('../netlify/lib/booking-repository'));
  });

  afterEach(() => {
    setBookingStoreOverride(null);
  });

  it('keeps two distinct vehicles after add + project', async () => {
    const {
      submitChangeRequestCommand,
      decideChangeRequestCommand,
    } = require('../netlify/lib/booking-commands');
    const { getBookingRecord } = require('../netlify/lib/booking-repository');
    const bookingId = `CD1-VADD-${Date.now().toString(36)}`;

    const store = createMemoryStore({
      [bookingId]: {
        id: bookingId,
        bookingVersion: 1,
        quoteVersion: 1,
        status: 'Confirmed',
        appointmentStatus: 'confirmed',
        jobStatus: 'confirmed',
        zipCode: '07102',
        travelFeeAmount: 0,
        ledger: { approvedCents: 17500, settledCents: 0, creditedCents: 0, entries: [] },
        quote: { quoteVersion: 1, approvedCents: 17500 },
        vehicles: [{
          vehicleId: 'veh_1',
          category: 'cars',
          cat: 'cars',
          tierKey: 'small',
          packageId: 'maint',
          pkgId: 'maint',
          pkgName: 'Maintenance Detail',
          year: '2020',
          make: 'Honda',
          model: 'Civic',
          vehicleLabel: '2020 Honda Civic',
          addOnIds: [],
          addons: [],
        }],
        service: {
          vehicles: [{
            vehicleId: 'veh_1',
            category: 'cars',
            cat: 'cars',
            tierKey: 'small',
            packageId: 'maint',
            pkgId: 'maint',
            pkgName: 'Maintenance Detail',
            year: '2020',
            make: 'Honda',
            model: 'Civic',
            vehicleLabel: '2020 Honda Civic',
            addOnIds: [],
            addons: [],
          }],
        },
        changeRequests: [],
      },
    });
    setBookingStoreOverride(store);

    const submitted = await submitChangeRequestCommand({
      bookingId,
      expectedBookingVersion: 1,
      requestType: 'vehicle_add_request',
      delta: {
        category: 'cars',
        vehicleCategory: 'cars',
        year: '2018',
        make: 'Toyota',
        model: 'RAV4',
        vehicleLabel: '2018 Toyota RAV4',
        packageId: 'full',
        packageName: 'Premium Full Detail',
        tierKey: 'suv2',
      },
    });
    assert.equal(submitted.ok, true, submitted.error);

    const decided = await decideChangeRequestCommand({
      bookingId,
      requestId: submitted.changeRequest.requestId,
      decision: 'approve',
      expectedBookingVersion: submitted.booking.bookingVersion,
      acceptRequote: true,
    });
    assert.equal(decided.ok, true, `${decided.error} ${decided.message || ''}`);

    const final = await getBookingRecord(bookingId);
    const booking = final.booking;
    assert.ok(Array.isArray(booking.service.vehicles));
    assert.equal(booking.service.vehicles.length, 2, 'second vehicle must remain on service.vehicles');

    const projected = projectBookingForCustomer(booking);
    assert.equal(projected.vehicles.length, 2);
    assert.notEqual(projected.vehicles[0].vehicleId, projected.vehicles[1].vehicleId);
    assert.ok(projected.vehicles.some((v) => /RAV4|Toyota/i.test(v.vehicleLabel || `${v.make} ${v.model}`)));
    assert.ok(projected.vehicles.every((v) => v.packageId || v.pkgId));
    assert.ok(projected.vehicles.every((v) => Number(v.basePrice) > 0 || Number(v.subtotal) > 0));
    assert.ok(Number(projected.approvedCents) > 17500);
    assert.ok(Number(projected.quoteVersion) >= 2);
    // Newly added vehicle must not collapse into vehicles[0]
    assert.equal(projected.vehicles[0].vehicleId, 'veh_1');
    assert.notEqual(projected.vehicles[1].vehicleId, 'veh_1');
  });
});

describe('Customer UI vehicle itemization rendering', () => {
  it('renders both vehicle sections with packages, add-ons, and subtotals', () => {
    const ctx = buildRenderSandbox();
    const projected = projectBookingForCustomer(twoVehicleBooking());
    const html = vm.runInContext(
      `renderVehicleBreakdownHtml(${JSON.stringify(projected)})`,
      ctx
    );
    assert.match(html, /vehicle-breakdown/g);
    assert.equal((html.match(/class="vehicle-breakdown"/g) || []).length, 2);
    assert.match(html, /2020 Honda Civic/);
    assert.match(html, /2018 Toyota RAV4/);
    assert.match(html, /Maintenance Detail/);
    assert.match(html, /Premium Full Detail/);
    assert.match(html, /Odor Elimination/);
    assert.match(html, /\$175\.00/);
    assert.match(html, /\$250\.00/);
    assert.match(html, /\$150\.00/);
    assert.match(html, /Vehicle subtotal/);
  });

  it('falls back when vehicles[] is empty (legacy primary fields)', () => {
    const ctx = buildRenderSandbox();
    const legacy = {
      vehicleYear: '2019',
      vehicleMake: 'Ford',
      vehicleModel: 'Focus',
      vehicleCategory: 'cars',
      addons: [{ name: 'Odor', price: 75 }],
      vehicles: [],
    };
    const breakdown = vm.runInContext(
      `renderVehicleBreakdownHtml(${JSON.stringify(legacy)})`,
      ctx
    );
    assert.equal(breakdown, '');
    const usable = vm.runInContext(
      `hasUsableVehicleProjection(${JSON.stringify(legacy)})`,
      ctx
    );
    assert.equal(usable, false);
    const line = vm.runInContext(`vehicleLine(${JSON.stringify(legacy)})`, ctx);
    assert.match(line, /2019 Ford Focus/);
  });

  it('renders length-based vehicles without year/make/model', () => {
    const ctx = buildRenderSandbox();
    const booking = {
      vehicles: [{
        vehicleId: 'veh_boat',
        vehicleLabel: 'Center console',
        category: 'boats',
        lengthFt: 22,
        pkgName: 'Boat Detail',
        basePrice: 400,
        subtotal: 400,
        addons: [],
      }],
    };
    const html = vm.runInContext(
      `renderVehicleBreakdownHtml(${JSON.stringify(booking)})`,
      ctx
    );
    assert.match(html, /Center console/);
    assert.match(html, /22 ft/);
    assert.match(html, /Boat Detail/);
    assert.doesNotMatch(html, /undefined|NaN/);
  });

  it('escapes make/model/package/add-on display text', () => {
    const ctx = buildRenderSandbox();
    const booking = {
      vehicles: [{
        vehicleId: 'veh_x',
        year: '2021',
        make: '<img src=x onerror=alert(1)>',
        model: 'Model</dd>',
        pkgName: '<script>alert(1)</script>',
        basePrice: 100,
        subtotal: 175,
        addons: [{ name: 'Addon<script>', qty: 2, price: 75 }],
      }],
    };
    const html = vm.runInContext(
      `renderVehicleBreakdownHtml(${JSON.stringify(booking)})`,
      ctx
    );
    assert.doesNotMatch(html, /<img src=x/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;img src=x/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /Addon&lt;script&gt;/);
    assert.match(html, /× 2/);
  });

  it('dashboard wiring iterates vehicles and keeps server payment totals', () => {
    assert.match(myGarageJs, /function renderVehicleBreakdownHtml/);
    assert.match(myGarageJs, /function hasUsableVehicleProjection/);
    assert.match(myGarageJs, /vehicleSections = renderVehicleBreakdownHtml/);
    assert.match(myGarageJs, /booking-financial-summary/);
    assert.match(myGarageJs, /approvedCentsFromPayment\(pay\)/);
    assert.match(myGarageJs, /settledCentsFromPayment\(pay\)/);
    assert.match(myGarageJs, /remainingCentsFromPayment\(pay\)/);
    // No client catalog pricing inside the breakdown helper
    const start = myGarageJs.indexOf('function renderVehicleBreakdownHtml');
    const end = myGarageJs.indexOf('function normalizePackageCategory');
    const breakdownSrc = myGarageJs.slice(start, end > start ? end : start + 2500);
    assert.doesNotMatch(breakdownSrc, /getCatalog\(|estimateLengthPrice\(|packagesForBooking\(/);
    // Post vehicle-add refresh still full re-fetch
    assert.match(myGarageJs, /vehicle_add_request[\s\S]{0,800}?loadAccount\(\)|loadLimited/);
    assert.match(myGarageJs, /if \(state\.scope === 'account'\) await loadAccount\(\);\s*else await loadLimited/);
  });

  it('cache-busts my-garage.js for Production browsers', () => {
    assert.match(myGarageHtml, /my-garage\.js\?v=20260723-vehicles5/);
  });
});
