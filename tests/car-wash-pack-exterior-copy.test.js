'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

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

function extractAssignedObject(source, name) {
  const declaration = new RegExp(`(?:const|let)\\s+${name}\\s*=`);
  const declarationMatch = declaration.exec(source);
  assert.notEqual(declarationMatch, null, `${name} assignment missing`);
  const markerAt = declarationMatch.index;
  const start = source.indexOf('{', markerAt + declarationMatch[0].length);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const sandbox = {};
        const items = source.match(/const CAR_INTERIOR_SERVICE_ITEMS = (\[[\s\S]*?\]);/);
        if (items) sandbox.CAR_INTERIOR_SERVICE_ITEMS = vm.runInNewContext(items[1]);
        return vm.runInNewContext(`(${source.slice(start, i + 1)})`, sandbox);
      }
    }
  }
  assert.fail(`${name} closing brace missing`);
}

function pkgIncludesAddon(pkg) {
  const txt = [].concat(pkg.feats || [], pkg.ext || [], pkg.int || []).join(' ').toLowerCase();
  return { rainx: /rain-?x/.test(txt), claybar: /clay\s*bar/.test(txt) };
}

test('Signature exterior copy matches Exterior Refresh & Protect exactly', () => {
  for (const file of BOOKING_PAGES) {
    const pricing = extractAssignedObject(read(file), 'PRICING');
    const pkgs = pricing.cars.packages;
    const refresh = pkgs.find((p) => p.id === 'refresh');
    const premium = pkgs.find((p) => p.id === 'premium');
    assert.ok(refresh && premium, `${file} missing refresh/premium`);
    assert.ok(Array.isArray(refresh.ext) && refresh.ext.length > 0, `${file} refresh.ext missing`);
    assert.deepEqual(premium.ext, refresh.ext, `${file} premium.ext must copy refresh.ext exactly`);
    assert.ok(Array.isArray(premium.int) && premium.int.length > 0, `${file} premium interior must stay`);
  }
});

test('Exterior Hand Wash starts at $110 and keeps wax/clay/engine as paid add-ons', () => {
  const { PRICING, coerceVehicleForCategory, inferPkgId } = require('../netlify/lib/booking-price-catalog');
  assert.equal(PRICING.cars.tiers.small.wash, 110);
  assert.equal(PRICING.cars.tiers.suv2.wash, 135);
  assert.equal(PRICING.cars.tiers.suv3.wash, 155);
  assert.equal(PRICING.cars.tiers.truck.wash, 155);
  assert.equal(PRICING.cars.tiers.small.refresh, 320);
  assert.equal(PRICING.cars.tiers.small.premium, 385);

  for (const file of BOOKING_PAGES) {
    const pricing = extractAssignedObject(read(file), 'PRICING');
    const wash = pricing.cars.packages.find((p) => p.id === 'wash');
    assert.ok(wash, `${file} missing wash pack`);
    assert.equal(wash.name, 'Exterior Hand Wash');
    assert.equal(wash.scope, 'ext');
    assert.equal(pricing.cars.tiers.small.wash, 110);
    const inc = pkgIncludesAddon(wash);
    assert.equal(inc.claybar, false, `${file} wash must not include clay bar`);
    assert.equal(inc.rainx, false, `${file} wash must not include Rain-X`);
    const addons = pricing.cars.addons;
    for (const id of ['wax1yr', 'claybar', 'engine', 'polymer']) {
      assert.ok(addons.some((a) => a.id === id && a.scope === 'ext'), `${file} missing ext add-on ${id}`);
    }
  }

  assert.equal(inferPkgId({ pkgId: 'wash', cat: 'cars' }, {}), 'wash');
  assert.equal(inferPkgId({ pkgName: 'Exterior Hand Wash', cat: 'cars' }, {}), 'wash');
  const coerced = coerceVehicleForCategory({
    category: 'powersports',
    packageId: 'wash',
    pkgId: 'wash',
    tierKey: 'motorcycle',
  }, 'cars', { tierKey: 'small', packageId: 'wash' });
  assert.equal(coerced.packageId, 'wash');
});

test('homepage and state hubs sell the wash pack from $110', () => {
  for (const file of ['index.html', 'new-jersey-hub.html', 'ny-metro-hub.html', 'connecticut-hub.html', 'pennsylvania-hub.html']) {
    const html = read(file);
    assert.match(html, /data-pkg="wash"/);
    assert.match(html, /id="home-from-wash">\$110/);
    assert.match(html, /openBookingCarPkg\('wash'\)/);
    assert.match(html, /openHomePkgDetailModal\('wash'/);
  }
  const modal = read('assets/car-pkg-detail-modal.js');
  assert.match(modal, /wash:\s*\{[\s\S]*title:\s*"Exterior Hand Wash"/);
  assert.match(modal, /"1-Year Carnauba Wax"/);
  assert.match(modal, /"Clay bar"/);
  assert.match(modal, /"Engine bay detailing"/);
});
