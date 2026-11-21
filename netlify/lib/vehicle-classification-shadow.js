'use strict';

/**
 * Observe-only classification of Cars & SUVs booking vehicles (commercial program B1).
 *
 * submit-booking calls observeBookingVehicles() AFTER the existing server pricing has
 * accepted the booking. This module:
 *   - reads a copy of a few identity/configuration fields and never writes to the booking;
 *   - never throws (every error becomes an `error` result);
 *   - returns nothing the caller uses for price, tier, routing or checkout;
 *   - never loads the commercial pricing engine or any amount;
 *   - does not enforce the draft comparable-van policy (CHANNEL_ENFORCEMENT_ENABLED stays false).
 *
 * A vehicle is only classified when every attribute that could change its category is
 * known. Otherwise the result is `unresolved` with the missing attributes listed. Missing
 * passenger counts are never treated as zero, and the configuration is never inferred from
 * make/model alone (a plain "Transit" is not assumed to be a cargo van here, even though
 * Cars pricing defaults it to cargo).
 */

const CarsCatalog = require('../../assets/vehicle-catalog');
const CommercialCatalog = require('../../assets/commercial-vehicle-catalog');
const Channel = require('./vehicle-pricing-channel');
const { vehicleIdentity } = require('./car-catalog-tier');

const SHADOW_VERSION = 1;
const SHADOW_MODE = 'observe_only';
const STATUS = Object.freeze({ RESOLVED: 'resolved', UNRESOLVED: 'unresolved', NOT_APPLICABLE: 'not_applicable', ERROR: 'error' });
const UNRESOLVED = 'unresolved';

/** Cars van records with no commercial catalog equivalent (manual mapping needed). */
const VAN_RECORDS_WITHOUT_EQUIVALENT = Object.freeze(['Chevrolet|City Express', 'Dodge|Sprinter', 'Ford|E-Series']);
/** Heavy-duty pickups that are also sold as chassis cabs with a work body (same set as the classifier). */
const HD_CHASSIS_CAPABLE = new Set(['F-350 Super Duty', '3500', 'Ram 3500', 'Silverado 3500HD', 'Sierra 3500HD']);
/** Cars van records whose nameplate also covers cutaway shuttles and box trucks. */
const CUTAWAY_CAPABLE = new Set(['Ford|E-Series', 'Ford|Transit', 'Chevrolet|Express', 'GMC|Savana']);

const VAN_USES = new Set(['cargo', 'passenger']);
const BODIES = new Set(['cargo_van', 'crew_van', 'passenger_van', 'wheelchair_van', 'shuttle_bus', 'box_truck']);
const BED_TYPES = new Set(['pickup_bed', 'chassis_cab_body']);

function text(value) {
  return String(value == null ? '' : value).trim();
}

function nonNegativeInt(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 60 ? n : null;
}

/** Only these fields are read. Copying them first means the booking object is never touched. */
function snapshotVehicle(vehicle) {
  const v = vehicle && typeof vehicle === 'object' ? vehicle : {};
  const id = vehicleIdentity({
    make: v.make, vehicleMake: v.vehicleMake, model: v.model, vehicleModel: v.vehicleModel,
    year: v.year, vehicleYear: v.vehicleYear, modelYear: v.modelYear,
    vehicleLabel: v.vehicleLabel, label: v.label, vehicle: v.vehicle,
  });
  const configuration = v.vehicleConfiguration && typeof v.vehicleConfiguration === 'object' ? v.vehicleConfiguration : {};
  const pick = (key) => (configuration[key] != null ? configuration[key] : v[key]);
  return {
    cat: text(v.cat || v.category).toLowerCase(),
    tierKey: text(v.tierKey) || null,
    make: id.make,
    model: id.model,
    year: id.year,
    vanUse: VAN_USES.has(text(v.vanUse).toLowerCase()) ? text(v.vanUse).toLowerCase() : null,
    body: BODIES.has(text(pick('body'))) ? text(pick('body')) : null,
    roof: text(pick('roof')) || null,
    length: text(pick('length')) || null,
    passengerCapacity: nonNegativeInt(pick('passengerCapacity')),
    wheelchairPositions: nonNegativeInt(pick('wheelchairPositions')),
    bedType: BED_TYPES.has(text(pick('bedType'))) ? text(pick('bedType')) : null,
  };
}

function result(status, fields) {
  const category = status === STATUS.RESOLVED ? fields.category : (status === STATUS.NOT_APPLICABLE ? null : UNRESOLVED);
  return { status, ...fields, category };
}

/**
 * Classify one Cars & SUVs vehicle without side effects.
 * @returns {{status, category, reason?, missing?, candidates?, known?}}
 */
function classifyBookingVehicle(vehicle) {
  const s = snapshotVehicle(vehicle);
  if (s.cat && s.cat !== 'cars') return result(STATUS.NOT_APPLICABLE, { reason: 'not_cars_category' });
  if (!s.make || !s.model) return result(STATUS.UNRESOLVED, { reason: 'vehicle_identity_missing', missing: ['make', 'model'] });

  const found = CarsCatalog.findVehicleRecord(s.make, s.model);
  const rec = found && found.vehicle;
  if (!rec) return result(STATUS.UNRESOLVED, { reason: 'vehicle_not_in_catalog', missing: [] });
  const key = `${rec.make}|${rec.model}`;
  // Explicit van use: a vanUse field or a "Cargo"/"Passenger" model label. Never the catalog default.
  // A record offered in only one use (e.g. ProMaster: cargo) is a catalog fact, not an inference.
  const singleUse = Array.isArray(rec.vanUseOptions) && rec.vanUseOptions.length === 1 ? rec.vanUseOptions[0] : null;
  const labelUse = found.vanUse && VAN_USES.has(found.vanUse) ? found.vanUse : null;
  const vanUse = s.vanUse || labelUse || singleUse || null;
  const vanUseSource = s.vanUse ? 'field' : (labelUse ? 'model_label' : (singleUse ? 'catalog_single_option' : null));
  const known = { make: rec.make, model: rec.model, vanUse, vanUseSource };

  if (HD_CHASSIS_CAPABLE.has(rec.model)) {
    if (!s.bedType) {
      return result(STATUS.UNRESOLVED, { reason: 'hd_pickup_body_unknown', missing: ['bedType'], candidates: [Channel.CATEGORY.CARS_VEHICLE, Channel.CATEGORY.CHASSIS_CAB_BOX_TRUCK], known });
    }
    const c = Channel.classifyCarsVehicle({ make: rec.make, model: rec.model, year: s.year, bedType: s.bedType });
    return result(STATUS.RESOLVED, { category: c.category, known: { ...known, bedType: s.bedType } });
  }

  const isVan = rec.vehicleFamily === 'van' || !!rec.vanSize;
  if (!isVan) return result(STATUS.RESOLVED, { category: Channel.CATEGORY.CARS_VEHICLE, reason: 'not_a_van_or_hd_pickup' });

  if (VAN_RECORDS_WITHOUT_EQUIVALENT.includes(key)) {
    return result(STATUS.UNRESOLVED, { reason: 'no_commercial_catalog_equivalent', missing: [], candidates: candidatesFor(rec, key), known });
  }

  const modelId = Object.keys(Channel.CARS_EQUIVALENT)
    .find((k) => Channel.CARS_EQUIVALENT[k][0] === rec.make && Channel.CARS_EQUIVALENT[k][1] === rec.model);
  const model = modelId ? CommercialCatalog.getModel(modelId) : null;
  if (!model) return result(STATUS.UNRESOLVED, { reason: 'no_commercial_catalog_equivalent', missing: [], candidates: candidatesFor(rec, key), known });

  const missing = [];
  // Body: cutaway-capable nameplates need it; otherwise van use decides cargo vs passenger.
  let body = s.body;
  if (!body && CUTAWAY_CAPABLE.has(key)) missing.push('body');
  if (!body && !CUTAWAY_CAPABLE.has(key)) {
    if (!vanUse) missing.push('vanUse');
    else body = vanUse === 'passenger' ? 'passenger_van' : 'cargo_van';
  }
  const vanBody = !body || !['shuttle_bus', 'box_truck'].includes(body);
  if (vanBody) {
    if (model.roofs.length && !s.roof) missing.push('roof');
    if (model.lengths.length && !s.length) missing.push('length');
    const seatsMatter = !body || ['passenger_van', 'crew_van', 'wheelchair_van'].includes(body) || s.wheelchairPositions > 0;
    if (seatsMatter && s.passengerCapacity == null) missing.push('passengerCapacity');
    if (s.wheelchairPositions == null && body !== 'wheelchair_van') missing.push('wheelchairAccessible');
    if (body === 'wheelchair_van' && s.wheelchairPositions == null) missing.push('wheelchairPositions');
  }
  if (missing.length) {
    return result(STATUS.UNRESOLVED, { reason: 'configuration_incomplete', missing, candidates: candidatesFor(rec, key), known });
  }

  // Every category-relevant attribute is known: reuse the shared classifier.
  const effectiveBody = body === 'cargo_van' && s.wheelchairPositions > 0 ? 'wheelchair_van' : body;
  const c = Channel.classifyCarsVehicle({
    make: rec.make,
    model: rec.model,
    year: s.year,
    vanUse,
    body: effectiveBody,
    roof: s.roof,
    length: s.length,
    passengerCapacity: s.passengerCapacity,
    wheelchairPositions: s.wheelchairPositions,
  });
  if (c.category === Channel.CATEGORY.UNSUPPORTED) {
    return result(STATUS.UNRESOLVED, { reason: c.reason || c.channel || 'configuration_needs_review', missing: [], known });
  }
  return result(STATUS.RESOLVED, {
    category: c.category,
    sizeClass: c.sizeClass || null,
    policyStatus: Channel.DRAFT_CHANNEL_POLICY.status,
    known: { ...known, body: effectiveBody, roof: s.roof, length: s.length, passengerCapacity: s.passengerCapacity, wheelchairPositions: s.wheelchairPositions },
  });
}

function candidatesFor(rec, key) {
  const C = Channel.CATEGORY;
  if (rec.vanSize && rec.vanSize !== 'full_size') return [C.COMPARABLE_VAN, C.LARGE_COMMERCIAL_VAN];
  const list = [C.COMPARABLE_VAN, C.LARGE_COMMERCIAL_VAN];
  if (CUTAWAY_CAPABLE.has(key)) list.push(C.SHUTTLE_BUS, C.CUTAWAY_BOX_TRUCK);
  return list;
}

function bookingVehicles(booking) {
  if (Array.isArray(booking.vehicles) && booking.vehicles.length) return booking.vehicles;
  return [{ cat: booking.vehicleCategory, vehicleLabel: booking.vehicle || booking.vehicleLabel, make: booking.vehicleMake, model: booking.vehicleModel, year: booking.vehicleYear }];
}

/**
 * Classify every vehicle on a booking. Never throws and never mutates `booking`.
 * @returns {{version, mode, enforced:false, vehicles: Array}}
 */
function shadowClassifyBooking(booking) {
  const out = { version: SHADOW_VERSION, mode: SHADOW_MODE, enforced: false, vehicles: [] };
  try {
    if (!booking || typeof booking !== 'object') return out;
    const list = bookingVehicles(booking);
    for (let i = 0; i < list.length && i < 20; i += 1) {
      try {
        out.vehicles.push({ index: i, ...classifyBookingVehicle(list[i]) });
      } catch (err) {
        out.vehicles.push({ index: i, status: STATUS.ERROR, category: UNRESOLVED, reason: 'classifier_error' });
      }
    }
  } catch (err) {
    out.error = 'classifier_error';
  }
  return out;
}

/** True when a vehicle's result is worth one diagnostic line (vans, HD pickups, errors). */
function isNoteworthy(v) {
  return v.status === STATUS.ERROR || v.status === STATUS.UNRESOLVED
    || (v.status === STATUS.RESOLVED && v.category !== Channel.CATEGORY.CARS_VEHICLE);
}

/**
 * The submit-booking hook. Observe only: logs at most one structured line for a final
 * (non-draft) booking that has a van, an HD pickup, or a classifier error. No customer
 * PII: make, model, tier, category and attribute NAMES only.
 */
function observeBookingVehicles(booking, { isDraft = false, log = console.log } = {}) {
  try {
    if (isDraft) return null;
    // Work on a detached copy so nothing here can reach the live booking object.
    const copy = JSON.parse(JSON.stringify(booking || {}));
    const shadow = shadowClassifyBooking(copy);
    const rows = shadow.vehicles.filter(isNoteworthy).map((v) => {
      const source = (bookingVehicles(copy)[v.index]) || {};
      return {
        i: v.index,
        status: v.status,
        category: v.category,
        reason: v.reason || null,
        missing: v.missing || [],
        make: v.known ? v.known.make : null,
        model: v.known ? v.known.model : null,
        vanUse: v.known ? v.known.vanUse : null,
        tierKey: text(source.tierKey) || null,
      };
    });
    if (!rows.length && !shadow.error) return shadow;
    log('[vehicle-classification-shadow]', JSON.stringify({ v: SHADOW_VERSION, mode: SHADOW_MODE, enforced: false, error: shadow.error || null, vehicles: rows }));
    return shadow;
  } catch (err) {
    return null;
  }
}

module.exports = {
  SHADOW_VERSION,
  SHADOW_MODE,
  STATUS,
  classifyBookingVehicle,
  shadowClassifyBooking,
  observeBookingVehicles,
};
