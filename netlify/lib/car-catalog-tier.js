'use strict';

/**
 * Server authority for cars vehicle class.
 *
 * The official class comes from data/cars-vehicle-catalog.json through
 * assets/vehicle-catalog.js. This module does not keep a second class table
 * and does not replace a submitted tierKey.
 *
 * catalogTierMode is chosen by server code, never by the request body:
 *   known_only       — a recognized public vehicle must use its catalog class.
 *                      Unrecognized free text may keep an explicit valid tier.
 *   require_identity — same rule, and a named make/model that does not resolve
 *                      to one public class is rejected (public booking and
 *                      public offer preview).
 */

const Catalog = require('../../assets/vehicle-catalog');

const CLIENT_TIER_AUTHORITY_FIELDS = Object.freeze([
  'catalogTierMode',
  'catalogTierOverride',
  'adminTierOverride',
]);

function text(value) {
  return String(value == null ? '' : value).trim();
}

function parseYear(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (!/^(19|20)\d{2}$/.test(raw)) return null;
  return Number(raw);
}

function leadingLabelYear(label) {
  const match = text(label).match(/^(19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function splitMakePrefix(raw) {
  const source = text(raw);
  if (!source) return null;
  const makes = Catalog.getMakes().slice().sort(
    (a, b) => Catalog.normKey(b).length - Catalog.normKey(a).length
  );
  for (const make of makes) {
    const target = Catalog.normKey(make);
    if (!target) continue;
    for (let i = 0; i < source.length; i += 1) {
      if (Catalog.normKey(source.slice(0, i + 1)) !== target) continue;
      const boundary = source[i + 1];
      if (boundary && /[A-Za-z0-9]/.test(boundary)) break;
      return { make, model: source.slice(i + 1).trim() };
    }
  }
  return null;
}

function vehicleIdentity(vehicle) {
  const label = text(vehicle.vehicleLabel || vehicle.label || vehicle.vehicle);
  const explicitMake = text(vehicle.make || vehicle.vehicleMake);
  const explicitModel = text(vehicle.model || vehicle.vehicleModel);
  const year = parseYear(vehicle.year ?? vehicle.vehicleYear ?? vehicle.modelYear)
    || leadingLabelYear(label);

  if (explicitMake || explicitModel) {
    return { make: explicitMake, model: explicitModel, year, attempted: true };
  }

  const head = label.replace(/^(19|20)\d{2}\b\s*/, '').split('·')[0].trim();
  const parsed = splitMakePrefix(head);
  if (!parsed) return { make: '', model: '', year, attempted: false };
  return { make: parsed.make, model: parsed.model, year, attempted: true };
}

function distinctBandClasses(record) {
  const classes = new Set();
  for (const band of record.years || []) {
    if (band && band.class) classes.add(String(band.class));
  }
  return classes;
}

function yearInBand(record, year) {
  if (year == null) return false;
  return (record.years || []).some((band) => {
    const from = band.from == null ? -Infinity : Number(band.from);
    const to = band.to == null ? Infinity : Number(band.to);
    return year >= from && year <= to;
  });
}

/**
 * @returns {{ok:true}|{ok:false,error:string}}
 * Recognized vehicles never proceed on a different class. Nothing here
 * rewrites tierKey or reveals the catalog class.
 */
function assertCarCatalogTier(vehicle, claimedTierKey, opts) {
  const mode = opts && opts.catalogTierMode === 'require_identity'
    ? 'require_identity'
    : 'known_only';
  const identity = vehicleIdentity(vehicle || {});
  if (!identity.attempted) return { ok: true };

  const found = identity.make && identity.model
    ? Catalog.findVehicleRecord(identity.make, identity.model)
    : null;
  const record = found && found.vehicle && found.vehicle.public !== false
    ? found.vehicle
    : null;

  if (!record) {
    if (mode === 'require_identity') return { ok: false, error: 'vehicle_unresolved' };
    return { ok: true };
  }

  const classes = distinctBandClasses(record);
  if (classes.size > 1 && !yearInBand(record, identity.year)) {
    return { ok: false, error: 'vehicle_unresolved' };
  }

  const resolved = Catalog.resolveVehicle({
    make: identity.make,
    model: identity.model,
    year: identity.year || undefined,
    vanUse: vehicle.vanUse || undefined,
  });
  if (!resolved.ok || resolved.public === false || !resolved.tierKey) {
    if (mode === 'require_identity') return { ok: false, error: 'vehicle_unresolved' };
    return { ok: true };
  }

  if (claimedTierKey !== resolved.tierKey) {
    return { ok: false, error: 'tier_mismatch' };
  }
  return { ok: true };
}

function stripClientCatalogTierAuthority(booking) {
  if (!booking || typeof booking !== 'object') return booking;
  for (const field of CLIENT_TIER_AUTHORITY_FIELDS) delete booking[field];
  if (Array.isArray(booking.vehicles)) {
    for (const vehicle of booking.vehicles) {
      if (!vehicle || typeof vehicle !== 'object') continue;
      for (const field of CLIENT_TIER_AUTHORITY_FIELDS) delete vehicle[field];
    }
  }
  return booking;
}

module.exports = {
  CLIENT_TIER_AUTHORITY_FIELDS,
  assertCarCatalogTier,
  stripClientCatalogTierAuthority,
  vehicleIdentity,
};
