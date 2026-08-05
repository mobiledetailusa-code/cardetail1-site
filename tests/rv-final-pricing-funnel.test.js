'use strict';

/**
 * RV pricing funnel removed — assert absence and six-step booking path remains.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const { LENGTH_PRICING, getLengthPrice } = require('../netlify/lib/booking-price-catalog');

test('RV page has no pricing funnel', () => {
  const page = read('rv-detailing.html');
  assert.doesNotMatch(page, /rv-pricing-funnel/);
  assert.doesNotMatch(page, /data-rv-price-funnel/);
  assert.doesNotMatch(page, /CHECK PRICE &amp; AVAILABILITY/);
  assert.ok(!fs.existsSync(path.join(root, 'assets/rv-pricing-funnel.js')));
});

test('Package CTAs use package-booking-cta into six-step booking', () => {
  const page = read('rv-detailing.html');
  assert.match(page, /package-booking-cta/);
  assert.match(page, /data-booking-category="rvs"/);
  assert.match(read('assets/specialty-booking-bridge.js'), /openCategoryPackageBooking/);
  assert.match(read('index.html'), /Step 03 — Vehicle/);
});

test('Maint uses base+ratePerFoot authoritative table', () => {
  assert.equal(LENGTH_PRICING.rvs.packages.maint.base, 130);
  assert.equal(LENGTH_PRICING.rvs.packages.maint.ratePerFoot, 10);
  assert.equal(getLengthPrice('rvs', 'maint', 19, 'travel'), 290);
  assert.notEqual(getLengthPrice('rvs', 'maint', 19, 'travel'), Math.max(129, Math.round(8.5 * 19)));
});

test('Exact length pricing differs below 24 ft', () => {
  assert.notEqual(getLengthPrice('rvs', 'maint', 19, 'travel'), getLengthPrice('rvs', 'maint', 24, 'travel'));
});
