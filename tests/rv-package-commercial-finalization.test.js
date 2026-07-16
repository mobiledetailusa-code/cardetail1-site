'use strict';

/**
 * RV package commercial finalization — structure, claims, add-ons, pricing, regressions.
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

const FINAL_IDS = [
  'maint',
  'exterior',
  'interior',
  'premium',
  'full',
  'correction',
  'correction_int',
];

const FINAL_NAMES = {
  maint: 'Maintenance Wash',
  exterior: 'Exterior Wash & Protect',
  interior: 'Interior Detail',
  premium: 'Premium Exterior Detail',
  full: 'Premium Complete Detail',
  correction: 'One-Step Paint Correction',
  correction_int: 'One-Step Paint Correction + Interior',
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

test('PACKAGE STRUCTURE: seven RV packages remain with unique IDs and order', () => {
  const html = read('index.html');
  const block = extractRvPackages(html);
  const ids = [...block.matchAll(/id:'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(ids, FINAL_IDS);
  assert.equal(new Set(ids).size, FINAL_IDS.length);

  const page = read('rv-detailing.html');
  for (const [id, name] of Object.entries(FINAL_NAMES)) {
    assert.match(page, new RegExp(`data-rv-tier="${id}"`));
    const htmlName = name.replace(/&/g, '&amp;').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(page, new RegExp(htmlName));
    assert.match(block, new RegExp(`id:'${id}'[^\\n]*name:'${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  }

  const bridge = read('assets/specialty-booking-bridge.js');
  assert.match(bridge, /rvs:\s*\{[^}]*maint:[^}]*correction_int:/);
});

test('PACKAGE STRUCTURE: cards use customer-centered copy groupings', () => {
  const page = read('rv-detailing.html');
  assert.match(page, /Essential Care/);
  assert.match(page, /Complete Care/);
  assert.match(page, /Paint Improvement/);
  assert.match(page, /Keep your RV clean between major services/i);
  assert.match(page, /Bring comfort back inside your RV/i);
  assert.match(page, /Everything most RV owners need in one visit/i);
  assert.doesNotMatch(page, /\bWho:\s|\bSolves:\s|Why upgrade:/i);
});

test('TRUTHFUL CLAIMS: one-step polish scope; no restoration overpromises', () => {
  const page = read('rv-detailing.html');
  const pkgs = extractRvPackages(read('index.html'));
  for (const src of [page, pkgs]) {
    assert.match(src, /One-Step Machine Polish|one-step machine polish|One-step machine polishing/i);
    assert.doesNotMatch(src, /highest ticket/i);
    assert.doesNotMatch(src, /like new/i);
    assert.doesNotMatch(src, /removes all oxidation/i);
    assert.doesNotMatch(src, /complete restoration|full restoration|living-area restoration/i);
  }
  assert.match(page, /multi-stage restoration|requires inspection/i);
  assert.match(page, /Most Popular/);
  assert.doesNotMatch(page, /Full RV Detail/);
});

test('ADD-ONS: Super Interior $135 in RV list; Mold Treatment absent from RV', () => {
  const html = read('index.html');
  const rvAddons = extractRvAddons(html);
  assert.match(rvAddons, /id:'superint'[^}]*name:'Super Interior'[^}]*price:135/);
  assert.doesNotMatch(rvAddons, /id:'mold'/);
  assert.match(rvAddons, /id:'odor'/);
  assert.match(rvAddons, /id:'pethair'/);
  assert.match(rvAddons, /id:'sanitize'/);

  const server = PRICING.rvs.addons.find((a) => a.id === 'superint');
  assert.equal(server.price, 135);
  assert.ok(!PRICING.rvs.addons.some((a) => a.id === 'mold'));
  assert.ok(PRICING.cars.addons.some((a) => a.id === 'mold'));

  const page = read('rv-detailing.html');
  assert.match(page, /Super Interior · \$135/);
  assert.doesNotMatch(page, /Mold Treatment/);
});

test('ADD-ONS: Super Interior is server-authoritative and persists in pricing payload', () => {
  const priced = computeVehicleSubtotal({
    cat: 'rvs',
    pkgId: 'interior',
    lengthFt: 24,
    addons: [{ id: 'superint', name: 'Hacked Name', price: 1 }],
  }, '07601');
  assert.equal(priced.ok, true);
  assert.equal(priced.addonTotal, 135);
  const si = priced.addons.find((a) => a.id === 'superint');
  assert.equal(si.price, 135);

  const hacked = computeAddonTotal({
    cat: 'rvs',
    addons: [{ id: 'superint', price: 999 }],
  });
  assert.equal(hacked.ok, true);
  assert.equal(hacked.total, 135);

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
  assert.doesNotThrow(() => JSON.stringify(historical));
});

test('PRICING: hierarchy, mins, deterministic per-foot math', () => {
  const lp = LENGTH_PRICING.rvs.packages;
  assert.equal(lp.maint.min, 279);
  assert.equal(lp.exterior.min, 399);
  assert.equal(lp.interior.min, 379);
  assert.equal(lp.premium.min, 899);
  assert.equal(lp.full.min, 1299);
  assert.equal(lp.correction.min, 1199);
  assert.equal(lp.correction_int.min, 1499);

  assert.ok(lp.exterior.min > lp.maint.min);
  assert.ok(lp.premium.min > lp.exterior.min);
  assert.ok(lp.full.min > lp.premium.min);
  assert.ok(lp.correction.min > lp.premium.min);
  assert.ok(lp.correction_int.min > lp.correction.min);

  const ft = 24;
  const prices = Object.fromEntries(
    FINAL_IDS.map((id) => [id, getLengthPrice('rvs', id, ft)]),
  );
  assert.equal(prices.maint, 279);
  assert.equal(prices.exterior, 399);
  assert.equal(prices.interior, 576);
  assert.equal(prices.premium, 960);
  assert.equal(prices.full, 1299);
  assert.equal(prices.correction, 1248);
  assert.equal(prices.correction_int, 1499);
  assert.ok(prices.full > prices.premium);
  assert.ok(prices.correction > prices.premium);
  assert.ok(prices.correction_int > prices.correction);

  const bundleGap = (prices.premium + prices.interior) - prices.full;
  assert.ok(bundleGap > 0 && bundleGap / (prices.premium + prices.interior) < 0.25);

  const lengthBlock = extractRvLength(read('index.html'));
  assert.match(lengthBlock, /exterior:\s*\{perFt:\s*16,\s*min:\s*399\}/);
  assert.match(lengthBlock, /full:\s*\{perFt:\s*54,\s*min:\s*1299\}/);
});

test('REGRESSION: six-step booking, other categories, Stripe surface, no Twilio', () => {
  const index = read('index.html');
  assert.match(index, /BK_VISIBLE_STEPS\s*=\s*6/);
  assert.match(index, /id="bpt6"/);
  assert.match(index, /boats:[\s\S]*?maint:\s*\{perFt:\s*12,\s*min:\s*199\}/);
  assert.match(index, /motorcycle:\s*\{[\s\S]*?wash:119/);
  assert.match(index, /id="home-from-interior">\$225/);

  const boatsLp = LENGTH_PRICING.boats.packages;
  assert.equal(boatsLp.maint.min, 199);
  assert.equal(boatsLp.full.min, 449);

  const page = read('rv-detailing.html');
  assert.match(page, /vienna-front-after-768\.jpg/);
  assert.match(page, /wingamm-front-after-768\.jpg/);
  assert.doesNotMatch(page, /\btwilio\b/i);
  assert.doesNotMatch(index, /require\(['"]twilio['"]\)|from ['"]twilio['"]/);

  const catalog = read('netlify/lib/booking-price-catalog.js');
  assert.doesNotMatch(catalog, /stripe\.(charges|paymentIntents)/i);
});

test('REGRESSION: WELCOME10 remains disabled on production; membership interest-only', () => {
  const toml = read('netlify.toml');
  assert.doesNotMatch(toml, /\[context\.production\.environment\][\s\S]*FIRST_BOOKING_OFFER_ENABLED = "true"/);
  const page = read('rv-detailing.html');
  assert.match(page, /Interest list only|future interest list/i);
  assert.doesNotMatch(page, /Subscribe now|Start membership checkout/i);
});

test('public-surface sync script remains available and RV pricing sync is idempotent', () => {
  assert.ok(fs.existsSync(path.join(root, 'scripts/sync-public-surface.mjs')));
  const syncRv = path.join(root, 'scripts/sync-rv-pricing-blocks.mjs');
  if (fs.existsSync(syncRv)) {
    const first = spawnSync(nodeBin, [syncRv], { cwd: root, encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const second = spawnSync(nodeBin, [syncRv], { cwd: root, encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.match(second.stdout + second.stderr, /0 files|unchanged|no changes|idempotent|identical/i);
  }
});

test('client and server RV package mins stay synced', () => {
  const lengthBlock = extractRvLength(read('index.html'));
  for (const id of FINAL_IDS) {
    const rule = LENGTH_PRICING.rvs.packages[id];
    assert.match(
      lengthBlock,
      new RegExp(`${id}:\\s*\\{perFt:\\s*${rule.perFt},\\s*min:\\s*${rule.min}\\}`),
    );
  }
  const bridge = read('assets/specialty-booking-bridge.js');
  for (const id of FINAL_IDS) {
    assert.match(bridge, new RegExp(`\\b${id}:\\s*1`));
  }
});
