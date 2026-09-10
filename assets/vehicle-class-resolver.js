'use strict';
/**
 * Cardetail1 canonical vehicle classification resolver.
 *
 * One resolution feeds both customer-facing display and pricing tierKey.
 * Pricing catalog keys remain: small | suv2 | suv3 | truck
 * (there is no separate minivan price key — minivans price as suv3).
 *
 * Catalog base map lives in page MODELS[make].t[model].
 * This module adds: body display class, year-sensitive overrides, safe fallback.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CD1VehicleClass = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DISPLAY = {
    small: { label: 'Small Car', rows: null },
    suv2: { label: '2-Row SUV', rows: 2 },
    suv3: { label: '3-Row SUV', rows: 3 },
    truck: { label: 'Truck', rows: null },
    minivan: { label: 'Minivan', rows: 3 },
  };

  // Models that share suv3 pricing but must display as Minivan.
  const MINIVAN_KEYS = new Set([
    'Dodge|Grand Caravan',
    'Chrysler|Pacifica',
    'Chrysler|Voyager',
    'Honda|Odyssey',
    'Toyota|Sienna',
    'Kia|Carnival',
  ]);

  /**
   * Year-sensitive tier/body overrides (inclusive from-year).
   * Only models where generation changes row count — not a full vehicle DB.
   * Santa Fe: 2024+ redesign is a standard 3-row SUV; earlier gens stay catalog default.
   */
  const YEAR_OVERRIDES = {
    'Hyundai|Santa Fe': [
      { from: 2024, tierKey: 'suv3', body: 'suv3' },
    ],
  };

  function modelKey(make, model) {
    return String(make || '').trim() + '|' + String(model || '').trim();
  }

  function bodyFor(make, model, tierKey) {
    const key = modelKey(make, model);
    if (MINIVAN_KEYS.has(key)) return 'minivan';
    if (tierKey === 'suv2' || tierKey === 'suv3' || tierKey === 'small' || tierKey === 'truck') {
      return tierKey;
    }
    return null;
  }

  function applyYearOverride(make, model, year) {
    const y = Number(year);
    if (!Number.isFinite(y) || y <= 0) return null;
    const rows = YEAR_OVERRIDES[modelKey(make, model)];
    if (!rows || !rows.length) return null;
    // Highest matching from-year wins.
    let hit = null;
    for (const row of rows) {
      if (y >= row.from) hit = row;
    }
    return hit;
  }

  /**
   * @param {object} input
   * @param {string} input.make
   * @param {string} input.model
   * @param {string|number} [input.year]
   * @param {string|null|undefined} input.catalogTierKey  from MODELS[make].t[model]
   * @returns {{
   *   ok: boolean,
   *   needsConfirmation: boolean,
   *   tierKey: string|null,
   *   body: string|null,
   *   displayLabel: string|null,
   *   rows: number|null,
   *   source: string
   * }}
   */
  function resolveVehicleClassification(input) {
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
      // Unsafe to silently underprice as small/suv2 — require manual size chip.
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
