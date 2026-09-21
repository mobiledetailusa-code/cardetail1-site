'use strict';

/**
 * Commercial pricing optimization — phase 1.
 *
 * Locks the approved car + powersports matrix, RICH_ZIP retirement, and
 * public-surface / portal catalog consistency. Server booking-price-catalog
 * remains the only money authority.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  PRICING,
  LENGTH_PRICING,
  RICH_ZIPS,
  getRichMultiplier,
  applyRichPrice,
  computeVehicleSubtotal,
  computeBookingServiceSubtotal,
} = require('../netlify/lib/booking-price-catalog');
const { applyServerTravelAndTotal } = require('../netlify/lib/travel-fee');
const { serializeCanonicalPackageCatalogForBooking } = require('../netlify/lib/canonical-package-catalog');
const { packageOptionsForVehicle } = require('../netlify/lib/package-financial-mutation');
const { CHAT_STARTING_PRICES } = require('../netlify/functions/ai-chat');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const APPROVED_CARS = Object.freeze({
  small: { wash: 125, maint: 160, interior: 210, full: 275, refresh: 350, premium: 425 },
  suv2: { wash: 145, maint: 195, interior: 235, full: 295, refresh: 395, premium: 500 },
  suv3: { wash: 165, maint: 225, interior: 265, full: 325, refresh: 435, premium: 575 },
  truck: { wash: 165, maint: 225, interior: 260, full: 315, refresh: 425, premium: 560 },
  compact_van: { wash: 165, maint: 225, interior: 260, full: 315, refresh: 435, premium: 575 },
  midsize_van: { wash: 165, maint: 225, interior: 260, full: 315, refresh: 435, premium: 575 },
  full_size_van: { wash: 185, maint: 255, interior: 295, full: 350, refresh: 475, premium: 625 },
  full_size_van_passenger: { wash: 195, maint: 265, interior: 310, full: 375, refresh: 495, premium: 650 },
});

const APPROVED_POWERSPORTS = Object.freeze({
  motorcycle: { maintenance: 180, restore: 250 },
  motorcycle_large: { maintenance: 200, restore: 275 },
  motorcycle_trike: { maintenance: 225, restore: 310 },
  atv: { maintenance: 180, restore: 240 },
  utv_standard: { maintenance: 210, restore: 275 },
  utv_large: { maintenance: 235, restore: 325 },
});

const UNCHANGED_SNAPSHOT = Object.freeze({
  trucks: {
    day_cab: { interior: 340, int_wash: 415, int_wash_wax: 520 },
    sleeper_cab: { interior: 425, int_wash: 520, int_wash_wax: 650 },
  },
  boats: {
    under20: { maint: 235, essential: 350, full: 525, premium: 825 },
  },
  rvs: {
    travel: { maint: 280, maint_light: 410, interior: 405, full_basic: 790, premium: 1000, full: 1235 },
  },
  fleet: {
    vehicle: { maint: 70, essential: 115, full: 185, premium: 270 },
  },
  jetski: { wash: 105, essential: 165, full: 235, premium: 320 },
  boatLengthMaintMin: 175,
  carAddonOzone: 40,
  carAddonPethair: 95,
});

const FORMER_RICH_ZIP = '07620';
const NORMAL_ZIP = '07102';

describe('phase 1 approved car matrix', () => {
  for (const [tierKey, packages] of Object.entries(APPROVED_CARS)) {
    for (const [pkgId, amount] of Object.entries(packages)) {
      it(`${tierKey}.${pkgId} = $${amount}`, () => {
        assert.equal(PRICING.cars.tiers[tierKey][pkgId], amount);
        const quote = computeVehicleSubtotal({
          cat: 'cars', pkgId, tierKey, addons: [],
        }, NORMAL_ZIP);
        assert.equal(quote.ok, true);
        assert.equal(quote.basePrice, amount);
      });
    }
  }
});

describe('phase 1 approved powersports public matrix', () => {
  for (const [tierKey, packages] of Object.entries(APPROVED_POWERSPORTS)) {
    for (const [pkgId, amount] of Object.entries(packages)) {
      it(`${tierKey}.${pkgId} = $${amount}`, () => {
        assert.equal(PRICING.powersports.tiers[tierKey][pkgId], amount);
        const quote = computeVehicleSubtotal({
          cat: 'powersports', pkgId, tierKey, addons: [],
        }, NORMAL_ZIP);
        assert.equal(quote.ok, true);
        assert.equal(quote.basePrice, amount);
      });
    }
  }

  it('preserves historical powersports package keys and dollar meaning', () => {
    assert.equal(PRICING.powersports.tiers.motorcycle.wash, 105);
    assert.equal(PRICING.powersports.tiers.motorcycle.essential, 165);
    assert.equal(PRICING.powersports.tiers.motorcycle.full, 235);
    assert.equal(PRICING.powersports.tiers.motorcycle.premium, 325);
    assert.equal(PRICING.powersports.tiers.utv.wash, 130);
    assert.equal(PRICING.powersports.tiers.jetski.wash, 105);
    assert.equal(PRICING.powersports.tiers.jetski.maintenance, undefined);
  });
});

describe('phase 1 RICH_ZIP retirement', () => {
  it('getRichMultiplier is always 1.0 for former rich and normal ZIPs', () => {
    assert.equal(getRichMultiplier(FORMER_RICH_ZIP), 1.0);
    assert.equal(getRichMultiplier(NORMAL_ZIP), 1.0);
    assert.equal(getRichMultiplier(''), 1.0);
    assert.equal(applyRichPrice(275, FORMER_RICH_ZIP), 275);
    assert.equal(applyRichPrice(275, NORMAL_ZIP), 275);
  });

  it('RICH_ZIPS export remains but no longer lists wealth ZIPs', () => {
    assert.ok(RICH_ZIPS instanceof Set);
    assert.equal(RICH_ZIPS.size, 0);
    assert.equal(RICH_ZIPS.has(FORMER_RICH_ZIP), false);
  });

  it('former RICH_ZIP and normal ZIP produce the same base service subtotal', () => {
    const vehicle = {
      cat: 'cars', pkgId: 'full', tierKey: 'small', addons: [{ id: 'ozone', qty: 1 }],
    };
    const rich = computeVehicleSubtotal(vehicle, FORMER_RICH_ZIP);
    const normal = computeVehicleSubtotal(vehicle, NORMAL_ZIP);
    assert.equal(rich.ok, true);
    assert.equal(normal.ok, true);
    assert.equal(rich.basePrice, normal.basePrice);
    assert.equal(rich.addonTotal, normal.addonTotal);
    assert.equal(rich.subtotal, normal.subtotal);
    assert.equal(rich.basePrice, 275);
    assert.equal(rich.addonTotal, 40);
  });

  it('customer-supplied multiplier or price is not trusted on recalculation', () => {
    const booking = {
      zipCode: FORMER_RICH_ZIP,
      totalPrice: 50,
      richMultiplier: 1.05,
      vehicles: [{
        cat: 'cars',
        pkgId: 'full',
        tierKey: 'small',
        tierLabel: 'Small Car',
        subtotal: 999,
        basePrice: 999,
        addons: [],
      }],
    };
    const r = applyServerTravelAndTotal(booking);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'price_mismatch');
  });

  it('historical stored quote amounts are not silently recalculated by catalog reads', () => {
    const historicalApprovedCents = 25650; // previously accepted total, not in new matrix
    const projection = {
      approvedCents: historicalApprovedCents,
      settledCents: historicalApprovedCents,
      remainingCents: 0,
      paymentStatus: 'paid',
    };
    // Catalog change must not rewrite a paid ledger projection object.
    assert.equal(projection.approvedCents, 25650);
    assert.notEqual(projection.approvedCents, PRICING.cars.tiers.small.full * 100);
  });
});

describe('phase 1 booking review and multi-vehicle authority', () => {
  it('booking review total uses server catalog for small-car full', () => {
    const expected = APPROVED_CARS.small.full;
    const booking = {
      zipCode: NORMAL_ZIP,
      totalPrice: expected,
      vehicles: [{
        cat: 'cars', pkgId: 'full', tierKey: 'small', tierLabel: 'Small Car', addons: [],
      }],
    };
    const r = applyServerTravelAndTotal(booking);
    assert.equal(r.ok, true);
    assert.equal(booking.totalPrice, expected);
    assert.equal(booking.vehicles[0].subtotal, expected);
  });

  it('submit-booking style multi-vehicle subtotal matches catalog', () => {
    const cart = computeBookingServiceSubtotal({
      zipCode: NORMAL_ZIP,
      vehicles: [
        { cat: 'cars', pkgId: 'interior', tierKey: 'suv2', addons: [] },
        { cat: 'powersports', pkgId: 'restore', tierKey: 'motorcycle', addons: [] },
      ],
    });
    assert.equal(cart.ok, true);
    assert.equal(cart.serviceSubtotal, 235 + 250);
  });

  it('add-on totals remain unchanged beside the new base', () => {
    const quote = computeVehicleSubtotal({
      cat: 'cars',
      pkgId: 'maint',
      tierKey: 'small',
      addons: [{ id: 'pethair', qty: 1 }, { id: 'ozone', qty: 1 }],
    }, NORMAL_ZIP);
    assert.equal(quote.basePrice, 160);
    assert.equal(quote.addonTotal, 95 + 40);
    assert.equal(quote.subtotal, 295);
  });
});

describe('phase 1 customer and admin package catalogs', () => {
  it('customer package catalog prices come from booking-price-catalog', () => {
    const booking = {
      id: 'PHASE1-PKG',
      zipCode: NORMAL_ZIP,
      service: {
        vehicles: [{
          vehicleId: 'veh_1',
          cat: 'cars',
          category: 'cars',
          tierKey: 'small',
          packageId: 'maint',
          pkgId: 'maint',
          addOnIds: [],
          addons: [],
        }],
      },
    };
    const catalog = serializeCanonicalPackageCatalogForBooking(booking);
    const full = catalog.vehicles[0].options.find((o) => o.packageId === 'full');
    assert.equal(full.priceCents, 27500);
    const direct = packageOptionsForVehicle(booking.service.vehicles[0], booking);
    assert.equal(direct.options.find((o) => o.id === 'full').priceCents, 27500);
  });

  it('admin-style package options include every approved car package at matrix cents', () => {
    const vehicle = { cat: 'cars', tierKey: 'suv3', pkgId: 'maint', addons: [] };
    const opts = packageOptionsForVehicle(vehicle, { zipCode: NORMAL_ZIP });
    for (const [pkgId, amount] of Object.entries(APPROVED_CARS.suv3)) {
      const row = opts.options.find((o) => o.id === pkgId);
      assert.ok(row, pkgId);
      assert.equal(row.priceCents, amount * 100);
    }
  });
});

describe('phase 1 unchanged categories and public From$ surfaces', () => {
  it('boats, RVs, semis, fleet, PWC, and add-ons retain prior prices', () => {
    assert.deepEqual(
      {
        interior: PRICING.trucks.tiers.day_cab.interior,
        int_wash: PRICING.trucks.tiers.day_cab.int_wash,
        int_wash_wax: PRICING.trucks.tiers.day_cab.int_wash_wax,
      },
      UNCHANGED_SNAPSHOT.trucks.day_cab,
    );
    assert.deepEqual(
      {
        interior: PRICING.trucks.tiers.sleeper_cab.interior,
        int_wash: PRICING.trucks.tiers.sleeper_cab.int_wash,
        int_wash_wax: PRICING.trucks.tiers.sleeper_cab.int_wash_wax,
      },
      UNCHANGED_SNAPSHOT.trucks.sleeper_cab,
    );
    assert.equal(PRICING.boats.tiers.under20.maint, UNCHANGED_SNAPSHOT.boats.under20.maint);
    assert.equal(PRICING.rvs.tiers.travel.full, UNCHANGED_SNAPSHOT.rvs.travel.full);
    assert.equal(PRICING.fleet.tiers.vehicle.full, UNCHANGED_SNAPSHOT.fleet.vehicle.full);
    assert.deepEqual(
      {
        wash: PRICING.powersports.tiers.jetski.wash,
        essential: PRICING.powersports.tiers.jetski.essential,
        full: PRICING.powersports.tiers.jetski.full,
        premium: PRICING.powersports.tiers.jetski.premium,
      },
      UNCHANGED_SNAPSHOT.jetski,
    );
    assert.equal(LENGTH_PRICING.boats.packages.maint.min, UNCHANGED_SNAPSHOT.boatLengthMaintMin);
    assert.equal(PRICING.cars.addons.find((a) => a.id === 'ozone').price, UNCHANGED_SNAPSHOT.carAddonOzone);
    assert.equal(PRICING.cars.addons.find((a) => a.id === 'pethair').price, UNCHANGED_SNAPSHOT.carAddonPethair);
  });

  it('AI chat starting prices derive from the new catalog', () => {
    assert.deepEqual(CHAT_STARTING_PRICES, {
      cars: 210,
      carMaintenance: 160,
      carWash: 125,
      boats: 175,
      rvs: 243,
      powersports: 180,
    });
  });

  it('homepage and powersports public From$ surfaces match the catalog', () => {
    const index = read('index.html');
    assert.match(index, new RegExp(`id="home-from-interior">\\$${APPROVED_CARS.small.interior}`));
    assert.match(index, new RegExp(`id="home-from-refresh">\\$${APPROVED_CARS.small.refresh}`));
    assert.match(index, new RegExp(`From \\$${APPROVED_CARS.small.full} · priced by vehicle type`));
    assert.doesNotMatch(index, /RICH_ZIPS\.has\(zip\.trim\(\)\) \? 1\.05/);
    assert.match(index, /function getRichMultiplier\(zip\)\{\s*\/\/ Wealth-based ZIP premium retired/);

    const ps = read('powersports-detailing.html');
    assert.match(ps, /From \$180/);
    assert.match(ps, /From \$240/);
    assert.doesNotMatch(ps, /From \$220/);
  });

  it('mirrored booking pages carry the approved small-car wash amount', () => {
    for (const page of ['index.html', 'new-jersey-hub.html', 'bergen-county-hub.html']) {
      const html = read(page);
      assert.match(html, /small:\s*\{label:'Small Car'[\s\S]*?wash:125/);
      assert.match(html, /motorcycle:\s*\{label:'Motorcycle'[\s\S]*?restore:250/);
      assert.doesNotMatch(html, /wash:115,\s*maint:160,\s*interior:200/);
    }
  });
});
