// Add-on dedup + ticker copy hotfix (branch: addon-dedup-ticker-cleanup).
// Verifies that packages already including Rain-X / clay bar do not re-offer
// them as paid add-ons, that the global catalog and prices are unchanged, and
// that stale "Paint Correction" ticker copy is gone. Static-analysis style
// (mirrors tests/card-on-file-hardening.test.js) — no DOM required.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const { PRICING } = require('../netlify/lib/booking-price-catalog');

const BOOKING_PAGES = [
  'index.html',
  'bergen-county-hub.html',
  'hudson-county-hub.html',
  'essex-county-hub.html',
  'passaic-county-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
  'new-jersey-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'template-city.html',
];

// Mirror of the shipped dedup predicate in renderAddons(). A guard test below
// asserts the shipped source matches this logic, so this stays in sync.
function pkgIncludesAddon(pkg) {
  const txt = [].concat(pkg.feats || [], pkg.ext || [], pkg.int || []).join(' ').toLowerCase();
  return { rainx: /rain-?x/.test(txt), claybar: /clay\s*bar/.test(txt) };
}

// 1 + 3: add-ons appear when the package does not include them.
test('Rain-X and clay bar are offered when the package does not include them', () => {
  const pkg = { feats: ['Exterior hand wash & rinse', 'Interior vacuum', 'Tire dressing'] };
  const inc = pkgIncludesAddon(pkg);
  assert.equal(inc.rainx, false);
  assert.equal(inc.claybar, false);
});

// 2: Rain-X is hidden when the selected package already includes it.
test('Rain-X is hidden when the package includes Rain-X (refresh / signature)', () => {
  assert.equal(pkgIncludesAddon({ feats: ['Rain-X glass treatment'] }).rainx, true);
  assert.equal(pkgIncludesAddon({ ext: ['Exterior glass cleaned + Rain-X treatment'] }).rainx, true);
  assert.equal(pkgIncludesAddon({ ext: ['Rain-X windshield treatment'] }).rainx, true);
});

// 4: clay bar is hidden when the selected package already includes it.
test('clay bar is hidden when the package includes clay bar', () => {
  assert.equal(pkgIncludesAddon({ feats: ['Clay bar decontamination'] }).claybar, true);
  assert.equal(pkgIncludesAddon({ ext: ['Clay bar decontamination', 'Tire dressing'] }).claybar, true);
});

// Only rainx / claybar are ever deduped — other add-ons are never hidden by this logic.
test('dedup predicate only ever targets rainx and claybar', () => {
  const inc = pkgIncludesAddon({ feats: ['Rain-X glass treatment', 'Clay bar decontamination'] });
  assert.deepEqual(Object.keys(inc).sort(), ['claybar', 'rainx']);
});

// Guard: the shipped dedup source exists in every booking page and matches the predicate.
test('all booking pages contain the add-on dedup filter', () => {
  for (const f of BOOKING_PAGES) {
    const s = read(f);
    assert.ok(
      s.includes('if(_pkgIncludesAddon[a.id]) return false;'),
      `${f} is missing the add-on dedup filter`
    );
    assert.ok(
      s.includes('rainx:/rain-?x/.test(_pkgInclTxt)'),
      `${f} is missing the Rain-X dedup predicate`
    );
    assert.ok(
      s.includes('claybar:/clay\\s*bar/.test(_pkgInclTxt)'),
      `${f} is missing the clay bar dedup predicate`
    );
  }
});

// 5: add-on catalog values are unchanged and NOT deleted from the catalog.
test('server add-on catalog is unchanged (rainx $25, claybar $45 still present)', () => {
  const carAddons = PRICING.cars.addons;
  const rainx = carAddons.find((a) => a.id === 'rainx');
  const claybar = carAddons.find((a) => a.id === 'claybar');
  assert.ok(rainx, 'rainx must remain in the catalog');
  assert.ok(claybar, 'claybar must remain in the catalog');
  assert.equal(rainx.price, 25);
  assert.equal(claybar.price, 45);
});

test('client add-on catalog still lists rainx $25 and claybar $45 (not deleted)', () => {
  const s = read('index.html');
  assert.match(s, /id:'rainx'[^}]*price:25/);
  assert.match(s, /id:'claybar'[^}]*price:45/);
});

// 6: package prices are unchanged (server catalog + client source of truth).
test('car package prices are unchanged in the server catalog', () => {
  const t = PRICING.cars.tiers;
  assert.equal(t.small.refresh, 375);
  assert.equal(t.suv2.refresh, 425);
  assert.equal(t.suv3.refresh, 475);
  assert.equal(t.truck.refresh, 465);
  assert.equal(t.small.premium, 450);
  assert.equal(t.suv2.premium, 550);
  assert.equal(t.suv3.premium, 635);
  assert.equal(t.truck.premium, 615);
});

test('car package prices are unchanged in client index.html', () => {
  const s = read('index.html');
  assert.ok(s.includes('refresh:375, premium:450'));
  assert.ok(s.includes('refresh:425, premium:550'));
  assert.ok(s.includes('refresh:475, premium:635'));
  assert.ok(s.includes('refresh:465, premium:615'));
});

// 7: historical booking display is not broken — dedup is isolated to the live
// booking pages and never touches portal/admin/tech rendering of stored add-ons.
test('dedup logic does not leak into portal/admin/tech rendering', () => {
  for (const f of ['customer.html', 'admin.html', 'admin-ops.html', 'technician.html']) {
    assert.ok(!read(f).includes('_pkgIncludesAddon'), `${f} must not contain dedup logic`);
  }
});

// 8: stale ticker copy removed; current label present.
// Package names may include "One-Step Paint Correction"; ticker demo jobs must not.
test('ticker copy no longer references stale bare "Paint Correction"', () => {
  for (const f of BOOKING_PAGES) {
    const s = read(f);
    const tickerBlock = s.match(/const\s+TICKER_JOBS\s*=\s*\[[\s\S]*?\];/)
      || s.match(/service:'[^']*Paint Correction[^']*'/g);
    if (tickerBlock && typeof tickerBlock[0] === 'string' && tickerBlock[0].startsWith('const')) {
      assert.doesNotMatch(tickerBlock[0], /Paint Correction/, `${f} ticker still has Paint Correction`);
    }
    assert.doesNotMatch(s, /service:'Paint Correction[^']*'/);
  }
});

test('ticker copy uses the current "Signature Detail" label', () => {
  const s = read('index.html');
  assert.ok(s.includes('Signature Detail · BMW X5'));
});

// 9 + 10: this hotfix does not introduce its markers into payment/admin/tech files.
test('no payment/admin/tech file contains this hotfix marker', () => {
  const guarded = [
    'netlify/functions/stripe-webhook.js',
    'netlify/functions/submit-booking.js',
    'netlify/functions/create-setup-intent.js',
    'netlify/functions/booking-card-status.js',
    'admin.html',
    'admin-ops.html',
    'technician.html',
  ];
  for (const f of guarded) {
    assert.ok(!read(f).includes('_pkgIncludesAddon'), `${f} must not be modified by this hotfix`);
  }
});
