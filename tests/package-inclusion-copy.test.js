'use strict';

// Public package copy must match what the server bundles into each car package.
// PACKAGE_INCLUDED_ADDONS decides which add-ons are free with a package; the
// booking pages hide an add-on whenever the package text names it, so a package
// that claims "clay bar" without the server including it would hide a paid
// add-on, and one that omits it would invite a duplicate charge.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { includedAddonIds } = require('../netlify/lib/booking-price-catalog');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const BOOKING_PAGES = [
  'index.html', 'bergen-county-hub.html', 'connecticut-hub.html', 'essex-county-hub.html',
  'hudson-county-hub.html', 'new-jersey-hub.html', 'newark-mobile-detailing.html',
  'ny-metro-hub.html', 'passaic-county-hub.html', 'pennsylvania-hub.html', 'template-city.html',
  'trenton-mobile-detailing.html', 'westchester-mobile-detailing.html',
];

function carPackage(html, id) {
  const start = html.indexOf(`{id:'${id}',`);
  assert.ok(start >= 0, `missing package ${id}`);
  const missAt = html.indexOf('miss:[', start);
  const end = html.indexOf(']}', missAt);
  const block = html.slice(start, end);
  const included = block.slice(0, missAt - start);
  return { included, miss: block.slice(missAt - start) };
}

test('server bundles clay bar and Rain-X into Premium Full Detail only among wash/maint/full', () => {
  assert.deepEqual(includedAddonIds('cars', 'full').sort(), ['claybar', 'rainx']);
  assert.deepEqual(includedAddonIds('cars', 'maint'), []);
  assert.deepEqual(includedAddonIds('cars', 'wash'), []);
});

test('Maintenance Detail copy does not claim clay bar; Premium Full Detail does', () => {
  for (const file of BOOKING_PAGES) {
    const html = read(file);
    const maint = carPackage(html, 'maint');
    assert.doesNotMatch(maint.included, /clay/i, `${file} Maintenance Detail still claims clay bar`);
    assert.match(maint.miss, /Clay bar \(available as add-on\)/, `${file} Maintenance Detail should list clay bar as an add-on`);
  }
  const index = read('index.html');
  assert.match(carPackage(index, 'full').included, /Clay bar decontamination/);
  assert.match(carPackage(index, 'full').included, /Rain-X/);
  assert.doesNotMatch(index, /maint:\s*\{[^}]*chips:\s*\[[^\]]*'Clay'/);
});
