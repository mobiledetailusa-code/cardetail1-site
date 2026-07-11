// Unified operational DB layer — all channels read/write cd1-bookings through here.
const { blobsStore } = require('./tech-security');
const { BOOKINGS_STORE } = require('./ops-schema');
const { appendEventLog, normalizeJobStatus, normalizePaymentWorkflowStatus } = require('./ops-workflow');

async function bookingStore() {
  return blobsStore(BOOKINGS_STORE);
}

async function getBooking(bookingId) {
  const store = await bookingStore();
  return store.get(bookingId, { type: 'json' }).catch(() => null);
}

async function patchBooking(bookingId, patches, eventEntry) {
  const store = await bookingStore();
  const booking = await getBooking(bookingId);
  if (!booking) return null;
  const now = new Date().toISOString();
  const patched = {
    ...booking,
    ...patches,
    jobStatus: patches.jobStatus || booking.jobStatus,
    updatedAt: now,
    eventLog: eventEntry ? appendEventLog(booking, eventEntry) : (booking.eventLog || []),
  };
  patched.jobStatus = normalizeJobStatus(patched);
  if (!patched.paymentWorkflowStatus && patches.paymentWorkflowStatus === undefined) {
    patched.paymentWorkflowStatus = normalizePaymentWorkflowStatus(patched);
  }
  await store.setJSON(bookingId, patched);
  return patched;
}

async function listRawBookings() {
  const store = await bookingStore();
  const listing = await store.list();
  const blobs = (listing && listing.blobs) || [];
  return (await Promise.all(
    blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null))
  )).filter(b => b && !b.isDraft);
}

const {
  normalizePhone,
  phonesMatch,
} = require('./phone-auth');

module.exports = {
  bookingStore,
  getBooking,
  patchBooking,
  listRawBookings,
  normalizePhone,
  phonesMatch,
};
