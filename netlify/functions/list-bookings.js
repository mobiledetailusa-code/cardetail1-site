// netlify/functions/list-bookings.js
// Returns ALL bookings stored centrally in Netlify Blobs, for the Admin dashboard.
// Protected by admin session token (x-admin-key header).

const { verifyAdminKey, listAllBlobs, fetchBlobRecords } = require('../lib/tech-security');
const { redactBookingForLegacyAdmin } = require('../lib/admin-security');
const { isVisibleSubmittedBooking } = require('../lib/booking-visibility');

const json = (status, body) => ({
  statusCode: status,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key, x-show-test',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});

  const auth = await verifyAdminKey(event.headers || {});
  if (!auth.ok) {
    const status = auth.error === 'missing_admin_config' ? 503 : 401;
    return json(status, { ok: false, error: auth.error || 'unauthorized' });
  }

  const showTest = !!(
    (event.headers && (event.headers['x-show-test'] || event.headers['X-Show-Test'])) ||
    (event.queryStringParameters && event.queryStringParameters.showTest)
  );

  try {
    const { getStore } = await import('@netlify/blobs');
    const siteID = process.env.NETLIFY_SITE_ID;
    const token = process.env.NETLIFY_AUTH_TOKEN;
    const store = (siteID && token) ? getStore({ name: 'cd1-bookings', siteID, token }) : getStore('cd1-bookings');
    const blobs = await listAllBlobs(store, 'cd1-bookings');
    const all = await fetchBlobRecords(store, blobs);
    const finalized = all.filter((b) =>
      b && isVisibleSubmittedBooking(b, { includeArchivedTest: !!showTest })
    );
    const bookings = finalized.map(redactBookingForLegacyAdmin);
    bookings.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return json(200, { ok: true, count: bookings.length, bookings });
  } catch (e) {
    return json(500, { ok: false, error: 'list_failed' });
  }
};
