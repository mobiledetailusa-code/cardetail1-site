'use strict';
/**
 * Cardetail1 Cars vehicle catalog runtime (Phase 1 foundation).
 *
 * Canonical data: data/cars-vehicle-catalog.json
 * Generated browser bundle: assets/generated/cars-vehicle-catalog.generated.js
 *
 * Responsibilities:
 *  - alias → canonical model
 *  - year-band lookup (year-aware schema)
 *  - pricingClass vs displayClass
 *  - legacy MODELS/MAKES projection for booking pages
 *
 * Package prices stay in booking-price-catalog / page PRICING.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CD1VehicleCatalog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DISPLAY = {
    small: { label: 'Small Car', rows: null },
    suv2: { label: '2-Row SUV', rows: 2 },
    suv3: { label: '3-Row SUV', rows: 3 },
    truck: { label: 'Truck', rows: null },
    minivan: { label: 'Minivan', rows: 3 },
    // Van taxonomy (not SUVs). full_size_van = cargo pricing key.
    compact_van: { label: 'Compact Van', rows: null },
    midsize_van: { label: 'Midsize Van', rows: null },
    full_size_van: { label: 'Full-Size Cargo Van', rows: null },
    full_size_van_passenger: { label: 'Full-Size Passenger Van', rows: null },
  };

  function parseVanUseSuffix(model) {
    const raw = String(model || '').trim();
    const m = raw.match(/^(.*)\s+(Cargo|Passenger)$/i);
    if (!m) return { baseModel: raw, vanUse: null };
    return { baseModel: m[1].trim(), vanUse: m[2].toLowerCase() === 'passenger' ? 'passenger' : 'cargo' };
  }

  function vanDisplayLabel(vanSize, vanUse) {
    const size =
      vanSize === 'compact' ? 'Compact' : vanSize === 'midsize' ? 'Midsize' : vanSize === 'full_size' ? 'Full-Size' : null;
    if (!size) return null;
    if (vanUse === 'passenger') return size + ' Passenger Van';
    if (vanUse === 'cargo') return size + ' Cargo Van';
    return size + ' Van';
  }

  function pricingClassForVanUse(vehicle, use) {
    const size = vehicle && vehicle.vanSize;
    const u = use || (vehicle && vehicle.defaultVanUse) || null;
    const pc = vehicle ? vehicle.pricingClass : null;
    if (size === 'compact' || pc === 'compact_van') return 'compact_van';
    if (size === 'midsize' || pc === 'midsize_van') return 'midsize_van';
    if (
      size === 'full_size' ||
      pc === 'full_size_van' ||
      pc === 'full_size_van_passenger'
    ) {
      return u === 'passenger' ? 'full_size_van_passenger' : 'full_size_van';
    }
    return pc;
  }

  function loadCatalogData() {
    const g = typeof globalThis !== 'undefined' ? globalThis : null;
    if (g && g.CD1_CARS_VEHICLE_CATALOG) return g.CD1_CARS_VEHICLE_CATALOG;
    if (typeof require === 'function') {
      try {
        // Prefer generated JS (browser+node), fall back to JSON SoT.
        // eslint-disable-next-line import/no-unresolved, global-require
        return require('./generated/cars-vehicle-catalog.generated.js');
      } catch (_) {
        try {
          // eslint-disable-next-line global-require
          return require('../data/cars-vehicle-catalog.json');
        } catch (err) {
          throw new Error(
            'CD1VehicleCatalog: catalog data not found. Run node scripts/sync-vehicle-catalog.cjs'
          );
        }
      }
    }
    throw new Error('CD1VehicleCatalog: browser catalog global missing');
  }

  // Lazy load so generation can write the data file first.
  let _catalog = null;
  function catalog() {
    if (!_catalog) _catalog = loadCatalogData();
    return _catalog;
  }

  function setCatalogForTests(next) {
    _catalog = next;
  }

  function normKey(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, '')
      .trim();
  }

  function publicVehicles() {
    return (catalog().vehicles || []).filter((v) => v.public !== false);
  }

  function allVehicles() {
    return catalog().vehicles || [];
  }

  function getMakes() {
    const set = new Set();
    for (const v of publicVehicles()) set.add(v.make);
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  function modelsForMake(make) {
    const mk = String(make || '').trim();
    return publicVehicles()
      .filter((v) => v.make === mk)
      .map((v) => v.model)
      .sort((a, b) => a.localeCompare(b));
  }

  function findVehicleRecord(make, model) {
    const mk = String(make || '').trim();
    const parsed = parseVanUseSuffix(model);
    const md = parsed.baseModel;
    const mdNorm = normKey(md);
    const pool = allVehicles().filter((v) => v.make === mk || normKey(v.make) === normKey(mk));
    // Prefer longer/exact model names first so NV200 never collapses to NV, etc.
    const byLen = [...pool].sort((a, b) => b.model.length - a.model.length);
    // Exact canonical model (including full "NV200" before any NV alias)
    let hit = byLen.find((v) => v.model === md || normKey(v.model) === mdNorm);
    if (hit && (hit.model === md || normKey(hit.model) === mdNorm)) {
      return { vehicle: hit, matchedAlias: hit.model === String(model || '').trim() ? null : String(model || '').trim(), vanUse: parsed.vanUse };
    }
    // Exact canonical against original string (e.g. rare models ending in Cargo)
    hit = byLen.find((v) => v.model === String(model || '').trim());
    if (hit) return { vehicle: hit, matchedAlias: null, vanUse: parsed.vanUse };
    // Explicit aliases[] — longest alias wins (Transit Connect before Transit)
    let best = null;
    let bestAlias = null;
    for (const v of byLen) {
      for (const a of v.aliases || []) {
        if (normKey(a) === mdNorm || a === md || normKey(a) === normKey(model) || a === model) {
          if (!bestAlias || String(a).length > String(bestAlias).length) {
            best = v;
            bestAlias = a;
          }
        }
      }
    }
    if (best) return { vehicle: best, matchedAlias: bestAlias, vanUse: parsed.vanUse };
    return null;
  }

  function yearBand(vehicle, year) {
    const y = Number(year);
    const bands = vehicle.years || [];
    if (!Number.isFinite(y) || y <= 0) {
      // No year → preserve legacy MODELS.t default via vehicle.pricingClass/displayClass.
      // (Do NOT pick the newest generation band — that would change Santa Fe etc.)
      return {
        band: {
          class: vehicle.pricingClass,
          displayClass: vehicle.displayClass,
          rows:
            vehicle.displayClass === 'minivan' || vehicle.pricingClass === 'suv3'
              ? 3
              : vehicle.pricingClass === 'suv2'
                ? 2
                : null,
        },
        yearValid: null,
      };
    }
    for (const band of bands) {
      const from = band.from == null ? -Infinity : Number(band.from);
      const to = band.to == null ? Infinity : Number(band.to);
      if (y >= from && y <= to) return { band, yearValid: true };
    }
    return { band: null, yearValid: false };
  }

  function displayMeta(displayClass, pricingClass) {
    const key = displayClass || pricingClass;
    return DISPLAY[key] || DISPLAY[pricingClass] || { label: null, rows: null };
  }

  /**
   * Canonical year+make+model resolution.
   * @param {{year?:string|number, make:string, model:string, strictYear?:boolean}} input
   */
  function resolveVehicle(input) {
    const make = input && input.make;
    const model = input && input.model;
    const year = input && input.year;
    const strictYear = !!(input && input.strictYear);
    const found = findVehicleRecord(make, model);
    if (!found) {
      return {
        ok: false,
        needsConfirmation: true,
        make: make || null,
        model: model || null,
        canonicalMake: null,
        canonicalModel: null,
        matchedAlias: null,
        yearValid: null,
        tierKey: null,
        pricingClass: null,
        body: null,
        displayClass: null,
        displayLabel: null,
        rows: null,
        source: 'not_found',
        public: null,
      };
    }

    const { vehicle, matchedAlias, vanUse: parsedUse } = found;
    const { band, yearValid } = yearBand(vehicle, year);

    // Phase 1: year-aware data is present, but Production keeps over-acceptance for public models
    // unless strictYear is explicitly enabled.
    if (yearValid === false && (strictYear || vehicle.public === false)) {
      return {
        ok: false,
        needsConfirmation: true,
        make: vehicle.make,
        model: vehicle.model,
        canonicalMake: vehicle.make,
        canonicalModel: vehicle.model,
        matchedAlias,
        yearValid: false,
        tierKey: null,
        pricingClass: null,
        body: null,
        displayClass: null,
        displayLabel: null,
        rows: null,
        source: 'invalid_year',
        public: vehicle.public !== false,
      };
    }

    const vanUse =
      (input && input.vanUse) ||
      parsedUse ||
      vehicle.defaultVanUse ||
      (Array.isArray(vehicle.vanUseOptions) ? vehicle.vanUseOptions[0] : null) ||
      null;

    let pricingClass = (band && band.class) || vehicle.pricingClass;
    if (vehicle.vehicleFamily === 'van' || vehicle.vanSize) {
      pricingClass = pricingClassForVanUse(vehicle, vanUse) || pricingClass;
    }

    let displayClass =
      vehicle.displayClass === 'minivan'
        ? 'minivan'
        : (band && (band.displayClass || band.class)) || vehicle.displayClass || pricingClass;
    if (vehicle.vehicleFamily === 'van' || vehicle.vanSize) {
      displayClass = pricingClass; // van display tracks pricing/use class
    }
    const meta = displayMeta(displayClass, pricingClass);
    const rows = band && band.rows != null ? band.rows : meta.rows;
    const vanLabel = vanDisplayLabel(vehicle.vanSize, vanUse);

    return {
      ok: true,
      needsConfirmation: false,
      make: vehicle.make,
      model: vehicle.model,
      canonicalMake: vehicle.make,
      canonicalModel: vehicle.model,
      matchedAlias,
      yearValid: yearValid === null ? true : yearValid,
      tierKey: pricingClass,
      pricingClass,
      body: displayClass,
      displayClass,
      displayLabel: vanLabel || meta.label,
      rows,
      source: matchedAlias ? 'alias' : band ? 'catalog_year' : 'catalog',
      public: vehicle.public !== false,
      subtype: band && band.subtype ? band.subtype : null,
      vehicleFamily: vehicle.vehicleFamily || null,
      vanSize: vehicle.vanSize || null,
      vanUse,
      series: Array.isArray(vehicle.series) ? vehicle.series : [],
    };
  }

  /**
   * Adapter matching assets/vehicle-class-resolver.js shape.
   * Uses catalog as authority; ignores legacy catalogTierKey except as emergency fallback.
   */
  function resolveVehicleClassification(input) {
    const resolved = resolveVehicle(input || {});
    if (!resolved.ok) {
      // Emergency fallback: honor explicit catalogTierKey from page MODELS (parity during migration).
      const catalogTierKey = input && input.catalogTierKey;
      if (catalogTierKey && DISPLAY[catalogTierKey]) {
        const body =
          input && input.make && input.model
            ? resolveVehicle({ make: input.make, model: input.model, year: input.year }).body || catalogTierKey
            : catalogTierKey;
        // If model is a known minivan, keep minivan display even in fallback.
        const mini = resolveVehicle({ make: input.make, model: input.model });
        const displayClass =
          mini && mini.ok && mini.displayClass === 'minivan' ? 'minivan' : catalogTierKey;
        const meta = displayMeta(displayClass, catalogTierKey);
        return {
          ok: true,
          needsConfirmation: false,
          tierKey: catalogTierKey,
          body: displayClass,
          displayLabel: meta.label,
          rows: meta.rows,
          source: 'legacy_catalog_tier',
        };
      }
      return {
        ok: false,
        needsConfirmation: true,
        tierKey: null,
        body: null,
        displayLabel: null,
        rows: null,
        source: resolved.source || 'needs_confirmation',
      };
    }
    return {
      ok: true,
      needsConfirmation: false,
      tierKey: resolved.tierKey,
      body: resolved.body,
      displayLabel: resolved.displayLabel,
      rows: resolved.rows,
      source: resolved.source,
    };
  }

  function toLegacyModelsMap() {
    const out = {};
    for (const v of publicVehicles()) {
      if (!out[v.make]) out[v.make] = { m: [], t: {} };
      if (!out[v.make].m.includes(v.model)) out[v.make].m.push(v.model);
      // Legacy MODELS.t uses the default/catalog tier (first year band / vehicle pricingClass).
      // For Santa Fe this remains suv2 (pre-2024 default), matching prior Production.
      const defaultBand = (v.years && v.years[0]) || null;
      const legacyTier =
        v.displayClass === 'minivan'
          ? 'suv3'
          : v.pricingClass || (defaultBand && defaultBand.class) || 'small';
      // Prefer explicit vehicle.pricingClass when set; for year-split models use earliest band class
      // only when pricingClass equals earliest (migration sets pricingClass = MODELS.t default).
      out[v.make].t[v.model] = v.pricingClass || legacyTier;
    }
    for (const make of Object.keys(out)) {
      out[make].m.sort((a, b) => a.localeCompare(b));
    }
    return out;
  }

  function toLegacyMakes() {
    return getMakes();
  }

  function displayLabelForTierKey(tierKey) {
    const meta = DISPLAY[tierKey];
    return meta ? meta.label : null;
  }

  function isYearValid(make, model, year) {
    const found = findVehicleRecord(make, model);
    if (!found) return false;
    const { yearValid } = yearBand(found.vehicle, year);
    if (yearValid === null) return true;
    return yearValid;
  }

  return {
    DISPLAY,
    catalog,
    setCatalogForTests,
    getMakes,
    modelsForMake,
    publicVehicles,
    allVehicles,
    findVehicleRecord,
    resolveVehicle,
    resolveVehicleClassification,
    toLegacyModelsMap,
    toLegacyMakes,
    displayLabelForTierKey,
    isYearValid,
    normKey,
  };
});
