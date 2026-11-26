/**
 * Admin, read-only: customer quote requests and questions stored by
 * submit-inquiry (Netlify Blobs store `revenue-inquiries`).
 *
 * GET ?limit=N → newest first, with contact, vehicle, services, status and the
 * email/SMS outcome. There is no write action here.
 *
 * Auth: the existing admin session (x-admin-key header or admin cookie) via
 * verifyAdminKey, same as admin-reviews.
 */

const { jsonCors, verifyAdminKey } = require('../lib/tech-security');
const { listInquiries } = require('../lib/vehicle-inquiry');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});

  const auth = await verifyAdminKey(event.headers || {});
  if (!auth.ok) {
    const status = auth.error === 'missing_admin_config' || auth.error === 'missing_admin_session_secret'
      ? 503
      : 401;
    return jsonCors(status, { ok: false, error: auth.error || 'unauthorized' });
  }

  if (event.httpMethod !== 'GET') return jsonCors(405, { ok: false, error: 'method_not_allowed' });

  const limit = Number((event.queryStringParameters || {}).limit) || 100;
  try {
    const result = await listInquiries({ limit });
    return jsonCors(200, { ok: true, ...result });
  } catch (e) {
    console.warn('[admin-inquiries] list failed:', e && e.message);
    return jsonCors(503, { ok: false, error: 'inquiries_unavailable' });
  }
};
