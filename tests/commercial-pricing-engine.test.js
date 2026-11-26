'use strict';

/**
 * Commercial pricing engine (rate card v2) and the shared vehicle classifier.
 *
 * - netlify/lib/commercial-pricing.js: base services, add-ons, configuration labor,
 *   travel, minimum ticket, manual-quote eligibility. Inactive: draft card, no public
 *   price, no checkout.
 * - netlify/lib/vehicle-pricing-channel.js: classification from validated configuration.
 *   Not used by any booking path.
 *
 * Amounts in fixtureCard() are synthetic test numbers, not a price proposal. The
 * proposed (unapproved) amounts live only in docs/pricing on the analysis branch.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const CC = require('../assets/commercial-vehicle-catalog');
const Pricing = require('../netlify/lib/commercial-pricing');
const Channel = require('../netlify/lib/vehicle-pricing-channel');
const Travel = require('../netlify/lib/travel-fee');
const { PRICING } = require('../netlify/lib/booking-price-catalog');

const TEST_POLICY = { status: 'approved', comparableClasses: ['cv_van_compact', 'cv_van_midsize', 'cv_van_full'], comparableMaxSeats: 8 };

/** Test-only approved card with synthetic amounts (not a price proposal). */
function fixtureCard(overrides = {}) {
  const card = Pricing.draftRateCard();
  CC.SIZE_CLASSES.forEach((cls, i) => {
    const row = card.sizeClasses[cls];
    row.includedSeats = cls === 'cv_shuttle_small' ? 14 : cls === 'cv_shuttle_medium' ? 20 : cls === 'cv_shuttle_large' ? 28 : 3;
    row.services.interior_cleaning = { cents: 10000 + 100 * i, minutes: 60 };
    row.services.exterior_wash = { cents: 8000 + 100 * i, minutes: 45 };
    row.services.full_detail = { cents: 15000 + 100 * i, minutes: 90 };
    for (const s of Pricing.SERVICES) row.maxAutoMiles[s] = 30;
    Object.assign(row.addOns.deep_interior, { cents: 3000, minutes: 30, perExtraSeatCents: 500, perWheelchairPositionCents: 700, minimumCents: 2500 });
    for (const k of Object.keys(row.addOns.roof_cleaning.byRoofHeight)) row.addOns.roof_cleaning.byRoofHeight[k] = { cents: k === 'high' ? 2600 : 2000, minutes: 15 };
    Object.assign(row.addOns.undercarriage_wash, { cents: 3000, minutes: 20 });
  });
  card.sizeClasses.cv_shuttle_medium.maxAutoMiles.full_detail = 110;
  Object.assign(card.configuration, { extraSeatCentsPerSeat: 700, minutesPerExtraSeat: 4, wheelchairPositionCents: 3000, minutesPerWheelchairPosition: 15, superHighRoofCents: 6000, superHighRoofMinutes: 30 });
  card.roundToCents = 500;
  card.mobileWaterCents = 5000;
  card.safeguards.minimumTicketCents = 100;
  card.safeguards.minimumRevenuePerHourCents = 100;
  card.channelPolicy.comparableMaxSeats = 8;
  return Object.assign(card, { status: 'approved', approvedBy: 'test-fixture', approvedAt: '2026-11-20T00:00:00Z' }, overrides);
}
const withEquipment = (card) => Object.assign(card, { equipmentConfirmed: { roofPlatformForTallVehicles: true, undercarriageKitForTrucksAndBuses: true, mobileWaterApproved: true } });

const T15 = { modelId: 'ford_transit', body: 'passenger_van', roof: 'high', length: 'long', passengerCapacity: 15, year: 2022 };
const CARGO = { modelId: 'ford_transit', body: 'cargo_van', roof: 'low', length: 'regular', year: 2022 };
const BUS = { modelId: 'chevrolet_gmc_cutaway_bus', body: 'shuttle_bus', busLength: '25_to_29', passengerCapacity: 24, wheelchairPositions: 2, year: 2022 };
const BOX = { modelId: 'isuzu_n_series', body: 'box_truck', boxLength: '14_to_16', year: 2022 };
const quote = (req, card = fixtureCard()) => Pricing.quoteCommercial({ zip: '07601', ...req }, { rateCard: card });
const codes = (q) => q.lines.map((l) => l.code);

describe('classifier: categories come from the validated configuration', () => {
  const cat = (sel, policy = TEST_POLICY) => Channel.classifyCommercialSelection(sel, { policy }).category;

  it('comparable vans, large commercial vans, buses, cutaways, chassis cabs, unsupported', () => {
    assert.equal(cat(CARGO), 'comparable_van');
    assert.equal(cat({ modelId: 'ford_transit_connect', body: 'passenger_van', length: 'lwb', passengerCapacity: 5, year: 2022 }), 'comparable_van');
    assert.equal(cat(T15), 'large_commercial_van');
    assert.equal(cat({ ...CARGO, roof: 'high' }), 'large_commercial_van');
    assert.equal(cat({ ...CARGO, length: 'long' }), 'large_commercial_van');
    assert.equal(cat({ ...CARGO, body: 'passenger_van', passengerCapacity: 12 }), 'large_commercial_van');
    assert.equal(cat({ ...CARGO, body: 'wheelchair_van', passengerCapacity: 6, wheelchairPositions: 1 }), 'large_commercial_van');
    assert.equal(cat(BUS), 'shuttle_bus');
    assert.equal(cat({ modelId: 'ford_eseries_cutaway_box', body: 'box_truck', boxLength: '14_to_16', year: 2022 }), 'cutaway_box_truck');
    assert.equal(cat(BOX), 'chassis_cab_box_truck');
    assert.equal(cat({ modelId: 'hino_box', body: 'box_truck', boxLength: '22_to_26', year: 2022 }), 'chassis_cab_box_truck');
    assert.equal(cat({ modelId: 'other_box_truck', body: 'box_truck', boxLength: '14_to_16', year: 2022 }), 'unsupported');
    assert.equal(cat({ modelId: 'ford_transit', body: 'cargo_van', length: 'regular', year: 2022 }), 'unsupported', 'roof not given');
    assert.equal(Channel.classifyCommercialSelection({ modelId: 'nope' }).ok, false);
  });

  it('every catalog configuration gets exactly one category', () => {
    const allowed = Object.values(Channel.CATEGORY);
    for (const m of CC.MODELS) for (const body of m.bodies) {
      const sel = { modelId: m.id, body, roof: m.roofs[0], length: m.lengths[0], busLength: m.busLengths[0], boxLength: m.boxLengths[0], passengerCapacity: 4, year: 2022 };
      const c = Channel.classifyCommercialSelection(sel, { policy: TEST_POLICY });
      if (c.ok) assert.ok(allowed.includes(c.category), `${m.id}/${body}: ${c.category}`);
    }
  });

  it('a client size class or tier on the selection is ignored', () => {
    const c = Channel.classifyCommercialSelection({ ...T15, sizeClass: 'cv_van_compact', tierKey: 'small', category: 'comparable_van' }, { policy: TEST_POLICY });
    assert.equal(c.sizeClass, 'cv_van_full_xl');
    assert.equal(c.category, 'large_commercial_van');
  });

  it('the eight-seat boundary is a draft: no comparable van without an approved policy', () => {
    assert.equal(Channel.DRAFT_CHANNEL_POLICY.status, 'draft');
    assert.equal(Channel.classifyCommercialSelection(CARGO).policyApproved, false);
    assert.equal(Channel.classifyCommercialSelection(CARGO, { policy: null }).category, 'large_commercial_van');
    assert.equal(Pricing.ACTIVE_RATE_CARD.channelPolicy.comparableMaxSeats, null);
  });

  it('Cars & SUVs vehicles: what the classifier would decide (not enforced)', () => {
    assert.equal(Channel.CHANNEL_ENFORCEMENT_ENABLED, false);
    const ch = (v) => Channel.classifyCarsVehicle(v, { policy: TEST_POLICY });
    assert.equal(ch({ make: 'Ford', model: 'Transit', year: 2022, vanUse: 'passenger' }).channel, 'configuration_required');
    assert.deepEqual(ch({ make: 'Ford', model: 'Transit', year: 2022, vanUse: 'passenger', body: 'passenger_van', roof: 'high', length: 'long', passengerCapacity: 15 }), { category: 'large_commercial_van', channel: 'commercial', sizeClass: 'cv_van_full_xl', policyApproved: true });
    assert.equal(ch({ make: 'Ford', model: 'Transit', year: 2022, vanUse: 'cargo', body: 'cargo_van', roof: 'low', length: 'regular' }).channel, 'cars');
    assert.equal(ch({ make: 'Ford', model: 'E-Series', year: 2020, body: 'shuttle_bus' }).category, 'shuttle_bus');
    assert.equal(ch({ make: 'Chevrolet', model: 'Express', year: 2020, body: 'box_truck' }).category, 'cutaway_box_truck');
    assert.equal(ch({ make: 'Ram', model: '3500', year: 2021 }).channel, 'configuration_required');
    assert.equal(ch({ make: 'Ram', model: '3500', year: 2021, bedType: 'chassis_with_body' }).category, 'chassis_cab_box_truck');
    assert.equal(ch({ make: 'Ram', model: '3500', year: 2021, bedType: 'pickup_bed' }).channel, 'cars');
    assert.equal(ch({ make: 'Ford', model: 'Transit Connect', year: 2020 }).channel, 'cars');
    assert.equal(ch({ make: 'Honda', model: 'Accord', year: 2020 }).channel, 'cars');
  });
});

describe('engine: server-authoritative configuration', () => {
  it('client price, total, size class, tier, miles and rate card are ignored', () => {
    const clean = quote({ selection: T15, service: 'full_detail', addOns: ['deep_interior'] });
    const forged = quote({
      selection: { ...T15, sizeClass: 'cv_van_compact', tierKey: 'small' }, service: 'full_detail', addOns: ['deep_interior'],
      price: 1, priceCents: 1, totalCents: 1, sizeClass: 'cv_van_compact', tierKey: 'small', miles: 0, travelFee: 0, lines: [], rateCard: fixtureCard({ status: 'approved' }),
    });
    assert.deepEqual(forged, clean);
    assert.equal(clean.ok, true);
    assert.equal(clean.sizeClass, 'cv_van_full_xl');
  });

  it('a 15-passenger Transit is never priced from a Cars tier', () => {
    const q = quote({ selection: T15, service: 'full_detail' });
    assert.equal(q.priceSource, 'commercial_rate_card');
    assert.ok(q.lines.every((l) => !String(l.source || '').startsWith('cars:')));
  });

  it('comparable vans use the Cars van price only under an approved channel policy', () => {
    const parity = quote({ selection: CARGO, service: 'full_detail', addOns: ['roof_cleaning'] });
    assert.equal(parity.priceSource, 'cars_parity');
    assert.equal(parity.lines[0].cents, PRICING.cars.tiers.full_size_van.full * 100);
    assert.deepEqual(codes(parity), ['full_detail', 'roof_cleaning']);
    const card = fixtureCard();
    card.channelPolicy.comparableMaxSeats = null; // policy not approved -> card incomplete -> no price at all
    assert.equal(quote({ selection: CARGO, service: 'full_detail' }, card).reason, 'pricing_not_approved');
  });
});

describe('engine: base services and configuration adjustments', () => {
  it('each base service is one line at the class amount', () => {
    const card = fixtureCard();
    const row = card.sizeClasses.cv_van_full_xl;
    for (const s of Pricing.SERVICES) {
      const q = quote({ selection: { ...CARGO, roof: 'high', length: 'long' }, service: s }, card);
      assert.deepEqual(codes(q), [s]);
      assert.equal(q.servicesCents, row.services[s].cents);
      assert.equal(q.estimatedMinutes, row.services[s].minutes);
    }
  });

  it('seat and wheelchair labor apply to interior work only, rounded to the card step', () => {
    const q = quote({ selection: BUS, service: 'interior_cleaning' });
    assert.deepEqual(codes(q), ['interior_cleaning', 'extra_seat', 'wheelchair_position']);
    assert.equal(q.lines[1].qty, 4); // 24 seats, 20 included
    assert.equal(q.lines[1].cents, 3000); // 4 x 700 = 2800 -> 3000
    assert.equal(q.lines[2].cents, 6000);
    assert.equal(q.estimatedMinutes, 60 + 4 * 4 + 2 * 15);
    assert.deepEqual(codes(quote({ selection: BUS, service: 'exterior_wash' })), ['exterior_wash']);
  });

  it('super-high roof adds exterior labor only', () => {
    const sh = { modelId: 'ram_promaster', body: 'cargo_van', roof: 'super_high', length: 'wb159', year: 2024 };
    assert.deepEqual(codes(quote({ selection: sh, service: 'exterior_wash' })), ['exterior_wash', 'super_high_roof']);
    assert.deepEqual(codes(quote({ selection: sh, service: 'interior_cleaning' })), ['interior_cleaning']);
  });

  it('minimum ticket and revenue-per-hour floors add an adjustment line', () => {
    const card = fixtureCard();
    card.safeguards.minimumTicketCents = 999000;
    const q = quote({ selection: BOX, service: 'exterior_wash' }, card);
    assert.equal(q.servicesCents, 999000);
    assert.equal(q.lines.at(-1).code, 'minimum_job_adjustment');
    const card2 = fixtureCard();
    card2.safeguards.minimumRevenuePerHourCents = 100000; // $1,000/h x 45 min = $750
    assert.equal(quote({ selection: BOX, service: 'exterior_wash' }, card2).servicesCents, 75000);
  });
});

describe('engine: add-on compatibility and no double counting', () => {
  it('add-ons attach only to a base that includes their work', () => {
    assert.equal(quote({ selection: T15, service: 'exterior_wash', addOns: ['deep_interior'] }).reason, 'addon_needs_other_service');
    assert.equal(quote({ selection: T15, service: 'interior_cleaning', addOns: ['roof_cleaning'] }).reason, 'addon_needs_other_service');
    assert.equal(quote({ selection: T15, service: 'interior_cleaning', addOns: ['undercarriage_wash'] }).reason, 'addon_needs_other_service');
    assert.equal(quote({ selection: T15, service: 'full_detail', addOns: ['cargo_box_interior'] }).reason, 'invalid_addon');
    assert.equal(quote({ selection: T15, service: 'full_detail', addOns: ['wax'] }).reason, 'invalid_addon');
    assert.equal(quote({ selection: T15, service: 'full_detail', addOns: ['deep_interior', 'roof_cleaning', 'undercarriage_wash'] }).ok, true);
  });

  it('full detail is one line; each add-on is billed once and adds exactly its own line', () => {
    const sel = { ...CARGO, roof: 'high', length: 'long' };
    const base = quote({ selection: sel, service: 'full_detail' });
    const all = quote({ selection: sel, service: 'full_detail', addOns: ['roof_cleaning', 'deep_interior', 'roof_cleaning', 'undercarriage_wash'] });
    assert.deepEqual(codes(all), ['full_detail', 'roof_cleaning', 'deep_interior', 'undercarriage_wash']);
    assert.deepEqual(all.lines[0], base.lines[0], 'base line unchanged by add-ons');
    assert.equal(all.servicesCents - base.servicesCents, all.lines.slice(1).reduce((s, l) => s + l.cents, 0));
    assert.equal(all.estimatedMinutes, base.estimatedMinutes + 15 + 30 + 20);
  });

  it('deep interior scales with extra seats and wheelchair positions, with a minimum', () => {
    const q = quote({ selection: BUS, service: 'full_detail', addOns: ['deep_interior'] });
    const deep = q.lines.find((l) => l.code === 'deep_interior');
    assert.equal(deep.cents, 6500); // 3000 + 4 x 500 + 2 x 700 = 6400 -> 6500
    const card = fixtureCard();
    card.sizeClasses.cv_van_full_xl.addOns.deep_interior.minimumCents = 9000;
    assert.equal(quote({ selection: { ...CARGO, roof: 'high', length: 'long' }, service: 'interior_cleaning', addOns: ['deep_interior'] }, card).lines[1].cents, 9000);
  });

  it('roof price follows roof height; undercarriage with mobile water adds the water line', () => {
    assert.equal(quote({ selection: { ...CARGO, roof: 'high' }, service: 'exterior_wash', addOns: ['roof_cleaning'] }).lines[1].cents, 2600);
    assert.equal(quote({ selection: CARGO, service: 'exterior_wash', addOns: ['roof_cleaning'] }).lines[1].cents, 2000);
    const q = quote({ selection: CARGO, service: 'exterior_wash', addOns: ['undercarriage_wash'], water: 'mobile' }, withEquipment(fixtureCard()));
    assert.deepEqual(codes(q).slice(1), ['undercarriage_wash', 'mobile_water']);
  });
});

describe('engine: manual-quote fallback', () => {
  const reasonsOf = (req, card) => {
    const q = quote(req, card);
    assert.equal(q.reason, 'manual_quote', JSON.stringify(q));
    assert.equal(q.totalCents, undefined);
    return q.reviewReasons;
  };

  it('unverified dimensions and unsupported vehicles', () => {
    assert.ok(reasonsOf({ selection: { modelId: 'ford_transit', body: 'cargo_van', length: 'regular', year: 2022 }, service: 'full_detail' }).includes('configuration_incomplete'));
    assert.ok(reasonsOf({ selection: { ...CARGO, year: 2001 }, service: 'full_detail' }).includes('model_year_outside_catalog'));
    assert.ok(reasonsOf({ selection: { modelId: 'ram_promaster', body: 'cargo_van', roof: 'super_high', length: 'wb159', year: 2022 }, service: 'exterior_wash' }).includes('roof_not_confirmed_for_year'));
    assert.ok(reasonsOf({ selection: { modelId: 'other_box_truck', body: 'box_truck', boxLength: '14_to_16', year: 2022 }, service: 'full_detail' }).includes('unverified_configuration'));
    assert.ok(reasonsOf({ selection: { modelId: 'hino_box', body: 'box_truck', boxLength: '22_to_26', year: 2022 }, service: 'full_detail' }).includes('unsupported_vehicle_size'));
    assert.ok(reasonsOf({ selection: { ...BUS, busLength: '30_to_35', passengerCapacity: 28 }, service: 'full_detail' }).includes('unsupported_vehicle_size'));
    assert.ok(reasonsOf({ selection: { ...BUS, passengerCapacity: 33, wheelchairPositions: 0, busLength: '30_to_35' }, service: 'interior_cleaning' }).includes('seats_above_instant_range'));
    assert.ok(reasonsOf({ selection: { ...BUS, passengerCapacity: 20, wheelchairPositions: 6 }, service: 'interior_cleaning' }).includes('wheelchair_positions_above_instant_range'));
  });

  it('heavy contamination, biohazard, mold, grease and unknown conditions', () => {
    for (const condition of ['heavy_contamination', 'biohazard', 'mold', 'heavy_grease_or_mud']) {
      assert.ok(reasonsOf({ selection: T15, service: 'full_detail', addOns: ['deep_interior'], condition }).includes(`condition_${condition}`), condition);
    }
    assert.ok(reasonsOf({ selection: T15, service: 'full_detail', condition: 'whatever' }).includes('condition_unknown'));
    assert.ok(reasonsOf({ selection: T15, service: 'full_detail', condition: 'deep_interior' }).includes('deep_condition_without_deep_addon'));
    assert.equal(quote({ selection: T15, service: 'full_detail', addOns: ['deep_interior'], condition: 'deep_interior' }).ok, true);
  });

  it('unsafe roof access and unsupported undercarriage access', () => {
    const sh = { modelId: 'ram_promaster', body: 'cargo_van', roof: 'super_high', length: 'wb159', year: 2024 };
    assert.ok(reasonsOf({ selection: sh, service: 'exterior_wash', addOns: ['roof_cleaning'] }, withEquipment(fixtureCard())).includes('unsafe_roof_access'));
    assert.ok(reasonsOf({ selection: BUS, service: 'exterior_wash', addOns: ['roof_cleaning'] }).includes('roof_access_equipment_not_confirmed'));
    assert.ok(reasonsOf({ selection: BOX, service: 'exterior_wash', addOns: ['undercarriage_wash'] }).includes('undercarriage_access_not_supported'));
    assert.ok(reasonsOf({ selection: CARGO, service: 'exterior_wash', addOns: ['undercarriage_wash'], water: 'none' }).includes('no_water_source'));
    assert.ok(reasonsOf({ selection: CARGO, service: 'exterior_wash', addOns: ['undercarriage_wash'], water: 'mobile' }).includes('mobile_water_not_approved'));
    assert.ok(reasonsOf({ selection: CARGO, service: 'exterior_wash', addOns: ['undercarriage_wash'], runoffRestricted: true }).includes('runoff_restricted_site'));
    const ok = quote({ selection: BUS, service: 'full_detail', addOns: ['roof_cleaning', 'undercarriage_wash'] }, withEquipment(fixtureCard()));
    assert.equal(ok.ok, true, 'confirmed equipment makes tall-vehicle add-ons priceable');
  });

  it('cargo box interior is always a manual quote and never part of full detail', () => {
    const full = quote({ selection: BOX, service: 'full_detail' });
    assert.deepEqual(codes(full), ['full_detail']);
    assert.ok(reasonsOf({ selection: BOX, service: 'full_detail', addOns: ['cargo_box_interior'] }, withEquipment(fixtureCard())).includes('cargo_box_interior_manual_quote'));
  });

  it('quote-only services', () => {
    for (const service of Pricing.QUOTE_ONLY_SERVICES) assert.ok(reasonsOf({ selection: T15, service }).includes(`quote_only:${service}`));
    assert.equal(quote({ selection: T15, service: 'polish' }).reason, 'invalid_service');
  });
});

describe('engine: travel', () => {
  it('the travel charge is the existing travel-fee.js charge for the service ZIP', () => {
    for (const zip of ['07601', '11201']) { // 0 mi; 19 mi + $35 cross-Hudson surcharge
      const q = quote({ selection: T15, service: 'full_detail', zip });
      const t = Travel.resolveTravelForZip(zip);
      assert.equal(q.ok, true, zip);
      assert.equal(q.travelCents, t.fee * 100, zip);
      assert.equal(q.miles, t.miles);
      assert.equal(q.totalCents, q.servicesCents + q.travelCents);
    }
  });

  it('beyond the 30-mile commercial boundary only an approved per-class limit allows a price', () => {
    assert.equal(Pricing.COMMERCIAL_AUTO_PRICING_MAX_MILES, 30);
    assert.ok(quote({ selection: T15, service: 'full_detail', zip: '08608' }).reviewReasons.includes('beyond_auto_pricing_distance'));
    const bus = { ...BUS, wheelchairPositions: 0, passengerCapacity: 20 };
    const far = quote({ selection: bus, service: 'full_detail', zip: '08608' }); // 78 mi, limit 110
    assert.equal(far.ok, true);
    assert.equal(far.travelCents, Travel.resolveTravelForZip('08608').fee * 100);
    assert.ok(quote({ selection: bus, service: 'interior_cleaning', zip: '08608' }).reviewReasons.includes('beyond_auto_pricing_distance'));
  });

  it('missing or out-of-area ZIP returns no price', () => {
    assert.equal(Pricing.quoteCommercial({ selection: T15, service: 'full_detail' }, { rateCard: fixtureCard() }).reason, 'zip_required');
    assert.equal(quote({ selection: T15, service: 'full_detail', zip: '90210' }).reason, 'outside_service_area');
  });
});

describe('engine: activation safety', () => {
  it('a card with every amount but not approved prices nothing', () => {
    for (const o of [{ status: 'draft' }, { approvedBy: null }, { approvedAt: 'not a date' }, { version: 1 }]) {
      const q = quote({ selection: T15, service: 'full_detail' }, fixtureCard(o));
      assert.equal(q.reason, 'pricing_not_approved', JSON.stringify(o));
      assert.equal(q.totalCents, undefined);
    }
    const missing = fixtureCard();
    missing.sizeClasses.cv_box_xl.services.full_detail.cents = null;
    assert.ok(Pricing.validateRateCard(missing).problems.includes('cv_box_xl.full_detail'));
    assert.equal(quote({ selection: T15, service: 'full_detail' }, missing).reason, 'pricing_not_approved');
  });

  it('the live card is used by default and the public entry point never returns an amount', () => {
    assert.equal(Pricing.quoteCommercial({ selection: T15, service: 'full_detail', zip: '07601' }).reason, 'pricing_not_approved');
    const pub = Pricing.publicCommercialQuote({ selection: T15, service: 'full_detail', zip: '07601', rateCard: fixtureCard() });
    assert.deepEqual(pub, { ok: false, reason: 'pricing_not_approved', sizeClass: 'cv_van_full_xl' });
    assert.equal(Pricing.publicCommercialQuote.length, 1, 'no rate card parameter');
  });

  it('the live card cannot be changed at runtime', () => {
    assert.throws(() => { Pricing.ACTIVE_RATE_CARD.status = 'approved'; }, TypeError);
    assert.throws(() => { Pricing.ACTIVE_RATE_CARD.sizeClasses.cv_van_full.services.full_detail.cents = 1; }, TypeError);
    assert.equal(Pricing.commercialCheckoutEnabled(), false);
  });
});
