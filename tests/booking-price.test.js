const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeVehicleSubtotal,
  computeBookingServiceSubtotal,
  applyRichPrice,
  getRichMultiplier,
} = require('../netlify/lib/booking-price-catalog');
const { applyServerTravelAndTotal } = require('../netlify/lib/travel-fee');

test('car tier maintenance detail at standard zip', () => {
  const vehicle = {
    cat: 'cars',
    pkgId: 'maint',
    tierKey: 'small',
    tierLabel: 'Small Car',
    vehicleLabel: '2022 Honda Civic',
    addons: [],
  };
  const r = computeVehicleSubtotal(vehicle, '07601');
  assert.equal(r.ok, true);
  assert.equal(r.basePrice, 175);
  assert.equal(r.subtotal, 175);
});

test('rich zip applies 5% premium to car base price', () => {
  const vehicle = {
    cat: 'cars',
    pkgId: 'maint',
    tierKey: 'small',
    addons: [],
  };
  assert.equal(getRichMultiplier('07620'), 1.05);
  assert.equal(applyRichPrice(175, '07620'), 184);
  const r = computeVehicleSubtotal(vehicle, '07620');
  assert.equal(r.basePrice, 184);
});

test('addon quantity uses catalog price', () => {
  const vehicle = {
    cat: 'cars',
    pkgId: 'maint',
    tierKey: 'small',
    addons: [{ id: 'floormats', qty: 3 }],
  };
  const r = computeVehicleSubtotal(vehicle, '07601');
  assert.equal(r.addonTotal, 60);
  assert.equal(r.subtotal, 235);
});

test('booking service subtotal sums multiple vehicles', () => {
  const booking = {
    zipCode: '07601',
    vehicles: [
      { cat: 'cars', pkgId: 'maint', tierKey: 'small', addons: [] },
      { cat: 'powersports', pkgId: 'wash', tierKey: 'motorcycle', addons: [] },
    ],
  };
  const r = computeBookingServiceSubtotal(booking);
  assert.equal(r.ok, true);
  assert.equal(r.serviceSubtotal, 175 + 119);
});

test('applyServerTravelAndTotal recalculates total with travel fee', () => {
  const booking = {
    zipCode: '07601',
    totalPrice: 175,
    vehicles: [{
      cat: 'cars',
      pkgId: 'maint',
      tierKey: 'small',
      tierLabel: 'Small Car',
      vehicleLabel: '2022 Honda Civic',
      subtotal: 999,
      addons: [],
    }],
  };
  const r = applyServerTravelAndTotal(booking);
  assert.equal(r.ok, true);
  assert.equal(booking.travelFeeAmount, 0);
  assert.equal(booking.vehicles[0].subtotal, 175);
  assert.equal(booking.totalPrice, 175);
});

test('applyServerTravelAndTotal rejects tampered client total', () => {
  const booking = {
    zipCode: '07601',
    totalPrice: 50,
    vehicles: [{
      cat: 'cars',
      pkgId: 'maint',
      tierKey: 'small',
      addons: [],
    }],
  };
  const r = applyServerTravelAndTotal(booking);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'price_mismatch');
});
