// Unified operational DB layer — all channels read/write cd1-bookings through here.
const { blobsStore, listAllBlobs, fetchBlobRecords } = require('./tech-security');
const { BOOKINGS_STORE } = require('./ops-schema');
const { appendEventLog, normalizeJobStatus, normalizePaymentWorkflowStatus } = require('./ops-workflow');
const { isVisibleSubmittedBooking } = require('./booking-visibility');
const { adaptHistoricalBooking } = require('./historical-adapter');

let _opsStoreOverride = null;

function setOpsStoreOverride(store) {
  _opsStoreOverride = store || null;
}

async function bookingStore() {
  if (_opsStoreOverride) return _opsStoreOverride;
  return blobsStore(BOOKINGS_STORE);
}

async function getBooking(bookingId) {
  const store = await bookingStore();
  const raw = await store.get(bookingId, { type: 'json' }).catch(() => null);
  if (!raw) return null;
  const adapted = adaptHistoricalBooking(raw);
  return adapted.ok ? adapted.booking : raw;
}

async function patchBooking(bookingId, patches, eventEntry) {
  const { getBookingRecord, commitBooking } = require('./booking-repository');
  const { buildNextAggregate, normalizeAggregate } = require('./booking-aggregate');
  const current = await getBookingRecord(bookingId);
  if (!current.exists) return null;
  const { ok, aggregate } = normalizeAggregate(current.booking, { allowDraft: true });
  const base = ok ? aggregate : current.booking;
  const now = new Date().toISOString();
  const next = buildNextAggregate(base, {
    ...patches,
    jobStatus: patches.jobStatus || base.jobStatus,
    eventLog: eventEntry ? appendEventLog(base, eventEntry) : (base.eventLog || []),
    updatedAt: now,
  });
  next.jobStatus = normalizeJobStatus(next);
  if (!next.paymentWorkflowStatus && patches.paymentWorkflowStatus === undefined) {
    next.paymentWorkflowStatus = normalizePaymentWorkflowStatus(next);
  }
  const committed = await commitBooking({
    bookingId,
    expectedBookingVersion: base.bookingVersion || 0,
    nextAggregate: next,
  });
  // Release A: never fall back to unconditional set — conflict must surface.
  if (!committed.ok) return null;
  return committed.booking;
}

async function listRawBookings() {
  const store = await bookingStore();
  const blobs = await listAllBlobs(store, 'cd1-bookings');
  const records = await fetchBlobRecords(store, blobs);
  const out = [];
  for (const raw of records) {
    if (!raw) continue;
    const adapted = adaptHistoricalBooking(raw);
    if (!adapted.ok || !adapted.booking) continue;
    if (!isVisibleSubmittedBooking(adapted.booking, { includeArchivedTest: true })) continue;
    // listRawBookings historically excluded drafts only; keep archived/test for schedule conflict checks
    if (adapted.booking.isDraft) continue;
    out.push(adapted.booking);
  }
  out.sort((a, b) => {
    const ta = String(a.updatedAt || a.createdAt || '');
    const tb = String(b.updatedAt || b.createdAt || '');
    if (ta !== tb) return tb.localeCompare(ta);
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
  return out;
}

const {
  normalizePhone,
  phonesMatch,
} = require('./phone-auth');

module.exports = {
  bookingStore,
  setOpsStoreOverride,
  getBooking,
  patchBooking,
  listRawBookings,
  normalizePhone,
  phonesMatch,
};
