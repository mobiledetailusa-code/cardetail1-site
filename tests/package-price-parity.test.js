const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const {
  PRICING,
  LENGTH_PRICING,
  getLengthPrice,
} = require('../netlify/lib/booking-price-catalog');

const BOOKING_PAGES = [
  'bergen-county-hub.html',
  'connecticut-hub.html',
  'essex-county-hub.html',
  'hudson-county-hub.html',
  'index.html',
  'new-jersey-hub.html',
  'newark-mobile-detailing.html',
  'ny-metro-hub.html',
  'passaic-county-hub.html',
  'pennsylvania-hub.html',
  'template-city.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
];

const OUT_OF_SCOPE_ADDON_PRICES = {
  cars: { pethair: 95, superint: 125, odor: 90, mold: 149, sanitize: 65, biohazard: 115, engine: 45, floormats: 20, rainx: 25, polymer: 25, wax1yr: 75, claybar: 45, headlight: 90, babyseat: 20, stroller: 20, trashcans: 25, ozone: 40 },
  boats: { rainx: 25, polymer: 25, wax1yr: 75, chrome: 85, odor: 90, mold: 149, sanitize: 65, biohazard: 115, trashcans: 25 },
  rvs: { polymer: 25, wax1yr: 75, rainx: 25, biohazard: 115, sanitize: 75, superint: 135, awning: 50, roof: 50, capfront: 149, pethair: 95, odor: 90, trashcans: 25 },
  powersports: { polymer: 25, wax1yr: 75, rainx: 25, heavymud: 55, seatdeep: 45, storage: 35, wheeldet: 35, waterspot: 35, saltwash: 35, trimprot: 35, lightdeg: 45 },
  fleet: { polymer: 25, trashcans: 25, disinfect: 20, biohazard: 115, odor: 99, heavymud: 65 },
};

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function extractAssignedObject(source, name) {
  // `let` is used on index.html for PRICING / LENGTH_PRICING because the Owner Studio
  // saved-draft preview replaces them at runtime; both declaration forms are valid here.
  const declaration = new RegExp(`(?:const|let)\\s+${name}\\s*=`);
  const declarationMatch = declaration.exec(source);
  assert.notEqual(declarationMatch, null, `${name} assignment missing`);
  const markerAt = declarationMatch.index;
  const start = source.indexOf('{', markerAt + declarationMatch[0].length);
  assert.notEqual(start, -1, `${name} opening brace missing`);

  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return vm.runInNewContext(`(${source.slice(start, i + 1)})`);
      }
    }
  }
  assert.fail(`${name} closing brace missing`);
}

function catalogPriceEntries() {
  const entries = [];
  for (const [category, catalog] of Object.entries(PRICING)) {
    for (const [tier, row] of Object.entries(catalog.tiers)) {
      for (const [packageId, price] of Object.entries(row)) {
        if (typeof price === 'number') {
          entries.push({ source: 'PRICING', category, tier, packageId, key: null, price });
        }
      }
    }
  }
  for (const [category, catalog] of Object.entries(LENGTH_PRICING)) {
    for (const [packageId, row] of Object.entries(catalog.packages)) {
      for (const [key, price] of Object.entries(row)) {
        if (typeof price === 'number') {
          entries.push({ source: 'LENGTH_PRICING', category, tier: null, packageId, key, price });
        }
      }
    }
  }
  return entries;
}

test('13 booking pages match all 144 authoritative package values (1,872 comparisons)', () => {
  const discovered = fs.readdirSync(ROOT)
    .filter((file) => file.endsWith('.html'))
    .filter((file) => /(?:const|let)\s+PRICING\s*=/.test(read(file)))
    .sort();
  assert.deepEqual(discovered, BOOKING_PAGES.slice().sort());

  const entries = catalogPriceEntries();
  assert.equal(entries.length, 144);
  let comparisons = 0;
  for (const file of BOOKING_PAGES) {
    const html = read(file);
    const pagePricing = extractAssignedObject(html, 'PRICING');
    const pageLengthPricing = extractAssignedObject(html, 'LENGTH_PRICING');
    for (const entry of entries) {
      const actual = entry.source === 'PRICING'
        ? pagePricing[entry.category].tiers[entry.tier][entry.packageId]
        : pageLengthPricing[entry.category].packages[entry.packageId][entry.key];
      assert.equal(actual, entry.price, `${file}: ${JSON.stringify(entry)}`);
      comparisons += 1;
    }
  }
  assert.equal(comparisons, 1872);
});

test('server length helpers and RV calculator derive from the authoritative catalog', () => {
  const lengthModule = require('../netlify/lib/length-pricing');
  const rvModule = require('../netlify/lib/rv-type-catalog');
  assert.strictEqual(lengthModule.LENGTH_PRICING, LENGTH_PRICING);
  assert.strictEqual(rvModule.RV_RATE_TABLE, LENGTH_PRICING.rvs.packages);

  for (const typeKey of Object.keys(rvModule.RV_TYPES)) {
    for (const packageId of Object.keys(LENGTH_PRICING.rvs.packages)) {
      for (const feet of [12, 19, 23, 30, 40, 45]) {
        assert.equal(
          rvModule.computeRvServicePrice(packageId, feet, typeKey),
          getLengthPrice('rvs', packageId, feet, typeKey),
          `${typeKey}/${packageId}/${feet}ft`,
        );
      }
    }
  }
});

test('add-ons remain at their pre-repricing amounts on server and browser', () => {
  for (const [category, expected] of Object.entries(OUT_OF_SCOPE_ADDON_PRICES)) {
    const server = Object.fromEntries(PRICING[category].addons.map((addon) => [addon.id, addon.price]));
    assert.deepEqual(server, expected, `${category} server add-ons changed`);
  }

  for (const file of BOOKING_PAGES) {
    const pagePricing = extractAssignedObject(read(file), 'PRICING');
    for (const [category, expected] of Object.entries(OUT_OF_SCOPE_ADDON_PRICES)) {
      const browser = Object.fromEntries(pagePricing[category].addons.map((addon) => [addon.id, addon.price]));
      const browserExpected = category === 'cars'
        ? Object.fromEntries(Object.entries(expected).filter(([id]) => id !== 'ozone'))
        : expected;
      assert.deepEqual(browser, browserExpected, `${file}: ${category} browser add-ons changed`);
    }
  }
});

test('commercial rounding is consistent for flat/base/minimum package amounts', () => {
  for (const catalog of Object.values(PRICING)) {
    for (const row of Object.values(catalog.tiers)) {
      for (const price of Object.values(row).filter((value) => typeof value === 'number' && value > 0)) {
        assert.equal(price % 5, 0, `flat package price ${price} is not a $5 increment`);
      }
    }
  }
  for (const catalog of Object.values(LENGTH_PRICING)) {
    for (const row of Object.values(catalog.packages)) {
      for (const [key, price] of Object.entries(row)) {
        if (price > 0 && key !== 'perFt' && key !== 'ratePerFoot') {
          assert.equal(price % 5, 0, `${key} package price ${price} is not a $5 increment`);
        }
      }
    }
  }
});

test('static starting-price surfaces are verified against the catalog', () => {
  const carInterior = Math.min(...Object.values(PRICING.cars.tiers).map((tier) => tier.interior));
  const carRefresh = Math.min(...Object.values(PRICING.cars.tiers).map((tier) => tier.refresh));
  const boat = LENGTH_PRICING.boats.packages.maint.min;
  const rv = getLengthPrice('rvs', 'maint', LENGTH_PRICING.rvs.min, 'travel');
  const powersports = Math.min(...Object.values(PRICING.powersports.tiers).map((tier) => tier.wash));

  for (const file of BOOKING_PAGES) {
    const html = read(file);
    assert.match(html, new RegExp(`id="bkfrom-boats"[^>]*>From \\$${boat}<`), file);
    assert.match(html, new RegExp(`id="bkfrom-powersports"[^>]*>From \\$${powersports}<`), file);
    assert.match(html, /id="bkfrom-rvs"[^>]*>Price calculated from your vehicle details\.</, file);
    assert.match(html, new RegExp(`cars:\\s+\\{[^\\n]*from:'From \\$${carInterior}'`), file);
    assert.match(html, new RegExp(`boats:\\s+\\{[^\\n]*from:'From \\$${boat}'`), file);
    assert.match(html, new RegExp(`powersports:\\s*\\{[^\\n]*from:'From \\$${powersports}'`), file);
    assert.doesNotMatch(html, /LENGTH_PRICING\.rvs\.packages\.exterior\.min/, file);
  }

  for (const file of ['index.html', 'new-jersey-hub.html', 'connecticut-hub.html', 'ny-metro-hub.html', 'pennsylvania-hub.html']) {
    const html = read(file);
    assert.match(html, new RegExp(`id="home-from-interior">\\$${carInterior}<`), file);
    assert.match(html, new RegExp(`id="home-from-refresh">\\$${carRefresh}<`), file);
    assert.match(html, new RegExp(`Sedans from \\$${PRICING.cars.tiers.small.full} · SUVs from \\$${PRICING.cars.tiers.suv2.full} · 3-row SUVs from \\$${PRICING.cars.tiers.suv3.full}`), file);
  }

  for (const file of ['new-jersey-hub.html', 'connecticut-hub.html', 'ny-metro-hub.html', 'pennsylvania-hub.html']) {
    const html = read(file);
    assert.match(html, new RegExp(`id="hfrom-boats-amt">\\$${boat}<`), file);
    assert.match(html, new RegExp(`id="hfrom-rvs-amt">\\$${rv}<`), file);
    assert.match(html, new RegExp(`id="hfrom-powersports-amt">\\$${powersports}<`), file);
  }

  assert.match(read('boats-detailing.html'), new RegExp(`Marine Wash[\\s\\S]*?From \\$${boat}<`));
  assert.match(read('powersports-detailing.html'), new RegExp(`Wash &amp; Shine[\\s\\S]*?From \\$${powersports}<`));
  for (const [packageId, rule] of Object.entries(LENGTH_PRICING.rvs.packages)) {
    const minimum = rule.base + rule.ratePerFoot * LENGTH_PRICING.rvs.min;
    assert.match(read('rv-detailing.html'), new RegExp(`data-rv-tier="${packageId}"[\\s\\S]*?min \\$${minimum}<`));
  }
});

test('AI chat starting prices are derived from the same catalog', () => {
  const { BUSINESS_SYSTEM, CHAT_STARTING_PRICES } = require('../netlify/functions/ai-chat');
  assert.deepEqual(CHAT_STARTING_PRICES, {
    cars: 190,
    carMaintenance: 150,
    boats: 170,
    rvs: 238,
    powersports: 100,
  });
  for (const price of Object.values(CHAT_STARTING_PRICES)) {
    assert.match(BUSINESS_SYSTEM, new RegExp(`\\$${price}\\b`));
  }
});

test('legacy patch scripts cannot restore stale package prices', () => {
  const addonPatcher = read('scripts/patch-addon-catalog.mjs');
  assert.doesNotMatch(
    addonPatcher,
    /const serverPath|server\.replace\(/,
    'legacy add-on patcher must not contain a historical server-tier payload',
  );

  for (const file of ['scripts/patch-inclusive-from-prices.js', 'scripts/patch-inclusive-from-prices.ps1']) {
    const source = read(file);
    assert.doesNotMatch(source, /LENGTH_PRICING\.rvs\.packages\.exterior\.min/, file);
    assert.doesNotMatch(source, /From \$60\/unit/, file);
    assert.match(source, /getLengthPrice\('rvs','maint',LENGTH_PRICING\.rvs\.min\)/, file);
    assert.match(source, /From \$50\/unit/, file);
  }

  const rvLegacyEntry = read('scripts/patch-rv-five-packages.mjs');
  assert.match(rvLegacyEntry, /apply-package-price-change\.mjs/);
  assert.match(rvLegacyEntry, /--sync-only/);
  assert.doesNotMatch(rvLegacyEntry, /data-per-ft|data-min|Starting at \$/);

  const stateTheme = read('scripts/apply-state-hub-theme.mjs');
  assert.doesNotMatch(stateTheme, /full:300|full:325, refresh/);
});
