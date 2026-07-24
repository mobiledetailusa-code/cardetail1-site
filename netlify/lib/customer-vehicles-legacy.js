/**
 * Legacy My Vehicles Blob store — READ-ONLY migration source (Stage 2B).
 *
 * Store: cd1-customer-vehicles
 * Key:   owner_<10-digit-phone>
 *
 * Do not write through this module after Stage 2B cutover.
 * Blob records are retained for post-soak cleanup (separate decision).
 */

const { blobsStore } = require('./tech-security');

const VEHICLE_STORE = 'cd1-customer-vehicles';

const ALLOWED_CATEGORIES = new Set([
  'car', 'suv', 'truck', 'van', 'boat', 'rv', 'motorcycle', 'atv', 'other',
]);

function ownerKey(phoneDigits) {
  return `owner_${String(phoneDigits || '').replace(/\D/g, '').slice(0, 10)}`;
}

function normalizeLegacyVehicleFields(input = {}) {
  const category = String(input?.category || input?.vehicleCategory || 'car').toLowerCase();
  return {
    label: String(input?.label || input?.vehicleLabel || '').slice(0, 120).trim(),
    category: ALLOWED_CATEGORIES.has(category) ? category : 'car',
    color: String(input?.color || '').slice(0, 40).trim(),
    notes: String(input?.notes || '').slice(0, 500).trim(),
    year: String(input?.year || '').slice(0, 4).trim(),
    make: String(input?.make || '').slice(0, 60).trim(),
    model: String(input?.model || '').slice(0, 60).trim(),
  };
}

const LEGACY_SOURCE_UNAVAILABLE = 'legacy_vehicle_source_unavailable';

/**
 * Netlify Blobs SDK (@netlify/blobs): missing key → HTTP 404 → null.
 * Other statuses / parse failures throw (do not treat as empty).
 */
function isMissingBlobKeyResult(value) {
  return value == null;
}

function legacySourceUnavailableError(causeCode = 'blob_read_failed') {
  const err = new Error(LEGACY_SOURCE_UNAVAILABLE);
  err.code = LEGACY_SOURCE_UNAVAILABLE;
  err.causeCode = String(causeCode || 'blob_read_failed').slice(0, 64);
  return err;
}

/**
 * Read legacy Blob vehicles for a normalized phone. Never mutates Blob.
 *
 * Success shapes:
 * - missing key → { ok: true, missing: true, vehicles: [] }
 * - present payload → { ok: true, missing: false, vehicles: [...] }
 *
 * Read/transport/parse/malformed failures throw legacy_vehicle_source_unavailable
 * so importers do not commit vehiclesImportedAt.
 */
async function readLegacyVehiclesForPhone(phoneDigits, opts = {}) {
  const digits = String(phoneDigits || '').replace(/\D/g, '').slice(0, 10);
  if (!digits || digits.length < 10) {
    return {
      ok: true,
      missing: true,
      phoneDigits: digits || null,
      vehicles: [],
      key: null,
    };
  }

  let store;
  try {
    store = opts.store || await blobsStore(VEHICLE_STORE);
  } catch {
    throw legacySourceUnavailableError('blob_store_unavailable');
  }

  const key = ownerKey(digits);
  let data;
  try {
    data = await store.get(key, { type: 'json' });
  } catch {
    // Do not swallow — transient Blob failures must retry on next access.
    throw legacySourceUnavailableError('blob_get_failed');
  }

  if (isMissingBlobKeyResult(data)) {
    return {
      ok: true,
      missing: true,
      phoneDigits: digits,
      vehicles: [],
      key,
    };
  }

  // Present but unreadable/malformed garage payload — fail closed (retry later).
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw legacySourceUnavailableError('blob_payload_malformed');
  }
  if (
    Object.prototype.hasOwnProperty.call(data, 'vehicles')
    && data.vehicles != null
    && !Array.isArray(data.vehicles)
  ) {
    throw legacySourceUnavailableError('blob_vehicles_malformed');
  }

  const vehicles = Array.isArray(data.vehicles) ? data.vehicles : [];
  return {
    ok: true,
    missing: false,
    phoneDigits: digits,
    vehicles,
    key,
  };
}

module.exports = {
  VEHICLE_STORE,
  ALLOWED_CATEGORIES,
  LEGACY_SOURCE_UNAVAILABLE,
  ownerKey,
  normalizeLegacyVehicleFields,
  isMissingBlobKeyResult,
  legacySourceUnavailableError,
  readLegacyVehiclesForPhone,
};
