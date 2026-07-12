'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const BTT_PAGES = [
  'index.html',
  'new-jersey-hub.html',
  'bergen-county-hub.html',
  'newark-mobile-detailing.html',
  'boats-detailing.html',
  'rv-detailing.html',
  'powersports-detailing.html',
  'fleet-services.html',
  'multi-vehicle-detailing.html',
  'terms-conditions.html',
];

for (const page of BTT_PAGES) {
  test(`${page} loads authoritative back-to-top.js`, () => {
    const html = read(page);
    assert.match(html, /back-to-top\.js/);
    assert.doesNotMatch(html, /id="btt"[^>]*class=/);
  });
}

test('back-to-top module is single-init with keyboard support', () => {
  const js = read('assets/back-to-top.js');
  assert.match(js, /__CD1_BTT_INIT__/);
  assert.match(js, /prefers-reduced-motion/);
  assert.match(js, /keydown/);
  assert.match(js, /scrollingElement/);
});
