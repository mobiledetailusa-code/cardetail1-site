'use strict';

/**
 * Refined studio visuals: exact make+model archetypes across cars + specialty.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const icon3d = fs.readFileSync(path.join(root, 'assets/icon-3d.js'), 'utf8');
const PowersportsCatalog = require('../assets/powersports-model-catalog');
const BrandVisualsData = require('../assets/generated/brand-model-visuals.generated.js');
const BrandVisuals = require('../assets/vehicle-brand-visuals.js');

const REQUIRED = [
  'compact-sedan.webp','executive-sedan.webp','sport-coupe.webp','supercar.webp','convertible.webp',
  'premium-wagon.webp','jeep-wrangler.webp','compact-crossover.webp','midsize-crossover.webp',
  'luxury-crossover.webp','family-suv-3row.webp','family-minivan.webp','midsize-pickup.webp',
  'compact-van.webp','midsize-van.webp','cargo-van.webp','passenger-van.webp','truck.webp',
  'motorcycle.webp','cruiser.webp','sportbike.webp','adventure-bike.webp','dirtbike.webp','scooter.webp',
  'atv.webp','utv.webp','golf-cart.webp','jetski.webp',
  'runabout.webp','pontoon.webp','bass-boat.webp','cabin-cruiser.webp','sailboat.webp',
  'rv-class-a.webp','rv-class-b.webp','travel-trailer.webp','fifth-wheel.webp','airstream.webp',
];

const TIER_TO_FILE = {
  small: 'compact-sedan.webp',
  suv2: 'midsize-crossover.webp',
  suv3: 'family-suv-3row.webp',
  compact_van: 'compact-van.webp',
  midsize_van: 'midsize-van.webp',
  full_size_van: 'cargo-van.webp',
  full_size_van_passenger: 'passenger-van.webp',
  truck: 'midsize-pickup.webp',
  motorcycle: 'motorcycle.webp',
  atv: 'atv.webp',
  utv: 'utv.webp',
  jetski: 'jetski.webp',
};

function loadVisualRuntime() {
  const start = index.indexOf('const VEHICLE_VISUALS');
  const end = index.indexOf('function setVehicleVisual');
  assert.ok(start > 0 && end > start);
  const chunk =
    index.slice(start, end) +
    '\n;({VEHICLE_VISUALS,TIER_VISUAL_KEYS,MODEL_MAP,PRECISION_VISUAL_KEYS,modelMapVisual,makeVisualHint,getVehicleVisualKey});';
  const sandbox = {
    ST: { cat: 'cars', tierKey: '', vehicleLabel: '', body: null, boatType: '', rvType: '', make: '', model: '' },
    CD1_BRAND_MODEL_VISUALS: BrandVisualsData,
    CD1_VehicleBrandVisuals: BrandVisuals,
  };
  // Bind data onto BrandVisuals root expectation
  globalThis.CD1_BRAND_MODEL_VISUALS = BrandVisualsData;
  return { api: vm.runInNewContext(chunk, sandbox), ST: sandbox.ST, sandbox };
}

test('refined studio assets exist and are pairwise distinct', () => {
  const hashes = new Map();
  for (const file of REQUIRED) {
    const p = path.join(root, 'assets/vehicles/studio', file);
    assert.ok(fs.existsSync(p), `missing ${file}`);
    const buf = fs.readFileSync(p);
    assert.ok(buf.length > 1000, `${file} too small`);
    const h = crypto.createHash('md5').update(buf).digest('hex');
    assert.equal(hashes.has(h), false, `${file} duplicates ${hashes.get(h)}`);
    hashes.set(h, file);
  }
});

test('VEHICLE_VISUALS references refined studio assets', () => {
  for (const file of [
    'compact-sedan.webp','executive-sedan.webp','sport-coupe.webp','jeep-wrangler.webp',
    'compact-crossover.webp','midsize-crossover.webp','luxury-crossover.webp',
    'family-suv-3row.webp','family-minivan.webp','midsize-pickup.webp','premium-wagon.webp',
  ]) {
    assert.match(index, new RegExp(`assets/vehicles/studio/${file.replace('.', '\\.')}`));
  }
});

test('icon3dTier maps pricing tiers to refined studio renders', () => {
  assert.match(icon3d, /STUDIO_BASE/);
  for (const [tier, file] of Object.entries(TIER_TO_FILE)) {
    assert.match(icon3d, new RegExp(`${tier}:\\s*\\{[^}]*${file.replace('.', '\\.')}`));
  }
});

test('getVehicleVisualKey prefers exact brand+model before pricing tier', () => {
  const start = index.indexOf('function getVehicleVisualKey');
  const chunk = index.slice(start, start + 4200);
  assert.match(chunk, /resolveBrandModelVisual/);
  assert.match(chunk, /if\(cat==='boats'\)/);
  assert.match(chunk, /if\(cat==='rvs'\)/);
  const fleet = chunk.indexOf("if(cat==='fleet')");
  assert.ok(fleet > 0);
  const carsTail = chunk.slice(fleet);
  assert.ok(carsTail.indexOf('resolveBrandModelVisual') > 0);
  assert.ok(carsTail.indexOf('PRECISION_VISUAL_KEYS[ST.body]') > carsTail.indexOf('resolveBrandModelVisual'));
});

test('precision across categories: cars, powersports, boats, rvs', () => {
  const { api, ST } = loadVisualRuntime();
  const { getVehicleVisualKey } = api;

  ST.cat = 'cars';
  ST.tierKey = 'suv3';
  ST.vehicleLabel = '2021 Honda Odyssey';
  ST.make = 'Honda';
  ST.model = 'Odyssey';
  ST.body = null;
  assert.equal(getVehicleVisualKey(), 'family_minivan');

  ST.vehicleLabel = '2020 Ford Mustang';
  ST.make = 'Ford';
  ST.model = 'Mustang';
  ST.tierKey = 'small';
  assert.equal(getVehicleVisualKey(), 'sport_coupe');

  ST.vehicleLabel = '2022 Jeep Wrangler';
  ST.make = 'Jeep';
  ST.model = 'Wrangler';
  ST.tierKey = 'suv2';
  assert.equal(getVehicleVisualKey(), 'jeep_wrangler');

  ST.vehicleLabel = '2021 Subaru Outback';
  ST.make = 'Subaru';
  ST.model = 'Outback';
  assert.equal(getVehicleVisualKey(), 'premium_wagon');

  ST.cat = 'powersports';
  ST.make = '';
  ST.model = '';
  ST.tierKey = 'motorcycle';
  ST.vehicleLabel = '2024 Polaris RZR Turbo R';
  assert.equal(getVehicleVisualKey(), 'utv');

  ST.vehicleLabel = '2023 Harley-Davidson Street Glide';
  assert.equal(getVehicleVisualKey(), 'cruiser');

  ST.vehicleLabel = '2022 Suzuki Hayabusa';
  assert.equal(getVehicleVisualKey(), 'sportbike');

  ST.vehicleLabel = '2021 Honda CRF450R';
  assert.equal(getVehicleVisualKey(), 'dirtbike');

  ST.vehicleLabel = '2020 Vespa GTS 300';
  assert.equal(getVehicleVisualKey(), 'scooter');

  ST.vehicleLabel = '2023 Club Car Onward';
  assert.equal(getVehicleVisualKey(), 'golfcart');

  ST.cat = 'boats';
  ST.boatType = 'pontoon';
  ST.vehicleLabel = '2022 Bennington 22';
  assert.equal(getVehicleVisualKey(), 'pontoon');

  ST.boatType = 'bass';
  ST.vehicleLabel = '2021 Bass Tracker';
  assert.equal(getVehicleVisualKey(), 'bassboat');

  ST.boatType = 'cabincruiser';
  ST.vehicleLabel = '2019 Sea Ray Sundancer';
  assert.equal(getVehicleVisualKey(), 'cabincruiser');

  ST.boatType = 'other';
  ST.vehicleLabel = '2018 Catalina 22 Sailboat';
  assert.equal(getVehicleVisualKey(), 'sailboat');

  ST.cat = 'rvs';
  ST.rvType = 'airstream';
  ST.vehicleLabel = '2020 Airstream Flying Cloud';
  assert.equal(getVehicleVisualKey(), 'airstream');

  ST.rvType = 'fifthwheel';
  ST.vehicleLabel = '2021 Keystone Cougar';
  assert.equal(getVehicleVisualKey(), 'fifthwheel');

  ST.rvType = 'classa';
  ST.vehicleLabel = '2019 Winnebago Bounder';
  assert.equal(getVehicleVisualKey(), 'classa');

  ST.rvType = 'classb';
  ST.vehicleLabel = '2022 Winnebago Travato';
  assert.equal(getVehicleVisualKey(), 'classb');
});

test('exact brand+model icons: Jeep, Acura, Volvo, Toyota, Honda, Lexus', () => {
  const { api, ST } = loadVisualRuntime();
  const { getVehicleVisualKey } = api;
  ST.cat = 'cars';
  ST.body = null;

  const cases = [
    ['Jeep', 'Wrangler', 'jeep_wrangler'],
    ['Jeep', 'Renegade', 'compact_crossover'],
    ['Jeep', 'Cherokee', 'midsize_crossover'],
    ['Jeep', 'Grand Cherokee', 'luxury_crossover'],
    ['Jeep', 'Gladiator', 'midsize_pickup'],
    ['Acura', 'ILX', 'compact_sedan'],
    ['Acura', 'MDX', 'family_suv3'],
    ['Acura', 'RDX', 'luxury_crossover'],
    ['Acura', 'TLX', 'executive_sedan'],
    ['Acura', 'NSX', 'supercar'],
    ['Volvo', 'V60', 'premium_wagon'],
    ['Volvo', 'S60', 'executive_sedan'],
    ['Volvo', 'XC60', 'luxury_crossover'],
    ['Volvo', 'XC90', 'family_suv3'],
    ['Toyota', 'Corolla', 'compact_sedan'],
    ['Toyota', 'RAV4', 'midsize_crossover'],
    ['Toyota', '4Runner', 'offroad'],
    ['Toyota', 'Sienna', 'family_minivan'],
    ['Honda', 'Civic', 'compact_sedan'],
    ['Honda', 'CR-V', 'midsize_crossover'],
    ['Honda', 'Pilot', 'family_suv3'],
    ['Honda', 'Odyssey', 'family_minivan'],
    ['Lexus', 'ES', 'executive_sedan'],
    ['Lexus', 'RX', 'luxury_crossover'],
    ['Lexus', 'GX', 'offroad'],
    ['Lexus', 'LX', 'family_suv3'],
  ];

  for (const [make, model, visual] of cases) {
    ST.make = make;
    ST.model = model;
    ST.tierKey = 'suv2';
    ST.vehicleLabel = `2024 ${make} ${model}`;
    assert.equal(getVehicleVisualKey(), visual, `${make} ${model}`);
    assert.ok(api.VEHICLE_VISUALS[visual], `missing VEHICLE_VISUALS.${visual}`);
  }
});

test('brand-model generated catalog covers every public SoT vehicle', () => {
  assert.ok(BrandVisualsData.count >= 400);
  assert.equal(Object.keys(BrandVisualsData.flat).length, BrandVisualsData.count);
  const sot = JSON.parse(fs.readFileSync(path.join(root, 'data/cars-vehicle-catalog.json'), 'utf8'));
  for (const v of sot.vehicles.filter((x) => x.public !== false)) {
    const key = BrandVisuals.resolveBrandModelVisual(v.make, v.model, '');
    assert.ok(key, `missing visual for ${v.make} ${v.model}`);
  }
});

test('premium brands map to supercar / luxury crossover / executive sedan', () => {
  const { api, ST } = loadVisualRuntime();
  const { getVehicleVisualKey } = api;
  ST.cat = 'cars';
  ST.body = null;

  ST.tierKey = 'small';
  ST.make = 'Ferrari';
  ST.model = 'Roma';
  ST.vehicleLabel = '2023 Ferrari Roma';
  assert.equal(getVehicleVisualKey(), 'supercar');

  ST.model = 'Amalfi';
  ST.vehicleLabel = '2025 Ferrari Amalfi';
  assert.equal(getVehicleVisualKey(), 'supercar');

  ST.make = 'Lamborghini';
  ST.model = 'Huracán';
  ST.vehicleLabel = '2024 Lamborghini Huracan';
  assert.equal(getVehicleVisualKey(), 'supercar');

  ST.make = 'Porsche';
  ST.model = '911';
  ST.vehicleLabel = '2021 Porsche 911';
  assert.equal(getVehicleVisualKey(), 'supercar');

  ST.tierKey = 'suv2';
  ST.make = 'Ferrari';
  ST.model = 'Purosangue';
  ST.vehicleLabel = '2024 Ferrari Purosangue';
  assert.equal(getVehicleVisualKey(), 'luxury_crossover');

  ST.make = 'Lamborghini';
  ST.model = 'Urus';
  ST.vehicleLabel = '2023 Lamborghini Urus';
  assert.equal(getVehicleVisualKey(), 'luxury_crossover');

  ST.make = 'Porsche';
  ST.model = 'Cayenne';
  ST.vehicleLabel = '2022 Porsche Cayenne';
  assert.equal(getVehicleVisualKey(), 'luxury_crossover');

  ST.make = 'Aston Martin';
  ST.model = 'DBX';
  ST.vehicleLabel = '2021 Aston Martin DBX';
  assert.equal(getVehicleVisualKey(), 'luxury_crossover');

  ST.tierKey = 'small';
  ST.make = 'Porsche';
  ST.model = 'Panamera';
  ST.vehicleLabel = '2020 Porsche Panamera';
  assert.equal(getVehicleVisualKey(), 'executive_sedan');
});

test('Ram ProMaster is a van, not Ferrari Roma supercar', () => {
  const { api, ST } = loadVisualRuntime();
  ST.cat = 'cars';
  ST.tierKey = 'small';
  ST.make = 'Ram';
  ST.model = 'ProMaster City';
  ST.vehicleLabel = '2022 Ram ProMaster City';
  assert.equal(api.getVehicleVisualKey(), 'compact_van');
  ST.model = 'ProMaster';
  ST.vehicleLabel = '2021 Ram ProMaster';
  assert.equal(api.getVehicleVisualKey(), 'cargo_van');
  ST.make = 'Ferrari';
  ST.model = 'Roma';
  ST.vehicleLabel = '2023 Ferrari Roma';
  assert.equal(api.getVehicleVisualKey(), 'supercar');
});

test('Dodge Dart is in the catalog and maps to compact sedan', () => {
  assert.match(index, /"Dodge":\{m:\[[^\]]*Dart/);
  const { api, ST } = loadVisualRuntime();
  ST.cat = 'cars';
  ST.tierKey = 'small';
  ST.make = 'Dodge';
  ST.model = 'Dart';
  ST.vehicleLabel = '2015 Dodge Dart';
  assert.equal(api.getVehicleVisualKey(), 'compact_sedan');
});

test('short MODEL_MAP keys use word boundaries to avoid substring collisions', () => {
  assert.match(index, /function modelMapKeyHit/);
  assert.match(index, /key\.length >= 5/);
  assert.doesNotMatch(index, /\['star','suv-3row'\]/);
});

test('John Deere Gator is in specialty catalog and maps to UTV', () => {
  const record = PowersportsCatalog.resolve('John Deere', 'Gator XUV835M');
  assert.equal(record.serviceClass, 'utv_standard');
  assert.equal(record.physicalFamily, 'utv');
  const { api, ST } = loadVisualRuntime();
  ST.cat = 'powersports';
  ST.tierKey = 'motorcycle';
  ST.vehicleLabel = '2024 John Deere Gator XUV835M';
  assert.equal(api.getVehicleVisualKey(), 'utv');
});

test('Kubota, golf carts, and equipment expand powersports catalog', () => {
  assert.equal(PowersportsCatalog.resolve('Kubota', 'RTV-X900').serviceClass, 'utv_standard');
  assert.equal(PowersportsCatalog.resolve('Club Car', 'Onward').publicStatus, 'contact');
  assert.equal(PowersportsCatalog.resolve('E-Z-GO', 'Liberty').physicalFamily, 'golfcart');
  assert.equal(PowersportsCatalog.resolve('Bobcat', 'S70 Skid Steer').physicalFamily, 'equipment');

  const { api, ST } = loadVisualRuntime();
  ST.cat = 'powersports';
  ST.tierKey = 'motorcycle';

  ST.vehicleLabel = '2024 Kubota RTV-X900';
  assert.equal(api.getVehicleVisualKey(), 'utv');

  ST.vehicleLabel = '2023 Club Car Onward';
  assert.equal(api.getVehicleVisualKey(), 'golfcart');

  ST.vehicleLabel = '2022 Bobcat S70 Skid Steer';
  assert.equal(api.getVehicleVisualKey(), 'equipment');
});

test('powersports confirm clears stale state and resolves exact catalog metadata', () => {
  assert.match(index, /CD1PowersportsBookingSafety\.resetForIdentityChange\(ST,make,model\)/);
  assert.match(index, /CD1PowersportsBookingSafety\.resolveAndApply\(ST,PRICING\.powersports,make,model\)/);
  const inferStart = index.indexOf('function inferPowersportsTier');
  const inferChunk = index.slice(inferStart, inferStart + 500);
  assert.match(inferChunk, /CD1PowersportsCatalog\.resolve\(make,model\)/);
  assert.doesNotMatch(inferChunk, /\.test\(/);
});

test('booking pages include brand-model visual scripts', () => {
  assert.match(index, /assets\/generated\/brand-model-visuals\.generated\.js/);
  assert.match(index, /assets\/vehicle-brand-visuals\.js/);
  for (const page of ['bergen-county-hub.html', 'new-jersey-hub.html', 'template-city.html']) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    assert.match(html, /brand-model-visuals\.generated\.js/);
    assert.match(html, /vehicle-brand-visuals\.js/);
  }
});
