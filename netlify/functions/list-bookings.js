// netlify/functions/list-bookings.js
// Returns ALL bookings stored centrally in Netlify Blobs, for the Admin dashboard.
// Protected by a server-side password so customer data isn't public.
//
// Netlify env var (Site settings → Environment variables):
//   ADMIN_DASH_PASSWORD   the password the admin must send to read bookings.
//                         Set it to the SAME value as the admin login password.
//
// The admin UI sends it in the `x-admin-key` header (or ?key= for convenience).

const {
  blobsStore,
  json: secureJson,
  rateLimit,
  requireAdmin,
} = require('./_security');

let currentEvent;
const json = (status, body) => secureJson(currentEvent, status, body, {
  allowHeaders: 'Content-Type, x-admin-key, x-show-test',
  allowMethods: 'GET, POST, OPTIONS',
});

exports.handler = async (event) => {
  currentEvent = event;
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  const rl = await rateLimit(event, 'list-bookings', 60, 60);
  if (!rl.ok) return json(rl.status, rl.body);

  const admin = requireAdmin(event);
  if (!admin.ok) return json(admin.status, admin.body);

  // Pass x-show-test: 1 header (or ?showTest=1) to include test/archived bookings.
  const showTest = !!(
    (event.headers && (event.headers['x-show-test'] || event.headers['X-Show-Test'])) ||
    (event.queryStringParameters && event.queryStringParameters.showTest)
  );

  try {
    const store = await blobsStore('cd1-bookings');
    const listing = await store.list();
    const blobs = (listing && listing.blobs) || [];
    const all = (await Promise.all(
      blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null))
    )).filter(Boolean);
    const finalized = all.filter(b => !b.isDraft);
    const bookings = showTest ? finalized : finalized.filter(b => !b.isTest && !b.archived);
    // Newest first by createdAt.
    bookings.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return json(200, { ok: true, count: bookings.length, bookings });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
};
