'use strict';

/**
 * Phase 1 — Cars vehicle catalog foundation.
 *
 * Proves: single SoT, alias resolution, year-aware schema (non-strict),
 * year-sensitive class bands, legacy MODELS projection parity across booking
 * pages, and reserved full_size_van representation (non-public fixture).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const Catalog = require('../assets/vehicle-catalog.js');
const {
  resolveVehicleClassification,
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

function extractAssignment(html, name) {
  const marker = `const ${name} = `;
  const idx = html.indexOf(marker);
  assert.ok(idx >= 0, `${name} missing`);
  let i = idx + marker.length;
  const open = html[i];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = null;
  let esc = false;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === '\\') {
        esc = true;
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  return html.slice(idx, i);
}

function loadModels(html) {
  const src = extractAssignment(html, 'MODELS') + '; return MODELS;';
  return new Function(src)();
}

function interiorPrice(tierKey) {
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
  assert.equal(typeof r.basePrice, 'number');
  assert.ok(Number.isFinite(r.basePrice));
  return r.basePrice;
}

test('canonical SoT + generated runtime + sync script exist once', () => {
  assert.ok(fs.existsSync(path.join(root, 'data/cars-vehicle-catalog.json')));
  assert.ok(
    fs.existsSync(path.join(root, 'assets/generated/cars-vehicle-catalog.generated.js'))
  );
  assert.ok(fs.existsSync(path.join(root, 'scripts/sync-vehicle-catalog.cjs')));
  assert.ok(fs.existsSync(path.join(root, 'assets/vehicle-catalog.js')));
});

test('canonical model resolves', () => {
  const r = Catalog.resolveVehicle({ make: 'Toyota', model: 'Camry', year: 2020 });
  assert.equal(r.ok, true);
  assert.equal(r.canonicalMake, 'Toyota');
  assert.equal(r.canonicalModel, 'Camry');
  assert.equal(r.tierKey, 'small');
  assert.equal(r.pricingClass, 'small');
  assert.equal(r.displayClass, 'small');
});

test('alias F150 resolves same model/tier as F-150', () => {
  const a = Catalog.resolveVehicle({ make: 'Ford', model: 'F150', year: 2020 });
  const b = Catalog.resolveVehicle({ make: 'Ford', model: 'F-150', year: 2020 });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.canonicalModel, 'F-150');
  assert.equal(b.canonicalModel, 'F-150');
  assert.equal(a.tierKey, b.tierKey);
  assert.equal(a.tierKey, 'truck');
  assert.equal(a.matchedAlias, 'F150');
  assert.equal(a.source, 'alias');
});

test('valid year resolves; invalid year detectable (strict optional)', () => {
  assert.equal(Catalog.isYearValid('Ford', 'F-150', 2020), true);
  assert.equal(Catalog.isYearValid('Ford', 'F-150', 1980), false);
  const strict = Catalog.resolveVehicle({
    make: 'Ford',
    model: 'F-150',
    year: 1980,
    strictYear: true,
  });
  assert.equal(strict.ok, false);
  assert.equal(strict.yearValid, false);
  // Phase 1: non-strict keeps Production over-acceptance for public models
  const loose = Catalog.resolveVehicle({ make: 'Ford', model: 'F-150', year: 1980 });
  assert.equal(loose.ok, true);
  assert.equal(loose.yearValid, false);
});

test('year-sensitive schema supported (Santa Fe)', () => {
  const y2022 = Catalog.resolveVehicle({ make: 'Hyundai', model: 'Santa Fe', year: 2022 });
  const y2025 = Catalog.resolveVehicle({ make: 'Hyundai', model: 'Santa Fe', year: 2025 });
  assert.equal(y2022.tierKey, 'suv2');
  assert.equal(y2025.tierKey, 'suv3');
  assert.equal(y2022.displayClass, 'suv2');
  assert.equal(y2025.displayClass, 'suv3');
});

test('classification + numeric package price preserved for representatives', () => {
  const cases = [
    ['Toyota', 'Camry', 2020, 'small', 'small'],
    ['Honda', 'CR-V', 2024, 'suv2', 'suv2'],
    ['Toyota', 'Highlander', 2024, 'suv3', 'suv3'],
    ['Honda', 'Odyssey', 2024, 'suv3', 'minivan'],
    ['Ford', 'F-150', 2020, 'truck', 'truck'],
    ['Tesla', 'Model 3', 2024, 'small', 'small'],
  ];
  for (const [make, model, year, tier, display] of cases) {
    const r = Catalog.resolveVehicle({ make, model, year });
    assert.equal(r.ok, true, `${make} ${model}`);
    assert.equal(r.tierKey, tier, `${make} ${model} tier`);
    assert.equal(r.displayClass, display, `${make} ${model} display`);
    const price = interiorPrice(r.tierKey);
    assert.equal(price, PRICING.cars.tiers[tier].interior);
  }
});

test('full_size_van representable via non-public fixture', () => {
  const r = Catalog.resolveVehicle({
    make: 'Fixture',
    model: 'Full-Size Van Example',
    year: 2020,
  });
  assert.equal(r.ok, true);
  assert.equal(r.pricingClass, 'full_size_van');
  assert.equal(r.tierKey, 'full_size_van');
  assert.equal(r.public, false);
  assert.equal(
    Catalog.publicVehicles().some((v) => v.model === 'Full-Size Van Example'),
    false
  );
  const legacy = Catalog.toLegacyModelsMap();
  assert.equal(legacy.Fixture, undefined);
});

test('index/hub/city MODELS hashes identical (13 pages) + shared scripts', () => {
  const hashes = new Set(
    BOOKING_PAGES.map((p) =>
      crypto
        .createHash('sha256')
        .update(extractAssignment(read(p), 'MODELS'))
        .digest('hex')
    )
  );
  assert.equal(hashes.size, 1);
  for (const p of BOOKING_PAGES) {
    const html = read(p);
    assert.match(html, /assets\/generated\/cars-vehicle-catalog\.generated\.js/);
    assert.match(html, /assets\/vehicle-catalog\.js/);
    assert.match(html, /assets\/vehicle-class-resolver\.js/);
  }
});

test('sync --check reports no drift', () => {
  execSync('node scripts/sync-vehicle-catalog.cjs --check', {
    cwd: root,
    stdio: 'pipe',
  });
});

test('legacy MODELS projection matches catalog pricingClass for every public entry', () => {
  const pageModels = loadModels(read('index.html'));
  const projected = Catalog.toLegacyModelsMap();
  let compared = 0;
  for (const [make, entry] of Object.entries(pageModels)) {
    assert.ok(projected[make], make);
    assert.deepEqual([...projected[make].m].sort(), [...entry.m].sort());
    for (const model of entry.m) {
      compared++;
      assert.equal(projected[make].t[model], entry.t[model], `${make} ${model}`);
      const r = resolveVehicleClassification({
        make,
        model,
        year: '',
        catalogTierKey: entry.t[model],
      });
      assert.equal(r.ok, true, `${make} ${model}`);
      assert.equal(r.tierKey, entry.t[model], `${make} ${model} resolver tier`);
    }
  }
  assert.ok(compared >= 300);
});
