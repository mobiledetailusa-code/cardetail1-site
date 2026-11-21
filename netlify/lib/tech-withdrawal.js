'use strict';

/**
 * Technician withdrawal requests (QuickOps Daily Dispatch).
 *
 * A technician asks to be taken off a job. The request needs a reason and at
 * least 12 hours' notice before the scheduled Eastern arrival start. Nothing
 * on the booking changes until an admin approves.
 *
 * Approval reuses the existing Quick Ops unassign (`unassignQuickOpsTech`):
 * the requesting technician is removed, the customer booking, payment, and
 * SMS state stay as they are. Approval never cancels the appointment.
 *
 * Stale guard: the request records the assignment it was filed against
 * (technician id + assignedAt). If the booking is now assigned to someone
 * else, or re-assigned since, approval is refused and the booking is not
 * touched. The unassign commit itself is version-checked (commitBooking CAS).
 *
 * Requests live in their own small blob store, not in the customer
 * change-request queue, so they never show in the customer's portal and can
 * never reach the customer auto-apply cancellation path.
 */

const crypto = require('crypto');
const { withdrawalNoticeCheck, resolveTechAssignment, technicianTerminalState } = require('./tech-dispatch-privacy');

const WITHDRAWAL_STORE = 'cd1-tech-withdrawal-requests';
const KEY_PREFIX = 'twr_';
const MIN_REASON = 10;
const MAX_REASON = 500;
const CLAIM_STALE_MS = 2 * 60 * 1000;

let storeOverride = null;
function setWithdrawalStoreOverride(store) {
  storeOverride = store || null;
}

async function withdrawalStore() {
  if (storeOverride) return storeOverride;
  const { blobsStore } = require('./tech-security');
  return blobsStore(WITHDRAWAL_STORE);
}

function writeWasApplied(result) {
  if (result == null) return true;
  return result.modified !== false;
}

// Strong read only; a failed read throws (StrongReadError). An eventual copy
// could carry a stale status or etag and must never drive a decision.
async function readWithEtag(store, key) {
  const { readJsonStrong } = require('./tech-security');
  return readJsonStrong(store, key);
}

async function casWrite(store, key, value, etag) {
  try {
    const res = etag
      ? await store.setJSON(key, value, { onlyIfMatch: etag })
      : await store.setJSON(key, value);
    return writeWasApplied(res);
  } catch {
    return false;
  }
}

async function listAll(store) {
  const { listAllBlobs, fetchBlobRecords } = require('./tech-security');
  const blobs = (await listAllBlobs(store, WITHDRAWAL_STORE)).filter((b) => String(b.key || '').startsWith(KEY_PREFIX));
  return fetchBlobRecords(store, blobs, 20);
}

function isOpen(record, nowMs = Date.now()) {
  if (!record) return false;
  if (record.status === 'pending') return true;
  if (record.status === 'approving') {
    return nowMs - Date.parse(record.claimedAt || 0) > CLAIM_STALE_MS;
  }
  return false;
}

function sanitizeReason(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_REASON);
}

/** Admin list row. Contains no customer PII (booking id only). */
function projectWithdrawalForAdmin(r) {
  return {
    id: r.id,
    bookingId: r.bookingId,
    techId: r.techId,
    techName: r.techName || '',
    reason: r.reason || '',
    status: r.status,
    createdAt: r.createdAt,
    arrivalStartAt: r.arrivalStartAt || '',
    decidedAt: r.decidedAt || '',
    adminNote: r.adminNote || '',
    outcome: r.outcome || '',
  };
}

/** Technician view of their own requests. */
function projectWithdrawalForTech(r) {
  return {
    id: r.id,
    bookingId: r.bookingId,
    status: r.status === 'approving' ? 'pending' : r.status,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt || '',
  };
}

/**
 * Technician files a withdrawal request.
 * @returns {Promise<{ok:true, request:object} | {ok:false, statusCode:number, error:string, [k:string]:any}>}
 */
async function createWithdrawalRequest({ booking, session, reason, nowMs = Date.now(), loadRoster } = {}) {
  const cleanReason = sanitizeReason(reason);
  if (cleanReason.length < MIN_REASON) {
    return { ok: false, statusCode: 400, error: 'reason_required', minLength: MIN_REASON };
  }
  if (!booking) return { ok: false, statusCode: 404, error: 'booking_not_found' };

  const assignment = await resolveTechAssignment(booking, session, { loadRoster });
  if (!assignment.assigned) return { ok: false, statusCode: 403, error: 'not_assigned_to_you' };
  if (technicianTerminalState(booking).terminal) {
    return { ok: false, statusCode: 409, error: 'job_not_active' };
  }
  const notice = withdrawalNoticeCheck(booking, nowMs);
  if (!notice.ok) {
    return {
      ok: false,
      statusCode: 400,
      error: notice.error,
      ...(notice.startsAt ? { startsAt: notice.startsAt } : {}),
      message: notice.error === 'insufficient_notice'
        ? 'Withdrawal needs at least 12 hours notice. Call the office.'
        : 'This job has no confirmed arrival time. Call the office.',
    };
  }

  const store = await withdrawalStore();
  const techId = String(session.techId || '').trim();
  const bookingId = String(booking.id || booking.bookingId || '').trim();
  const existing = (await listAll(store)).find((r) => r
    && r.bookingId === bookingId
    && String(r.techId).toLowerCase() === techId.toLowerCase()
    && isOpen(r, nowMs));
  if (existing) {
    return { ok: false, statusCode: 409, error: 'request_already_pending', request: projectWithdrawalForTech(existing) };
  }

  const id = `${KEY_PREFIX}${crypto.randomBytes(12).toString('base64url')}`;
  const record = {
    id,
    bookingId,
    techId,
    techName: String((session.tech && (session.tech.fullName || session.tech.name)) || session.techName || ''),
    reason: cleanReason,
    status: 'pending',
    createdAt: new Date(nowMs).toISOString(),
    arrivalStartAt: new Date(notice.schedule.startMs).toISOString(),
    assignmentSnapshot: {
      assignedTechId: String(booking.assignedTechId || booking.assignedTech || booking.assignedTechName || '').trim(),
      assignedAt: String(booking.assignedAt || ''),
      bookingVersion: Math.max(0, Math.round(Number(booking.bookingVersion) || 0)),
    },
    decidedAt: '',
    decidedBy: '',
    adminNote: '',
    outcome: '',
  };
  let written;
  try {
    written = await store.setJSON(id, record, { onlyIfNew: true });
  } catch {
    return { ok: false, statusCode: 503, error: 'storage_unavailable' };
  }
  if (!writeWasApplied(written)) return { ok: false, statusCode: 409, error: 'request_conflict' };
  return { ok: true, request: record };
}

async function listWithdrawalRequests({ status = 'pending', techId = '' } = {}) {
  const store = await withdrawalStore();
  const now = Date.now();
  let rows = (await listAll(store)).filter(Boolean);
  if (techId) rows = rows.filter((r) => String(r.techId).toLowerCase() === String(techId).toLowerCase());
  if (status === 'pending') rows = rows.filter((r) => isOpen(r, now) || r.status === 'approving');
  else if (status && status !== 'all') rows = rows.filter((r) => r.status === status);
  rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return rows;
}

/**
 * Is the booking still assigned to the technician, under the same
 * assignment, that the request was filed against?
 */
function sameAssignment(booking, request) {
  if (!booking) return false;
  const snap = request.assignmentSnapshot || {};
  // Compare with the exact assignee value recorded when the request was filed
  // (a technician id, or a legacy unique name verified at that time).
  const expected = String(snap.assignedTechId || request.techId || '').trim().toLowerCase();
  const current = String(booking.assignedTechId || booking.assignedTech || booking.assignedTechName || '').trim().toLowerCase();
  if (!current || !expected || current !== expected) return false;
  if (String(booking.assignmentKind || '').toLowerCase() === 'freelance') return false;
  const snapAt = snap.assignedAt;
  if (snapAt && String(booking.assignedAt || '') !== snapAt) return false;
  return true;
}

/**
 * Admin decision. `deps` is injectable for tests.
 * @param {{ id:string, decision:'approve'|'decline', adminNote?:string, actor?:string }} input
 * @param {{ loadBooking?:Function, unassign?:Function }} deps
 */
async function decideWithdrawalRequest(input = {}, deps = {}) {
  const id = String(input.id || '').trim();
  const decision = String(input.decision || '').toLowerCase();
  if (!id.startsWith(KEY_PREFIX)) return { ok: false, statusCode: 400, error: 'invalid_request_id' };
  if (decision !== 'approve' && decision !== 'decline') return { ok: false, statusCode: 400, error: 'invalid_decision' };
  const adminNote = sanitizeReason(input.adminNote).slice(0, 300);
  const actor = String(input.actor || 'admin').slice(0, 64);

  const loadBooking = deps.loadBooking || (async (bookingId) => {
    const { getBookingRecord } = require('./booking-repository');
    const rec = await getBookingRecord(bookingId, { requireStrong: true });
    return rec && rec.exists ? rec.booking : null;
  });
  const unassign = deps.unassign || ((booking, opts) => require('./quick-ops-assign').unassignQuickOpsTech(booking, opts));

  const store = await withdrawalStore();
  let read;
  try {
    read = await readWithEtag(store, id);
  } catch {
    return { ok: false, statusCode: 503, error: 'temporarily_unavailable' };
  }
  const request = read.data;
  if (!request) return { ok: false, statusCode: 404, error: 'request_not_found' };
  if (!isOpen(request)) {
    return { ok: false, statusCode: 409, error: 'already_decided', status: request.status };
  }

  const nowIso = new Date().toISOString();
  if (decision === 'decline') {
    const next = { ...request, status: 'declined', decidedAt: nowIso, decidedBy: actor, adminNote, outcome: 'declined' };
    if (!(await casWrite(store, id, next, read.etag))) {
      return { ok: false, statusCode: 409, error: 'concurrent_decision' };
    }
    return { ok: true, request: next };
  }

  // Claim the request first so two approvals cannot both act.
  const claimed = { ...request, status: 'approving', claimedAt: nowIso, claimedBy: actor };
  if (!(await casWrite(store, id, claimed, read.etag))) {
    return { ok: false, statusCode: 409, error: 'concurrent_decision' };
  }
  let reread;
  try {
    reread = await readWithEtag(store, id);
  } catch {
    // Claim stays until CLAIM_STALE_MS, then the request is open again.
    // Nothing is unassigned without a fresh strong read.
    return { ok: false, statusCode: 503, error: 'temporarily_unavailable' };
  }
  let etag = reread.etag;

  const finish = async (patch) => {
    const next = { ...claimed, ...patch };
    delete next.claimedAt;
    delete next.claimedBy;
    await casWrite(store, id, next, etag);
    return next;
  };

  let booking;
  try {
    booking = await loadBooking(request.bookingId);
  } catch {
    booking = null;
  }
  if (!booking) {
    const next = await finish({ status: 'pending' });
    return { ok: false, statusCode: 503, error: 'booking_unavailable', request: next };
  }

  if (!sameAssignment(booking, request)) {
    const next = await finish({
      status: 'stale', decidedAt: nowIso, decidedBy: actor, adminNote, outcome: 'assignment_changed',
    });
    return {
      ok: false,
      statusCode: 409,
      error: 'stale_request',
      message: 'This job is no longer assigned to that technician. Nothing was changed.',
      request: next,
    };
  }
  if (technicianTerminalState(booking).terminal) {
    const next = await finish({
      status: 'stale', decidedAt: nowIso, decidedBy: actor, adminNote, outcome: 'job_not_active',
    });
    return { ok: false, statusCode: 409, error: 'job_not_active', request: next };
  }

  let result;
  try {
    result = await unassign(booking, { by: 'admin' });
  } catch {
    result = { ok: false, statusCode: 500, error: 'unassign_failed' };
  }
  if (!result || !result.ok) {
    const next = await finish({ status: 'pending' });
    return {
      ok: false,
      statusCode: (result && result.statusCode) || 409,
      error: (result && result.error) || 'unassign_failed',
      request: next,
    };
  }
  const next = await finish({
    status: 'approved', decidedAt: nowIso, decidedBy: actor, adminNote, outcome: 'unassigned',
  });
  return {
    ok: true,
    request: next,
    bookingId: request.bookingId,
    jobStatus: result.booking && result.booking.jobStatus,
    assignment: result.assignment || null,
  };
}

module.exports = {
  WITHDRAWAL_STORE,
  MIN_REASON,
  setWithdrawalStoreOverride,
  createWithdrawalRequest,
  listWithdrawalRequests,
  decideWithdrawalRequest,
  projectWithdrawalForAdmin,
  projectWithdrawalForTech,
  sameAssignment,
};
