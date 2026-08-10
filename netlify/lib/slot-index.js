'use strict';

/**
 * Slot occupancy index — answers "who holds this date/time?" without hydrating
 * the booking store.
 *
 * Why this exists: listBookingsForSlotLock() reads every record in
 * cd1-bookings. That scan now exceeds the Netlify function ceiling on the live
 * store (booking-availability?action=nearby returns 502 after ~40s), which is
 * what breaks card-save: submit-booking's draft pre-registration runs the same
 * scan and dies before it can answer.
 *
 * The index keeps one empty blob per hold, in its own store, with everything
 * the occupancy check needs encoded in the KEY:
 *
 *   <slotDate>/<slotTime>/<state>/<expiresAtMs>/<bookingId>
 *   2026-09-15/10:00/booked/0/CD1-ABC123
 *   2026-09-15/10:00/draft/1789459200000/CD1-DEF456
 *
 * so a check is one prefix list — keys only, zero payload fetches — instead of
 * a full-store hydration.
 *
 * Blobs stay authoritative. This is a derived index:
 *   - reads are gated by SLOT_INDEX_READS and fall back to the scan on any
 *     error, never to "the slot looks free";
 *   - draft holds are written BEFORE the draft record, so a crash in between
 *     leaves an entry that makes the slot look busy (fail-closed) and expires
 *     on its own within DRAFT_SLOT_HOLD_MS;
 *   - submitted holds are written after the record, because an orphan there
 *     would block a real slot forever; drift is reported by
 *     scripts/verify-slot-index.js.
 */

const { DRAFT_SLOT_HOLD_MS, normalizePreferredTime, capacityForSlot } = require('./booking-schedule');
const { isoDateParts } = require('./operational-availability');
const { bookingRef } = require('./tech-security');

const SLOT_INDEX_STORE = 'cd1-slot-index';
const STATE_BOOKED = 'booked';
const STATE_DRAFT = 'draft';

/** Reads stay off until the index is backfilled; writes always run. */
function slotIndexReadsEnabled(env = process.env) {
  const flag = String(env.SLOT_INDEX_READS || '').trim().toLowerCase();
  return flag === '1' || flag === 'true';
}

let _storeOverride = null;

/** Test seam — same shape as ops-db.setOpsStoreOverride. */
function setSlotIndexStoreOverride(store) {
  _storeOverride = store || null;
}

async function slotIndexStore() {
  if (_storeOverride) return _storeOverride;
  const { blobsStore } = require('./tech-security');
  return blobsStore(SLOT_INDEX_STORE);
}

/** bookingId is last so it can carry the '/' -free id without splitting concerns. */
function slotIndexKey({ slotDate, slotTime, state, expiresAtMs, bookingId }) {
  return [
    slotDate,
    slotTime,
    state,
    Math.max(0, Math.round(Number(expiresAtMs) || 0)),
    String(bookingId || '').replace(/\//g, '_'),
  ].join('/');
}

function parseSlotIndexKey(key) {
  const parts = String(key || '').split('/');
  if (parts.length < 5) return null;
  const [slotDate, slotTime, state, expiresRaw, ...idParts] = parts;
  if (state !== STATE_BOOKED && state !== STATE_DRAFT) return null;
  const expiresAtMs = Number(expiresRaw);
  if (!Number.isFinite(expiresAtMs)) return null;
  return {
    key,
    slotDate,
    slotTime,
    state,
    expiresAtMs,
    bookingId: idParts.join('/'),
  };
}

function entryIsActive(entry, nowMs) {
  if (!entry) return false;
  if (entry.state === STATE_BOOKED) return true;
  return entry.expiresAtMs > nowMs;
}

/**
 * The hold a booking record represents.
 *
 * `active` mirrors booking-schedule.isActiveBookingForSlotLock exactly, so the
 * index and the scan can never disagree about what occupies a slot — a shared
 * test asserts the two agree case by case.
 *
 * The slot coordinates are returned even for an inactive record, because that
 * is what lets a cancellation clear its own entry without being handed the
 * previous version of the booking.
 *
 * @returns {{ active: boolean, slotDate: string|null, slotTime: string|null, state: string, expiresAtMs: number }}
 */
function slotHoldForBooking(booking, nowMs = Date.now()) {
  const parts = booking && typeof booking === 'object' ? isoDateParts(booking.preferredDate) : null;
  const slotTime = booking && typeof booking === 'object'
    ? normalizePreferredTime(booking.preferredTime)
    : null;
  const slot = {
    active: false,
    slotDate: parts ? parts.iso : null,
    slotTime: slotTime || null,
    state: STATE_BOOKED,
    expiresAtMs: 0,
  };
  if (!booking || typeof booking !== 'object') return slot;
  if (booking.archived || booking.isTest) return slot;
  if (!slot.slotDate || !slot.slotTime) return slot;

  const isDraft = booking.isDraft === true || String(booking.kind || '').toLowerCase() === 'draft';
  if (isDraft) {
    slot.state = STATE_DRAFT;
    const cof = String(booking.cardOnFileStatus || '').toLowerCase();
    if (cof !== 'pending' && cof !== 'saved') return slot;
    const ts = Date.parse(booking.updatedAt || booking.createdAt || '');
    if (!Number.isFinite(ts)) return slot;
    slot.expiresAtMs = ts + DRAFT_SLOT_HOLD_MS;
    // An already-expired hold is not written; entries that expire later are
    // filtered at read time from the timestamp in their key.
    slot.active = slot.expiresAtMs > nowMs;
    return slot;
  }

  const { normalizeJobStatus } = require('./ops-schema');
  const js = normalizeJobStatus(booking);
  if (js === 'cancelled' || js === 'archived_test') return slot;
  const appt = String(booking.appointmentStatus || '').toLowerCase();
  if (appt === 'canceled' || appt === 'cancelled' || appt === 'rejected') return slot;
  const legacy = String(booking.status || '').toLowerCase();
  if (legacy === 'cancelled' || legacy === 'canceled' || legacy === 'rejected') return slot;

  slot.active = true;
  return slot;
}

async function listSlotEntries(store, prefix) {
  const out = [];
  const paged = store.list({ prefix, paginate: true });
  if (paged && typeof paged[Symbol.asyncIterator] === 'function') {
    for await (const page of paged) {
      for (const blob of (page && page.blobs) || []) {
        const entry = parseSlotIndexKey(blob.key);
        if (entry) out.push(entry);
      }
    }
    return out;
  }
  const listing = await paged;
  for (const blob of (listing && listing.blobs) || []) {
    const entry = parseSlotIndexKey(blob.key);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * Active holds on one slot. Throws on any store failure so callers fall back to
 * the authoritative scan instead of reading a short list as "empty".
 */
async function readSlotHolds(slotDate, slotTime, { excludeId = null, nowMs = Date.now() } = {}) {
  const parts = isoDateParts(slotDate);
  const time = normalizePreferredTime(slotTime);
  if (!parts || !time) return [];
  const store = await slotIndexStore();
  const entries = await listSlotEntries(store, `${parts.iso}/${time}/`);
  return entries.filter((e) => {
    if (!entryIsActive(e, nowMs)) return false;
    if (excludeId && String(e.bookingId) === String(excludeId)) return false;
    return true;
  });
}

/**
 * Indexed replacement for booking-schedule.hasSlotConflict.
 *
 * @returns {Promise<{ ok: true, conflict: boolean } | { ok: false, reason: string }>}
 *   ok:false means "index could not answer" — the caller must fall back.
 */
async function indexedSlotConflict(slotDate, slotTime, {
  excludeId = null,
  nowMs = Date.now(),
  config = null,
} = {}) {
  if (!slotIndexReadsEnabled()) return { ok: false, reason: 'reads_disabled' };
  const parts = isoDateParts(slotDate);
  const time = normalizePreferredTime(slotTime);
  if (!parts || !time) return { ok: true, conflict: false };
  try {
    const holds = await readSlotHolds(parts.iso, time, { excludeId, nowMs });
    const capacity = capacityForSlot(parts.iso, time, config, new Date(nowMs));
    return { ok: true, conflict: holds.length >= capacity };
  } catch (err) {
    console.warn('[slot-index] read_failed', err && err.message ? err.message : err);
    return { ok: false, reason: 'read_failed' };
  }
}

/** Occupancy counts for a whole day, shaped like booking-schedule.buildOccupancyMap. */
async function indexedOccupancyForDates(dates, { nowMs = Date.now() } = {}) {
  if (!slotIndexReadsEnabled()) return { ok: false, reason: 'reads_disabled' };
  try {
    const store = await slotIndexStore();
    const map = {};
    for (const date of dates || []) {
      const parts = isoDateParts(date);
      if (!parts) continue;
      const entries = await listSlotEntries(store, `${parts.iso}/`);
      for (const entry of entries) {
        if (!entryIsActive(entry, nowMs)) continue;
        const key = `${entry.slotDate}|${entry.slotTime}`;
        map[key] = (map[key] || 0) + 1;
      }
    }
    return { ok: true, occupancy: map };
  } catch (err) {
    console.warn('[slot-index] occupancy_failed', err && err.message ? err.message : err);
    return { ok: false, reason: 'read_failed' };
  }
}

async function deleteHoldEntries(store, bookingId, hold) {
  if (!hold || !hold.slotDate || !hold.slotTime) return;
  // State and expiry are part of the key, so a moved or refreshed hold is found
  // by scanning its old slot rather than by reconstructing the old key.
  const entries = await listSlotEntries(store, `${hold.slotDate}/${hold.slotTime}/`);
  const stale = entries.filter((e) => String(e.bookingId) === String(bookingId));
  for (const entry of stale) {
    await store.delete(entry.key);
  }
}

/**
 * Bring the index in line with a booking record.
 *
 * @param {object} booking current record (post-write for submitted, pre-write for drafts)
 * @param {object} [opts.previous] the record as it was, when the slot may have moved
 * @returns {Promise<{ ok: boolean, wrote?: string|null, error?: string }>} never throws
 */
async function syncSlotIndex(booking, { previous = null } = {}) {
  const bookingId = String(booking?.id || booking?.bookingId || '').trim();
  if (!bookingId) return { ok: false, error: 'missing_booking_id' };

  try {
    const store = await slotIndexStore();
    const next = slotHoldForBooking(booking);
    const prior = previous ? slotHoldForBooking(previous) : null;

    // Clear the slot the booking used to sit in when it moved, then clear the
    // target slot so a state or expiry change replaces the entry rather than
    // stacking a second one. A cancellation stops here and stays cleared.
    if (prior && prior.slotDate
      && (prior.slotDate !== next.slotDate || prior.slotTime !== next.slotTime)) {
      await deleteHoldEntries(store, bookingId, prior);
    }
    if (next.slotDate) await deleteHoldEntries(store, bookingId, next);

    if (!next.active) return { ok: true, wrote: null };

    const key = slotIndexKey({ ...next, bookingId });
    await store.setJSON(key, 1);
    return { ok: true, wrote: key };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.warn('[slot-index] sync_failed', { bookingRef: bookingRef(bookingId), message });
    return { ok: false, error: message };
  }
}

/** Fire-and-forget sync for paths that must not be blocked by the index. */
function scheduleSlotIndexSync(booking, opts) {
  Promise.resolve().then(() => syncSlotIndex(booking, opts)).catch(() => {});
}

module.exports = {
  SLOT_INDEX_STORE,
  STATE_BOOKED,
  STATE_DRAFT,
  slotIndexReadsEnabled,
  setSlotIndexStoreOverride,
  slotIndexStore,
  slotIndexKey,
  parseSlotIndexKey,
  entryIsActive,
  slotHoldForBooking,
  readSlotHolds,
  indexedSlotConflict,
  indexedOccupancyForDates,
  syncSlotIndex,
  scheduleSlotIndexSync,
};
