'use strict';

/**
 * Hub/city booking copies must not render "Estimate" for published-package
 * price misses. Canonical contract lives in index.html.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RETRY = "We couldn't load this package price. Please retry.";

const HUB_CITY_PAGES = [
  'bergen-county-hub.html',
  'connecticut-hub.html',
  'essex-county-hub.html',
  'hudson-county-hub.html',
  'new-jersey-hub.html',
  'newark-mobile-detailing.html',
  'ny-metro-hub.html',
  'passaic-county-hub.html',
  'pennsylvania-hub.html',
  'template-city.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function activePublishedEstimateFallbacks(html) {
  const hits = [];
  html.split('\n').forEach((line, idx) => {
    if (!/['"]Estimate['"]/.test(line)) return;
    // Custom quote CTA on package cards — not a published numeric package.
    if (/\?['"]Estimate['"]/.test(line) && /custom/.test(line)) return;
    // Fleet custom badge copy.
    if (/Estimate required/.test(line)) return;
    // Explanatory prose / labels (not a price fallback).
    if (/Estimated total|Estimated service|Estimate confirmation|Estimate by fleet/.test(line)) return;
    if (/:'Estimate'|: 'Estimate'|==null\?['"]Estimate['"]|\?'Estimate'|:\"Estimate\"/.test(line)) {
      hits.push({ line: idx + 1, text: line.trim() });
    }
  });
  return hits;
}

describe('canonical index published-package Estimate contract', () => {
  const index = read('index.html');

  it('updateTotal / strip / confirm / review use retry or emdash, not Estimate', () => {
    assert.equal(activePublishedEstimateFallbacks(index).length, 0);
    assert.match(index, /We couldn't load this package price\. Please retry\./);
    assert.doesNotMatch(index, /s5-total'\)\.textContent=cartBase\?'\$'\+\(cartBase\+fee\):'Estimate'/);
    assert.doesNotMatch(index, /packagePrice==null\?'Estimate'/);
    assert.doesNotMatch(index, /c-total'\)\.textContent=total \? '\$'\+total : 'Estimate'/);
    assert.doesNotMatch(index, /ok-total'\)\.textContent=\(b\.totalPrice\|\|0\)\?bkMoney\(b\.totalPrice\):'Estimate'/);
  });
});

describe('hub/city copies match canonical Estimate→retry contract', () => {
  for (const page of HUB_CITY_PAGES) {
    it(`${page} has zero active published-package Estimate fallbacks`, () => {
      const html = read(page);
      const hits = activePublishedEstimateFallbacks(html);
      assert.deepEqual(hits, [], `${page} still has Estimate fallbacks`);
      assert.match(html, /We couldn't load this package price\. Please retry\./);
      assert.match(html, /if\(ST\.cat==='cars'\) return;/);
      assert.match(html, /next3'\)\.disabled=\!\(ST\.basePrice>0\)/);
    });
  }

  it('all 12 copies share the same s5 / c-total / packagePrice / ok-total semantics', () => {
    const needles = [
      "totalEl.textContent = " + JSON.stringify(RETRY),
      "it.packagePrice==null?" + JSON.stringify(RETRY),
      "c-total').textContent=total ? '$'+total : (vehicles.some(function(v){ return v && v.pkgId && v.pkgId!=='custom' && !(Number(v.basePrice)>0); }) ? " + JSON.stringify(RETRY),
      "ok-total').textContent=(b.totalPrice||0)?bkMoney(b.totalPrice):'—'",
    ];
    for (const page of HUB_CITY_PAGES) {
      const html = read(page);
      for (const n of needles) {
        assert.ok(html.includes(n), `${page} missing semantic: ${n.slice(0, 60)}`);
      }
    }
  });
});
