'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function carPackagesBlock() {
  const m = html.match(/cars:\s*\{[\s\S]*?packages:\[([\s\S]*?)\],\s*addons:/);
  assert.ok(m, 'cars packages block missing');
  return m[1];
}

test('car package durations match the published hour ranges', () => {
  const cars = carPackagesBlock();
  assert.match(cars, /id:'maint'[\s\S]*?dur:'~1\.5–2h'/);
  assert.match(cars, /id:'interior'[\s\S]*?dur:'~1\.5–2h'/);
  assert.match(cars, /id:'full'[\s\S]*?dur:'~2\.5–3h'/);
  assert.match(cars, /id:'refresh'[\s\S]*?dur:'~3\.5–4h'/);
  assert.match(cars, /id:'premium'[\s\S]*?dur:'~3\.5–4h'/);
  assert.doesNotMatch(cars, /id:'interior'[\s\S]*?dur:'~2\.5–3\.5h'/);
  assert.doesNotMatch(cars, /id:'full'[\s\S]*?dur:'~3–5h/);
  assert.doesNotMatch(cars, /id:'premium'[\s\S]*?dur:'~6–8h'/);
});

test('homepage car chips use the same hour ranges', () => {
  assert.match(html, /data-pkg="interior"[\s\S]*?~1\.5–2 hrs/);
  assert.match(html, /data-pkg="full"[\s\S]*?~2\.5–3 hrs/);
  assert.match(html, /data-pkg="refresh"[\s\S]*?~3\.5–4 hrs/);
});

test('interior service list is shared on interior, full, and signature packs', () => {
  assert.match(html, /const CAR_INTERIOR_SERVICE_ITEMS = \[/);
  assert.match(html, /Headliner cleaning/);
  assert.match(html, /Door jambs cleaned/);
  assert.match(html, /truck bed where applicable/);
  const cars = carPackagesBlock();
  const maint = cars.split("id:'interior'")[0];
  const refresh = cars.split("id:'refresh'")[1].split("id:'premium'")[0];
  assert.match(cars, /id:'interior'[\s\S]*?int:CAR_INTERIOR_SERVICE_ITEMS/);
  assert.match(cars, /id:'full'[\s\S]*?int:CAR_INTERIOR_SERVICE_ITEMS/);
  assert.match(cars, /id:'premium'[\s\S]*?int:CAR_INTERIOR_SERVICE_ITEMS/);
  assert.doesNotMatch(maint, /int:CAR_INTERIOR_SERVICE_ITEMS/);
  assert.doesNotMatch(refresh, /int:CAR_INTERIOR_SERVICE_ITEMS/);
  assert.match(maint, /Roof\/headliner/);
});

test('signature pack drops ceramic protection and includes wheels, tire shine, and plastic restoration', () => {
  const cars = carPackagesBlock();
  const premium = cars.match(/id:'premium'[\s\S]*?miss:\[\]/)[0];
  assert.doesNotMatch(premium, /ceramic protection/i);
  assert.doesNotMatch(premium, /Long-lasting ceramic/);
  assert.match(premium, /Wheel cleaning & tire shine/);
  assert.match(premium, /Exterior plastic restoration/);
});

test('Maintenance Detail hides shampoo/steam add-ons', () => {
  assert.match(html, /function addonRequiresShampooOrSteam\(a\)\{/);
  assert.match(html, /a\.id==='superint'\|\|a\.id==='floormats'/);
  assert.match(html, /ST\.pkgId==='maint' && addonRequiresShampooOrSteam\(a\)/);
});

test('package reselect after Back updates selection, price, and add-ons', () => {
  assert.match(html, /function selectPkg\(id\)\{[\s\S]*?pkg-grid[\s\S]*?ST\._addonKey=''/);
  assert.match(html, /function selectPkg\(id\)\{[\s\S]*?ST\.cat==='cars' && ST\.tierKey/);
  assert.match(html, /function selectPkg\(id\)\{[\s\S]*?currentBkStep < 3/);
  assert.doesNotMatch(html, /function selectPkg\(id\)\{[\s\S]*?renderPkgDetailPanel\(\)/);
  assert.match(html, /if \(n === 2\) \{[\s\S]*?pk-' \+ ST\.pkgId/);
  assert.doesNotMatch(html, /\.pkg\.pop \.pkg-btn\{background:var\(--blue\)/);
});
