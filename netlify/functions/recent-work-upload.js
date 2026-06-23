// netlify/functions/recent-work-upload.js
// Admin-only image upload for the Recent Work gallery.
//
// POST { data: <base64 string>, contentType: <string>, filename: <string>, size: <number> }
// Headers: x-admin-key, Content-Type: application/json
//
// Validates: admin auth, MIME type (jpeg/png/webp), extension, size (<= 4 MB),
//            magic bytes. Stores image in cd1-gallery-images Netlify Blob store.
// Returns:  { ok, id, url, size, contentType }
// Public URL: /.netlify/functions/recent-work-image?id=<id>
//
// 4 MB limit (not 5 MB) because base64 expands 1.33× — a 4 MB file encodes to
// ~5.3 MB base64, safely under Netlify's 6 MB function body limit.

const crypto = require('crypto');
const { json: secureJson } = require('./_security');

let currentEvent;
const json = (status, body) => secureJson(currentEvent, status, body);

const ALLOWED = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png':  ['png'],
  'image/webp': ['webp'],
};
const MAX_BYTES = 4 * 1024 * 1024; // 4 MB

function checkMagicBytes(buf, contentType) {
  if (buf.length < 12) return false;
  if (contentType === 'image/jpeg') {
    return buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
  }
  if (contentType === 'image/png') {
    return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
  }
  if (contentType === 'image/webp') {
    // RIFF....WEBP
    return buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
  }
  return false;
}

function sanitizeFilename(name) {
  return String(name || 'upload')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.+/g, '.')
    .replace(/^[._-]+/, '')
    .slice(0, 80) || 'upload';
}

async function openImageStore() {
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token)
    ? getStore({ name: 'cd1-gallery-images', siteID, token })
    : getStore('cd1-gallery-images');
}

exports.handler = async (event) => {
  currentEvent = event;
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });

  // ── Auth ──────────────────────────────────────────────────────────────────
  const expected = (process.env.ADMIN_DASH_PASSWORD || '').trim();
  if (!expected) return json(503, { ok: false, error: 'admin_password_not_configured' });

  const provided = (
    (event.headers && (event.headers['x-admin-key'] || event.headers['X-Admin-Key'])) || ''
  ).trim();
  if (!provided) return json(401, { ok: false, error: 'missing_key' });

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return json(401, { ok: false, error: 'unauthorized' });
  }

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'invalid_json' }); }

  const { data, contentType, filename, size } = body;

  if (!data || typeof data !== 'string') {
    return json(400, { ok: false, error: 'missing_data' });
  }
  if (!ALLOWED[contentType]) {
    return json(400, { ok: false, error: 'invalid_content_type', allowed: Object.keys(ALLOWED) });
  }

  // Extension check — must be an allowed extension (or absent)
  const rawExt = String(filename || '').split('.').pop().toLowerCase();
  if (rawExt && !Object.values(ALLOWED).flat().includes(rawExt)) {
    return json(400, { ok: false, error: 'invalid_extension' });
  }

  // ── Decode & validate ──────────────────────────────────────────────────────
  let buf;
  try { buf = Buffer.from(data, 'base64'); }
  catch { return json(400, { ok: false, error: 'invalid_base64' }); }

  if (buf.length === 0) return json(400, { ok: false, error: 'empty_file' });
  if (buf.length > MAX_BYTES) {
    return json(400, {
      ok: false,
      error: 'file_too_large',
      maxMB: 4,
      receivedBytes: buf.length,
    });
  }

  if (!checkMagicBytes(buf, contentType)) {
    return json(400, {
      ok: false,
      error: 'invalid_file_header',
      detail: 'File content does not match declared type — SVG, HTML, PDF, and non-image files are rejected',
    });
  }

  // ── Store ──────────────────────────────────────────────────────────────────
  const randPart = crypto.randomBytes(8).toString('hex');
  const id = `img_${Date.now()}_${randPart}`;
  const safeFilename = sanitizeFilename(filename);

  try {
    const store = await openImageStore();
    // Binary image blob
    await store.set(id, buf);
    // Companion metadata (content type for serving)
    await store.setJSON(`meta_${id}`, {
      contentType,
      originalFilename: safeFilename,
      size: buf.length,
      uploadedAt: new Date().toISOString(),
    });
  } catch (e) {
    return json(500, { ok: false, error: 'storage_error', detail: e.message });
  }

  const url = `/.netlify/functions/recent-work-image?id=${id}`;
  return json(200, { ok: true, id, url, size: buf.length, contentType });
};
