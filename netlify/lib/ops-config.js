// Platform operational settings — single blob `cd1-ops-settings` / key `platform`.
// Operational availability lives in the same store under key `availability`
// (UI-independent contract; not OsCatalogDraft).
const { blobsStore } = require('./tech-security');
const {
  LEGACY_AVAILABILITY,
  normalizeAvailabilityConfig,
  projectAdminAvailability,
} = require('./operational-availability');

const SETTINGS_STORE = 'cd1-ops-settings';
const SETTINGS_KEY = 'platform';
const AVAILABILITY_KEY = 'availability';

const DEFAULT_SETTINGS = {
  // Auto-confirm: recommended OFF until rules mature (zone, card on file, fraud checks).
  autoConfirmAppointments: false,
  autoPostToAuctionOnConfirm: false,
  dispatchMode: 'manual', // manual | auction | auto_assign_lowest_bid
  bidMaxPercent: 85,
  bidMaxOverride: null,
  bidWindowMinutes: 60,
  bidWindowMinutesBoatRv: 90,
  requireCompoundExperience: true,
  minTechRatingToBid: 3.0,
  maintenancePlansEnabled: true,
  contractorAgreementVersion: 'v1',
  updatedAt: null,
};

const MAINTENANCE_PLAN_TEMPLATES = [
  { id: 'maint-monthly', name: 'Monthly Maintenance', intervalMonths: 1, suggestedPrice: 79 },
  { id: 'maint-bimonthly', name: 'Every 2 Months', intervalMonths: 2, suggestedPrice: 99 },
  { id: 'maint-quarterly', name: 'Quarterly', intervalMonths: 3, suggestedPrice: 119 },
  { id: 'maint-biannual', name: 'Every 6 Months', intervalMonths: 6, suggestedPrice: 149 },
  { id: 'maint-annual', name: 'Annual Detail', intervalMonths: 12, suggestedPrice: 199 },
];

async function getOpsSettings() {
  const store = await blobsStore(SETTINGS_STORE);
  const raw = await store.get(SETTINGS_KEY, { type: 'json' }).catch(() => null);
  return { ...DEFAULT_SETTINGS, ...(raw || {}) };
}

async function saveOpsSettings(patches) {
  const store = await blobsStore(SETTINGS_STORE);
  const current = await getOpsSettings();
  const next = { ...current, ...patches, updatedAt: new Date().toISOString() };
  await store.setJSON(SETTINGS_KEY, next);
  return next;
}

function calcBidMax(customerTotal, settings) {
  if (settings.bidMaxOverride != null && settings.bidMaxOverride > 0) {
    return Math.round(Number(settings.bidMaxOverride) * 100) / 100;
  }
  const total = Number(customerTotal) || 0;
  const pct = Number(settings.bidMaxPercent) || 85;
  if (total <= 0) return null;
  return Math.round(total * pct) / 100;
}

function bidWindowForJob(booking, settings) {
  const hay = [
    booking.package, booking.service, booking.vehicle, booking.vehicleLabel,
  ].join(' ').toLowerCase();
  if (/boat|rv|motorhome|trailer|yacht|marine/.test(hay)) {
    return Number(settings.bidWindowMinutesBoatRv) || 90;
  }
  return Number(settings.bidWindowMinutes) || 60;
}

/**
 * Load operational availability. Missing/invalid → complete legacy defaults.
 * Never partially merges invalid rules.
 */
async function getOperationalAvailability() {
  try {
    const store = await blobsStore(SETTINGS_STORE);
    const raw = await store.get(AVAILABILITY_KEY, { type: 'json' }).catch(() => null);
    return normalizeAvailabilityConfig(raw || LEGACY_AVAILABILITY);
  } catch (_) {
    return normalizeAvailabilityConfig(null);
  }
}

/**
 * Persist availability after normalization. Rejects invalid payloads by
 * falling back to legacy (caller should validate intent first).
 */
async function saveOperationalAvailability(nextRaw, meta = {}) {
  const normalized = normalizeAvailabilityConfig({
    ...(nextRaw || {}),
    updatedAt: new Date().toISOString(),
    updatedBy: meta.updatedBy || nextRaw?.updatedBy || null,
  });
  // If caller intended supervised but normalize demoted due to bad input, surface it.
  const store = await blobsStore(SETTINGS_STORE);
  await store.setJSON(AVAILABILITY_KEY, normalized);
  return projectAdminAvailability(normalized);
}

module.exports = {
  SETTINGS_STORE,
  SETTINGS_KEY,
  AVAILABILITY_KEY,
  DEFAULT_SETTINGS,
  MAINTENANCE_PLAN_TEMPLATES,
  getOpsSettings,
  saveOpsSettings,
  getOperationalAvailability,
  saveOperationalAvailability,
  calcBidMax,
  bidWindowForJob,
};
