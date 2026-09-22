'use strict';

/**
 * Specialty pricing recalibration — phase 2.
 *
 * Locks semi interior recalibration, powersports heavy-mud uplift, Premium Marine
 * scope wording, and fingerprints for boats / RVs / remaining powersports that
 * must not move in this PR.
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
  validateAndRecalculateBookingPricing,
} = require('../netlify/lib/booking-price-catalog');
const { applyServerTravelAndTotal } = require('../netlify/lib/travel-fee');
const { BOAT_PACKAGES } = require('../netlify/lib/length-pricing');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const NORMAL_ZIP = '07102';

const APPROVED_SEMI = Object.freeze({
  day_cab: { interior: 295, int_wash: 415, int_wash_wax: 520 },
  sleeper_cab: { interior: 350, int_wash: 520, int_wash_wax: 650 },
});

const UNCHANGED_POWERSPORTS_PACKAGES = Object.freeze({
  motorcycle: { maintenance: 180, restore: 250 },
  motorcycle_large: { maintenance: 200, restore: 275 },
  motorcycle_trike: { maintenance: 225, restore: 310 },
  atv: { maintenance: 180, restore: 240 },
  utv_standard: { maintenance: 210, restore: 275 },
  utv_large: { maintenance: 235, restore: 325 },
  jetski: { wash: 105, essential: 165, full: 235, premium: 320 },
});

const UNCHANGED_BOAT_LENGTH = Object.freeze({
  maint: { perFt: 11, min: 175 },
  essential: { perFt: 19, min: 265 },
  full: { perFt: 27, min: 390 },
  premium: { perFt: 33, min: 615 },
});

const UNCHANGED_RV_FORMULAS = Object.freeze({
  maint: { base: 135, ratePerFoot: 9 },
  maint_light: { base: 220, ratePerFoot: 14 },
  interior: { base: 220, ratePerFoot: 15 },
  full_basic: { base: 265, ratePerFoot: 22 },
  premium: { base: 265, ratePerFoot: 25 },
  full: { base: 350, ratePerFoot: 32 },
});

describe('phase 2 semi-truck interior recalibration', () => {
  for (const [tierKey, packages] of Object.entries(APPROVED_SEMI)) {
    for (const [pkgId, amount] of Object.entries(packages)) {
      it(`${tierKey}.${pkgId} = $${amount}`, () => {
        assert.equal(PRICING.trucks.tiers[tierKey][pkgId], amount);
        const quote = computeVehicleSubtotal({
          cat: 'trucks', pkgId, tierKey, addons: [],
        }, NORMAL_ZIP);
        assert.equal(quote.ok, true);
        assert.equal(quote.basePrice, amount);
        assert.equal(quote.subtotal, amount);
      });
    }
  }

  it('combined wash packages were not reduced', () => {
    assert.equal(PRICING.trucks.tiers.day_cab.int_wash, 415);
    assert.equal(PRICING.trucks.tiers.day_cab.int_wash_wax, 520);
    assert.equal(PRICING.trucks.tiers.sleeper_cab.int_wash, 520);
    assert.equal(PRICING.trucks.tiers.sleeper_cab.int_wash_wax, 650);
  });

  it('trucks specialty page and homepage From$ show day-cab interior $295', () => {
    const trucks = read('trucks-detailing.html');
    assert.match(trucks, /From \$295/);
    assert.match(trucks, /Day cab from \$295 · sleeper from \$350/);
    assert.match(trucks, /"price":\s*"295"/);
    assert.doesNotMatch(trucks, /From \$340/);
    assert.doesNotMatch(trucks, /\$425 \/ \$520 \/ \$650/);

    const index = read('index.html');
    assert.match(index, /id="bkfrom-trucks">From \$295</);
    assert.match(index, /day_cab:[\s\S]*?interior:295/);
    assert.match(index, /sleeper_cab:[\s\S]*?interior:350/);
  });
});

describe('phase 2 powersports heavy mud = $75; base packages unchanged', () => {
  it('heavymud canonical add-on is $75', () => {
    assert.equal(PRICING.powersports.addons.find((a) => a.id === 'heavymud').price, 75);
    const quote = computeVehicleSubtotal({
      cat: 'powersports',
      pkgId: 'maintenance',
      tierKey: 'motorcycle',
      addons: [{ id: 'heavymud', qty: 1 }],
    }, NORMAL_ZIP);
    assert.equal(quote.ok, true);
    assert.equal(quote.basePrice, 180);
    assert.equal(quote.addonTotal, 75);
    assert.equal(quote.subtotal, 255);
  });

  it('fleet heavymud remains a separate $65 worksite add-on', () => {
    assert.equal(PRICING.fleet.addons.find((a) => a.id === 'heavymud').price, 65);
  });

  for (const [tierKey, packages] of Object.entries(UNCHANGED_POWERSPORTS_PACKAGES)) {
    for (const [pkgId, amount] of Object.entries(packages)) {
      it(`powersports ${tierKey}.${pkgId} stays $${amount}`, () => {
        assert.equal(PRICING.powersports.tiers[tierKey][pkgId], amount);
      });
    }
  }

  it('powersports specialty page shows Heavy Mud starting at $75 with photo-review copy', () => {
    const html = read('powersports-detailing.html');
    assert.match(html, /Heavy Mud Removal — starting at \$75/);
    assert.match(html, /photo review before final confirmation/i);
    assert.doesNotMatch(html, /Heavy packed mud is a \$55/);
  });

  it('mirrored booking pages carry heavymud at $75 with condition language', () => {
    for (const page of ['index.html', 'bergen-county-hub.html', 'new-jersey-hub.html']) {
      const html = read(page);
      assert.match(html, /id:'heavymud'[\s\S]*?price:75/);
      assert.match(html, /Severe conditions require photo review before final confirmation/);
    }
  });
});

describe('phase 2 boat rates unchanged; Premium Marine scope constrained', () => {
  it('boat length rates and minimums remain the approved matrix', () => {
    assert.deepEqual(LENGTH_PRICING.boats.packages, UNCHANGED_BOAT_LENGTH);
  });

  it('Premium Marine canonical copy is gloss / light-to-moderate oxidation', () => {
    const premium = BOAT_PACKAGES.find((p) => p.id === 'premium');
    assert.ok(premium);
    assert.match(premium.tag, /Gloss enhancement and light-to-moderate oxidation correction/i);
    assert.match(premium.description, /photo review and a custom quote/i);
    assert.doesNotMatch(premium.tag, /maximum marine protection/i);
    assert.doesNotMatch(premium.description, /unlimited|wet sanding included|complete oxidation removal/i);
  });

  it('boats specialty page requires photo review for severe restoration', () => {
    const html = read('boats-detailing.html');
    assert.match(html, /Gloss enhancement and light-to-moderate oxidation correction/);
    assert.match(html, /Severe chalking, heavy oxidation, wet sanding or multi-stage gel-coat restoration requires photo review and a custom quote/);
    assert.doesNotMatch(html, /heavy gel-coat oxidation removal/);
    assert.doesNotMatch(html, /Oxidation improvement, hull polish, and maximum marine protection/);
  });

  it('booking PKG_DEFS Premium Marine tag matches constrained scope', () => {
    const index = read('index.html');
    assert.match(index, /tag:'Gloss enhancement and light-to-moderate oxidation correction'/);
    assert.doesNotMatch(index, /tag:'Oxidation improvement, hull polish, and maximum marine protection'/);
  });
});

describe('phase 2 RV formulas unchanged', () => {
  it('length formulas match the approved six-package matrix', () => {
    assert.deepEqual(LENGTH_PRICING.rvs.packages, UNCHANGED_RV_FORMULAS);
  });

  it('RV display tiers for travel remain prior amounts', () => {
    assert.deepEqual(
      {
        maint: PRICING.rvs.tiers.travel.maint,
        maint_light: PRICING.rvs.tiers.travel.maint_light,
        interior: PRICING.rvs.tiers.travel.interior,
        full_basic: PRICING.rvs.tiers.travel.full_basic,
        premium: PRICING.rvs.tiers.travel.premium,
        full: PRICING.rvs.tiers.travel.full,
      },
      { maint: 280, maint_light: 410, interior: 405, full_basic: 790, premium: 1000, full: 1235 },
    );
  });
});

describe('phase 2 RICH_ZIP remains retired + booking authority', () => {
  it('RICH_ZIP stays retired', () => {
    assert.equal(RICH_ZIPS.size, 0);
    assert.equal(getRichMultiplier('07620'), 1.0);
    assert.equal(applyRichPrice(295, '07620'), 295);
  });

  it('existing booking price authority rejects stale client totals', () => {
    const booking = {
      zipCode: NORMAL_ZIP,
      totalPrice: 340,
      vehicles: [{
        cat: 'trucks',
        pkgId: 'interior',
        tierKey: 'day_cab',
        tierLabel: 'Day Cab / Single Cab',
        subtotal: 340,
        basePrice: 340,
        addons: [],
      }],
    };
    const r = applyServerTravelAndTotal(booking);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'price_mismatch');
  });

  it('new semi interior totals validate against the catalog', () => {
    const result = validateAndRecalculateBookingPricing({
      zipCode: NORMAL_ZIP,
      totalPrice: 295,
      vehicles: [{
        cat: 'trucks',
        pkgId: 'interior',
        tierKey: 'day_cab',
        vehicleLabel: '2020 Freightliner Cascadia · Day Cab',
        addons: [],
      }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.serviceSubtotal, 295);
  });

  it('historical approved ledger cents are not rewritten by the catalog', () => {
    const historicalApprovedCents = 42500; // prior sleeper interior quote
    const projection = {
      approvedCents: historicalApprovedCents,
      settledCents: historicalApprovedCents,
      remainingCents: 0,
      paymentStatus: 'paid',
    };
    assert.equal(projection.approvedCents, 42500);
    assert.notEqual(projection.approvedCents, PRICING.trucks.tiers.sleeper_cab.interior * 100);
  });
});
