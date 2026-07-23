/**
 * Compatibility shim — Stage 2B.
 *
 * Live authority is PostgreSQL CustomerVehicle via customer-vehicle-service.
 * This module re-exports legacy Blob READ helpers and keeps normalize helpers
 * for tests that still import them. Write APIs are intentionally removed.
 */

const legacy = require('./customer-vehicles-legacy');

module.exports = {
  VEHICLE_STORE: legacy.VEHICLE_STORE,
  ALLOWED_CATEGORIES: legacy.ALLOWED_CATEGORIES,
  ownerKey: legacy.ownerKey,
  normalizeVehicleInput: legacy.normalizeLegacyVehicleFields,
  listVehiclesForOwner: async (phoneDigits) => {
    const r = await legacy.readLegacyVehiclesForPhone(phoneDigits);
    return (r.vehicles || []).filter((v) => !v.archived && !v.archivedAt);
  },
  // Writes disabled — callers must use customer-vehicle-service.
  addVehicle: async () => ({
    ok: false,
    error: 'unavailable',
    message: 'Legacy Blob vehicle writes are disabled. Use CustomerAccount vehicles.',
  }),
  updateVehicle: async () => ({
    ok: false,
    error: 'unavailable',
    message: 'Legacy Blob vehicle writes are disabled. Use CustomerAccount vehicles.',
  }),
  archiveVehicle: async () => ({
    ok: false,
    error: 'unavailable',
    message: 'Legacy Blob vehicle writes are disabled. Use CustomerAccount vehicles.',
  }),
};
