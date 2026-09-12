'use strict';

/**
 * Cardetail1 — full_size_van class + P0/P1 catalog repair regressions.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const {
  resolveVehicleClassification,
  MINIVAN_KEYS,
  DISPLAY,
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

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function extractModels(html) {
  const start = html.indexOf('const MODELS = ');
  assert.ok(start >= 0, 'MODELS missing');
  const from = html.slice(start + 'const MODELS = '.length);
  const end = from.indexOf(';\n');
  assert.ok(end > 0, 'MODELS terminator missing');
  return vm.runInNewContext(`(${from.slice(0, end)})`);
}

function extractMakes(html) {
  const start = html.indexOf('const MAKES = ');
  assert.ok(start >= 0, 'MAKES missing');
  const from = html.slice(start + 'const MAKES = '.length);
  const end = from.indexOf(';\n');
  return vm.runInNewContext(`(${from.slice(0, end)})`);
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

function interiorPrice(tierKey) {
  const r = computeVehicleSubtotal(
    { cat: 'cars', pkgId: 'interior', tierKey },
    '07601'
  );
  assert.equal(r.ok, true, `pricing failed for ${tierKey}: ${r.error || ''}`);
  return r.basePrice;
}

test('full_size_van is a published numeric cars tier (server)', () => {
  const tier = PRICING.cars.tiers.full_size_van;
  assert.ok(tier, 'full_size_van tier missing');
  for (const pkg of ['wash', 'maint', 'interior', 'full', 'refresh', 'premium']) {
    assert.equal(typeof tier[pkg], 'number');
    assert.ok(Number.isFinite(tier[pkg]));
  }
  const suv3 = PRICING.cars.tiers.suv3;
  for (const pkg of ['wash', 'maint', 'interior', 'full', 'refresh', 'premium']) {
    const expected = Math.round((suv3[pkg] * 1.1) / 5) * 5;
    assert.equal(tier[pkg], expected, `${pkg} should be suv3+10% round5`);
  }
});

test('DISPLAY includes full_size_van', () => {
  assert.equal(DISPLAY.full_size_van.label, 'Full-Size Cargo Van');
});

test('P0 van reclass: Transit/Express/ProMaster/Sprinter/Savana/NV → full_size_van', () => {
  const models = extractModels(read('index.html'));
  for (const [make, model] of [
    ['Ford', 'Transit'],
    ['Chevrolet', 'Express'],
    ['Ram', 'ProMaster'],
    ['Mercedes-Benz', 'Sprinter'],
    ['GMC', 'Savana'],
    ['Nissan', 'NV'],
  ]) {
    const r = resolve(models, make, model, 2020);
    assert.equal(r.ok, true, `${make} ${model}`);
    assert.equal(r.tierKey, 'full_size_van', `${make} ${model}`);
    assert.equal(r.body, 'full_size_van', `${make} ${model}`);
    assert.equal(r.displayLabel, 'Full-Size Cargo Van', `${make} ${model}`);
    assert.equal(interiorPrice(r.tierKey), PRICING.cars.tiers.full_size_van.interior);
  }
});

test('P0 compact/midsize vans are not SUVs and not full_size_van', () => {
  const models = extractModels(read('index.html'));
  for (const [make, model, tier] of [
    ['Ford', 'Transit Connect', 'compact_van'],
    ['Ram', 'ProMaster City', 'compact_van'],
    ['Nissan', 'NV200', 'compact_van'],
    ['Mercedes-Benz', 'Metris', 'midsize_van'],
  ]) {
    const r = resolve(models, make, model, 2019);
    assert.equal(r.ok, true, `${make} ${model}`);
    assert.equal(r.tierKey, tier, `${make} ${model}`);
    assert.notEqual(r.tierKey, 'full_size_van', `${make} ${model}`);
    assert.notEqual(r.tierKey, 'suv2', `${make} ${model}`);
    assert.notEqual(r.tierKey, 'truck', `${make} ${model}`);
    assert.equal(interiorPrice(r.tierKey), PRICING.cars.tiers.suv3.interior);
  }
});

test('P0 Mach-E → suv2; ID.Buzz → Minivan/suv3; 4Runner → suv2', () => {
  const models = extractModels(read('index.html'));

  const machE = resolve(models, 'Ford', 'Mustang Mach-E', 2024);
  assert.equal(machE.tierKey, 'suv2');
  assert.equal(machE.displayLabel, '2-Row SUV');

  const buzz = resolve(models, 'Volkswagen', 'ID.Buzz', 2025);
  assert.equal(buzz.tierKey, 'suv3');
  assert.equal(buzz.body, 'minivan');
  assert.equal(buzz.displayLabel, 'Minivan');
  assert.ok(MINIVAN_KEYS.has('Volkswagen|ID.Buzz'));

  const runner = resolve(models, 'Toyota', '4Runner', 2022);
  assert.equal(runner.tierKey, 'suv2');
  assert.equal(runner.displayLabel, '2-Row SUV');
});

test('P1 EV makes and high-impact models are present', () => {
  const models = extractModels(read('index.html'));
  const makes = extractMakes(read('index.html'));
  for (const make of ['Rivian', 'Lucid', 'Polestar']) {
    assert.ok(makes.includes(make), make);
    assert.ok(models[make], make);
  }
  assert.equal(catalogTier(models, 'Rivian', 'R1T'), 'truck');
  assert.equal(catalogTier(models, 'Rivian', 'R1S'), 'suv3');
  assert.equal(catalogTier(models, 'Lucid', 'Air'), 'small');
  assert.equal(catalogTier(models, 'Lucid', 'Gravity'), 'suv3');
  assert.equal(catalogTier(models, 'Polestar', '2'), 'small');
  assert.equal(catalogTier(models, 'Toyota', 'Grand Highlander'), 'suv3');
  assert.equal(catalogTier(models, 'Toyota', 'Corolla Cross'), 'suv2');
  assert.equal(catalogTier(models, 'Ford', 'Fusion'), 'small');
  assert.equal(catalogTier(models, 'Chevrolet', 'Bolt EV'), 'small');
  assert.equal(catalogTier(models, 'Nissan', 'Ariya'), 'suv2');
  assert.equal(catalogTier(models, 'Chrysler', 'Town & Country'), 'suv3');
});

test('all booking pages share P0 van classifications + full_size_van pricing', () => {
  const server = PRICING.cars.tiers.full_size_van;
  for (const page of BOOKING_PAGES) {
    const html = read(page);
    const models = extractModels(html);
    assert.equal(catalogTier(models, 'Ford', 'Transit'), 'full_size_van', page);
    assert.equal(catalogTier(models, 'Ford', 'Transit Connect'), 'compact_van', page);
    assert.equal(catalogTier(models, 'Mercedes-Benz', 'Sprinter'), 'full_size_van', page);
    assert.equal(catalogTier(models, 'Mercedes-Benz', 'Metris'), 'midsize_van', page);
    assert.match(html, /full_size_van\s*:\s*\{/);
    assert.match(html, /compact_van\s*:\s*\{/);
    assert.match(html, /midsize_van\s*:\s*\{/);
    assert.match(html, /full_size_van_passenger\s*:\s*\{/);
    const start = html.indexOf('full_size_van:');
    assert.ok(start > 0, page);
    const slice = html.slice(start, start + 260);
    assert.match(slice, new RegExp(`interior:${server.interior}`), page);
    assert.match(html, /assets\/vehicle-class-resolver\.js/);
  }
});


test('canonical SoT owns P0/P1 additions (not HTML-only)', () => {
  const sot = JSON.parse(read('data/cars-vehicle-catalog.json'));
  const byKey = new Map(sot.vehicles.map((v) => [`${v.make}|${v.model}`, v]));
  for (const [make, model, tier] of [
    ['Ford', 'Transit', 'full_size_van'],
    ['Mercedes-Benz', 'Sprinter', 'full_size_van'],
    ['Ram', 'ProMaster', 'full_size_van'],
    ['Chevrolet', 'Express', 'full_size_van'],
    ['GMC', 'Savana', 'full_size_van'],
    ['Nissan', 'NV', 'full_size_van'],
    ['Ford', 'Transit Connect', 'compact_van'],
    ['Nissan', 'NV200', 'compact_van'],
    ['Mercedes-Benz', 'Metris', 'midsize_van'],
    ['Chevrolet', 'City Express', 'compact_van'],
    ['Rivian', 'R1S', 'suv3'],
    ['Toyota', 'Grand Highlander', 'suv3'],
  ]) {
    const v = byKey.get(`${make}|${model}`);
    assert.ok(v, `missing SoT ${make} ${model}`);
    assert.equal(v.pricingClass, tier);
    assert.notEqual(v.public, false);
  }
  assert.equal(byKey.get('Fixture|Full-Size Van Example')?.public, false);
});

test('sync --check has no drift after SoT port', () => {
  const { execSync } = require('node:child_process');
  execSync('node scripts/sync-vehicle-catalog.cjs --check', { cwd: ROOT, stdio: 'pipe' });
});
