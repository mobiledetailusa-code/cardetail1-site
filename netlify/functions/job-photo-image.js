// Public serve endpoint for job before/after photos (uploaded via tech-job-photos.js).
const { ID_RE, openJobPhotoStore } = require('../lib/job-photo-storage');

const ALLOWED_SERVE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const jsonErr = (status, msg) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify({ ok: false, error: msg }),
});

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

    const buf = await store.get(id, { type: 'arrayBuffer' }).catch(() => null);
    if (!buf || buf.byteLength === 0) return jsonErr(404, 'not_found');

    return {
      statusCode: 200,
      headers: {
        'Content-Type': meta.contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
      },
      body: Buffer.from(buf).toString('base64'),
      isBase64Encoded: true,
    };
  } catch {
    return jsonErr(500, 'storage_error');
  }
};
