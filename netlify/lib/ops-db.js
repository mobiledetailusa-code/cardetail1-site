// Unified operational DB layer — all channels read/write cd1-bookings through here.
const { blobsStore, listAllBlobs, fetchBlobRecords, bookingRef } = require('./tech-security');
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

function normalizeBookingKey(raw) {
  return String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9\-]/g, '').slice(0, 48);
}

function healStickyDraftFlags(booking) {
  if (!booking || typeof booking !== 'object') return booking;
  const { hasSubmissionMarkers } = require('./booking-visibility');
  if (!hasSubmissionMarkers(booking)) return booking;
  if (booking.isDraft !== true && String(booking.kind || '').toLowerCase() !== 'draft') {
    return booking;
  }
  // In-memory heal so Customer Portal can open Admin-pending / finalized jobs.
  return {
    ...booking,
    isDraft: false,
    kind: 'booking',
  };
}

async function readBlobJson(store, key) {
  if (!key) return null;
  if (typeof store.getWithMetadata === 'function') {
    const result = await store.getWithMetadata(key, {
      type: 'json',
      consistency: 'strong',
    }).catch(() => null);
    if (result && result.data) return result.data;
  }
  return store.get(key, { type: 'json' }).catch(() => null);
}

function finalizeBookingRead(raw, fallbackId) {
  if (!raw) return null;
  const adapted = adaptHistoricalBooking(raw);
  const booking = healStickyDraftFlags(adapted.ok ? adapted.booking : raw);
  if (!booking) return null;
  const canonical = normalizeBookingKey(booking.id || booking.bookingId || fallbackId);
  if (canonical) {
    booking.id = booking.id || canonical;
    booking.bookingId = booking.bookingId || booking.id;
  }
  return booking;
}

/**
 * Resolve a booking by Blob key variants, then by scanning records where
 * payload.id / bookingId matches (Admin list can show jobs whose Blob key ≠ id).
 */
async function getBooking(bookingId) {
  const store = await bookingStore();
  const id = normalizeBookingKey(bookingId);
  if (!id) return null;

  const keyVariants = [...new Set([
    id,
    String(bookingId || '').trim(),
    String(bookingId || '').trim().toLowerCase(),
  ])].filter(Boolean);

  for (const key of keyVariants) {
    const raw = await readBlobJson(store, key);
    if (raw) return finalizeBookingRead(raw, id);
  }

  // Prisma on Blob miss, before the scan — Blobs remain primary, so this runs
  // only once every direct key variant above has missed. The id is
  // BookingRecord's primary key, so it answers in milliseconds; running it
  // after the scan (as it used to) meant any booking whose Blob key ≠
  // payload.id sent stripe-webhook and booking-card-status through a
  // full-store hydration that no longer fits in a function timeout.
  try {
    const { readBookingMirror } = require('./booking-prisma-mirror');
    const mirrored = await readBookingMirror(id);
    if (mirrored) {
      console.log('[ops-db] getBooking resolved via mirror', { bookingRef: bookingRef(id) });
      return finalizeBookingRead(mirrored, id);
    }
  } catch { /* ignore — the scan below is still authoritative */ }

  // Scan fallback — Admin feed uses list keys; Customer lookup uses booking.id.
  try {
    const blobs = await listAllBlobs(store, BOOKINGS_STORE);
    for (let i = 0; i < blobs.length; i += 30) {
      const chunk = blobs.slice(i, i + 30);
      const rows = await Promise.all(chunk.map(async (b) => {
        const raw = await readBlobJson(store, b.key);
        return raw ? { key: b.key, raw } : null;
      }));
      for (const row of rows) {
        if (!row) continue;
        const rid = normalizeBookingKey(row.raw.id || row.raw.bookingId || '');
        const rkey = normalizeBookingKey(row.key);
        if (rid === id || rkey === id) {
          // Refs, not ids: this line used to print the lookup id, the Blob key
          // and the payload id verbatim. Which side matched is the diagnostic
          // value; the id itself is PII the logs must not carry.
          console.log('[ops-db] getBooking resolved via scan', {
            bookingRef: bookingRef(id),
            blobKeyRef: bookingRef(row.key),
            matchedOn: rid === id ? 'payload_id' : 'blob_key',
          });
          return finalizeBookingRead(row.raw, id);
        }
      }
    }
  } catch (e) {
    console.warn('[ops-db] getBooking scan failed:', e.message);
  }

  return null;
}

// Matches fetchBlobRecords' default — same Blobs backend, same tested ceiling.
const BOOKING_LOOKUP_CONCURRENCY = 20;

/**
 * Batch-resolve bookings for a bounded set of ids (one Admin page).
 *
 * Same resolution order as getBooking — direct key variants, then the indexed
 * mirror, then a shared scan — but deduplicated and bounded:
 *   - each unique id is read once, never once per referencing row;
 *   - direct-key reads run in bounded-concurrency chunks instead of serially;
 *   - ids that miss every key variant share ONE scan pass rather than each
 *     triggering its own full store scan.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.allowScan=true] Set false where a page of rows must
 *   never pay a full-store hydration to enrich a booking it can render without.
 *   One unresolvable id would otherwise cost the whole endpoint ~10-18s.
 * @returns {Promise<Map<string, object|null>>} keyed by normalizeBookingKey(id)
 */
async function getBookingsByIds(bookingIds, { allowScan = true } = {}) {
  const resolved = new Map();
  const wanted = new Map();
  for (const raw of bookingIds || []) {
    const id = normalizeBookingKey(raw);
    if (id && !wanted.has(id)) wanted.set(id, raw);
  }
  if (!wanted.size) return resolved;

  const store = await bookingStore();
  const ids = [...wanted.keys()];

  // Pass 1 — direct key variants, bounded concurrency.
  for (let i = 0; i < ids.length; i += BOOKING_LOOKUP_CONCURRENCY) {
    const chunk = ids.slice(i, i + BOOKING_LOOKUP_CONCURRENCY);
    await Promise.all(chunk.map(async (id) => {
      const original = wanted.get(id);
      const keyVariants = [...new Set([
        id,
        String(original || '').trim(),
        String(original || '').trim().toLowerCase(),
      ])].filter(Boolean);
      for (const key of keyVariants) {
        const raw = await readBlobJson(store, key);
        if (raw) { resolved.set(id, finalizeBookingRead(raw, id)); return; }
      }
      resolved.set(id, null);
    }));
  }

  // Pass 2 — one indexed batch read for everything the direct keys missed.
  // Same reordering as getBooking: the mirror answers before, not after, a scan
  // that no longer fits in a function timeout.
  const missedKeys = new Set(ids.filter((id) => !resolved.get(id)));
  if (missedKeys.size) {
    try {
      const { readBookingMirrors } = require('./booking-prisma-mirror');
      const mirrored = await readBookingMirrors([...missedKeys]);
      for (const [mirroredId, payload] of mirrored) {
        const id = normalizeBookingKey(mirroredId);
        if (id && missedKeys.has(id)) resolved.set(id, finalizeBookingRead(payload, id));
      }
    } catch { /* ignore — the scan below is still authoritative */ }
  }

  // Pass 3 — one shared scan resolves every remaining id at once.
  const pending = new Set(ids.filter((id) => !resolved.get(id)));
  if (pending.size && !allowScan) {
    console.warn('[ops-db] getBookingsByIds unresolved without scan', { count: pending.size });
  }
  if (pending.size && allowScan) {
    try {
      const blobs = await listAllBlobs(store, BOOKINGS_STORE);
      for (let i = 0; i < blobs.length && pending.size; i += 30) {
        const chunk = blobs.slice(i, i + 30);
        const rows = await Promise.all(chunk.map(async (b) => {
          const raw = await readBlobJson(store, b.key);
          return raw ? { key: b.key, raw } : null;
        }));
        for (const row of rows) {
          if (!row || !pending.size) continue;
          const rid = normalizeBookingKey(row.raw.id || row.raw.bookingId || '');
          const rkey = normalizeBookingKey(row.key);
          for (const id of pending) {
            if (rid === id || rkey === id) {
              resolved.set(id, finalizeBookingRead(row.raw, id));
              pending.delete(id);
              break;
            }
          }
        }
      }
    } catch (e) {
      console.warn('[ops-db] getBookingsByIds scan failed:', e.message);
    }
  }

  return resolved;
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
    out.push(healStickyDraftFlags(adapted.booking));
  }
  out.sort((a, b) => {
    const ta = String(a.updatedAt || a.createdAt || '');
    const tb = String(b.updatedAt || b.createdAt || '');
    if (ta !== tb) return tb.localeCompare(ta);
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
  return out;
}

/**
 * Bookings + active card-save drafts that participate in slot locking.
 * Unlike listRawBookings, this includes soft-held drafts so draft creation
 * and finalize share the same conflict authority.
 */
async function listBookingsForSlotLock() {
  const { isActiveBookingForSlotLock } = require('./booking-schedule');
  const store = await bookingStore();
  const blobs = await listAllBlobs(store, 'cd1-bookings');
  const records = await fetchBlobRecords(store, blobs);
  const out = [];
  for (const raw of records) {
    if (!raw) continue;
    const adapted = adaptHistoricalBooking(raw);
    if (!adapted.ok || !adapted.booking) continue;
    const booking = healStickyDraftFlags(adapted.booking);
    if (!isActiveBookingForSlotLock(booking)) continue;
    out.push(booking);
  }
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
  getBookingsByIds,
  BOOKING_LOOKUP_CONCURRENCY,
  patchBooking,
  listRawBookings,
  listBookingsForSlotLock,
  normalizeBookingKey,
  normalizePhone,
  phonesMatch,
};
