// Write-time index for the AI SEARCH PERFORMANCE report, so the report reads a
// handful of rows instead of scanning every stored event (the general dashboard
// reads at most 500 events, about a week of production traffic).
//
// Store: revenue-ai-index. Every write is create-only, so retries, refreshes and
// duplicate posts can never add a second row. Rows hold only attribution fields
// the event already carried: no names, phones, emails, addresses or click IDs.
//   <YYYY-MM-DD>/<eventId>            AI-attributed page view, booking start or submission
//   booking/<CD1-REF>/<eventId>       EVERY booking_submitted naming that booking,
//                                     AI or not, so the report can see conflicting claims
//   meta/coverage-start               first time the index was written
//   meta/write-failure/<day>/<id>     an index write that failed (best effort)
//
// Attribution fields are reported by the browser. The index records them as
// received; it does not verify them. Events stored before this index existed
// are not backfilled; the report states the coverage start instead.

const { classifyEventAttribution } = require('./ai-attribution');

const INDEX_VERSION = 2;
const INDEXED_EVENTS = Object.freeze([
  'page_view', 'service_page_view', 'city_page_view', 'hub_page_view',
  'booking_started', 'booking_submitted',
]);
const PAGE_VIEW_EVENTS = Object.freeze(['page_view', 'service_page_view', 'city_page_view', 'hub_page_view']);
const BOOKING_REF_RE = /^CD1-[A-Za-z0-9-]{4,64}$/;
// sessionStorage unavailable: every such browser shares this id, so it never
// identifies a session.
const UNRELIABLE_SESSION_IDS = Object.freeze(['sess_fallback']);

function normalizeBookingReference(value) {
  const ref = String(value || '').trim().toUpperCase();
  return BOOKING_REF_RE.test(ref) ? ref : '';
}

function reliableSessionId(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().slice(0, 128);
  if (!s || UNRELIABLE_SESSION_IDS.includes(s)) return null;
  return s;
}

function touchSummary(touch) {
  return touch ? { key: touch.key, matchedBy: touch.matchedBy, value: touch.value } : null;
}

function dayOf(storeKey) {
  const day = String(storeKey || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/**
 * The index rows for a stored event record. Pure.
 * Returns { day, eventId, rows: [{ key, value }] } or null when nothing is indexed.
 */
function buildIndexRows(record, eventId, storeKey) {
  if (!record || !INDEXED_EVENTS.includes(record.event)) return null;
  const day = dayOf(storeKey);
  if (!day) return null;
  const p = record.properties && typeof record.properties === 'object' ? record.properties : {};
  const a = classifyEventAttribution(p);
  const id = String(eventId).slice(0, 128);
  const base = {
    v: INDEX_VERSION,
    event: record.event,
    eventId: id,
    day,
    receivedAt: record.receivedAt || null,
    sessionId: reliableSessionId(p.anonymous_session_id),
    sourceKey: a.sourceKey,
    firstTouch: touchSummary(a.firstTouch),
    lastTouch: touchSummary(a.lastTouch),
    paidSignal: a.paidSignal,
  };
  const rows = [];
  const ref = record.event === 'booking_submitted' ? normalizeBookingReference(p.booking_reference) : '';
  if (a.isAi) rows.push({ key: `${day}/${id}`, value: { ...base, bookingReference: ref || null } });
  if (ref) rows.push({ key: `booking/${ref}/${id}`, value: { ...base, bookingReference: ref } });
  return rows.length ? { day, eventId: id, rows } : null;
}

/**
 * Best effort: never throws, never changes the ingestion response.
 * A failed write leaves a meta/write-failure marker (if that write works) so
 * the report can mark the day partial instead of showing a silent undercount.
 * deps: { getStore(name), create(store, key, value) } — injectable for tests.
 */
async function indexAiEvent(record, eventId, storeKey, deps) {
  let built;
  try {
    built = buildIndexRows(record, eventId, storeKey);
  } catch {
    return { indexed: false, reason: 'classify_failed' };
  }
  if (!built) return { indexed: false };
  let store;
  try {
    store = await deps.getStore('aiIndex');
  } catch (err) {
    console.warn('[ai-index] store_unavailable', String(err && err.message || err).slice(0, 120));
    return { indexed: false, reason: 'write_failed' };
  }
  const failedKeys = [];
  let wroteAny = false;
  for (const row of built.rows) {
    try {
      await deps.create(store, row.key, row.value);
      wroteAny = true;
    } catch (err) {
      failedKeys.push(row.key);
      console.warn('[ai-index] write_failed', String(err && err.message || err).slice(0, 120));
    }
  }
  if (wroteAny) {
    try {
      await deps.create(store, 'meta/coverage-start', { startedAt: record.receivedAt || new Date().toISOString() });
    } catch { /* a later event sets it; a later start only shortens the claimed coverage */ }
  }
  if (failedKeys.length) {
    try {
      await deps.create(store, `meta/write-failure/${built.day}/${built.eventId}`, {
        keys: failedKeys, at: new Date().toISOString(),
      });
    } catch { /* undetectable; documented limitation */ }
    return { indexed: false, reason: 'write_failed', failedKeys };
  }
  return { indexed: true };
}

module.exports = {
  INDEX_VERSION,
  INDEXED_EVENTS,
  PAGE_VIEW_EVENTS,
  normalizeBookingReference,
  reliableSessionId,
  buildIndexRows,
  indexAiEvent,
};
