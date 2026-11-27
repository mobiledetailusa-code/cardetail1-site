'use strict';

/**
 * Commercial program B1: observe-only classification of Cars & SUVs booking vehicles.
 *
 * - netlify/lib/vehicle-classification-shadow.js classifies from explicit data only and
 *   never writes to the booking.
 * - submit-booking calls it after server pricing; a failure there must not change the
 *   response, the stored booking, the price or the tier.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const Shadow = require('../netlify/lib/vehicle-classification-shadow');
const Channel = require('../netlify/lib/vehicle-pricing-channel');
const Pricing = require('../netlify/lib/commercial-pricing');
const CarsCatalog = require('../assets/vehicle-catalog');
const { PRICING, validateAndRecalculateBookingPricing } = require('../netlify/lib/booking-price-catalog');
const { applyServerTravelAndTotal } = require('../netlify/lib/travel-fee');
const { validateBookingRouting } = require('../netlify/lib/booking-routing-validation');

const C = Channel.CATEGORY;
const classify = (v) => Shadow.classifyBookingVehicle({ cat: 'cars', ...v });

describe('B1 shadow classification: data gaps in today\'s Cars & SUVs selections', () => {
  const vans = CarsCatalog.publicVehicles().filter((v) => v.vehicleFamily === 'van' || v.vanSize);

  it('no Cars van selection (make, model, label, year) is enough to classify it', () => {
    assert.equal(vans.length, 13);
    for (const rec of vans) {
      for (const model of [rec.model, `${rec.model} Cargo`, `${rec.model} Passenger`]) {
        const r = classify({ make: rec.make, model, year: 2021 });
        assert.equal(r.status, 'unresolved', `${rec.make} ${model}`);
        assert.equal(r.category, 'unresolved');
        assert.ok(r.reason === 'configuration_incomplete' || r.reason === 'no_commercial_catalog_equivalent', `${rec.make} ${model}: ${r.reason}`);
      }
    }
  });

  it('lists exactly what is missing per van, never inferring from make/model', () => {
    const gap = (make, model) => classify({ make, model, year: 2021 }).missing;
    assert.deepEqual(gap('Ford', 'Transit'), ['body', 'roof', 'length', 'passengerCapacity', 'wheelchairAccessible']);
    assert.deepEqual(gap('Ford', 'Transit Passenger'), ['body', 'roof', 'length', 'passengerCapacity', 'wheelchairAccessible']);
    assert.deepEqual(gap('Mercedes-Benz', 'Sprinter'), ['vanUse', 'roof', 'length', 'passengerCapacity', 'wheelchairAccessible']);
    assert.deepEqual(gap('Mercedes-Benz', 'Sprinter Cargo'), ['roof', 'length', 'wheelchairAccessible']);
    assert.deepEqual(gap('Mercedes-Benz', 'Sprinter Passenger'), ['roof', 'length', 'passengerCapacity', 'wheelchairAccessible']);
    assert.deepEqual(gap('Ram', 'ProMaster'), ['roof', 'length', 'wheelchairAccessible']);
    assert.deepEqual(gap('Nissan', 'NV'), ['vanUse', 'roof', 'passengerCapacity', 'wheelchairAccessible']);
    assert.deepEqual(gap('Chevrolet', 'Express'), ['body', 'length', 'passengerCapacity', 'wheelchairAccessible']);
    assert.deepEqual(gap('Ford', 'Transit Connect'), ['vanUse', 'length', 'passengerCapacity', 'wheelchairAccessible']);
    assert.deepEqual(gap('Mercedes-Benz', 'Metris Cargo'), ['wheelchairAccessible']);
    assert.deepEqual(gap('Nissan', 'NV200'), ['wheelchairAccessible']);
    for (const [make, model] of [['Ford', 'E-Series'], ['Dodge', 'Sprinter'], ['Chevrolet', 'City Express']]) {
      assert.equal(classify({ make, model, year: 2012 }).reason, 'no_commercial_catalog_equivalent', model);
    }
  });

  it('cargo vs passenger comes only from an explicit field or a Cargo/Passenger model label', () => {
    assert.equal(classify({ make: 'Mercedes-Benz', model: 'Sprinter', year: 2021 }).known.vanUse, null);
    assert.equal(classify({ make: 'Mercedes-Benz', model: 'Sprinter Cargo', year: 2021 }).known.vanUseSource, 'model_label');
    assert.equal(classify({ make: 'Mercedes-Benz', model: 'Sprinter Passenger', year: 2021 }).known.vanUse, 'passenger');
    assert.equal(classify({ make: 'Mercedes-Benz', model: 'Sprinter', vanUse: 'passenger', year: 2021 }).known.vanUseSource, 'field');
    assert.equal(classify({ make: 'Mercedes-Benz', model: 'Sprinter', vanUse: 'bus', year: 2021 }).known.vanUse, null);
    // Single-use catalog records (ProMaster is cargo only) are a catalog fact.
    assert.equal(classify({ make: 'Ram', model: 'ProMaster', year: 2021 }).known.vanUseSource, 'catalog_single_option');
    // The label is also read from vehicleLabel, as the booking form sends it.
    assert.equal(classify({ vehicleLabel: '2019 Chevrolet Express Passenger' }).known.vanUse, 'passenger');
  });

  it('a missing passenger count is never treated as zero', () => {
    const full = { make: 'Ford', model: 'Transit Passenger', year: 2021, body: 'passenger_van', roof: 'high', length: 'extended', wheelchairPositions: 0 };
    const r = classify(full);
    assert.equal(r.status, 'unresolved');
    assert.deepEqual(r.missing, ['passengerCapacity']);
    for (const bad of ['', null, 'many', -1, 2.5, 99]) {
      assert.deepEqual(classify({ ...full, passengerCapacity: bad }).missing, ['passengerCapacity'], String(bad));
    }
    assert.equal(classify({ ...full, passengerCapacity: 15 }).status, 'resolved');
  });

  it('HD pickups need the body type; 2500-class pickups and ordinary cars stay Cars vehicles', () => {
    const f350 = classify({ make: 'Ford', model: 'F-350 Super Duty', year: 2020 });
    assert.equal(f350.status, 'unresolved');
    assert.deepEqual(f350.missing, ['bedType']);
    assert.deepEqual(f350.candidates, [C.CARS_VEHICLE, C.CHASSIS_CAB_BOX_TRUCK]);
    assert.equal(classify({ make: 'Ford', model: 'F-350 Super Duty', year: 2020, bedType: 'pickup_bed' }).category, C.CARS_VEHICLE);
    assert.equal(classify({ make: 'Ford', model: 'F-350 Super Duty', year: 2020, bedType: 'chassis_cab_body' }).category, C.CHASSIS_CAB_BOX_TRUCK);
    assert.equal(classify({ make: 'Chevrolet', model: 'Silverado 2500HD', year: 2020 }).category, C.CARS_VEHICLE);
    assert.equal(classify({ make: 'Toyota', model: 'Camry', year: 2020 }).category, C.CARS_VEHICLE);
    assert.equal(classify({ make: 'Honda', model: 'Odyssey', year: 2020 }).category, C.CARS_VEHICLE);
  });
});

describe('B1 shadow classification: candidates once configuration is known (B2 fields)', () => {
  const transit = { make: 'Ford', model: 'Transit', year: 2021, roof: 'medium', length: 'regular', wheelchairPositions: 0 };

  it('separates comparable vans, large vans, shuttle buses and box trucks', () => {
    assert.equal(classify({ ...transit, body: 'passenger_van', passengerCapacity: 8 }).category, C.COMPARABLE_VAN);
    assert.equal(classify({ ...transit, body: 'passenger_van', roof: 'high', length: 'extended', passengerCapacity: 15 }).category, C.LARGE_COMMERCIAL_VAN);
    assert.equal(classify({ ...transit, body: 'cargo_van' }).category, C.COMPARABLE_VAN);
    assert.equal(classify({ ...transit, body: 'cargo_van', roof: 'high' }).category, C.LARGE_COMMERCIAL_VAN);
    assert.deepEqual(classify({ ...transit, body: 'cargo_van', wheelchairPositions: 2 }).missing, ['passengerCapacity']);
    assert.equal(classify({ ...transit, body: 'cargo_van', wheelchairPositions: 2, passengerCapacity: 6 }).category, C.LARGE_COMMERCIAL_VAN);
    assert.equal(classify({ make: 'Ford', model: 'Transit', year: 2021, body: 'shuttle_bus' }).category, C.SHUTTLE_BUS);
    assert.equal(classify({ make: 'Chevrolet', model: 'Express', year: 2021, body: 'box_truck' }).category, C.CUTAWAY_BOX_TRUCK);
  });

  it('reports the draft policy and never enforces it', () => {
    const r = classify({ ...transit, body: 'passenger_van', passengerCapacity: 8 });
    assert.equal(r.policyStatus, 'draft');
    assert.equal(Channel.CHANNEL_ENFORCEMENT_ENABLED, false);
    assert.equal(Channel.DRAFT_CHANNEL_POLICY.status, 'draft');
    assert.equal(Shadow.shadowClassifyBooking({ vehicles: [{ cat: 'cars', ...transit }] }).enforced, false);
  });

  it('unsupported or invalid configurations stay unresolved', () => {
    assert.equal(classify({ make: 'Ford', model: 'Transit', year: 2021, body: 'limousine' }).missing[0], 'body');
    assert.equal(classify({ make: 'Nope', model: 'Nothing', year: 2021 }).reason, 'vehicle_not_in_catalog');
    assert.equal(classify({}).reason, 'vehicle_identity_missing');
    assert.equal(Shadow.classifyBookingVehicle({ cat: 'fleet', make: 'Ford', model: 'Transit' }).status, 'not_applicable');
    assert.equal(classify({ ...transit, body: 'passenger_van', roof: 'super_high', passengerCapacity: 8 }).status, 'unresolved');
  });
});

describe('B1 shadow classification: isolation and failures', () => {
  it('never mutates the booking (frozen input, deep equality)', () => {
    const booking = {
      vehicleCategory: 'cars',
      vehicles: [{ cat: 'cars', pkgId: 'full', tierKey: 'full_size_van', vehicleLabel: '2021 Ford Transit', addons: [] }],
      totalPrice: 335,
    };
    const before = structuredClone(booking);
    const deepFreeze = (o) => { Object.values(o).forEach((x) => x && typeof x === 'object' && deepFreeze(x)); return Object.freeze(o); };
    deepFreeze(booking);
    Shadow.shadowClassifyBooking(booking);
    Shadow.observeBookingVehicles(booking, { log: () => {} });
    assert.deepEqual(booking, before);
  });

  it('a classifier error becomes an error result, never an exception', () => {
    const original = Channel.classifyCarsVehicle;
    Channel.classifyCarsVehicle = () => { throw new Error('boom'); };
    try {
      const out = Shadow.shadowClassifyBooking({ vehicles: [{ cat: 'cars', make: 'Ford', model: 'F-350 Super Duty', bedType: 'pickup_bed' }] });
      assert.equal(out.vehicles[0].status, 'error');
      assert.equal(out.vehicles[0].category, 'unresolved');
    } finally {
      Channel.classifyCarsVehicle = original;
    }
    const hostile = { get vehicles() { throw new Error('getter'); } };
    assert.doesNotThrow(() => Shadow.shadowClassifyBooking(hostile));
    assert.doesNotThrow(() => Shadow.observeBookingVehicles(hostile, { log: () => { throw new Error('log'); } }));
    assert.doesNotThrow(() => Shadow.observeBookingVehicles(null, { log: () => {} }));
    assert.doesNotThrow(() => Shadow.observeBookingVehicles({ vehicles: [{ cat: 'cars', toJSON() { throw new Error('json'); } }] }));
  });

  it('logs one PII-free line only for a final booking with a van, HD pickup or error', () => {
    const lines = [];
    const log = (...args) => lines.push(args.join(' '));
    const booking = {
      firstName: 'Pat', lastName: 'Example', phone: '2015550100', email: 'pat@example.com', address: '1 Main St', zipCode: '07601',
      vehicles: [
        { cat: 'cars', tierKey: 'small', vehicleLabel: '2020 Toyota Camry' },
        { cat: 'cars', tierKey: 'full_size_van', vehicleLabel: '2021 Ford Transit' },
      ],
    };
    Shadow.observeBookingVehicles(booking, { isDraft: true, log });
    assert.equal(lines.length, 0, 'drafts are not logged');
    Shadow.observeBookingVehicles({ vehicles: [booking.vehicles[0]] }, { log });
    assert.equal(lines.length, 0, 'ordinary cars are not logged');
    Shadow.observeBookingVehicles(booking, { log });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[vehicle-classification-shadow\] /);
    for (const pii of ['Pat', 'Example', '2015550100', 'pat@example.com', 'Main St', '07601']) assert.ok(!lines[0].includes(pii), pii);
    const payload = JSON.parse(lines[0].replace('[vehicle-classification-shadow] ', ''));
    assert.equal(payload.enforced, false);
    assert.deepEqual(payload.vehicles.map((v) => [v.i, v.category, v.tierKey]), [[1, 'unresolved', 'full_size_van']]);
  });

  it('exposes no price, amount or rate card', () => {
    const out = JSON.stringify(Shadow.shadowClassifyBooking({ vehicles: [
      { cat: 'cars', make: 'Ford', model: 'Transit', year: 2021, body: 'passenger_van', roof: 'high', length: 'extended', passengerCapacity: 15, wheelchairPositions: 0 },
      { cat: 'cars', make: 'Ford', model: 'Transit', year: 2021, body: 'shuttle_bus' },
    ] }));
    assert.doesNotMatch(out, /price|amount|cents|total|rateCard|\$/i);
  });
});

describe('B1 financial safety', () => {
  const carsBooking = (vehicle, total) => ({
    zipCode: '07102',
    vehicleCategory: 'cars',
    vehicles: [{ cat: 'cars', pkgId: 'full', addons: [], ...vehicle }],
    totalPrice: total,
  });
  const cases = [
    [{ tierKey: 'small', vehicleLabel: '2024 Honda Civic' }, 250],
    [{ tierKey: 'full_size_van', vehicleLabel: '2021 Ford Transit' }, 335],
    [{ tierKey: 'full_size_van_passenger', vehicleLabel: '2021 Ford Transit Passenger' }, 350],
    [{ tierKey: 'full_size_van', vehicleLabel: '2021 Mercedes-Benz Sprinter Cargo' }, 335],
    [{ tierKey: 'full_size_van', vehicleLabel: '2021 Ram ProMaster' }, 335],
    [{ tierKey: 'truck', vehicleLabel: '2020 Ford F-350 Super Duty' }, 300],
  ];

  it('Cars prices and tiers are identical with and without the shadow pass', () => {
    assert.equal(PRICING.cars.tiers.full_size_van.full, 335);
    assert.equal(PRICING.cars.tiers.full_size_van_passenger.full, 350);
    for (const [vehicle, total] of cases) {
      const a = carsBooking(vehicle, total);
      const b = structuredClone(a);
      const ra = applyServerTravelAndTotal(a, { catalogTierMode: 'require_identity' });
      Shadow.observeBookingVehicles(b, { log: () => {} });
      const rb = applyServerTravelAndTotal(b, { catalogTierMode: 'require_identity' });
      assert.equal(ra.ok, true, vehicle.vehicleLabel);
      assert.deepEqual(rb, ra, vehicle.vehicleLabel);
      assert.deepEqual(b, a, vehicle.vehicleLabel);
      assert.equal(a.totalPrice, total, vehicle.vehicleLabel);
      const priced = validateAndRecalculateBookingPricing(structuredClone(a), { catalogTierMode: 'require_identity' });
      assert.equal(priced.vehicles[0].tierKey, vehicle.tierKey);
    }
  });

  it('no commercial price, checkout or routing change is reachable', () => {
    assert.equal(Pricing.ACTIVE_RATE_CARD.status, 'draft');
    assert.equal(Pricing.validateRateCard(Pricing.ACTIVE_RATE_CARD).approved, false);
    assert.equal(Pricing.COMMERCIAL_PUBLIC_PRICING_ENABLED, false);
    assert.equal(Pricing.COMMERCIAL_CHECKOUT_ENABLED, false);
    assert.equal(Pricing.commercialCheckoutEnabled(), false);
    assert.equal(validateBookingRouting({ zipCode: '07601', vehicles: [{ cat: 'fleet', units: 3 }] }).error, 'fleet_quote_required');
    assert.equal(validateBookingRouting({ zipCode: '07601', vehicles: [{ cat: 'cars' }], isCommercial: true }).ok, false);
  });
});

describe('B1 submit-booking integration: shadow outcome never changes the booking', () => {
  const submitBooking = require('../netlify/functions/submit-booking');
  const envKeys = ['DRAFT_TOKEN_SECRET', 'ADMIN_EMAIL', 'RESEND_API_KEY', 'TWILIO_SEND_ENABLED', 'CONTEXT', 'NETLIFY_DEV', 'STRIPE_SECRET_KEY'];
  const env = {};
  const originalFetch = globalThis.fetch;
  const originalObserve = Shadow.observeBookingVehicles;

  function createMemoryStore() {
    const data = new Map();
    return {
      data,
      async get(key) { const v = data.get(key); return v == null ? null : structuredClone(v); },
      async setJSON(key, value) { data.set(key, structuredClone(value)); return { modified: true }; },
      async list() { return { blobs: [...data.keys()].map((key) => ({ key })) }; },
    };
  }

  const payload = (overrides = {}) => ({
    firstName: 'Shadow', lastName: 'Test', phone: '2015550188', email: 'shadow@example.com',
    address: '1 Main St, Newark, NJ', zipCode: '07102',
    preferredDate: '2099-06-16', preferredTime: '10:00 AM', preferredArrivalWindow: '', scheduleFlexibility: 'exact',
    vehicle: '2021 Ford Transit', vehicleCategory: 'cars', vehicleTier: 'Full-Size Cargo Van',
    package: 'Premium Detail', packageId: 'full',
    vehicles: [{
      vehicleId: 'vehicle-1', cat: 'cars', pkgId: 'full', pkgName: 'Premium Detail',
      tierKey: 'full_size_van', tierLabel: 'Full-Size Cargo Van', vehicleLabel: '2021 Ford Transit',
      addons: [], addonTotal: 0,
    }],
    totalPrice: 335, travelFeeAmount: 0, zoneSurcharge: 0,
    paymentMethod: '', paymentMethodPreference: '', cardOnFileRequired: false,
    acceptedCardOnFilePolicy: false, acceptedCardOnFilePolicyAt: null,
    acceptedBookingPolicy: true, policyVersion: '2026-08-booking-request',
    ...overrides,
  });

  async function post(body) {
    const response = await submitBooking.handler({
      httpMethod: 'POST',
      headers: { 'x-nf-client-connection-ip': '203.0.113.77' },
      body: JSON.stringify(body),
    });
    return { status: response.statusCode, body: JSON.parse(response.body) };
  }

  const STABLE = ['isDraft', 'kind', 'status', 'paymentStatus', 'appointmentStatus', 'cardOnFileStatus', 'totalPrice', 'travelFeeAmount', 'vehicleCategory', 'vehicleTier', 'package'];
  async function run(mode) {
    const store = createMemoryStore();
    submitBooking.__test.setBlobsStoreOverride(async () => store);
    const lines = [];
    const originalLog = console.log;
    console.log = (...args) => { if (String(args[0]).includes('vehicle-classification-shadow')) lines.push(args.join(' ')); else originalLog(...args); };
    if (mode === 'throws') Shadow.observeBookingVehicles = () => { throw new Error('shadow exploded'); };
    if (mode === 'absent') Shadow.observeBookingVehicles = () => undefined;
    try {
      const draft = await post(payload({ isDraft: true }));
      const final = await post(payload({ draftBookingId: draft.body.id, draftSaveToken: draft.body.draftSaveToken }));
      const saved = await store.get(final.body.id);
      const pick = (o) => Object.fromEntries(STABLE.map((k) => [k, o && o[k]]));
      const vehicles = (saved.vehicles || []).map((v) => ({ tierKey: v.tierKey, basePrice: v.basePrice, subtotal: v.subtotal, pkgId: v.pkgId }));
      return {
        draftStatus: draft.status,
        finalStatus: final.status,
        finalOk: final.body.ok,
        bookingCreated: final.body.bookingCreated,
        response: pick(final.body),
        saved: pick(saved),
        vehicles,
        shadowKeys: Object.keys(saved).filter((k) => /shadow|classification/i.test(k)),
        lines,
      };
    } finally {
      console.log = originalLog;
      Shadow.observeBookingVehicles = originalObserve;
      submitBooking.__test.setBlobsStoreOverride(null);
    }
  }

  before(() => {
    for (const key of envKeys) env[key] = process.env[key];
    process.env.DRAFT_TOKEN_SECRET = 's'.repeat(40);
    process.env.ADMIN_EMAIL = '';
    process.env.RESEND_API_KEY = '';
    process.env.TWILIO_SEND_ENABLED = 'false';
    process.env.CONTEXT = 'deploy-preview';
    delete process.env.NETLIFY_DEV;
    delete process.env.STRIPE_SECRET_KEY;
    globalThis.fetch = async () => { throw new Error('unexpected_external_call'); };
  });

  after(() => {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
  });

  it('a van booking is accepted identically whether the shadow works, throws or is absent', async () => {
    const normal = await run('normal');
    const throwing = await run('throws');
    const absent = await run('absent');

    assert.equal(normal.draftStatus, 200);
    assert.equal(normal.finalStatus, 200);
    assert.equal(normal.finalOk, true);
    assert.equal(normal.bookingCreated, true);
    assert.equal(normal.saved.totalPrice, 335);
    assert.deepEqual(normal.vehicles, [{ tierKey: 'full_size_van', basePrice: 335, subtotal: 335, pkgId: 'full' }]);
    assert.deepEqual(normal.shadowKeys, [], 'nothing is stored on the booking');

    for (const other of [throwing, absent]) {
      assert.deepEqual({ ...other, lines: null }, { ...normal, lines: null });
    }

    // Exactly one diagnostic line, for the final submission, with no customer data.
    assert.equal(normal.lines.length, 1);
    for (const pii of ['Shadow', 'Test', '2015550188', 'shadow@example.com', 'Main St', '07102']) assert.ok(!normal.lines[0].includes(pii), pii);
    assert.match(normal.lines[0], /"category":"unresolved"/);
    assert.equal(throwing.lines.length, 0);
  });
});
