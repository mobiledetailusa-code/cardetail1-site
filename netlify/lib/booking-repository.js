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

/**
 * Booking documents do not use writeWasApplied.
 * @netlify/blobs 10.7.9 reports every conditional response other than HTTP 412
 * as modified:true, and it substitutes an empty string when the etag header
 * is missing. A confirmed booking write therefore needs modified:true and a
 * non-empty etag. Anything else stays unknown and is not success.
 */
function classifyConditionalWrite(result) {
  if (!result || typeof result !== 'object' || typeof result.modified !== 'boolean') {
    return 'unknown';
  }
  if (result.modified === false) return 'conflict';
  const etag = typeof result.etag === 'string' ? result.etag.trim() : '';
  if (!etag) return 'unknown';
  return 'success';
}

/** Stored JSON, detached from the read projection that adapts it. */
function cloneStoredRecord(value) {
  if (!value || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

async function getBookingRecord(bookingId, { storeOverride = null } = {}) {
  const store = storeOverride || await getStore();
  const id = String(bookingId || '').trim();
  if (!id) return { exists: false, booking: null, etag: null, etagTrusted: false, raw: null };

  let result = null;
  if (typeof store.getWithMetadata === 'function') {
    result = await store.getWithMetadata(id, { type: 'json', consistency: STRONG_CONSISTENCY }).catch(() => null);
  }
  if (result && result.data) {
    const raw = cloneStoredRecord(result.data);
    const adapted = adaptHistoricalBooking(raw);
    const booking = adapted.ok ? adapted.booking : raw;
    const norm = normalizeAggregate(booking, { allowDraft: true });
    return {
      exists: true,
      booking: norm.ok ? norm.aggregate : booking,
      etag: result.etag || null,
      etagTrusted: Boolean(result.etag),
      raw: cloneStoredRecord(result.data),
      quarantined: adapted.quarantined,
    };
  }

  // Fallback stores (tests / older adapters) without getWithMetadata
  const data = await store.get(id, { type: 'json' }).catch(() => null);
  if (!data) return { exists: false, booking: null, etag: null, raw: null };
  const raw = cloneStoredRecord(data);
  const adapted = adaptHistoricalBooking(raw);
  const booking = adapted.ok ? adapted.booking : raw;
  const norm = normalizeAggregate(booking, { allowDraft: true });
  const explicitEtag = data.__etag || data._etag || '';
  const etag = explicitEtag || `v${Number(data.bookingVersion) || 0}:${data.updatedAt || ''}`;
  return {
    exists: true,
    booking: norm.ok ? norm.aggregate : booking,
    etag,
    etagTrusted: Boolean(explicitEtag),
    raw: cloneStoredRecord(data),
    quarantined: adapted.quarantined,
  };
}

/**
 * Conditionally persist next aggregate when expectedBookingVersion matches.
 * An existing booking is written only with a trusted etag and onlyIfMatch.
 * strictCas is accepted for older callers and cannot turn that into an
 * unconditional overwrite. A new booking uses onlyIfNew and does not need
 * a prior etag. The read requests strong consistency; the client default
 * in @netlify/blobs 10.7.9 remains eventual for callers that omit it.
 */
async function commitBooking({
  bookingId,
  expectedBookingVersion,
  nextAggregate,
  createIfMissing = false,
  storeOverride = null,
  syncSlots = true,
  strictCas = false,
  auditActorId = '',
}) {
  void strictCas;
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
    if (typeof store.setJSON !== 'function') {
      return { ok: false, error: 'store_unavailable' };
    }
    let writeResult;
    try {
      writeResult = await store.setJSON(id, toWrite, { onlyIfNew: true });
    } catch {
      return { ok: false, error: 'write_outcome_unknown', statusCode: 409 };
    }
    const created = classifyConditionalWrite(writeResult);
    if (created === 'conflict') {
      return { ok: false, error: 'version_conflict', statusCode: 409 };
    }
    if (created !== 'success') {
      return { ok: false, error: 'write_outcome_unknown', statusCode: 409 };
    }
    // Dual-write Prisma (fail-open) — Blobs already committed
    try {
      const { scheduleBookingMirror } = require('./booking-prisma-mirror');
      scheduleBookingMirror(toWrite);
    } catch { /* never block Blob authority */ }
    if (syncSlots) {
      try {
        const { syncSlotIndex } = require('./slot-index');
        await syncSlotIndex(toWrite);
      } catch { /* never block Blob authority */ }
    }
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

  const trustedEtag = current.etagTrusted && typeof current.etag === 'string'
    ? current.etag.trim()
    : '';
  if (!trustedEtag) {
    return { ok: false, error: 'cas_precondition_missing', statusCode: 409 };
  }

  let toWrite = { ...nextAggregate, id, bookingVersion: expected + 1 };
  // Preserve unknown fields from current that were not in nextAggregate keys intentionally
  // nextAggregate should already be a full merged object from buildNextAggregate
  delete toWrite.__etag;
  delete toWrite._etag;
  const { reconcilePreparedIssuance, recordSupersessionAudit } = require('./square-prepared-issuance');
  const reconciled = reconcilePreparedIssuance(
    toWrite,
    toWrite.updatedAt || new Date().toISOString()
  );
  toWrite = { ...reconciled.booking, id, bookingVersion: expected + 1 };
  delete toWrite.__etag;
  delete toWrite._etag;

  if (typeof store.setJSON !== 'function') {
    return { ok: false, error: 'store_unavailable' };
  }
  let writeResult;
  try {
    writeResult = await store.setJSON(id, toWrite, { onlyIfMatch: trustedEtag });
  } catch {
    return { ok: false, error: 'write_outcome_unknown', statusCode: 409 };
  }
  const written = classifyConditionalWrite(writeResult);
  if (written === 'conflict') {
    return {
      ok: false,
      error: 'version_conflict',
      statusCode: 409,
      actualBookingVersion: actualVersion,
      expectedBookingVersion: expected,
    };
  }
  if (written !== 'success') {
    return { ok: false, error: 'write_outcome_unknown', statusCode: 409 };
  }

  // Dual-write Prisma (fail-open) — Blobs already committed; never affect checkout/CAS.
  try {
    const { scheduleBookingMirror } = require('./booking-prisma-mirror');
    scheduleBookingMirror(toWrite);
  } catch { /* never block Blob authority */ }

  // Slot index (fail-open, awaited): this is the choke point every Admin/portal
  // cancellation and non-span edit goes through. Reschedule passes syncSlots
  // false and moves occupancy itself, so a failed date change cannot release
  // the old span before the new one is stored.
  if (syncSlots) {
    try {
      const { syncSlotIndex } = require('./slot-index');
      await syncSlotIndex(toWrite, { previous: current.booking });
    } catch { /* never block Blob authority */ }
  }

  let auditRecorded = null;
  if (reconciled.superseded) {
    try {
      await recordSupersessionAudit(reconciled.superseded, id, auditActorId);
      auditRecorded = true;
    } catch {
      auditRecorded = false;
    }
  }

  return {
    ok: true,
    booking: toWrite,
    bookingVersion: toWrite.bookingVersion,
    auditRecorded,
    supersededIssuance: reconciled.superseded,
  };
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
  getStore,
  getBookingRecord,
  commitBooking,
  listSubmittedBookings,
  writeWasApplied,
  classifyConditionalWrite,
};
