'use strict';

// ZIP pricing audit (2026-11-23). Every number below comes from the real
// implementation: package prices from PRICING, travel from travel-fee.js.
// Package and add-on prices do not vary by ZIP; the only geographic charge is
// the per-appointment travel fee (distance beyond the free radius + the NYC
// cross-Hudson surcharge). The Google Ads "starting at" prices are the small-car
// package prices, which must hold with no travel fee in every targeted county.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PRICING,
  getRichMultiplier,
  computeBookingServiceSubtotal,
} = require('../netlify/lib/booking-price-catalog');
const {
  resolveTravelForZip,
  applyServerTravelAndTotal,
  FREE_RADIUS_MI,
  CROSS_HUDSON_SURCHARGE,
} = require('../netlify/lib/travel-fee');

const ADVERTISED_FROM = { wash: 125, maint: 160, interior: 200, full: 250, refresh: 335 };

// Google Ads location targets: Bergen, Hudson, Passaic (NJ) and Rockland (NY).
const ADS_TARGET_ZIPS = [
  '07601', '07650', '07430', '07450', '07666', '07024', '07020', // Bergen
  '07030', '07002', '07306', '07087', '07093', '07047', // Hudson
  '07501', '07421', '07470', '07011', '07055', '07424', // Passaic
  '10901', '10956', '10960', '10977', '10994', '10989', // Rockland
];

function car(pkgId, tierKey = 'small', addonIds = []) {
  return {
    vehicleId: `veh_${pkgId}_${tierKey}`,
    cat: 'cars',
    category: 'cars',
    pkgId,
    packageId: pkgId,
    tierKey,
    tierLabel: PRICING.cars.tiers[tierKey].label,
    vehicleLabel: '2022 Test Vehicle',
    addons: addonIds.map((id) => ({ id })),
    addOnIds: [],
  };
}

function serviceSubtotal(zipCode, vehicles) {
  const r = computeBookingServiceSubtotal({ zipCode, vehicles });
  assert.equal(r.ok, true, r.error);
  return r;
}

test('advertised "starting at" prices are the small-car catalog prices', () => {
  for (const [pkg, price] of Object.entries(ADVERTISED_FROM)) {
    assert.equal(PRICING.cars.tiers.small[pkg], price, pkg);
    const lowest = Math.min(...Object.values(PRICING.cars.tiers).map((t) => t[pkg]).filter(Number.isFinite));
    assert.equal(lowest, price, `${pkg} small car is the lowest tier`);
  }
});

test('package and add-on prices carry no ZIP multiplier', () => {
  for (const zip of ['07601', '10001', '06901', '08608', '10956']) {
    assert.equal(getRichMultiplier(zip), 1);
    for (const [pkg, price] of Object.entries(ADVERTISED_FROM)) {
      const r = serviceSubtotal(zip, [car(pkg, 'small', pkg === 'wash' ? ['claybar'] : [])]);
      assert.equal(r.vehicles[0].basePrice, price, `${pkg} @ ${zip}`);
      if (pkg === 'wash') assert.equal(r.vehicles[0].addonTotal, 45, `claybar @ ${zip}`);
    }
  }
});

test('every Ads-targeted county ZIP is served with no travel fee', () => {
  for (const zip of ADS_TARGET_ZIPS) {
    const t = resolveTravelForZip(zip);
    assert.ok(t, `${zip} must be in the service area`);
    assert.ok(t.miles <= FREE_RADIUS_MI, `${zip} is ${t.miles} road miles`);
    assert.equal(t.fee, 0, `${zip} travel fee`);
  }
});

test('the advertised price is the final server total in Ads-targeted ZIPs (no coupon)', () => {
  for (const zip of ['07601', '07030', '07501', '10956']) {
    for (const [pkg, price] of Object.entries(ADVERTISED_FROM)) {
      const booking = { zipCode: zip, totalPrice: price, vehicles: [car(pkg)] };
      const r = applyServerTravelAndTotal(booking);
      assert.equal(r.ok, true, `${pkg} @ ${zip}: ${r.error}`);
      assert.equal(booking.travelFeeAmount, 0);
      assert.equal(booking.totalPrice, price, `${pkg} @ ${zip}`);
    }
  }
});

test('changing the ZIP recomputes travel from scratch and keeps no previous fee', () => {
  const booking = { zipCode: '10001', totalPrice: 250 + CROSS_HUDSON_SURCHARGE, vehicles: [car('full')] };
  assert.equal(applyServerTravelAndTotal(booking).ok, true);
  assert.equal(booking.totalPrice, 285);
  booking.zipCode = '07601';
  booking.totalPrice = 250;
  assert.equal(applyServerTravelAndTotal(booking).ok, true);
  assert.equal(booking.travelFeeAmount, 0);
  assert.equal(booking.totalPrice, 250);
  booking.zipCode = '08608';
  booking.totalPrice = 250; // stale client total from the previous ZIP
  const stale = applyServerTravelAndTotal(booking);
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'price_mismatch');
  assert.equal(stale.serverTotal, 250 + resolveTravelForZip('08608').fee);
});

test('travel fee is charged once per appointment, not per vehicle or add-on', () => {
  const zip = '08608';
  const fee = resolveTravelForZip(zip).fee;
  assert.ok(fee > 0);
  const vehicles = [car('full'), car('interior', 'suv2', ['pethair'])];
  const sub = serviceSubtotal(zip, vehicles).serviceSubtotal;
  assert.equal(sub, 250 + 225 + 95);
  const booking = { zipCode: zip, totalPrice: sub + fee, vehicles };
  assert.equal(applyServerTravelAndTotal(booking).ok, true);
  assert.equal(booking.totalPrice, sub + fee);
});

test('unknown and out-of-range ZIPs are refused, never priced with a guess', () => {
  for (const zip of ['99999', '12210', '90210', 'abc']) {
    assert.equal(resolveTravelForZip(zip), null, zip);
    const r = applyServerTravelAndTotal({ zipCode: zip, totalPrice: 250, vehicles: [car('full')] });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'out_of_service_area');
  }
});
