'use strict';

/**
 * CARDDETAIL1 — vehicle classification engine regression.
 *
 * Canonical path:
 *   MODELS[make].t[model] (+ year overrides)
 *   → CD1VehicleClass.resolveVehicleClassification
 *   → { tierKey, displayLabel, body, rows }
 *   → pricing (PRICING.cars.tiers[tierKey]) AND customer display
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const {
  resolveVehicleClassification,
  YEAR_OVERRIDES,
} = require('../assets/vehicle-class-resolver.js');
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
  return vm.runInNewContext('(' + from.slice(0, end) + ')');
}

function catalogTier(models, make, model) {
  return models[make]?.t?.[model] ?? null;
}

function resolve(models, make, model, year) {
  return resolveVehicleClassification({
    make,
    model,
    year,
    catalogTierKey: catalogTier(models, make, model),
  });
}

function interiorTotal(tierKey) {
  const r = computeVehicleSubtotal(
    {
      cat: 'cars',
      pkgId: 'interior',
      tierKey,
      tierLabel: PRICING.cars.tiers[tierKey].label,
      vehicleLabel: 'test',
      addons: [],
    },
    '07601'
  );
  assert.equal(r.ok, true);
  return r.basePrice;
}

test('resolver script is the single classification engine on booking pages', () => {
  for (const page of BOOKING_PAGES) {
    const html = read(page);
    assert.match(html, /assets\/vehicle-class-resolver\.js/);
    assert.match(html, /resolveVehicleClassification/);
    assert.doesNotMatch(html, /MODELS\[ST\.make\]\?\.t\[ST\.model\]\|\|'small'/);
  }
});

test('Grand Caravan → Minivan display + suv3 pricing (not SUV 2-Row)', () => {
  const models = extractModels(read('index.html'));
  const r = resolve(models, 'Dodge', 'Grand Caravan', 2022);
  assert.equal(r.ok, true);
  assert.notEqual(r.tierKey, 'suv2');
  assert.equal(r.tierKey, 'suv3');
  assert.equal(r.body, 'minivan');
  assert.equal(r.displayLabel, 'Minivan');
  assert.equal(r.rows, 3);
  assert.equal(interiorTotal(r.tierKey), 235);
  assert.notEqual(interiorTotal(r.tierKey), PRICING.cars.tiers.suv2.interior);
});

test('Santa Fe 2025 → 3-Row SUV + suv3 pricing (year override)', () => {
  const models = extractModels(read('index.html'));
  assert.equal(catalogTier(models, 'Hyundai', 'Santa Fe'), 'suv2', 'catalog default remains pre-2024 2-row');
  assert.ok(YEAR_OVERRIDES['Hyundai|Santa Fe']);

  const old = resolve(models, 'Hyundai', 'Santa Fe', 2022);
  assert.equal(old.tierKey, 'suv2');
  assert.equal(old.displayLabel, '2-Row SUV');
  assert.equal(old.rows, 2);
  assert.equal(interiorTotal(old.tierKey), 215);

  const neu = resolve(models, 'Hyundai', 'Santa Fe', 2025);
  assert.equal(neu.ok, true);
  assert.equal(neu.tierKey, 'suv3');
  assert.equal(neu.body, 'suv3');
  assert.equal(neu.displayLabel, '3-Row SUV');
  assert.equal(neu.rows, 3);
  assert.equal(neu.source, 'year_override');
  assert.equal(interiorTotal(neu.tierKey), 235);
});

test('minivan sample → Minivan / suv3', () => {
  const models = extractModels(read('index.html'));
  const sample = [
    ['Dodge', 'Grand Caravan', 2020],
    ['Chrysler', 'Pacifica', 2024],
    ['Honda', 'Odyssey', 2024],
    ['Toyota', 'Sienna', 2024],
  ];
  for (const [make, model, year] of sample) {
    const r = resolve(models, make, model, year);
    assert.equal(r.displayLabel, 'Minivan', `${make} ${model}`);
    assert.equal(r.tierKey, 'suv3', `${make} ${model}`);
    assert.equal(r.rows, 3, `${make} ${model}`);
  }
});

test('3-row SUV sample → 3-Row SUV / suv3 where canonical year supports it', () => {
  const models = extractModels(read('index.html'));
  const sample = [
    ['Hyundai', 'Santa Fe', 2025],
    ['Hyundai', 'Palisade', 2024],
    ['Kia', 'Telluride', 2024],
    ['Honda', 'Pilot', 2024],
    ['Toyota', 'Highlander', 2024],
    ['Ford', 'Explorer', 2024],
  ];
  for (const [make, model, year] of sample) {
    const r = resolve(models, make, model, year);
    assert.equal(r.displayLabel, '3-Row SUV', `${make} ${model}`);
    assert.equal(r.tierKey, 'suv3', `${make} ${model}`);
    assert.equal(r.rows, 3, `${make} ${model}`);
    assert.notEqual(r.displayLabel, 'Minivan', `${make} ${model}`);
  }
});

test('2-row SUV controls remain 2-Row SUV / suv2', () => {
  const models = extractModels(read('index.html'));
  for (const [make, model] of [
    ['Honda', 'CR-V'],
    ['Toyota', 'RAV4'],
    ['Mazda', 'CX-5'],
  ]) {
    const r = resolve(models, make, model, 2024);
    assert.equal(r.tierKey, 'suv2', `${make} ${model}`);
    assert.equal(r.displayLabel, '2-Row SUV', `${make} ${model}`);
    assert.equal(r.rows, 2, `${make} ${model}`);
  }
});

test('display class === pricing-resolved class (same resolution object)', () => {
  const models = extractModels(read('index.html'));
  const cases = [
    ['Dodge', 'Grand Caravan', 2022],
    ['Hyundai', 'Santa Fe', 2025],
    ['Honda', 'CR-V', 2024],
  ];
  for (const [make, model, year] of cases) {
    const r = resolve(models, make, model, year);
    assert.equal(r.ok, true);
    // Pricing uses tierKey; display uses displayLabel from same resolve() result.
    assert.ok(PRICING.cars.tiers[r.tierKey], 'pricing tier exists');
    assert.ok(r.displayLabel, 'display label present');
    assert.equal(interiorTotal(r.tierKey), PRICING.cars.tiers[r.tierKey].interior);
  }

  const html = read('index.html');
  assert.match(html, /ST\.displayLabel=resolved\.displayLabel/);
  assert.match(html, /ST\.tierKey=resolved\.tierKey/);
  assert.match(
    html,
    /tierLabel:\s*ST\.displayLabel \|\| \(ST\.tier \? ST\.tier\.label : ''\)/
  );
});

test('unknown / unmapped model does not silently default to small or suv2', () => {
  const r = resolveVehicleClassification({
    make: 'UnknownMake',
    model: 'UnknownModel',
    year: 2024,
    catalogTierKey: null,
  });
  assert.equal(r.ok, false);
  assert.equal(r.needsConfirmation, true);
  assert.equal(r.tierKey, null);
  assert.notEqual(r.tierKey, 'small');
  assert.notEqual(r.tierKey, 'suv2');

  const html = read('index.html');
  assert.match(html, /needsConfirmation|Needs confirmation|Vehicle size needs confirmation/);
  assert.match(html, /classNeedsConfirm=true/);
});

test('all booking pages keep sample mappings + resolver wiring', () => {
  for (const page of BOOKING_PAGES) {
    const models = extractModels(read(page));
    assert.equal(resolve(models, 'Dodge', 'Grand Caravan', 2022).displayLabel, 'Minivan', page);
    assert.equal(resolve(models, 'Hyundai', 'Santa Fe', 2025).tierKey, 'suv3', page);
    assert.equal(resolve(models, 'Honda', 'CR-V', 2024).tierKey, 'suv2', page);
    assert.equal(resolve(models, 'Honda', 'Pilot', 2024).tierKey, 'suv3', page);
  }
});
