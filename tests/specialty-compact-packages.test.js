'use strict';

/**
 * Specialty categories share compact package rows + add-on grid chrome
 * (trucks / boats / RVs / powersports). Cars remain vehicle-first; specialty
 * stays package-first. Display name for trucks is Semi Trucks.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const progress = fs.readFileSync(path.join(root, 'assets/booking-progress.js'), 'utf8');

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

test('usesCompactPackageUi covers cars and specialty, not fleet', () => {
  assert.match(html, /function usesCompactPackageUi\(cat\)/);
  const fn = extractFunction(html, 'usesCompactPackageUi');
  const sandbox = { ST: { cat: 'cars' } };
  vm.createContext(sandbox);
  vm.runInContext(fn + '\nthis.usesCompactPackageUi = usesCompactPackageUi;', sandbox);
  assert.equal(sandbox.usesCompactPackageUi('cars'), true);
  assert.equal(sandbox.usesCompactPackageUi('trucks'), true);
  assert.equal(sandbox.usesCompactPackageUi('boats'), true);
  assert.equal(sandbox.usesCompactPackageUi('rvs'), true);
  assert.equal(sandbox.usesCompactPackageUi('powersports'), true);
  assert.equal(sandbox.usesCompactPackageUi('fleet'), false);
});

test('renderPackages uses compact UI for specialty categories', () => {
  assert.match(html, /const useCompact = usesCompactPackageUi\(cat\);/);
  assert.doesNotMatch(html, /const useCompact = cat==='cars';/);
  assert.match(html, /function compactPackagePriceLabel\(/);
  assert.match(html, /function getPkgCompactMeta\(/);
  assert.match(html, /PKG_COMPACT_META_BY_CAT/);
  assert.match(html, /trucks:\s*\{[\s\S]*?int_wash:/);
  assert.match(html, /boats:\s*\{[\s\S]*?essential:/);
  assert.match(html, /powersports:\s*\{[\s\S]*?maintenance:/);
});

test('specialty keeps package-first flow (auto-advance to vehicle)', () => {
  assert.match(html, /function carsVehicleFirstFlow\(\)\s*\{\s*return ST\.cat === 'cars';\s*\}/);
  assert.match(html, /Specialty \/ package-first: auto-advance to vehicle/);
  assert.match(html, /function syncSpecialtyAddonsChrome\(/);
});

test('compact add-ons chrome is not cars-only', () => {
  assert.match(html, /const compactUi = usesCompactPackageUi\(ST\.cat\);/);
  assert.doesNotMatch(html, /const compactUi = carsVehicleFirstFlow\(\);/);
});

test('booking category card and labels say Semi Trucks (not generic Trucks)', () => {
  assert.match(html, /id="bkcat-trucks"[\s\S]*?<div class="svc-name"[^>]*>Semi Trucks<\/div>/);
  assert.match(html, /svc-desc[^>]*>Semi truck · Day cab · Sleeper cab/);
  assert.match(html, /trucks:\s*\{\s*ico:'🚛',\s*name:'Semi Trucks'/);
  assert.match(html, /Semi trucks, boats, RVs/);
  assert.match(progress, /trucks:\s*'Semi Trucks'/);
  assert.doesNotMatch(html, /id="bkcat-trucks"[\s\S]*?<div class="svc-name"[^>]*>Trucks<\/div>/);
});

test('boat/RV compact price labels stay length-based (no fake flat price)', () => {
  const fn = extractFunction(html, 'compactPackagePriceLabel');
  const sandbox = {
    ST: { tierKey: '' },
    LENGTH_PRICING: {
      boats: { packages: { full: { min: 380 } } },
      rvs: { packages: { full_basic: { base: 255, ratePerFoot: 21 } } },
    },
    applyRichPrice: (n) => n,
    getTravelFeeAmount: () => 0,
    powersportsPublicFromPriceForPackage: () => 175,
  };
  vm.createContext(sandbox);
  vm.runInContext(fn + '\nthis.compactPackagePriceLabel = compactPackagePriceLabel;', sandbox);
  assert.equal(
    sandbox.compactPackagePriceLabel('boats', { id: 'full' }, { tiers: {} }),
    'From $380'
  );
  assert.equal(
    sandbox.compactPackagePriceLabel('rvs', { id: 'full_basic' }, { tiers: {} }),
    'By length'
  );
  assert.equal(
    sandbox.compactPackagePriceLabel(
      'trucks',
      { id: 'int_wash' },
      { tiers: { day_cab: { int_wash: 400 } } }
    ),
    'From $400'
  );
});
