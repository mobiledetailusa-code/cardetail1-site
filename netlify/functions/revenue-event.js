// POST /.netlify/functions/revenue-event — first-party analytics ingestion.

const { enforcePublicRateLimit } = require('../lib/public-rate-limit');
const { validateEventPayload } = require('../lib/revenue-event-schema');
const { getRevenueStore, blobGetJson, blobSetJson, retentionExpiresAt } = require('../lib/revenue-store');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ ok: false, error: 'method_not_allowed' }) };
  }

  const rate = await enforcePublicRateLimit(event, 'revenue-event', 'track');
  if (!rate.ok) {
    return {
      statusCode: 429,
      headers: { ...cors, 'Retry-After': String(Math.ceil((rate.retryAfterMs || 60000) / 1000)) },
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
    const existing = await blobGetJson(idemStore, idemKey);
    if (existing) {
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, duplicate: true }) };
    }

    const record = {
      event: validated.event,
      properties: validated.properties,
      receivedAt: new Date().toISOString(),
      expiresAt: retentionExpiresAt('eventIdempotency'),
    };

    const eventStore = await getRevenueStore('events');
    const day = new Date().toISOString().slice(0, 10);
    const storeKey = `${day}/${validated.eventId}`;
    await blobSetJson(eventStore, storeKey, record);
    await blobSetJson(idemStore, idemKey, { eventId: validated.eventId, storedAt: record.receivedAt });

    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('[revenue-event] storage error:', err.message);
    return { statusCode: 503, headers: cors, body: JSON.stringify({ ok: false, error: 'storage_unavailable' }) };
  }
};
