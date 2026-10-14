'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  PRICING,
  computeVehicleSubtotal,
  computeBookingServiceSubtotal,
} = require('../netlify/lib/booking-price-catalog');
const { applyServerTravelAndTotal } = require('../netlify/lib/travel-fee');
const { quoteService } = require('../netlify/lib/canonical-quote');
const {
  stripClientCatalogTierAuthority,
  vehicleIdentity,
} = require('../netlify/lib/car-catalog-tier');
const Catalog = require('../assets/vehicle-catalog');

const ZIP = '07601';
const FULL = {
  small: 250,
  suv2: 285,
  suv3: 310,
};
const PUBLISHED_CAR_PACKAGES = {
  small: { wash: 125, maint: 160, interior: 200, full: 250, refresh: 335, premium: 400 },
  suv2: { wash: 145, maint: 195, interior: 225, full: 285, refresh: 385, premium: 495 },
  suv3: { wash: 165, maint: 225, interior: 255, full: 310, refresh: 430, premium: 570 },
  compact_van: { wash: 165, maint: 225, interior: 255, full: 300, refresh: 430, premium: 570 },
  midsize_van: { wash: 165, maint: 225, interior: 255, full: 300, refresh: 430, premium: 570 },
  full_size_van: { wash: 185, maint: 255, interior: 285, full: 335, refresh: 470, premium: 625 },
  full_size_van_passenger: { wash: 195, maint: 265, interior: 300, full: 350, refresh: 490, premium: 650 },
  truck: { wash: 165, maint: 225, interior: 255, full: 300, refresh: 420, premium: 555 },
};

function car(fields) {
  return {
    cat: 'cars',
    pkgId: 'full',
    addons: [],
    ...fields,
  };
}

function quote(fields, total, mode = 'require_identity') {
  const booking = {
    zipCode: ZIP,
    totalPrice: total,
    vehicles: [car(fields)],
  };
  const before = JSON.parse(JSON.stringify(booking));
  const result = applyServerTravelAndTotal(booking, { catalogTierMode: mode });
  return { booking, before, result };
}

test('published car package prices are unchanged', () => {
  const actual = {};
  for (const [tierKey, row] of Object.entries(PRICING.cars.tiers)) {
    actual[tierKey] = {
      wash: row.wash,
      maint: row.maint,
      interior: row.interior,
      full: row.full,
      refresh: row.refresh,
      premium: row.premium,
    };
  }
  assert.deepEqual(actual, PUBLISHED_CAR_PACKAGES);
  assert.equal(PRICING.cars.tiers.suv3.ceramic_1yr, 825);
  assert.equal(PRICING.cars.tiers.small.ceramic_1yr, 650);
  assert.equal(PRICING.cars.addons.find((addon) => addon.id === 'engine').price, 45);
});

test('Sequoia 2006 submitted as small at $250 is rejected and not rewritten', () => {
  const { booking, before, result } = quote({
    make: 'Toyota',
    model: 'Sequoia',
    year: 2006,
    vehicleLabel: '2006 Toyota Sequoia',
    tierKey: 'small',
    tierLabel: 'Small Car',
  }, FULL.small);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'tier_mismatch');
  assert.equal(result.serverTotal, undefined);
  assert.deepEqual(booking, before);
});

test('Sequoia 2006 submitted as suv3 at $310 is accepted', () => {
  const { booking, result } = quote({
    make: 'Toyota',
    model: 'Sequoia',
    year: 2006,
    vehicleLabel: '2006 Toyota Sequoia',
    tierKey: 'suv3',
  }, FULL.suv3);
  assert.equal(result.ok, true);
  assert.equal(result.serverTotal, FULL.suv3);
  assert.equal(booking.totalPrice, FULL.suv3);
  assert.equal(booking.vehicles[0].tierKey, 'suv3');
  assert.equal(booking.vehicles[0].basePrice, FULL.suv3);
});

test('Magnum 2005 submitted as suv3 at $310 is rejected', () => {
  const resolved = Catalog.resolveVehicle({ make: 'Dodge', model: 'Magnum', year: 2005 });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.tierKey, 'small');
  const { booking, before, result } = quote({
    make: 'Dodge',
    model: 'Magnum',
    year: 2005,
    vehicleLabel: '2005 Dodge Magnum',
    tierKey: 'suv3',
  }, FULL.suv3);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'tier_mismatch');
  assert.deepEqual(booking, before);
});

test('Magnum 2005 submitted as small at $250 is accepted', () => {
  const { result, booking } = quote({
    make: 'Dodge',
    model: 'Magnum',
    year: 2005,
    vehicleLabel: '2005 Dodge Magnum',
    tierKey: 'small',
  }, FULL.small);
  assert.equal(result.ok, true);
  assert.equal(result.serverTotal, FULL.small);
  assert.equal(booking.vehicles[0].basePrice, FULL.small);
});

test('Camry with its catalog class is accepted and a lower-looking mismatch is not', () => {
  const honest = quote({
    make: 'Toyota',
    model: 'Camry',
    year: 2018,
    vehicleLabel: '2018 Toyota Camry',
    tierKey: 'small',
  }, FULL.small);
  assert.equal(honest.result.ok, true);
  assert.equal(honest.result.serverTotal, FULL.small);

  const forged = quote({
    make: 'Toyota',
    model: 'Camry',
    year: 2018,
    vehicleLabel: '2018 Toyota Camry',
    tierKey: 'suv2',
  }, FULL.suv2);
  assert.equal(forged.result.ok, false);
  assert.equal(forged.result.error, 'tier_mismatch');
});

test('an unknown tier key is invalid_pricing before any class comparison', () => {
  const { result } = quote({
    make: 'Toyota',
    model: 'Sequoia',
    year: 2006,
    vehicleLabel: '2006 Toyota Sequoia',
    tierKey: 'free',
  }, 0);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_pricing');

  const staleLabel = computeVehicleSubtotal(car({
    make: 'Toyota',
    model: 'Sequoia',
    year: 2006,
    tierKey: 'not_a_real_tier',
    tierLabel: 'SUV 3-Row',
  }), ZIP);
  assert.equal(staleLabel.ok, true);
  assert.equal(staleLabel.tierKey, 'suv3');
  assert.equal(staleLabel.basePrice, FULL.suv3);

  const staleCheaper = computeVehicleSubtotal(car({
    make: 'Toyota',
    model: 'Sequoia',
    year: 2006,
    tierKey: 'not_a_real_tier',
    tierLabel: 'Small Car',
  }), ZIP);
  assert.equal(staleCheaper.ok, false);
  assert.equal(staleCheaper.error, 'tier_mismatch');
});

test('the catalog class with a tampered total is price_mismatch', () => {
  const { result } = quote({
    make: 'Toyota',
    model: 'Sequoia',
    year: 2006,
    vehicleLabel: '2006 Toyota Sequoia',
    tierKey: 'suv3',
  }, FULL.small);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'price_mismatch');
  assert.equal(result.serverTotal, FULL.suv3);
  assert.equal(result.clientTotal, FULL.small);
});

test('ceramic Sequoia priced as a lower class is rejected', () => {
  const forged = quote({
    make: 'Toyota',
    model: 'Sequoia',
    year: 2006,
    vehicleLabel: '2006 Toyota Sequoia',
    tierKey: 'small',
    pkgId: 'ceramic_1yr',
  }, 650);
  assert.equal(forged.result.ok, false);
  assert.equal(forged.result.error, 'tier_mismatch');

  const honest = quote({
    make: 'Toyota',
    model: 'Sequoia',
    year: 2006,
    vehicleLabel: '2006 Toyota Sequoia',
    tierKey: 'suv3',
    pkgId: 'ceramic_1yr',
  }, 825);
  assert.equal(honest.result.ok, true);
  assert.equal(honest.result.serverTotal, 825);
  assert.equal(honest.booking.vehicles[0].tierKey, 'suv3');
});

test('a manipulated add-on price does not replace the catalog add-on price', () => {
  const priced = computeVehicleSubtotal(car({
    make: 'Toyota',
    model: 'Sequoia',
    year: 2006,
    vehicleLabel: '2006 Toyota Sequoia',
    tierKey: 'suv3',
    addons: [{ id: 'engine', name: 'Engine', price: 1, qty: 1 }],
  }), ZIP, null, { catalogTierMode: 'require_identity' });
  assert.equal(priced.ok, true);
  assert.equal(priced.basePrice, FULL.suv3);
  assert.equal(priced.addonTotal, 45);
  assert.equal(priced.subtotal, FULL.suv3 + 45);

  const forgedTier = quote({
    make: 'Toyota',
    model: 'Sequoia',
    year: 2006,
    tierKey: 'small',
    addons: [{ id: 'engine', price: 1 }],
  }, FULL.small + 1);
  assert.equal(forgedTier.result.ok, false);
  assert.equal(forgedTier.result.error, 'tier_mismatch');
});

test('an unrecognized vehicle on the public path does not receive a fallback price', () => {
  const { booking, before, result } = quote({
    make: 'Toyota',
    model: 'Not Listed',
    year: 2006,
    vehicleLabel: '2006 Toyota Not Listed',
    tierKey: 'small',
  }, FULL.small);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'vehicle_unresolved');
  assert.equal(result.serverTotal, undefined);
  assert.deepEqual(booking, before);

  const namedWrongMake = quote({
    make: 'Toyota',
    model: 'Civic',
    year: 2020,
    vehicleLabel: '2020 Toyota Civic',
    tierKey: 'small',
  }, FULL.small);
  assert.equal(namedWrongMake.result.error, 'vehicle_unresolved');
});

test('client override flags cannot authorize another class', () => {
  const fields = {
    make: 'Toyota',
    model: 'Sequoia',
    year: 2006,
    vehicleLabel: '2006 Toyota Sequoia',
    tierKey: 'small',
    catalogTierMode: 'known_only',
    catalogTierOverride: true,
    adminTierOverride: true,
  };
  for (const mode of ['require_identity', 'known_only']) {
    const { result } = quote(fields, FULL.small, mode);
    assert.equal(result.ok, false, mode);
    assert.equal(result.error, 'tier_mismatch', mode);
  }
  const admin = quoteService({
    zip: ZIP,
    vehicles: [car({
      ...fields,
      category: 'cars',
      packageId: 'full',
    })],
  }, { catalogTierOverride: true, adminTierOverride: true });
  assert.equal(admin.ok, false);
  assert.equal(admin.error, 'tier_mismatch');
});

test('a stored booking is not rewritten when a later recalc rejects its class', () => {
  const historical = {
    id: 'CD1-HIST-1',
    zipCode: ZIP,
    totalPrice: FULL.small,
    vehicles: [car({
      make: 'Toyota',
      model: 'Sequoia',
      year: 2006,
      vehicleLabel: '2006 Toyota Sequoia',
      tierKey: 'small',
      basePrice: FULL.small,
      subtotal: FULL.small,
    })],
  };
  const snapshot = JSON.parse(JSON.stringify(historical));
  const recalc = applyServerTravelAndTotal(historical, { skipMismatchCheck: true });
  assert.equal(recalc.ok, false);
  assert.equal(recalc.error, 'tier_mismatch');
  assert.deepEqual(historical, snapshot);

  const untouched = JSON.parse(JSON.stringify(snapshot));
  assert.deepEqual(untouched, snapshot);
});

test('a historical booking whose class already matches is not repriced', () => {
  const historical = {
    id: 'CD1-HIST-2',
    zipCode: ZIP,
    totalPrice: FULL.suv3,
    vehicles: [car({
      vehicleLabel: '2006 Toyota Sequoia',
      tierKey: 'suv3',
      basePrice: FULL.suv3,
      subtotal: FULL.suv3,
    })],
  };
  const result = applyServerTravelAndTotal(
    JSON.parse(JSON.stringify(historical)),
    { skipMismatchCheck: true }
  );
  assert.equal(result.ok, true);
  assert.equal(result.serverTotal, FULL.suv3);

  const generic = {
    id: 'CD1-HIST-3',
    zipCode: ZIP,
    totalPrice: FULL.small,
    vehicles: [car({
      vehicleLabel: 'Small Car',
      tierKey: 'small',
      basePrice: FULL.small,
      subtotal: FULL.small,
    })],
  };
  const genericResult = applyServerTravelAndTotal(JSON.parse(JSON.stringify(generic)), {
    catalogTierMode: 'require_identity',
  });
  assert.equal(genericResult.ok, true);
  assert.equal(genericResult.serverTotal, FULL.small);
});

test('normalization accepts case and spacing, and an existing alias, without fuzzy names', () => {
  const spaced = quote({
    make: '  TOYOTA ',
    model: '  sequoia  ',
    year: '2006',
    vehicleLabel: '2006 toyota   sequoia',
    tierKey: 'suv3',
  }, FULL.suv3);
  assert.equal(spaced.result.ok, true);

  const alias = quote({
    make: 'Ford',
    model: 'F150',
    year: 2020,
    vehicleLabel: '2020 Ford F150',
    tierKey: 'truck',
    pkgId: 'full',
  }, 300);
  assert.equal(alias.result.ok, true);
  assert.equal(alias.result.serverTotal, 300);

  const aliasForged = quote({
    make: 'ford',
    model: 'F 150',
    year: 2020,
    tierKey: 'small',
  }, FULL.small);
  assert.equal(aliasForged.result.error, 'tier_mismatch');

  assert.equal(Catalog.resolveVehicle({ make: 'Chevy', model: 'Suburban', year: 2023 }).ok, false);
  const chevy = vehicleIdentity({ vehicleLabel: '2023 Chevy Suburban' });
  assert.equal(chevy.attempted, false);
});

test('missing, invalid, and conflicting identity does not pick a cheaper class', () => {
  const missingYear = quote({
    make: 'Hyundai',
    model: 'Santa Fe',
    vehicleLabel: 'Hyundai Santa Fe',
    tierKey: 'suv2',
  }, FULL.suv2);
  assert.equal(missingYear.result.error, 'vehicle_unresolved');

  const invalidSantaFeYear = quote({
    make: 'Hyundai',
    model: 'Santa Fe',
    year: 1985,
    vehicleLabel: '1985 Hyundai Santa Fe',
    tierKey: 'suv2',
  }, FULL.suv2);
  assert.equal(invalidSantaFeYear.result.error, 'vehicle_unresolved');

  const santaFe2022 = quote({
    make: 'Hyundai',
    model: 'Santa Fe',
    year: 2022,
    vehicleLabel: '2022 Hyundai Santa Fe',
    tierKey: 'suv2',
  }, FULL.suv2);
  assert.equal(santaFe2022.result.ok, true);
  const santaFe2022Forged = quote({
    make: 'Hyundai',
    model: 'Santa Fe',
    year: 2022,
    tierKey: 'suv3',
  }, FULL.suv3);
  assert.equal(santaFe2022Forged.result.error, 'tier_mismatch');

  const santaFe2025 = quote({
    make: 'Hyundai',
    model: 'Santa Fe',
    year: 2025,
    vehicleLabel: '2025 Hyundai Santa Fe',
    tierKey: 'suv3',
  }, FULL.suv3);
  assert.equal(santaFe2025.result.ok, true);
  const santaFe2025Forged = quote({
    make: 'Hyundai',
    model: 'Santa Fe',
    year: 2025,
    tierKey: 'suv2',
  }, FULL.suv2);
  assert.equal(santaFe2025Forged.result.error, 'tier_mismatch');

  const missingModel = quote({
    make: 'Toyota',
    model: '',
    year: 2006,
    tierKey: 'suv3',
  }, FULL.suv3);
  assert.equal(missingModel.result.error, 'vehicle_unresolved');

  const omittedTier = quote({
    make: 'Toyota',
    model: 'Sequoia',
    year: 2006,
    vehicleLabel: '2006 Toyota Sequoia',
  }, FULL.suv3);
  assert.equal(omittedTier.result.error, 'invalid_pricing');

  const invalidSequoiaYear = quote({
    make: 'Toyota',
    model: 'Sequoia',
    year: 1985,
    vehicleLabel: '1985 Toyota Sequoia',
    tierKey: 'suv3',
  }, FULL.suv3);
  assert.equal(invalidSequoiaYear.result.ok, true);
  const invalidSequoiaCheaper = quote({
    make: 'Toyota',
    model: 'Sequoia',
    year: 1985,
    tierKey: 'small',
  }, FULL.small);
  assert.equal(invalidSequoiaCheaper.result.error, 'tier_mismatch');
});

test('passenger and cargo configurations keep different classes', () => {
  const passenger = quote({
    make: 'Dodge',
    model: 'Sprinter Passenger',
    year: 2005,
    vehicleLabel: '2005 Dodge Sprinter Passenger',
    tierKey: 'full_size_van_passenger',
  }, 350);
  assert.equal(passenger.result.ok, true);
  assert.equal(passenger.result.serverTotal, 350);

  const cargoClaim = quote({
    make: 'Dodge',
    model: 'Sprinter Passenger',
    year: 2005,
    tierKey: 'full_size_van',
  }, 335);
  assert.equal(cargoClaim.result.error, 'tier_mismatch');

  const cargo = quote({
    make: 'Dodge',
    model: 'Sprinter Cargo',
    year: 2005,
    vehicleLabel: '2005 Dodge Sprinter Cargo',
    tierKey: 'full_size_van',
  }, 335);
  assert.equal(cargo.result.ok, true);
});

test('a label that names a catalog vehicle cannot hide a forged class', () => {
  const { result } = quote({
    vehicleLabel: '2006 Toyota Sequoia',
    tierKey: 'small',
  }, FULL.small);
  assert.equal(result.error, 'tier_mismatch');

  const honest = quote({
    vehicleLabel: '2006 Toyota Sequoia',
    tierKey: 'suv3',
  }, FULL.suv3);
  assert.equal(honest.result.ok, true);
});

test('admin free text that is not in the catalog can still price an explicit tier', () => {
  const admin = computeBookingServiceSubtotal({
    zipCode: ZIP,
    vehicles: [car({
      make: 'Private',
      model: 'Coach',
      year: 2010,
      vehicleLabel: '2010 Private Coach',
      tierKey: 'suv3',
    })],
  });
  assert.equal(admin.ok, true);
  assert.equal(admin.serviceSubtotal, FULL.suv3);

  const recognized = computeBookingServiceSubtotal({
    zipCode: ZIP,
    vehicles: [car({
      make: 'Toyota',
      model: 'Highlander',
      year: 2022,
      vehicleLabel: '2022 Toyota Highlander',
      tierKey: 'suv2',
    })],
  });
  assert.equal(recognized.ok, false);
  assert.equal(recognized.error, 'tier_mismatch');
});

test('public handlers force catalog identity and discard client authority fields', () => {
  const root = path.join(__dirname, '..');
  const submit = fs.readFileSync(path.join(root, 'netlify/functions/submit-booking.js'), 'utf8');
  const preview = fs.readFileSync(path.join(root, 'netlify/functions/evaluate-booking-offer.js'), 'utf8');
  assert.match(submit, /catalogTierMode:\s*'require_identity'/);
  assert.match(preview, /catalogTierMode:\s*'require_identity'/);
  assert.match(submit, /stripClientCatalogTierAuthority/);
  assert.match(preview, /stripClientCatalogTierAuthority/);

  const booking = {
    catalogTierMode: 'known_only',
    catalogTierOverride: true,
    vehicles: [{ adminTierOverride: true, tierKey: 'small' }],
  };
  stripClientCatalogTierAuthority(booking);
  assert.equal(booking.catalogTierMode, undefined);
  assert.equal(booking.catalogTierOverride, undefined);
  assert.equal(booking.vehicles[0].adminTierOverride, undefined);
  assert.equal(booking.vehicles[0].tierKey, 'small');
});
