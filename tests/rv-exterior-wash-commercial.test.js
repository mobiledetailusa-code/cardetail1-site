'use strict';

/**
 * CARDDETAIL1 — RV exterior wash / protect / polish.
 * Prices are the draft catalog, not a published market average.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  LENGTH_PRICING,
  getLengthPrice,
  inferPkgId,
  computeVehicleSubtotal,
} = require('../netlify/lib/booking-price-catalog');
const { resolveTravelForZip } = require('../netlify/lib/travel-fee');
const {
  RV_TYPES,
  estimateExteriorWashMinutes,
  applyRvExteriorWashDuration,
  rvModelTypeHint,
  eligiblePackagesForType,
} = require('../netlify/lib/rv-type-catalog');

const root = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'missing ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unterminated ' + name);
}

function browserLengthPrice() {
  const sandbox = { ST: { rvType: 'travel' }, RV_TYPE_MULTIPLIERS: {}, LENGTH_PRICING };
  const mult = indexHtml.match(/const RV_TYPE_MULTIPLIERS = \{[^}]+\}/);
  assert.ok(mult, 'RV_TYPE_MULTIPLIERS missing');
  vm.createContext(sandbox);
  vm.runInContext(mult[0] + ';\n' + extractFunction(indexHtml, 'getLengthPrice') + '\nthis.getLengthPrice = getLengthPrice;', sandbox);
  return sandbox.getLengthPrice;
}

const TYPES = ['travel', 'fifthwheel', 'motorhome', 'classA', 'classB', 'classC'];

test('25 ft at ZIP 07105 is the same service price for every RV type', () => {
  const travel = resolveTravelForZip('07105');
  assert.equal(travel.miles, 19);
  assert.equal(travel.fee, 0);
  assert.equal(travel.mileageFee, 0);
  assert.equal(travel.bridgeSurcharge, 0);

  const expected = {
    exterior_wash: 225,
    maint: 360,
    premium: 890,
    maint_light: 570,
    interior: 595,
    full_basic: 815,
    full: 1150,
  };
  for (const typeKey of TYPES) {
    for (const [pkgId, price] of Object.entries(expected)) {
      const service = getLengthPrice('rvs', pkgId, 25, typeKey);
      assert.equal(service, price, `${typeKey} ${pkgId}`);
      const quoted = computeVehicleSubtotal({
        cat: 'rvs', pkgId, lengthFt: 25, rvType: typeKey, addons: [],
      }, '07105');
      assert.equal(quoted.ok, true);
      assert.equal(quoted.basePrice, price);
      assert.equal(quoted.addonTotal, 0);
      assert.equal(quoted.subtotal, price);
      assert.equal(quoted.subtotal + travel.fee, price);
    }
  }
  assert.equal(RV_TYPES.travel.multiplier, 1);
  assert.equal(RV_TYPES.fifthwheel.multiplier, 1);
  assert.equal(RV_TYPES.motorhome.multiplier, 1);
  assert.equal(RV_TYPES.classA.multiplier, 1);
});

test('wash formula: floor, per-foot, rounding, and invalid length', () => {
  const rule = LENGTH_PRICING.rvs.packages.exterior_wash;
  assert.deepEqual(rule, { perFt: 9, min: 199, ratePerFoot: 9 });
  assert.equal(rule.base, undefined);
  const cases = { 12: 199, 20: 199, 22: 199, 23: 207, 24: 216, 25: 225, 30: 270, 40: 360, 45: 405 };
  for (const [ft, price] of Object.entries(cases)) {
    assert.equal(getLengthPrice('rvs', 'exterior_wash', Number(ft), 'travel'), price, ft);
  }
  for (const bad of [0, -1, 11, 46, Number.NaN, 'nope']) {
    assert.equal(getLengthPrice('rvs', 'exterior_wash', bad, 'motorhome'), null, String(bad));
    assert.equal(getLengthPrice('rvs', 'maint', bad, 'travel'), null, 'maint ' + bad);
  }
  assert.equal(getLengthPrice('rvs', 'exterior_wash', null, 'travel'), 199);
});

test('browser getLengthPrice matches the server for wash, protect, and polish', () => {
  const browser = browserLengthPrice();
  for (const ft of [20, 25, 30, 40]) {
    for (const pkgId of ['exterior_wash', 'maint', 'premium']) {
      for (const typeKey of ['travel', 'fifthwheel', 'motorhome']) {
        assert.equal(
          browser('rvs', pkgId, ft, typeKey),
          getLengthPrice('rvs', pkgId, ft, typeKey),
          `${pkgId} ${typeKey} ${ft}`,
        );
      }
    }
  }
  assert.equal(browser('rvs', 'exterior_wash', 11, 'travel'), null);
});

test('saved package ids keep their scope, and a bare Exterior Wash name does not pick a package', () => {
  const stored = computeVehicleSubtotal({
    cat: 'rvs',
    pkgId: 'maint',
    pkgName: 'Maintenance Wash',
    lengthFt: 25,
    rvType: 'classA',
    addons: [],
  }, '07105');
  assert.equal(stored.pkgId, 'maint');
  assert.equal(stored.basePrice, 360);

  assert.equal(inferPkgId({ cat: 'rvs', pkgName: 'Exterior Wash' }, { vehicleCategory: 'rvs' }), null);
  const nameless = computeVehicleSubtotal({
    cat: 'rvs', pkgName: 'Exterior Wash', lengthFt: 25, rvType: 'travel', addons: [],
  }, '07105');
  assert.equal(nameless.ok, false);
  assert.equal(inferPkgId({ cat: 'rvs', pkgName: 'Exterior Wash & Protect' }, { vehicleCategory: 'rvs' }), 'maint_light');
  assert.equal(inferPkgId({ cat: 'rvs', pkgId: 'exterior', pkgName: 'Exterior Wash' }, { vehicleCategory: 'rvs' }), 'maint_light');

  const basic = computeVehicleSubtotal({
    cat: 'rvs', pkgId: 'exterior_wash', pkgName: 'Exterior Wash', lengthFt: 25, addons: [],
  }, '07105');
  assert.equal(basic.pkgId, 'exterior_wash');
  assert.equal(basic.basePrice, 225);

  assert.equal(inferPkgId({ cat: 'rvs', pkgName: 'Wash & Protect' }, {}), 'maint');
  assert.equal(inferPkgId({ cat: 'rvs', pkgName: 'Exterior Polish & Protect' }, {}), 'premium');
  assert.equal(inferPkgId({ cat: 'rvs', pkgId: 'exterior' }, { vehicleCategory: 'rvs' }), 'maint_light');
});

test('stored protection add-ons still reprice, and the booking UI hides them when the package already includes wax', () => {
  const protect = computeVehicleSubtotal({
    cat: 'rvs', pkgId: 'maint', lengthFt: 25, rvType: 'fifthwheel',
    addons: [{ id: 'polymer' }, { id: 'wax1yr' }],
  }, '07105');
  assert.equal(protect.basePrice, 360);
  assert.equal(protect.addonTotal, 100);
  const wash = computeVehicleSubtotal({
    cat: 'rvs', pkgId: 'exterior_wash', lengthFt: 25,
    addons: [{ id: 'polymer' }],
  }, '07105');
  assert.equal(wash.basePrice, 225);
  assert.equal(wash.addonTotal, 25);
  assert.match(indexHtml, /rvPackageIncludesProtection\(ST\.pkgId\) && \(a\.id==='polymer' \|\| a\.id==='wax1yr'\)/);
  assert.match(indexHtml, /function rvPackageIncludesProtection\(pkgId\)\{[\s\S]*?'maint'[\s\S]*?'premium'/);
  assert.doesNotMatch(
    indexHtml.slice(indexHtml.indexOf('function rvPackageIncludesProtection'), indexHtml.indexOf('function rvPackageIncludesProtection') + 400),
    /exterior_wash/,
  );
});

test('wash duration follows the 150 and 280 minute anchors and does not replace ceramic', () => {
  const minutes = { 12: 38, 20: 107, 25: 150, 30: 194, 35: 237, 40: 280, 45: 324 };
  const slots = { 12: 1, 20: 1, 25: 2, 30: 2, 35: 2, 40: 3, 45: 3 };
  let previous = 0;
  for (const [ft, expected] of Object.entries(minutes)) {
    const got = estimateExteriorWashMinutes(Number(ft));
    assert.equal(got, expected, ft);
    assert.ok(got > previous, 'monotonic ' + ft);
    previous = got;
    const held = got <= 120 ? 1 : Math.ceil(got / 120);
    assert.equal(held, slots[ft], 'slots ' + ft);
  }
  assert.equal(estimateExteriorWashMinutes(0), null);
  assert.match(indexHtml, /Math\.ceil\(\(130 \* n - 1000\) \/ 15\)/);
  const ux = fs.readFileSync(path.join(root, 'assets/booking-conversion-ux.js'), 'utf8');
  assert.match(ux, /Math\.ceil\(\(130 \* ft - 1000\) \/ 15\)/);
  const booking = applyRvExteriorWashDuration({
    lengthFt: 40,
    vehicles: [{ pkgId: 'exterior_wash', lengthFt: 40 }],
  });
  assert.equal(booking.appointmentDurationMinutes, 280);
  assert.equal(booking.durationSource, 'estimate_owner_review');
  const ceramic = applyRvExteriorWashDuration({
    appointmentDurationMinutes: 480,
    vehicles: [{ pkgId: 'ceramic_1yr' }, { pkgId: 'exterior_wash', lengthFt: 25 }],
  });
  assert.equal(ceramic.appointmentDurationMinutes, 480);
  const other = applyRvExteriorWashDuration({
    vehicles: [{ pkgId: 'maint', lengthFt: 25 }],
  });
  assert.equal(other.appointmentDurationMinutes, undefined);
});

test('Lexington is a motorhome hint only, and motorized copy is type-specific', () => {
  assert.equal(rvModelTypeHint('Forest River', 'Lexington'), 'motorhome');
  assert.equal(rvModelTypeHint('Forest River', 'Salem'), '');
  assert.match(indexHtml, /Lexington/);
  assert.match(indexHtml, /option value="motorhome">Motorhome — Class A, B or C/);
  assert.match(indexHtml, /option value="travel">Travel Trailer — rear hitch/);
  assert.match(indexHtml, /option value="fifthwheel">Fifth Wheel — pickup-bed hitch/);
  assert.match(indexHtml, /My model isn’t listed/);
  assert.match(indexHtml, /id:'exterior_wash'/);
  assert.equal(eligiblePackagesForType('cargo', 'no').includes('exterior_wash'), true);
  const admin = fs.readFileSync(path.join(root, 'netlify/functions/admin-ops-jobs.js'), 'utf8');
  const finance = fs.readFileSync(path.join(root, 'netlify/lib/package-financial-mutation.js'), 'utf8');
  for (const src of [admin, finance]) {
    assert.match(src, /exterior_wash: 'Exterior Wash'/);
    assert.match(src, /maint: 'Wash & Protect'/);
    assert.match(src, /premium: 'Exterior Polish & Protect'/);
    assert.match(src, /maint_light: 'Maintenance Wash \+ Light Interior'/);
  }
});
