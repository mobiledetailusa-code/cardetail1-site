// Customer change-request queue — authoritative request records for admin review.

const crypto = require('crypto');
const { blobsStore } = require('./tech-security');
const { asArray } = require('./historical-adapter');

const REQUEST_STORE = 'cd1-customer-change-requests';

const OPEN_STATUSES = new Set(['pending', 'pending_approval', 'needs_clarification', 'awaiting_admin']);
const MONEY_REQUEST_TYPES = new Set([
  'package_change_request',
  'addon_request',
  'addon_remove_request',
  'vehicle_add_request',
  'vehicle_replace_request',
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
  return updated;
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
};
