'use strict';

// Driveway & Entry Cleanup is retired from new bookings. The booking pages must
// stop offering it, while existing and historical bookings that carry it keep
// pricing, repricing and displaying exactly as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Seasonal = require('../assets/seasonal-driveway-addon');
const { computeBookingServiceSubtotal, PRICING } = require('../netlify/lib/booking-price-catalog');

const ROOT = path.join(__dirname, '..');
const BOOKING_PAGES = [
  'index.html', 'bergen-county-hub.html', 'connecticut-hub.html', 'essex-county-hub.html',
  'hudson-county-hub.html', 'new-jersey-hub.html', 'newark-mobile-detailing.html',
  'ny-metro-hub.html', 'passaic-county-hub.html', 'pennsylvania-hub.html', 'template-city.html',
  'trenton-mobile-detailing.html', 'westchester-mobile-detailing.html',
];

test('the whole Driveway family is hidden from new bookings', () => {
  assert.equal(Seasonal.NEW_BOOKINGS_ENABLED, false);
  for (const id of Seasonal.FAMILY_IDS) {
    assert.equal(Seasonal.hiddenFromNewBookings(id), true, id);
  }
  for (const id of ['rainx', 'polymer', 'engine', 'claybar', 'undercarriage']) {
    assert.equal(Seasonal.hiddenFromNewBookings(id), false, id);
  }
});

test('booking pages filter add-ons through the retirement switch, with a cached-module fallback', () => {
  for (const page of BOOKING_PAGES) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    assert.match(
      html,
      /CD1SeasonalDriveway\.hiddenFromNewBookings \? CD1SeasonalDriveway\.hiddenFromNewBookings\(a\.id\) : CD1SeasonalDriveway\.isChildId\(a\.id\)/,
      page
    );
  }
});

test('the catalog still prices the family, so existing bookings reprice unchanged', () => {
  for (const cat of ['cars', 'rvs', 'powersports']) {
    const row = PRICING[cat].addons.find((a) => a.id === Seasonal.PARENT_ID);
    assert.equal(row && row.price, 95, cat);
  }
  const existing = computeBookingServiceSubtotal({
    zipCode: '07601',
    vehicles: [{
      vehicleId: 'veh_a', cat: 'cars', category: 'cars', pkgId: 'full', packageId: 'full',
      pkgName: 'Premium Detail', tierKey: 'small', tierLabel: 'Small Car', vehicleLabel: '2022 Honda Civic',
      addons: [{ id: Seasonal.PARENT_ID }], addOnIds: [],
    }],
  });
  assert.equal(existing.ok, true, existing.error);
  assert.equal(existing.serviceSubtotal, 250 + 95);
  assert.equal(existing.vehicles[0].addonTotal, 95);
});
