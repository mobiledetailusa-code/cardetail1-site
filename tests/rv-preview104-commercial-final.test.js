'use strict';

/**
 * Preview 104 selective commercial port — presentation + six-package booking gates.
 * Funnel removed; six-step booking with RV Vehicle-step fields preserved.
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
  resolveRvTypeKey,
  computeVehicleSubtotal,
  computeAddonTotal,
} = require('../netlify/lib/booking-price-catalog');

const {
  RV_TYPES,
  ADJUSTED_RATES,
  RV_PACKAGE_META,
  eligiblePackagesForType,
} = require('../netlify/lib/rv-type-catalog');

const PKG_IDS = ['maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'];
const RATES = {
  maint: { perFt: 12.75, min: 225 },
  maint_light: { perFt: 16, min: 229 },
  interior: { perFt: 21, min: 249 },
  full_basic: { perFt: 31, min: 399 },
  premium: { perFt: 33, min: 449 },
  full: { perFt: 49.5, min: 699 },
};

function extractRvLength(html) {
  const m = html.match(/LENGTH_PRICING\s*=\s*\{[\s\S]*?rvs:\s*\{[\s\S]*?packages:\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(m, 'LENGTH_PRICING.rvs missing');
  return m[1];
}

// ── FUNNEL REMOVED ───────────────────────────────────────────────────────────
test('funnel assets and attributes are gone from RV page', () => {
  const page = read('rv-detailing.html');
  assert.doesNotMatch(page, /rv-pricing-funnel/);
  assert.doesNotMatch(page, /data-rv-price-funnel/);
  assert.doesNotMatch(page, /CHECK PRICE &amp; AVAILABILITY/);
  assert.doesNotMatch(page, /rv-open-funnel/);
  assert.ok(!fs.existsSync(path.join(root, 'assets/rv-pricing-funnel.js')));
  assert.ok(!fs.existsSync(path.join(root, 'assets/rv-pricing-funnel.css')));
});

test('membership section removed from RV page', () => {
  const page = read('rv-detailing.html');
  assert.doesNotMatch(page, /id="membership"/);
  assert.doesNotMatch(page, /RV Care Membership/);
  assert.doesNotMatch(page, /Interest list only/);
});

// ── COMMERCIAL PRESENTATION ──────────────────────────────────────────────────
test('compact tabbed packages with booking CTAs', () => {
  const page = read('rv-detailing.html');
  assert.match(page, /assets\/rv-commercial\.css/);
  assert.match(page, /assets\/rv-package-tabs\.js/);
  assert.match(page, /data-rv-tablist/);
  assert.match(page, /Outside Only/);
  assert.match(page, /Inside Only/);
  assert.match(page, /Inside &amp; Out/);
  assert.match(page, /id="rv-panel-outside"/);
  assert.match(page, /id="rv-panel-inside"/);
  assert.match(page, /id="rv-panel-both"/);
  assert.equal((page.match(/data-rv-tier="/g) || []).length, 6);
  assert.match(page, /Starting at \$12\.75\/ft/);
  assert.match(page, /Starting at \$31\/ft/);
  assert.match(page, /MOST POPULAR/);
  assert.match(page, /BEST FINISH/);
  assert.match(page, /data-rv-tier="full_basic"[\s\S]*?MOST POPULAR/);
  const ctas = page.match(/package-booking-cta[^>]*data-booking-category="rvs"/g) || [];
  assert.ok(ctas.length >= 8);
  for (const id of PKG_IDS) {
    assert.match(page, new RegExp(`data-booking-package="${id}"`));
  }
});

test('hero and bottom CTA book online not funnel', () => {
  const page = read('rv-detailing.html');
  assert.match(page, /href="index\.html\?book=rvs"/);
  assert.match(page, /data-booking-package="full_basic"/);
  assert.match(page, /Length-based pricing/);
  assert.doesNotMatch(page, /ZIP-first estimates/);
});

test('no service hours or From totals on cards', () => {
  const page = read('rv-detailing.html');
  assert.doesNotMatch(page, /~\d+–\d+h|~\d+h|Service duration depends/);
  assert.doesNotMatch(page, /From \$899|From \$1,?199|From \$1,?499/);
  assert.doesNotMatch(page, /Estimated total for your \d+-ft/);
});

test('gallery unchanged', () => {
  const page = read('rv-detailing.html');
  assert.match(page, /vienna-front-after-768\.jpg/);
  assert.match(page, /wingamm-front-after-768\.jpg/);
  assert.match(page, /data-specialty-gallery="rv-before-after"/);
});

// ── RATES ────────────────────────────────────────────────────────────────────
test('authoritative LENGTH_PRICING.rvs rates', () => {
  for (const id of PKG_IDS) {
    const rule = LENGTH_PRICING.rvs.packages[id];
    assert.equal(rule.perFt, RATES[id].perFt, id);
    assert.equal(rule.min, RATES[id].min, id);
    assert.equal(ADJUSTED_RATES[id], RATES[id].perFt, id);
  }
  assert.equal(12.75 * 19, 242.25);
  assert.equal(getLengthPrice('rvs', 'maint', 19, 'travel'), 242.25);
});

test('client and server LENGTH_PRICING.rvs synced', () => {
  const block = extractRvLength(read('index.html'));
  for (const id of PKG_IDS) {
    const rule = LENGTH_PRICING.rvs.packages[id];
    assert.match(block, new RegExp(`${id}:\\s*\\{perFt:\\s*${rule.perFt},\\s*min:\\s*${rule.min}\\}`));
  }
});

test('full_basic formula uses maint+interior bundle', () => {
  assert.equal(ADJUSTED_RATES.full_basic, 31);
  assert.ok(ADJUSTED_RATES.full_basic < ADJUSTED_RATES.maint + ADJUSTED_RATES.interior);
});

// ── RV TYPES ─────────────────────────────────────────────────────────────────
test('expanded RV_TYPES with living-quarters gate', () => {
  for (const k of ['travel', 'fifthwheel', 'classA', 'classB', 'classC', 'airstream', 'cargo', 'horse', 'other']) {
    assert.ok(RV_TYPES[k], k);
  }
  assert.deepEqual(eligiblePackagesForType('cargo', 'no'), ['maint', 'premium']);
  assert.ok(eligiblePackagesForType('horse', 'yes').includes('full_basic'));
  assert.equal(resolveRvTypeKey({ rvType: 'classB' }), 'classB');
  assert.equal(resolveRvTypeKey({ rvType: 'classBC' }), 'classC');
  assert.equal(resolveRvTypeKey({ rvType: 'specialty' }), 'other');
});

// ── ADD-ONS ──────────────────────────────────────────────────────────────────
test('Super Interior $135; Sanitize $75; no mold for new RV', () => {
  assert.equal(PRICING.rvs.addons.find((a) => a.id === 'superint').price, 135);
  assert.equal(PRICING.rvs.addons.find((a) => a.id === 'sanitize').price, 75);
  assert.ok(!PRICING.rvs.addons.some((a) => a.id === 'mold'));
  assert.doesNotMatch(read('rv-detailing.html'), /Mold Treatment/);
});

// ── BOOKING / INDEX ──────────────────────────────────────────────────────────
test('index Vehicle step RV fields and no default length pricing', () => {
  const index = read('index.html');
  assert.match(index, /id="rv-type-wrap"/);
  assert.match(index, /id="rv-type-sel"/);
  assert.match(index, /id="rv-living-wrap"/);
  assert.match(index, /id="length-input"/);
  assert.match(index, /id="rv-service-subtotal"/);
  assert.match(index, /ST\.lengthFt = 0/);
  assert.match(index, /Exact RV Length/);
  assert.match(index, /bs2-rv-note/);
  assert.match(index, /BK_VISIBLE_STEPS\s*=\s*6|bpt6|Step 06/);
  assert.match(index, /From \$12\.75\/ft/);
});

test('specialty bridge uses openCategoryPackageBooking only', () => {
  const bridge = read('assets/specialty-booking-bridge.js');
  assert.match(bridge, /openCategoryPackageBooking/);
  assert.doesNotMatch(bridge, /rv-pricing-funnel|data-rv-price-funnel/);
  assert.match(bridge, /maint_light: 1, interior: 1, full_basic: 1/);
});

test('other categories unchanged', () => {
  assert.equal(LENGTH_PRICING.boats.packages.maint.min, 199);
  assert.equal(PRICING.cars.tiers.small.interior, 225);
  assert.equal(PRICING.powersports.tiers.motorcycle.wash, 119);
});

test('SYNC: rv pricing blocks idempotent', () => {
  const syncRv = path.join(root, 'scripts/sync-rv-pricing-blocks.mjs');
  const first = spawnSync(nodeBin, [syncRv], { cwd: root, encoding: 'utf8' });
  const second = spawnSync(nodeBin, [syncRv], { cwd: root, encoding: 'utf8' });
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /0 file\(s\) changed/);
});

test('package meta badges', () => {
  assert.equal(RV_PACKAGE_META.full_basic.badge, 'MOST POPULAR');
  assert.equal(RV_PACKAGE_META.full.badge, 'BEST FINISH');
});

test('manipulated addon prices rejected server-side', () => {
  const r = computeVehicleSubtotal({
    cat: 'rvs', pkgId: 'interior', lengthFt: 24, rvType: 'travel',
    addons: [{ id: 'superint', price: 1 }, { id: 'sanitize', price: 1 }],
  }, '07601');
  assert.equal(r.ok, true);
  assert.equal(r.addonTotal, 210);
  const mold = computeAddonTotal({ cat: 'rvs', addons: [{ id: 'mold', price: 149 }] });
  assert.equal(mold.ok, false);
});
