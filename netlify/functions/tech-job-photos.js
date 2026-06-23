// Technician job photo upload — before/after, assigned jobs only.
const {
  blobsStore, jsonCors, validateTechSession, bookingAssignedToTech, sanitizeText,
} = require('../lib/tech-security');
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
    const booking = await store.get(bookingId, { type: 'json' }).catch(() => null);
    if (!booking) return jsonCors(404, { ok: false, error: 'booking_not_found' });
    if (!bookingAssignedToTech(booking, session.techId, session.techName)) {
      return jsonCors(403, { ok: false, error: 'not_assigned_to_you' });
    }
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
  const booking = await bookStore.get(bid, { type: 'json' }).catch(() => null);
  if (!booking) return jsonCors(404, { ok: false, error: 'booking_not_found' });
  if (!bookingAssignedToTech(booking, session.techId, session.techName)) {
    return jsonCors(403, { ok: false, error: 'not_assigned_to_you' });
  }

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
