'use strict';

/**
 * Phase A: each cars + powersports pricing class has a distinct studio render,
 * and body-style precision (minivan / cruiser / sportbike / UTV) beats generic tiers.
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
  'sedan.webp',
  'suv-crossover.webp',
  'suv-3row.webp',
  'compact-van.webp',
  'midsize-van.webp',
  'cargo-van.webp',
  'passenger-van.webp',
  'minivan.webp',
  'truck.webp',
  'motorcycle.webp',
  'cruiser.webp',
  'sportbike.webp',
  'atv.webp',
  'utv.webp',
  'jetski.webp',
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
    ST: { cat: 'cars', tierKey: '', vehicleLabel: '', body: null, boatType: '' },
  };
  const api = vm.runInNewContext(chunk, sandbox);
  return { api, ST: sandbox.ST };
}

test('Phase A studio assets exist and are pairwise distinct', () => {
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

test('TIER_VISUAL_KEYS maps each van class to a distinct visual key', () => {
  assert.match(index, /compact_van:'compact_van'/);
  assert.match(index, /midsize_van:'midsize_van'/);
  assert.match(index, /full_size_van:'cargo_van'/);
  assert.match(index, /full_size_van_passenger:'passenger_van'/);
});

test('VEHICLE_VISUALS points cars + powersports classes at studio renders', () => {
  for (const file of REQUIRED) {
    assert.match(index, new RegExp(`assets/vehicles/studio/${file.replace('.', '\\.')}`));
  }
});

test('icon3dTier prefers studio renders for every cars + powersports tier', () => {
  assert.match(icon3d, /STUDIO_BASE/);
  for (const [tier, file] of Object.entries(TIER_TO_FILE)) {
    assert.match(icon3d, new RegExp(`${tier}:\\s*\\{[^}]*${file.replace('.', '\\.')}`));
  }
});

test('getVehicleVisualKey prefers body-style precision before pricing tier', () => {
  const start = index.indexOf('function getVehicleVisualKey');
  assert.ok(start > 0);
  const chunk = index.slice(start, start + 2600);
  const fleet = chunk.indexOf("if(cat==='fleet')");
  assert.ok(fleet > 0, 'missing fleet branch');
  const carsTail = chunk.slice(fleet);
  const bodyPref = carsTail.indexOf(
    'if(ST.body && VEHICLE_VISUALS[ST.body] && PRECISION_VISUAL_KEYS[ST.body]) return ST.body'
  );
  const precise = carsTail.indexOf('const precise=modelMapVisual(lbl, PRECISION_VISUAL_KEYS)');
  const tierPref = carsTail.indexOf(
    'if(ST.tierKey && TIER_VISUAL_KEYS[ST.tierKey]) return TIER_VISUAL_KEYS[ST.tierKey]'
  );
  assert.ok(bodyPref > 0, 'missing body preference');
  assert.ok(precise > bodyPref, 'model precision must run after body');
  assert.ok(tierPref > precise, 'tier preference must run after precision');
});

test('precision visuals: Odyssey minivan, RZR UTV, Harley cruiser, Hayabusa sportbike', () => {
  const { api, ST } = loadVisualRuntime();
  const { getVehicleVisualKey } = api;

  ST.cat = 'cars';
  ST.tierKey = 'suv3';
  ST.vehicleLabel = '2021 Honda Odyssey';
  ST.body = 'minivan';
  assert.equal(getVehicleVisualKey(), 'minivan');

  ST.body = null;
  assert.equal(getVehicleVisualKey(), 'minivan');

  ST.vehicleLabel = '2020 Honda Civic';
  ST.tierKey = 'small';
  assert.equal(getVehicleVisualKey(), 'compact');

  ST.vehicleLabel = '2022 Honda CR-V';
  ST.tierKey = 'suv2';
  assert.equal(getVehicleVisualKey(), 'suv2');

  ST.cat = 'powersports';
  ST.tierKey = 'motorcycle';
  ST.vehicleLabel = '2024 Polaris RZR Turbo R';
  assert.equal(getVehicleVisualKey(), 'utv');

  ST.vehicleLabel = '2023 Harley-Davidson Street Glide';
  assert.equal(getVehicleVisualKey(), 'cruiser');

  ST.vehicleLabel = '2022 Suzuki Hayabusa';
  assert.equal(getVehicleVisualKey(), 'sportbike');
});

test('powersports confirm lets UTV/ATV model cues override a stale Motorcycle tier', () => {
  assert.match(index, /if\(ST\.cat==='powersports'\)\{\s*const inferred=inferPowersportsTier/);
  assert.match(index, /inferred==='utv' \|\| inferred==='atv'/);
  assert.doesNotMatch(index, /if\(ST\.cat==='powersports' && !ST\.tierKey\)/);
});
