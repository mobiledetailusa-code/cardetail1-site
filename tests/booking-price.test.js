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
  assert.equal(r.basePrice, 150);
  assert.equal(r.subtotal, 150);
});

// ── Exterior Refresh (P0 hotfix: refresh package must validate server-side) ──
const REFRESH_PRICES = {
  small: 320,
  suv2: 360,
  suv3: 405,
  truck: 395,
};
const REFRESH_TIER_LABELS = {
  small: 'Small Car',
  suv2: 'SUV 2-Row',
  suv3: 'SUV 3-Row',
  truck: 'Truck',
};

for (const [tierKey, expected] of Object.entries(REFRESH_PRICES)) {
  test(`refresh package prices ${tierKey} at ${expected} (client parity)`, () => {
    const vehicle = {
      cat: 'cars',
      pkgId: 'refresh',
      tierKey,
      tierLabel: REFRESH_TIER_LABELS[tierKey],
      vehicleLabel: 'Sample Vehicle',
      addons: [],
    };
    const r = computeVehicleSubtotal(vehicle, '07601');
    assert.equal(r.ok, true);
    assert.equal(r.pkgId, 'refresh');
    assert.equal(r.basePrice, expected);
    assert.equal(r.subtotal, expected);
  });
}

test('refresh resolves from package name alias without explicit pkgId', () => {
  const vehicle = {
    cat: 'cars',
    tierKey: 'small',
    tierLabel: 'Small Car',
    pkgName: 'Exterior Refresh & Protect',
    addons: [],
  };
  const r = computeVehicleSubtotal(vehicle, '07601');
  assert.equal(r.ok, true);
  assert.equal(r.pkgId, 'refresh');
  assert.equal(r.basePrice, 320);
});

test('refresh booking validates server-side with no invalid_pricing', () => {
  const booking = {
    zipCode: '07601',
    totalPrice: 405,
    vehicles: [{
      cat: 'cars',
      pkgId: 'refresh',
      tierKey: 'suv3',
      tierLabel: 'SUV 3-Row',
      vehicleLabel: '2023 Chevy Suburban',
      subtotal: 999,
      addons: [],
    }],
  };
  const r = applyServerTravelAndTotal(booking);
  assert.equal(r.ok, true);
  assert.notEqual(r.error, 'invalid_pricing');
  assert.equal(booking.vehicles[0].subtotal, 405);
  assert.equal(booking.totalPrice, 405);
});

test('refresh with addon sums base + addon', () => {
  const vehicle = {
    cat: 'cars',
    pkgId: 'refresh',
    tierKey: 'truck',
    tierLabel: 'Truck',
    addons: [{ id: 'headlight' }],
  };
  const r = computeVehicleSubtotal(vehicle, '07601');
  assert.equal(r.ok, true);
  assert.equal(r.basePrice, 395);
  assert.equal(r.addonTotal, 90);
  assert.equal(r.subtotal, 485);
});

test('paint correction / enhancement still maps to premium, not refresh', () => {
  const vehicle = {
    cat: 'cars',
    tierKey: 'small',
    tierLabel: 'Small Car',
    pkgName: 'Paint Correction / Enhancement',
    addons: [],
  };
  const r = computeVehicleSubtotal(vehicle, '07601');
  assert.equal(r.ok, true);
  assert.equal(r.pkgId, 'premium');
  assert.equal(r.basePrice, 385);
});

test('existing car packages still validate (maint/interior/full/premium)', () => {
  const cases = [
    { pkgId: 'maint', expected: 150 },
    { pkgId: 'interior', expected: 190 },
    { pkgId: 'full', expected: 240 },
    { pkgId: 'premium', expected: 385 },
  ];
  for (const c of cases) {
    const r = computeVehicleSubtotal(
      { cat: 'cars', pkgId: c.pkgId, tierKey: 'small', tierLabel: 'Small Car', addons: [] },
      '07601'
    );
    assert.equal(r.ok, true, `${c.pkgId} should validate`);
    assert.equal(r.basePrice, c.expected);
  }
});

const FULL_DETAIL_CAPS = {
  small: 240,
  suv2: 260,
  suv3: 270,
  truck: 275,
};
const FULL_TIER_LABELS = {
  small: 'Small Car',
  suv2: 'SUV 2-Row',
  suv3: 'SUV 3-Row',
  truck: 'Truck',
};

for (const [tierKey, expected] of Object.entries(FULL_DETAIL_CAPS)) {
  test(`premium full detail (${tierKey}) capped at ${expected}`, () => {
    const r = computeVehicleSubtotal(
      {
        cat: 'cars',
        pkgId: 'full',
        tierKey,
        tierLabel: FULL_TIER_LABELS[tierKey],
        addons: [],
      },
      '07601'
    );
    assert.equal(r.ok, true);
    assert.equal(r.pkgId, 'full');
    assert.equal(r.basePrice, expected);
    assert.ok(r.basePrice <= expected);
  });
}

test('Signature/premium booking still validates server-side', () => {
  const booking = {
    zipCode: '07601',
    totalPrice: 525,
    vehicles: [{
      cat: 'cars',
      pkgId: 'premium',
      tierKey: 'truck',
      tierLabel: 'Truck',
      vehicleLabel: '2022 Ford F-130',
      subtotal: 999,
      addons: [],
    }],
  };
  const r = applyServerTravelAndTotal(booking);
  assert.equal(r.ok, true);
  assert.equal(booking.vehicles[0].subtotal, 525);
  assert.equal(booking.totalPrice, 525);
});

test('tampered refresh total is rejected as price_mismatch', () => {
  const booking = {
    zipCode: '07601',
    totalPrice: 50,
    vehicles: [{
      cat: 'cars',
      pkgId: 'refresh',
      tierKey: 'small',
      tierLabel: 'Small Car',
      addons: [],
    }],
  };
  const r = applyServerTravelAndTotal(booking);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'price_mismatch');
});

test('rich zip applies 5% premium to car base price', () => {
  const vehicle = {
    cat: 'cars',
    pkgId: 'maint',
    tierKey: 'small',
    addons: [],
  };
  assert.equal(getRichMultiplier('07620'), 1.05);
  assert.equal(applyRichPrice(150, '07620'), 184);
  const r = computeVehicleSubtotal(vehicle, '07620');
  assert.equal(r.basePrice, 158);
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
  assert.equal(r.subtotal, 210);
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
  assert.equal(r.serviceSubtotal, 150 + 100);
});

test('applyServerTravelAndTotal recalculates total with travel fee', () => {
  const booking = {
    zipCode: '07601',
    totalPrice: 150,
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
  assert.equal(booking.vehicles[0].subtotal, 150);
  assert.equal(booking.totalPrice, 150);
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
