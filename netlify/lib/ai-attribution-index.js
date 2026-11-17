// Write-time index of AI-attributed events, so the AI report reads a handful of
// rows instead of scanning every stored event (the general dashboard reads at
// most 500 events, about a week of production traffic).
//
// Store: revenue-ai-index. Every write is create-only, so retries, refreshes and
// duplicate posts can never add a second row. Rows hold only attribution fields
// the event already carried: no names, phones, emails, addresses or click IDs.
//   <YYYY-MM-DD>/<eventId>   one row per indexed event
//   booking/<CD1-REF>        first AI-attributed booking_submitted for a booking
//   meta/coverage-start      first time the index was written (coverage start)
//
// Events stored before this index existed are not backfilled. The report states
// the coverage start instead of presenting older periods as complete.

const { classifyEventAttribution } = require('./ai-attribution');

const INDEXED_EVENTS = Object.freeze([
  'page_view', 'service_page_view', 'city_page_view', 'hub_page_view',
  'booking_started', 'booking_submitted',
]);
const PAGE_VIEW_EVENTS = Object.freeze(['page_view', 'service_page_view', 'city_page_view', 'hub_page_view']);
const BOOKING_REF_RE = /^CD1-[A-Za-z0-9-]{4,64}$/;

function normalizeBookingReference(value) {
  const ref = String(value || '').trim().toUpperCase();
  return BOOKING_REF_RE.test(ref) ? ref : '';
}

function touchSummary(touch) {
  return touch ? { key: touch.key, matchedBy: touch.matchedBy, value: touch.value } : null;
}

/** The index row for a stored event record, or null if it is not indexed. Pure. */
function buildIndexEntry(record, eventId, storeKey) {
  if (!record || !INDEXED_EVENTS.includes(record.event)) return null;
  const p = record.properties && typeof record.properties === 'object' ? record.properties : {};
  const attribution = classifyEventAttribution(p);
  if (!attribution.isAi) return null;
  const day = String(storeKey || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const sessionId = typeof p.anonymous_session_id === 'string' ? p.anonymous_session_id.slice(0, 128) : null;
  return {
    v: 1,
    event: record.event,
    eventId: String(eventId).slice(0, 128),
    day,
    receivedAt: record.receivedAt || null,
    sessionId,
    sourceKey: attribution.sourceKey,
    firstTouch: touchSummary(attribution.firstTouch),
    lastTouch: touchSummary(attribution.lastTouch),
    bookingReference: record.event === 'booking_submitted' ? (normalizeBookingReference(p.booking_reference) || null) : null,
  };
}

/**
 * Best effort: never throws, never changes the ingestion response.
 * deps: { getStore(name), create(store, key, value) } — injectable for tests.
 */
async function indexAiEvent(record, eventId, storeKey, deps) {
  let entry;
  try {
    entry = buildIndexEntry(record, eventId, storeKey);
  } catch {
    return { indexed: false, reason: 'classify_failed' };
  }
  if (!entry) return { indexed: false };
  try {
    const store = await deps.getStore('aiIndex');
    const row = await deps.create(store, `${entry.day}/${entry.eventId}`, entry);
    if (entry.bookingReference) {
      await deps.create(store, `booking/${entry.bookingReference}`, entry);
    }
    await deps.create(store, 'meta/coverage-start', { startedAt: entry.receivedAt || new Date().toISOString() });
    return { indexed: true, created: !!(row && row.created) };
  } catch (err) {
    console.warn('[ai-index] write_failed', String(err && err.message || err).slice(0, 120));
    return { indexed: false, reason: 'write_failed' };
  }
}

module.exports = {
  INDEXED_EVENTS,
  PAGE_VIEW_EVENTS,
  normalizeBookingReference,
  buildIndexEntry,
  indexAiEvent,
};
