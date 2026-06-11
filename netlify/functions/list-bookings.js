// netlify/functions/list-bookings.js
// Returns ALL bookings stored centrally in Netlify Blobs, for the Admin dashboard.
// Protected by a server-side password so customer data isn't public.
//
// Netlify env var (Site settings → Environment variables):
//   ADMIN_DASH_PASSWORD   the password the admin must send to read bookings.
//                         Set it to the SAME value as the admin login password.
//
// The admin UI sends it in the `x-admin-key` header (or ?key= for convenience).

const json = (status, body) => ({
  statusCode: status,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});

  const expected = process.env.ADMIN_DASH_PASSWORD || '';
  if (!expected) return json(503, { ok: false, error: 'ADMIN_DASH_PASSWORD not set on server' });

  const provided =
    (event.headers && (event.headers['x-admin-key'] || event.headers['X-Admin-Key'])) ||
    (event.queryStringParameters && event.queryStringParameters.key) || '';
  if (provided !== expected) return json(401, { ok: false, error: 'unauthorized' });

  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore('cd1-bookings');
    const listing = await store.list();
    const blobs = (listing && listing.blobs) || [];
    const bookings = (await Promise.all(
      blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null))
    )).filter(Boolean);
    // Newest first by createdAt.
    bookings.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return json(200, { ok: true, count: bookings.length, bookings });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
};
