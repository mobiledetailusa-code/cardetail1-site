/**
 * Repricing tool. Two steps, in this order:
 *
 *   1. apply a percentage change to the server catalog
 *   2. sync every booking page's price table FROM that catalog
 *
 *   node scripts/apply-package-price-change.mjs --percent -15
 *   node scripts/apply-package-price-change.mjs --sync-only
 *
 * Step 2 is a sync, not a second multiplication, and that distinction matters.
 * The pages each carry their own copy of the price table, and eight of them had
 * silently drifted from the server on the Full Detail row. Multiplying both sides
 * independently would have preserved that drift at the new price level. Deriving
 * the pages from the catalog removes it and cannot reintroduce it.
 *
 * In scope:
 *   PRICING[cat].tiers           cars, powersports, fleet (charged per unit)
 *   LENGTH_PRICING[cat].packages boats, rvs, fleet marine (charged per foot)
 *
 * Boats and RVs are charged by length, so their tier tables are display-only.
 * Both move together, so the number a customer reads is the number they pay.
 *
 * Out of scope: add-ons, travel fee, and the length bounds (min/max/defaultFt are
 * feet, not money).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = path.join(ROOT, 'netlify/lib/booking-price-catalog.js');

const args = process.argv.slice(2);
const syncOnly = args.includes('--sync-only');
const pctIdx = args.indexOf('--percent');
if (!syncOnly && (pctIdx < 0 || !args[pctIdx + 1])) {
  console.error('usage: node scripts/apply-package-price-change.mjs --percent -15 | --sync-only');
  process.exit(1);
}
const PERCENT = syncOnly ? 0 : Number(args[pctIdx + 1]);
if (!Number.isFinite(PERCENT) || PERCENT <= -100) {
  console.error('--percent must be a finite number greater than -100');
  process.exit(1);
}
const FACTOR = 1 + PERCENT / 100;

const TIER_PRICE_KEYS = [
  'maint', 'maint_light', 'interior', 'exterior', 'essential', 'wash',
  'full', 'full_basic', 'refresh', 'premium', 'custom',
];
const LENGTH_PRICE_KEYS = ['perFt', 'min', 'base', 'ratePerFoot'];

/**
 * Round flat/base/minimum package amounts to the nearest $5. Per-foot rates
 * stay whole dollars — rounding those to $5 would distort a long vehicle by far
 * more than the intended percentage.
 */
function repriceValue(value, key) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return n;
  const next = n * FACTOR;
  if (key === 'perFt' || key === 'ratePerFoot') return Math.max(1, Math.round(next));
  return Math.max(5, Math.round(next / 5) * 5);
}

/**
 * Walks a source file and visits only the two known price blocks, tracking brace
 * depth so a `min:` that means feet is never mistaken for one that means dollars.
 * `visit(key, value, block)` returns the replacement value.
 */
function transformPriceBlocks(src, visit) {
  const lines = src.split('\n');
  let inPricing = false;
  let inTiers = false;
  let inLength = false;
  let inPackages = false;
  let depth = 0;
  let tierKey = null;
  let category = null;
  let pkgKey = null;

  const out = lines.map((line) => {
    if (/^\s*(const\s+)?PRICING\s*=\s*\{/.test(line)) { inPricing = true; depth = 0; }
    if (/^\s*(const\s+)?LENGTH_PRICING\s*=\s*\{/.test(line)) { inLength = true; depth = 0; }

    if ((inPricing || inLength) && depth === 1) {
      const m = line.match(/^\s*'?([A-Za-z_][\w]*)'?\s*:\s*\{/);
      if (m) category = m[1];
    }
    // Tier rows sit at depth 3 (PRICING > category > tiers > row), same as
    // package rows. Reading them at depth 2 leaves tierKey null, and the sync
    // then silently falls back to the page's existing value.
    if (inTiers && depth === 3) {
      const m = line.match(/^\s*'?([\w-]+)'?\s*:\s*\{/);
      if (m) tierKey = m[1];
    }
    if (inPackages && depth === 3) {
      const m = line.match(/^\s*'?([\w-]+)'?\s*:\s*\{/);
      if (m) pkgKey = m[1];
    }

    let result = line;
    const keys = (inPricing && inTiers) ? TIER_PRICE_KEYS
      : (inLength && inPackages) ? LENGTH_PRICE_KEYS
        : null;
    if (keys) {
      for (const key of keys) {
        const re = new RegExp(`(\\b${key}\\s*:\\s*)(\\d+(?:\\.\\d+)?)`, 'g');
        result = result.replace(re, (m0, prefix, num) => prefix + visit({
          block: inTiers ? 'tiers' : 'packages',
          category,
          tierKey: inTiers ? tierKey : pkgKey,
          key,
          value: Number(num),
        }));
      }
    }

    if (inPricing && /\btiers\s*:\s*\{/.test(line)) inTiers = true;
    if (inLength && /\bpackages\s*:\s*\{/.test(line)) inPackages = true;

    for (const ch of line) {
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        // Leave the block as soon as its closing brace lands, so a sibling key
        // (addons, length bounds) is never treated as a price.
        if (depth <= 2) { inTiers = false; inPackages = false; }
        if (depth <= 0) { inPricing = false; inLength = false; }
      }
    }
    return result;
  });

  return out.join('\n');
}

/* ── Step 1: reprice the server catalog ──────────────────────────────────── */

if (!syncOnly) {
  const before = fs.readFileSync(CATALOG, 'utf8');
  let changed = 0;
  const after = transformPriceBlocks(before, ({ key, value }) => {
    const next = repriceValue(value, key);
    if (next !== value) changed += 1;
    return next;
  });
  fs.writeFileSync(CATALOG, after);
  console.log(`catalog  ${PERCENT > 0 ? '+' : ''}${PERCENT}%  — ${changed} values changed`);
}

/* ── Step 2: sync every page from the repriced catalog ───────────────────── */

// Cache-busted so step 2 reads the file step 1 just wrote, not a stale module.
const { PRICING, LENGTH_PRICING } = await import(`file://${CATALOG}?t=${Date.now()}`)
  .then((m) => m.default || m);

function authoritativeValue({ block, category, tierKey, key, value }) {
  if (block === 'tiers') {
    const v = PRICING?.[category]?.tiers?.[tierKey]?.[key];
    return typeof v === 'number' ? v : value;
  }
  const v = LENGTH_PRICING?.[category]?.packages?.[tierKey]?.[key];
  return typeof v === 'number' ? v : value;
}

function minTierPrice(category, packageId) {
  return Math.min(...Object.values(PRICING[category].tiers)
    .map((tier) => Number(tier[packageId]))
    .filter((price) => price > 0));
}

const STATIC_PRICES = Object.freeze({
  carInterior: minTierPrice('cars', 'interior'),
  carRefresh: minTierPrice('cars', 'refresh'),
  carFullSmall: PRICING.cars.tiers.small.full,
  carFullSuv2: PRICING.cars.tiers.suv2.full,
  carFullSuv3: PRICING.cars.tiers.suv3.full,
  boats: LENGTH_PRICING.boats.packages.maint.min,
  rvs: LENGTH_PRICING.rvs.packages.maint.base
    + LENGTH_PRICING.rvs.packages.maint.ratePerFoot * LENGTH_PRICING.rvs.min,
  powersports: minTierPrice('powersports', 'wash'),
});

function syncBookingPageSurfaces(src) {
  return src
    .replace(/(id="home-from-interior">\$)[\d,]+/g, `$1${STATIC_PRICES.carInterior}`)
    .replace(/(id="home-from-refresh">\$)[\d,]+/g, `$1${STATIC_PRICES.carRefresh}`)
    .replace(
      /(id="home-from-full-note">)Sedans from \$[\d,]+ · SUVs from \$[\d,]+ · 3-row SUVs from \$[\d,]+/g,
      `$1Sedans from $${STATIC_PRICES.carFullSmall} · SUVs from $${STATIC_PRICES.carFullSuv2} · 3-row SUVs from $${STATIC_PRICES.carFullSuv3}`,
    )
    .replace(/(id="bkfrom-boats"[^>]*>From \$)[\d,]+/g, `$1${STATIC_PRICES.boats}`)
    .replace(/(id="bkfrom-powersports"[^>]*>From \$)[\d,]+/g, `$1${STATIC_PRICES.powersports}`)
    .replace(
      /(id="bkfrom-rvs"[^>]*>)(?:From \$[\d,.]+(?:\/ft)?|Price calculated from your vehicle details\.)(<\/div>)/g,
      '$1Price calculated from your vehicle details.$2',
    )
    .replace(/(id="hfrom-boats-amt">\$)[\d,]+/g, `$1${STATIC_PRICES.boats}`)
    .replace(/(id="hfrom-rvs-amt">\$)[\d,]+/g, `$1${STATIC_PRICES.rvs}`)
    .replace(/(id="hfrom-powersports-amt">\$)[\d,]+/g, `$1${STATIC_PRICES.powersports}`)
    .replace(/^(\s*cars:\s+\{.*from:'From \$)[\d,]+('.*)$/gm, `$1${STATIC_PRICES.carInterior}$2`)
    .replace(/^(\s*boats:\s+\{.*from:'From \$)[\d,]+('.*)$/gm, `$1${STATIC_PRICES.boats}$2`)
    .replace(/^(\s*powersports:\s*\{.*from:'From \$)[\d,]+('.*)$/gm, `$1${STATIC_PRICES.powersports}$2`)
    .replace(
      /LENGTH_PRICING\.rvs\.packages\.exterior\.min/g,
      "getLengthPrice('rvs','maint',LENGTH_PRICING.rvs.min,'travel')",
    );
}

function replacePackageMinimum(src, packageMarker, value) {
  const re = new RegExp(
    `(${packageMarker}[\\s\\S]*?<p class="sp-pkg-basis">Priced by exact RV length · min \\$)[\\d,]+`,
  );
  return src.replace(re, `$1${value}`);
}

function syncSpecialtyPages(file, src) {
  if (file === 'boats-detailing.html') {
    return src
      .replace(/(<h3 class="sp-pkg-name">Marine Wash<\/h3>[\s\S]*?<div class="sp-pkg-price">From \$)[\d,]+/, `$1${LENGTH_PRICING.boats.packages.maint.min}`)
      .replace(/(<h3 class="sp-pkg-name">Full Marine Detail<\/h3>[\s\S]*?<div class="sp-pkg-price">From \$)[\d,]+/, `$1${LENGTH_PRICING.boats.packages.full.min}`)
      .replace(/(<h3 class="sp-pkg-name">Premium Marine<\/h3>[\s\S]*?<div class="sp-pkg-price">From \$)[\d,]+/, `$1${LENGTH_PRICING.boats.packages.premium.min}`);
  }
  if (file === 'powersports-detailing.html') {
    return src
      .replace(/(<h3 class="sp-pkg-name">Wash &amp; Shine<\/h3>[\s\S]*?<div class="sp-pkg-price">From \$)[\d,]+/, `$1${minTierPrice('powersports', 'wash')}`)
      .replace(/(<h3 class="sp-pkg-name">Full Detail<\/h3>[\s\S]*?<div class="sp-pkg-price">From \$)[\d,]+/, `$1${minTierPrice('powersports', 'full')}`)
      .replace(/(<h3 class="sp-pkg-name">Premium Detail<\/h3>[\s\S]*?<div class="sp-pkg-price">From \$)[\d,]+/, `$1${minTierPrice('powersports', 'premium')}`);
  }
  if (file === 'rv-detailing.html') {
    let out = src;
    for (const [packageId, rule] of Object.entries(LENGTH_PRICING.rvs.packages)) {
      const minimum = rule.base + rule.ratePerFoot * LENGTH_PRICING.rvs.min;
      out = replacePackageMinimum(out, `data-rv-tier="${packageId}"`, minimum);
    }
    return out;
  }
  return src;
}

const pages = fs.readdirSync(ROOT)
  .filter((f) => f.endsWith('.html'))
  .filter((f) => /const PRICING\s*=/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));

let corrected = 0;
for (const file of pages) {
  const p = path.join(ROOT, file);
  const before = fs.readFileSync(p, 'utf8');
  let drift = 0;
  let after = transformPriceBlocks(before, (ctx) => {
    const authoritative = authoritativeValue(ctx);
    if (authoritative !== ctx.value) drift += 1;
    return authoritative;
  });
  after = syncBookingPageSurfaces(after);
  if (before !== after) fs.writeFileSync(p, after);
  corrected += drift;
  console.log(`${before === after ? 'in sync ' : 'synced  '} ${file}${drift ? `  (${drift} values)` : ''}`);
}

console.log(`\n${pages.length} pages synced from the catalog — ${corrected} values written`);

for (const file of ['boats-detailing.html', 'powersports-detailing.html', 'rv-detailing.html']) {
  const p = path.join(ROOT, file);
  const before = fs.readFileSync(p, 'utf8');
  const after = syncSpecialtyPages(file, before);
  if (after !== before) fs.writeFileSync(p, after);
  console.log(`${after === before ? 'in sync ' : 'synced  '} ${file}`);
}
