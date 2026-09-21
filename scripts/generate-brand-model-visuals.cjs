#!/usr/bin/env node
/**
 * Generate exact make+model → studio visual key map for booking thumbnails.
 *
 * Source: data/cars-vehicle-catalog.json + brand/body override rules below.
 * Output: assets/generated/brand-model-visuals.generated.js
 *
 * Usage:
 *   node scripts/generate-brand-model-visuals.cjs
 *   node scripts/generate-brand-model-visuals.cjs --check
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOT = path.join(ROOT, 'data/cars-vehicle-catalog.json');
const OUT = path.join(ROOT, 'assets/generated/brand-model-visuals.generated.js');
const CHECK = process.argv.includes('--check');

/** Default visual from catalog display/pricing class. */
const CLASS_DEFAULT = {
  small: 'compact_sedan',
  suv2: 'midsize_crossover',
  suv3: 'family_suv3',
  truck: 'midsize_pickup',
  minivan: 'family_minivan',
  compact_van: 'compact_van',
  midsize_van: 'midsize_van',
  full_size_van: 'cargo_van',
  full_size_van_passenger: 'passenger_van',
};

/** Luxury / premium makes — escalate sedan/SUV defaults. */
const LUXURY_MAKES = new Set([
  'Acura', 'Audi', 'BMW', 'Cadillac', 'Genesis', 'INFINITI', 'Jaguar',
  'Lexus', 'Lincoln', 'Mercedes-Benz', 'Porsche', 'Volvo', 'Land Rover',
  'Alfa Romeo', 'Maserati', 'Bentley', 'Rolls-Royce', 'Aston Martin',
]);

const EXOTIC_MAKES = new Set([
  'Ferrari', 'Lamborghini', 'McLaren', 'Bugatti', 'Pagani', 'Koenigsegg',
]);

/**
 * Exact model overrides: make → { modelLower: visualKey }
 * Checked before class defaults. Keys are lowercased model names.
 */
const MODEL_OVERRIDES = {
  Jeep: {
    wrangler: 'jeep_wrangler',
    'wrangler willys': 'jeep_wrangler',
    'wrangler rubicon': 'jeep_wrangler',
    'wrangler sahara': 'jeep_wrangler',
    'wrangler unlimited': 'jeep_wrangler',
    renegade: 'compact_crossover',
    compass: 'compact_crossover',
    cherokee: 'midsize_crossover',
    'grand cherokee': 'luxury_crossover',
    'grand cherokee l': 'family_suv3',
    wagoneer: 'fullsize_suv',
    'grand wagoneer': 'fullsize_suv',
    gladiator: 'midsize_pickup',
  },
  Acura: {
    ilx: 'compact_sedan',
    integra: 'sport_coupe',
    tlx: 'executive_sedan',
    rlx: 'executive_sedan',
    rdx: 'luxury_crossover',
    zdx: 'luxury_crossover',
    mdx: 'family_suv3',
    nsx: 'supercar',
  },
  Honda: {
    civic: 'compact_sedan',
    'civic si': 'sport_coupe',
    'civic type r': 'sport_coupe',
    accord: 'executive_sedan',
    insight: 'compact_sedan',
    fit: 'compact_sedan',
    hrv: 'compact_crossover',
    'hr-v': 'compact_crossover',
    crv: 'midsize_crossover',
    'cr-v': 'midsize_crossover',
    passport: 'midsize_crossover',
    pilot: 'family_suv3',
    odyssey: 'family_minivan',
    ridgeline: 'midsize_pickup',
    prologue: 'midsize_crossover',
  },
  Toyota: {
    corolla: 'compact_sedan',
    'corolla hatchback': 'compact_sedan',
    camry: 'executive_sedan',
    avalon: 'executive_sedan',
    prius: 'compact_sedan',
    mirai: 'executive_sedan',
    yaris: 'compact_sedan',
    cahr: 'compact_crossover',
    'c-hr': 'compact_crossover',
    corolla_cross: 'compact_crossover',
    'corolla cross': 'compact_crossover',
    rav4: 'midsize_crossover',
    'rav4 prime': 'midsize_crossover',
    venza: 'luxury_crossover',
    highlander: 'family_suv3',
    'grand highlander': 'family_suv3',
    '4runner': 'offroad',
    sequoia: 'fullsize_suv',
    'land cruiser': 'offroad',
    sienna: 'family_minivan',
    tacoma: 'midsize_pickup',
    tundra: 'pickup',
    supra: 'sport_coupe',
    'gr86': 'sport_coupe',
    'gr corolla': 'sport_coupe',
    bz4x: 'midsize_crossover',
  },
  Lexus: {
    ux: 'compact_crossover',
    nx: 'luxury_crossover',
    rx: 'luxury_crossover',
    rz: 'luxury_crossover',
    gx: 'offroad',
    lx: 'fullsize_suv',
    tx: 'family_suv3',
    is: 'executive_sedan',
    es: 'executive_sedan',
    gs: 'executive_sedan',
    ls: 'executive_sedan',
    lc: 'sport_coupe',
    rc: 'sport_coupe',
    'rc f': 'sport_coupe',
  },
  Volvo: {
    s60: 'executive_sedan',
    s90: 'executive_sedan',
    v60: 'premium_wagon',
    v90: 'premium_wagon',
    'v60 cross country': 'premium_wagon',
    'v90 cross country': 'premium_wagon',
    c40: 'luxury_crossover',
    ex30: 'compact_crossover',
    xc40: 'compact_crossover',
    xc60: 'luxury_crossover',
    xc90: 'family_suv3',
    ex90: 'family_suv3',
  },
  Ford: {
    fiesta: 'compact_sedan',
    focus: 'compact_sedan',
    fusion: 'executive_sedan',
    taurus: 'executive_sedan',
    mustang: 'sport_coupe',
    'mustang mach-e': 'midsize_crossover',
    escape: 'compact_crossover',
    edge: 'midsize_crossover',
    explorer: 'family_suv3',
    expedition: 'fullsize_suv',
    bronco: 'offroad',
    'bronco sport': 'compact_crossover',
    maverick: 'midsize_pickup',
    ranger: 'midsize_pickup',
    'f-150': 'pickup',
    'f-250 super duty': 'pickup',
    'f-350 super duty': 'pickup',
  },
  Chevrolet: {
    spark: 'compact_sedan',
    cruze: 'compact_sedan',
    malibu: 'executive_sedan',
    impala: 'executive_sedan',
    camaro: 'sport_coupe',
    corvette: 'supercar',
    trax: 'compact_crossover',
    trailblazer: 'compact_crossover',
    equinox: 'midsize_crossover',
    blazer: 'midsize_crossover',
    'blazer ev': 'midsize_crossover',
    traverse: 'family_suv3',
    tahoe: 'fullsize_suv',
    suburban: 'fullsize_suv',
    colorado: 'midsize_pickup',
    'silverado 1500': 'pickup',
    'silverado 2500hd': 'pickup',
    'silverado 3500hd': 'pickup',
    'silverado ev': 'pickup',
  },
  Subaru: {
    impreza: 'compact_sedan',
    legacy: 'executive_sedan',
    wrx: 'sport_coupe',
    brz: 'sport_coupe',
    crosstrek: 'compact_crossover',
    forester: 'midsize_crossover',
    outback: 'premium_wagon',
    ascent: 'family_suv3',
    solterra: 'midsize_crossover',
  },
  Mazda: {
    mazda3: 'compact_sedan',
    mazda6: 'executive_sedan',
    mx5: 'convertible',
    'mx-5': 'convertible',
    'mx-5 miata': 'convertible',
    cx30: 'compact_crossover',
    'cx-30': 'compact_crossover',
    cx5: 'midsize_crossover',
    'cx-5': 'midsize_crossover',
    cx50: 'midsize_crossover',
    'cx-50': 'midsize_crossover',
    cx9: 'family_suv3',
    'cx-9': 'family_suv3',
    cx90: 'family_suv3',
    'cx-90': 'family_suv3',
  },
  Nissan: {
    versa: 'compact_sedan',
    sentra: 'compact_sedan',
    altima: 'executive_sedan',
    maxima: 'executive_sedan',
    leaf: 'compact_sedan',
    z: 'sport_coupe',
    'gt-r': 'supercar',
    kicks: 'compact_crossover',
    rogue: 'midsize_crossover',
    'rogue sport': 'compact_crossover',
    murano: 'midsize_crossover',
    pathfinder: 'family_suv3',
    armada: 'fullsize_suv',
    frontier: 'midsize_pickup',
    titan: 'pickup',
    ariya: 'midsize_crossover',
  },
  Hyundai: {
    accent: 'compact_sedan',
    elantra: 'compact_sedan',
    sonata: 'executive_sedan',
    ioniq: 'compact_sedan',
    'ioniq 5': 'midsize_crossover',
    'ioniq 6': 'executive_sedan',
    venue: 'compact_crossover',
    kona: 'compact_crossover',
    tucson: 'midsize_crossover',
    'santa fe': 'midsize_crossover',
    palisade: 'family_suv3',
    'santa cruz': 'midsize_pickup',
  },
  Kia: {
    rio: 'compact_sedan',
    forte: 'compact_sedan',
    k5: 'executive_sedan',
    stinger: 'sport_coupe',
    soul: 'compact_crossover',
    seltos: 'compact_crossover',
    sportage: 'midsize_crossover',
    sorento: 'midsize_crossover',
    telluride: 'family_suv3',
    niro: 'compact_crossover',
    ev6: 'midsize_crossover',
    ev9: 'family_suv3',
    carnival: 'family_minivan',
    sedona: 'family_minivan',
  },
  BMW: {
    '2 series': 'sport_coupe',
    '3 series': 'executive_sedan',
    '4 series': 'sport_coupe',
    '5 series': 'executive_sedan',
    '7 series': 'executive_sedan',
    '8 series': 'sport_coupe',
    i4: 'executive_sedan',
    i7: 'executive_sedan',
    x1: 'compact_crossover',
    x2: 'compact_crossover',
    x3: 'luxury_crossover',
    x4: 'luxury_crossover',
    x5: 'family_suv3',
    x6: 'luxury_crossover',
    x7: 'fullsize_suv',
    ix: 'luxury_crossover',
    z4: 'convertible',
    m2: 'sport_coupe',
    m3: 'executive_sedan',
    m4: 'sport_coupe',
  },
  'Mercedes-Benz': {
    'a-class': 'compact_sedan',
    'c-class': 'executive_sedan',
    'e-class': 'executive_sedan',
    's-class': 'executive_sedan',
    cla: 'executive_sedan',
    cle: 'sport_coupe',
    cls: 'executive_sedan',
    gla: 'compact_crossover',
    glb: 'compact_crossover',
    glc: 'luxury_crossover',
    gle: 'luxury_crossover',
    gls: 'fullsize_suv',
    'g-class': 'offroad',
    eqb: 'compact_crossover',
    eqe: 'executive_sedan',
    eqs: 'executive_sedan',
    eqe_suv: 'luxury_crossover',
    'amg gt': 'supercar',
  },
  Audi: {
    a3: 'compact_sedan',
    a4: 'executive_sedan',
    a5: 'sport_coupe',
    a6: 'executive_sedan',
    a7: 'executive_sedan',
    a8: 'executive_sedan',
    e_tron: 'luxury_crossover',
    'e-tron': 'luxury_crossover',
    q3: 'compact_crossover',
    q4: 'compact_crossover',
    'q4 e-tron': 'compact_crossover',
    q5: 'luxury_crossover',
    q7: 'family_suv3',
    q8: 'luxury_crossover',
    'q8 e-tron': 'luxury_crossover',
    tt: 'sport_coupe',
    r8: 'supercar',
    rs5: 'sport_coupe',
    rs7: 'executive_sedan',
  },
  Tesla: {
    'model 3': 'executive_sedan',
    'model s': 'executive_sedan',
    'model y': 'midsize_crossover',
    'model x': 'family_suv3',
    cybertruck: 'pickup',
  },
  Porsche: {
    '718 boxster': 'convertible',
    '718 cayman': 'sport_coupe',
    '911': 'supercar',
    panamera: 'executive_sedan',
    taycan: 'executive_sedan',
    'taycan cross turismo': 'premium_wagon',
    macan: 'luxury_crossover',
    'macan electric': 'luxury_crossover',
    cayenne: 'luxury_crossover',
    'cayenne electric': 'luxury_crossover',
  },
  Ferrari: {
    roma: 'supercar',
    'roma spider': 'convertible',
    portofino: 'convertible',
    'portofino m': 'convertible',
    purosangue: 'luxury_crossover',
    '296 gtb': 'supercar',
    '296 gts': 'convertible',
    'sf90 stradale': 'supercar',
    'sf90 spider': 'convertible',
    'f8 tributo': 'supercar',
    'f8 spider': 'convertible',
    nsx: 'supercar',
  },
  Lamborghini: {
    urus: 'luxury_crossover',
    huracan: 'supercar',
    'huracán': 'supercar',
    revuelto: 'supercar',
    aventador: 'supercar',
    temerario: 'supercar',
  },
  LandRover: {},
  'Land Rover': {
    defender: 'offroad',
    discovery: 'family_suv3',
    'discovery sport': 'midsize_crossover',
    freelander: 'midsize_crossover',
    'range rover': 'fullsize_suv',
    'range rover sport': 'luxury_crossover',
    'range rover evoque': 'compact_crossover',
    'range rover velar': 'luxury_crossover',
  },
  Ram: {
    '1500': 'pickup',
    '2500': 'pickup',
    '3500': 'pickup',
    promaster: 'cargo_van',
    'promaster city': 'compact_van',
  },
  GMC: {
    terrain: 'midsize_crossover',
    acadia: 'family_suv3',
    yukon: 'fullsize_suv',
    'yukon xl': 'fullsize_suv',
    canyon: 'midsize_pickup',
    sierra: 'pickup',
    'sierra 1500': 'pickup',
    'sierra 2500hd': 'pickup',
    'sierra 3500hd': 'pickup',
    hummer: 'offroad',
  },
  Cadillac: {
    ct4: 'executive_sedan',
    ct5: 'executive_sedan',
    ct6: 'executive_sedan',
    xt4: 'compact_crossover',
    xt5: 'luxury_crossover',
    xt6: 'family_suv3',
    lyriq: 'luxury_crossover',
    escalade: 'fullsize_suv',
    'escalade esv': 'fullsize_suv',
  },
  Genesis: {
    g70: 'executive_sedan',
    g80: 'executive_sedan',
    g90: 'executive_sedan',
    gv60: 'luxury_crossover',
    gv70: 'luxury_crossover',
    gv80: 'family_suv3',
  },
  INFINITI: {
    q50: 'executive_sedan',
    q60: 'sport_coupe',
    qx50: 'luxury_crossover',
    qx55: 'luxury_crossover',
    qx60: 'family_suv3',
    qx80: 'fullsize_suv',
  },
  Lincoln: {
    corsair: 'luxury_crossover',
    nautilus: 'luxury_crossover',
    aviator: 'family_suv3',
    navigator: 'fullsize_suv',
    'navigator l': 'fullsize_suv',
    mkz: 'executive_sedan',
    mkx: 'luxury_crossover',
  },
  Volkswagen: {
    jetta: 'compact_sedan',
    golf: 'compact_sedan',
    gti: 'sport_coupe',
    passat: 'executive_sedan',
    arteon: 'executive_sedan',
    taos: 'compact_crossover',
    tiguan: 'midsize_crossover',
    atlas: 'family_suv3',
    'atlas cross sport': 'midsize_crossover',
    'id.4': 'midsize_crossover',
    'id.buzz': 'family_minivan',
  },
  Chrysler: {
    '300': 'executive_sedan',
    pacifica: 'family_minivan',
    voyager: 'family_minivan',
    'town & country': 'family_minivan',
  },
  Dodge: {
    dart: 'compact_sedan',
    charger: 'executive_sedan',
    challenger: 'sport_coupe',
    hornet: 'compact_crossover',
    durango: 'family_suv3',
    journey: 'midsize_crossover',
    'grand caravan': 'family_minivan',
  },
  Buick: {
    encore: 'compact_crossover',
    'encore gx': 'compact_crossover',
    envision: 'midsize_crossover',
    enclave: 'family_suv3',
  },
  Mitsubishi: {
    mirage: 'compact_sedan',
    'eclipse cross': 'compact_crossover',
    outlander: 'midsize_crossover',
    'outlander sport': 'compact_crossover',
    'outlander phev': 'midsize_crossover',
  },
  'Alfa Romeo': {
    giulia: 'executive_sedan',
    stelvio: 'luxury_crossover',
    tonale: 'compact_crossover',
    '4c spider': 'convertible',
  },
  Rivian: {
    r1s: 'family_suv3',
    r1t: 'midsize_pickup',
  },
  Lucid: {
    air: 'executive_sedan',
  },
  Polestar: {
    '2': 'executive_sedan',
    '3': 'luxury_crossover',
    '4': 'luxury_crossover',
  },
  MINI: {
    cooper: 'compact_sedan',
    countryman: 'compact_crossover',
    clubman: 'premium_wagon',
  },
  FIAT: {
    '500': 'compact_sedan',
    '500l': 'compact_crossover',
    '500x': 'compact_crossover',
  },
};

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function classVisual(make, displayClass, pricingClass) {
  const cls = displayClass || pricingClass || 'small';
  if (EXOTIC_MAKES.has(make)) {
    if (cls === 'suv2' || cls === 'suv3') return 'luxury_crossover';
    return 'supercar';
  }
  if (LUXURY_MAKES.has(make)) {
    if (cls === 'small') return 'executive_sedan';
    if (cls === 'suv2') return 'luxury_crossover';
    if (cls === 'suv3') return 'family_suv3';
  }
  return CLASS_DEFAULT[cls] || 'sedan';
}

function resolveVisual(vehicle) {
  const make = vehicle.make;
  const model = vehicle.model;
  const modelKey = norm(model);
  const brandMap = MODEL_OVERRIDES[make] || {};
  if (brandMap[modelKey]) return brandMap[modelKey];
  // fuzzy: model starts with override key (Grand Cherokee L → grand cherokee)
  const keys = Object.keys(brandMap).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (modelKey === k || modelKey.startsWith(k + ' ')) return brandMap[k];
  }
  return classVisual(make, vehicle.displayClass, vehicle.pricingClass);
}

function build() {
  const sot = JSON.parse(fs.readFileSync(SOT, 'utf8'));
  const byMake = {};
  let count = 0;
  for (const v of sot.vehicles || []) {
    if (v.public === false) continue;
    const make = v.make;
    const model = v.model;
    if (!byMake[make]) byMake[make] = {};
    byMake[make][model] = resolveVisual(v);
    count++;
  }
  // Also index normalized keys for runtime fuzzy lookup
  const flat = {};
  for (const [make, models] of Object.entries(byMake)) {
    for (const [model, visual] of Object.entries(models)) {
      flat[norm(make) + '|' + norm(model)] = visual;
    }
  }
  return { byMake, flat, count };
}

function serialize(data) {
  return (
    '/* AUTO-GENERATED by scripts/generate-brand-model-visuals.cjs — do not edit. */\n' +
    '/* Source: data/cars-vehicle-catalog.json + brand/body override rules. */\n' +
    '(function (root, factory) {\n' +
    '  var data = factory();\n' +
    "  if (typeof module === 'object' && module.exports) module.exports = data;\n" +
    '  if (root) root.CD1_BRAND_MODEL_VISUALS = data;\n' +
    "})(typeof globalThis !== 'undefined' ? globalThis : this, function () {\n" +
    '  return ' +
    JSON.stringify(data, null, 2) +
    ';\n' +
    '});\n'
  );
}

function main() {
  const data = build();
  const body = serialize(data);
  if (CHECK) {
    if (!fs.existsSync(OUT) || fs.readFileSync(OUT, 'utf8') !== body) {
      console.error('DRIFT: assets/generated/brand-model-visuals.generated.js');
      process.exit(1);
    }
    console.log(JSON.stringify({ check: true, models: data.count, drift: false }));
    return;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, body);
  console.log(JSON.stringify({ wrote: path.relative(ROOT, OUT), models: data.count }, null, 2));
}

main();
