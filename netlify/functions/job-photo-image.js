// Serve endpoint for job before/after photos (uploaded via tech-job-photos.js).
//
// Two photo generations, decided by the stored meta:
//
// * Protected (meta.cachePolicy === 'private-v1', every upload from QuickOps
//   Daily Dispatch onward): every request must carry either a valid Admin
//   session (x-admin-key) or a technician session (x-tech-token) that passes
//   the same server-side policy as customer PII for the photo's booking:
//   assigned by id (or unique legacy name), not cancelled/completed in any
//   status field, and inside the 12-hour America/New_York pre-arrival window.
//   The check runs on each request, so cancellation, completion, reassignment
//   or rescheduling stops further fetches. Responses are `private, no-store`.
//   Admin and technician pages fetch these with their auth header and display
//   them as blob: URLs.
//
// * Legacy (no cachePolicy): uploaded before this change and already served as
//   `public, max-age=31536000, immutable` with wildcard CORS. Those responses
//   may sit in browser or intermediary caches for up to a year and their URLs
//   may already be stored on devices. They are left public so existing links
//   keep working; requiring auth now could not recall copies already cached.
const { ID_RE, openJobPhotoStore, PRIVATE_CACHE_POLICY } = require('../lib/job-photo-storage');

const ALLOWED_SERVE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function isProtected(meta) {
  return !!(meta && meta.cachePolicy === PRIVATE_CACHE_POLICY);
}

function cacheHeadersFor(meta) {
  if (isProtected(meta)) {
    return { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', Vary: 'x-admin-key, x-tech-token' };
  }
  return { 'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*' };
}

const jsonErr = (status, msg) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify({ ok: false, error: msg }),
});

function header(event, name) {
  const h = (event && event.headers) || {};
  const lower = name.toLowerCase();
  for (const k of Object.keys(h)) if (k.toLowerCase() === lower) return String(h[k] || '');
  return '';
}

/**
 * Authorization for a protected photo, re-evaluated on every request.
 * @returns {Promise<{ ok: true, via: 'admin'|'technician' } | { ok: false, status: number, error: string }>}
 */
async function authorizeProtectedPhoto(event, meta) {
  // Admin session arrives as x-admin-key or the HttpOnly admin cookie.
  if (header(event, 'x-admin-key') || /(?:^|;\s*)cd1_admin_session=/.test(header(event, 'cookie'))) {
    const { verifyAdminRequest } = require('../lib/admin-security');
    const admin = await verifyAdminRequest(event.headers || {}).catch(() => ({ ok: false }));
    if (admin && admin.ok) return { ok: true, via: 'admin' };
  }
  if (header(event, 'x-tech-token')) {
    const {
      validateTechSession, blobsStore, listAllBlobs, fetchBlobRecords,
    } = require('../lib/tech-security');
    const { technicianAccess, createRosterLoader } = require('../lib/tech-dispatch-privacy');
    const session = await validateTechSession(event.headers || {}).catch(() => null);
    if (!session) return { ok: false, status: 401, error: 'unauthorized' };
    const bookingId = String(meta.bookingId || '').trim();
    if (!bookingId) return { ok: false, status: 403, error: 'forbidden' };
    const store = await blobsStore('cd1-bookings');
    let booking = null;
    if (typeof store.getWithMetadata === 'function') {
      const r = await store.getWithMetadata(bookingId, { type: 'json', consistency: 'strong' }).catch(() => null);
      booking = r && r.data;
    }
    if (!booking) booking = await store.get(bookingId, { type: 'json' }).catch(() => null);
    if (!booking) return { ok: false, status: 403, error: 'forbidden' };
    const roster = createRosterLoader(async () => {
      const ts = await blobsStore('cd1-tech-accounts');
      const blobs = await listAllBlobs(ts, 'cd1-tech-accounts');
      return fetchBlobRecords(ts, blobs.filter((b) => String(b.key || '').startsWith('tech-')), 15);
    });
    const access = await technicianAccess(booking, session, { loadRoster: roster });
    if (access.piiAllowed) return { ok: true, via: 'technician' };
    return { ok: false, status: 403, error: 'forbidden' };
  }
  return { ok: false, status: 401, error: 'unauthorized' };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' };
  }
  if (event.httpMethod !== 'GET') return jsonErr(405, 'method_not_allowed');

  const id = ((event.queryStringParameters || {}).id || '').trim();
  if (!ID_RE.test(id)) return jsonErr(400, 'invalid_id');

  try {
    const store = await openJobPhotoStore();
    const meta = await store.get(`meta_${id}`, { type: 'json' }).catch(() => null);
    if (!meta || !ALLOWED_SERVE_TYPES.has(meta.contentType)) {
      return jsonErr(404, 'not_found');
    }

    if (isProtected(meta)) {
      const auth = await authorizeProtectedPhoto(event, meta);
      if (!auth.ok) return jsonErr(auth.status, auth.error);
    }

    const buf = await store.get(id, { type: 'arrayBuffer' }).catch(() => null);
    if (!buf || buf.byteLength === 0) return jsonErr(404, 'not_found');

    return {
      statusCode: 200,
      headers: {
        'Content-Type': meta.contentType,
        ...cacheHeadersFor(meta),
        'X-Content-Type-Options': 'nosniff',
      },
      body: Buffer.from(buf).toString('base64'),
      isBase64Encoded: true,
    };
  } catch {
    return jsonErr(500, 'storage_error');
  }
};

// Exposed for tests only.
exports._cacheHeadersFor = cacheHeadersFor;
