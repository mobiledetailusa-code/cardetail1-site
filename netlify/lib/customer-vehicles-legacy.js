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

/**
 * Read legacy Blob vehicles for a normalized phone. Never mutates Blob.
 * Returns all entries (including archived) so importers can filter.
 */
async function readLegacyVehiclesForPhone(phoneDigits, opts = {}) {
  const digits = String(phoneDigits || '').replace(/\D/g, '').slice(0, 10);
  if (!digits || digits.length < 10) {
    return { ok: true, phoneDigits: digits || null, vehicles: [], key: null };
  }
  const store = opts.store || await blobsStore(VEHICLE_STORE);
  const key = ownerKey(digits);
  const data = await store.get(key, { type: 'json' }).catch(() => null);
  const vehicles = Array.isArray(data?.vehicles) ? data.vehicles : [];
  return { ok: true, phoneDigits: digits, vehicles, key };
}

module.exports = {
  VEHICLE_STORE,
  ALLOWED_CATEGORIES,
  ownerKey,
  normalizeLegacyVehicleFields,
  readLegacyVehiclesForPhone,
};
