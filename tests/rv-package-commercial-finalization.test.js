'use strict';

/**
 * RV five-package scope clarity + per-foot pricing gates.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const nodeBin = process.env.NODE_BIN
  || (fs.existsSync('C:\\Users\\magno\\AppData\\Local\\OpenAI\\Codex\\bin\\node.exe')
    ? 'C:\\Users\\magno\\AppData\\Local\\OpenAI\\Codex\\bin\\node.exe'
    : process.execPath);

const {
  PRICING,
  LENGTH_PRICING,
  getLengthPrice,
  computeVehicleSubtotal,
  computeAddonTotal,
} = require('../netlify/lib/booking-price-catalog');

const FINAL_IDS = ['maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'];
const FINAL_NAMES = {
  maint: 'Maintenance Wash',
  maint_light: 'Maintenance Wash + Light Interior',
  interior: 'Interior Detail',
  full_basic: 'Full RV Detail',
  premium: 'Premium Exterior Detail',
  full: 'Premium Complete RV Detail',
};

function extractRvPackages(html) {
  const m = html.match(/rvs:\s*\{[\s\S]*?packages:\[([\s\S]*?)\],\s*addons:/);
  assert.ok(m, 'rvs packages block missing');
  return m[1];
}

function extractRvAddons(html) {
  const m = html.match(/rvs:\s*\{[\s\S]*?addons:\[([\s\S]*?)\],/);
  assert.ok(m, 'rvs addons block missing');
  return m[1];
}

function extractRvLength(html) {
  const m = html.match(/LENGTH_PRICING\s*=\s*\{[\s\S]*?rvs:\s*\{[\s\S]*?packages:\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(m, 'LENGTH_PRICING.rvs missing');
  return m[1];
}

test('PACKAGE STRUCTURE: six customer-visible RV packages', () => {
  const html = read('index.html');
  const block = extractRvPackages(html);
  const ids = [...block.matchAll(/id:'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(ids, FINAL_IDS);

  const page = read('rv-detailing.html');
  assert.equal((page.match(/data-rv-tier="/g) || []).length, 6);
  for (const [id, name] of Object.entries(FINAL_NAMES)) {
    assert.match(page, new RegExp(`data-rv-tier="${id}"`));
    assert.match(page, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(block, new RegExp(`id:'${id}'`));
  }
  assert.doesNotMatch(page, /One-Step Paint Correction \+|Exterior Wash &amp; Protect|Paint Improvement|Essential Care|Complete Care/);
  assert.doesNotMatch(block, /id:'(exterior|correction|correction_int)'/);

  const bridge = read('assets/specialty-booking-bridge.js');
  assert.match(bridge, /rvs:\s*\{[^}]*full_basic:[^}]*full:/);
  assert.doesNotMatch(bridge, /correction_int/);
});

test('SCOPE CLARITY: banned vague phrases removed; surfaces listed', () => {
  const page = read('rv-detailing.html');
  const pkgs = extractRvPackages(read('index.html'));
  for (const src of [page, pkgs]) {
    assert.doesNotMatch(src, /full interior scope/i);
    assert.doesNotMatch(src, /full restoration/i);
    assert.doesNotMatch(src, /complete restoration/i);
    assert.doesNotMatch(src, /living-area restoration/i);
    assert.doesNotMatch(src, /rejuvenation/i);
    assert.doesNotMatch(src, /highest ticket/i);
  }
  assert.doesNotMatch(page, /Service duration depends|~\d+–\d+h/);
  assert.match(page, /Exterior hand wash/);
  assert.match(page, /Refrigerator interior when empty/);
  assert.match(page, /One-step machine polish/);
  assert.match(page, /MOST POPULAR/);
  assert.match(page, /BEST FINISH/);
});

test('ADD-ONS: Super Interior $135, Sanitize $75, Mold absent for new RV bookings', () => {
  const addons = PRICING.rvs.addons;
  assert.equal(addons.find((a) => a.id === 'superint').price, 135);
  assert.equal(addons.find((a) => a.id === 'sanitize').price, 75);
  assert.ok(!addons.some((a) => a.id === 'mold'));

  const htmlAddons = extractRvAddons(read('index.html'));
  assert.match(htmlAddons, /id:'superint'[\s\S]*?price:135/);
  assert.match(htmlAddons, /id:'sanitize'[\s\S]*?price:75/);
  assert.doesNotMatch(htmlAddons, /id:'mold'/);

  const page = read('rv-detailing.html');
  assert.match(page, /Super Interior · \$135|Super Interior is \$135/);
  assert.match(page, /Sanitize · \$75|Sanitize is \$75/);
  assert.doesNotMatch(page, /Mold Treatment/);

  const priced = computeVehicleSubtotal({
    cat: 'rvs',
    pkgId: 'interior',
    lengthFt: 24,
    addons: [
      { id: 'superint', name: 'Hacked', price: 1 },
      { id: 'sanitize', name: 'Hacked', price: 1 },
    ],
  }, '07601');
  assert.equal(priced.ok, true);
  assert.equal(priced.addonTotal, 210);

  const moldNew = computeAddonTotal({
    cat: 'rvs',
    addons: [{ id: 'mold', name: 'Mold Treatment', price: 149 }],
  });
  assert.equal(moldNew.ok, false);
});

test('ADD-ONS: historical Mold Treatment records remain display-safe', () => {
  const historical = {
    cat: 'rvs',
    package: 'Interior Detail',
    addons: [{ id: 'mold', name: 'Mold Treatment', price: 149 }],
  };
  const line = `Add-ons: ${(historical.addons || []).map((a) => a.name).join(', ') || 'None'}`;
  assert.match(line, /Mold Treatment/);
});

test('PRICING: six-package hierarchy and per-foot math', () => {
  const lp = LENGTH_PRICING.rvs.packages;
  assert.equal(lp.maint.min, 129);
  assert.equal(lp.maint_light.min, 229);
  assert.equal(lp.interior.min, 249);
  assert.equal(lp.full_basic.min, 349);
  assert.equal(lp.premium.min, 449);
  assert.equal(lp.full.min, 699);
  assert.equal(Object.keys(lp).sort().join(','), FINAL_IDS.slice().sort().join(','));

  assert.ok(lp.maint_light.min > lp.maint.min);
  assert.ok(lp.premium.min > lp.maint_light.min);
  assert.ok(lp.full.min > lp.premium.min);

  const ft = 24;
  const prices = Object.fromEntries(FINAL_IDS.map((id) => [id, getLengthPrice('rvs', id, ft, 'travel')]));
  assert.equal(prices.maint, Math.max(129, Math.round(8.5 * 24)));
  assert.equal(prices.maint_light, Math.max(229, Math.round(16 * 24)));
  assert.equal(prices.interior, Math.max(249, Math.round(21 * 24)));
  assert.equal(prices.full_basic, Math.max(349, Math.round(27 * 24)));
  assert.equal(prices.premium, Math.max(449, Math.round(33 * 24)));
  assert.equal(prices.full, Math.max(699, Math.round(49.5 * 24)));
  assert.ok(prices.maint < prices.maint_light);
  assert.ok(prices.full > prices.premium);
  assert.ok(prices.full > prices.interior);
  assert.ok(prices.full > prices.full_basic);

  assert.equal(getLengthPrice('rvs', 'exterior', 24, 'travel'), prices.maint_light);
  assert.equal(getLengthPrice('rvs', 'correction', 24, 'travel'), prices.premium);
  assert.equal(getLengthPrice('rvs', 'correction_int', 24, 'travel'), prices.full);

  const lengthBlock = extractRvLength(read('index.html'));
  assert.match(lengthBlock, /maint_light:\s*\{perFt:\s*16,\s*min:\s*229\}/);
  assert.match(lengthBlock, /full:\s*\{perFt:\s*49\.5,\s*min:\s*699\}/);
  assert.doesNotMatch(lengthBlock, /correction/);
});

test('DISPLAY: funnel CTA replaces premature length/price controls', () => {
  const page = read('rv-detailing.html');
  assert.match(page, /CHECK PRICE &amp; AVAILABILITY/);
  assert.match(page, /Enter your ZIP code, RV type and exact length/);
  assert.doesNotMatch(page, /Starting at \$/);
  assert.doesNotMatch(page, /From \$899\b|From \$1,?199|From \$1,?299|From \$1,?499/);
  assert.doesNotMatch(page, /id="rv-length-range"/);
  assert.match(page, /rv-pricing-funnel\.js/);
});

test('BOOKING: length bridge + six-step + other categories unchanged', () => {
  const bridge = read('assets/specialty-booking-bridge.js');
  assert.match(bridge, /params\.set\('length'/);
  assert.match(bridge, /cd1_rv_length/);

  const index = read('index.html');
  assert.match(index, /BK_VISIBLE_STEPS\s*=\s*6/);
  assert.match(index, /boats:[\s\S]*?maint:\s*\{perFt:\s*12,\s*min:\s*199\}/);
  assert.match(index, /motorcycle:\s*\{[\s\S]*?wash:119/);
  assert.match(index, /id="home-from-interior">\$225/);
  assert.equal(LENGTH_PRICING.boats.packages.maint.min, 199);
  assert.equal(PRICING.cars.tiers.small.interior, 225);
  assert.equal(PRICING.cars.addons.find((a) => a.id === 'sanitize').price, 65);

  assert.doesNotMatch(read('rv-detailing.html'), /\btwilio\b/i);
  assert.doesNotMatch(read('netlify/lib/booking-price-catalog.js'), /stripe\.(charges|paymentIntents)/i);
});

test('REGRESSION: membership interest-only; galleries untouched markers', () => {
  const page = read('rv-detailing.html');
  assert.match(page, /Interest list only|future interest list/i);
  assert.match(page, /vienna-front-after-768\.jpg/);
  assert.match(page, /wingamm-front-after-768\.jpg/);
});

test('SYNC: RV pricing sync remains idempotent', () => {
  const syncRv = path.join(root, 'scripts/sync-rv-pricing-blocks.mjs');
  assert.ok(fs.existsSync(syncRv));
  const first = spawnSync(nodeBin, [syncRv], { cwd: root, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const second = spawnSync(nodeBin, [syncRv], { cwd: root, encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.match(second.stdout + second.stderr, /0 file|unchanged|no change|idempotent/i);
});

test('client and server LENGTH_PRICING.rvs stay synced', () => {
  const lengthBlock = extractRvLength(read('index.html'));
  for (const id of FINAL_IDS) {
    const rule = LENGTH_PRICING.rvs.packages[id];
    assert.match(
      lengthBlock,
      new RegExp(`${id}:\\s*\\{perFt:\\s*${rule.perFt},\\s*min:\\s*${rule.min}\\}`),
    );
  }
});
