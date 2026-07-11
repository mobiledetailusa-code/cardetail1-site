// Private customer vehicle garage — account-scoped, never auto-modifies appointments.

const crypto = require('crypto');
const { blobsStore } = require('./tech-security');

const VEHICLE_STORE = 'cd1-customer-vehicles';

const ALLOWED_CATEGORIES = new Set([
  'car', 'suv', 'truck', 'van', 'boat', 'rv', 'motorcycle', 'atv', 'other',
]);

function vehicleId() {
  return `cv_${crypto.randomBytes(10).toString('base64url')}`;
}

function ownerKey(phoneDigits) {
  return `owner_${String(phoneDigits || '').replace(/\D/g, '').slice(0, 10)}`;
}

function normalizeVehicleInput(input) {
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

async function listVehiclesForOwner(phoneDigits) {
  const store = await blobsStore(VEHICLE_STORE);
  const key = ownerKey(phoneDigits);
  const data = await store.get(key, { type: 'json' }).catch(() => null);
  const vehicles = Array.isArray(data?.vehicles) ? data.vehicles : [];
  return vehicles.filter((v) => !v.archived);
}

async function saveVehiclesForOwner(phoneDigits, vehicles) {
  const store = await blobsStore(VEHICLE_STORE);
  const key = ownerKey(phoneDigits);
  await store.setJSON(key, {
    phoneDigits: String(phoneDigits).slice(0, 10),
    vehicles,
    updatedAt: new Date().toISOString(),
  });
}

async function addVehicle(phoneDigits, input) {
  const normalized = normalizeVehicleInput(input);
  if (!normalized.label && !(normalized.make && normalized.model)) {
    return { ok: false, error: 'validation_error', message: 'Vehicle label or make/model is required.' };
  }
  const vehicles = await listVehiclesForOwner(phoneDigits);
  const entry = {
    id: vehicleId(),
    ...normalized,
    archived: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  vehicles.push(entry);
  await saveVehiclesForOwner(phoneDigits, vehicles);
  return { ok: true, vehicle: entry };
}

async function updateVehicle(phoneDigits, vehicleIdRaw, patch) {
  const vehicles = await listVehiclesForOwner(phoneDigits);
  const idx = vehicles.findIndex((v) => v.id === vehicleIdRaw);
  if (idx < 0) return { ok: false, error: 'not_found' };
  const merged = { ...vehicles[idx], ...normalizeVehicleInput({ ...vehicles[idx], ...patch }), updatedAt: new Date().toISOString() };
  vehicles[idx] = merged;
  await saveVehiclesForOwner(phoneDigits, vehicles);
  return { ok: true, vehicle: merged };
}

async function archiveVehicle(phoneDigits, vehicleIdRaw) {
  const store = await blobsStore(VEHICLE_STORE);
  const key = ownerKey(phoneDigits);
  const data = await store.get(key, { type: 'json' }).catch(() => null);
  const vehicles = Array.isArray(data?.vehicles) ? data.vehicles : [];
  const idx = vehicles.findIndex((v) => v.id === vehicleIdRaw);
  if (idx < 0) return { ok: false, error: 'not_found' };
  vehicles[idx] = { ...vehicles[idx], archived: true, archivedAt: new Date().toISOString() };
  await saveVehiclesForOwner(phoneDigits, vehicles);
  return { ok: true };
}

module.exports = {
  VEHICLE_STORE,
  ALLOWED_CATEGORIES,
  listVehiclesForOwner,
  addVehicle,
  updateVehicle,
  archiveVehicle,
  normalizeVehicleInput,
};
