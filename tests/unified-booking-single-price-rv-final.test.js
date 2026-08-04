'use strict';

/**
 * Unified booking single-price UX + authoritative RV base+ratePerFoot pricing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const {
  LENGTH_PRICING,
  PRICING,
  getLengthPrice,
  computeVehicleSubtotal,
} = require('../netlify/lib/booking-price-catalog');

const { RV_TYPES, RV_RATE_TABLE, computeRvServicePrice } = require('../netlify/lib/rv-type-catalog');

const PKG_IDS = ['maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'];

const FIXTURES = {
  19: [270, 554, 592, 775, 832, 1084],
  23: [245, 618, 664, 875, 944, 1228],
  30: [290, 730, 790, 840, 1140, 1480],
  40: [440, 890, 970, 1300, 1420, 1840],
};

test('authoritative RV fixtures: travel, no addons, no travel fee', () => {
  for (const [ft, prices] of Object.entries(FIXTURES)) {
    PKG_IDS.forEach((id, i) => {
      const expected = prices[i];
      assert.equal(getLengthPrice('rvs', id, Number(ft), 'travel'), expected, `${id}@${ft}ft`);
      assert.equal(computeRvServicePrice(id, Number(ft), 'travel'), expected, `compute ${id}@${ft}ft`);
    });
  }
});

test('RV type multipliers are 1.0 (eligibility only)', () => {
  for (const t of Object.values(RV_TYPES)) {
    assert.equal(t.multiplier, 1.0, t.id);
  }
  assert.equal(getLengthPrice('rvs', 'full', 30, 'classA'), getLengthPrice('rvs', 'full', 30, 'travel'));
});

test('LENGTH_PRICING uses base+ratePerFoot without min/perFt-only', () => {
  for (const id of PKG_IDS) {
    const rule = LENGTH_PRICING.rvs.packages[id];
    assert.equal(rule.base, RV_RATE_TABLE[id].base);
    assert.equal(rule.ratePerFoot, RV_RATE_TABLE[id].ratePerFoot);
    assert.equal(rule.min, undefined);
    assert.equal(rule.perFt, undefined);
  }
});

test('single-price UX strings in index.html', () => {
  const html = read('index.html');
  assert.match(html, /Estimated service price:/);
  assert.match(html, /Travel and location adjustments are calculated after the service ZIP is entered/);
  // Travel fee is applied via getTravelFeeAmount() once ZIP/zone is known (not gated on currentBkStep >= 4).
  assert.match(html, /getTravelFeeAmount\(\)/);
  assert.match(html, /id="ah-total-lbl"/);
  assert.match(html, /Estimated service price/);
  assert.match(html, /Estimated total/);
  assert.match(html, /Price calculated from your vehicle details/);
  assert.doesNotMatch(html, /\$12\.75\/ft/);
});

test('start=vehicle routing and launchBooking startStep', () => {
  const html = read('index.html');
  const bridge = read('assets/specialty-booking-bridge.js');
  assert.match(html, /params\.get\('start'\)/);
  assert.match(html, /goVehicle && ST\.pkg\) bkGoTo\(3\)/);
  assert.match(html, /ST\._startStep\s*=\s*3/);
  assert.match(html, /opts\.startStep/);
  assert.match(bridge, /params\.set\('start',\s*'vehicle'\)/);
  assert.match(bridge, /params\.set\('start',\s*'package'\)/);
});

test('six-step booking; no funnel or membership on RV page', () => {
  const page = read('rv-detailing.html');
  assert.match(read('index.html'), /BK_VISIBLE_STEPS\s*=\s*6/);
  assert.doesNotMatch(page, /rv-pricing-funnel|id="membership"|RV Care Membership/);
  assert.match(page, /Price calculated from your vehicle details/);
  assert.doesNotMatch(page, /Starting at \$[\d.]+\/ft/);
});

test('Super Interior blocks overlapping pethair/odor for RVs', () => {
  const html = read('index.html');
  assert.match(html, /syncRvSuperintAddonDedup/);
  assert.match(html, /addon-disabled/);
  assert.equal(PRICING.rvs.addons.find((a) => a.id === 'superint').price, 135);
  assert.equal(PRICING.rvs.addons.find((a) => a.id === 'sanitize').price, 75);
  assert.ok(!PRICING.rvs.addons.some((a) => a.id === 'mold'));
});

test('non-RV prices unchanged', () => {
  assert.equal(LENGTH_PRICING.boats.packages.maint.min, 160);
  assert.equal(LENGTH_PRICING.boats.packages.maint.perFt, 12);
  assert.equal(LENGTH_PRICING.fleet.packages.maint.min, 160);
  assert.equal(PRICING.cars.tiers.small.interior, 180);
  const boat = getLengthPrice('boats', 'maint', 22, null);
  assert.equal(boat, Math.max(160, Math.round(12 * 22)));
  const hacked = computeVehicleSubtotal({
    cat: 'rvs',
    pkgId: 'full',
    lengthFt: 30,
    rvType: 'travel',
    addons: [{ id: 'superint', price: 1 }],
  }, '07650');
  assert.equal(hacked.basePrice, 1480);
  assert.equal(hacked.addonTotal, 135);
});
