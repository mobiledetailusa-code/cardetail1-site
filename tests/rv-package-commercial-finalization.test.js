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
  assert.match(page, /Machine buffing &amp; shine enhancement|Exterior Gloss Restoration/);
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

test('PRICING: six-package hierarchy and base+ratePerFoot math', () => {
  const lp = LENGTH_PRICING.rvs.packages;
  assert.equal(lp.maint.base, 120);
  assert.equal(lp.maint.ratePerFoot, 10);
  assert.equal(lp.maint_light.base, 200);
  assert.equal(lp.interior.base, 200);
  assert.equal(lp.full_basic.base, 240);
  assert.equal(lp.premium.base, 240);
  assert.equal(lp.full.base, 255);
  assert.equal(Object.keys(lp).sort().join(','), FINAL_IDS.slice().sort().join(','));

  assert.ok(lp.maint_light.base > lp.maint.base);
  assert.ok(lp.full.ratePerFoot > lp.premium.ratePerFoot);

  const ft = 24;
  const prices = Object.fromEntries(FINAL_IDS.map((id) => [id, getLengthPrice('rvs', id, ft, 'travel')]));
  assert.equal(prices.maint, 390);
  assert.equal(prices.maint_light, 634);
  assert.equal(prices.interior, 682);
  assert.equal(prices.full_basic, 720);
  assert.equal(prices.premium, 972);
  assert.equal(prices.full, 1264);
  assert.ok(prices.maint < prices.maint_light);
  assert.ok(prices.full > prices.premium);

  const lengthBlock = extractRvLength(read('index.html'));
  assert.match(lengthBlock, /maint_light:\s*\{ base: 200, ratePerFoot: 16 \}/);
  assert.match(lengthBlock, /full:\s*\{ base: 255, ratePerFoot: 36 \}/);
});

test('DISPLAY: single-price cards and booking CTAs; no funnel', () => {
  const page = read('rv-detailing.html');
  assert.match(page, /Price calculated from your vehicle details/);
  assert.match(page, /package-booking-cta/);
  assert.match(page, /Select This RV Package|Book This Package/);
  assert.doesNotMatch(page, /rv-pricing-funnel/);
  assert.doesNotMatch(page, /CHECK PRICE &amp; AVAILABILITY/);
  assert.doesNotMatch(page, /From \$899\b|From \$1,?160/);
});

test('REGRESSION: no membership; galleries untouched', () => {
  const page = read('rv-detailing.html');
  assert.doesNotMatch(page, /RV Care Membership|id="membership"/);
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
      new RegExp(`${id}:\\s*\\{ base: ${rule.base}, ratePerFoot: ${rule.ratePerFoot} \\}`),
    );
  }
});
