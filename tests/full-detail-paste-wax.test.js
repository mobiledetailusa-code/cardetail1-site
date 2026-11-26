'use strict';

// Premium Full Detail finish: spray sealant -> hand-applied premium paste wax.
// Copy and display catalogs change; prices, billed add-ons and other packages
// do not; bookings sold before the change keep showing what they were sold.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  PRICING,
  includedAddonIds,
  computeBookingServiceSubtotal,
} = require('../netlify/lib/booking-price-catalog');
const { PACKAGE_DESCRIPTIONS } = (() => {
  const mod = require('../netlify/lib/canonical-package-catalog');
  return { PACKAGE_DESCRIPTIONS: mod.PACKAGE_DESCRIPTIONS || null };
})();
const CustomerCatalog = require('../netlify/lib/customer-catalog');
const { resolvePackageDetailsForCustomerView } = require('../netlify/lib/package-details-resolve');
const { projectVehicleForCustomer } = require('../netlify/lib/ops-schema');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const D = 'Complete interior and exterior detailing with Clay Bar Paint Decontamination and Hand-Applied Premium Paste Wax for a deep, rich gloss, a smooth finish, and added paint protection.';
const WAX = 'Hand-applied premium paste wax';

const BOOKING_PAGES = [
  'index.html', 'bergen-county-hub.html', 'connecticut-hub.html', 'essex-county-hub.html',
  'hudson-county-hub.html', 'new-jersey-hub.html', 'newark-mobile-detailing.html',
  'ny-metro-hub.html', 'passaic-county-hub.html', 'pennsylvania-hub.html', 'template-city.html',
  'trenton-mobile-detailing.html', 'westchester-mobile-detailing.html',
];
const CARD_PAGES = [
  'index.html', 'connecticut-hub.html', 'new-jersey-hub.html', 'ny-metro-hub.html', 'pennsylvania-hub.html',
  'fairfield-county-hub.html', 'morris-county-hub.html', 'rockland-county-hub.html', 'union-county-hub.html',
  'edgewater-mobile-detailing.html', 'englewood-mobile-detailing.html', 'fort-lee-mobile-detailing.html',
  'franklin-lakes-mobile-detailing.html', 'mahwah-mobile-detailing.html', 'tenafly-mobile-detailing.html',
  'hackensack-mobile-detailing.html', 'palisades-park-mobile-detailing.html', 'paramus-mobile-detailing.html',
  'ridgewood-mobile-detailing.html', 'teaneck-mobile-detailing.html',
];

function packageBlock(html, tagMarker) {
  const at = html.indexOf(tagMarker);
  assert.ok(at >= 0, `missing ${tagMarker}`);
  const start = html.lastIndexOf('{id:', at);
  const end = html.indexOf(']}', html.indexOf('miss:[', at)) + 2;
  return html.slice(start, end);
}

function fullCar(extra = {}) {
  return {
    vehicleId: 'veh_full', cat: 'cars', category: 'cars', pkgId: 'full', packageId: 'full',
    pkgName: 'Premium Full Detail', tierKey: 'small', tierLabel: 'Small Car', vehicleLabel: '2022 Test',
    addons: [], addOnIds: [], basePrice: 250, subtotal: 250, ...extra,
  };
}

test('booking pages list paste wax, not spray sealant, for Premium Full Detail only', () => {
  for (const file of BOOKING_PAGES) {
    const html = read(file);
    const full = packageBlock(html, 'clay bar, paste wax & Rain-X included');
    assert.equal(full.split(`'${WAX}'`).length - 1, 2, `${file} ext + feats`);
    assert.doesNotMatch(full, /spray sealant/i, file);
    assert.doesNotMatch(full, /carnauba/i, file);
    assert.match(full, /'Clay bar decontamination'/, file);
    assert.match(full, /Rain-X/, file);
    // Exterior Refresh & Protect keeps its polish + sealant procedure.
    const refresh = packageBlock(html, 'Complete exterior treatment — clay bar, single-pass correction, sealant');
    assert.match(refresh, /Long-lasting sealant application/, `${file} refresh`);
    assert.doesNotMatch(refresh, /paste wax/i, `${file} refresh`);
  }
});

test('Premium Full Detail cards use the approved description and no stale wording remains', () => {
  for (const file of CARD_PAGES) {
    const html = read(file);
    assert.ok(html.includes(D) || html.includes(D.charAt(0).toLowerCase() + D.slice(1)), `${file} approved description`);
    assert.doesNotMatch(html, /light paint cleaning/i, file);
  }
  const generator = read('scripts/generate-bergen-city-pages.mjs');
  assert.doesNotMatch(generator, /light paint cleaning|spray sealant/i);
  assert.match(generator, /hand-applied premium paste wax/);
});

test('details modal lists paste wax for Premium Full Detail', () => {
  const modal = read('assets/car-pkg-detail-modal.js');
  const full = modal.slice(modal.indexOf('  full: {'), modal.indexOf('  ceramic_1yr: {'));
  assert.match(full, new RegExp(`"${WAX}"`));
  assert.doesNotMatch(full, /Exterior protection|sealant|carnauba/i);
});

test('server display catalogs describe the new Full Detail; Refresh keeps sealant', () => {
  const canonical = require('../netlify/lib/canonical-package-catalog');
  const src = read('netlify/lib/canonical-package-catalog.js');
  assert.ok(src.includes(`full: '${D}'`));
  assert.match(src, /refresh: 'Clay bar, chemical decontamination, single-pass paint correction, sealant/);
  assert.ok(canonical);
  const full = CustomerCatalog.CAR_PACKAGES.find((p) => p.id === 'full');
  assert.equal(full.description, D);
  assert.ok(full.feats.includes(WAX));
  assert.ok(!full.feats.some((f) => /sealant|carnauba/i.test(f)));
  if (PACKAGE_DESCRIPTIONS) assert.equal(PACKAGE_DESCRIPTIONS.cars.full, D);
});

test('prices and billed add-ons are unchanged; paste wax is not a billed line', () => {
  assert.deepEqual(
    ['wash', 'maint', 'interior', 'full', 'refresh'].map((p) => PRICING.cars.tiers.small[p]),
    [125, 160, 200, 250, 335]
  );
  assert.deepEqual(includedAddonIds('cars', 'full').sort(), ['claybar', 'rainx']);
  const r = computeBookingServiceSubtotal({ zipCode: '07601', vehicles: [fullCar({ addons: [{ id: 'claybar' }, { id: 'rainx' }] })] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.serviceSubtotal, 250);
  assert.equal(r.vehicles[0].addonTotal, 0);
});

test('bookings sold before the change keep the spray-sealant composition', () => {
  const cutover = Date.parse(CustomerCatalog.FULL_DETAIL_PASTE_WAX_EFFECTIVE_AT);
  assert.ok(Number.isFinite(cutover), 'cutover must be a valid ISO timestamp');
  const before = new Date(cutover - 60_000).toISOString();
  const after = new Date(cutover + 60_000).toISOString();

  const old = resolvePackageDetailsForCustomerView(fullCar(), { bookingCreatedAt: before });
  assert.equal(old.source, 'catalog');
  assert.ok(old.includedServices.includes('Spray sealant'));
  assert.ok(!old.includedServices.includes(WAX));

  const undated = resolvePackageDetailsForCustomerView(fullCar(), { bookingCreatedAt: '' });
  assert.ok(undated.includedServices.includes('Spray sealant'), 'no creation time = older booking');

  const fresh = resolvePackageDetailsForCustomerView(fullCar(), { bookingCreatedAt: after });
  assert.ok(fresh.includedServices.includes(WAX));
  assert.ok(!fresh.includedServices.includes('Spray sealant'));

  const noContext = resolvePackageDetailsForCustomerView(fullCar());
  assert.ok(noContext.includedServices.includes(WAX), 'non-booking views show the current package');

  const snap = resolvePackageDetailsForCustomerView(
    fullCar({ packageSnapshot: { includedServices: ['Snapshot item'] } }),
    { bookingCreatedAt: after }
  );
  assert.deepEqual(snap.includedServices, ['Snapshot item'], 'a stored snapshot still wins');
});

test('the customer projection passes the booking creation time; other packages are untouched', () => {
  const cutover = Date.parse(CustomerCatalog.FULL_DETAIL_PASTE_WAX_EFFECTIVE_AT);
  const before = new Date(cutover - 86_400_000).toISOString();
  const projectedOld = projectVehicleForCustomer(fullCar(), { bookingCreatedAt: before });
  assert.ok(projectedOld.packageDetails.includedServices.includes('Spray sealant'));
  // Array.map passes an index as the second argument; it must not be read as context.
  const projectedIndex = projectVehicleForCustomer(fullCar(), 0);
  assert.ok(projectedIndex.packageDetails.includedServices.includes(WAX));
  const refresh = projectVehicleForCustomer(fullCar({ pkgId: 'refresh', packageId: 'refresh', pkgName: 'Exterior Refresh & Protect' }), { bookingCreatedAt: before });
  const refreshCatalog = CustomerCatalog.CAR_PACKAGES.find((p) => p.id === 'refresh');
  assert.deepEqual(refresh.packageDetails.includedServices, refreshCatalog.feats);
});
