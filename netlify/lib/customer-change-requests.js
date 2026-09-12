// Customer change-request queue — authoritative request records for admin review.

const crypto = require('crypto');
const { blobsStore } = require('./tech-security');
const { asArray } = require('./historical-adapter');

const REQUEST_STORE = 'cd1-customer-change-requests';
const OPEN_CATALOG_KEY = '_open_catalog';
const HYDRATE_CONCURRENCY = 40;

const OPEN_STATUSES = new Set(['pending', 'pending_approval', 'needs_clarification', 'awaiting_admin']);
const MONEY_REQUEST_TYPES = new Set([
  'package_change_request',
  'addon_request',
  'addon_remove_request',
  'vehicle_add_request',
  'vehicle_replace_request',
  'vehicle_remove_request',
]);

function requestId() {
  return `cr_${crypto.randomBytes(10).toString('base64url')}`;
}

function sanitizeSnapshot(booking) {
  if (!booking || typeof booking !== 'object') return {};
  return {
    status: booking.status || '',
    package: booking.package || booking.service || '',
    preferredDate: booking.preferredDate || '',
    preferredTime: booking.preferredTime || '',
    address: booking.address || '',
    vehicleCount: Array.isArray(booking.vehicles) ? booking.vehicles.length : 0,
  };
}

async function createChangeRequest({
  bookingId,
  requestType,
  previousState,
  requestedState,
  authorizedRef,
  status = 'pending',
}) {
  const store = await blobsStore(REQUEST_STORE);
  const id = requestId();
  const now = new Date().toISOString();
  const record = {
    id,
    bookingId,
    requestType,
    previousState: previousState || {},
    requestedState: requestedState || {},
    authorizedRef: authorizedRef || 'booking',
    status,
    adminDecision: '',
    adminNote: '',
    createdAt: now,
    decidedAt: '',
    customerVisibleResult: '',
    notificationStatus: 'pending',
  };
  await store.setJSON(id, record);
  await syncOpenCatalog(store, record);
  return record;
}

async function listRequestsForBooking(bookingId) {
  const store = await blobsStore(REQUEST_STORE);
  const { blobs } = await store.list({ prefix: 'cr_' });
  const items = await Promise.all(
    (blobs || []).map(async (b) => {
      if (typeof store.getWithMetadata === 'function') {
        const result = await store.getWithMetadata(b.key, {
          type: 'json',
          consistency: 'strong',
        }).catch(() => null);
        if (result && result.data) return result.data;
      }
      return store.get(b.key, { type: 'json' }).catch(() => null);
    })
  );
  return items.filter((r) => r && r.bookingId === bookingId);
}

/**
 * Merge index rows with booking.changeRequests (booking status wins).
 * Hides money requests once the invoice is paid/closed.
 */
function resolveCustomerVisibleRequests(booking, indexRows = []) {
  const byId = new Map();
  for (const r of asArray(indexRows)) {
    if (!r || !r.id) continue;
    byId.set(String(r.id), { ...r });
  }
  for (const r of asArray(booking?.changeRequests)) {
    const id = String(r.requestId || r.id || '').trim();
    if (!id) continue;
    const prev = byId.get(id) || {};
    byId.set(id, {
      ...prev,
      ...r,
      id,
      bookingId: booking.id || booking.bookingId || prev.bookingId,
      requestType: r.requestType || r.type || prev.requestType,
      status: r.status || prev.status,
      requestedState: r.delta || r.requestedState || prev.requestedState || {},
    });
  }

  let rows = [...byId.values()].filter((r) => OPEN_STATUSES.has(String(r.status || '').toLowerCase()));

  let invoicePaid = false;
  try {
    const { isInvoicePaid } = require('./appointment-status-policy');
    invoicePaid = isInvoicePaid(booking);
  } catch { /* ignore */ }

  if (invoicePaid) {
    rows = rows.filter((r) => !MONEY_REQUEST_TYPES.has(String(r.requestType || r.type || '')));
  }

  return rows.sort((a, b) => String(b.createdAt || b.submittedAt || '').localeCompare(String(a.createdAt || a.submittedAt || '')));
}

async function listVisibleRequestsForBooking(booking) {
  const bookingId = booking?.id || booking?.bookingId;
  if (!bookingId) return [];
  const indexRows = await listRequestsForBooking(bookingId);
  return resolveCustomerVisibleRequests(booking, indexRows);
}

async function updateRequest(id, patch) {
  const store = await blobsStore(REQUEST_STORE);
  let existing = null;
  if (typeof store.getWithMetadata === 'function') {
    const result = await store.getWithMetadata(id, { type: 'json', consistency: 'strong' }).catch(() => null);
    existing = result && result.data;
  }
  if (!existing) existing = await store.get(id, { type: 'json' });
  if (!existing) return null;
  const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  await store.setJSON(id, updated);
  await syncOpenCatalog(store, updated);
  return updated;
}

function isCatalogKey(key) {
  return String(key || '') === OPEN_CATALOG_KEY || String(key || '').startsWith('_');
}

async function readOpenCatalog(store) {
  try {
    const raw = await store.get(OPEN_CATALOG_KEY, { type: 'json' }).catch(() => null);
    if (!raw || !Array.isArray(raw.ids)) return null;
    return {
      v: raw.v || 1,
      ids: raw.ids.map((id) => String(id || '').trim()).filter(Boolean),
      updatedAt: raw.updatedAt || '',
    };
  } catch {
    return null;
  }
}

async function writeOpenCatalog(store, ids) {
  const next = {
    v: 1,
    ids: [...new Set((ids || []).map((id) => String(id || '').trim()).filter(Boolean))],
    updatedAt: new Date().toISOString(),
  };
  await store.setJSON(OPEN_CATALOG_KEY, next);
  return next;
}

async function patchOpenCatalog(store, mutator) {
  let etag = null;
  let currentIds = [];
  if (typeof store.getWithMetadata === 'function') {
    const result = await store.getWithMetadata(OPEN_CATALOG_KEY, {
      type: 'json',
      consistency: 'strong',
    }).catch(() => null);
    if (result && result.data && Array.isArray(result.data.ids)) {
      currentIds = result.data.ids;
    }
    etag = result && result.etag;
  } else {
    const data = await store.get(OPEN_CATALOG_KEY, { type: 'json' }).catch(() => null);
    if (data && Array.isArray(data.ids)) currentIds = data.ids;
  }
  const ids = new Set(currentIds.map((id) => String(id || '').trim()).filter(Boolean));
  mutator(ids);
  const next = {
    v: 1,
    ids: [...ids],
    updatedAt: new Date().toISOString(),
  };
  const opts = etag ? { onlyIfMatch: etag } : undefined;
  const written = await store.setJSON(OPEN_CATALOG_KEY, next, opts);
  if (written && written.modified === false) {
    throw new Error('open_catalog_cas_conflict');
  }
}

async function syncOpenCatalog(store, record) {
  const id = String(record?.id || record?.requestId || '').trim();
  if (!id || isCatalogKey(id)) return;
  const open = OPEN_STATUSES.has(String(record.status || '').toLowerCase());
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await patchOpenCatalog(store, (ids) => {
          if (open) ids.add(id);
          else ids.delete(id);
        });
        return;
      } catch (err) {
        if (String(err && err.message) !== 'open_catalog_cas_conflict' || attempt === 2) throw err;
      }
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.warn('[change-requests] open_catalog_sync_failed', message);
    try {
      if (typeof store.delete === 'function') await store.delete(OPEN_CATALOG_KEY);
    } catch (_) { /* next list falls back to a full scan */ }
  }
}

/**
 * Admin/customer list reads — one eventual GET per key, bounded concurrency.
 * Strong consistency stays on decide/mutate.
 */
async function hydrateRequestRecords(store, blobs) {
  const keys = (blobs || [])
    .map((b) => (typeof b === 'string' ? b : (b && b.key)))
    .map((k) => String(k || '').trim())
    .filter((k) => k && !isCatalogKey(k));
  const records = [];
  for (let i = 0; i < keys.length; i += HYDRATE_CONCURRENCY) {
    const chunk = keys.slice(i, i + HYDRATE_CONCURRENCY);
    const rows = await Promise.all(
      chunk.map((key) => store.get(key, { type: 'json' }).catch(() => null))
    );
    for (const row of rows) if (row) records.push(row);
  }
  return records;
}

/**
 * Mark open money change requests superseded after invoice settlement.
 */
function supersedeMoneyRequestsOnSettle(changeRequests, { at } = {}) {
  const now = at || new Date().toISOString();
  return asArray(changeRequests).map((r) => {
    const status = String(r.status || '').toLowerCase();
    const type = r.requestType || r.type;
    if (!OPEN_STATUSES.has(status) || !MONEY_REQUEST_TYPES.has(type)) return r;
    return {
      ...r,
      status: 'superseded',
      decision: 'reject',
      adminNote: 'Superseded — invoice paid/closed.',
      decidedAt: now,
      customerVisibleResult: 'This request was closed because the invoice is paid.',
    };
  });
}

module.exports = {
  REQUEST_STORE,
  OPEN_CATALOG_KEY,
  OPEN_STATUSES,
  MONEY_REQUEST_TYPES,
  requestId,
  sanitizeSnapshot,
  createChangeRequest,
  listRequestsForBooking,
  listVisibleRequestsForBooking,
  resolveCustomerVisibleRequests,
  supersedeMoneyRequestsOnSettle,
  updateRequest,
  readOpenCatalog,
  writeOpenCatalog,
  syncOpenCatalog,
  hydrateRequestRecords,
};
