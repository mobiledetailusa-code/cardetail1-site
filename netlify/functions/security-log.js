// netlify/functions/security-log.js
// Admin-only: view security event logs.
// Auth: x-admin-token or x-admin-key header.
//
// GET → { ok, events[] }
// Query params: limit (default 100), type (filter by event type)

const crypto = require('crypto');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-token, x-admin-key',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Cache-Control': 'no-store',
};
const json = (status, body) => ({ statusCode: status, headers: CORS, body: JSON.stringify(body) });

async function getStore(name) {
  const { getStore: gs } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token) ? gs({ name, siteID, token }) : gs(name);
}

async function verifyAdmin(headers) {
  const h = headers || {};
  const token = (h['x-admin-token'] || h['X-Admin-Token'] || '').trim();
  if (token && token.length >= 32) {
    const sessionStore = await getStore('cd1-admin-sessions');
    const key = 'sess-' + token.slice(0, 16);
    const s = await sessionStore.get(key, { type: 'json' }).catch(() => null);
    if (s && Date.now() <= s.expiresAt) {
      return crypto.timingSafeEqual(Buffer.from(s.token), Buffer.from(token));
    }
  }
  const adminKey = (h['x-admin-key'] || h['X-Admin-Key'] || '').trim();
  const expected = (process.env.ADMIN_DASH_PASSWORD || '').trim();
  if (!adminKey || !expected) return false;
  const a = Buffer.from(adminKey);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'method_not_allowed' });

  if (!(await verifyAdmin(event.headers))) {
    return json(401, { ok: false, error: 'unauthorized' });
  }

  const params = event.queryStringParameters || {};
  const limit = Math.min(parseInt(params.limit) || 100, 500);
  const typeFilter = (params.type || '').trim();

  try {
    const store = await getStore('cd1-security-log');
    const listing = await store.list();
    const blobs = (listing && listing.blobs) || [];

    // Sort keys descending (newest first, since keys are timestamp-based)
    const sortedKeys = blobs.map(b => b.key).filter(k => k.startsWith('log-')).sort().reverse();

    const events = [];
    for (const key of sortedKeys) {
      if (events.length >= limit) break;
      const ev = await store.get(key, { type: 'json' }).catch(() => null);
      if (!ev) continue;
      if (typeFilter && ev.type !== typeFilter) continue;
      events.push(ev);
    }

    return json(200, { ok: true, count: events.length, events });
  } catch (e) {
    return json(500, { ok: false, error: 'failed_to_load_logs' });
  }
};
