'use strict';

/**
 * Phase A: each cars + powersports pricing class has a distinct silhouette.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const icon3d = fs.readFileSync(path.join(root, 'assets/icon-3d.js'), 'utf8');

const REQUIRED = [
  'small-car.svg',
  'suv-2row.svg',
  'suv-3row.svg',
  'compact-van.svg',
  'midsize-van.svg',
  'cargo-van.svg',
  'passenger-van.svg',
  'truck.svg',
  'motorcycle.svg',
  'atv.svg',
  'utv.svg',
  'jetski.svg',
];

const TIER_TO_FILE = {
  small: 'small-car.svg',
  suv2: 'suv-2row.svg',
  suv3: 'suv-3row.svg',
  compact_van: 'compact-van.svg',
  midsize_van: 'midsize-van.svg',
  full_size_van: 'cargo-van.svg',
  full_size_van_passenger: 'passenger-van.svg',
  truck: 'truck.svg',
  motorcycle: 'motorcycle.svg',
  atv: 'atv.svg',
  utv: 'utv.svg',
  jetski: 'jetski.svg',
};

test('Phase A silhouette assets exist and are pairwise distinct', () => {
  const hashes = new Map();
  for (const file of REQUIRED) {
    const p = path.join(root, 'assets/vehicles/silhouettes', file);
    assert.ok(fs.existsSync(p), `missing ${file}`);
    const buf = fs.readFileSync(p);
    assert.ok(buf.length > 200, `${file} too small`);
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
  assert.doesNotMatch(
    index,
    /compact_van:'van',\s*midsize_van:'van',\s*full_size_van:'van',\s*full_size_van_passenger:'van'/
  );
});

test('VEHICLE_VISUALS points cars + powersports classes at silhouettes', () => {
  for (const file of [
    'small-car.svg',
    'suv-2row.svg',
    'suv-3row.svg',
    'cargo-van.svg',
    'passenger-van.svg',
    'truck.svg',
    'motorcycle.svg',
    'utv.svg',
    'jetski.svg',
  ]) {
    assert.match(index, new RegExp(`assets/vehicles/silhouettes/${file.replace('.', '\\.')}`));
  }
});

test('icon3dTier prefers silhouettes for every cars + powersports tier', () => {
  assert.match(icon3d, /SILHOUETTE_BASE/);
  for (const [tier, file] of Object.entries(TIER_TO_FILE)) {
    assert.match(icon3d, new RegExp(`${tier}:\\s*\\{[^}]*${file.replace('.', '\\.')}`));
  }
});

test('getVehicleVisualKey prefers resolved tierKey before MODEL_MAP', () => {
  const start = index.indexOf('function getVehicleVisualKey');
  assert.ok(start > 0);
  const chunk = index.slice(start, start + 2200);
  const fleet = chunk.indexOf("if(cat==='fleet')");
  assert.ok(fleet > 0, 'missing fleet branch');
  const carsTail = chunk.slice(fleet);
  const tierPref = carsTail.indexOf('if(ST.tierKey && TIER_VISUAL_KEYS[ST.tierKey]) return TIER_VISUAL_KEYS[ST.tierKey]');
  const modelMap = carsTail.indexOf('for(const [k,t] of MODEL_MAP)');
  assert.ok(tierPref > 0, 'missing tier preference after fleet branch');
  assert.ok(modelMap > tierPref, 'MODEL_MAP must run after tier preference');
  assert.match(chunk, /if\(ST\.tierKey==='utv'\) return 'utv'/);
});
