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
    full_size_van: { label: 'Full-Size Van', rows: null },
  };

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
    const md = String(model || '').trim();
    const mdNorm = normKey(md);
    const pool = allVehicles().filter((v) => v.make === mk || normKey(v.make) === normKey(mk));
    // Exact canonical model
    let hit = pool.find((v) => v.model === md);
    if (hit) return { vehicle: hit, matchedAlias: null };
    // Case-insensitive / normalized model (treat non-canonical spelling as alias)
    hit = pool.find((v) => normKey(v.model) === mdNorm);
    if (hit) return { vehicle: hit, matchedAlias: md === hit.model ? null : md };
    // Explicit aliases[]
    hit = pool.find((v) => (v.aliases || []).some((a) => normKey(a) === mdNorm || a === md));
    if (hit) {
      const alias = (hit.aliases || []).find((a) => normKey(a) === mdNorm || a === md) || md;
      return { vehicle: hit, matchedAlias: alias };
    }
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

    const { vehicle, matchedAlias } = found;
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

    const pricingClass = (band && band.class) || vehicle.pricingClass;
    const displayClass =
      vehicle.displayClass === 'minivan'
        ? 'minivan'
        : (band && (band.displayClass || band.class)) || vehicle.displayClass || pricingClass;
    const meta = displayMeta(displayClass, pricingClass);
    const rows = band && band.rows != null ? band.rows : meta.rows;

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
      displayLabel: meta.label,
      rows,
      source: matchedAlias ? 'alias' : band ? 'catalog_year' : 'catalog',
      public: vehicle.public !== false,
      subtype: band && band.subtype ? band.subtype : null,
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
