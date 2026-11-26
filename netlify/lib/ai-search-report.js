// AI SEARCH PERFORMANCE report for the Revenue Operations dashboard.
//
// Every number is a count of stored records; nothing is estimated or modelled.
// Attribution (utm_*, referrers) is reported by the visitor's browser. The
// report classifies it on the server but cannot verify it, so AI figures are
// "browser-reported attribution", never verified AI referral revenue.
//
// Reliability rules:
// - Storage is read strictly. A failed read or listing is never turned into 0:
//   the report becomes "partial" (numbers are lower bounds) or "unavailable".
// - "complete" requires: index coverage started before the range, every listing
//   and read succeeded, no list hit its cap, and no unhealed index-write failure.
// - Conversion rates are returned only for complete ranges.
//
// Booking rules:
// - Confirmed bookings and value come only from server confirmation events
//   (event_origin "server_confirm"). Browser amounts are never read. A booking
//   confirmed more than once counts once, at its latest confirmation.
// - The value is the amount approved at confirmation: not collected payment,
//   not completed-job revenue. Later cancellations are not netted out (same
//   rule as the existing Revenue Operations totals).
// - Each booking gets ONE classification from all booking_submitted events that
//   name it: ai (one assistant), paid_ai_assisted (a paid signal is present),
//   not_ai, no_record, or unverifiable (conflicting sessions or attribution, or
//   an event outside the booking's submission window). Unverifiable and paid
//   bookings are reported separately and never added to AI totals.

const { AI_ASSISTANTS, labelFor } = require('./ai-attribution');
const { INDEX_VERSION, PAGE_VIEW_EVENTS, normalizeBookingReference } = require('./ai-attribution-index');

const DAY_LIST_CAP = 2000;
const MAX_CONFIRMATIONS = 1000;
const MAX_BOOKING_ROWS = 20;
const LIST_CONCURRENCY = 8;
// A legitimate booking_submitted is sent by the browser right after the server
// creates the reference. Retries are allowed for a day; anything earlier than
// the reference or later than that cannot bind attribution to the booking.
const SUBMISSION_SKEW_MS = 5 * 60 * 1000;
const SUBMISSION_WINDOW_MS = 24 * 60 * 60 * 1000;

const LIMITATIONS = Object.freeze([
  'Attribution is reported by the visitor\'s browser and can be forged; it is not independently verified.',
  'Phone calls, typed URLs, copied links, Google AI Overviews and Copilot in Bing search cannot be identified.',
  'Sessions are browser-tab sessions, not people: a returning visitor counts again in a new tab or day.',
  'A visitor whose earlier visit came from an AI assistant stays "first acquired through AI" in later sessions.',
  'Bookings with any paid-campaign signal are shown as paid + AI-assisted and excluded from AI totals.',
  'A return visit through an AI assistant after a paid ad click is not recorded, to keep paid attribution intact.',
  'Approved booking value is the amount approved at confirmation, not collected payment; cancellations are not netted out.',
  'Index writes lost without a failure record (for example a function crash) cannot be detected.',
]);

function dayKeys(fromDay, toDay) {
  const out = [];
  const start = new Date(`${fromDay}T12:00:00Z`);
  const end = new Date(`${toDay}T12:00:00Z`);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Strict key listing: storage errors propagate; reports whether the cap was hit. */
async function strictListKeys(store, prefix, cap) {
  if (!store || typeof store.list !== 'function') throw new Error('store_list_unavailable');
  const keys = [];
  const take = (blobs) => {
    for (const blob of blobs || []) {
      const key = blob && (blob.key || blob.blobKey);
      if (key) keys.push(String(key));
      if (keys.length > cap) return true;
    }
    return false;
  };
  const listed = store.list({ prefix, paginate: true });
  if (listed && typeof listed[Symbol.asyncIterator] === 'function') {
    for await (const page of listed) {
      if (take(page && page.blobs)) return { keys: keys.slice(0, cap), truncated: true };
    }
    return { keys, truncated: false };
  }
  const result = await listed;
  if (!result || !Array.isArray(result.blobs)) throw new Error('store_list_invalid');
  const over = take(result.blobs);
  return { keys: keys.slice(0, cap), truncated: over };
}

function isServerConfirmation(rec) {
  return !!(rec && rec.event === 'booking_confirmed' && rec.properties && rec.properties.event_origin === 'server_confirm'
    && !(rec.qaFixture === true || rec.qaTag === 'QA-REVOPS'));
}

function inRange(iso, range) {
  const s = String(iso || '');
  return !!s && s >= range.from && s <= range.to;
}

/** Creation time encoded in CD1-<base36 ms>-XXXX references, or null. */
function referenceCreatedMs(ref) {
  const m = /^CD1-([0-9A-Z]{6,10})-[0-9A-Z]{2,8}$/.exec(ref);
  if (!m) return null;
  const ms = parseInt(m[1], 36);
  return ms > Date.UTC(2024, 0, 1) && ms < Date.UTC(2100, 0, 1) ? ms : null;
}

/** One classification for a booking from every booking_submitted row naming it. Pure. */
function classifyBooking(ref, rows, { listTruncated = false } = {}) {
  if (!rows.length) return { kind: 'no_record' };
  if (listTruncated) return { kind: 'unverifiable', reason: 'too_many_claims' };
  const created = referenceCreatedMs(ref);
  if (created == null) return { kind: 'unverifiable', reason: 'reference_unparseable' };
  for (const r of rows) {
    const at = Date.parse(r.receivedAt || '');
    if (!Number.isFinite(at) || at < created - SUBMISSION_SKEW_MS || at > created + SUBMISSION_WINDOW_MS) {
      return { kind: 'unverifiable', reason: 'outside_submission_window' };
    }
  }
  const sessions = new Set(rows.map((r) => r.sessionId || '\u0000none'));
  if (sessions.size > 1 || sessions.has('\u0000none')) return { kind: 'unverifiable', reason: 'conflicting_sessions' };
  const sigs = new Set(rows.map((r) => `${r.sourceKey || ''}|${r.paidSignal ? 1 : 0}`));
  if (sigs.size > 1) return { kind: 'unverifiable', reason: 'conflicting_attribution' };
  const r = rows[0];
  if (!r.sourceKey) return { kind: 'not_ai' };
  if (r.paidSignal) return { kind: 'paid_ai_assisted', sourceKey: r.sourceKey };
  return { kind: 'ai', sourceKey: r.sourceKey };
}

function ratio(num, den) {
  return den > 0 ? Math.round((num / den) * 10000) / 10000 : null;
}

function cents(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
}

/**
 * range: { from, to, fromDay, toDay } (revops-dashboard parseDateRange output).
 * deps: { getStore(name), getJson(store, key) — strict: throws on storage error,
 *         null when missing; listKeys?(store, prefix, cap) — strict, defaults
 *         to strictListKeys }.
 */
async function buildAiSearchReport(range, deps) {
  const listKeys = deps.listKeys || strictListKeys;
  const warnings = [];
  const unavailable = (reason) => ({
    ok: true, status: 'unavailable', reason, range: { from: range.from, to: range.to },
    totals: null, sources: null, excluded: null, confirmations: null, limitations: LIMITATIONS,
  });

  let aiStore; let eventStore; let coverage;
  try {
    aiStore = await deps.getStore('aiIndex');
    eventStore = await deps.getStore('events');
    coverage = await deps.getJson(aiStore, 'meta/coverage-start');
  } catch {
    return unavailable('storage_unavailable');
  }
  const coverageStart = coverage && typeof coverage.startedAt === 'string' ? coverage.startedAt : null;
  const days = dayKeys(range.fromDay, range.toDay);
  let truncated = false;

  const safeList = async (store, prefix, cap, label) => {
    try {
      const res = await listKeys(store, prefix, cap);
      if (res.truncated) { truncated = true; warnings.push(`${label}_truncated`); }
      return res.keys;
    } catch {
      warnings.push(`${label}_list_failed`);
      return [];
    }
  };
  const safeGet = async (store, key, label) => {
    try { return await deps.getJson(store, key); } catch { warnings.push(`${label}_read_failed`); return undefined; }
  };

  // ── Unhealed index-write failures ────────────────────────────────────────
  const failureKeys = (await mapLimit(days, LIST_CONCURRENCY,
    (day) => safeList(aiStore, `meta/write-failure/${day}/`, DAY_LIST_CAP, 'write_failure'))).flat();
  let unhealedWriteFailures = 0;
  await mapLimit(failureKeys, LIST_CONCURRENCY, async (k) => {
    const marker = await safeGet(aiStore, k, 'write_failure');
    if (!marker || !Array.isArray(marker.keys)) { if (marker !== undefined) unhealedWriteFailures += 1; return; }
    for (const key of marker.keys) {
      const row = await safeGet(aiStore, key, 'write_failure');
      if (row === null) { unhealedWriteFailures += 1; return; }
    }
  });
  if (unhealedWriteFailures) warnings.push('index_write_failures');

  // ── AI index rows in range ──────────────────────────────────────────────
  const indexKeys = (await mapLimit(days, LIST_CONCURRENCY,
    (day) => safeList(aiStore, `${day}/`, DAY_LIST_CAP, 'ai_index'))).flat();
  const rows = (await mapLimit(indexKeys, LIST_CONCURRENCY, (k) => safeGet(aiStore, k, 'ai_index')))
    .filter((r) => r && r.v === INDEX_VERSION && inRange(r.receivedAt, range));

  // Sessions: a session with any paid signal is paid + AI-assisted, never AI.
  const paidSessions = new Set();
  for (const r of rows) if (r.sessionId && r.paidSignal) paidSessions.add(r.sessionId);
  const latest = {}; const first = {};
  const allAi = new Set(); const allLatest = new Set(); const allFirst = new Set();
  let aiEventsWithoutSession = 0;
  const submittedRefs = new Set();
  let submissionsWithoutReference = 0;
  const addTo = (map, key, sid) => { (map[key] = map[key] || new Set()).add(sid); };
  for (const r of rows) {
    if (r.event === 'booking_submitted') {
      const ref = normalizeBookingReference(r.bookingReference);
      if (ref) submittedRefs.add(ref); else submissionsWithoutReference += 1;
      continue;
    }
    if (!PAGE_VIEW_EVENTS.includes(r.event)) continue;
    if (!r.sessionId) { aiEventsWithoutSession += 1; continue; }
    if (paidSessions.has(r.sessionId)) continue;
    if (r.lastTouch && r.lastTouch.key) { addTo(latest, r.lastTouch.key, r.sessionId); allLatest.add(r.sessionId); allAi.add(r.sessionId); }
    if (r.firstTouch && r.firstTouch.key) { addTo(first, r.firstTouch.key, r.sessionId); allFirst.add(r.sessionId); allAi.add(r.sessionId); }
  }

  // ── Server confirmations in range ───────────────────────────────────────
  let confirmKeys = (await mapLimit(days, LIST_CONCURRENCY,
    (day) => safeList(eventStore, `${day}/confirmed:`, DAY_LIST_CAP, 'confirmations'))).flat();
  if (confirmKeys.length > MAX_CONFIRMATIONS) {
    truncated = true; warnings.push('confirmations_truncated'); confirmKeys = confirmKeys.slice(0, MAX_CONFIRMATIONS);
  }
  const confirmations = (await mapLimit(confirmKeys, LIST_CONCURRENCY, (k) => safeGet(eventStore, k, 'confirmations')))
    .filter((rec) => isServerConfirmation(rec) && inRange(rec.properties.timestamp || rec.receivedAt, range));
  const latestByRef = new Map();
  for (const rec of confirmations) {
    const ref = normalizeBookingReference(rec.properties.booking_reference);
    if (!ref) continue;
    const at = String(rec.properties.timestamp || rec.receivedAt || '');
    const prev = latestByRef.get(ref);
    if (!prev || at > prev.at) latestByRef.set(ref, { at, rec });
  }

  // ── One classification per booking (submitted or confirmed in range) ───
  const refs = [...new Set([...submittedRefs, ...latestByRef.keys()])];
  const classification = new Map();
  await mapLimit(refs, LIST_CONCURRENCY, async (ref) => {
    let listed;
    try { listed = await listKeys(aiStore, `booking/${ref}/`, MAX_BOOKING_ROWS); } catch {
      warnings.push('booking_rows_list_failed'); classification.set(ref, { kind: 'unavailable' }); return;
    }
    const bookingRows = [];
    for (const k of listed.keys) {
      const row = await safeGet(aiStore, k, 'booking_rows');
      if (row === undefined) { classification.set(ref, { kind: 'unavailable' }); return; }
      if (row && row.v === INDEX_VERSION) bookingRows.push(row);
    }
    classification.set(ref, classifyBooking(ref, bookingRows, { listTruncated: listed.truncated }));
  });

  const per = {};
  const src = (key) => (per[key] = per[key] || { submissions: 0, confirmed: 0, cents: 0, missing: 0 });
  const excluded = {
    paidAssistedSessions: paidSessions.size,
    paidAssistedSubmissions: 0,
    paidAssistedConfirmed: 0,
    paidAssistedApprovedValue: 0,
    unverifiableSubmissions: 0,
    unverifiableConfirmed: 0,
    aiEventsWithoutSession,
    submissionsWithoutReference,
  };
  let paidCents = 0;
  for (const ref of submittedRefs) {
    const c = classification.get(ref) || { kind: 'unavailable' };
    if (c.kind === 'ai') src(c.sourceKey).submissions += 1;
    else if (c.kind === 'paid_ai_assisted') excluded.paidAssistedSubmissions += 1;
    else if (c.kind === 'unverifiable' || c.kind === 'no_record') excluded.unverifiableSubmissions += 1;
  }
  const confirmationSummary = { allServerConfirmedInRange: latestByRef.size, withoutAttributionRecord: 0, notAi: 0, unavailable: 0 };
  for (const [ref, { rec }] of latestByRef) {
    const c = classification.get(ref) || { kind: 'unavailable' };
    const value = cents(rec.properties.estimated_value);
    if (c.kind === 'ai') {
      const s = src(c.sourceKey);
      s.confirmed += 1;
      if (value == null) s.missing += 1; else s.cents += value;
    } else if (c.kind === 'paid_ai_assisted') {
      excluded.paidAssistedConfirmed += 1;
      if (value != null) paidCents += value;
    } else if (c.kind === 'unverifiable') excluded.unverifiableConfirmed += 1;
    else if (c.kind === 'no_record') confirmationSummary.withoutAttributionRecord += 1;
    else if (c.kind === 'not_ai') confirmationSummary.notAi += 1;
    else confirmationSummary.unavailable += 1;
  }
  excluded.paidAssistedApprovedValue = paidCents / 100;
  if (confirmationSummary.unavailable) warnings.push('booking_classification_unavailable');

  // ── Assemble ────────────────────────────────────────────────────────────
  const sources = AI_ASSISTANTS.map((a) => {
    const s = per[a.key] || { submissions: 0, confirmed: 0, cents: 0, missing: 0 };
    return {
      key: a.key,
      label: labelFor(a.key) || a.label,
      latestReferralSessions: latest[a.key] ? latest[a.key].size : 0,
      firstAcquiredSessions: first[a.key] ? first[a.key].size : 0,
      bookingSubmissions: s.submissions,
      confirmedBookings: s.confirmed,
      approvedValue: s.cents / 100,
      confirmedMissingAmount: s.missing,
    };
  });
  const sum = (k) => sources.reduce((n, s) => n + s[k], 0);
  const approvedCents = Object.values(per).reduce((n, s) => n + s.cents, 0);
  const confirmedBookings = sum('confirmedBookings');
  const confirmedMissingAmount = sum('confirmedMissingAmount');
  const priced = confirmedBookings - confirmedMissingAmount;

  const uniqueWarnings = [...new Set(warnings)];
  const coverageCovers = !!(coverageStart && coverageStart <= range.from);
  let status;
  if (!coverageStart && !rows.length && !refs.length && !uniqueWarnings.length) status = 'not_started';
  else status = coverageCovers && !truncated && uniqueWarnings.length === 0 ? 'complete' : 'partial';
  const complete = status === 'complete';

  return {
    ok: true,
    status,
    complete,
    // Partial numbers are lower bounds: at least this many were recorded.
    lowerBound: status === 'partial',
    range: { from: range.from, to: range.to },
    coverageStart,
    truncated,
    warnings: uniqueWarnings,
    totals: {
      aiSessions: allAi.size,
      latestReferralSessions: allLatest.size,
      firstAcquiredSessions: allFirst.size,
      bookingSubmissions: sum('bookingSubmissions'),
      confirmedBookings,
      approvedValue: approvedCents / 100,
      confirmedMissingAmount,
      averageApprovedValue: priced > 0 ? Math.round(approvedCents / priced) / 100 : null,
      submissionRate: complete ? ratio(sum('bookingSubmissions'), allAi.size) : null,
      confirmationRate: complete ? ratio(confirmedBookings, allAi.size) : null,
    },
    sources,
    excluded,
    confirmations: confirmationSummary,
    basis: {
      aiSessions: 'Distinct browser-tab sessions with an AI-attributed page view (first or latest referral) and no paid signal.',
      latestReferralSessions: 'Sessions whose latest identifiable referral or campaign was an AI assistant.',
      firstAcquiredSessions: 'Sessions from visitors whose first recorded visit came from an AI assistant.',
      bookingSubmissions: 'Distinct booking references whose submission attribution is consistent, AI, and has no paid signal.',
      confirmedBookings: 'Server confirmations (event_origin server_confirm), one per booking, for those AI bookings.',
      approvedValue: 'Approved booking value at confirmation. Not collected payment. Browser amounts are never used.',
    },
    limitations: LIMITATIONS,
  };
}

module.exports = {
  buildAiSearchReport,
  classifyBooking,
  referenceCreatedMs,
  strictListKeys,
  LIMITATIONS,
  MAX_CONFIRMATIONS,
  DAY_LIST_CAP,
};
