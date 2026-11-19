'use strict';
/**
 * Cardetail1 commercial & specialty vehicle catalog (Phase 2A).
 *
 * Structured identification for commercial vans, shuttle / passenger buses and
 * box trucks. Shared by the booking page (Commercial & Specialty form) and the
 * server (netlify/lib/vehicle-inquiry.js, netlify/lib/commercial-pricing.js).
 *
 * Data rules:
 *  - Model years for vans come from the cars catalog (data/cars-vehicle-catalog.json)
 *    through CD1VehicleCatalog, so there is one year table, not two.
 *  - Roof / length / seating options list factory configurations only. Bodies
 *    built by an upfitter (cutaway shuttle buses, box bodies, wheelchair
 *    conversions) vary by builder, so the customer reports seats, wheelchair
 *    positions and length class within bounded ranges.
 *  - This file carries no prices. The server derives the commercial size class
 *    from the resolved configuration; it never accepts one from the browser.
 *
 * Standard cargo / passenger vans keep booking under Cars & SUVs with the
 * existing cars pricing. This catalog only feeds the quote-only commercial path.
 */
(function (root, factory) {
  const cars = typeof module === 'object' && module.exports
    ? require('./vehicle-catalog')
    : (root && root.CD1VehicleCatalog) || null;
  const api = factory(cars);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CD1CommercialCatalog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CarsCatalog) {
  const freeze = (o) => Object.freeze(o);

  /** Customer-facing commercial groups (step 1 of the form). */
  const GROUPS = freeze({
    commercial_van: freeze({ label: 'Commercial van' }),
    shuttle_bus: freeze({ label: 'Shuttle or passenger bus' }),
    box_truck: freeze({ label: 'Box truck' }),
  });

  /**
   * Body configurations. `inquiryCategory` is the Phase 1 inquiry category the
   * record is stored under, so admin views and notifications keep working.
   * `fields` lists the only configuration fields asked for this body.
   */
  const BODIES = freeze({
    cargo_van: freeze({ label: 'Cargo van', inquiryCategory: 'cargo_van', fields: freeze(['roof', 'length']) }),
    crew_van: freeze({ label: 'Crew van (cargo with a second seat row)', inquiryCategory: 'cargo_van', fields: freeze(['roof', 'length']) }),
    passenger_van: freeze({ label: 'Passenger van', inquiryCategory: 'passenger_van', fields: freeze(['roof', 'length', 'passengerCapacity']), requireCapacity: true }),
    wheelchair_van: freeze({ label: 'Wheelchair-accessible van', inquiryCategory: 'paratransit', fields: freeze(['roof', 'length', 'passengerCapacity', 'wheelchairPositions']), requireCapacity: true }),
    shuttle_bus: freeze({ label: 'Cutaway shuttle bus', inquiryCategory: 'shuttle_bus', fields: freeze(['busLength', 'passengerCapacity', 'wheelchairPositions']), requireCapacity: true, requireLength: 'busLength' }),
    box_truck: freeze({ label: 'Box truck', inquiryCategory: 'box_truck', fields: freeze(['boxLength']), requireLength: 'boxLength' }),
  });

  const ROOFS = freeze({
    low: 'Low roof',
    medium: 'Medium roof',
    standard: 'Standard roof',
    high: 'High roof',
    super_high: 'Super-high roof',
  });

  /** Van lengths are named the way each manufacturer orders them. */
  const VAN_LENGTHS = freeze({
    regular: 'Regular length',
    long: 'Long wheelbase',
    extended: 'Extended length',
    swb: 'Short wheelbase',
    lwb: 'Long wheelbase',
    wb118: '118 in. wheelbase',
    wb136: '136 in. wheelbase',
    wb159: '159 in. wheelbase',
    wb159ext: '159 in. extended',
    wb144: '144 in. wheelbase',
    wb170: '170 in. wheelbase',
    wb170ext: '170 in. extended',
    wb135: '135 in. wheelbase (regular)',
    wb155: '155 in. wheelbase (extended)',
  });

  /** Upfitted bodies: overall length classes the customer can read off the vehicle. */
  const BUS_LENGTHS = freeze({
    up_to_24: 'Up to 24 ft',
    '25_to_29': '25–29 ft',
    '30_to_35': '30–35 ft',
  });
  const BOX_LENGTHS = freeze({
    '10_to_12': '10–12 ft box',
    '14_to_16': '14–16 ft box',
    '18_to_20': '18–20 ft box',
    '22_to_26': '22–26 ft box',
  });

  /** Bounds for customer-reported counts (upfitter-dependent bodies). */
  const COUNT_LIMITS = freeze({
    passengerCapacity: freeze({ min: 1, max: 40 }),
    wheelchairPositions: freeze({ min: 0, max: 8 }),
  });

  /**
   * Models. `cars` points at the cars-catalog record that owns the model years.
   * `maxPassengers` is a per-body factory maximum (vans) or a bound for upfitted
   * bodies. `roofYears` restricts a roof option to the model years it was sold.
   */
  const MODELS = freeze([
    // ── Commercial vans ────────────────────────────────────────────────────
    {
      id: 'ford_transit', group: 'commercial_van', make: 'Ford', model: 'Transit', vanSize: 'full_size',
      cars: ['Ford', 'Transit'],
      bodies: ['cargo_van', 'crew_van', 'passenger_van', 'wheelchair_van'],
      roofs: ['low', 'medium', 'high'],
      lengths: ['regular', 'long', 'extended'],
      maxPassengers: { passenger_van: 15, wheelchair_van: 15 },
    },
    {
      id: 'ford_transit_connect', group: 'commercial_van', make: 'Ford', model: 'Transit Connect', vanSize: 'compact',
      cars: ['Ford', 'Transit Connect'],
      bodies: ['cargo_van', 'passenger_van'],
      roofs: [],
      lengths: ['swb', 'lwb'],
      maxPassengers: { passenger_van: 7 },
    },
    {
      id: 'mercedes_sprinter', group: 'commercial_van', make: 'Mercedes-Benz', model: 'Sprinter', vanSize: 'full_size',
      cars: ['Mercedes-Benz', 'Sprinter'],
      bodies: ['cargo_van', 'crew_van', 'passenger_van', 'wheelchair_van'],
      roofs: ['standard', 'high'],
      lengths: ['wb144', 'wb170', 'wb170ext'],
      maxPassengers: { passenger_van: 15, wheelchair_van: 15 },
    },
    {
      id: 'mercedes_metris', group: 'commercial_van', make: 'Mercedes-Benz', model: 'Metris', vanSize: 'midsize',
      cars: ['Mercedes-Benz', 'Metris'],
      bodies: ['cargo_van', 'passenger_van'],
      roofs: [],
      lengths: [],
      maxPassengers: { passenger_van: 8 },
    },
    {
      id: 'ram_promaster', group: 'commercial_van', make: 'Ram', model: 'ProMaster', vanSize: 'full_size',
      cars: ['Ram', 'ProMaster'],
      bodies: ['cargo_van', 'wheelchair_van'],
      roofs: ['standard', 'high', 'super_high'],
      roofYears: { super_high: { from: 2023 } },
      lengths: ['wb118', 'wb136', 'wb159', 'wb159ext'],
      maxPassengers: { wheelchair_van: 15 },
    },
    {
      id: 'ram_promaster_city', group: 'commercial_van', make: 'Ram', model: 'ProMaster City', vanSize: 'compact',
      cars: ['Ram', 'ProMaster City'],
      bodies: ['cargo_van', 'passenger_van'],
      roofs: [],
      lengths: [],
      maxPassengers: { passenger_van: 5 },
    },
    {
      id: 'chevrolet_express', group: 'commercial_van', make: 'Chevrolet', model: 'Express', vanSize: 'full_size',
      cars: ['Chevrolet', 'Express'],
      bodies: ['cargo_van', 'passenger_van', 'wheelchair_van'],
      roofs: [],
      lengths: ['wb135', 'wb155'],
      maxPassengers: { passenger_van: 15, wheelchair_van: 15 },
    },
    {
      id: 'gmc_savana', group: 'commercial_van', make: 'GMC', model: 'Savana', vanSize: 'full_size',
      cars: ['GMC', 'Savana'],
      bodies: ['cargo_van', 'passenger_van', 'wheelchair_van'],
      roofs: [],
      lengths: ['wb135', 'wb155'],
      maxPassengers: { passenger_van: 15, wheelchair_van: 15 },
    },
    {
      id: 'nissan_nv', group: 'commercial_van', make: 'Nissan', model: 'NV (1500 / 2500 / 3500)', vanSize: 'full_size',
      cars: ['Nissan', 'NV'],
      bodies: ['cargo_van', 'passenger_van'],
      roofs: ['standard', 'high'],
      lengths: [],
      maxPassengers: { passenger_van: 12 },
    },
    {
      id: 'nissan_nv200', group: 'commercial_van', make: 'Nissan', model: 'NV200', vanSize: 'compact',
      cars: ['Nissan', 'NV200'],
      bodies: ['cargo_van'],
      roofs: [],
      lengths: [],
      maxPassengers: {},
    },

    // ── Shuttle & passenger buses (cutaway chassis, upfitter body) ─────────
    {
      id: 'chevrolet_gmc_cutaway_bus', group: 'shuttle_bus', make: 'Chevrolet / GMC', model: 'Express / Savana cutaway shuttle bus',
      bodies: ['shuttle_bus'], busLengths: ['up_to_24', '25_to_29', '30_to_35'],
      maxPassengers: { shuttle_bus: 40 },
    },
    {
      id: 'ford_transit_shuttle', group: 'shuttle_bus', make: 'Ford', model: 'Transit passenger van or cutaway shuttle', vanSize: 'full_size',
      cars: ['Ford', 'Transit'],
      bodies: ['passenger_van', 'wheelchair_van', 'shuttle_bus'],
      roofs: ['low', 'medium', 'high'],
      lengths: ['regular', 'long', 'extended'],
      busLengths: ['up_to_24', '25_to_29'],
      maxPassengers: { passenger_van: 15, wheelchair_van: 15, shuttle_bus: 40 },
    },
    {
      id: 'ford_eseries_cutaway_bus', group: 'shuttle_bus', make: 'Ford', model: 'E-Series cutaway shuttle bus (E-350 / E-450)',
      bodies: ['shuttle_bus'], busLengths: ['up_to_24', '25_to_29', '30_to_35'],
      maxPassengers: { shuttle_bus: 40 },
    },
    {
      id: 'other_shuttle_bus', group: 'shuttle_bus', make: '', model: 'Other shuttle or passenger bus', needsReview: true,
      bodies: ['shuttle_bus'], busLengths: ['up_to_24', '25_to_29', '30_to_35'],
      maxPassengers: { shuttle_bus: 40 },
    },

    // ── Box trucks ─────────────────────────────────────────────────────────
    {
      id: 'ford_eseries_cutaway_box', group: 'box_truck', make: 'Ford', model: 'E-Series cutaway box truck (E-350 / E-450)',
      bodies: ['box_truck'], boxLengths: ['10_to_12', '14_to_16'],
    },
    {
      id: 'ford_transit_cutaway_box', group: 'box_truck', make: 'Ford', model: 'Transit cutaway box truck',
      bodies: ['box_truck'], boxLengths: ['10_to_12', '14_to_16'],
    },
    {
      id: 'chevrolet_gmc_cutaway_box', group: 'box_truck', make: 'Chevrolet / GMC', model: 'Express / Savana cutaway box truck',
      bodies: ['box_truck'], boxLengths: ['10_to_12', '14_to_16'],
    },
    {
      id: 'chevrolet_lcf_box', group: 'box_truck', make: 'Chevrolet', model: 'Low Cab Forward box truck (3500 / 4500 / 5500)',
      bodies: ['box_truck'], boxLengths: ['10_to_12', '14_to_16', '18_to_20'],
    },
    {
      id: 'isuzu_n_series', group: 'box_truck', make: 'Isuzu', model: 'NPR / NPR-HD / NQR / NRR box truck',
      bodies: ['box_truck'], boxLengths: ['10_to_12', '14_to_16', '18_to_20'],
    },
    {
      id: 'hino_box', group: 'box_truck', make: 'Hino', model: 'Hino box truck',
      bodies: ['box_truck'], boxLengths: ['14_to_16', '18_to_20', '22_to_26'],
    },
    {
      id: 'fuso_box', group: 'box_truck', make: 'Mitsubishi Fuso', model: 'Fuso FE / FUSO Canter box truck',
      bodies: ['box_truck'], boxLengths: ['10_to_12', '14_to_16', '18_to_20'],
    },
    {
      id: 'freightliner_m2_box', group: 'box_truck', make: 'Freightliner', model: 'M2 106 box truck',
      bodies: ['box_truck'], boxLengths: ['18_to_20', '22_to_26'],
    },
    {
      id: 'international_box', group: 'box_truck', make: 'International', model: 'MV / CV box truck',
      bodies: ['box_truck'], boxLengths: ['14_to_16', '18_to_20', '22_to_26'],
    },
    {
      id: 'ford_f650_f750_box', group: 'box_truck', make: 'Ford', model: 'F-650 / F-750 box truck',
      bodies: ['box_truck'], boxLengths: ['18_to_20', '22_to_26'],
    },
    {
      id: 'other_box_truck', group: 'box_truck', make: '', model: 'Other box truck', needsReview: true,
      bodies: ['box_truck'], boxLengths: ['10_to_12', '14_to_16', '18_to_20', '22_to_26'],
    },
  ].map((m) => freeze({
    roofs: [], lengths: [], busLengths: [], boxLengths: [], maxPassengers: {}, roofYears: {}, ...m,
  })));

  const BY_ID = new Map(MODELS.map((m) => [m.id, m]));

  function has(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function getModel(id) {
    return BY_ID.get(String(id || '')) || null;
  }

  function modelsForGroup(group) {
    return MODELS.filter((m) => m.group === group);
  }

  /** Model years from the cars catalog when the model is a van there; null otherwise. */
  function yearRange(model) {
    if (!model || !model.cars || !CarsCatalog || typeof CarsCatalog.findVehicleRecord !== 'function') return null;
    const found = CarsCatalog.findVehicleRecord(model.cars[0], model.cars[1]);
    const bands = found && found.vehicle && found.vehicle.years;
    if (!Array.isArray(bands) || !bands.length) return null;
    let from = Infinity;
    let to = -Infinity;
    for (const b of bands) {
      if (b.from != null) from = Math.min(from, Number(b.from));
      if (b.to != null) to = Math.max(to, Number(b.to));
    }
    return Number.isFinite(from) && Number.isFinite(to) ? { from, to } : null;
  }

  /** Configuration fields that apply to one model + body (nothing else is asked). */
  function fieldsFor(model, bodyKey) {
    const body = BODIES[bodyKey];
    if (!model || !body || !model.bodies.includes(bodyKey)) return [];
    return body.fields.filter((f) => {
      if (f === 'roof') return model.roofs.length > 0;
      if (f === 'length') return model.lengths.length > 0;
      if (f === 'busLength') return model.busLengths.length > 0;
      if (f === 'boxLength') return model.boxLengths.length > 0;
      return true;
    });
  }

  function optionsFor(model, field) {
    if (!model) return [];
    if (field === 'roof') return model.roofs.map((k) => ({ key: k, label: ROOFS[k], years: model.roofYears[k] || null }));
    if (field === 'length') return model.lengths.map((k) => ({ key: k, label: VAN_LENGTHS[k] }));
    if (field === 'busLength') return model.busLengths.map((k) => ({ key: k, label: BUS_LENGTHS[k] }));
    if (field === 'boxLength') return model.boxLengths.map((k) => ({ key: k, label: BOX_LENGTHS[k] }));
    return [];
  }

  function parseCount(value) {
    if (value === undefined || value === null || value === '') return { present: false };
    const s = String(value).trim();
    if (!/^\d{1,3}$/.test(s)) return { present: true, ok: false };
    return { present: true, ok: true, value: Number(s) };
  }

  /**
   * Server size class. Derived only from the resolved configuration.
   * Returns null when the configuration cannot be sized (manual quote).
   */
  function sizeClassFor(model, bodyKey, cfg) {
    if (!model || model.needsReview) return null;
    if (bodyKey === 'box_truck') {
      return {
        '10_to_12': 'cv_box_small', '14_to_16': 'cv_box_medium', '18_to_20': 'cv_box_large', '22_to_26': 'cv_box_xl',
      }[cfg.boxLength] || null;
    }
    if (bodyKey === 'shuttle_bus') {
      return { up_to_24: 'cv_shuttle_small', '25_to_29': 'cv_shuttle_medium', '30_to_35': 'cv_shuttle_large' }[cfg.busLength] || null;
    }
    if (model.vanSize === 'compact') return 'cv_van_compact';
    if (model.vanSize === 'midsize') return 'cv_van_midsize';
    if (model.vanSize !== 'full_size') return null;
    // Unanswered roof / length on a full-size van: size unknown, manual quote.
    if (model.roofs.length && !cfg.roof) return null;
    if (model.lengths.length && !cfg.length) return null;
    const tall = cfg.roof === 'high' || cfg.roof === 'super_high';
    const long = ['extended', 'wb170ext', 'wb159ext', 'wb170', 'wb159', 'wb155'].includes(cfg.length);
    if (tall && long) return 'cv_van_full_xl';
    if (tall || long) return 'cv_van_full_large';
    return 'cv_van_full';
  }

  /**
   * Validate a client selection against the catalog.
   * input: { modelId, body, roof, length, busLength, boxLength, passengerCapacity, wheelchairPositions, year }
   * Returns { ok, errors, resolution } where resolution holds only catalog-backed
   * values. Fields that do not apply to the selected body are dropped.
   */
  function resolveSelection(input) {
    const errors = [];
    const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const model = getModel(src.modelId);
    if (!model) return { ok: false, errors: ['modelId'], resolution: null };
    const bodyKey = String(src.body || '');
    if (!has(BODIES, bodyKey) || !model.bodies.includes(bodyKey)) {
      return { ok: false, errors: ['body'], resolution: null };
    }
    const body = BODIES[bodyKey];
    const fields = fieldsFor(model, bodyKey);
    const cfg = {};
    const notes = [];

    const pickOption = (field) => {
      const raw = src[field];
      if (raw === undefined || raw === null || raw === '') return;
      const key = String(raw);
      const opt = optionsFor(model, field).find((o) => o.key === key);
      if (!opt) { errors.push(field); return; }
      cfg[field] = key;
    };
    for (const f of ['roof', 'length', 'busLength', 'boxLength']) if (fields.includes(f)) pickOption(f);
    if (body.requireLength && fields.includes(body.requireLength) && !cfg[body.requireLength]
        && !errors.includes(body.requireLength)) {
      errors.push(body.requireLength);
    }

    let year = null;
    const yRaw = src.year === undefined || src.year === null ? '' : String(src.year).trim();
    if (yRaw) {
      if (!/^\d{4}$/.test(yRaw)) errors.push('year');
      else year = Number(yRaw);
    }
    const years = yearRange(model);
    let yearStatus = year == null ? 'not_given' : 'unverified';
    if (year != null && years) {
      yearStatus = year >= years.from && year <= years.to ? 'in_range' : 'out_of_range';
      if (yearStatus === 'out_of_range') notes.push('model_year_outside_catalog');
    }
    if (cfg.roof && model.roofYears[cfg.roof]) {
      const ry = model.roofYears[cfg.roof];
      if (year == null || (ry.from != null && year < ry.from) || (ry.to != null && year > ry.to)) {
        notes.push('roof_not_confirmed_for_year');
      }
    }

    const maxPassengers = model.maxPassengers[bodyKey];
    if (fields.includes('passengerCapacity')) {
      const p = parseCount(src.passengerCapacity);
      const max = Math.min(maxPassengers || COUNT_LIMITS.passengerCapacity.max, COUNT_LIMITS.passengerCapacity.max);
      if (p.present && (!p.ok || p.value < COUNT_LIMITS.passengerCapacity.min || p.value > max)) errors.push('passengerCapacity');
      else if (p.present) cfg.passengerCapacity = p.value;
      else if (body.requireCapacity) errors.push('passengerCapacity');
    }
    if (fields.includes('wheelchairPositions')) {
      const w = parseCount(src.wheelchairPositions);
      if (w.present && (!w.ok || w.value < COUNT_LIMITS.wheelchairPositions.min || w.value > COUNT_LIMITS.wheelchairPositions.max)) {
        errors.push('wheelchairPositions');
      } else if (w.present) cfg.wheelchairPositions = w.value;
      if (cfg.wheelchairPositions !== undefined && cfg.passengerCapacity !== undefined
          && cfg.wheelchairPositions > cfg.passengerCapacity) errors.push('wheelchairPositions');
    }
    if (errors.length) return { ok: false, errors, resolution: null };

    const sizeClass = notes.length ? null : sizeClassFor(model, bodyKey, cfg);
    const reviewReasons = notes.slice();
    if (model.needsReview) reviewReasons.push('model_not_listed');
    else if (!sizeClass && !notes.length) reviewReasons.push('configuration_incomplete');
    const resolution = {
      modelId: model.id,
      group: model.group,
      make: model.make,
      model: model.model,
      body: bodyKey,
      bodyLabel: body.label,
      inquiryCategory: body.inquiryCategory,
      year,
      yearStatus,
      configuration: cfg,
      sizeClass,
      // identified: a size class could be derived; needs_review: a person must size it.
      status: sizeClass ? 'identified' : 'needs_review',
      reviewReasons,
    };
    return { ok: true, errors: [], resolution };
  }

  /** Human-readable configuration lines for emails / admin. */
  function describeResolution(r) {
    if (!r) return [];
    const parts = [r.bodyLabel];
    const c = r.configuration || {};
    if (c.roof) parts.push(ROOFS[c.roof]);
    if (c.length) parts.push(VAN_LENGTHS[c.length]);
    if (c.busLength) parts.push(BUS_LENGTHS[c.busLength]);
    if (c.boxLength) parts.push(BOX_LENGTHS[c.boxLength]);
    if (c.passengerCapacity !== undefined) parts.push(`${c.passengerCapacity} passengers`);
    if (c.wheelchairPositions !== undefined) parts.push(`${c.wheelchairPositions} wheelchair positions`);
    return [`Catalog: ${[r.make, r.model].filter(Boolean).join(' ')}`, `Configuration: ${parts.join(', ')}`];
  }

  return freeze({
    GROUPS,
    BODIES,
    ROOFS,
    VAN_LENGTHS,
    BUS_LENGTHS,
    BOX_LENGTHS,
    COUNT_LIMITS,
    MODELS,
    SIZE_CLASSES: freeze([
      'cv_van_compact', 'cv_van_midsize', 'cv_van_full', 'cv_van_full_large', 'cv_van_full_xl',
      'cv_shuttle_small', 'cv_shuttle_medium', 'cv_shuttle_large',
      'cv_box_small', 'cv_box_medium', 'cv_box_large', 'cv_box_xl',
    ]),
    getModel,
    modelsForGroup,
    yearRange,
    fieldsFor,
    optionsFor,
    resolveSelection,
    describeResolution,
  });
});
