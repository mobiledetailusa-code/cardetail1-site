#!/usr/bin/env node
/**
 * Bounded van taxonomy normalization for Cardetail1 Cars SoT.
 * Mutates data/cars-vehicle-catalog.json only (then run sync-vehicle-catalog.cjs).
 *
 * Sources: NHTSA vPIC GetModelsForMake / GetModelsForMakeYear samples (2026-09-12).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOT_PATH = path.join(ROOT, 'data/cars-vehicle-catalog.json');

function round5(n) {
  return Math.round(Number(n) / 5) * 5;
}

/** Minivan/suv3 base (must remain unchanged elsewhere). */
const MINIVAN = {
  wash: 155,
  maint: 215,
  interior: 235,
  full: 270,
  refresh: 405,
  premium: 540,
};

function plusPct(base, pct) {
  const out = {};
  for (const [k, v] of Object.entries(base)) out[k] = round5(v * (1 + pct));
  return out;
}

// Exported for tests / price proof docs
const VAN_PRICE_PROOF = {
  minivan: { ...MINIVAN },
  compact_van: { ...MINIVAN },
  midsize_van: { ...MINIVAN },
  full_size_van: plusPct(MINIVAN, 0.1), // cargo
  full_size_van_passenger: plusPct(MINIVAN, 0.15),
};

function upsert(sot, rec) {
  const i = sot.vehicles.findIndex((v) => v.make === rec.make && v.model === rec.model);
  if (i >= 0) sot.vehicles[i] = { ...sot.vehicles[i], ...rec };
  else sot.vehicles.push(rec);
}

function vanRec({
  make,
  model,
  vanSize,
  vanUseOptions,
  defaultVanUse,
  pricingClass,
  displayClass,
  from,
  to,
  aliases = [],
  series = [],
  public: isPublic = true,
}) {
  return {
    make,
    model,
    aliases,
    series,
    vehicleFamily: 'van',
    vanSize,
    vanUseOptions,
    defaultVanUse: defaultVanUse || vanUseOptions[0],
    years: [
      {
        from,
        to,
        class: pricingClass,
        displayClass,
        rows: null,
      },
    ],
    pricingClass,
    displayClass,
    public: isPublic,
  };
}

function main() {
  const sot = JSON.parse(fs.readFileSync(SOT_PATH, 'utf8'));

  // Schema registries
  for (const k of ['compact_van', 'midsize_van', 'full_size_van', 'full_size_van_passenger']) {
    if (!sot.pricingClasses.includes(k)) sot.pricingClasses.push(k);
    if (!sot.displayClasses.includes(k)) sot.displayClasses.push(k);
  }
  sot.vanTaxonomy = {
    sizes: ['compact', 'midsize', 'full_size'],
    uses: ['cargo', 'passenger'],
    pricing: {
      compact_van: 'minivan base (suv3)',
      midsize_van: 'minivan base (suv3)',
      full_size_van: 'minivan +10% ($5 round) — cargo',
      full_size_van_passenger: 'minivan +15% ($5 round) — passenger',
    },
    priceProof: VAN_PRICE_PROOF,
    notes:
      'Strict year validation remains OFF globally. Van year bands are populated for future enforcement.',
  };

  // --- Ford ---
  upsert(
    sot,
    vanRec({
      make: 'Ford',
      model: 'Transit',
      vanSize: 'full_size',
      vanUseOptions: ['cargo', 'passenger'],
      defaultVanUse: 'cargo',
      pricingClass: 'full_size_van',
      displayClass: 'full_size_van',
      from: 2014,
      to: 2027,
      series: ['150', '250', '350', '350HD'],
      aliases: [
        'Transit 150',
        'Transit 250',
        'Transit 350',
        'Transit 350HD',
        'T-150',
        'T-250',
        'T-350',
        'T-350HD',
        'Transit Cargo',
        'Transit Passenger',
        'Transit Van',
      ],
    })
  );
  upsert(
    sot,
    vanRec({
      make: 'Ford',
      model: 'Transit Connect',
      vanSize: 'compact',
      vanUseOptions: ['cargo', 'passenger'],
      defaultVanUse: 'cargo',
      pricingClass: 'compact_van',
      displayClass: 'compact_van',
      from: 2010,
      to: 2023,
      aliases: [
        'Transit Connect Cargo',
        'Transit Connect Passenger',
        'Transit Connect Wagon',
        'TransitConnect',
      ],
    })
  );
  upsert(
    sot,
    vanRec({
      make: 'Ford',
      model: 'E-Series',
      vanSize: 'full_size',
      vanUseOptions: ['cargo', 'passenger'],
      defaultVanUse: 'cargo',
      pricingClass: 'full_size_van',
      displayClass: 'full_size_van',
      from: 1990,
      to: 2014,
      series: ['150', '250', '350'],
      aliases: [
        'Econoline',
        'E-150',
        'E-250',
        'E-350',
        'E150',
        'E250',
        'E350',
        'E-Series Cargo',
        'E-Series Passenger',
      ],
    })
  );

  // --- Chevrolet ---
  upsert(
    sot,
    vanRec({
      make: 'Chevrolet',
      model: 'Express',
      vanSize: 'full_size',
      vanUseOptions: ['cargo', 'passenger'],
      defaultVanUse: 'cargo',
      pricingClass: 'full_size_van',
      displayClass: 'full_size_van',
      from: 1996,
      to: 2027,
      series: ['1500', '2500', '3500'],
      aliases: [
        'Express 1500',
        'Express 2500',
        'Express 3500',
        'Express Cargo',
        'Express Passenger',
        'Express Cargo Van',
        'Express Passenger Van',
      ],
    })
  );
  upsert(
    sot,
    vanRec({
      make: 'Chevrolet',
      model: 'City Express',
      vanSize: 'compact',
      vanUseOptions: ['cargo'],
      defaultVanUse: 'cargo',
      pricingClass: 'compact_van',
      displayClass: 'compact_van',
      from: 2015,
      to: 2018,
      aliases: ['CityExpress', 'Chevy City Express'],
    })
  );

  // --- GMC ---
  upsert(
    sot,
    vanRec({
      make: 'GMC',
      model: 'Savana',
      vanSize: 'full_size',
      vanUseOptions: ['cargo', 'passenger'],
      defaultVanUse: 'cargo',
      pricingClass: 'full_size_van',
      displayClass: 'full_size_van',
      from: 1996,
      to: 2027,
      series: ['1500', '2500', '3500'],
      aliases: [
        'Savana 1500',
        'Savana 2500',
        'Savana 3500',
        'Savana Cargo',
        'Savana Passenger',
      ],
    })
  );

  // --- Mercedes-Benz ---
  upsert(
    sot,
    vanRec({
      make: 'Mercedes-Benz',
      model: 'Metris',
      vanSize: 'midsize',
      vanUseOptions: ['cargo', 'passenger'],
      defaultVanUse: 'cargo',
      pricingClass: 'midsize_van',
      displayClass: 'midsize_van',
      from: 2016,
      to: 2023,
      aliases: ['Metris Cargo', 'Metris Passenger', 'Mercedes Metris'],
    })
  );
  upsert(
    sot,
    vanRec({
      make: 'Mercedes-Benz',
      model: 'Sprinter',
      vanSize: 'full_size',
      vanUseOptions: ['cargo', 'passenger'],
      defaultVanUse: 'cargo',
      pricingClass: 'full_size_van',
      displayClass: 'full_size_van',
      from: 2010,
      to: 2027,
      series: ['1500', '2500', '3500', '3500XD'],
      aliases: [
        'Sprinter 1500',
        'Sprinter 2500',
        'Sprinter 3500',
        'Sprinter 3500XD',
        'Sprinter Cargo',
        'Sprinter Passenger',
        'Mercedes Sprinter',
      ],
    })
  );

  // --- Dodge legacy Sprinter ---
  upsert(
    sot,
    vanRec({
      make: 'Dodge',
      model: 'Sprinter',
      vanSize: 'full_size',
      vanUseOptions: ['cargo', 'passenger'],
      defaultVanUse: 'cargo',
      pricingClass: 'full_size_van',
      displayClass: 'full_size_van',
      from: 2003,
      to: 2009,
      aliases: ['Dodge Sprinter Cargo', 'Dodge Sprinter Passenger'],
    })
  );

  // --- Ram ---
  upsert(
    sot,
    vanRec({
      make: 'Ram',
      model: 'ProMaster',
      vanSize: 'full_size',
      vanUseOptions: ['cargo'],
      defaultVanUse: 'cargo',
      pricingClass: 'full_size_van',
      displayClass: 'full_size_van',
      from: 2014,
      to: 2027,
      series: ['1500', '2500', '3500'],
      aliases: [
        'ProMaster 1500',
        'ProMaster 2500',
        'ProMaster 3500',
        'Promaster',
        'Ram ProMaster',
        'ProMaster Cargo',
      ],
    })
  );
  upsert(
    sot,
    vanRec({
      make: 'Ram',
      model: 'ProMaster City',
      vanSize: 'compact',
      vanUseOptions: ['cargo', 'passenger'],
      defaultVanUse: 'cargo',
      pricingClass: 'compact_van',
      displayClass: 'compact_van',
      from: 2015,
      to: 2022,
      aliases: ['Promaster City', 'ProMaster City Cargo', 'ProMaster City Passenger'],
    })
  );

  // --- Nissan ---
  upsert(
    sot,
    vanRec({
      make: 'Nissan',
      model: 'NV',
      vanSize: 'full_size',
      vanUseOptions: ['cargo', 'passenger'],
      defaultVanUse: 'cargo',
      pricingClass: 'full_size_van',
      displayClass: 'full_size_van',
      from: 2011,
      to: 2021,
      series: ['1500', '2500', '3500'],
      aliases: [
        'NV1500',
        'NV2500',
        'NV3500',
        'NV 1500',
        'NV 2500',
        'NV 3500',
        'NV Cargo',
        'NV Passenger',
        'NV Cargo Van',
        'NV Passenger Van',
      ],
    })
  );
  upsert(
    sot,
    vanRec({
      make: 'Nissan',
      model: 'NV200',
      vanSize: 'compact',
      vanUseOptions: ['cargo'],
      defaultVanUse: 'cargo',
      pricingClass: 'compact_van',
      displayClass: 'compact_van',
      from: 2013,
      to: 2021,
      aliases: ['NV 200', 'Nissan NV200 Compact Cargo'],
    })
  );

  // Fixture stays non-public but gets taxonomy fields
  const fixture = sot.vehicles.find(
    (v) => v.make === 'Fixture' && v.model === 'Full-Size Van Example'
  );
  if (fixture) {
    fixture.vehicleFamily = 'van';
    fixture.vanSize = 'full_size';
    fixture.vanUseOptions = ['cargo'];
    fixture.defaultVanUse = 'cargo';
    fixture.pricingClass = 'full_size_van';
    fixture.displayClass = 'full_size_van';
  }

  sot.vehicles.sort((a, b) => {
    const c = a.make.localeCompare(b.make);
    return c !== 0 ? c : a.model.localeCompare(b.model);
  });

  fs.writeFileSync(SOT_PATH, JSON.stringify(sot, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        vehicles: sot.vehicles.length,
        pricingClasses: sot.pricingClasses,
        displayClasses: sot.displayClasses,
        priceProof: VAN_PRICE_PROOF,
      },
      null,
      2
    )
  );
}

main();
