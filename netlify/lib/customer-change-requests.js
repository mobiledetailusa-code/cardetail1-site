// Customer change-request queue — authoritative request records for admin review.

const crypto = require('crypto');
const { blobsStore } = require('./tech-security');

const REQUEST_STORE = 'cd1-customer-change-requests';

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
    (blobs || []).map((b) => store.get(b.key, { type: 'json' }).catch(() => null))
  );
  return items.filter((r) => r && r.bookingId === bookingId);
}

async function updateRequest(id, patch) {
  const store = await blobsStore(REQUEST_STORE);
  const existing = await store.get(id, { type: 'json' });
  if (!existing) return null;
  const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  await store.setJSON(id, updated);
  return updated;
}

module.exports = {
  REQUEST_STORE,
  requestId,
  sanitizeSnapshot,
  createChangeRequest,
  listRequestsForBooking,
  updateRequest,
};
