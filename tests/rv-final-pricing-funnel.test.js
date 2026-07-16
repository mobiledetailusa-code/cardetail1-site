'use strict';

/**
 * RV final pricing funnel — ZIP-first estimates, type catalog, Full RV Detail,
 * ≤7% rate bump, mileage table reuse, booking prefill gates.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const {
  PRICING,
  LENGTH_PRICING,
  getLengthPrice,
  resolveRvTypeKey,
  computeVehicleSubtotal,
  computeAddonTotal,
  validateAndRecalculateBookingPricing,
} = require('../netlify/lib/booking-price-catalog');

const {
  RV_TYPES,
  RV_RATE_BASELINE,
  ADJUSTED_RATES,
  RV_PACKAGE_META,
  bumpPerFtRate,
  eligiblePackagesForType,
  rateIncreasePct,
} = require('../netlify/lib/rv-type-catalog');

const {
  TRAVEL_FEE_TIERS,
  TRAVEL_MAX_MILES,
  estimateMilesForZip,
  travelFeeFromMiles,
  resolveTravelForZip,
} = require('../netlify/lib/travel-fee');

const PKG_IDS = ['maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'];

// ── PUBLIC PAGE ──────────────────────────────────────────────────────────────
test('1. No RV length ruler before pricing funnel', () => {
  const page = read('rv-detailing.html');
  assert.doesNotMatch(page, /id="rv-length-bar"|id="rv-length-range"|data-rv-length-control/);
});

test('2. No dynamic total before valid ZIP', () => {
  const page = read('rv-detailing.html');
  assert.doesNotMatch(page, /Starting at \$|Estimated total for your \d+-ft|data-per-ft=/);
  assert.doesNotMatch(page, /data-rv-price(?!-funnel)/);
});

test('3. Service descriptions remain visible', () => {
  const page = read('rv-detailing.html');
  assert.match(page, /Exterior hand wash/);
  assert.match(page, /Carpet and upholstery shampoo/);
  assert.match(page, /One-step machine polish/);
  assert.match(page, /Roof excluded/);
});

test('4. Package CTAs open the canonical RV price funnel', () => {
  const page = read('rv-detailing.html');
  assert.match(page, /assets\/rv-pricing-funnel\.js/);
  assert.match(page, /data-rv-price-funnel/);
  assert.match(page, /CHECK PRICE &amp; AVAILABILITY/);
  for (const id of PKG_IDS) {
    assert.match(page, new RegExp(`data-booking-package="${id}"`));
  }
  assert.ok((page.match(/data-rv-price-funnel/g) || []).length >= 6);
});

// ── FUNNEL ───────────────────────────────────────────────────────────────────
test('5-13. Funnel ZIP-first, types, length, persistence', () => {
  const js = read('assets/rv-pricing-funnel.js');
  assert.match(js, /Service ZIP code/);
  assert.match(js, /resolveTravel/);
  assert.match(js, /TRAVEL_FEE_TIERS/);
  assert.match(js, /ZIP3_EST_MILES/);
  assert.match(js, /data-step="1"/);
  assert.match(js, /Travel Trailer/);
  assert.match(js, /Fifth Wheel/);
  assert.match(js, /Class A Motorhome/);
  assert.match(js, /Class B \/ Class C Motorhome/);
  assert.match(js, /Airstream/);
  assert.match(js, /Cargo, Horse or Custom Trailer/);
  assert.match(js, /finished living quarters/);
  assert.match(js, /Lengths are not rounded up to 24 ft/);
  assert.match(js, /setStep\(4\)/);
  assert.match(js, /See estimates/);
  assert.match(js, /params\.set\('zip'/);
  assert.match(js, /params\.set\('rvType'/);
  assert.match(js, /params\.set\('length'/);
  assert.match(js, /openCategoryPackageBooking/);
  assert.match(js, /not rounded up to 24/);
  assert.doesNotMatch(js, /Math\.max\(\s*24/);
});

// ── RV TYPES ─────────────────────────────────────────────────────────────────
test('14-20. RV type catalog + specialty living quarters', () => {
  assert.ok(RV_TYPES.travel);
  assert.ok(RV_TYPES.fifthwheel);
  assert.ok(RV_TYPES.classA);
  assert.ok(RV_TYPES.classBC);
  assert.ok(RV_TYPES.airstream);
  assert.ok(RV_TYPES.specialty);
  const unfinished = eligiblePackagesForType('specialty', 'no');
  assert.deepEqual(unfinished, ['maint', 'premium']);
  assert.ok(!unfinished.includes('interior'));
  assert.ok(!unfinished.includes('full_basic'));
  const finished = eligiblePackagesForType('specialty', 'yes');
  assert.ok(finished.includes('interior'));
  assert.ok(finished.includes('full_basic'));
});

// ── PRICING ──────────────────────────────────────────────────────────────────
test('21-22. Per-foot rates increased ≤7% and documented', () => {
  for (const id of ['maint', 'maint_light', 'interior', 'premium']) {
    const oldR = RV_RATE_BASELINE[id];
    const newR = ADJUSTED_RATES[id];
    assert.equal(newR, bumpPerFtRate(oldR));
    assert.ok(rateIncreasePct(oldR, newR) <= 7.0001);
    assert.equal(LENGTH_PRICING.rvs.packages[id].perFt, newR);
  }
  // full is derived (bundle), not a direct ≤7% bump of 44
  assert.equal(ADJUSTED_RATES.full, 49.5);
  assert.equal(LENGTH_PRICING.rvs.packages.full.perFt, 49.5);
  assert.equal(ADJUSTED_RATES.full_basic, 27);
});

test('23. Mileage rates did not receive the 7% increase', () => {
  assert.deepEqual(TRAVEL_FEE_TIERS.map((t) => t.fee), [0, 15, 25, 35, 40, 55]);
  assert.equal(TRAVEL_MAX_MILES, 120);
});

test('24-25. Super Interior $135; Sanitize $75', () => {
  assert.equal(PRICING.rvs.addons.find((a) => a.id === 'superint').price, 135);
  assert.equal(PRICING.rvs.addons.find((a) => a.id === 'sanitize').price, 75);
});

test('26-29. Travel once, multiplier once, parity, reject manipulated addons', () => {
  const ft = 28;
  const type = 'fifthwheel';
  const mult = RV_TYPES[type].multiplier;
  for (const id of PKG_IDS) {
    const rule = LENGTH_PRICING.rvs.packages[id];
    const expected = Math.max(rule.min, Math.round(rule.perFt * ft * mult));
    assert.equal(getLengthPrice('rvs', id, ft, type), expected);
    const sub = computeVehicleSubtotal({
      cat: 'rvs', pkgId: id, lengthFt: ft, rvType: type, addons: [],
    }, '07650');
    assert.equal(sub.ok, true);
    assert.equal(sub.basePrice, expected);
  }
  const travel = resolveTravelForZip('07650');
  assert.ok(travel);
  assert.equal(travel.fee, 0);
  const hacked = computeVehicleSubtotal({
    cat: 'rvs', pkgId: 'full', lengthFt: 28, rvType: 'travel',
    addons: [{ id: 'superint', price: 1 }],
  }, '07650');
  assert.equal(hacked.ok, true);
  assert.equal(hacked.addonTotal, 135);
});

test('30. Other category prices remain unchanged', () => {
  assert.equal(LENGTH_PRICING.boats.packages.maint.perFt, 12);
  assert.equal(PRICING.cars.tiers.small.maint, 175);
  assert.equal(PRICING.powersports.tiers.motorcycle.wash, 119);
  assert.equal(PRICING.fleet.tiers.vehicle.maint, 79);
});

// ── PACKAGES ─────────────────────────────────────────────────────────────────
test('31-45. Six packages, badges, polish rules, no mold/hours', () => {
  const page = read('rv-detailing.html');
  assert.equal((page.match(/data-rv-tier="/g) || []).length, 6);
  assert.match(page, /Maintenance Wash/);
  assert.match(page, /Maintenance Wash \+ Light Interior/);
  assert.match(page, /Interior Detail/);
  assert.match(page, /Full RV Detail/);
  assert.match(page, /Premium Exterior Detail/);
  assert.match(page, /Premium Complete RV Detail/);
  assert.match(page, /MOST POPULAR/);
  assert.match(page, /BEST FINISH/);
  assert.match(page, /data-rv-tier="full_basic"[\s\S]*?MOST POPULAR/);
  assert.match(page, /data-rv-tier="full"[\s\S]*?BEST FINISH/);
  const fullBasic = page.slice(page.indexOf('data-rv-tier="full_basic"'), page.indexOf('data-rv-tier="premium"'));
  assert.match(fullBasic, /does not include one-step machine polishing/i);
  assert.doesNotMatch(fullBasic, /<li>[^<]*[Oo]ne-step machine polish/);
  assert.match(page, /Premium Exterior Detail[\s\S]*?One-step machine polish/);
  assert.match(page, /Premium Complete RV Detail[\s\S]*?One-step machine polish[\s\S]*?Carpet and upholstery shampoo/);
  assert.match(page, /Roof excluded/);
  assert.doesNotMatch(page, /full interior scope/i);
  assert.doesNotMatch(page, /Service duration depends|~\d+–\d+h|estimated service hours/i);
  assert.doesNotMatch(page, /Mold Treatment/);
  assert.ok(!PRICING.rvs.addons.some((a) => a.id === 'mold'));
  assert.equal(RV_PACKAGE_META.full_basic.badge, 'MOST POPULAR');
  assert.equal(RV_PACKAGE_META.full.badge, 'BEST FINISH');
});

test('Full RV Detail formula and hierarchy', () => {
  const derived = Math.floor((ADJUSTED_RATES.maint + ADJUSTED_RATES.interior) * 0.92 * 2) / 2;
  assert.equal(ADJUSTED_RATES.full_basic, derived);
  assert.ok(ADJUSTED_RATES.full_basic > ADJUSTED_RATES.maint);
  assert.ok(ADJUSTED_RATES.full_basic > ADJUSTED_RATES.interior);
  assert.ok(ADJUSTED_RATES.full_basic < ADJUSTED_RATES.maint + ADJUSTED_RATES.interior);
  assert.ok(ADJUSTED_RATES.full_basic < ADJUSTED_RATES.full);
  assert.ok(ADJUSTED_RATES.full > ADJUSTED_RATES.premium);
  assert.ok(ADJUSTED_RATES.full > ADJUSTED_RATES.interior);
  assert.ok(ADJUSTED_RATES.full > ADJUSTED_RATES.full_basic);
});

// ── MILEAGE BOUNDARIES ───────────────────────────────────────────────────────
test('18. Mileage band boundaries use authoritative table', () => {
  const samples = [
    { zip: '07650', expectFee: 0 },
    { zip: '07801', expectFee: 15 },
    { zip: '08101', expectFee: 25 },
    { zip: '08601', expectFee: 35 },
    { zip: '19019', expectFee: 40 },
    { zip: '17101', expectFee: 55 },
  ];
  for (const s of samples) {
    const miles = estimateMilesForZip(s.zip);
    assert.ok(miles != null && miles <= TRAVEL_MAX_MILES, s.zip);
    assert.equal(travelFeeFromMiles(miles), s.expectFee, s.zip);
    const r = resolveTravelForZip(s.zip);
    assert.ok(r, s.zip);
    assert.equal(r.fee, s.expectFee);
  }
  const outside = resolveTravelForZip('13201');
  assert.equal(outside, null);
});

// ── REGRESSION ───────────────────────────────────────────────────────────────
test('46-54. Six steps, no Twilio, galleries/stripe untouched markers', () => {
  const index = read('index.html');
  assert.match(index, /bkGoTo\(6\)|bs6|STEP 6|Secure Your Booking/i);
  assert.match(index, /id:'full_basic'/);
  assert.equal(LENGTH_PRICING.rvs.packages.maint.perFt, 8.5);
  const page = read('rv-detailing.html');
  assert.match(page, /specialty-gallery/);
  const allJs = [
    read('assets/rv-pricing-funnel.js'),
    read('netlify/lib/rv-type-catalog.js'),
    read('netlify/lib/booking-price-catalog.js'),
  ].join('\n');
  assert.doesNotMatch(allJs, /twilio|Twilio/);
  assert.equal(resolveRvTypeKey({ rvType: 'classBC' }), 'classBC');
  assert.equal(resolveRvTypeKey({ rvType: 'airstream' }), 'airstream');
});

test('exact length not rounded to 24; 20-ft below 24 differs', () => {
  assert.notEqual(getLengthPrice('rvs', 'maint', 20, 'travel'), getLengthPrice('rvs', 'maint', 24, 'travel'));
  assert.equal(getLengthPrice('rvs', 'maint', 20, 'travel'), Math.max(129, Math.round(8.5 * 20)));
});

test('manipulated frontend totals rejected by server recalculation', () => {
  const result = validateAndRecalculateBookingPricing({
    vehicleCategory: 'rvs',
    package: 'Full RV Detail',
    lengthFt: 28,
    rvType: 'travel',
    zipCode: '07650',
    totalPrice: 1,
    vehicles: [{
      cat: 'rvs', pkgId: 'full_basic', lengthFt: 28, rvType: 'travel', addons: [],
    }],
  });
  assert.equal(result.ok, true);
  const expected = getLengthPrice('rvs', 'full_basic', 28, 'travel');
  assert.equal(result.serviceSubtotal, expected);
  assert.notEqual(result.clientTotal, result.serviceSubtotal);
});
