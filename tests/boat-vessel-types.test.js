'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const boatsPage = fs.readFileSync(path.join(ROOT, 'boats-detailing.html'), 'utf8');
const psPage = fs.readFileSync(path.join(ROOT, 'powersports-detailing.html'), 'utf8');
const progress = fs.readFileSync(path.join(ROOT, 'assets/booking-progress.js'), 'utf8');
const bridge = fs.readFileSync(path.join(ROOT, 'assets/specialty-booking-bridge.js'), 'utf8');

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

describe('boat vessel types in booking', () => {
  it('homepage booking lists vessel types like RV types, including Jet Ski / PWC', () => {
    assert.match(index, /id="boat-type-sel"/);
    for (const value of ['runabout', 'bowrider', 'center', 'pontoon', 'cuddy', 'cruiser', 'jetski', 'other']) {
      assert.match(index, new RegExp(`<option value="${value}">`));
    }
    assert.match(index, /id="rv-type-sel"/);
    assert.match(index, /function setupBoatTypeControls/);
  });

  it('Boats category copy names watercraft types instead of All vessels', () => {
    const card = index.slice(index.indexOf('id="bkcat-boats"'), index.indexOf('id="bkcat-rvs"'));
    assert.match(card, /Pontoon · Center console · Jet Ski \/ PWC/);
    assert.doesNotMatch(card, /All vessels/);
    const ps = index.slice(index.indexOf('id="bkcat-powersports"'), index.indexOf('id="bkcat-powersports"') + 900);
    assert.match(ps, /Motorcycle · ATV · UTV/);
    assert.doesNotMatch(ps, /Motorcycle · ATV · UTV · Jet Ski/);
  });

  it('does not change marine length pricing or jet ski dollar amounts', () => {
    assert.match(index, /maint:\s*\{perFt:\s*10,\s*min:\s*170\}/);
    assert.match(index, /jetski:\s*\{label:'Jet Ski \/ PWC'[\s\S]*?wash:100,\s*essential:160,\s*full:225,\s*premium:310\}/);
  });

  it('jet ski uses PWC prices, not boat length mins', () => {
    const sandbox = {
      ST: { cat: 'boats', boatType: 'jetski' },
      PRICING: {
        powersports: { tiers: { jetski: { wash: 100, essential: 160, full: 225, premium: 310 } } },
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(
      'var JETSKI_PKG_PRICE_KEY = { maint:"wash", essential:"essential", full:"full", premium:"premium" };\n' +
      extractFunction(index, 'isJetSkiBoat') +
      extractFunction(index, 'getJetSkiPackagePrice') +
      'this.out = { wash: getJetSkiPackagePrice("maint"), full: getJetSkiPackagePrice("full"), premium: getJetSkiPackagePrice("premium"), isPwc: isJetSkiBoat() };',
      sandbox
    );
    assert.equal(sandbox.out.isPwc, true);
    assert.equal(sandbox.out.wash, 100);
    assert.equal(sandbox.out.full, 225);
    assert.equal(sandbox.out.premium, 310);
  });

  it('powersports chips hide jet ski; deep-link boatType is wired', () => {
    assert.match(index, /filter\(\(\[k\]\)=>!\(cat==='powersports' && k==='jetski'\)\)/);
    assert.match(index, /params\.get\('boatType'\)/);
    assert.match(index, /book==='powersports' && \(resolvedBoatType==='jetski'/);
    assert.match(progress, /boatType: ST\.boatType/);
    assert.match(bridge, /data-booking-boat-type/);
    assert.match(bridge, /params\.set\('boatType'/);
  });

  it('boats specialty page books jet ski into boats, not powersports', () => {
    assert.match(boatsPage, /data-booking-boat-type="jetski"/);
    assert.match(boatsPage, /book=boats&amp;boatType=jetski/);
    assert.match(psPage, /book=boats&amp;boatType=jetski/);
  });
});
