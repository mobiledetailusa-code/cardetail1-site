'use strict';

/**
 * Shared vehicle classification for pricing (commercial engine, Phase 2B-A). NOT ENFORCED.
 *
 * Decides, from a VALIDATED vehicle configuration (never a client tier or size class),
 * what kind of vehicle this is for pricing:
 *
 *   comparable_van         passenger/cargo van comparable to a Cars & SUVs van booking
 *   large_commercial_van   full-size van with high/super-high roof, long/extended body,
 *                          seats above the comparable limit, or wheelchair positions
 *   shuttle_bus            passenger / shuttle bus (cutaway)
 *   cutaway_box_truck      box body on a van cutaway chassis (E-Series, Transit, Express)
 *   chassis_cab_box_truck  box body on a chassis cab (LCF, Isuzu, Hino, HD pickups…)
 *   unsupported            not identified well enough to classify (manual review)
 *
 * Nothing in the Cars & SUVs booking path calls this module. CHANNEL_ENFORCEMENT_ENABLED
 * is a code constant and stays false until the owner approves the comparable boundary
 * and the Cars form collects van configuration. The comparable seat limit below is a
 * PROPOSAL (policy status 'draft').
 */

const CommercialCatalog = require('../../assets/commercial-vehicle-catalog');
const CarsCatalog = require('../../assets/vehicle-catalog');

const CHANNEL_ENFORCEMENT_ENABLED = false;

const CATEGORY = Object.freeze({
  COMPARABLE_VAN: 'comparable_van',
  LARGE_COMMERCIAL_VAN: 'large_commercial_van',
  SHUTTLE_BUS: 'shuttle_bus',
  CUTAWAY_BOX_TRUCK: 'cutaway_box_truck',
  CHASSIS_CAB_BOX_TRUCK: 'chassis_cab_box_truck',
  UNSUPPORTED: 'unsupported',
  CARS_VEHICLE: 'cars_vehicle',
});

/** Proposed, unapproved boundary for "comparable" vans. */
const DRAFT_CHANNEL_POLICY = Object.freeze({
  status: 'draft',
  comparableClasses: Object.freeze(['cv_van_compact', 'cv_van_midsize', 'cv_van_full']),
  comparableMaxSeats: 8,
});

const VAN_BODIES = Object.freeze(['cargo_van', 'crew_van', 'passenger_van']);
const CUTAWAY_BOX_MODELS = new Set(['ford_eseries_cutaway_box', 'ford_transit_cutaway_box', 'chevrolet_gmc_cutaway_box']);
const CHASSIS_CAB_BOX_MODELS = new Set(['chevrolet_lcf_box', 'isuzu_n_series', 'hino_box', 'fuso_box', 'freightliner_m2_box', 'international_box', 'ford_f650_f750_box']);

/** The Cars & SUVs record a customer would pick for each commercial van model. */
const CARS_EQUIVALENT = Object.freeze({
  ford_transit: Object.freeze(['Ford', 'Transit']),
  ford_transit_connect: Object.freeze(['Ford', 'Transit Connect']),
  mercedes_sprinter: Object.freeze(['Mercedes-Benz', 'Sprinter']),
  mercedes_metris: Object.freeze(['Mercedes-Benz', 'Metris']),
  ram_promaster: Object.freeze(['Ram', 'ProMaster']),
  ram_promaster_city: Object.freeze(['Ram', 'ProMaster City']),
  chevrolet_express: Object.freeze(['Chevrolet', 'Express']),
  gmc_savana: Object.freeze(['GMC', 'Savana']),
  nissan_nv: Object.freeze(['Nissan', 'NV']),
  nissan_nv200: Object.freeze(['Nissan', 'NV200']),
});

/** Cars records that can also be a chassis cab with a work body. */
const HD_PICKUP_MODELS = new Set(['F-350 Super Duty', '3500', 'Ram 3500', 'Silverado 3500HD', 'Sierra 3500HD']);
/** Cars van records whose name also covers cutaway shuttles and box trucks. */
const CUTAWAY_CAPABLE = new Set(['Ford|E-Series', 'Ford|Transit', 'Chevrolet|Express', 'GMC|Savana']);

function policyIsUsable(policy) {
  return !!policy && Array.isArray(policy.comparableClasses) && Number.isInteger(policy.comparableMaxSeats);
}

function isComparableVan(resolution, policy) {
  if (!policyIsUsable(policy)) return false;
  const cfg = resolution.configuration || {};
  return policy.comparableClasses.includes(resolution.sizeClass)
    && VAN_BODIES.includes(resolution.body)
    && !(cfg.wheelchairPositions > 0)
    && (cfg.passengerCapacity || 0) <= policy.comparableMaxSeats;
}

/**
 * Classify a commercial catalog selection. The selection is re-resolved here; any
 * sizeClass / tier / price on it is ignored by resolveSelection.
 */
function classifyCommercialSelection(selection, { policy = DRAFT_CHANNEL_POLICY } = {}) {
  const resolved = CommercialCatalog.resolveSelection(selection);
  if (!resolved.ok) return { ok: false, category: CATEGORY.UNSUPPORTED, reason: 'invalid_vehicle', fields: resolved.errors };
  const r = resolved.resolution;
  const base = { ok: true, resolution: r, sizeClass: r.sizeClass || null, policyApproved: !!policy && policy.status === 'approved' };
  if (r.status !== 'identified' || !r.sizeClass) {
    return { ...base, category: CATEGORY.UNSUPPORTED, channel: 'manual_review', reviewReasons: r.reviewReasons || [] };
  }
  if (r.body === 'shuttle_bus') return { ...base, category: CATEGORY.SHUTTLE_BUS, cutaway: true, channel: 'commercial' };
  if (r.body === 'box_truck') {
    if (CUTAWAY_BOX_MODELS.has(r.modelId)) return { ...base, category: CATEGORY.CUTAWAY_BOX_TRUCK, cutaway: true, channel: 'commercial' };
    if (CHASSIS_CAB_BOX_MODELS.has(r.modelId)) return { ...base, category: CATEGORY.CHASSIS_CAB_BOX_TRUCK, cutaway: false, channel: 'commercial' };
    return { ...base, category: CATEGORY.UNSUPPORTED, channel: 'manual_review', reviewReasons: ['unknown_box_truck_chassis'] };
  }
  const comparable = isComparableVan(r, policy);
  const carsEquivalent = CARS_EQUIVALENT[r.modelId] || null;
  if (comparable && carsEquivalent) return { ...base, category: CATEGORY.COMPARABLE_VAN, comparable: true, carsEquivalent, channel: 'cars' };
  return { ...base, category: CATEGORY.LARGE_COMMERCIAL_VAN, comparable: false, carsEquivalent, channel: 'commercial' };
}

/** Cars & SUVs tier key for a comparable van (cargo vs passenger use), or null. */
function carsTierForComparable(classification) {
  if (!classification || classification.category !== CATEGORY.COMPARABLE_VAN || !classification.carsEquivalent) return null;
  const [make, model] = classification.carsEquivalent;
  const r = classification.resolution;
  const resolved = CarsCatalog.resolveVehicle({ make, model, year: r.year || undefined, vanUse: r.body === 'passenger_van' ? 'passenger' : 'cargo' });
  return resolved.ok && resolved.public !== false && resolved.tierKey ? resolved.tierKey : null;
}

/**
 * How a vehicle entered under Cars & SUVs WOULD be classified. Not called by any booking
 * function (CHANNEL_ENFORCEMENT_ENABLED is false).
 * vehicle: { make, model, year, vanUse, bedType?, body?, roof?, length?, passengerCapacity?, wheelchairPositions? }
 */
function classifyCarsVehicle(vehicle, { policy = DRAFT_CHANNEL_POLICY } = {}) {
  const v = vehicle && typeof vehicle === 'object' ? vehicle : {};
  const found = CarsCatalog.findVehicleRecord(String(v.make || ''), String(v.model || ''));
  const rec = found && found.vehicle;
  if (!rec) return { category: CATEGORY.CARS_VEHICLE, channel: 'cars', reason: 'not_a_catalog_van_or_hd_pickup' };

  if (HD_PICKUP_MODELS.has(rec.model)) {
    if (!v.bedType) return { category: CATEGORY.UNSUPPORTED, channel: 'configuration_required', ask: ['bedType'] };
    if (v.bedType === 'pickup_bed') return { category: CATEGORY.CARS_VEHICLE, channel: 'cars' };
    return { category: CATEGORY.CHASSIS_CAB_BOX_TRUCK, channel: 'commercial', reason: 'chassis_cab_with_body' };
  }
  if (rec.vehicleFamily !== 'van') return { category: CATEGORY.CARS_VEHICLE, channel: 'cars' };
  if (rec.vanSize !== 'full_size') return { category: CATEGORY.COMPARABLE_VAN, channel: 'cars', reason: 'compact_or_midsize_van' };

  const key = `${rec.make}|${rec.model}`;
  if (CUTAWAY_CAPABLE.has(key) && !v.body) {
    return { category: CATEGORY.UNSUPPORTED, channel: 'configuration_required', ask: ['body', 'roof', 'length', 'passengerCapacity', 'wheelchairPositions'] };
  }
  if (v.body === 'shuttle_bus') return { category: CATEGORY.SHUTTLE_BUS, channel: 'commercial', cutaway: true };
  if (v.body === 'box_truck') return { category: CATEGORY.CUTAWAY_BOX_TRUCK, channel: 'commercial', cutaway: true };
  if (v.body && !VAN_BODIES.includes(v.body) && v.body !== 'wheelchair_van') return { category: CATEGORY.UNSUPPORTED, channel: 'manual_review', reason: 'unknown_body' };

  const modelId = Object.keys(CARS_EQUIVALENT).find((k) => CARS_EQUIVALENT[k][0] === rec.make && CARS_EQUIVALENT[k][1] === rec.model);
  if (!modelId) return { category: CATEGORY.UNSUPPORTED, channel: 'manual_review', reason: 'no_commercial_equivalent' };
  const body = v.body || (v.vanUse === 'passenger' ? 'passenger_van' : 'cargo_van');
  const needsSeats = body === 'passenger_van' || body === 'wheelchair_van';
  const model = CommercialCatalog.getModel(modelId);
  const needsRoof = model && model.roofs.length > 0;
  const needsLength = model && model.lengths.length > 0;
  if ((needsRoof && v.roof == null) || (needsLength && v.length == null) || (needsSeats && v.passengerCapacity == null)) {
    return { category: CATEGORY.UNSUPPORTED, channel: 'configuration_required', ask: ['roof', 'length', 'passengerCapacity', 'wheelchairPositions'] };
  }
  const c = classifyCommercialSelection({
    modelId, body, roof: v.roof, length: v.length, year: v.year,
    passengerCapacity: needsSeats ? v.passengerCapacity : undefined,
    wheelchairPositions: body === 'wheelchair_van' ? (v.wheelchairPositions || 0) : undefined,
  }, { policy });
  if (!c.ok || c.category === CATEGORY.UNSUPPORTED) return { category: CATEGORY.UNSUPPORTED, channel: 'manual_review', reason: 'configuration_needs_review' };
  return { category: c.category, channel: c.channel, sizeClass: c.sizeClass, policyApproved: c.policyApproved };
}

module.exports = {
  CHANNEL_ENFORCEMENT_ENABLED,
  CATEGORY,
  DRAFT_CHANNEL_POLICY,
  CARS_EQUIVALENT,
  classifyCommercialSelection,
  classifyCarsVehicle,
  carsTierForComparable,
  isComparableVan,
};
