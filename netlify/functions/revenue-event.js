// POST /.netlify/functions/revenue-event — first-party analytics ingestion.

const crypto = require('crypto');
const { enforcePublicRateLimit } = require('../lib/public-rate-limit');
const { validateEventPayload } = require('../lib/revenue-event-schema');
const {
  getRevenueStore,
  blobGetJsonStrict,
  blobCreateJson,
} = require('../lib/revenue-store');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

function fingerprintEvent(validated) {
  const properties = { ...validated.properties };
  // The ID already names the reservation. Timestamp is deliberately excluded:
  // legacy/direct callers may omit it, causing validation to supply a new value
  // on a later retry. Same ID + same semantic payload must still replay safely.
  delete properties.event_id;
  delete properties.timestamp;
  delete properties.anonymous_session_id;
  const stableProperties = {};
  Object.keys(properties).sort().forEach((key) => { stableProperties[key] = properties[key]; });
  return crypto.createHash('sha256').update(JSON.stringify({
    event: validated.event,
    sessionId: validated.sessionId,
    properties: stableProperties,
  })).digest('hex');
}

function isLegacyReservation(value, eventId) {
  return !!(
    value
    && value.eventId === eventId
    && !value.fingerprint
    && !value.storeKey
    && !value.record
  );
}

function reservationIsUsable(value, eventId) {
  return !!(
    value
    && value.version === 2
    && value.eventId === eventId
    && typeof value.fingerprint === 'string'
    && typeof value.storeKey === 'string'
    && value.storeKey.endsWith(`/${eventId}`)
    && value.record
    && typeof value.record === 'object'
  );
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ ok: false, error: 'method_not_allowed' }) };
  }

  // enforcePublicRateLimit takes an OPTIONS OBJECT and returns { blocked, allowed },
  // never `ok`. The legacy positional call below silently destructured the string
  // 'revenue-event' as the options object, so `endpoint` was undefined and the
  // configured revenue-event:track bucket was never consulted; and `rate.ok` was
  // always undefined, so `!rate.ok` was always true and EVERY request returned 429
  // — including when the limiter explicitly allowed or failed open.
  const rate = await enforcePublicRateLimit(event, { endpoint: 'revenue-event', action: 'track' });
  if (rate.blocked) {
    return {
      statusCode: 429,
      headers: { ...cors, 'Retry-After': String(Math.max(1, Math.ceil(Number(rate.retryAfterSec) || 60))) },
      body: JSON.stringify({ ok: false, error: 'rate_limited' }),
    };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: 'invalid_json' }) }; }

  const validated = validateEventPayload(body);
  if (!validated.ok) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: validated.error }) };
  }

  try {
    const idemStore = await getRevenueStore('eventIdempotency');
    const idemKey = `evt:${validated.eventId}`;
    const receivedAt = new Date().toISOString();
    const fingerprint = fingerprintEvent(validated);
    const storeKey = `${receivedAt.slice(0, 10)}/${validated.eventId}`;
    const reservation = {
      version: 2,
      eventId: validated.eventId,
      fingerprint,
      storeKey,
      reservedAt: receivedAt,
      record: {
        event: validated.event,
        properties: validated.properties,
        receivedAt,
      },
    };

    // The reservation is the single event-ID authority. `onlyIfNew` is an
    // atomic create-only Blob write (If-None-Match:*). Exactly one concurrent
    // caller can create it; every other caller must read and replay its key.
    const reservationWrite = await blobCreateJson(idemStore, idemKey, reservation);
    let canonical = reservation;
    let duplicate = !reservationWrite.created;

    if (!reservationWrite.created) {
      canonical = await blobGetJsonStrict(idemStore, idemKey);
      if (!canonical) throw new Error('idempotency_reservation_unreadable');

      // Markers written by the pre-v2 event-first implementation prove the
      // corresponding event write already succeeded, because the marker was
      // written second. Never recreate them under a new UTC-day key.
      if (isLegacyReservation(canonical, validated.eventId)) {
        return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, duplicate: true }) };
      }
      if (!reservationIsUsable(canonical, validated.eventId)) {
        throw new Error('idempotency_reservation_invalid');
      }
      if (canonical.fingerprint !== fingerprint) {
        return {
          statusCode: 409,
          headers: cors,
          body: JSON.stringify({ ok: false, error: 'event_id_conflict' }),
        };
      }
    }

    const eventStore = await getRevenueStore('events');
    // Projection is also create-only. A retry after a lost response, a partial
    // reservation-only failure, or a concurrent call targets this exact key.
    const eventWrite = await blobCreateJson(eventStore, canonical.storeKey, canonical.record);
    duplicate = duplicate || !eventWrite.created;

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify(duplicate ? { ok: true, duplicate: true } : { ok: true }),
    };
  } catch (err) {
    console.error('[revenue-event] storage error:', err.message);
    return { statusCode: 503, headers: cors, body: JSON.stringify({ ok: false, error: 'storage_unavailable' }) };
  }
};
