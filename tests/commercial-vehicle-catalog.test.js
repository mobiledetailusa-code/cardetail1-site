'use strict';

/**
 * Commercial & specialty vehicles, Phase 2A.
 *
 * - assets/commercial-vehicle-catalog.js: identification + configuration rules.
 * - netlify/lib/vehicle-inquiry.js: catalog selections are re-resolved on the server.
 * - netlify/lib/commercial-pricing.js: pricing structure, inactive (no amounts, no checkout).
 * - index.html: the catalog step of the Commercial & Specialty form (real block, in jsdom).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const CC = require('../assets/commercial-vehicle-catalog');
const CarsCatalog = require('../assets/vehicle-catalog');
const Pricing = require('../netlify/lib/commercial-pricing');
const { buildInquiryRecord, VEHICLE_CATEGORIES } = require('../netlify/lib/vehicle-inquiry');
const { PRICING, computeVehicleSubtotal } = require('../netlify/lib/booking-price-catalog');
const { validateBookingRouting } = require('../netlify/lib/booking-routing-validation');

const resolve = (sel) => CC.resolveSelection(sel);
const sizeOf = (sel) => {
  const r = resolve(sel);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.resolution.sizeClass;
};

describe('commercial catalog: required vehicles are listed', () => {
  const listed = (group, make, needle) => CC.modelsForGroup(group)
    .some((m) => m.make.includes(make) && m.model.includes(needle));

  it('commercial vans', () => {
    for (const [make, model] of [
      ['Ford', 'Transit'], ['Ford', 'Transit Connect'], ['Mercedes-Benz', 'Sprinter'], ['Mercedes-Benz', 'Metris'],
      ['Ram', 'ProMaster'], ['Ram', 'ProMaster City'], ['Chevrolet', 'Express'], ['GMC', 'Savana'], ['Nissan', 'NV'],
    ]) assert.ok(listed('commercial_van', make, model), `${make} ${model}`);
  });

  it('shuttle and passenger buses', () => {
    assert.ok(listed('shuttle_bus', 'Chevrolet / GMC', 'cutaway shuttle bus'));
    assert.ok(listed('shuttle_bus', 'Ford', 'Transit passenger van or cutaway shuttle'));
    assert.ok(listed('shuttle_bus', 'Ford', 'E-Series cutaway shuttle bus'));
    assert.ok(CC.getModel('other_shuttle_bus').needsReview);
  });

  it('box trucks', () => {
    for (const [make, model] of [
      ['Ford', 'E-Series cutaway box'], ['Ford', 'Transit cutaway box'], ['Chevrolet / GMC', 'cutaway box'],
      ['Chevrolet', 'Low Cab Forward'], ['Isuzu', 'NPR'], ['Hino', 'box'], ['Freightliner', 'M2'],
    ]) assert.ok(listed('box_truck', make, model), `${make} ${model}`);
    assert.ok(CC.getModel('other_box_truck').needsReview);
  });

  it('every model, body and option is internally consistent', () => {
    const ids = new Set();
    for (const m of CC.MODELS) {
      assert.ok(!ids.has(m.id), `duplicate ${m.id}`); ids.add(m.id);
      assert.ok(CC.GROUPS[m.group], m.id);
      assert.ok(m.bodies.length, m.id);
      for (const b of m.bodies) assert.ok(CC.BODIES[b], `${m.id}.${b}`);
      for (const r of m.roofs) assert.ok(CC.ROOFS[r], `${m.id} roof ${r}`);
      for (const l of m.lengths) assert.ok(CC.VAN_LENGTHS[l], `${m.id} length ${l}`);
      for (const l of m.busLengths) assert.ok(CC.BUS_LENGTHS[l], `${m.id} bus ${l}`);
      for (const l of m.boxLengths) assert.ok(CC.BOX_LENGTHS[l], `${m.id} box ${l}`);
      // Every body maps onto a Phase 1 inquiry category (storage, admin, alerts unchanged).
      for (const b of m.bodies) assert.ok(VEHICLE_CATEGORIES[CC.BODIES[b].inquiryCategory], b);
      if (m.bodies.includes('box_truck')) assert.ok(m.boxLengths.length, `${m.id} needs box lengths`);
      if (m.bodies.includes('shuttle_bus')) assert.ok(m.busLengths.length, `${m.id} needs bus lengths`);
    }
  });

  it('van model years come from the cars catalog, not a second table', () => {
    for (const m of CC.MODELS.filter((x) => x.cars)) {
      const rec = CarsCatalog.findVehicleRecord(m.cars[0], m.cars[1]);
      assert.ok(rec && rec.vehicle, `${m.id} must exist in the cars catalog`);
      const yr = CC.yearRange(m);
      assert.equal(yr.from, Math.min(...rec.vehicle.years.map((b) => b.from)), m.id);
      assert.equal(yr.to, Math.max(...rec.vehicle.years.map((b) => b.to)), m.id);
    }
    assert.deepEqual(CC.yearRange(CC.getModel('ford_transit_connect')), { from: 2010, to: 2023 });
    assert.deepEqual(CC.yearRange(CC.getModel('ram_promaster_city')), { from: 2015, to: 2022 });
  });
});

describe('commercial catalog: classification', () => {
  it('full-size vans size by roof and length', () => {
    assert.equal(sizeOf({ modelId: 'ford_transit', body: 'cargo_van', roof: 'low', length: 'regular' }), 'cv_van_full');
    assert.equal(sizeOf({ modelId: 'ford_transit', body: 'cargo_van', roof: 'high', length: 'regular' }), 'cv_van_full_large');
    assert.equal(sizeOf({ modelId: 'ford_transit', body: 'cargo_van', roof: 'medium', length: 'extended' }), 'cv_van_full_large');
    assert.equal(sizeOf({ modelId: 'ford_transit', body: 'passenger_van', roof: 'high', length: 'extended', passengerCapacity: 15 }), 'cv_van_full_xl');
    assert.equal(sizeOf({ modelId: 'mercedes_sprinter', body: 'cargo_van', roof: 'high', length: 'wb170ext' }), 'cv_van_full_xl');
    assert.equal(sizeOf({ modelId: 'mercedes_sprinter', body: 'cargo_van', roof: 'standard', length: 'wb144' }), 'cv_van_full');
    assert.equal(sizeOf({ modelId: 'chevrolet_express', body: 'passenger_van', length: 'wb155', passengerCapacity: 15 }), 'cv_van_full_large');
    assert.equal(sizeOf({ modelId: 'nissan_nv', body: 'cargo_van', roof: 'high' }), 'cv_van_full_large');
  });

  it('Ford Transit long wheelbase counts as long (regression)', () => {
    const transit = (roof, length, modelId = 'ford_transit', body = 'cargo_van') => sizeOf({ modelId, body, roof, length });
    assert.equal(transit('low', 'regular'), 'cv_van_full');
    assert.equal(transit('medium', 'regular'), 'cv_van_full');
    assert.equal(transit('low', 'long'), 'cv_van_full_large');
    assert.equal(transit('medium', 'long'), 'cv_van_full_large');
    assert.equal(transit('high', 'long'), 'cv_van_full_xl');
    assert.equal(transit('high', 'regular'), 'cv_van_full_large');
    // Extended configurations are unchanged.
    assert.equal(transit('low', 'extended'), 'cv_van_full_large');
    assert.equal(transit('high', 'extended'), 'cv_van_full_xl');
    // The Transit entry under shuttle / passenger buses classifies the same way.
    assert.equal(sizeOf({ modelId: 'ford_transit_shuttle', body: 'passenger_van', roof: 'low', length: 'long', passengerCapacity: 12 }), 'cv_van_full_large');
    assert.equal(sizeOf({ modelId: 'ford_transit_shuttle', body: 'passenger_van', roof: 'high', length: 'long', passengerCapacity: 15 }), 'cv_van_full_xl');
  });

  it('other models keep their classification', () => {
    assert.equal(sizeOf({ modelId: 'mercedes_sprinter', body: 'cargo_van', roof: 'standard', length: 'wb144' }), 'cv_van_full');
    assert.equal(sizeOf({ modelId: 'mercedes_sprinter', body: 'cargo_van', roof: 'standard', length: 'wb170' }), 'cv_van_full_large');
    assert.equal(sizeOf({ modelId: 'ram_promaster', body: 'cargo_van', roof: 'standard', length: 'wb136' }), 'cv_van_full');
    assert.equal(sizeOf({ modelId: 'ram_promaster', body: 'cargo_van', roof: 'high', length: 'wb159' }), 'cv_van_full_xl');
    assert.equal(sizeOf({ modelId: 'chevrolet_express', body: 'cargo_van', length: 'wb135' }), 'cv_van_full');
    assert.equal(sizeOf({ modelId: 'gmc_savana', body: 'cargo_van', length: 'wb155' }), 'cv_van_full_large');
    assert.equal(sizeOf({ modelId: 'nissan_nv', body: 'cargo_van', roof: 'standard' }), 'cv_van_full');
    assert.equal(sizeOf({ modelId: 'ford_transit_connect', body: 'cargo_van', length: 'lwb' }), 'cv_van_compact');
  });

  it('compact and midsize vans have one size each', () => {
    assert.equal(sizeOf({ modelId: 'ford_transit_connect', body: 'cargo_van', length: 'lwb' }), 'cv_van_compact');
    assert.equal(sizeOf({ modelId: 'ram_promaster_city', body: 'passenger_van', passengerCapacity: 5 }), 'cv_van_compact');
    assert.equal(sizeOf({ modelId: 'nissan_nv200', body: 'cargo_van' }), 'cv_van_compact');
    assert.equal(sizeOf({ modelId: 'mercedes_metris', body: 'passenger_van', passengerCapacity: 8 }), 'cv_van_midsize');
  });

  it('buses size by length class, box trucks by box length', () => {
    assert.equal(sizeOf({ modelId: 'ford_eseries_cutaway_bus', body: 'shuttle_bus', busLength: '25_to_29', passengerCapacity: 24, wheelchairPositions: 2 }), 'cv_shuttle_medium');
    assert.equal(sizeOf({ modelId: 'chevrolet_gmc_cutaway_bus', body: 'shuttle_bus', busLength: '30_to_35', passengerCapacity: 33 }), 'cv_shuttle_large');
    assert.equal(sizeOf({ modelId: 'ford_transit_shuttle', body: 'shuttle_bus', busLength: 'up_to_24', passengerCapacity: 14 }), 'cv_shuttle_small');
    assert.equal(sizeOf({ modelId: 'isuzu_n_series', body: 'box_truck', boxLength: '18_to_20' }), 'cv_box_large');
    assert.equal(sizeOf({ modelId: 'ford_eseries_cutaway_box', body: 'box_truck', boxLength: '14_to_16' }), 'cv_box_medium');
    assert.equal(sizeOf({ modelId: 'freightliner_m2_box', body: 'box_truck', boxLength: '22_to_26' }), 'cv_box_xl');
  });

  it('bodies map to the Phase 1 inquiry category', () => {
    const cat = (sel) => resolve(sel).resolution.inquiryCategory;
    assert.equal(cat({ modelId: 'ford_transit', body: 'crew_van' }), 'cargo_van');
    assert.equal(cat({ modelId: 'ford_transit', body: 'wheelchair_van', passengerCapacity: 8, wheelchairPositions: 2 }), 'paratransit');
    assert.equal(cat({ modelId: 'ford_eseries_cutaway_bus', body: 'shuttle_bus', busLength: 'up_to_24', passengerCapacity: 12 }), 'shuttle_bus');
    assert.equal(cat({ modelId: 'hino_box', body: 'box_truck', boxLength: '14_to_16' }), 'box_truck');
  });
});

describe('commercial catalog: configuration validation', () => {
  const errs = (sel) => resolve(sel).errors;

  it('rejects configurations a model was not built with', () => {
    assert.deepEqual(errs({ modelId: 'ram_promaster', body: 'passenger_van', passengerCapacity: 12 }), ['body']);
    assert.deepEqual(errs({ modelId: 'chevrolet_express', body: 'cargo_van', roof: 'high' }).length, 0, 'roof is not asked for Express: dropped, not an error');
    assert.deepEqual(errs({ modelId: 'ford_transit', body: 'cargo_van', roof: 'super_high' }), ['roof']);
    assert.deepEqual(errs({ modelId: 'ford_transit', body: 'cargo_van', length: 'wb170' }), ['length']);
    assert.deepEqual(errs({ modelId: 'isuzu_n_series', body: 'box_truck', boxLength: '22_to_26' }), ['boxLength']);
    assert.deepEqual(errs({ modelId: 'ford_eseries_cutaway_box', body: 'shuttle_bus' }), ['body']);
  });

  it('enforces seat and wheelchair bounds', () => {
    assert.deepEqual(errs({ modelId: 'ford_transit_connect', body: 'passenger_van', passengerCapacity: 8 }), ['passengerCapacity']);
    assert.deepEqual(errs({ modelId: 'mercedes_metris', body: 'passenger_van', passengerCapacity: 9 }), ['passengerCapacity']);
    assert.deepEqual(errs({ modelId: 'ford_transit', body: 'passenger_van', passengerCapacity: 16 }), ['passengerCapacity']);
    assert.deepEqual(errs({ modelId: 'ford_transit', body: 'passenger_van' }), ['passengerCapacity'], 'seats are required for passenger vans');
    assert.deepEqual(errs({ modelId: 'ford_eseries_cutaway_bus', body: 'shuttle_bus', busLength: 'up_to_24', passengerCapacity: 6, wheelchairPositions: 7 }), ['wheelchairPositions']);
    assert.deepEqual(errs({ modelId: 'ford_eseries_cutaway_bus', body: 'shuttle_bus', busLength: 'up_to_24', passengerCapacity: 'twelve' }), ['passengerCapacity']);
  });

  it('requires the length class for upfitted bodies', () => {
    assert.deepEqual(errs({ modelId: 'isuzu_n_series', body: 'box_truck' }), ['boxLength']);
    assert.deepEqual(errs({ modelId: 'chevrolet_gmc_cutaway_bus', body: 'shuttle_bus', passengerCapacity: 20 }), ['busLength']);
  });

  it('only asks for fields relevant to the vehicle, and drops the rest', () => {
    assert.deepEqual(CC.fieldsFor(CC.getModel('isuzu_n_series'), 'box_truck'), ['boxLength']);
    assert.deepEqual(CC.fieldsFor(CC.getModel('ford_transit'), 'cargo_van'), ['roof', 'length']);
    assert.deepEqual(CC.fieldsFor(CC.getModel('ford_transit'), 'passenger_van'), ['roof', 'length', 'passengerCapacity']);
    assert.deepEqual(CC.fieldsFor(CC.getModel('mercedes_metris'), 'cargo_van'), []);
    assert.deepEqual(CC.fieldsFor(CC.getModel('chevrolet_express'), 'wheelchair_van'), ['length', 'passengerCapacity', 'wheelchairPositions']);
    const r = resolve({ modelId: 'isuzu_n_series', body: 'box_truck', boxLength: '14_to_16', roof: 'high', passengerCapacity: 40, wheelchairPositions: 3, lengthFt: 60 });
    assert.deepEqual(r.resolution.configuration, { boxLength: '14_to_16' });
  });
});

describe('commercial catalog: unknown and unverified vehicles fall back to a manual quote', () => {
  it('an unknown model id is rejected (the form offers "My model isn’t listed" instead)', () => {
    assert.deepEqual(resolve({ modelId: 'tesla_semi', body: 'box_truck' }).errors, ['modelId']);
    assert.deepEqual(resolve(null).errors, ['modelId']);
  });

  it('"Other" models are stored for review with no size class', () => {
    const r = resolve({ modelId: 'other_box_truck', body: 'box_truck', boxLength: '14_to_16' }).resolution;
    assert.equal(r.sizeClass, null);
    assert.equal(r.status, 'needs_review');
    assert.deepEqual(r.reviewReasons, ['model_not_listed']);
  });

  it('a model year outside the catalog range needs review', () => {
    const r = resolve({ modelId: 'ford_transit_connect', body: 'cargo_van', length: 'swb', year: 2026 }).resolution;
    assert.equal(r.yearStatus, 'out_of_range');
    assert.equal(r.sizeClass, null);
    assert.deepEqual(r.reviewReasons, ['model_year_outside_catalog']);
  });

  it('a roof that was not sold in that year needs review', () => {
    const early = resolve({ modelId: 'ram_promaster', body: 'cargo_van', roof: 'super_high', length: 'wb159ext', year: 2020 }).resolution;
    assert.equal(early.sizeClass, null);
    assert.deepEqual(early.reviewReasons, ['roof_not_confirmed_for_year']);
    const later = resolve({ modelId: 'ram_promaster', body: 'cargo_van', roof: 'super_high', length: 'wb159ext', year: 2024 }).resolution;
    assert.equal(later.sizeClass, 'cv_van_full_xl');
  });

  it('"Not sure" roof or length on a full-size van needs review', () => {
    const r = resolve({ modelId: 'mercedes_sprinter', body: 'cargo_van', roof: 'high' }).resolution;
    assert.equal(r.sizeClass, null);
    assert.deepEqual(r.reviewReasons, ['configuration_incomplete']);
  });
});

const QUOTE = {
  name: 'Dana Fleet', phone: '(201) 555-0142', zip: '07601', source: 'Booking - commercial & specialty',
  vehicle: {
    category: 'cargo_van', year: '2022', make: 'Typed', model: 'Wrong',
    services: ['full_detail'], extras: ['roof_cleaning'],
    catalog: { modelId: 'mercedes_sprinter', body: 'passenger_van', roof: 'high', length: 'wb170', passengerCapacity: 12 },
  },
};
const clone = (o) => JSON.parse(JSON.stringify(o));

describe('server: catalog selections in quote requests', () => {
  it('stores the catalog identity and a server-derived size class', () => {
    const built = buildInquiryRecord(clone(QUOTE));
    assert.equal(built.ok, true, JSON.stringify(built.fields));
    const v = built.record.vehicle;
    assert.equal(v.category, 'passenger_van', 'category comes from the catalog body, not the browser');
    assert.equal(v.make, 'Mercedes-Benz');
    assert.equal(v.model, 'Sprinter');
    assert.equal(v.passengerCapacity, 12);
    assert.equal(v.catalog.sizeClass, 'cv_van_full_xl');
    assert.equal(v.catalog.status, 'identified');
    assert.match(built.record.message, /Configuration: Passenger van, High roof, 170 in\. wheelbase, 12 passengers/);
  });

  it('ignores client-supplied size class, tier, dimensions and prices', () => {
    const body = clone(QUOTE);
    Object.assign(body.vehicle, { tierKey: 'small', lengthFt: 12, price: 1, basePrice: 1 });
    Object.assign(body.vehicle.catalog, { sizeClass: 'cv_van_compact', tierKey: 'small', price: 1, lengthFt: 12, inquiryCategory: 'car_suv' });
    Object.assign(body, { price: 1, totalPrice: 1, tierKey: 'small' });
    const built = buildInquiryRecord(body);
    assert.equal(built.ok, true);
    const json = JSON.stringify(built.record);
    for (const k of ['tierKey', 'price', 'basePrice', 'totalPrice', 'lengthFt', 'inquiryCategory']) {
      assert.ok(!json.includes(`"${k}"`), `${k} must not be stored`);
    }
    assert.equal(built.record.vehicle.catalog.sizeClass, 'cv_van_full_xl');
  });

  it('rejects an invalid catalog selection with field errors', () => {
    const bad = clone(QUOTE);
    bad.vehicle.catalog.passengerCapacity = 40;
    assert.deepEqual(buildInquiryRecord(bad).fields, ['catalog.passengerCapacity']);
    bad.vehicle.catalog = { modelId: 'nope' };
    assert.deepEqual(buildInquiryRecord(bad).fields, ['catalog.modelId']);
    bad.vehicle.catalog = ['x'];
    assert.deepEqual(buildInquiryRecord(bad).fields, ['catalog']);
  });

  it('an "Other" model keeps the customer’s typed make and model', () => {
    const body = clone(QUOTE);
    body.vehicle.make = 'Kia'; body.vehicle.model = 'K3500';
    body.vehicle.catalog = { modelId: 'other_box_truck', body: 'box_truck', boxLength: '14_to_16' };
    const v = buildInquiryRecord(body).record.vehicle;
    assert.equal(v.category, 'box_truck');
    assert.equal(`${v.make} ${v.model}`, 'Kia K3500');
    assert.equal(v.catalog.sizeClass, null);
  });

  it('manual (unlisted) requests are unchanged from Phase 1', () => {
    const body = clone(QUOTE);
    delete body.vehicle.catalog;
    body.vehicle.category = 'box_truck'; body.vehicle.lengthFt = 16;
    const v = buildInquiryRecord(body).record.vehicle;
    assert.equal(v.catalog, undefined);
    assert.equal(v.lengthFt, 16);
    assert.equal(v.make, 'Typed');
  });
});

// Engine behaviour (base services, add-ons, configuration, travel, manual quotes) is
// covered in tests/commercial-pricing-engine.test.js. Here: the live card stays inactive.
describe('pricing foundation: inactive until approved', () => {
  it('the live rate card is a draft with no amounts', () => {
    const card = Pricing.ACTIVE_RATE_CARD;
    assert.equal(card.status, 'draft');
    assert.equal(card.approvedBy, null);
    assert.equal(card.approvedAt, null);
    assert.deepEqual(Object.keys(card.sizeClasses).sort(), [...CC.SIZE_CLASSES].sort());
    const amounts = JSON.stringify(card).match(/":\s*\d+/g) || [];
    assert.deepEqual(amounts, ['":2'], 'only the version number is numeric');
    assert.equal(Pricing.validateRateCard(card).approved, false);
    assert.ok(Object.isFrozen(card) && Object.isFrozen(card.sizeClasses.cv_van_full.services.full_detail));
  });

  it('no commercial checkout or public price: constants off, and every configuration is refused a price', () => {
    assert.equal(Pricing.COMMERCIAL_CHECKOUT_ENABLED, false);
    assert.equal(Pricing.COMMERCIAL_PUBLIC_PRICING_ENABLED, false);
    assert.equal(Pricing.commercialCheckoutEnabled(), false);
    for (const m of CC.MODELS) {
      for (const body of m.bodies) {
        const sel = { modelId: m.id, body, roof: m.roofs[0], length: m.lengths[0], busLength: m.busLengths[0], boxLength: m.boxLengths[0], passengerCapacity: 4, wheelchairPositions: 1 };
        for (const service of Pricing.SERVICES) {
          const q = Pricing.quoteCommercial({ selection: sel, service, zip: '07601' });
          assert.equal(q.ok, false, `${m.id}/${body}/${service}`);
          assert.ok(['pricing_not_approved', 'manual_quote'].includes(q.reason), `${m.id}/${body}: ${q.reason}`);
          assert.equal(q.totalCents, undefined);
          const pub = Pricing.publicCommercialQuote({ selection: sel, service, zip: '07601' });
          assert.equal(pub.ok, false);
          assert.equal(JSON.stringify(pub).match(/cents/i), null, 'public result carries no amount');
        }
      }
    }
  });
});

describe('no commercial vehicle receives passenger-car or pickup pricing', () => {
  it('commercial size classes are separate from cars / trucks / fleet tiers', () => {
    for (const cat of Object.keys(PRICING)) {
      for (const tier of Object.keys(PRICING[cat].tiers || {})) {
        assert.ok(!CC.SIZE_CLASSES.includes(tier), `${cat}.${tier} collides with a commercial size class`);
      }
    }
  });

  it('a commercial size class cannot be priced by the booking catalog in any category', () => {
    for (const sizeClass of CC.SIZE_CLASSES) {
      for (const cat of ['cars', 'trucks', 'fleet', 'commercial']) {
        const vehicle = { cat, pkgId: cat === 'trucks' ? 'interior' : 'full', tierKey: sizeClass, addons: [], make: 'Isuzu', model: 'NPR' };
        const r = computeVehicleSubtotal(vehicle, '07601', { vehicles: [vehicle] }, { catalogTierMode: 'require_identity' });
        assert.equal(r.ok, false, `${cat}/${sizeClass}`);
      }
    }
  });

  it('commercial-only bodies are not in the cars catalog', () => {
    for (const [make, model] of [['Isuzu', 'NPR'], ['Hino', '195'], ['Freightliner', 'M2 106'], ['Mitsubishi Fuso', 'FE']]) {
      assert.equal(CarsCatalog.resolveVehicle({ make, model }).tierKey, null, `${make} ${model}`);
    }
  });

  it('existing cars and pickup prices are unchanged', () => {
    const PKGS = ['label', 'wash', 'maint', 'interior', 'full', 'refresh', 'premium'];
    const tier = (k) => Object.fromEntries(PKGS.map((p) => [p, PRICING.cars.tiers[k][p]]));
    assert.deepEqual(tier('full_size_van'), { label: 'Full-Size Cargo Van', wash: 185, maint: 255, interior: 285, full: 335, refresh: 470, premium: 625 });
    assert.deepEqual(tier('full_size_van_passenger'), { label: 'Full-Size Passenger Van', wash: 195, maint: 265, interior: 300, full: 350, refresh: 490, premium: 650 });
    assert.deepEqual(tier('truck'), { label: 'Truck', wash: 165, maint: 225, interior: 255, full: 300, refresh: 420, premium: 555 });
    assert.deepEqual(tier('compact_van'), { label: 'Compact Van', wash: 165, maint: 225, interior: 255, full: 300, refresh: 430, premium: 570 });
  });

  it('the pricing foundation is not wired into any function, checkout or payment code', () => {
    const src = fs.readFileSync(path.join(ROOT, 'netlify/lib/commercial-pricing.js'), 'utf8');
    // Only read-only libraries: the catalogs, travel-fee and the Cars price table. No payment or booking functions.
    assert.doesNotMatch(src, /require\([^)]*(stripe|square|payment|checkout|submit-booking|create-payment)/i);
    for (const lib of ['commercial-pricing', 'vehicle-pricing-channel']) {
      for (const dir of ['netlify/functions', 'netlify/lib']) {
        for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((x) => x.endsWith('.js'))) {
          if (f === 'commercial-pricing.js' || f === `${lib}.js`) continue;
          assert.doesNotMatch(fs.readFileSync(path.join(ROOT, dir, f), 'utf8'), new RegExp(`require\\([^)]*${lib}`), `${dir}/${f} must not use ${lib} yet`);
        }
      }
    }
    const fnDir = path.join(ROOT, 'netlify/functions');
    for (const f of fs.readdirSync(fnDir).filter((x) => x.endsWith('.js'))) {
      assert.doesNotMatch(fs.readFileSync(path.join(fnDir, f), 'utf8'), /commercial-pricing/, f);
    }
    const inquiry = fs.readFileSync(path.join(ROOT, 'netlify/lib/vehicle-inquiry.js'), 'utf8');
    assert.doesNotMatch(inquiry, /commercial-pricing|booking-price-catalog|stripe|square/i);
  });

  it('fleet / commercial bookings are still routed to a quote', () => {
    assert.equal(validateBookingRouting({ zipCode: '07601', vehicles: [{ cat: 'fleet', units: 3 }] }).error, 'fleet_quote_required');
    assert.equal(validateBookingRouting({ zipCode: '07601', vehicles: [{ cat: 'cars' }], isCommercial: true }).ok, false);
  });
});

// ── browser: the real Commercial & Specialty block from index.html ─────────────
const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
function slice(startMarker, endMarker) {
  const start = index.indexOf(startMarker);
  const end = index.indexOf(endMarker, start);
  assert.ok(start > 0 && end > start, `block not found: ${startMarker}`);
  return index.slice(start, end);
}

function makeSandbox({ withCatalog = true } = {}) {
  const markup = slice('<!-- Commercial & specialty vehicles', '<div id="cd-chat">');
  const code = slice('// ── COMMERCIAL & SPECIALTY', 'function launchBooking(');
  const dom = new JSDOM(`<!DOCTYPE html><body><input id="bk-zip" value="07601"><div id="bk-ov" class="open"></div>${markup}</body>`,
    { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window;
  const calls = { fetch: [] };
  Object.assign(w, {
    INQUIRY_URL: '/.netlify/functions/submit-inquiry',
    ADMIN_SMS: '+15513893986',
    ST: {},
    forceCloseBooking() {},
    cdToggle() { throw new Error('chat should not open'); },
    fetch: async (url, init) => { calls.fetch.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ ok: true, id: 'INQ-X', status: 'sent' }) }; },
  });
  if (withCatalog) {
    // Same load order as the page: cars catalog bundle, cars runtime, commercial catalog.
    for (const f of ['assets/generated/cars-vehicle-catalog.generated.js', 'assets/vehicle-catalog.js', 'assets/commercial-vehicle-catalog.js']) {
      w.eval(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    }
  }
  w.eval(code);
  const doc = w.document;
  const set = (id, v) => { doc.getElementById(id).value = v; };
  const pick = (id, v, fn) => { set(id, v); w[fn](); };
  const check = (value) => { doc.querySelector(`input[value="${value}"]`).checked = true; };
  const shown = (attr) => [...doc.querySelectorAll(`[${attr}]`)].filter((el) => !el.hidden).map((el) => el.getAttribute(attr));
  const status = () => doc.getElementById('cs-status').textContent;
  const submitForm = () => w.submitCommercialForm({ preventDefault() {} });
  return { w, doc, calls, set, pick, check, shown, status, submitForm };
}

describe('Commercial & Specialty form: catalog step (index.html)', () => {
  it('the page loads the commercial catalog after the cars catalog', () => {
    const cars = index.indexOf('<script src="assets/vehicle-catalog.js"></script>');
    const commercial = index.indexOf('<script src="assets/commercial-vehicle-catalog.js"></script>');
    assert.ok(cars > 0 && commercial > cars);
  });

  it('starts with the vehicle kind; the manual type list is hidden', () => {
    const sb = makeSandbox();
    sb.w.openCommercialInquiry();
    assert.equal(sb.doc.getElementById('cs-identify').hidden, false);
    assert.equal(sb.doc.getElementById('cs-category-wrap').hidden, true);
    assert.deepEqual(sb.shown('data-cs-cat'), []);
    assert.deepEqual(sb.shown('data-cs-text'), []);
  });

  it('lists only the models of the chosen kind, plus "not listed"', () => {
    const sb = makeSandbox();
    sb.pick('cs-group', 'box_truck', 'csGroupChanged');
    const opts = [...sb.doc.querySelectorAll('#cs-model-id option')].map((o) => o.value).filter(Boolean);
    assert.deepEqual(opts, [...CC.modelsForGroup('box_truck').map((m) => m.id), 'unlisted']);
    assert.ok(!opts.includes('ford_transit'));
  });

  it('asks only the questions that apply to each vehicle', () => {
    const sb = makeSandbox();
    sb.pick('cs-group', 'box_truck', 'csGroupChanged');
    sb.pick('cs-model-id', 'isuzu_n_series', 'csModelChanged');
    assert.equal(sb.doc.getElementById('cs-body').value, 'box_truck', 'single configuration is preselected');
    assert.deepEqual(sb.shown('data-cs-cat'), ['model', 'body', 'boxLength']);
    assert.deepEqual(sb.shown('data-cs-field'), []);

    sb.pick('cs-group', 'commercial_van', 'csGroupChanged');
    sb.pick('cs-model-id', 'ford_transit', 'csModelChanged');
    sb.pick('cs-body', 'passenger_van', 'csBodyChanged');
    assert.deepEqual(sb.shown('data-cs-cat'), ['model', 'body', 'roof', 'length']);
    assert.deepEqual(sb.shown('data-cs-field'), ['passengerCapacity']);
    assert.equal(sb.doc.getElementById('cs-year').placeholder, '2014–2027');

    sb.pick('cs-body', 'wheelchair_van', 'csBodyChanged');
    assert.deepEqual(sb.shown('data-cs-field'), ['passengerCapacity', 'wheelchairSpaces']);
    sb.pick('cs-model-id', 'mercedes_metris', 'csModelChanged');
    sb.pick('cs-body', 'cargo_van', 'csBodyChanged');
    assert.deepEqual(sb.shown('data-cs-cat'), ['model', 'body']);
    assert.deepEqual(sb.shown('data-cs-field'), []);
  });

  it('sends the catalog selection, no price, and the server accepts it', async () => {
    const sb = makeSandbox();
    sb.w.openCommercialInquiry();
    await sb.submitForm();
    assert.match(sb.status(), /vehicle type/);
    sb.pick('cs-group', 'shuttle_bus', 'csGroupChanged');
    await sb.submitForm();
    assert.match(sb.status(), /model/);
    sb.pick('cs-model-id', 'ford_eseries_cutaway_bus', 'csModelChanged');
    sb.set('cs-capacity', '24'); sb.set('cs-wheelchair', '2');
    await sb.submitForm();
    assert.match(sb.status(), /bus length/);
    sb.set('cs-buslength', '25_to_29');
    sb.set('cs-capacity', '45');
    await sb.submitForm();
    assert.match(sb.status(), /1 to 40/);
    sb.set('cs-capacity', '24');
    sb.check('interior_cleaning'); sb.check('roof_cleaning');
    sb.set('cs-name', 'Lee'); sb.set('cs-phone', '(201) 555-0150'); sb.set('cs-year', '2019');
    await sb.submitForm();
    assert.equal(sb.calls.fetch.length, 1);
    const { body } = sb.calls.fetch[0];
    assert.deepEqual(body.vehicle, {
      category: 'shuttle_bus', year: '2019', make: 'Ford', model: 'E-Series cutaway shuttle bus (E-350 / E-450)',
      catalog: { modelId: 'ford_eseries_cutaway_bus', body: 'shuttle_bus', busLength: '25_to_29', passengerCapacity: 24, wheelchairPositions: 2 },
      services: ['interior_cleaning'], extras: ['roof_cleaning'], notes: '',
    });
    for (const k of ['price', 'tierKey', 'basePrice', 'total', 'sizeClass']) {
      assert.equal(body[k], undefined, k);
      assert.equal(body.vehicle.catalog[k], undefined, k);
    }
    const built = buildInquiryRecord(body);
    assert.equal(built.ok, true, JSON.stringify(built.fields));
    assert.equal(built.record.vehicle.catalog.sizeClass, 'cv_shuttle_medium');
    assert.equal(built.record.vehicle.wheelchairSpaces, 2);
    assert.match(sb.status(), /Nothing has been booked or charged/);
  });

  it('"My model isn’t listed" falls back to the Phase 1 manual form', async () => {
    const sb = makeSandbox();
    sb.pick('cs-group', 'box_truck', 'csGroupChanged');
    sb.pick('cs-model-id', 'unlisted', 'csModelChanged');
    assert.equal(sb.doc.getElementById('cs-category-wrap').hidden, false);
    assert.equal(sb.doc.getElementById('cs-category').value, 'box_truck', 'type preselected from the kind');
    assert.deepEqual(sb.shown('data-cs-text'), ['make', 'model']);
    assert.deepEqual(sb.shown('data-cs-field'), ['lengthFt']);
    sb.set('cs-make', 'Kenworth'); sb.set('cs-model', 'T270'); sb.set('cs-length', '24');
    sb.check('exterior_wash'); sb.set('cs-name', 'Lee'); sb.set('cs-phone', '2015550150');
    await sb.submitForm();
    const { body } = sb.calls.fetch[0];
    assert.equal(body.vehicle.catalog, undefined);
    assert.equal(body.vehicle.lengthFt, 24);
    assert.equal(buildInquiryRecord(body).ok, true);
  });

  it('"Something else" (school bus, motorcoach…) uses the manual form', () => {
    const sb = makeSandbox();
    sb.pick('cs-group', 'other', 'csGroupChanged');
    assert.equal(sb.doc.getElementById('cs-category-wrap').hidden, false);
    assert.deepEqual(sb.shown('data-cs-cat'), []);
  });

  it('without the catalog script the form is exactly the Phase 1 form', () => {
    const sb = makeSandbox({ withCatalog: false });
    sb.w.openCommercialInquiry();
    assert.equal(sb.doc.getElementById('cs-identify').hidden, true);
    assert.equal(sb.doc.getElementById('cs-category-wrap').hidden, false);
  });
});

it('the Commercial & Specialty form no longer offers Undercarriage wash (service suspended)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const extras = html.slice(html.indexOf('id="cs-extras"'), html.indexOf('</div>', html.indexOf('id="cs-extras"')));
  assert.match(extras, /value="roof_cleaning"/);
  assert.doesNotMatch(extras, /undercarriage/i);
  assert.doesNotMatch(html, /value="undercarriage_wash"/);
});
