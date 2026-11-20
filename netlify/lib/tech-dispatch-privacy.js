'use strict';

/**
 * QuickOps Daily Dispatch — server-side technician privacy gate.
 *
 * One predicate decides whether a technician session may receive customer
 * PII (name, phone, address, notes, access details) or job photo URLs for a
 * booking. Every technician read path calls it; the browser never decides.
 *
 * Access requires ALL of:
 *   1. The booking is assigned to this technician by id. A legacy name-only
 *      assignment counts only when exactly one technician account has that
 *      name (duplicate names fail closed).
 *   2. The booking is not terminal in ANY status field (legacy `status`,
 *      `jobStatus`, `serviceStatus`, `appointmentStatus`). A stale field never
 *      re-opens access.
 *   3. The scheduled arrival start resolves unambiguously in America/New_York
 *      and `now` is at or after (start − 12 hours). Missing, invalid or
 *      inconsistent scheduling information fails closed.
 *
 * This gate only controls what is delivered from now on. JSON or photo URLs
 * already delivered to a device are not retroactively revoked.
 */

const TIME_ZONE = 'America/New_York';
const PII_LEAD_MS = 12 * 60 * 60 * 1000;
const WITHDRAWAL_NOTICE_MS = 12 * 60 * 60 * 1000;
// Operational arrivals happen in daytime. Anything outside this range is
// treated as invalid rather than guessed, which also keeps every accepted
// value clear of the 1–3 AM DST transition hours.
const MIN_ARRIVAL_MINUTES = 6 * 60;
const MAX_ARRIVAL_MINUTES = 21 * 60;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TECH_ID_RE = /^tech-[0-9a-f]{6,}$/i;

// ---------------------------------------------------------------------------
// Time zone math (no library; Intl ships with Node)
// ---------------------------------------------------------------------------

let _fmt = null;
function easternFormatter() {
  if (!_fmt) {
    _fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: TIME_ZONE,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }
  return _fmt;
}

/** Wall-clock parts of a UTC instant in America/New_York. */
function easternParts(utcMs) {
  const out = {};
  for (const p of easternFormatter().formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  if (out.hour === 24) out.hour = 0;
  return out;
}

function easternOffsetMinutes(utcMs) {
  const p = easternParts(utcMs);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

/** YYYY-MM-DD of a UTC instant in America/New_York. */
function easternDateIso(utcMs) {
  const p = easternParts(utcMs);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function parseIsoDate(raw) {
  const m = ISO_DATE_RE.exec(String(raw || '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return { y, mo, d, iso: m[0] };
}

/**
 * UTC instant for an America/New_York wall-clock time.
 * Returns null when that wall time does not exist (spring-forward gap).
 */
function easternWallToUtcMs(dateIso, minutes) {
  const date = parseIsoDate(dateIso);
  if (!date || !Number.isInteger(minutes) || minutes < 0 || minutes >= 24 * 60) return null;
  const naive = Date.UTC(date.y, date.mo - 1, date.d, Math.floor(minutes / 60), minutes % 60);
  let t = naive - easternOffsetMinutes(naive) * 60000;
  const second = naive - easternOffsetMinutes(t) * 60000;
  if (second !== t) t = second;
  const back = easternParts(t);
  if (back.year !== date.y || back.month !== date.mo || back.day !== date.d
    || back.hour * 60 + back.minute !== minutes) {
    return null;
  }
  return t;
}

// ---------------------------------------------------------------------------
// Arrival start resolution
// ---------------------------------------------------------------------------

function parseClock(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return null;
  let m = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?$/.exec(s);
  if (m) {
    const h = Number(m[1]);
    const min = m[2] == null ? 0 : Number(m[2]);
    if (h < 1 || h > 12 || min > 59) return null;
    const h24 = (h % 12) + (m[3] === 'p' ? 12 : 0);
    return h24 * 60 + min;
  }
  m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }
  return null;
}

/**
 * Parse an arrival window or slot string.
 *   "8:00 AM"              → { start: 480, end: 480 }
 *   "08:00-11:00"          → { start: 480, end: 660 }
 *   "8:00 AM – 11:00 AM"   → { start: 480, end: 660 }
 *   "anytime"              → { anytime: true }
 *   "Morning", "", garbage → null / invalid
 */
function parseArrivalText(raw) {
  const s = String(raw || '').trim();
  if (!s) return { empty: true };
  const lower = s.toLowerCase();
  if (lower === 'anytime' || lower === 'any time' || lower === 'any time that day') return { anytime: true };
  const parts = s.split(/\s*(?:–|—|-|\bto\b)\s*/i).filter(Boolean);
  if (parts.length === 1) {
    const t = parseClock(parts[0]);
    return t == null ? { invalid: true } : { start: t, end: t };
  }
  if (parts.length === 2) {
    const b = parseClock(parts[1]);
    let a = parseClock(parts[0]);
    // Admin reschedule accepts "2:00-4:00 PM" (meridiem only on the end) and
    // books the start in that same half of the day. Mirror that reading
    // instead of treating "2:00" as 2 AM.
    const endMeridiem = /([ap])\.?\s*m\.?$/i.exec(parts[1]);
    const startHasMeridiem = /[ap]\.?\s*m\.?$/i.test(parts[0]);
    if (endMeridiem && !startHasMeridiem && /^\d{1,2}(?::\d{2})?$/.test(parts[0].trim())) {
      a = parseClock(`${parts[0].trim()} ${endMeridiem[1]}m`);
    }
    if (a == null || b == null || b < a) return { invalid: true };
    return { start: a, end: b };
  }
  return { invalid: true };
}

function text(v) {
  return String(v == null ? '' : v).trim();
}

/**
 * Resolve the scheduled arrival-window start for a booking.
 * @returns {{ ok: true, date: string, startMinutes: number, startMs: number, unlockMs: number }
 *   | { ok: false, reason: string }}
 */
function resolveArrivalStart(booking) {
  if (!booking || typeof booking !== 'object') return { ok: false, reason: 'missing_booking' };

  const confirmedDateRaw = text(booking.confirmedDate);
  const preferredDateRaw = text(booking.preferredDate);
  if (!confirmedDateRaw && !preferredDateRaw) return { ok: false, reason: 'missing_date' };
  const cd = confirmedDateRaw ? parseIsoDate(confirmedDateRaw) : null;
  const pd = preferredDateRaw ? parseIsoDate(preferredDateRaw) : null;
  if ((confirmedDateRaw && !cd) || (preferredDateRaw && !pd)) return { ok: false, reason: 'invalid_date' };
  if (cd && pd && cd.iso !== pd.iso) return { ok: false, reason: 'inconsistent_date' };
  const date = (cd || pd).iso;

  const confirmedWindow = text(booking.confirmedTimeWindow || booking.confirmedWindow);
  const confirmedSlot = text(booking.confirmedTime);
  const useConfirmed = !!(confirmedWindow || confirmedSlot);
  const windowRaw = useConfirmed ? confirmedWindow : text(booking.preferredArrivalWindow);
  const slotRaw = useConfirmed ? confirmedSlot : text(booking.preferredTime);

  const w = parseArrivalText(windowRaw);
  const s = parseArrivalText(slotRaw);
  if (w.invalid || s.invalid) return { ok: false, reason: 'invalid_time' };
  if (s.anytime) return { ok: false, reason: 'invalid_time' };

  let start = null;
  if (!w.empty && !w.anytime && !s.empty) {
    // A slot outside its own arrival window means the record disagrees with itself.
    if (s.start < w.start || s.start > w.end) return { ok: false, reason: 'inconsistent_time' };
    start = w.start;
  } else if (!w.empty && !w.anytime) {
    start = w.start;
  } else if (!s.empty) {
    start = s.start;
  } else {
    return { ok: false, reason: 'missing_time' };
  }

  if (start < MIN_ARRIVAL_MINUTES || start > MAX_ARRIVAL_MINUTES) return { ok: false, reason: 'invalid_time' };
  const startMs = easternWallToUtcMs(date, start);
  if (startMs == null) return { ok: false, reason: 'invalid_time' };
  return { ok: true, date, startMinutes: start, startMs, unlockMs: startMs - PII_LEAD_MS };
}

/** Service date used by the day board (date only; never unlocks PII). */
function bookingServiceDate(booking) {
  const cd = parseIsoDate(text(booking && booking.confirmedDate));
  if (cd) return cd.iso;
  const pd = parseIsoDate(text(booking && booking.preferredDate));
  return pd ? pd.iso : '';
}

// ---------------------------------------------------------------------------
// Terminal state across every status field
// ---------------------------------------------------------------------------

const CANCEL_TOKENS = new Set(['cancelled', 'canceled', 'no-show', 'no_show', 'archived_test']);
const COMPLETE_JOB = new Set([
  'completed', 'completed_pending_admin_review', 'completed_pending_payment', 'completed_paid', 'closed',
]);
const COMPLETE_SERVICE = new Set(['service_completed', 'awaiting_customer_action', 'closed']);
const COMPLETE_LEGACY = new Set(['completed', 'completed_paid', 'closed', 'paid', 'complete']);

function low(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

/**
 * Terminal for technician access. Any cancellation signal wins. Completion
 * signals win unless the job was explicitly reopened after completion (the
 * reopen writer moves jobStatus/serviceStatus to `reopened` but leaves the
 * legacy `status` label and completedAt in place).
 * @returns {{ terminal: boolean, reason: string }}
 */
function technicianTerminalState(booking) {
  if (!booking || typeof booking !== 'object') return { terminal: true, reason: 'missing_booking' };
  if (booking.isDraft === true || booking.isTest === true || booking.archived === true) {
    return { terminal: true, reason: 'archived' };
  }
  const status = low(booking.status);
  const job = low(booking.jobStatus);
  const service = low(booking.serviceStatus);
  const appt = low(booking.appointmentStatus);

  for (const v of [status, job, service, appt]) {
    if (CANCEL_TOKENS.has(v)) return { terminal: true, reason: 'cancelled' };
  }

  const reopened = (job === 'reopened' || service === 'reopened') && !!booking.reopenedAt;
  const completed = COMPLETE_JOB.has(job)
    || COMPLETE_SERVICE.has(service)
    || COMPLETE_LEGACY.has(status)
    || appt === 'completed'
    || booking.completionSubmitted === true
    || !!(booking.completedAt || booking.jobCompletedAt || booking.techCompletedAt);
  if (completed) {
    // A reopen is only honoured if the active job/service field says so and
    // neither of those two fields reports a completion again.
    const activeFieldsComplete = COMPLETE_JOB.has(job) || COMPLETE_SERVICE.has(service)
      || booking.completionSubmitted === true;
    if (!(reopened && !activeFieldsComplete)) return { terminal: true, reason: 'completed' };
  }
  return { terminal: false, reason: '' };
}

// ---------------------------------------------------------------------------
// Assignment (id-first; legacy names only when unambiguous)
// ---------------------------------------------------------------------------

function normName(v) {
  return low(v).replace(/\s+/g, ' ');
}

function sessionTechId(session) {
  return text(session && (session.techId || (session.tech && (session.tech.techId || session.tech.id))));
}

function sessionTechName(session) {
  return text(session && ((session.tech && (session.tech.fullName || session.tech.name)) || session.techName));
}

function looksLikeTechId(v, rosterIds) {
  const s = text(v);
  if (!s) return false;
  if (TECH_ID_RE.test(s)) return true;
  return !!(rosterIds && rosterIds.has(s.toLowerCase()));
}

/**
 * Lazily loaded technician roster for legacy name checks. Only bookings
 * without an id-shaped assignment trigger the load, at most once per request.
 */
function createRosterLoader(loadRecords) {
  let cached = null;
  return async function loadRoster() {
    if (cached) return cached;
    let rows = null;
    try {
      rows = await loadRecords();
    } catch {
      rows = null;
    }
    if (!Array.isArray(rows)) {
      cached = { ok: false, ids: new Set(), nameCounts: new Map() };
      return cached;
    }
    const ids = new Set();
    const nameCounts = new Map();
    for (const t of rows) {
      if (!t || typeof t !== 'object') continue;
      const id = text(t.techId || t.id).toLowerCase();
      if (id) ids.add(id);
      const n = normName(t.fullName || t.name);
      if (n) nameCounts.set(n, (nameCounts.get(n) || 0) + 1);
    }
    cached = { ok: true, ids, nameCounts };
    return cached;
  };
}

async function defaultRosterRecords() {
  const { blobsStore, listAllBlobs, fetchBlobRecords } = require('./tech-security');
  const store = await blobsStore('cd1-tech-accounts');
  const blobs = await listAllBlobs(store, 'cd1-tech-accounts');
  const techBlobs = blobs.filter((b) => String(b.key || '').startsWith('tech-'));
  return fetchBlobRecords(store, techBlobs, 15);
}

/**
 * @returns {Promise<{ assigned: boolean, via: 'id'|'legacy_name'|'', reason: string }>}
 */
async function resolveTechAssignment(booking, session, { loadRoster } = {}) {
  if (!booking || typeof booking !== 'object') return { assigned: false, via: '', reason: 'missing_booking' };
  const myId = sessionTechId(session).toLowerCase();
  if (!myId) return { assigned: false, via: '', reason: 'no_session' };
  if (low(booking.assignmentKind) === 'freelance') return { assigned: false, via: '', reason: 'freelance_assignment' };

  const idField = text(booking.assignedTechId);
  const legacyField = text(booking.assignedTech);
  const nameField = text(booking.assignedTechName);

  // Fast path: the id the assignment writer stores.
  if (idField && idField.toLowerCase() === myId) return { assigned: true, via: 'id', reason: '' };
  if (!idField && legacyField && legacyField.toLowerCase() === myId) return { assigned: true, via: 'id', reason: '' };
  if (TECH_ID_RE.test(idField) || (!idField && TECH_ID_RE.test(legacyField))) {
    return { assigned: false, via: '', reason: 'assigned_to_other_id' };
  }
  if (!idField && !legacyField && !nameField) return { assigned: false, via: '', reason: 'unassigned' };

  const roster = await (loadRoster || createRosterLoader(defaultRosterRecords))();
  if (!roster.ok) return { assigned: false, via: '', reason: 'roster_unavailable' };
  if (looksLikeTechId(idField, roster.ids) || (!idField && looksLikeTechId(legacyField, roster.ids))) {
    return { assigned: false, via: '', reason: 'assigned_to_other_id' };
  }

  const myName = normName(sessionTechName(session));
  if (!myName) return { assigned: false, via: '', reason: 'no_session_name' };
  const candidates = [idField, legacyField, nameField].map(normName).filter(Boolean);
  if (!candidates.length || !candidates.every((c) => c === myName)) {
    return { assigned: false, via: '', reason: 'name_mismatch' };
  }
  if ((roster.nameCounts.get(myName) || 0) !== 1) {
    return { assigned: false, via: '', reason: 'ambiguous_name' };
  }
  return { assigned: true, via: 'legacy_name', reason: '' };
}

// ---------------------------------------------------------------------------
// Combined decision + projection redaction
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{ assigned: boolean, piiAllowed: boolean, reason: string,
 *   unlocksAt: string, terminal: boolean, schedule: object }>}
 */
async function technicianAccess(booking, session, { nowMs = Date.now(), loadRoster } = {}) {
  const assignment = await resolveTechAssignment(booking, session, { loadRoster });
  const term = technicianTerminalState(booking);
  const schedule = resolveArrivalStart(booking);
  const base = {
    assigned: assignment.assigned,
    terminal: term.terminal,
    schedule,
    unlocksAt: schedule.ok ? new Date(schedule.unlockMs).toISOString() : '',
  };
  if (!assignment.assigned) return { ...base, piiAllowed: false, reason: assignment.reason || 'not_assigned' };
  if (term.terminal) return { ...base, piiAllowed: false, reason: term.reason };
  if (!schedule.ok) return { ...base, piiAllowed: false, reason: schedule.reason };
  if (nowMs < schedule.unlockMs) return { ...base, piiAllowed: false, reason: 'before_unlock_window' };
  return { ...base, piiAllowed: true, reason: '' };
}

const PII_BLANK_FIELDS = Object.freeze([
  'phone', 'email', 'address', 'zipCode', 'customerNote', 'notes', 'adminNotes',
  'accessNotes', 'serviceLocation', 'techNotes',
]);

/**
 * Apply the access decision to a projectJobForTech row. Package, vehicle,
 * date, window and status stay so the day board still works.
 */
function redactTechJob(job, access) {
  const out = { ...job };
  if (access && access.piiAllowed) {
    out.piiLocked = false;
    out.piiLockReason = '';
    out.piiUnlocksAt = access.unlocksAt || '';
    return out;
  }
  for (const k of PII_BLANK_FIELDS) if (k in out) out[k] = '';
  out.customerName = 'Customer';
  out.photosBefore = [];
  out.photosAfter = [];
  // equipmentHints stay: they are generic kit reminders (water/power/ladder),
  // never gate codes or addresses. Any site-access field is blanked.
  for (const k of Object.keys(out)) {
    if (/^(siteAccess|gate|building|parking|unit|apartment)/i.test(k)) out[k] = '';
  }
  out.piiLocked = true;
  out.piiLockReason = (access && access.reason) || 'locked';
  out.piiUnlocksAt = (access && access.unlocksAt) || '';
  return out;
}

/**
 * PII decision for the signed SMS job link (tech-quick-ops). Assignment there
 * is proven by the link session (booking id + assignee phone + current token
 * hash), so only the terminal-state and time/schedule checks apply here.
 * @returns {{ allowed: boolean, reason: string, unlocksAt: string, message: string }}
 */
function quickOpsPiiDecision(booking, nowMs = Date.now()) {
  const term = technicianTerminalState(booking);
  if (term.terminal) {
    return { allowed: false, reason: term.reason, unlocksAt: '', message: 'This job is closed. Customer details are no longer shown.' };
  }
  const schedule = resolveArrivalStart(booking);
  if (!schedule.ok) {
    return {
      allowed: false,
      reason: schedule.reason,
      unlocksAt: '',
      message: 'Customer details stay hidden until the office confirms the arrival time.',
    };
  }
  const unlocksAt = new Date(schedule.unlockMs).toISOString();
  if (nowMs < schedule.unlockMs) {
    const label = new Date(schedule.unlockMs).toLocaleString('en-US', {
      timeZone: TIME_ZONE, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
    return {
      allowed: false,
      reason: 'before_unlock_window',
      unlocksAt,
      message: `Customer name, address and notes appear ${label} ET (12 hours before the arrival window).`,
    };
  }
  return { allowed: true, reason: '', unlocksAt, message: '' };
}

/** Withdrawal notice: arrival start must resolve and be ≥ 12h away. */
function withdrawalNoticeCheck(booking, nowMs = Date.now()) {
  const schedule = resolveArrivalStart(booking);
  if (!schedule.ok) return { ok: false, error: 'schedule_unresolved', reason: schedule.reason };
  if (schedule.startMs - nowMs < WITHDRAWAL_NOTICE_MS) {
    return { ok: false, error: 'insufficient_notice', startsAt: new Date(schedule.startMs).toISOString() };
  }
  return { ok: true, schedule };
}

module.exports = {
  TIME_ZONE,
  PII_LEAD_MS,
  WITHDRAWAL_NOTICE_MS,
  PII_BLANK_FIELDS,
  easternWallToUtcMs,
  easternDateIso,
  parseArrivalText,
  resolveArrivalStart,
  bookingServiceDate,
  technicianTerminalState,
  createRosterLoader,
  resolveTechAssignment,
  technicianAccess,
  redactTechJob,
  quickOpsPiiDecision,
  withdrawalNoticeCheck,
};
