'use strict';
/**
 * Cardetail1 canonical vehicle classification resolver.
 *
 * Phase 1: delegates to CD1VehicleCatalog (single Cars SoT) when available.
 * Falls back to legacy MODELS.t + local minivan/year maps only if catalog is absent.
 *
 * One resolution feeds both customer-facing display and pricing tierKey.
 * Pricing catalog keys remain: small | suv2 | suv3 | truck
 * (there is no separate minivan price key — minivans price as suv3).
 * full_size_van is reserved in the catalog schema for Phase 2/3.
 *
 * Catalog base map historically lived in page MODELS[make].t[model].
 * Phase 1 pages still receive generated MODELS for UI lists, but classification
 * authority is data/cars-vehicle-catalog.json via assets/vehicle-catalog.js.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CD1VehicleClass = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  const DISPLAY = {
    small: { label: 'Small Car', rows: null },
    suv2: { label: '2-Row SUV', rows: 2 },
    suv3: { label: '3-Row SUV', rows: 3 },
    truck: { label: 'Truck', rows: null },
    minivan: { label: 'Minivan', rows: 3 },
    full_size_van: { label: 'Full-Size Van', rows: null },
  };

  // Legacy fallback maps — kept for offline/no-catalog boot only.
  // Authoritative copies live in data/cars-vehicle-catalog.json.
  const MINIVAN_KEYS = new Set([
    'Dodge|Grand Caravan',
    'Chrysler|Pacifica',
    'Chrysler|Voyager',
    'Honda|Odyssey',
    'Toyota|Sienna',
    'Kia|Carnival',
  ]);

  const YEAR_OVERRIDES = {
    'Hyundai|Santa Fe': [{ from: 2024, tierKey: 'suv3', body: 'suv3' }],
  };

  function modelKey(make, model) {
    return String(make || '').trim() + '|' + String(model || '').trim();
  }

  function bodyFor(make, model, tierKey) {
    const key = modelKey(make, model);
    if (MINIVAN_KEYS.has(key)) return 'minivan';
    if (
      tierKey === 'suv2' ||
      tierKey === 'suv3' ||
      tierKey === 'small' ||
      tierKey === 'truck' ||
      tierKey === 'full_size_van'
    ) {
      return tierKey;
    }
    return null;
  }

  function applyYearOverride(make, model, year) {
    const y = Number(year);
    if (!Number.isFinite(y) || y <= 0) return null;
    const rows = YEAR_OVERRIDES[modelKey(make, model)];
    if (!rows || !rows.length) return null;
    let hit = null;
    for (const row of rows) {
      if (y >= row.from) hit = row;
    }
    return hit;
  }

  function getCatalogApi() {
    if (root && root.CD1VehicleCatalog) return root.CD1VehicleCatalog;
    if (typeof require === 'function') {
      try {
        // eslint-disable-next-line global-require
        return require('./vehicle-catalog.js');
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  /**
   * @param {object} input
   * @param {string} input.make
   * @param {string} input.model
   * @param {string|number} [input.year]
   * @param {string|null|undefined} input.catalogTierKey  from MODELS[make].t[model]
   */
  function resolveVehicleClassification(input) {
    const catalogApi = getCatalogApi();
    if (catalogApi && typeof catalogApi.resolveVehicleClassification === 'function') {
      const viaCatalog = catalogApi.resolveVehicleClassification(input || {});
      if (viaCatalog && viaCatalog.ok) return viaCatalog;
      // If catalog cannot resolve but page still has a legacy tier, fall through.
    }

    const make = input && input.make;
    const model = input && input.model;
    const year = input && input.year;
    const catalogTierKey = input && input.catalogTierKey;

    const yearHit = applyYearOverride(make, model, year);
    let tierKey = null;
    let source = 'none';

    if (yearHit && yearHit.tierKey) {
      tierKey = yearHit.tierKey;
      source = 'year_override';
    } else if (catalogTierKey && DISPLAY[catalogTierKey] !== undefined) {
      tierKey = catalogTierKey;
      source = 'catalog';
    }

    if (!tierKey) {
      return {
        ok: false,
        needsConfirmation: true,
        tierKey: null,
        body: null,
        displayLabel: null,
        rows: null,
        source: 'needs_confirmation',
      };
    }

    let body = yearHit && yearHit.body ? yearHit.body : bodyFor(make, model, tierKey);
    if (!body) body = tierKey;
    const meta = DISPLAY[body] || DISPLAY[tierKey] || { label: null, rows: null };

    return {
      ok: true,
      needsConfirmation: false,
      tierKey,
      body,
      displayLabel: meta.label,
      rows: meta.rows,
      source,
    };
  }

  function displayLabelForTierKey(tierKey) {
    const meta = DISPLAY[tierKey];
    return meta ? meta.label : null;
  }

  return {
    DISPLAY,
    MINIVAN_KEYS,
    YEAR_OVERRIDES,
    resolveVehicleClassification,
    displayLabelForTierKey,
    modelKey,
  };
});
