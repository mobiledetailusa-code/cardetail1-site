'use strict';

/**
 * CARDDETAIL1 — Grand Caravan / minivan classification regression.
 *
 * Canonical car pricing tiers have no separate "minivan" key. Cardetail1 maps
 * minivans onto the 3-row passenger tier (`suv3` / "SUV 3-Row"), matching
 * Odyssey / Sienna / Carnival. Display label and package price both come from
 * MODELS[make].t[model] → PRICING.cars.tiers[tierKey].
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const { PRICING, computeVehicleSubtotal } = require('../netlify/lib/booking-price-catalog');

const BOOKING_PAGES = [
  'index.html',
  'bergen-county-hub.html',
  'hudson-county-hub.html',
  'essex-county-hub.html',
  'passaic-county-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
  'new-jersey-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'template-city.html',
];

function extractModels(html) {
  const start = html.indexOf('const MODELS = ');
  assert.ok(start >= 0, 'MODELS declaration missing');
  const from = html.slice(start + 'const MODELS = '.length);
  const end = from.indexOf(';\n');
  assert.ok(end > 0, 'MODELS terminator missing');
  const literal = from.slice(0, end);
  return vm.runInNewContext('(' + literal + ')');
}

function tierFor(models, make, model) {
  const row = models[make];
  assert.ok(row, `make missing: ${make}`);
  assert.ok(row.t && row.t[model], `model tier missing: ${make} ${model}`);
  return row.t[model];
}

function assertYearHandlerUsesSharedTier(html) {
  // year-sel change: one MODELS lookup drives both display chip + ST.tier pricing.
  assert.match(
    html,
    /const tierKey=MODELS\[ST\.make\]\?\.t\[ST\.model\]\|\|'small';/,
    'year handler must resolve tier from MODELS'
  );
  assert.match(
    html,
    /ST\.tierKey=tierKey;\s*ST\.tier=PRICING\.cars\.tiers\[tierKey\];/,
    'year handler must assign the same tierKey to display + pricing state'
  );
}

test('Grand Caravan is not SUV 2-Row; maps to canonical minivan/suv3 tier', () => {
  const models = extractModels(read('index.html'));
  const tier = tierFor(models, 'Dodge', 'Grand Caravan');
  assert.notEqual(tier, 'suv2');
  assert.equal(tier, 'suv3');
});

test('Pacifica / Odyssey / Sienna map to minivan-appropriate suv3 class', () => {
  const models = extractModels(read('index.html'));
  assert.equal(tierFor(models, 'Chrysler', 'Pacifica'), 'suv3');
  assert.equal(tierFor(models, 'Honda', 'Odyssey'), 'suv3');
  assert.equal(tierFor(models, 'Toyota', 'Sienna'), 'suv3');
});

test('2-row SUV stays suv2; 3-row SUV stays suv3', () => {
  const models = extractModels(read('index.html'));
  assert.equal(tierFor(models, 'Honda', 'CR-V'), 'suv2');
  assert.equal(tierFor(models, 'Honda', 'Pilot'), 'suv3');
});

test('classification used for display === classification used for pricing', () => {
  const html = read('index.html');
  const models = extractModels(html);
  assertYearHandlerUsesSharedTier(html);

  const tierKey = tierFor(models, 'Dodge', 'Grand Caravan');
  const clientTierMatch = html.match(/suv3:\s*\{label:'SUV 3-Row'/);
  assert.ok(clientTierMatch, 'client PRICING must label suv3 as SUV 3-Row');

  const serverTier = PRICING.cars.tiers[tierKey];
  assert.equal(serverTier.label, 'SUV 3-Row');

  const priced = computeVehicleSubtotal(
    {
      cat: 'cars',
      pkgId: 'interior',
      tierKey,
      tierLabel: serverTier.label,
      vehicleLabel: '2022 Dodge Grand Caravan',
      addons: [],
    },
    '07601'
  );
  assert.equal(priced.ok, true);
  assert.equal(priced.basePrice, 235);
  assert.equal(priced.subtotal, 235);
  assert.notEqual(priced.basePrice, PRICING.cars.tiers.suv2.interior);
});

test('all booking pages share the same minivan / SUV sample mappings', () => {
  for (const page of BOOKING_PAGES) {
    const models = extractModels(read(page));
    assert.equal(tierFor(models, 'Dodge', 'Grand Caravan'), 'suv3', page);
    assert.equal(tierFor(models, 'Chrysler', 'Pacifica'), 'suv3', page);
    assert.equal(tierFor(models, 'Chrysler', 'Voyager'), 'suv3', page);
    assert.equal(tierFor(models, 'Honda', 'Odyssey'), 'suv3', page);
    assert.equal(tierFor(models, 'Toyota', 'Sienna'), 'suv3', page);
    assert.equal(tierFor(models, 'Honda', 'CR-V'), 'suv2', page);
    assert.equal(tierFor(models, 'Honda', 'Pilot'), 'suv3', page);
    assertYearHandlerUsesSharedTier(read(page));
  }
});
