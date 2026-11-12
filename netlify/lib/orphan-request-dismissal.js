'use strict';

/**
 * Admin dismissal of change requests that belong to no real appointment:
 * the booking does not exist (test-suite leftovers) or is archived as a test.
 *
 * This never touches the booking, never changes money and never notifies
 * anyone. Requests on a live booking are refused; those still go through
 * Approve / Reject. The record keeps its history (previousStatus, who, when).
 */

const { isOpenStatus } = require('./admin-change-request-projection');
const { isArchivedOrTest } = require('./booking-visibility');

const DISMISSED_STATUS = 'dismissed';
const MAX_BATCH = 100;

function eligibility(record, booking) {
  if (!record) return { ok: false, error: 'not_found' };
  const status = String(record.status || 'pending').toLowerCase();
  if (status === DISMISSED_STATUS) return { ok: true, idempotent: true };
  if (!isOpenStatus(status)) return { ok: false, error: 'not_open', status };
  if (!record.bookingId) return { ok: true, why: 'no_booking_id' };
  if (!booking) return { ok: true, why: 'booking_missing' };
  if (isArchivedOrTest(booking)) return { ok: true, why: 'booking_archived_test' };
  return { ok: false, error: 'booking_active' };
}

/**
 * @param {object} deps
 * @param {object} deps.store        request Blob store (get / setJSON)
 * @param {(id: string) => Promise<object|null>} deps.getBooking
 */
async function dismissOrphanRequests({ store, getBooking }, {
  requestIds,
  dryRun = false,
  reason = '',
  now = new Date().toISOString(),
} = {}) {
  const ids = [...new Set((Array.isArray(requestIds) ? requestIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean))];
  if (!ids.length) return { ok: false, statusCode: 400, error: 'request_ids_required' };
  if (ids.length > MAX_BATCH) return { ok: false, statusCode: 400, error: 'too_many_requests', max: MAX_BATCH };

  const results = [];
  for (const id of ids) {
    let record = null;
    if (typeof store.getWithMetadata === 'function') {
      const got = await store.getWithMetadata(id, { type: 'json', consistency: 'strong' }).catch(() => null);
      record = got && got.data;
    }
    if (!record) record = await store.get(id, { type: 'json' }).catch(() => null);
    let booking = null;
    if (record && record.bookingId) {
      try {
        booking = await getBooking(record.bookingId);
      } catch {
        // An outage must never read as "booking missing".
        results.push({ requestId: id, dismissed: false, error: 'booking_lookup_failed' });
        continue;
      }
    }
    const check = eligibility(record, booking);
    if (!check.ok) {
      results.push({ requestId: id, dismissed: false, error: check.error });
      continue;
    }
    if (check.idempotent) {
      results.push({ requestId: id, dismissed: true, idempotent: true });
      continue;
    }
    if (!dryRun) {
      await store.setJSON(id, {
        ...record,
        previousStatus: record.status || 'pending',
        status: DISMISSED_STATUS,
        dismissedAt: now,
        dismissedBy: 'admin',
        dismissReason: String(reason || check.why).slice(0, 200),
        updatedAt: now,
      });
    }
    results.push({ requestId: id, dismissed: !dryRun, eligible: true, why: check.why });
  }
  return {
    ok: true,
    dryRun: !!dryRun,
    eligible: results.filter((r) => r.eligible || r.idempotent).length,
    dismissed: results.filter((r) => r.dismissed && !r.idempotent).length,
    refused: results.filter((r) => r.error).length,
    results,
  };
}

/**
 * One strict read of the whole booking store, indexed by Blob key and by
 * payload id. Any list or read failure throws, so an outage can never make a
 * live booking look missing. (ops-db getBooking swallows errors and falls
 * back to a full scan per call, which is unsafe and too slow here.)
 */
async function strictBookingLookup(store, { normalizeKey = (k) => String(k || '').trim() } = {}) {
  if (!store || typeof store.list !== 'function') throw new Error('booking_store_unavailable');
  const keys = [];
  const paged = store.list({ paginate: true });
  if (paged && typeof paged[Symbol.asyncIterator] === 'function') {
    for await (const page of paged) keys.push(...((page && page.blobs) || []).map((b) => b.key));
  } else {
    const listing = await paged;
    if (!listing || !Array.isArray(listing.blobs)) throw new Error('booking_list_incomplete');
    keys.push(...listing.blobs.map((b) => b.key));
  }
  const index = new Map();
  for (let i = 0; i < keys.length; i += 20) {
    const chunk = keys.slice(i, i + 20);
    const rows = await Promise.all(chunk.map((key) => store.get(key, { type: 'json' })));
    rows.forEach((row, j) => {
      if (!row || typeof row !== 'object') return;
      for (const k of [chunk[j], row.id, row.bookingId]) {
        const n = normalizeKey(k);
        if (n && !index.has(n)) index.set(n, row);
      }
    });
  }
  return async (bookingId) => index.get(normalizeKey(bookingId)) || null;
}

module.exports = {
  strictBookingLookup,
  dismissOrphanRequests,
  eligibility,
  DISMISSED_STATUS,
  MAX_BATCH,
};
