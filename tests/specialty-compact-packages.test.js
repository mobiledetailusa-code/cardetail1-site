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
  assert.match(html, /id="bkcat-trucks"[\s\S]*?Day cab · Sleeper · Not pickups/);
  assert.match(html, /trucks:\s*\{\s*ico:'🚛',\s*name:'Semi Trucks'/);
  assert.match(html, /bk-cat-grid--tiles/);
  assert.match(html, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(html, /#bk-cat-grid #bkcat-trucks\{grid-column:1\/-1\}/);
  assert.doesNotMatch(html, /id="bk-cat-grid"[^>]*style="grid-template-columns:1fr"/);
  assert.doesNotMatch(html, /id="bkcat-trucks"[\s\S]*?<div class="svc-name"[^>]*>Trucks<\/div>/);
  assert.match(progress, /trucks:\s*'Semi Trucks'/);
});

test('Step 01 category tiles sit side-by-side (not stacked full-bleed)', () => {
  assert.match(html, /bk-cat-grid--tiles/);
  assert.match(html, /id="bk-cat-grid"/);
  assert.match(html, /id="bkcat-cars"/);
  assert.match(html, /id="bkcat-trucks"/);
  assert.match(html, /id="bkcat-boats"/);
  assert.match(html, /id="bkcat-rvs"/);
  assert.match(html, /id="bkcat-powersports"/);
  assert.doesNotMatch(html, /class="bk-cat-specialty-label"/);
  assert.doesNotMatch(html, /#bkcat-trucks\{grid-column:1\/-1\}/);
  assert.doesNotMatch(html, /style="grid-template-columns:1fr"/);
});

test('boat/RV compact price labels stay length-based (no fake flat price)', () => {
  const fn = extractFunction(html, 'compactPackagePriceLabel');
  const sandbox = {
    ST: { tierKey: '' },
    LENGTH_PRICING: {
      boats: { packages: { full: { min: 435 } } },
      rvs: { packages: { full_basic: { base: 295, ratePerFoot: 24 } } },
    },
    applyRichPrice: (n) => n,
    getTravelFeeAmount: () => 0,
    powersportsPublicFromPriceForPackage: () => 200,
  };
  vm.createContext(sandbox);
  vm.runInContext(fn + '\nthis.compactPackagePriceLabel = compactPackagePriceLabel;', sandbox);
  assert.equal(
    sandbox.compactPackagePriceLabel('boats', { id: 'full' }, { tiers: {} }),
    'From $435'
  );
  assert.equal(
    sandbox.compactPackagePriceLabel('rvs', { id: 'full_basic' }, { tiers: {} }),
    'By length'
  );
  assert.equal(
    sandbox.compactPackagePriceLabel(
      'trucks',
      { id: 'int_wash' },
      { tiers: { day_cab: { int_wash: 460 } } }
    ),
    'From $460'
  );
});

test('boat packages use complete marine descriptions (no cascade "previous package included")', () => {
  const boatsIdx = html.indexOf('boats: {');
  const rvsIdx = html.indexOf('rvs: {', boatsIdx);
  assert.ok(boatsIdx > 0 && rvsIdx > boatsIdx);
  const boatsBlock = html.slice(boatsIdx, rvsIdx);
  assert.doesNotMatch(boatsBlock, /Marine Wash included|Essential Marine included|Full Marine Detail included/i);
  assert.doesNotMatch(boatsBlock, /Everything in |plus the |previous package/i);
  for (const id of ["id:'maint'", "id:'essential'", "id:'full'", "id:'premium'"]) {
    assert.match(boatsBlock, new RegExp(id + "[\\s\\S]*?feats:\\[[\\s\\S]*?Exterior hull wash above the waterline"));
  }
  assert.match(boatsBlock, /id:'essential'[\s\S]*?Non-skid surfaces scrubbed/);
  assert.match(boatsBlock, /id:'essential'[\s\S]*?Vinyl seats and cushions cleaned and conditioned/);
  assert.match(boatsBlock, /id:'full'[\s\S]*?Marine wax or sealant applied to exterior gel coat/);
  assert.match(boatsBlock, /id:'full'[\s\S]*?Cockpit and cabin deep clean when present/);
  assert.match(boatsBlock, /id:'premium'[\s\S]*?Machine-applied marine wax or sealant/);
  assert.match(boatsBlock, /id:'premium'[\s\S]*?Oxidation assessment with light improvement where achievable/);
  assert.match(boatsBlock, /Windshield cleaned/);
  assert.doesNotMatch(boatsBlock, /\bGlass\b/);
});

test('RV/trailer packages group into Exterior, Interior, and Interior + Exterior', () => {
  assert.match(html, /function groupPackagesForDisplay\(/);
  assert.match(html, /pkg-c-section/);
  assert.match(html, /pkg-grid--rv-grouped/);
  const fn = extractFunction(html, 'groupPackagesForDisplay');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fn + '\nthis.groupPackagesForDisplay = groupPackagesForDisplay;', sandbox);
  const pkgs = [
    { id: 'maint', scope: 'ext' },
    { id: 'maint_light', scope: 'both' },
    { id: 'interior', scope: 'int' },
    { id: 'full_basic', scope: 'both' },
    { id: 'premium', scope: 'ext' },
    { id: 'full', scope: 'both' },
  ];
  const groups = sandbox.groupPackagesForDisplay('rvs', pkgs);
  assert.equal(groups.length, 3);
  assert.equal(String(groups[0].label), 'Exterior');
  assert.equal(String(groups[1].label), 'Interior');
  assert.equal(String(groups[2].label), 'Interior + Exterior');
  assert.equal(groups[0].items.map((p) => p.id).join(','), 'maint,premium');
  assert.equal(groups[1].items.map((p) => p.id).join(','), 'interior');
  assert.equal(groups[2].items.map((p) => p.id).join(','), 'maint_light,full_basic,full');
  const cars = sandbox.groupPackagesForDisplay('cars', [{ id: 'full' }, { id: 'wash' }]);
  assert.equal(cars.length, 1);
  assert.equal(String(cars[0].label), '');
});

test('RV combined packages split includes into Interior and Exterior sections', () => {
  assert.match(html, /function renderPkgCompactDetails\(/);
  assert.match(html, /function formatPkgFeatureLabel\(/);
  const formatFn = extractFunction(html, 'formatPkgFeatureLabel');
  const renderFn = extractFunction(html, 'renderPkgCompactDetails');
  const sandbox = { ENGINE_BAY_DETAIL_NOTE: 'note' };
  vm.createContext(sandbox);
  vm.runInContext(
    formatFn + '\n' + renderFn +
      '\nthis.formatPkgFeatureLabel = formatPkgFeatureLabel;' +
      '\nthis.renderPkgCompactDetails = renderPkgCompactDetails;',
    sandbox
  );

  // Pull maint_light ext/int from live PRICING copy in index.html
  assert.match(html, /id:'maint_light'[\s\S]*?ext:\[[^\]]+\][\s\S]*?int:\[[^\]]+Interior mirrors and windshield/);
  assert.doesNotMatch(html, /Interior mirrors and glass/);
  assert.doesNotMatch(html, /id:'maint_light'[\s\S]*?feats:\[[^\]]*glass[^\]]*\]/);

  const htmlOut = sandbox.renderPkgCompactDetails({
    ext: ['Exterior hand wash', 'Wheels cleaned'],
    int: ['Vacuum accessible floors', 'Interior mirrors and windshield'],
  });
  assert.match(htmlOut, /<b>Interior<\/b>/);
  assert.match(htmlOut, /<b>Exterior<\/b>/);
  assert.match(htmlOut, /Interior mirrors and windshield/);
  assert.doesNotMatch(htmlOut, /<b>Includes<\/b>/);

  const flat = sandbox.renderPkgCompactDetails({
    feats: ['Only feats item'],
  });
  assert.match(flat, /<b>Includes<\/b>/);
  assert.match(flat, /Only feats item/);
});

test('package and add-on copy uses windshield instead of glass', () => {
  assert.match(html, /Interior windshield cleaned/);
  assert.match(html, /Exterior windshield cleaned/);
  assert.match(html, /Rain-X Windshield Treatment/);
  assert.doesNotMatch(html, /Interior glass cleaned/);
  assert.doesNotMatch(html, /Exterior glass cleaned/);
  assert.doesNotMatch(html, /Rain-X Glass Treatment/);
  assert.doesNotMatch(html, /Interior mirrors and glass/);
});
