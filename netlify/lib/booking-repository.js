/**
 * Versioned booking repository with etag conditional writes.
 * A read-then-unconditional-set is not acceptable conflict protection.
 */

const { blobsStore } = require('./tech-security');
const { BOOKINGS_STORE } = require('./ops-schema');
const { adaptHistoricalBooking } = require('./historical-adapter');
const { normalizeAggregate } = require('./booking-aggregate');
const { isVisibleSubmittedBooking } = require('./booking-visibility');
const { listAllBlobs, fetchBlobRecords } = require('./tech-security');

const STRONG_CONSISTENCY = 'strong';

let _storeOverride = null;

function setBookingStoreOverride(store) {
  _storeOverride = store;
}

async function getStore() {
  if (_storeOverride) return _storeOverride;
  return blobsStore(BOOKINGS_STORE);
}

function writeWasApplied(result) {
  if (result == null) return true;
  return result.modified !== false;
}

async function getBookingRecord(bookingId, { storeOverride = null } = {}) {
  const store = storeOverride || await getStore();
  const id = String(bookingId || '').trim();
  if (!id) return { exists: false, booking: null, etag: null, raw: null };

  let result = null;
  if (typeof store.getWithMetadata === 'function') {
    result = await store.getWithMetadata(id, { type: 'json', consistency: STRONG_CONSISTENCY }).catch(() => null);
  }
  if (result && result.data) {
    const adapted = adaptHistoricalBooking(result.data);
    const booking = adapted.ok ? adapted.booking : result.data;
    const norm = normalizeAggregate(booking, { allowDraft: true });
    return {
      exists: true,
      booking: norm.ok ? norm.aggregate : booking,
      etag: result.etag || null,
      raw: result.data,
      quarantined: adapted.quarantined,
    };
  }

  // Fallback stores (tests / older adapters) without getWithMetadata
  const data = await store.get(id, { type: 'json' }).catch(() => null);
  if (!data) return { exists: false, booking: null, etag: null, raw: null };
  const adapted = adaptHistoricalBooking(data);
  const booking = adapted.ok ? adapted.booking : data;
  const norm = normalizeAggregate(booking, { allowDraft: true });
  const etag = data.__etag || data._etag || `v${Number(data.bookingVersion) || 0}:${data.updatedAt || ''}`;
  return {
    exists: true,
    booking: norm.ok ? norm.aggregate : booking,
    etag,
    raw: data,
    quarantined: adapted.quarantined,
  };
}

/**
 * Conditionally persist next aggregate when expectedBookingVersion matches.
 * Uses Blob onlyIfMatch when etag available; also enforces bookingVersion.
 */
async function commitBooking({
  bookingId,
  expectedBookingVersion,
  nextAggregate,
  createIfMissing = false,
  storeOverride = null,
}) {
  const store = storeOverride || await getStore();
  const id = String(bookingId || nextAggregate?.id || '').trim();
  if (!id) return { ok: false, error: 'missing_booking_id' };

  const current = await getBookingRecord(id, { storeOverride: store });
  const expected = Math.max(0, Math.round(Number(expectedBookingVersion)));

  if (!current.exists) {
    if (!createIfMissing) return { ok: false, error: 'not_found' };
    const toWrite = {
      ...nextAggregate,
      id,
      bookingVersion: Math.max(1, Math.round(Number(nextAggregate.bookingVersion) || 1)),
    };
    delete toWrite.__etag;
    delete toWrite._etag;
    const writeResult = typeof store.setJSON === 'function'
      ? await store.setJSON(id, toWrite, { onlyIfNew: true })
      : await store.setJSON(id, toWrite);
    if (!writeWasApplied(writeResult)) {
      return { ok: false, error: 'version_conflict', statusCode: 409 };
    }
    // Dual-write Prisma (fail-open) — Blobs already committed
    try {
      const { scheduleBookingMirror } = require('./booking-prisma-mirror');
      scheduleBookingMirror(toWrite);
    } catch { /* never block Blob authority */ }
    try {
      const { syncSlotIndex } = require('./slot-index');
      await syncSlotIndex(toWrite);
    } catch { /* never block Blob authority */ }
    return { ok: true, booking: toWrite, bookingVersion: toWrite.bookingVersion };
  }

  const actualVersion = Math.max(0, Math.round(Number(current.booking?.bookingVersion) || 0));
  if (actualVersion !== expected) {
    return {
      ok: false,
      error: 'version_conflict',
      statusCode: 409,
      actualBookingVersion: actualVersion,
      expectedBookingVersion: expected,
    };
  }

  const toWrite = { ...nextAggregate, id, bookingVersion: expected + 1 };
  // Preserve unknown fields from current that were not in nextAggregate keys intentionally
  // nextAggregate should already be a full merged object from buildNextAggregate
  delete toWrite.__etag;
  delete toWrite._etag;

  let writeResult;
  if (current.etag && typeof store.setJSON === 'function') {
    writeResult = await store.setJSON(id, toWrite, { onlyIfMatch: current.etag });
  } else if (typeof store.setJSON === 'function') {
    // Test memory stores: simulate CAS via __etag / bookingVersion re-read
    const fresh = await getBookingRecord(id, { storeOverride: store });
    const freshVersion = Math.max(0, Math.round(Number(fresh.booking?.bookingVersion) || 0));
    if (freshVersion !== expected) {
      return {
        ok: false,
        error: 'version_conflict',
        statusCode: 409,
        actualBookingVersion: freshVersion,
        expectedBookingVersion: expected,
      };
    }
    toWrite.__etag = `v${toWrite.bookingVersion}:${toWrite.updatedAt || Date.now()}`;
    writeResult = await store.setJSON(id, toWrite);
  } else {
    return { ok: false, error: 'store_unavailable' };
  }

  if (!writeWasApplied(writeResult)) {
    return {
      ok: false,
      error: 'version_conflict',
      statusCode: 409,
      actualBookingVersion: actualVersion,
      expectedBookingVersion: expected,
    };
  }

  // Dual-write Prisma (fail-open) — Blobs already committed; never affect checkout/CAS.
  try {
    const { scheduleBookingMirror } = require('./booking-prisma-mirror');
    scheduleBookingMirror(toWrite);
  } catch { /* never block Blob authority */ }

  // Slot index (fail-open, awaited): this is the choke point every Admin/portal
  // reschedule and cancellation goes through, so keeping it here is what stops
  // the index from drifting. syncSlotIndex never throws.
  try {
    const { syncSlotIndex } = require('./slot-index');
    await syncSlotIndex(toWrite, { previous: current.booking });
  } catch { /* never block Blob authority */ }

  return { ok: true, booking: toWrite, bookingVersion: toWrite.bookingVersion };
}

async function listSubmittedBookings({ includeArchivedTest = false } = {}) {
  const store = await getStore();
  let blobs = [];
  if (typeof listAllBlobs === 'function') {
    blobs = await listAllBlobs(store, 'cd1-bookings');
  } else {
    const listing = await store.list();
    blobs = (listing && listing.blobs) || [];
  }

  const records = typeof fetchBlobRecords === 'function'
    ? await fetchBlobRecords(store, blobs)
    : await Promise.all(blobs.map((b) => store.get(b.key, { type: 'json' }).catch(() => null)));

  const bookings = [];
  const quarantined = [];
  for (const raw of records) {
    if (!raw) continue;
    const adapted = adaptHistoricalBooking(raw);
    if (!adapted.ok || !adapted.booking) {
      quarantined.push({ id: raw.id || raw.bookingId, reason: adapted.reason });
      continue;
    }
    if (!isVisibleSubmittedBooking(adapted.booking, { includeArchivedTest })) continue;
    const norm = normalizeAggregate(adapted.booking, { allowDraft: false });
    if (norm.ok) bookings.push(norm.aggregate);
  }

  bookings.sort((a, b) => {
    const ta = String(a.updatedAt || a.createdAt || '');
    const tb = String(b.updatedAt || b.createdAt || '');
    if (ta !== tb) return tb.localeCompare(ta);
    return String(a.id || '').localeCompare(String(b.id || ''));
  });

  return { bookings, quarantined };
}

module.exports = {
  setBookingStoreOverride,
  getBookingRecord,
  commitBooking,
  listSubmittedBookings,
  writeWasApplied,
};
