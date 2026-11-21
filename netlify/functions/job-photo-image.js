// Serve endpoint for job before/after photos (uploaded via tech-job-photos.js).
//
// Every photo, legacy or new, requires authorization on every request:
//   * a valid Admin session (x-admin-key header or the HttpOnly admin cookie), or
//   * a technician session (x-tech-token) that passes the same server-side
//     policy as customer PII for the photo's booking: assigned by id (or a
//     unique legacy name), not cancelled/completed in any status field, and
//     inside the 12-hour America/New_York pre-arrival window.
// Ownership is resolved from the photo's stored meta (bookingId, written by
// the only uploader since the feature shipped) and must be confirmed by that
// booking listing the photo in photosBefore/photosAfter. Anything that cannot
// be resolved fails closed. Anonymous requests get 401 and no image bytes.
// Responses are `private, no-store`. Admin and technician pages fetch photos
// with their auth header and display them as blob: URLs.
//
// Not revocable: legacy photos were previously served `public, max-age=31536000,
// immutable` with wildcard CORS. Copies already cached by a browser (or by any
// intermediary) or downloaded/saved before this change cannot be recalled;
// this only governs new requests that reach the function.
const { ID_RE, openJobPhotoStore } = require('../lib/job-photo-storage');

const ALLOWED_SERVE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Same headers for every photo generation (meta.cachePolicy no longer matters).
function cacheHeadersFor() {
  return { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', Vary: 'x-admin-key, x-tech-token, cookie' };
}

/** Does the booking list this photo id in its before/after photo arrays? */
function bookingReferencesPhoto(booking, id) {
  const lists = [booking && booking.photosBefore, booking && booking.photosAfter];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const m = /[?&]id=([^&#]+)/.exec(String(entry || ''));
      if (m && decodeURIComponent(m[1]) === id) return true;
    }
  }
  return false;
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
 * Authorization for any job photo, re-evaluated on every request.
 * @returns {Promise<{ ok: true, via: 'admin'|'technician' } | { ok: false, status: number, error: string }>}
 */
async function authorizePhoto(event, meta, id) {
  // Admin session arrives as x-admin-key or the HttpOnly admin cookie.
  if (header(event, 'x-admin-key') || /(?:^|;\s*)cd1_admin_session=/.test(header(event, 'cookie'))) {
    const { verifyAdminRequest } = require('../lib/admin-security');
    const admin = await verifyAdminRequest(event.headers || {}).catch(() => ({ ok: false }));
    if (admin && admin.ok) return { ok: true, via: 'admin' };
  }
  if (header(event, 'x-tech-token')) {
    const {
      validateTechSession, blobsStore, listAllBlobs, fetchBlobRecords, readJsonStrong,
    } = require('../lib/tech-security');
    const { technicianAccess, createRosterLoader } = require('../lib/tech-dispatch-privacy');
    const session = await validateTechSession(event.headers || {}).catch(() => null);
    if (!session) return { ok: false, status: 401, error: 'unauthorized' };
    const bookingId = String(meta.bookingId || '').trim();
    if (!bookingId) return { ok: false, status: 403, error: 'forbidden' };
    const store = await blobsStore('cd1-bookings');
    // Strong read only. If it fails, deny with a retryable 503 and no bytes;
    // never decide on an eventually consistent (possibly stale) copy.
    let booking = null;
    try {
      booking = (await readJsonStrong(store, bookingId)).data;
    } catch {
      return { ok: false, status: 503, error: 'temporarily_unavailable' };
    }
    if (!booking) return { ok: false, status: 403, error: 'forbidden' };
    // Ownership must agree in both directions: meta names the booking and the
    // booking lists the photo. A mismatch fails closed.
    if (!bookingReferencesPhoto(booking, id)) return { ok: false, status: 403, error: 'forbidden' };
    const roster = createRosterLoader(async () => {
      const ts = await blobsStore('cd1-tech-accounts');
      const blobs = await listAllBlobs(ts, 'cd1-tech-accounts');
      return fetchBlobRecords(ts, blobs.filter((b) => String(b.key || '').startsWith('tech-')), 15, { strict: true });
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

  // No credentials at all: refuse before any storage lookup, so an anonymous
  // caller learns nothing (not even whether the id exists).
  if (!header(event, 'x-admin-key') && !header(event, 'x-tech-token')
    && !/(?:^|;\s*)cd1_admin_session=/.test(header(event, 'cookie'))) {
    return jsonErr(401, 'unauthorized');
  }

  try {
    const store = await openJobPhotoStore();
    const meta = await store.get(`meta_${id}`, { type: 'json' }).catch(() => null);
    if (!meta || !ALLOWED_SERVE_TYPES.has(meta.contentType)) {
      return jsonErr(404, 'not_found');
    }

    const auth = await authorizePhoto(event, meta, id);
    if (!auth.ok) return jsonErr(auth.status, auth.error);

    const buf = await store.get(id, { type: 'arrayBuffer' }).catch(() => null);
    if (!buf || buf.byteLength === 0) return jsonErr(404, 'not_found');

    return {
      statusCode: 200,
      headers: {
        'Content-Type': meta.contentType,
        ...cacheHeadersFor(),
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
