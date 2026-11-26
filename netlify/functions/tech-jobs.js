// Technician: list assigned jobs + post status updates (not completion).
const {
  blobsStore, listAllBlobs, fetchBlobRecords, jsonCors, validateTechSession, sanitizeText, readJsonStrong,
} = require('../lib/tech-security');

const unavailable = () => jsonCors(503, { ok: false, error: 'temporarily_unavailable' }, { 'Retry-After': '5' });
const isStrongReadError = (e) => !!(e && e.code === 'strong_read_failed');
const isIncompleteListing = (e) => !!(e && e.code === 'listing_incomplete');
const {
  technicianAccess, technicianTerminalState, redactTechJob, createRosterLoader, resolveTechAssignment, bookingServiceDate,
} = require('../lib/tech-dispatch-privacy');
const {
  createWithdrawalRequest, listWithdrawalRequests, projectWithdrawalForTech,
} = require('../lib/tech-withdrawal');
const { isInternalBookingStoreKey } = require('../lib/booking-visibility');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const LIST_READ_CONCURRENCY = 20;
const STRONG_READ_CONCURRENCY = 20;

class IncompleteListingError extends Error {
  constructor(cause) {
    super('listing_incomplete');
    this.code = 'listing_incomplete';
    this.cause = cause;
  }
}

/**
 * Every booking key, from every list page. Unlike the shared listAllBlobs,
 * this never falls back to a single unpaginated page: any page failure throws
 * IncompleteListingError so the technician list answers 503 instead of a
 * silently partial 200. Scoped to the technician list only.
 */
async function listBookingKeysComplete(store) {
  if (!store || typeof store.list !== 'function') throw new IncompleteListingError(new Error('invalid_store'));
  const keys = [];
  try {
    const paged = store.list({ paginate: true });
    if (!paged || typeof paged[Symbol.asyncIterator] !== 'function') throw new Error('pagination_unsupported');
    for await (const page of paged) {
      if (!page || !Array.isArray(page.blobs)) throw new Error('malformed_page');
      for (const b of page.blobs) {
        const key = b && b.key;
        if (key && !isInternalBookingStoreKey(key)) keys.push(key);
      }
    }
  } catch (e) {
    throw new IncompleteListingError(e);
  }
  return keys;
}

/**
 * Rolling pool: at most `limit` calls in flight; the next item starts as soon
 * as any call finishes (no batch barrier). Only `limit` worker promises exist
 * at any time. The first error stops new work, waits for in-flight calls to
 * settle, then rethrows.
 */
async function forEachPooled(items, limit, fn) {
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (failure === null && next < items.length) {
      const i = next;
      next += 1;
      try {
        await fn(items[i], i);
      } catch (e) {
        if (failure === null) failure = e;
      }
    }
  };
  const workers = [];
  for (let w = 0; w < Math.min(limit, items.length); w += 1) workers.push(worker());
  await Promise.all(workers);
  if (failure) throw failure;
}

async function rosterRecords() {
  const store = await blobsStore('cd1-tech-accounts');
  const blobs = await listAllBlobs(store, 'cd1-tech-accounts');
  return fetchBlobRecords(store, blobs.filter((b) => String(b.key || '').startsWith('tech-')), 15, { strict: true });
}
const {
  projectJobForTech,
  TECH_STATUS_UPDATES,
  appendEventLog,
  isTechEligibleBooking,
  canTechTransition,
  normalizeTechJobStatus,
} = require('../lib/ops-workflow');
const {
  getBookingRecord,
  commitBooking,
  setBookingStoreOverride,
} = require('../lib/booking-repository');
const { buildNextAggregate, normalizeAggregate } = require('../lib/booking-aggregate');

const LEGACY_STATUS = {
  accepted: 'Scheduled',
  en_route: 'En Route',
  arrived: 'In Progress',
  in_progress: 'In Progress',
  paused: 'In Progress',
  issue_reported: 'Problem',
};

const FIELD_ACTIVE = new Set(['en_route', 'arrived', 'in_progress', 'paused', 'issue_reported']);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});

  const session = await validateTechSession(event.headers || {});
  if (!session) return jsonCors(401, { ok: false, error: 'unauthorized' });

  if (event.httpMethod === 'GET') {
    const qs = event.queryStringParameters || {};
    const date = String(qs.date || '').trim();
    if (date && !DATE_RE.test(date)) return jsonCors(400, { ok: false, error: 'invalid_date' });
    try {
      const store = await blobsStore('cd1-bookings');
      // Phase 1 — every key from every list page (incomplete listing → 503),
      // read with eventual consistency through a rolling pool of at most 20
      // reads in flight (the Admin list's tested ceiling). Used only to find
      // candidates: only matching keys are kept, never the records or PII.
      const keys = await listBookingKeysComplete(store);
      const rosterLoader = createRosterLoader(rosterRecords);
      let rosterOnce = null;
      const loadRoster = () => {
        if (!rosterOnce) rosterOnce = rosterLoader();
        return rosterOnce;
      };
      const nowMs = Date.now();

      const candidate = new Array(keys.length).fill(false);
      await forEachPooled(keys, LIST_READ_CONCURRENCY, async (key, i) => {
        let b;
        try {
          b = await store.get(key, { type: 'json' });
        } catch (e) {
          throw new IncompleteListingError(e); // an unread booking = incomplete list
        }
        if (!b || typeof b !== 'object') return; // deleted after listing
        if (b.isDraft || b.isTest || b.archived || !isTechEligibleBooking(b)) return;
        if (date && bookingServiceDate(b) !== date) return;
        if ((await resolveTechAssignment(b, session, { loadRoster })).assigned) candidate[i] = true;
      });
      const shortlist = keys.filter((_, i) => candidate[i]);

      // Phase 2 — strong re-read of the shortlist only, same rolling pool.
      // Every disclosure decision is made on this fresh copy, so a stale
      // eventual read can hide a job for one refresh but can never release PII
      // after cancellation, completion, reassignment or rescheduling. A failed
      // strong read throws and the request fails closed with 503.
      const freshRows = new Array(shortlist.length).fill(null);
      await forEachPooled(shortlist, STRONG_READ_CONCURRENCY, async (key, i) => {
        freshRows[i] = (await readJsonStrong(store, key)).data;
      });
      const jobs = [];
      for (const b of freshRows) {
        if (!b || b.isDraft || b.isTest || b.archived || !isTechEligibleBooking(b)) continue;
        if (date && bookingServiceDate(b) !== date) continue;
        // Server-side privacy gate: assignment by id (or a unique legacy name),
        // non-terminal in every status field, and within 12 hours of the
        // Eastern arrival start. Everything else is redacted before it leaves.
        const access = await technicianAccess(b, session, { nowMs, loadRoster });
        if (!access.assigned || access.terminal) continue;
        jobs.push(redactTechJob(projectJobForTech(b), access));
      }
      jobs.sort((a, b) => String(a.confirmedDate || a.preferredDate || '')
        .localeCompare(String(b.confirmedDate || b.preferredDate || '')));

      let withdrawals = [];
      try {
        withdrawals = (await listWithdrawalRequests({ status: 'all', techId: session.techId }))
          .map(projectWithdrawalForTech);
      } catch { withdrawals = []; }

      return jsonCors(200, {
        ok: true,
        count: jobs.length,
        jobs,
        date: date || null,
        withdrawals,
        serverNow: new Date(nowMs).toISOString(),
      });
    } catch (e) {
      if (isStrongReadError(e) || isIncompleteListing(e)) return unavailable();
      return jsonCors(500, { ok: false, error: 'failed_to_load_jobs' });
    }
  }

  if (event.httpMethod !== 'POST') return jsonCors(405, { ok: false, error: 'method_not_allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'invalid_json' }); }

  const bookingId = sanitizeText(body.bookingId, 48);
  if (String(body.action || '') === 'request_withdrawal') {
    if (!bookingId) return jsonCors(400, { ok: false, error: 'bookingId_required' });
    const store = await blobsStore('cd1-bookings');
    let rec;
    try {
      rec = await getBookingRecord(bookingId, { storeOverride: store, requireStrong: true });
    } catch (e) {
      if (isStrongReadError(e)) return unavailable();
      throw e;
    }
    if (!rec.exists || !rec.booking) return jsonCors(404, { ok: false, error: 'booking_not_found' });
    // Files a pending request only. The booking is not written here.
    const created = await createWithdrawalRequest({
      booking: rec.booking,
      session,
      reason: body.reason,
      loadRoster: createRosterLoader(rosterRecords),
    });
    if (!created.ok) {
      const { statusCode, ok, ...rest } = created;
      return jsonCors(statusCode || 400, { ...rest, ok: false });
    }
    return jsonCors(200, { ok: true, request: projectWithdrawalForTech(created.request) });
  }
  const newStatus = sanitizeText(body.status, 40).toLowerCase();
  const note = sanitizeText(body.note, 500);

  if (!bookingId) return jsonCors(400, { ok: false, error: 'bookingId_required' });
  if (!TECH_STATUS_UPDATES.has(newStatus)) {
    return jsonCors(400, { ok: false, error: 'invalid_status', allowed: [...TECH_STATUS_UPDATES] });
  }

  const store = await blobsStore('cd1-bookings');
  setBookingStoreOverride(store);
  try {
    let current;
    try {
      current = await getBookingRecord(bookingId, { storeOverride: store, requireStrong: true });
    } catch (e) {
      if (isStrongReadError(e)) return unavailable();
      throw e;
    }
    if (!current.exists || !current.booking) {
      return jsonCors(404, { ok: false, error: 'booking_not_found' });
    }
    const booking = current.booking;
    const assignment = await resolveTechAssignment(booking, session, {
      loadRoster: createRosterLoader(rosterRecords),
    });
    if (!assignment.assigned) {
      return jsonCors(403, { ok: false, error: 'not_assigned_to_you' });
    }
    // Terminal in any status field (legacy status, jobStatus, serviceStatus)
    // blocks field updates even when jobStatus alone looks active.
    if (!isTechEligibleBooking(booking) || technicianTerminalState(booking).terminal) {
      return jsonCors(403, { ok: false, error: 'not_confirmed_eligible' });
    }
    const fromStatus = normalizeTechJobStatus(booking);
    if (!canTechTransition(fromStatus, newStatus)) {
      return jsonCors(409, {
        ok: false,
        error: 'invalid_status_transition',
        from: fromStatus || null,
        to: newStatus,
      });
    }

    const now = new Date().toISOString();
    const updates = {
      jobStatus: newStatus,
      status: LEGACY_STATUS[newStatus] || booking.status,
      lastTechUpdate: now,
      lastTechUpdateBy: session.techId,
      updatedAt: now,
      updatedByRole: 'technician',
      updatedBy: session.techId,
      lastAction: 'tech_status_update',
      eventLog: appendEventLog(booking, {
        action: 'tech_status_update',
        status: newStatus,
        by: 'technician',
        technicianId: session.techId,
        ...(note ? { note } : {}),
      }),
    };
    // Keep appointmentStatus confirmed while field work is active so scheduling
    // identity stays intact; jobStatus drives customer mutation policy (PDA-11).
    if (FIELD_ACTIVE.has(newStatus) && !booking.appointmentStatus) {
      updates.appointmentStatus = 'confirmed';
    }
    if (newStatus === 'en_route') updates.enRouteAt = now;
    if (newStatus === 'arrived') updates.arrivedAt = now;
    if (newStatus === 'in_progress') updates.startedAt = now;
    if (newStatus === 'paused') updates.pausedAt = now;
    if (newStatus === 'issue_reported') {
      updates.hasProblem = true;
      updates.lastProblem = note || 'Issue reported by technician';
    }
    if (note) {
      updates.techNotes = ((booking.techNotes || '') + '\n[' + now.slice(0, 16) + '] ' + note).trim();
    }

    const { ok: normOk, aggregate: base } = normalizeAggregate(booking, { allowDraft: false });
    const next = buildNextAggregate(normOk ? base : booking, updates);
    const expected = Math.max(0, Math.round(Number(booking.bookingVersion) || 0));
    const committed = await commitBooking({
      bookingId,
      expectedBookingVersion: expected,
      nextAggregate: next,
      storeOverride: store,
    });
    if (!committed.ok) {
      return jsonCors(committed.statusCode || 409, {
        ok: false,
        error: committed.error || 'version_conflict',
        actualBookingVersion: committed.actualBookingVersion,
      });
    }
    return jsonCors(200, {
      ok: true,
      bookingId,
      jobStatus: newStatus,
      updatedAt: now,
      bookingVersion: committed.bookingVersion,
    });
  } finally {
    setBookingStoreOverride(null);
  }
};

// Exposed for tests only.
exports._forEachPooled = forEachPooled;
