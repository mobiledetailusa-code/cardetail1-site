'use strict';

// New-booking add-on rules for cars (assets/addon-rules.js), independent add-on
// pricing (Super Interior is a stain treatment that includes no other add-on),
// Maintenance paste wax, customer-portal guards, activation, and history.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const Rules = require('../assets/addon-rules');
const {
  PRICING,
  computeBookingServiceSubtotal,
  includedAddonIds,
} = require('../netlify/lib/booking-price-catalog');
const { applyServerTravelAndTotal } = require('../netlify/lib/travel-fee');
const CustomerCatalog = require('../netlify/lib/customer-catalog');
const { resolvePackageDetailsForCustomerView } = require('../netlify/lib/package-details-resolve');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const WAX = 'Hand-applied premium paste wax';
const BOOKING_PAGES = [
  'index.html', 'bergen-county-hub.html', 'connecticut-hub.html', 'essex-county-hub.html',
  'hudson-county-hub.html', 'new-jersey-hub.html', 'newark-mobile-detailing.html',
  'ny-metro-hub.html', 'passaic-county-hub.html', 'pennsylvania-hub.html', 'template-city.html',
  'trenton-mobile-detailing.html', 'westchester-mobile-detailing.html',
];

function car(pkgId, addonIds = [], tierKey = 'small') {
  return {
    vehicleId: `veh_${pkgId}`, cat: 'cars', category: 'cars', pkgId, packageId: pkgId,
    tierKey, tierLabel: PRICING.cars.tiers[tierKey].label, vehicleLabel: '2022 Test Vehicle',
    addons: addonIds.map((id) => ({ id })), addOnIds: [],
  };
}

function subtotal(vehicles, extra = {}) {
  const r = computeBookingServiceSubtotal({ zipCode: '07601', vehicles, ...extra });
  assert.equal(r.ok, true, r.error);
  return r;
}

const ADDON_PRICE = Object.fromEntries(PRICING.cars.addons.map((a) => [a.id, a.price]));

// What the booking page sums: package price + each selected add-on at its
// catalog price × quantity (recalcAddonTotal). Parsed from the page itself.
function pageCarAddonPrices(file) {
  const html = read(file);
  const at = html.indexOf("name:'Super Interior — Deep Cleaning Upgrade'");
  const list = html.slice(html.lastIndexOf('addons:[', at), html.indexOf('    ],', at));
  const out = {};
  for (const m of list.matchAll(/\{id:'([a-z0-9_]+)'[^}]*?price:(\d+)/g)) out[m[1]] = Number(m[2]);
  return out;
}

function clientTotal(file, pkg, lines) {
  const prices = pageCarAddonPrices(file);
  return PRICING.cars.tiers.small[pkg] + lines.reduce((s, [id, qty = 1]) => s + prices[id] * qty, 0);
}

test('base prices and the add-on prices involved are unchanged', () => {
  assert.deepEqual(
    ['wash', 'maint', 'interior', 'full', 'refresh'].map((p) => PRICING.cars.tiers.small[p]),
    [125, 160, 200, 250, 335]
  );
  const expected = { superint: 125, pethair: 95, odor: 90, sanitize: 65, floormats: 20, mold: 149, biohazard: 115, engine: 45, claybar: 45, wax1yr: 75 };
  for (const [id, price] of Object.entries(expected)) assert.equal(ADDON_PRICE[id], price, id);
});

/* ── Independent add-ons: every selected service is charged once ─────────── */

test('1. Interior Detail without Super Interior', () => {
  assert.equal(subtotal([car('interior')]).serviceSubtotal, 200);
});

test('2. Interior Detail with Super Interior', () => {
  const r = subtotal([car('interior', ['superint'])]);
  assert.equal(r.serviceSubtotal, 200 + 125);
});

test('3–6. Super Interior combined with Pet Hair, Odor and Sanitizing: each charged once', () => {
  const cases = [
    [['superint', 'pethair'], 200 + 125 + 95],
    [['superint', 'odor'], 200 + 125 + 90],
    [['superint', 'pethair', 'odor'], 200 + 125 + 95 + 90],
    [['superint', 'pethair', 'odor', 'sanitize'], 200 + 125 + 95 + 90 + 65],
  ];
  for (const [ids, total] of cases) {
    const r = subtotal([car('interior', ids)]);
    assert.equal(r.serviceSubtotal, total, ids.join('+'));
    // 10–12: nothing added, nothing removed, nothing zeroed, nothing duplicated.
    assert.deepEqual(r.vehicles[0].addons.map((a) => a.id), ids, ids.join('+'));
    assert.ok(r.vehicles[0].addons.every((a) => a.price > 0 && !a.includedWith), ids.join('+'));
    assert.equal(new Set(r.vehicles[0].addons.map((a) => a.id)).size, ids.length);
  }
});

test('Super Interior + Floor Mats: mats charged per valid unit', () => {
  const v = car('interior', ['superint']);
  v.addons.push({ id: 'floormats', qty: 4 });
  assert.equal(subtotal([v]).serviceSubtotal, 200 + 125 + 4 * 20);
});

test('7. Premium Full Detail with several add-ons; package-included clay bar and Rain-X never billed', () => {
  const v = car('full', ['superint', 'pethair', 'odor', 'sanitize', 'claybar', 'rainx']);
  v.addons.push({ id: 'floormats', qty: 2 });
  const r = subtotal([v]);
  assert.equal(r.serviceSubtotal, 250 + 125 + 95 + 90 + 65 + 40);
  assert.deepEqual(r.vehicles[0].addons.map((a) => a.id).sort(), ['floormats', 'odor', 'pethair', 'sanitize', 'superint']);
  assert.deepEqual(includedAddonIds('cars', 'full').sort(), ['claybar', 'rainx']);
});

test('8–9. booking page totals equal the server totals for the same selections', () => {
  const combos = [
    ['interior', [['superint'], ['pethair'], ['odor'], ['sanitize']]],
    ['interior', [['superint'], ['floormats', 3]]],
    ['full', [['superint'], ['pethair'], ['odor'], ['mold']]],
  ];
  for (const file of BOOKING_PAGES) {
    for (const [pkg, lines] of combos) {
      const v = car(pkg);
      v.addons = lines.map(([id, qty]) => (qty ? { id, qty } : { id }));
      assert.equal(clientTotal(file, pkg, lines), subtotal([v]).serviceSubtotal, `${file} ${pkg} ${JSON.stringify(lines)}`);
    }
  }
});

test('submit path: server total for several add-ons matches; travel fee unchanged', () => {
  const ids = ['superint', 'pethair', 'odor'];
  const booking = { zipCode: '10001', totalPrice: 200 + 125 + 95 + 90 + 35, vehicles: [car('interior', ids)] };
  const r = applyServerTravelAndTotal(booking);
  assert.equal(r.ok, true, r.error);
  assert.equal(booking.travelFeeAmount, 35);
  assert.equal(booking.totalPrice, 545);
  const stale = { zipCode: '07601', totalPrice: 200 + 125, vehicles: [car('interior', ids)] };
  assert.equal(applyServerTravelAndTotal(stale).error, 'price_mismatch', 'a total that drops add-ons is refused');
});

test('no Super Interior inclusion rules or messages remain anywhere', () => {
  for (const key of ['SUPERINT_BUNDLE', 'includedBySuperint', 'bundleActiveFor', 'includedNote']) {
    assert.equal(Rules[key], undefined, key);
  }
  const sources = ['assets/addon-rules.js', 'netlify/lib/booking-price-catalog.js', 'netlify/lib/canonical-addon-catalog.js', ...BOOKING_PAGES];
  for (const file of sources) {
    assert.doesNotMatch(read(file), /Included with Super Interior|includedWith|Covered by Super Interior|Choose Super Interior instead/i, file);
  }
});

/* ── Eligibility (unchanged decisions) ───────────────────────────────────── */

test('13. Maintenance blocks Super Interior, Biohazard, Odor, Interior Sanitizing, Mold and the wax add-on', () => {
  for (const id of ['superint', 'biohazard', 'odor', 'sanitize', 'wax1yr', 'mold']) {
    assert.equal(Rules.isOfferable('cars', 'maint', id), false, id);
    const v = Rules.validateNewBookingAddons({ vehicles: [car('maint', [id])] });
    assert.equal(v.ok, false, id);
    assert.equal(v.error, 'addon_not_available');
  }
  // Floor Mat Deep Clean stays a paid per-unit add-on on Maintenance (owner decision).
  for (const id of ['claybar', 'pethair', 'rainx', 'polymer', 'engine', 'headlight', 'floormats']) {
    assert.equal(Rules.isOfferable('cars', 'maint', id), true, id);
  }
});

test('Super Interior only on interior-capable car packages; Pet Hair, Odor, Sanitizing stay available there', () => {
  for (const pkg of ['interior', 'full', 'premium']) {
    for (const id of ['superint', 'pethair', 'odor', 'sanitize', 'floormats']) {
      assert.equal(Rules.isOfferable('cars', pkg, id), true, `${pkg} ${id}`);
    }
  }
  for (const pkg of ['maint', 'wash', 'refresh']) assert.equal(Rules.isOfferable('cars', pkg, 'superint'), false, pkg);
  assert.equal(Rules.isOfferable('rvs', 'maint', 'superint'), true);
  assert.equal(Rules.isOfferable('trucks', 'interior', 'superint'), true);
});

test('14. Engine Bay $125 and Mobile Water retired; Top Clean $45 sold where Engine Bay Light Cleaning is not included', () => {
  for (const pkg of ['wash', 'refresh', 'full', 'premium']) {
    assert.equal(Rules.isOfferable('cars', pkg, 'engine_bay'), false, pkg);
    assert.equal(Rules.isOfferable('cars', pkg, 'mobile_water'), false, pkg);
  }
  // Full, Refresh and Signature (same exterior as Refresh) include Engine Bay
  // Light Cleaning: no separate $45 line.
  for (const pkg of ['full', 'refresh', 'premium']) {
    assert.equal(Rules.isOfferable('cars', pkg, 'engine'), false, pkg);
    assert.equal(Rules.validateNewBookingAddons({ vehicles: [car(pkg, ['engine'])] }).error, 'addon_not_available', pkg);
    assert.equal(Rules.validateAddedAddons('cars', pkg, ['engine']).ok, false, pkg);
  }
  for (const pkg of ['wash', 'maint']) assert.equal(Rules.isOfferable('cars', pkg, 'engine'), true, pkg);
  for (const id of ['undercarriage', 'heavymud', 'claybar', 'rainx', 'polymer', 'headlight']) {
    assert.equal(Rules.isOfferable('cars', 'wash', id), true, id);
  }
});

test('Mobile Water Supply sent by an older page is dropped, not charged, and does not block the booking', () => {
  const b = { vehicles: [car('full', ['undercarriage', 'mobile_water'])] };
  b.vehicles[0].addOnIds = ['mobile_water'];
  Rules.stripDroppedFromNewBooking(b);
  assert.deepEqual(b.vehicles[0].addons.map((a) => a.id), ['undercarriage']);
  assert.deepEqual(b.vehicles[0].addOnIds, []);
  assert.equal(Rules.validateNewBookingAddons({ vehicles: [car('full', ['engine_bay'])] }).ok, false);
});

test('submit-booking strips and validates add-ons before pricing', () => {
  const src = read('netlify/functions/submit-booking.js');
  const strip = src.indexOf('AddonRules.stripDroppedFromNewBooking(b)');
  const check = src.indexOf('AddonRules.validateNewBookingAddons(b)');
  const price = src.indexOf('const travelApplied = applyServerTravelAndTotal(b, {');
  assert.ok(strip > 0 && check > strip && price > check);
  assert.doesNotMatch(src, /newBooking/);
});

test('Premium Full Detail and Maintenance do not sell a second wax; Refresh does not sell wax or sealant over its sealant', () => {
  assert.equal(Rules.isOfferable('cars', 'full', 'wax1yr'), false);
  assert.equal(Rules.isOfferable('cars', 'maint', 'wax1yr'), false);
  assert.equal(Rules.isOfferable('cars', 'wash', 'wax1yr'), true);
  assert.equal(Rules.isOfferable('cars', 'refresh', 'wax1yr'), false);
  assert.equal(Rules.isOfferable('cars', 'refresh', 'polymer'), false);
  assert.equal(Rules.isOfferable('cars', 'premium', 'polymer'), false);
  // Paste wax packages may still add a separate polymer sealant (different product).
  assert.equal(Rules.isOfferable('cars', 'full', 'polymer'), true);
  assert.equal(Rules.isOfferable('cars', 'maint', 'polymer'), true);
  // Carnauba on Premium (Signature) stays until the owner decides; see the audit report.
  assert.equal(Rules.isOfferable('cars', 'premium', 'wax1yr'), true);
});

/* ── 16. History ─────────────────────────────────────────────────────────── */

test('16. stored bookings reprice exactly as before, including retired add-ons', () => {
  assert.ok(subtotal([car('full', ['engine_bay'])], { createdAt: '2026-10-01T12:00:00Z' }).vehicles[0].addonTotal > 0);
  assert.equal(subtotal([car('interior', ['superint', 'pethair'])], { createdAt: '2026-10-01T12:00:00Z' }).serviceSubtotal, 420);
});

test('Maintenance and Full history: older bookings keep the composition they were sold', () => {
  const cutover = Date.parse(Rules.RULES_EFFECTIVE_AT);
  const maint = { ...car('maint'), basePrice: 160, subtotal: 160 };
  assert.ok(!resolvePackageDetailsForCustomerView(maint, { bookingCreatedAt: new Date(cutover - 60_000).toISOString() }).includedServices.includes(WAX));
  assert.ok(resolvePackageDetailsForCustomerView(maint, { bookingCreatedAt: new Date(cutover + 60_000).toISOString() }).includedServices.includes(WAX));
});

/* ── Copy ────────────────────────────────────────────────────────────────── */

test('booking pages: Super Interior stain copy, Maintenance paste wax, shared rules script', () => {
  for (const file of BOOKING_PAGES) {
    const html = read(file);
    assert.match(html, /\{id:'superint',   scope:'int', name:'Super Interior — Deep Cleaning Upgrade', desc:'Double Shampoo for Heavy Stains\.', price:125\}/, file);
    const start = html.indexOf("{id:'maint',    name:'Maintenance Detail'");
    const maint = html.slice(start, html.indexOf(']}', html.indexOf('miss:[', start)) + 2);
    assert.equal(maint.split(`'${WAX}'`).length - 1, 2, `${file} maint ext+feats`);
    const ceramicAt = html.indexOf('<script src="assets/ceramic-booking.js" defer></script>');
    const rulesAt = html.indexOf('<script src="assets/addon-rules.js" defer></script>');
    assert.ok(ceramicAt > 0 && rulesAt > ceramicAt, `${file} loads addon-rules after ceramic-booking`);
  }
});

test('18. Super Interior details: stain treatment, other treatments available separately, no guarantee', () => {
  const DESC = 'Double shampoo for heavy stains and enhanced extraction for heavily soiled interiors. Ideal for vehicles requiring extra attention, including those affected by stubborn stains, pet hair or lingering odors.';
  const d = Rules.detailsFor('cars', { id: 'superint', desc: 'Double Shampoo for Heavy Stains.' });
  assert.equal(d.description, DESC);
  assert.equal(d.note, 'Specialized Pet Hair Removal and Odor Treatment are available separately.');
  assert.match(d.items.join(' '), /second shampoo and extraction/i);
  assert.match(d.limits, /may be lightened rather than fully removed/);
  // Pet hair and odors are named as conditions, never as included services.
  assert.doesNotMatch(JSON.stringify(d), /included with super interior|covered by super interior|no additional charge|no extra charge|choose super interior|guarantee/i);
  assert.doesNotMatch(d.items.join(' '), /pet hair|odor|floor mat|sanitiz/i);
  const canonical = read('netlify/lib/canonical-addon-catalog.js');
  assert.ok(canonical.includes(`description: '${DESC}'`));
  for (const id of ['pethair', 'odor']) {
    assert.doesNotMatch(JSON.stringify(Rules.detailsFor('cars', { id, desc: 'x' })), /super interior/i, id);
  }
  const long = 'A'.repeat(200);
  assert.equal(Rules.detailsFor('cars', { id: 'floormats', desc: long }).description, long, 'full text, untruncated');
});

test('Interior and Full: approved condition note, no guarantee, nothing charged without approval', () => {
  const NOTE = 'Deep or permanent stains, embedded pet hair, and persistent odors may require additional specialized treatments. Results depend on the condition of the materials.';
  const modal = read('assets/car-pkg-detail-modal.js');
  for (const key of ['interior', 'full']) {
    const block = modal.slice(modal.indexOf(`  ${key}: {`), modal.indexOf('  },', modal.indexOf(`  ${key}: {`)));
    assert.ok(block.includes(`conditionNote: "${NOTE}`), key);
  }
  const src = read('assets/addon-rules.js');
  assert.ok(src.includes(NOTE));
  assert.match(src, /Nothing extra is added or charged without your approval/);
  assert.doesNotMatch(src, /See Super Interior/);
});

test('condition hints map each condition to its own treatment, never all to Super Interior', () => {
  const src = read('assets/addon-rules.js');
  assert.match(src, /id: 'superint', label: 'Super Interior \(heavy stains\)'/);
  assert.match(src, /id: 'pethair', label: 'Pet Hair Removal'/);
  assert.match(src, /id: 'odor', label: 'Odor Treatment'/);
  assert.match(src, /hazardous contamination need an inspection/);
});

/* ── 15. Customer portal ─────────────────────────────────────────────────── */

test('15. portal: compatible add-ons can be added separately or together; guards unchanged', () => {
  assert.equal(Rules.validateAddedAddons('cars', 'interior', ['superint']).ok, true);
  assert.equal(Rules.validateAddedAddons('cars', 'interior', ['pethair']).ok, true);
  assert.equal(Rules.validateAddedAddons('cars', 'interior', ['odor']).ok, true);
  assert.equal(Rules.validateAddedAddons('cars', 'full', ['superint', 'pethair', 'odor', 'sanitize']).ok, true);
  assert.equal(Rules.validateAddedAddons('cars', 'maint', ['superint']).error, 'addon_not_available');
  assert.equal(Rules.validateAddedAddons('cars', 'full', ['engine_bay']).error, 'addon_not_available');
  assert.equal(Rules.validatePackageChange('cars', 'maint', ['superint']).error, 'addon_incompatible_with_package');
  assert.equal(Rules.validatePackageChange('cars', 'interior', ['superint', 'pethair']).ok, true);
  assert.equal(Rules.validatePackageChange('cars', 'refresh', ['engine_bay']).ok, true);

  const src = read('netlify/functions/submit-customer-action.js');
  const addon = src.indexOf("} else if (action === 'addon_request') {");
  const addonGuard = src.indexOf('AddonRules.validateAddedAddons(', addon);
  assert.ok(addon > 0 && addonGuard > addon && addonGuard < src.indexOf('submitChangeRequestCommand({', addon));
  const pkg = src.indexOf("} else if (action === 'package_change_request') {");
  const pkgGuard = src.indexOf('AddonRules.validatePackageChange(', pkg);
  assert.ok(pkg > 0 && pkgGuard > pkg && pkgGuard < src.indexOf('submitChangeRequestCommand({', pkg));
});

/* ── 10. Activation ──────────────────────────────────────────────────────── */

test('activation: one approved instant with an explicit offset, used by the dated history rules', () => {
  const a = Rules.PACKAGE_RULES_ACTIVATION;
  assert.equal(a.timeZone, 'America/New_York');
  assert.equal(a.approved, true);
  assert.equal(a.effectiveAt, '2026-11-24T13:40:00-05:00');
  assert.equal(Rules.RULES_EFFECTIVE_AT, '2026-11-24T18:40:00.000Z');
  assert.match(a.effectiveAt, /[+-]\d{2}:\d{2}$|Z$/);
  assert.equal(CustomerCatalog.FULL_DETAIL_PASTE_WAX_EFFECTIVE_AT, Rules.RULES_EFFECTIVE_AT);
  assert.equal(CustomerCatalog.MAINTENANCE_PASTE_WAX_EFFECTIVE_AT, Rules.RULES_EFFECTIVE_AT);
  assert.equal(Rules.parseActivation('2026-12-03 06:00'), null);
  assert.equal(Rules.parseActivation('2026-12-03T06:00:00'), null);
  assert.ok(Rules.parseActivation('2026-12-03T06:00:00-05:00'));
  const ms = Date.parse(Rules.RULES_EFFECTIVE_AT);
  assert.equal(Rules.createdBeforeActivation(new Date(ms - 1).toISOString()), true);
  assert.equal(Rules.createdBeforeActivation(new Date(ms).toISOString()), false);
  assert.equal(Rules.createdBeforeActivation(''), true);
});

test('activation: env override is honored only with an explicit offset', () => {
  const run = (value) => execFileSync(process.execPath, ['-e',
    "const R=require('./assets/addon-rules');process.stdout.write(JSON.stringify([R.RULES_EFFECTIVE_AT,R.ACTIVATION_SOURCE,R.ACTIVATION_INVALID_ENV]))"],
  { cwd: ROOT, env: { ...process.env, CD1_PACKAGE_RULES_EFFECTIVE_AT: value } }).toString();
  assert.deepEqual(JSON.parse(run('2026-12-03T06:00:00-05:00')), ['2026-12-03T11:00:00.000Z', 'env', false]);
  const fallback = JSON.parse(run('2026-12-03 06:00'));
  assert.deepEqual(fallback.slice(1), ['constant', true]);
});

test('activation gate: ready at the planned publish time, refused when far from it', () => {
  const ok = execFileSync(process.execPath, ['scripts/check-package-rules-activation.mjs', '--publish-at', '2026-11-24T13:30:00-05:00'], { cwd: ROOT, stdio: 'pipe' }).toString();
  assert.match(ok, /READY/);
  let failed = false;
  try {
    execFileSync(process.execPath, ['scripts/check-package-rules-activation.mjs', '--publish-at', '2026-11-24T15:00:00-05:00'], { cwd: ROOT, stdio: 'pipe' });
  } catch (e) {
    failed = true;
    assert.match(String(e.stderr), /more than 15 min from publish/);
  }
  assert.ok(failed, 'gate must refuse a publish far from the activation time');
});

/* ── Carnauba ────────────────────────────────────────────────────────────── */

test('Carnauba Wax: no durability promise on cars; price unchanged', () => {
  for (const file of BOOKING_PAGES) {
    const html = read(file);
    const at = html.indexOf("name:'Super Interior — Deep Cleaning Upgrade'");
    const list = html.slice(at, html.indexOf('    ],', at));
    const wax = list.slice(list.indexOf("{id:'wax1yr'"), list.indexOf('}', list.indexOf("{id:'wax1yr'")) + 1);
    assert.match(wax, /name:'Carnauba Wax'/, file);
    assert.doesNotMatch(wax, /1-Year|12 months|year/i, file);
    assert.match(wax, /price:75/, file);
  }
});

/* ── 19. Featured Super Interior + "View More Interior Add-ons" ──────────── */

test('19. interior layout: Super Interior featured, independent add-ons in an expandable section', () => {
  const src = read('assets/addon-rules.js');
  assert.match(src, /'Recommended for heavily soiled interiors'/);
  assert.match(src, /'View More Interior Add-ons'/);
  assert.match(src, /setAttribute\('aria-expanded', 'false'\)/);
  assert.match(src, /setAttribute\('aria-controls', 'cd1-more-panel'\)/);
  // Cards are moved (appendChild of the existing node), never cloned or re-priced.
  assert.match(src, /cardsToMove\.forEach\(function \(c\) \{ panelEl\.appendChild\(c\); \}\)/);
  assert.doesNotMatch(src, /cloneNode/);
  // Opens itself when a moved add-on is already selected.
  assert.match(src, /Never hide a choice the customer already made/);
  // Only interior-capable car packages, and only when Super Interior is offerable there.
  assert.match(src, /if \(cat !== 'cars' \|\| !EXPECT_PACKAGES\[pkg\] \|\| !isOfferable\(cat, pkg, 'superint'\)\) return;/);
  assert.deepEqual(['interior', 'full', 'premium'].filter((p) => Rules.isOfferable('cars', p, 'superint')), ['interior', 'full', 'premium']);
});

test('notes hints: whole-word pet terms; each condition suggests its own treatment', () => {
  const src = read('assets/addon-rules.js');
  const petRe = eval(src.match(/re: (\/[^\n]*\/i), id: 'pethair'/)[1]); // eslint-disable-line no-eval
  assert.equal(petRe.test('dog hair on the back seat'), true);
  assert.equal(petRe.test('my office chair'), false);
  assert.equal(petRe.test('carpet stain'), false);
  assert.doesNotMatch(src, /[\x00-\x08]/, 'no control characters in the module');
});
