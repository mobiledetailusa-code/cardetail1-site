'use strict';

/**
 * RV per-foot pricing + five-package commercial model gates.
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

const PKG_IDS = ['maint', 'maint_light', 'interior', 'premium', 'full'];

test('every supported length uses exact ft × perFt with package min', () => {
  const cfg = LENGTH_PRICING.rvs;
  assert.equal(cfg.min, 12);
  assert.equal(cfg.max, 45);
  assert.equal(cfg.defaultFt, 20);
  for (let ft = cfg.min; ft <= cfg.max; ft += 1) {
    for (const id of PKG_IDS) {
      const rule = cfg.packages[id];
      assert.equal(
        getLengthPrice('rvs', id, ft),
        Math.max(rule.min, Math.round(rule.perFt * ft)),
      );
    }
  }
  assert.ok(getLengthPrice('rvs', 'premium', 20) < getLengthPrice('rvs', 'premium', 24));
  assert.notEqual(getLengthPrice('rvs', 'maint_light', 20), getLengthPrice('rvs', 'maint_light', 24));
});

test('no double-count: price is not min + perFt*(ft-24)', () => {
  for (const id of PKG_IDS) {
    const rule = LENGTH_PRICING.rvs.packages[id];
    const ft = 30;
    const expected = Math.max(rule.min, Math.round(rule.perFt * ft));
    assert.equal(getLengthPrice('rvs', id, ft), expected);
    assert.notEqual(getLengthPrice('rvs', id, ft), rule.min + Math.round(rule.perFt * (ft - 24)));
  }
});

test('Super Interior $135; Sanitize $75; Mold absent', () => {
  assert.equal(PRICING.rvs.addons.find((a) => a.id === 'superint').price, 135);
  assert.equal(PRICING.rvs.addons.find((a) => a.id === 'sanitize').price, 75);
  assert.ok(!PRICING.rvs.addons.some((a) => a.id === 'mold'));
  assert.equal(computeAddonTotal({ cat: 'rvs', addons: [{ id: 'superint' }] }).total, 135);
  assert.equal(computeAddonTotal({ cat: 'rvs', addons: [{ id: 'sanitize' }] }).total, 75);
});

test('cards show Starting at $/ft; length selector present; five packages only', () => {
  const page = read('rv-detailing.html');
  assert.match(page, /Starting at \$8\/ft/);
  assert.match(page, /Starting at \$15\/ft/);
  assert.match(page, /Starting at \$44\/ft/);
  assert.doesNotMatch(page, /From \$899\b|From \$1,?299|From \$1,?499/);
  assert.match(page, /id="rv-length-range"/);
  assert.equal((page.match(/data-rv-tier="/g) || []).length, 5);
  assert.match(page, /Maintenance Wash \+ Light Interior/);
  assert.match(page, /Premium Complete RV Detail/);
  assert.doesNotMatch(page, /One-Step Paint Correction \+/);
});

test('frontend formula matches backend; manipulated addon prices rejected', () => {
  const ft = 22;
  for (const id of PKG_IDS) {
    const front = Math.max(
      LENGTH_PRICING.rvs.packages[id].min,
      Math.round(LENGTH_PRICING.rvs.packages[id].perFt * ft),
    );
    assert.equal(getLengthPrice('rvs', id, ft), front);
    const total = computeVehicleSubtotal({
      cat: 'rvs',
      pkgId: id,
      lengthFt: ft,
      addons: [],
    }, '07650');
    assert.equal(total.ok, true);
    assert.equal(total.basePrice, front);
  }
  const hacked = computeVehicleSubtotal({
    cat: 'rvs',
    pkgId: 'full',
    lengthFt: 22,
    addons: [{ id: 'superint', price: 1 }],
  }, '07650');
  assert.equal(hacked.addonTotal, 135);
});

test('package hierarchy valid; other categories unchanged', () => {
  for (const ft of [20, 24, 30, 40, 45]) {
    const p = Object.fromEntries(PKG_IDS.map((id) => [id, getLengthPrice('rvs', id, ft)]));
    assert.ok(p.maint < p.maint_light);
    assert.ok(p.premium > p.maint_light);
    assert.ok(p.full > p.premium);
    assert.ok(p.full > p.interior);
  }
  const index = read('index.html');
  assert.match(index, /BK_VISIBLE_STEPS\s*=\s*6/);
  assert.match(index, /boats:[\s\S]*?maint:\s*\{perFt:\s*12,\s*min:\s*199\}/);
  assert.match(index, /id="home-from-interior">\$225/);
  assert.equal(LENGTH_PRICING.boats.packages.full.min, 449);
  assert.equal(LENGTH_PRICING.fleet.packages.maint.min, 199);
});

test('public-surface sync remains idempotent', () => {
  const first = spawnSync(nodeBin, ['scripts/sync-public-surface.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const second = spawnSync(nodeBin, ['scripts/sync-public-surface.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.match(second.stdout + second.stderr, /0 file|unchanged|no change|idempotent|0 diff|skipped/i);
});
