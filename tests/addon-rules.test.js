'use strict';

// New-booking add-on rules for cars (assets/addon-rules.js), the Super Interior
// bundle in server pricing, Maintenance paste wax, and history preservation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

function subtotal(vehicles, extra = {}, opts) {
  const r = computeBookingServiceSubtotal({ zipCode: '07601', vehicles, ...extra }, opts);
  assert.equal(r.ok, true, r.error);
  return r;
}

const ADDON_PRICE = Object.fromEntries(PRICING.cars.addons.map((a) => [a.id, a.price]));

test('base prices and the add-on prices involved are unchanged', () => {
  assert.deepEqual(
    ['wash', 'maint', 'interior', 'full', 'refresh'].map((p) => PRICING.cars.tiers.small[p]),
    [125, 160, 200, 250, 335]
  );
  assert.equal(ADDON_PRICE.superint, 125);
  assert.equal(ADDON_PRICE.pethair, 95);
  assert.equal(ADDON_PRICE.odor, 90);
  assert.equal(ADDON_PRICE.floormats, 20);
  assert.equal(ADDON_PRICE.engine, 45);
  assert.equal(ADDON_PRICE.claybar, 45);
  assert.equal(ADDON_PRICE.wax1yr, 75);
});

test('Maintenance blocks Super Interior, Biohazard, Odor, Interior Sanitizing and the wax add-on', () => {
  for (const id of ['superint', 'biohazard', 'odor', 'sanitize', 'wax1yr']) {
    assert.equal(Rules.isOfferable('cars', 'maint', id), false, id);
    const v = Rules.validateNewBookingAddons({ vehicles: [car('maint', [id])] });
    assert.equal(v.ok, false, id);
    assert.equal(v.error, 'addon_not_available');
  }
  // Audited, not changed: still offered on Maintenance.
  for (const id of ['claybar', 'pethair', 'floormats', 'mold', 'rainx', 'polymer', 'engine']) {
    assert.equal(Rules.isOfferable('cars', 'maint', id), true, id);
  }
});

test('Super Interior only on interior-capable car packages', () => {
  for (const pkg of ['interior', 'full', 'premium']) assert.equal(Rules.isOfferable('cars', pkg, 'superint'), true, pkg);
  for (const pkg of ['maint', 'wash', 'refresh']) assert.equal(Rules.isOfferable('cars', pkg, 'superint'), false, pkg);
  // Other categories keep their own rules.
  assert.equal(Rules.isOfferable('rvs', 'maint', 'superint'), true);
  assert.equal(Rules.isOfferable('trucks', 'interior', 'superint'), true);
});

test('Engine Bay Detail $125 and Mobile Water Supply are retired for new bookings; Top Clean $45 is not', () => {
  for (const pkg of ['wash', 'refresh', 'full', 'premium']) {
    assert.equal(Rules.isOfferable('cars', pkg, 'engine_bay'), false, pkg);
    assert.equal(Rules.isOfferable('cars', pkg, 'mobile_water'), false, pkg);
    assert.equal(Rules.isOfferable('cars', pkg, 'engine'), true, pkg);
    assert.equal(Rules.validateNewBookingAddons({ vehicles: [car(pkg, ['engine'])] }).ok, true, pkg);
  }
  assert.equal(Rules.validateNewBookingAddons({ vehicles: [car('full', ['engine_bay'])] }).error, 'addon_not_available');
  // Exterior matrix untouched: undercarriage, heavy mud, clay, Rain-X still offered where they were.
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
  assert.equal(Rules.validateNewBookingAddons({ vehicles: [car('full', ['mobile_water'])] }).ok, true);
  assert.equal(Rules.validateNewBookingAddons({ vehicles: [car('full', ['engine_bay'])] }).ok, false);
  const src = read('netlify/functions/submit-booking.js');
  assert.ok(src.indexOf('AddonRules.stripDroppedFromNewBooking(b)') < src.indexOf('AddonRules.validateNewBookingAddons(b)'));
});

test('stored bookings with retired add-ons still price as before', () => {
  const r = subtotal([car('full', ['engine_bay'], 'small')], { createdAt: '2026-10-01T12:00:00Z' });
  assert.equal(r.vehicles[0].addonTotal > 0, true, 'engine_bay keeps its stored price');
});

test('Premium Full Detail and Maintenance do not sell a second wax', () => {
  assert.equal(Rules.isOfferable('cars', 'full', 'wax1yr'), false);
  assert.equal(Rules.isOfferable('cars', 'maint', 'wax1yr'), false);
  assert.equal(Rules.isOfferable('cars', 'wash', 'wax1yr'), true);
  assert.equal(Rules.isOfferable('cars', 'refresh', 'wax1yr'), true);
  assert.deepEqual(includedAddonIds('cars', 'full').sort(), ['claybar', 'rainx']);
});

test('Super Interior bundle: no double charge on a new booking', () => {
  const opts = { newBooking: true };
  const bundled = subtotal([car('full', ['superint', 'pethair', 'odor', 'floormats'])], {}, opts);
  assert.equal(bundled.serviceSubtotal, 250 + 125);
  assert.deepEqual(bundled.vehicles[0].addons.map((a) => a.id), ['superint']);

  const alone = subtotal([car('interior', ['pethair', 'odor'])], {}, opts);
  assert.equal(alone.serviceSubtotal, 200 + 95 + 90, 'individual add-ons still sell without Super Interior');

  const other = subtotal([car('interior', ['superint', 'sanitize'])], {}, opts);
  assert.equal(other.serviceSubtotal, 200 + 125 + 65, 'unrelated add-ons stay billable');
});

test('Super Interior bundle never reprices stored bookings', () => {
  const vehicles = [car('full', ['superint', 'pethair', 'odor'])];
  assert.equal(subtotal(vehicles).serviceSubtotal, 250 + 125 + 95 + 90, 'no creation time = history');
  assert.equal(subtotal(vehicles, { createdAt: '2026-11-01T00:00:00Z' }).serviceSubtotal, 560);
  const after = new Date(Date.parse(Rules.RULES_EFFECTIVE_AT) + 60_000).toISOString();
  assert.equal(subtotal(vehicles, { createdAt: after }).serviceSubtotal, 375);
});

test('submit path: server total matches the bundled client total; travel fee unchanged', () => {
  const booking = { zipCode: '10001', totalPrice: 250 + 125 + 35, vehicles: [car('full', ['superint', 'pethair'])] };
  const r = applyServerTravelAndTotal(booking, { newBooking: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(booking.travelFeeAmount, 35);
  assert.equal(booking.totalPrice, 410);
  const stale = { zipCode: '07601', totalPrice: 250 + 125 + 95, vehicles: [car('full', ['superint', 'pethair'])] };
  assert.equal(applyServerTravelAndTotal(stale, { newBooking: true }).error, 'price_mismatch');
});

test('submit-booking validates add-ons before pricing and marks the submission as new', () => {
  const src = read('netlify/functions/submit-booking.js');
  const check = src.indexOf('AddonRules.validateNewBookingAddons(b)');
  const price = src.indexOf('const travelApplied = applyServerTravelAndTotal(b, {');
  assert.ok(check > 0 && price > check);
  assert.match(src.slice(price, price + 300), /newBooking: true/);
});

test('booking pages: Maintenance paste wax, Super Interior copy, shared rules script', () => {
  for (const file of BOOKING_PAGES) {
    const html = read(file);
    const start = html.indexOf("{id:'maint',    name:'Maintenance Detail'");
    const maint = html.slice(start, html.indexOf(']}', html.indexOf('miss:[', start)) + 2);
    assert.equal(maint.split(`'${WAX}'`).length - 1, 2, `${file} maint ext+feats`);
    assert.doesNotMatch(maint.slice(0, maint.indexOf('miss:[')), /clay bar|shampoo/i, `${file} maint stays basic`);
    assert.match(html, /name:'Super Interior — Deep Cleaning Upgrade', desc:'Double Shampoo for Heavy Stains, Pet Hair Removal, Odor Treatment & Extra Floor Mats Cleaning\.', price:125/, file);
    const ceramicAt = html.indexOf('<script src="assets/ceramic-booking.js" defer></script>');
    const rulesAt = html.indexOf('<script src="assets/addon-rules.js" defer></script>');
    assert.ok(ceramicAt > 0 && rulesAt > ceramicAt, `${file} loads addon-rules after ceramic-booking`);
  }
});

test('Super Interior details state scope and limits without guarantees', () => {
  const d = Rules.detailsFor('cars', { id: 'superint', desc: 'x' });
  assert.equal(d.items.length, 5);
  assert.match(d.items.join(' '), /Double shampoo/i);
  assert.match(d.items.join(' '), /Moderate pet hair/i);
  assert.match(d.items.join(' '), /odor/i);
  assert.match(d.items.join(' '), /floor mats/i);
  assert.match(d.limits, /not guaranteed/i);
  assert.doesNotMatch(JSON.stringify(d), /guaranteed removal|permanent/i);
  // Other add-ons fall back to their full catalog description, untruncated.
  const long = 'A'.repeat(200);
  assert.equal(Rules.detailsFor('cars', { id: 'pethair', desc: long }).description, long);
});

test('Maintenance history: older bookings keep the composition they were sold', () => {
  const cutover = Date.parse(CustomerCatalog.MAINTENANCE_PASTE_WAX_EFFECTIVE_AT);
  const v = { ...car('maint'), basePrice: 160, subtotal: 160 };
  const old = resolvePackageDetailsForCustomerView(v, { bookingCreatedAt: new Date(cutover - 60_000).toISOString() });
  assert.ok(!old.includedServices.includes(WAX));
  const fresh = resolvePackageDetailsForCustomerView(v, { bookingCreatedAt: new Date(cutover + 60_000).toISOString() });
  assert.ok(fresh.includedServices.includes(WAX));
});

/* ── Follow-up review: limits, portal guards, activation, Carnauba ───────── */

const { execFileSync } = require('node:child_process');

test('included Super Interior lines are dropped, never stored with a quantity', () => {
  const v = car('full', ['superint']);
  v.addons.push({ id: 'floormats', qty: 40 }, { id: 'pethair', qty: 5 }, { id: 'odor' });
  const r = subtotal([v], {}, { newBooking: true });
  assert.equal(r.serviceSubtotal, 250 + 125);
  assert.deepEqual(r.vehicles[0].addons.map((a) => [a.id, a.qty]), [['superint', 1]]);
});

test('the card note states the standard level for each included service', () => {
  assert.match(Rules.includedNote('cars', 'pethair'), /moderate pet hair/);
  assert.match(Rules.includedNote('cars', 'odor'), /common odors/);
  assert.match(Rules.includedNote('cars', 'floormats'), /own mats/);
  for (const id of Rules.bundledIds('cars')) assert.match(Rules.includedNote('cars', id), /^Included with Super Interior/);
});

test('portal: newly added add-ons follow current rules; existing lines are not re-checked', () => {
  assert.equal(Rules.validateAddedAddons('cars', 'maint', ['superint']).error, 'addon_not_available');
  assert.equal(Rules.validateAddedAddons('cars', 'full', ['engine_bay']).error, 'addon_not_available');
  assert.equal(Rules.validateAddedAddons('cars', 'full', ['mobile_water']).error, 'addon_not_available');
  assert.equal(Rules.validateAddedAddons('cars', 'full', ['engine', 'pethair']).ok, true);
  assert.equal(Rules.validateAddedAddons('rvs', 'maint', ['superint']).ok, true, 'other categories keep their rules');
  // Package change: blocked when the vehicle carries an add-on the new package blocks.
  assert.equal(Rules.validatePackageChange('cars', 'maint', ['superint']).error, 'addon_incompatible_with_package');
  assert.equal(Rules.validatePackageChange('cars', 'interior', ['superint', 'pethair']).ok, true);
  // A retired add-on already contracted does not block a package change.
  assert.equal(Rules.validatePackageChange('cars', 'refresh', ['engine_bay']).ok, true);

  const src = read('netlify/functions/submit-customer-action.js');
  const addon = src.indexOf("} else if (action === 'addon_request') {");
  const addonGuard = src.indexOf('AddonRules.validateAddedAddons(', addon);
  const addonCmd = src.indexOf('submitChangeRequestCommand({', addon);
  assert.ok(addon > 0 && addonGuard > addon && addonGuard < addonCmd, 'add-on guard runs before the change command');
  const pkg = src.indexOf("} else if (action === 'package_change_request') {");
  const pkgGuard = src.indexOf('AddonRules.validatePackageChange(', pkg);
  const pkgCmd = src.indexOf('submitChangeRequestCommand({', pkg);
  assert.ok(pkg > 0 && pkgGuard > pkg && pkgGuard < pkgCmd, 'package guard runs before the change command');
});

test('activation: one instant, explicit offset, not approved, used by every dated rule', () => {
  const a = Rules.PACKAGE_RULES_ACTIVATION;
  assert.equal(a.timeZone, 'America/New_York');
  assert.equal(a.approved, false);
  assert.match(a.effectiveAt, /[+-]\d{2}:\d{2}$|Z$/);
  assert.equal(Rules.RULES_EFFECTIVE_AT, '2026-12-01T05:00:00.000Z', 'unchanged until the owner approves a date');
  assert.equal(CustomerCatalog.FULL_DETAIL_PASTE_WAX_EFFECTIVE_AT, Rules.RULES_EFFECTIVE_AT);
  assert.equal(CustomerCatalog.MAINTENANCE_PASTE_WAX_EFFECTIVE_AT, Rules.RULES_EFFECTIVE_AT);
  assert.equal(Rules.parseActivation('2026-12-03 06:00'), null, 'no offset is rejected');
  assert.equal(Rules.parseActivation('2026-12-03T06:00:00'), null, 'no offset is rejected');
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
  assert.deepEqual(JSON.parse(run('2026-12-03 06:00')), ['2026-12-01T05:00:00.000Z', 'constant', true]);
});

test('Carnauba Wax: no durability promise on cars; not sold where paste wax is included', () => {
  for (const file of BOOKING_PAGES) {
    const html = read(file);
    const at = html.indexOf("name:'Super Interior — Deep Cleaning Upgrade'");
    const list = html.slice(at, html.indexOf('    ],', at));
    const wax = list.slice(list.indexOf("{id:'wax1yr'"), list.indexOf('}', list.indexOf("{id:'wax1yr'")) + 1);
    assert.match(wax, /name:'Carnauba Wax'/, file);
    assert.doesNotMatch(wax, /1-Year|12 months|year/i, file);
    assert.match(wax, /price:75/, file);
  }
  assert.equal(Rules.isOfferable('cars', 'maint', 'wax1yr'), false);
  assert.equal(Rules.isOfferable('cars', 'full', 'wax1yr'), false);
  assert.equal(ADDON_PRICE.wax1yr, 75);
});
