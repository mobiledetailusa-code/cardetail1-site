// Platform operational settings — single blob `cd1-ops-settings` / key `platform`.
// Operational availability lives in the same store under key `availability`
// (UI-independent contract; not OsCatalogDraft).
const { blobsStore, readJsonStrong } = require('./tech-security');
const {
  normalizeAvailabilityConfig,
  inspectAvailabilityConfig,
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
 * Availability read contract (Phase 1 — no silent legacy fallback).
 *
 *   never saved (key absent)  → { ok: true, source: 'default' } legacy defaults
 *   saved and valid           → { ok: true, source: 'stored' }
 *   read error after retries  → { ok: false, error: 'availability_unavailable', reason: 'read_failed' }
 *   saved but invalid         → { ok: false, error: 'availability_unavailable', reason: 'invalid_config:*' }
 *
 * Callers fail closed on ok:false: no date is offered or accepted on a
 * configuration we could not read. There is deliberately no last-known-good
 * copy: Netlify Blobs is the only shared store, so a second blob would fail
 * together with the first and a process-local copy cannot be kept consistent
 * across function instances (docs/availability/README.md).
 */
const AVAILABILITY_READ_ATTEMPTS = 3;
const AVAILABILITY_RETRY_DELAYS_MS = [150, 400];

let _availabilityStoreOverride = null;
/** Test seam — an in-memory store with get/getWithMetadata/setJSON. */
function setAvailabilityStoreOverride(store) {
  _availabilityStoreOverride = store || null;
}

async function availabilityStore() {
  if (_availabilityStoreOverride) return _availabilityStoreOverride;
  return blobsStore(SETTINGS_STORE);
}

class AvailabilityUnavailableError extends Error {
  constructor(reason) {
    super('availability_unavailable');
    this.code = 'availability_unavailable';
    this.reason = reason || 'read_failed';
  }
}

function isAvailabilityUnavailable(err) {
  return !!(err && err.code === 'availability_unavailable');
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadOperationalAvailability(opts = {}) {
  const attempts = Math.max(1, Math.floor(Number(opts.attempts)) || AVAILABILITY_READ_ATTEMPTS);
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : defaultSleep;
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const store = await availabilityStore();
      const { data, etag } = await readJsonStrong(store, AVAILABILITY_KEY);
      if (data == null) {
        return {
          ok: true,
          source: 'default',
          config: normalizeAvailabilityConfig(null),
          etag: null,
          revision: 0,
        };
      }
      const check = inspectAvailabilityConfig(data);
      if (!check.valid) {
        console.error('[availability] invalid_config', {
          reason: check.reason,
          updatedAt: data && data.updatedAt ? String(data.updatedAt) : null,
        });
        return {
          ok: false,
          error: 'availability_unavailable',
          reason: `invalid_config:${check.reason}`,
          retryable: false,
        };
      }
      const config = normalizeAvailabilityConfig(data);
      return { ok: true, source: 'stored', config, etag: etag || null, revision: config.revision };
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) await sleep(AVAILABILITY_RETRY_DELAYS_MS[i] || 400);
    }
  }
  const cause = lastError && (lastError.cause || lastError);
  console.error('[availability] read_failed', {
    attempts,
    message: cause && cause.message ? String(cause.message).slice(0, 200) : String(cause),
  });
  return { ok: false, error: 'availability_unavailable', reason: 'read_failed', retryable: true };
}

/**
 * Config for schedule decisions. Throws AvailabilityUnavailableError instead
 * of returning legacy defaults when the saved configuration cannot be used.
 */
async function getOperationalAvailability(opts = {}) {
  const loaded = await loadOperationalAvailability(opts);
  if (!loaded.ok) throw new AvailabilityUnavailableError(loaded.reason);
  return loaded.config;
}

/**
 * Persist availability after normalization with optimistic concurrency.
 * `meta.etag` (from loadOperationalAvailability) makes the write conditional,
 * so two admin tabs can never overwrite each other; `meta.expectNew` is used
 * when nothing was stored yet. Returns { ok:false, error:'version_conflict' }
 * when another write landed first.
 */
async function saveOperationalAvailability(nextRaw, meta = {}) {
  const baseRevision = Math.max(0, Math.floor(Number(meta.baseRevision ?? nextRaw?.revision)) || 0);
  const normalized = normalizeAvailabilityConfig({
    ...(nextRaw || {}),
    revision: baseRevision + 1,
    updatedAt: new Date().toISOString(),
    updatedBy: meta.updatedBy || nextRaw?.updatedBy || null,
  });
  const store = await availabilityStore();
  let result;
  if (meta.etag) {
    result = await store.setJSON(AVAILABILITY_KEY, normalized, { onlyIfMatch: meta.etag });
  } else if (meta.expectNew) {
    result = await store.setJSON(AVAILABILITY_KEY, normalized, { onlyIfNew: true });
  } else {
    result = await store.setJSON(AVAILABILITY_KEY, normalized);
  }
  if (result && result.modified === false) {
    return { ok: false, error: 'version_conflict' };
  }
  return { ok: true, config: normalized, availability: projectAdminAvailability(normalized) };
}

module.exports = {
  AVAILABILITY_READ_ATTEMPTS,
  AvailabilityUnavailableError,
  isAvailabilityUnavailable,
  setAvailabilityStoreOverride,
  loadOperationalAvailability,
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
