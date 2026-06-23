// Job before/after photo storage — cd1-job-photos blob store.
const crypto = require('crypto');

const JOB_PHOTOS_STORE = 'cd1-job-photos';
const ID_RE = /^jobph_\d+_[0-9a-f]+$/;

const ALLOWED = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
};
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_PHOTOS_PER_PHASE = 8;

function checkMagicBytes(buf, contentType) {
  if (buf.length < 12) return false;
  if (contentType === 'image/jpeg') {
    return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  }
  if (contentType === 'image/png') {
    return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  }
  if (contentType === 'image/webp') {
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

function photoServeUrl(id) {
  return `/.netlify/functions/job-photo-image?id=${id}`;
}

async function openJobPhotoStore() {
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token)
    ? getStore({ name: JOB_PHOTOS_STORE, siteID, token })
    : getStore(JOB_PHOTOS_STORE);
}

function decodeAndValidateImage(data, contentType, filename) {
  if (!data || typeof data !== 'string') return { error: 'missing_data' };
  if (!ALLOWED[contentType]) return { error: 'invalid_content_type', allowed: Object.keys(ALLOWED) };
  const rawExt = String(filename || '').split('.').pop().toLowerCase();
  if (rawExt && !Object.values(ALLOWED).flat().includes(rawExt)) {
    return { error: 'invalid_extension' };
  }
  let buf;
  try { buf = Buffer.from(data, 'base64'); }
  catch { return { error: 'invalid_base64' }; }
  if (buf.length === 0) return { error: 'empty_file' };
  if (buf.length > MAX_BYTES) {
    return { error: 'file_too_large', maxMB: 4, receivedBytes: buf.length };
  }
  if (!checkMagicBytes(buf, contentType)) {
    return { error: 'invalid_file_header' };
  }
  return { buf };
}

async function storeJobPhoto({ bookingId, phase, techId, buf, contentType, filename }) {
  const id = `jobph_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
  const store = await openJobPhotoStore();
  await store.set(id, buf);
  await store.setJSON(`meta_${id}`, {
    contentType,
    bookingId,
    phase,
    techId,
    originalFilename: sanitizeFilename(filename),
    size: buf.length,
    uploadedAt: new Date().toISOString(),
  });
  return { id, url: photoServeUrl(id), size: buf.length, contentType };
}

module.exports = {
  JOB_PHOTOS_STORE,
  ID_RE,
  ALLOWED,
  MAX_BYTES,
  MAX_PHOTOS_PER_PHASE,
  photoServeUrl,
  openJobPhotoStore,
  decodeAndValidateImage,
  storeJobPhoto,
};
