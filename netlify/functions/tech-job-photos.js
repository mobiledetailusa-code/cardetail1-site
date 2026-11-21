// Technician job photo upload — before/after, assigned jobs only.
const {
  blobsStore, listAllBlobs, fetchBlobRecords, jsonCors, validateTechSession, sanitizeText, readJsonStrong,
} = require('../lib/tech-security');
const { technicianAccess, createRosterLoader } = require('../lib/tech-dispatch-privacy');

async function rosterRecords() {
  const store = await blobsStore('cd1-tech-accounts');
  const blobs = await listAllBlobs(store, 'cd1-tech-accounts');
  return fetchBlobRecords(store, blobs.filter((x) => String(x.key || '').startsWith('tech-')), 15, { strict: true });
}

/**
 * Strong read: the access decision must see the latest assignment and status.
 * A failed strong read throws (StrongReadError); there is no eventual fallback.
 */
async function readBookingStrong(store, id) {
  return (await readJsonStrong(store, id)).data;
}
const unavailable = () => jsonCors(503, { ok: false, error: 'temporarily_unavailable' }, { 'Retry-After': '5' });

/**
 * Photos follow the same gate as customer PII: assigned by id (or a unique
 * legacy name), not completed/cancelled in any status field, and within
 * 12 hours of the Eastern arrival start. URLs already issued earlier stay
 * reachable; this only stops new ones being issued or accepted.
 */
async function photoAccessError(booking, session) {
  const access = await technicianAccess(booking, session, { loadRoster: createRosterLoader(rosterRecords) });
  if (!access.assigned) return jsonCors(403, { ok: false, error: 'not_assigned_to_you' });
  if (!access.piiAllowed) {
    return jsonCors(403, {
      ok: false,
      error: 'photo_access_locked',
      reason: access.reason,
      unlocksAt: access.unlocksAt || null,
    });
  }
  return null;
}
const { appendEventLog } = require('../lib/ops-workflow');
const {
  decodeAndValidateImage, storeJobPhoto, MAX_PHOTOS_PER_PHASE,
} = require('../lib/job-photo-storage');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});

  const session = await validateTechSession(event.headers || {});
  if (!session) return jsonCors(401, { ok: false, error: 'unauthorized' });

  const bookingId = sanitizeText(
    (event.httpMethod === 'GET'
      ? (event.queryStringParameters || {}).bookingId
      : null),
    48
  );

  if (event.httpMethod === 'GET') {
    if (!bookingId) return jsonCors(400, { ok: false, error: 'bookingId_required' });
    const store = await blobsStore('cd1-bookings');
    let booking;
    try { booking = await readBookingStrong(store, bookingId); } catch { return unavailable(); }
    if (!booking) return jsonCors(404, { ok: false, error: 'booking_not_found' });
    const denied = await photoAccessError(booking, session);
    if (denied) return denied;
    return jsonCors(200, {
      ok: true,
      bookingId,
      photosBefore: booking.photosBefore || [],
      photosAfter: booking.photosAfter || [],
    });
  }

  if (event.httpMethod !== 'POST') return jsonCors(405, { ok: false, error: 'method_not_allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'invalid_json' }); }

  const bid = sanitizeText(body.bookingId, 48);
  const phase = String(body.phase || '').toLowerCase();
  if (!bid) return jsonCors(400, { ok: false, error: 'bookingId_required' });
  if (!['before', 'after'].includes(phase)) {
    return jsonCors(400, { ok: false, error: 'phase_must_be_before_or_after' });
  }

  const bookStore = await blobsStore('cd1-bookings');
  let booking;
  try { booking = await readBookingStrong(bookStore, bid); } catch { return unavailable(); }
  if (!booking) return jsonCors(404, { ok: false, error: 'booking_not_found' });
  const denied = await photoAccessError(booking, session);
  if (denied) return denied;

  const field = phase === 'before' ? 'photosBefore' : 'photosAfter';
  const existing = Array.isArray(booking[field]) ? booking[field] : [];
  if (existing.length >= MAX_PHOTOS_PER_PHASE) {
    return jsonCors(400, {
      ok: false,
      error: 'max_photos_reached',
      max: MAX_PHOTOS_PER_PHASE,
      userMessage: `Maximum ${MAX_PHOTOS_PER_PHASE} ${phase} photos per job.`,
    });
  }

  const validated = decodeAndValidateImage(body.data, body.contentType, body.filename);
  if (validated.error) {
    return jsonCors(400, {
      ok: false,
      error: validated.error,
      ...(validated.maxMB ? { maxMB: validated.maxMB } : {}),
      userMessage: validated.error === 'file_too_large'
        ? 'Photo must be 4 MB or smaller.'
        : 'Invalid image file. Use JPEG, PNG, or WebP.',
    });
  }

  let stored;
  try {
    stored = await storeJobPhoto({
      bookingId: bid,
      phase,
      techId: session.techId,
      buf: validated.buf,
      contentType: body.contentType,
      filename: body.filename,
    });
  } catch (e) {
    return jsonCors(500, { ok: false, error: 'storage_error' });
  }

  const now = new Date().toISOString();
  const photos = [...existing, stored.url];
  const patched = {
    ...booking,
    [field]: photos,
    updatedAt: now,
    eventLog: appendEventLog(booking, {
      action: 'job_photo_uploaded',
      by: 'technician',
      technicianId: session.techId,
      phase,
      photoId: stored.id,
    }),
  };
  await bookStore.setJSON(bid, patched);

  return jsonCors(200, {
    ok: true,
    bookingId: bid,
    phase,
    id: stored.id,
    url: stored.url,
    photosBefore: patched.photosBefore || [],
    photosAfter: patched.photosAfter || [],
  });
};
