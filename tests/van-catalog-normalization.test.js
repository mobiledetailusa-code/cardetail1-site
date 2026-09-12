'use strict';

/**
 * Van taxonomy normalization — collisions, cargo/passenger pricing, Metris fix.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
  resolveVehicleClassification,
  DISPLAY,
} = require('../assets/vehicle-class-resolver.js');
const catalog = require('../assets/vehicle-catalog.js');
const { PRICING, computeVehicleSubtotal } = require('../netlify/lib/booking-price-catalog');

function round5(n) {
  return Math.round(Number(n) / 5) * 5;
}

function resolve(make, model, year) {
  return resolveVehicleClassification({ make, model, year });
}

function interior(tierKey) {
  const r = computeVehicleSubtotal({ cat: 'cars', pkgId: 'interior', tierKey }, '07601');
  assert.equal(r.ok, true, r.error || tierKey);
  return r.basePrice;
}

test('van DISPLAY keys exist and are not SUV labels', () => {
  assert.equal(DISPLAY.compact_van.label, 'Compact Van');
  assert.equal(DISPLAY.midsize_van.label, 'Midsize Van');
  assert.equal(DISPLAY.full_size_van.label, 'Full-Size Cargo Van');
  assert.equal(DISPLAY.full_size_van_passenger.label, 'Full-Size Passenger Van');
  assert.equal(/SUV/i.test(DISPLAY.full_size_van.label), false);
  assert.equal(/SUV/i.test(DISPLAY.midsize_van.label), false);
});

test('Metris is midsize_van (SUV defect fixed)', () => {
  const r = resolve('Mercedes-Benz', 'Metris', 2021);
  assert.equal(r.ok, true);
  assert.equal(r.tierKey, 'midsize_van');
  assert.match(r.displayLabel, /Midsize/i);
  assert.equal(/SUV/i.test(r.displayLabel), false);
  assert.equal(interior(r.tierKey), PRICING.cars.tiers.suv3.interior);
});

test('collision-safe model resolution', () => {
  const pairs = [
    ['Ford', 'Transit', 'Ford', 'Transit Connect'],
    ['Ram', 'ProMaster', 'Ram', 'ProMaster City'],
    ['Nissan', 'NV', 'Nissan', 'NV200'],
    ['Chevrolet', 'Express', 'Chevrolet', 'City Express'],
    ['Mercedes-Benz', 'Sprinter', 'Mercedes-Benz', 'Metris'],
  ];
  for (const [m1, mod1, m2, mod2] of pairs) {
    const a = catalog.resolveVehicle({ make: m1, model: mod1, year: 2019 });
    const b = catalog.resolveVehicle({ make: m2, model: mod2, year: 2019 });
    assert.equal(a.ok, true, mod1);
    assert.equal(b.ok, true, mod2);
    assert.equal(a.canonicalModel, mod1);
    assert.equal(b.canonicalModel, mod2);
    assert.notEqual(a.canonicalModel, b.canonicalModel);
  }
});

test('cargo vs passenger selectables map to distinct full-size prices', () => {
  const cargo = catalog.resolveVehicle({ make: 'Ford', model: 'Transit Cargo', year: 2022 });
  const pass = catalog.resolveVehicle({ make: 'Ford', model: 'Transit Passenger', year: 2022 });
  assert.equal(cargo.ok, true);
  assert.equal(pass.ok, true);
  assert.equal(cargo.canonicalModel, 'Transit');
  assert.equal(pass.canonicalModel, 'Transit');
  assert.equal(cargo.vanUse, 'cargo');
  assert.equal(pass.vanUse, 'passenger');
  assert.equal(cargo.pricingClass, 'full_size_van');
  assert.equal(pass.pricingClass, 'full_size_van_passenger');
  assert.equal(cargo.displayLabel, 'Full-Size Cargo Van');
  assert.equal(pass.displayLabel, 'Full-Size Passenger Van');
  assert.equal(interior(cargo.pricingClass), 260);
  assert.equal(interior(pass.pricingClass), 270);
});

test('package-by-package van pricing proof vs minivan/suv3', () => {
  const mv = PRICING.cars.tiers.suv3;
  const pkgs = ['wash', 'maint', 'interior', 'full', 'refresh', 'premium'];
  for (const p of pkgs) {
    assert.equal(PRICING.cars.tiers.compact_van[p], mv[p], p);
    assert.equal(PRICING.cars.tiers.midsize_van[p], mv[p], p);
    assert.equal(PRICING.cars.tiers.full_size_van[p], round5(mv[p] * 1.1), p);
    assert.equal(PRICING.cars.tiers.full_size_van_passenger[p], round5(mv[p] * 1.15), p);
    assert.equal(typeof PRICING.cars.tiers.full_size_van[p], 'number');
    assert.ok(Number.isFinite(PRICING.cars.tiers.full_size_van_passenger[p]));
  }
});

test('minivan controls unchanged (Odyssey / Sienna)', () => {
  for (const [make, model] of [
    ['Honda', 'Odyssey'],
    ['Toyota', 'Sienna'],
  ]) {
    const r = resolve(make, model, 2022);
    assert.equal(r.tierKey, 'suv3');
    assert.equal(r.body, 'minivan');
    assert.equal(r.displayLabel, 'Minivan');
    assert.equal(interior(r.tierKey), 235);
  }
});

test('Explorer remains SUV', () => {
  const r = resolve('Ford', 'Explorer', 2022);
  assert.equal(r.tierKey, 'suv3');
  assert.match(r.displayLabel, /SUV|3-Row/i);
});

test('SoT van metadata populated for target families', () => {
  const sot = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/cars-vehicle-catalog.json'), 'utf8'));
  assert.ok(sot.pricingClasses.includes('compact_van'));
  assert.ok(sot.pricingClasses.includes('midsize_van'));
  assert.ok(sot.pricingClasses.includes('full_size_van_passenger'));
  const transit = sot.vehicles.find((v) => v.make === 'Ford' && v.model === 'Transit');
  assert.equal(transit.vehicleFamily, 'van');
  assert.equal(transit.vanSize, 'full_size');
  assert.deepEqual(transit.vanUseOptions, ['cargo', 'passenger']);
  assert.ok(transit.aliases.some((a) => /T-250|Transit 250/i.test(a)));
});

test('MODELS projections include Cargo/Passenger selectables after sync', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /"Transit Cargo"/);
  assert.match(html, /"Transit Passenger"/);
  assert.match(html, /"Express Cargo"/);
  assert.match(html, /"Metris Cargo"/);
  assert.match(html, /"City Express"/);
});
