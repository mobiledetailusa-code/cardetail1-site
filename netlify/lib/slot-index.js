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
 *   - reads default ON (SLOT_INDEX_READS=0 forces the legacy full-store scan);
 *     leaving the scan as the hot path exceeds the function budget and returns
 *     an HTML 504 that checkout reports as "Booking backend returned an invalid response";
 *   - draft holds are written BEFORE the draft record, so a crash in between
 *     leaves an entry that makes the slot look busy (fail-closed) and expires
 *     on its own within DRAFT_SLOT_HOLD_MS;
 *   - submitted holds are written after the record, because an orphan there
 *     would block a real slot forever; drift is reported by
 *     scripts/verify-slot-index.js.
 */

const { DRAFT_SLOT_HOLD_MS, normalizePreferredTime, capacityForSlot, spannedSlotTimes } = require('./booking-schedule');
const { isoDateParts } = require('./operational-availability');
const { bookingRef } = require('./tech-security');

const SLOT_INDEX_STORE = 'cd1-slot-index';
const STATE_BOOKED = 'booked';
const STATE_DRAFT = 'draft';

/** Reads default ON — the full-store scan exceeds the Netlify function budget
 *  and returns an HTML 504 that checkout surfaces as "invalid response".
 *  Set SLOT_INDEX_READS=0 to force the legacy Blobs scan (tests / rollback). */
function slotIndexReadsEnabled(env = process.env) {
  const flag = String(env.SLOT_INDEX_READS || '').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') return false;
  if (flag === '1' || flag === 'true' || flag === 'on') return true;
  return true;
}

let _storeOverride = null;

/** Test seam — same shape as ops-db.setOpsStoreOverride. */
function setSlotIndexStoreOverride(store) {
  _storeOverride = store || null;
}

function indexStoreUnavailable(err) {
  if (process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME) return false;
  const message = String(err && err.message ? err.message : err || '');
  return message.includes('has not been configured to use Netlify Blobs');
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

function decodeIndexPart(value) {
  const text = String(value || '');
  try { return decodeURIComponent(text); }
  catch { return text; }
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
    slotDate: decodeIndexPart(slotDate),
    // Blob servers may list "8:00 AM" as "8:00%20AM". Keep the raw key for
    // delete, and compare occupancy on the decoded slot time.
    slotTime: decodeIndexPart(slotTime),
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
  // An async list() returns a Promise of the paginator. Reading .blobs on
  // that Promise, or skipping it because a Promise is not itself iterable,
  // reports a full index as empty.
  const iterable = paged && typeof paged.then === 'function' ? await paged : paged;
  if (iterable && typeof iterable[Symbol.asyncIterator] === 'function') {
    for await (const page of iterable) {
      for (const blob of (page && page.blobs) || []) {
        const entry = parseSlotIndexKey(blob.key);
        if (entry) out.push(entry);
      }
    }
    return out;
  }
  const listing = iterable;
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
async function readSlotHolds(slotDate, slotTime, { excludeId = null, nowMs = Date.now(), bookedOnly = false } = {}) {
  const parts = isoDateParts(slotDate);
  const time = normalizePreferredTime(slotTime);
  if (!parts || !time) return [];
  const store = await slotIndexStore();
  // Date prefix, then filter the decoded time. A time prefix such as
  // "2026-10-05/8:00 AM/" misses a stored key "2026-10-05/8:00%20AM/...".
  const entries = await listSlotEntries(store, `${parts.iso}/`);
  return entries.filter((e) => {
    if (e.slotTime !== time) return false;
    if (!entryIsActive(e, nowMs)) return false;
    if (bookedOnly && e.state !== STATE_BOOKED) return false;
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
  bookedOnly = false,
} = {}) {
  if (!slotIndexReadsEnabled()) return { ok: false, reason: 'reads_disabled' };
  const parts = isoDateParts(slotDate);
  const time = normalizePreferredTime(slotTime);
  if (!parts || !time) return { ok: true, conflict: false };
  try {
    const holds = await readSlotHolds(parts.iso, time, { excludeId, nowMs, bookedOnly });
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
  if (!hold || !hold.slotDate) return;
  // Scan the whole date so a duration that occupies later slots is cleared
  // together with the start slot. Key format is unchanged.
  const entries = await listSlotEntries(store, `${hold.slotDate}/`);
  const stale = entries.filter((e) => String(e.bookingId) === String(bookingId));
  for (const entry of stale) {
    await store.delete(entry.key);
  }
}

function scheduleHoldDays(booking) {
  const days = booking && booking.appointmentSchedule && booking.appointmentSchedule.days;
  if (!Array.isArray(days)) return [];
  return days.filter((day) => day && day.date && Array.isArray(day.slots) && day.slots.length);
}

async function deleteBookingHolds(store, bookingId, booking) {
  const dates = new Set();
  const hold = booking ? slotHoldForBooking(booking) : null;
  if (hold && hold.slotDate) dates.add(hold.slotDate);
  for (const day of scheduleHoldDays(booking)) dates.add(day.date);
  for (const date of dates) {
    await deleteHoldEntries(store, bookingId, { slotDate: date });
  }
}

function holdSlotTimes(booking, hold) {
  if (!hold || !hold.slotDate || !hold.slotTime) return [];
  const span = spannedSlotTimes(
    hold.slotDate,
    hold.slotTime,
    booking && booking.appointmentDurationMinutes
  );
  if (span.ok && span.slots.length) return span.slots;
  return [hold.slotTime];
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
    if (previous) await deleteBookingHolds(store, bookingId, previous);
    await deleteBookingHolds(store, bookingId, booking);

    if (!next.active) return { ok: true, wrote: null };

    const scheduled = scheduleHoldDays(booking);
    const writes = scheduled.length
      ? scheduled.flatMap((day) => day.slots.map((slotTime) => ({ slotDate: day.date, slotTime })))
      : holdSlotTimes(booking, next).map((slotTime) => ({ slotDate: next.slotDate, slotTime }));
    let wrote = null;
    try {
      for (const slot of writes) {
        if (!slot.slotDate || !slot.slotTime) continue;
        const key = slotIndexKey({ ...next, slotDate: slot.slotDate, slotTime: slot.slotTime, bookingId });
        await store.setJSON(key, 1);
        wrote = key;
      }
    } catch (writeErr) {
      try { await deleteBookingHolds(store, bookingId, booking); } catch { /* fail closed below */ }
      const message = writeErr && writeErr.message ? writeErr.message : String(writeErr);
      console.warn('[slot-index] sync_failed', { bookingRef: bookingRef(bookingId), message, rolledBack: true });
      return { ok: false, error: 'partial_reservation_rejected', message };
    }
    return { ok: true, wrote, wroteCount: writes.length };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.warn('[slot-index] sync_failed', { bookingRef: bookingRef(bookingId), message });
    return { ok: false, error: message };
  }
}

function spanWritesFor(booking) {
  const next = slotHoldForBooking({ ...booking, isDraft: false, kind: 'booking' });
  const scheduled = scheduleHoldDays(booking);
  const writes = scheduled.length
    ? scheduled.flatMap((day) => day.slots.map((slotTime) => ({ slotDate: day.date, slotTime })))
    : holdSlotTimes(booking, next).map((slotTime) => ({ slotDate: next.slotDate, slotTime }));
  return { next, writes: writes.filter((slot) => slot.slotDate && slot.slotTime) };
}

/**
 * Every required slot has a non-expiring booked key for this booking.
 * ok:false means the index could not be read. complete:false means the read
 * succeeded and at least one required slot is missing.
 */
async function bookedSpanReady(booking, nowMs = Date.now()) {
  const bookingId = String(booking?.id || booking?.bookingId || '').trim();
  if (!bookingId) return { ok: false, reason: 'missing_booking_id', complete: false };
  const { writes } = spanWritesFor(booking);
  if (!writes.length) return { ok: false, reason: 'missing_span', complete: false };
  try {
    for (const slot of writes) {
      const holds = await readSlotHolds(slot.slotDate, slot.slotTime, { nowMs });
      const mine = holds.some((hold) => (
        String(hold.bookingId) === bookingId && hold.state === STATE_BOOKED
      ));
      if (!mine) return { ok: true, complete: false, wroteCount: writes.length };
    }
    return { ok: true, complete: true, wroteCount: writes.length };
  } catch (err) {
    if (indexStoreUnavailable(err)) return { ok: true, complete: true, skipped: 'unconfigured' };
    return { ok: false, reason: 'read_failed', complete: false, message: err && err.message };
  }
}

async function foreignHoldBlocks(slot, bookingId, nowMs) {
  const holds = await readSlotHolds(slot.slotDate, slot.slotTime, {
    excludeId: bookingId,
    nowMs,
    bookedOnly: true,
  });
  const capacity = capacityForSlot(slot.slotDate, slot.slotTime, null, new Date(nowMs));
  return holds.length >= capacity;
}

const SPAN_CLAIM_STALE_MS = 15 * 1000;
const spanGates = new Map();

function withSpanGate(writes, work) {
  const keys = [...new Set(writes.map((slot) => `${slot.slotDate}|${slot.slotTime}`))].sort();
  const previous = Promise.all(keys.map((key) => spanGates.get(key) || Promise.resolve()));
  let release;
  const gate = new Promise((done) => { release = done; });
  const tail = previous.then(() => gate, () => gate);
  for (const key of keys) spanGates.set(key, tail);
  return previous.then(async () => {
    try {
      return await work();
    } finally {
      release();
      for (const key of keys) {
        if (spanGates.get(key) === tail) spanGates.delete(key);
      }
    }
  });
}

async function claimSpan(store, writes, bookingId) {
  if (!store || typeof store.set !== 'function') return { ok: true, owned: [] };
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const owned = [];
  for (const slot of writes) {
    const key = `span-claim/${slot.slotDate}/${encodeURIComponent(slot.slotTime)}`;
    const payload = JSON.stringify({ bookingId, nonce, at: new Date().toISOString() });
    let result = await store.set(key, payload, { onlyIfNew: true });
    if (result && result.modified === false) {
      const existing = await store.get(key, { type: 'json' }).catch(() => null);
      const age = Date.now() - Date.parse(existing && existing.at || '');
      const same = existing && String(existing.bookingId) === String(bookingId);
      if (!same && !(Number.isFinite(age) && age > SPAN_CLAIM_STALE_MS)) {
        await deleteKeys(store, owned);
        return { ok: false, owned: [] };
      }
      if (!same) await store.delete(key);
      result = await store.set(key, payload, { onlyIfNew: true });
      if (result && result.modified === false) {
        await deleteKeys(store, owned);
        return { ok: false, owned: [] };
      }
    }
    const seen = await store.get(key, { type: 'text' }).catch(() => null);
    if (seen && !String(seen).includes(nonce)) {
      await deleteKeys(store, owned);
      return { ok: false, owned: [] };
    }
    owned.push(key);
  }
  return { ok: true, owned };
}

async function deleteKeys(store, keys) {
  for (const key of keys) {
    await store.delete(key);
  }
}

async function deleteDraftHoldsOnly(store, bookingId, writes) {
  const dates = new Set(writes.map((slot) => slot.slotDate));
  for (const date of dates) {
    const entries = await listSlotEntries(store, `${date}/`);
    for (const entry of entries) {
      if (String(entry.bookingId) !== String(bookingId)) continue;
      if (entry.state !== STATE_DRAFT) continue;
      await store.delete(entry.key);
    }
  }
}

/**
 * Write every booked slot for a finalize without dropping draft holds first.
 * A partial write deletes only the booked keys from this attempt. Draft holds
 * and every other booking's keys stay. Callers must not confirm the customer
 * unless ok is true.
 */
async function reserveBookedSpan(booking, nowMs = Date.now()) {
  const bookingId = String(booking?.id || booking?.bookingId || '').trim();
  if (!bookingId) return { ok: false, error: 'missing_booking_id' };
  const { next, writes } = spanWritesFor(booking);
  if (!next.active || !writes.length) return { ok: false, error: 'missing_span' };

  return withSpanGate(writes, async () => {
    let claim = { ok: true, owned: [] };
    try {
      const store = await slotIndexStore();
      for (const slot of writes) {
        if (await foreignHoldBlocks(slot, bookingId, nowMs)) {
          return { ok: false, error: 'booking_slot_unavailable' };
        }
      }

      claim = await claimSpan(store, writes, bookingId);
      if (!claim.ok) return { ok: false, error: 'booking_slot_unavailable' };

      const written = [];
      try {
        for (const slot of writes) {
          const key = slotIndexKey({
            ...next,
            slotDate: slot.slotDate,
            slotTime: slot.slotTime,
            bookingId,
          });
          await store.setJSON(key, 1);
          written.push(key);
        }
      } catch (writeErr) {
        if (indexStoreUnavailable(writeErr) && written.length === 0) {
          return { ok: true, wroteCount: 0, skipped: 'unconfigured' };
        }
        try { await deleteKeys(store, written); } catch { /* drafts and other bookings stay */ }
        const message = writeErr && writeErr.message ? writeErr.message : String(writeErr);
        console.warn('[slot-index] sync_failed', { bookingRef: bookingRef(bookingId), message, rolledBack: true });
        return { ok: false, error: 'partial_reservation_rejected', message };
      }

      for (const slot of writes) {
        if (await foreignHoldBlocks(slot, bookingId, nowMs)) {
          try { await deleteKeys(store, written); } catch { /* keep other bookings */ }
          return { ok: false, error: 'booking_slot_unavailable' };
        }
      }

      await deleteDraftHoldsOnly(store, bookingId, writes);
      return { ok: true, wroteCount: writes.length };
    } catch (err) {
      if (indexStoreUnavailable(err)) return { ok: true, wroteCount: 0, skipped: 'unconfigured' };
      const message = err && err.message ? err.message : String(err);
      console.warn('[slot-index] sync_failed', { bookingRef: bookingRef(bookingId), message });
      return { ok: false, error: message };
    } finally {
      if (claim.owned && claim.owned.length) {
        try {
          const store = await slotIndexStore();
          await deleteKeys(store, claim.owned);
        } catch { /* booked keys remain the occupancy lock */ }
      }
    }
  });
}

function slotIdentity(slot) {
  const parts = isoDateParts(slot && slot.slotDate);
  const time = normalizePreferredTime(slot && slot.slotTime);
  if (!parts || !time) return '';
  return `${parts.iso}|${time}`;
}

/**
 * Move booked occupancy onto the next span before the booking record changes.
 * Old keys stay until releaseBookedSlots. Overlap is not rewritten. A failed
 * write deletes only the keys this attempt added. An unconfigured index is
 * not success: reschedule must fail closed when the index cannot answer.
 */
async function relocateBookedSpan({ previous, next, nowMs = Date.now() } = {}) {
  if (!slotIndexReadsEnabled()) {
    return { ok: false, error: 'booking_verification_unavailable' };
  }
  const bookingId = String(
    (next && (next.id || next.bookingId))
    || (previous && (previous.id || previous.bookingId))
    || ''
  ).trim();
  if (!bookingId) return { ok: false, error: 'missing_booking_id' };

  const previousWrites = spanWritesFor(previous || {}).writes;
  const planned = spanWritesFor(next || {});
  if (!planned.next.active || !planned.writes.length) {
    return { ok: false, error: 'missing_span' };
  }
  const nextWrites = planned.writes;

  return withSpanGate([...previousWrites, ...nextWrites], async () => {
    let claim = { ok: true, owned: [] };
    const added = [];
    try {
      const store = await slotIndexStore();
      const missing = [];
      for (const slot of nextWrites) {
        const holds = await readSlotHolds(slot.slotDate, slot.slotTime, { nowMs });
        const mine = holds.some((hold) => (
          String(hold.bookingId) === bookingId && hold.state === STATE_BOOKED
        ));
        if (!mine) missing.push(slot);
      }

      for (const slot of nextWrites) {
        if (await foreignHoldBlocks(slot, bookingId, nowMs)) {
          return { ok: false, error: 'booking_slot_unavailable', added: [] };
        }
      }

      claim = await claimSpan(store, nextWrites, bookingId);
      if (!claim.ok) return { ok: false, error: 'booking_slot_unavailable', added: [] };

      try {
        for (const slot of missing) {
          const key = slotIndexKey({
            ...planned.next,
            slotDate: slot.slotDate,
            slotTime: slot.slotTime,
            bookingId,
          });
          await store.setJSON(key, 1);
          added.push(key);
        }
      } catch (writeErr) {
        try { await deleteKeys(store, added); } catch { /* old keys and other bookings stay */ }
        const message = writeErr && writeErr.message ? writeErr.message : String(writeErr);
        console.warn('[slot-index] sync_failed', { bookingRef: bookingRef(bookingId), message, rolledBack: true });
        return { ok: false, error: 'partial_reservation_rejected', message, added: [] };
      }

      for (const slot of nextWrites) {
        if (await foreignHoldBlocks(slot, bookingId, nowMs)) {
          try { await deleteKeys(store, added); } catch { /* keep overlap and other bookings */ }
          return { ok: false, error: 'booking_slot_unavailable', added: [] };
        }
      }

      const nextIds = new Set(nextWrites.map(slotIdentity));
      const seen = new Set();
      const obsolete = [];
      for (const slot of previousWrites) {
        const id = slotIdentity(slot);
        if (!id || nextIds.has(id) || seen.has(id)) continue;
        seen.add(id);
        const [slotDate, slotTime] = id.split('|');
        obsolete.push({ slotDate, slotTime });
      }
      return { ok: true, added, obsolete, writes: nextWrites };
    } catch (err) {
      try {
        const store = await slotIndexStore();
        if (added.length) await deleteKeys(store, added);
      } catch { /* fail closed: do not drop the previous occupancy */ }
      const message = err && err.message ? err.message : String(err);
      console.warn('[slot-index] sync_failed', { bookingRef: bookingRef(bookingId), message });
      return { ok: false, error: 'booking_verification_unavailable', message, added: [] };
    } finally {
      if (claim.owned && claim.owned.length) {
        try {
          const store = await slotIndexStore();
          await deleteKeys(store, claim.owned);
        } catch { /* booked keys remain the occupancy lock */ }
      }
    }
  });
}

/**
 * Delete only this booking's keys on the listed slots. Missing keys are
 * already released. Another customer's key on the same slot stays.
 */
async function releaseBookedSlots(bookingId, slots) {
  const id = String(bookingId || '').trim();
  if (!id) return { ok: false, error: 'missing_booking_id' };
  if (!slotIndexReadsEnabled()) return { ok: false, error: 'booking_verification_unavailable' };

  const wanted = new Map();
  for (const slot of slots || []) {
    const ident = slotIdentity(slot);
    if (!ident) continue;
    const [date, time] = ident.split('|');
    if (!wanted.has(date)) wanted.set(date, new Set());
    wanted.get(date).add(time);
  }
  if (!wanted.size) return { ok: true, released: 0 };

  try {
    const store = await slotIndexStore();
    for (const [date, times] of wanted) {
      const entries = await listSlotEntries(store, `${date}/`);
      for (const entry of entries) {
        if (String(entry.bookingId) !== id) continue;
        if (!times.has(entry.slotTime)) continue;
        await store.delete(entry.key);
      }
    }
    for (const [date, times] of wanted) {
      const entries = await listSlotEntries(store, `${date}/`);
      for (const entry of entries) {
        if (String(entry.bookingId) !== id) continue;
        if (times.has(entry.slotTime)) return { ok: false, error: 'occupancy_incomplete' };
      }
    }
    return { ok: true, released: slots.length };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return { ok: false, error: 'booking_verification_unavailable', message };
  }
}

/** Drop keys from a failed attempt unless the stored booking still occupies them. */
async function dropSpanKeysUnlessNeeded(addedKeys, booking) {
  const keys = (Array.isArray(addedKeys) ? addedKeys : []).filter(Boolean);
  if (!keys.length) return { ok: true, dropped: [] };
  const bookingId = String(booking && (booking.id || booking.bookingId) || '').trim();
  const needed = new Set();
  if (bookingId) {
    const planned = spanWritesFor(booking);
    if (planned.next.active) {
      for (const slot of planned.writes) {
        needed.add(slotIndexKey({
          ...planned.next,
          slotDate: slot.slotDate,
          slotTime: slot.slotTime,
          bookingId,
        }));
      }
    }
  }
  const drop = keys.filter((key) => !needed.has(key));
  try {
    const store = await slotIndexStore();
    await deleteKeys(store, drop);
    return { ok: true, dropped: drop };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return { ok: false, error: 'occupancy_incomplete', message };
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
  reserveBookedSpan,
  bookedSpanReady,
  relocateBookedSpan,
  releaseBookedSlots,
  dropSpanKeysUnlessNeeded,
  scheduleSlotIndexSync,
};
