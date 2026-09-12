'use strict';

/**
 * Expanded studio visual map: body-style precision across cars, powersports, boats, RVs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const icon3d = fs.readFileSync(path.join(root, 'assets/icon-3d.js'), 'utf8');

const REQUIRED = [
  'sedan.webp','coupe.webp','convertible.webp','wagon.webp','offroad-suv.webp',
  'suv-crossover.webp','suv-3row.webp','minivan.webp',
  'compact-van.webp','midsize-van.webp','cargo-van.webp','passenger-van.webp','truck.webp',
  'motorcycle.webp','cruiser.webp','sportbike.webp','dirtbike.webp','scooter.webp',
  'atv.webp','utv.webp','golf-cart.webp','jetski.webp',
  'runabout.webp','pontoon.webp','bass-boat.webp','cabin-cruiser.webp','sailboat.webp',
  'rv-class-a.webp','rv-class-b.webp','travel-trailer.webp','fifth-wheel.webp','airstream.webp',
];

const TIER_TO_FILE = {
  small: 'sedan.webp',
  suv2: 'suv-crossover.webp',
  suv3: 'suv-3row.webp',
  compact_van: 'compact-van.webp',
  midsize_van: 'midsize-van.webp',
  full_size_van: 'cargo-van.webp',
  full_size_van_passenger: 'passenger-van.webp',
  truck: 'truck.webp',
  motorcycle: 'motorcycle.webp',
  atv: 'atv.webp',
  utv: 'utv.webp',
  jetski: 'jetski.webp',
};

function loadVisualRuntime() {
  const start = index.indexOf('const VEHICLE_VISUALS');
  const end = index.indexOf('function setVehicleVisual');
  assert.ok(start > 0 && end > start);
  const chunk =
    index.slice(start, end) +
    '\n;({VEHICLE_VISUALS,TIER_VISUAL_KEYS,MODEL_MAP,PRECISION_VISUAL_KEYS,modelMapVisual,getVehicleVisualKey});';
  const sandbox = {
    ST: { cat: 'cars', tierKey: '', vehicleLabel: '', body: null, boatType: '', rvType: '' },
  };
  return { api: vm.runInNewContext(chunk, sandbox), ST: sandbox.ST };
}

test('expanded studio assets exist and are pairwise distinct', () => {
  const hashes = new Map();
  for (const file of REQUIRED) {
    const p = path.join(root, 'assets/vehicles/studio', file);
    assert.ok(fs.existsSync(p), `missing ${file}`);
    const buf = fs.readFileSync(p);
    assert.ok(buf.length > 1000, `${file} too small`);
    const h = crypto.createHash('md5').update(buf).digest('hex');
    assert.equal(hashes.has(h), false, `${file} duplicates ${hashes.get(h)}`);
    hashes.set(h, file);
  }
});

test('VEHICLE_VISUALS references every expanded studio asset', () => {
  for (const file of REQUIRED) {
    assert.match(index, new RegExp(`assets/vehicles/studio/${file.replace('.', '\\.')}`));
  }
});

test('icon3dTier still maps pricing tiers to studio renders', () => {
  assert.match(icon3d, /STUDIO_BASE/);
  for (const [tier, file] of Object.entries(TIER_TO_FILE)) {
    assert.match(icon3d, new RegExp(`${tier}:\\s*\\{[^}]*${file.replace('.', '\\.')}`));
  }
});

test('getVehicleVisualKey prefers body-style precision before pricing tier', () => {
  const start = index.indexOf('function getVehicleVisualKey');
  const chunk = index.slice(start, start + 3200);
  assert.match(chunk, /if\(cat==='boats'\)/);
  assert.match(chunk, /if\(cat==='rvs'\)/);
  const fleet = chunk.indexOf("if(cat==='fleet')");
  assert.ok(fleet > 0);
  const carsTail = chunk.slice(fleet);
  assert.ok(carsTail.indexOf('PRECISION_VISUAL_KEYS[ST.body]') > 0);
  assert.ok(carsTail.indexOf('modelMapVisual(lbl, PRECISION_VISUAL_KEYS)') > 0);
  assert.ok(
    carsTail.indexOf('if(ST.tierKey && TIER_VISUAL_KEYS[ST.tierKey]) return TIER_VISUAL_KEYS[ST.tierKey]') >
      carsTail.indexOf('modelMapVisual(lbl, PRECISION_VISUAL_KEYS)')
  );
});

test('precision across categories: cars, powersports, boats, rvs', () => {
  const { api, ST } = loadVisualRuntime();
  const { getVehicleVisualKey } = api;

  ST.cat = 'cars';
  ST.tierKey = 'suv3';
  ST.vehicleLabel = '2021 Honda Odyssey';
  ST.body = null;
  assert.equal(getVehicleVisualKey(), 'minivan');

  ST.vehicleLabel = '2020 Ford Mustang';
  ST.tierKey = 'small';
  assert.equal(getVehicleVisualKey(), 'coupe');

  ST.vehicleLabel = '2022 Jeep Wrangler';
  ST.tierKey = 'suv2';
  assert.equal(getVehicleVisualKey(), 'offroad');

  ST.vehicleLabel = '2021 Subaru Outback';
  assert.equal(getVehicleVisualKey(), 'wagon');

  ST.cat = 'powersports';
  ST.tierKey = 'motorcycle';
  ST.vehicleLabel = '2024 Polaris RZR Turbo R';
  assert.equal(getVehicleVisualKey(), 'utv');

  ST.vehicleLabel = '2023 Harley-Davidson Street Glide';
  assert.equal(getVehicleVisualKey(), 'cruiser');

  ST.vehicleLabel = '2022 Suzuki Hayabusa';
  assert.equal(getVehicleVisualKey(), 'sportbike');

  ST.vehicleLabel = '2021 Honda CRF450R';
  assert.equal(getVehicleVisualKey(), 'dirtbike');

  ST.vehicleLabel = '2020 Vespa GTS 300';
  assert.equal(getVehicleVisualKey(), 'scooter');

  ST.vehicleLabel = '2023 Club Car Onward';
  assert.equal(getVehicleVisualKey(), 'golfcart');

  ST.cat = 'boats';
  ST.boatType = 'pontoon';
  ST.vehicleLabel = '2022 Bennington 22';
  assert.equal(getVehicleVisualKey(), 'pontoon');

  ST.boatType = 'bass';
  ST.vehicleLabel = '2021 Bass Tracker';
  assert.equal(getVehicleVisualKey(), 'bassboat');

  ST.boatType = 'cabincruiser';
  ST.vehicleLabel = '2019 Sea Ray Sundancer';
  assert.equal(getVehicleVisualKey(), 'cabincruiser');

  ST.boatType = 'other';
  ST.vehicleLabel = '2018 Catalina 22 Sailboat';
  assert.equal(getVehicleVisualKey(), 'sailboat');

  ST.cat = 'rvs';
  ST.rvType = 'airstream';
  ST.vehicleLabel = '2020 Airstream Flying Cloud';
  assert.equal(getVehicleVisualKey(), 'airstream');

  ST.rvType = 'fifthwheel';
  ST.vehicleLabel = '2021 Keystone Cougar';
  assert.equal(getVehicleVisualKey(), 'fifthwheel');

  ST.rvType = 'classa';
  ST.vehicleLabel = '2019 Winnebago Bounder';
  assert.equal(getVehicleVisualKey(), 'classa');

  ST.rvType = 'classb';
  ST.vehicleLabel = '2022 Winnebago Travato';
  assert.equal(getVehicleVisualKey(), 'classb');
});

test('powersports confirm still lets UTV/ATV override stale Motorcycle', () => {
  assert.match(index, /if\(ST\.cat==='powersports'\)\{\s*const inferred=inferPowersportsTier/);
  assert.match(index, /inferred==='utv' \|\| inferred==='atv'/);
});
