// netlify/functions/submit-review.js
// Customer review submission — verifies bookingId + phone before accepting.
// Saves pending reviews to cd1-reviews Blobs. Reviews are NOT published
// publicly until admin moderation is implemented and a review is approved.
//
// POST { bookingId, phone, rating, text, displayName?, service? }
//   bookingId   — e.g. "CD1-XXXXX"
//   phone       — any format; normalized server-side
//   rating      — integer 1–5
//   text        — review body, 5–1000 chars, HTML stripped
//   displayName — optional, e.g. "John D."
//   service     — optional, e.g. "Interior Detail"
//
// Responses:
//   { ok: true,  message: '…' }
//   { ok: false, error: '<code>', message: '…' }
//
// Env: NETLIFY_SITE_ID + NETLIFY_AUTH_TOKEN

const MIN_TEXT = 5;
const MAX_TEXT = 1000;

const json = (status, body) => ({
  statusCode: status,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Cache-Control': 'no-store',
  },
  body: JSON.stringify(body),
});

async function blobsStore(name) {
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token) ? getStore({ name, siteID, token }) : getStore(name);
}

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.charAt(0) === '1') return digits.slice(1);
  return digits;
}

// Strip HTML tags and block JS injection patterns
function sanitize(str) {
  return String(str || '')
    .replace(/<[^>]*>/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .trim();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST')    return json(405, { ok: false, error: 'method_not_allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'invalid_request' }); }

  const rawId      = String(body.bookingId || body.id || '').trim().toUpperCase().replace(/[^A-Z0-9\-]/g, '');
  const rawPhone   = normalizePhone(body.phone || body.customerPhone || '');
  const rating     = parseInt(body.rating, 10);
  const text       = sanitize(body.text || '');
  const displayName = sanitize(body.displayName || '');
  const service    = sanitize(body.service || '');

  if (!rawId)                              return json(400, { ok: false, error: 'missing_booking_id', message: 'Booking ID is required.' });
  if (!rawPhone || rawPhone.length < 7)    return json(400, { ok: false, error: 'invalid_phone',      message: 'A valid phone number is required.' });
  if (!rating || rating < 1 || rating > 5) return json(400, { ok: false, error: 'invalid_rating',    message: 'Rating must be between 1 and 5.' });
  if (!text || text.length < MIN_TEXT)     return json(400, { ok: false, error: 'text_too_short',     message: `Review text must be at least ${MIN_TEXT} characters.` });
  if (text.length > MAX_TEXT)              return json(400, { ok: false, error: 'text_too_long',      message: `Review text must be under ${MAX_TEXT} characters.` });

  try {
    // Verify booking exists and phone matches — same pattern as lookup-booking.js
    const bookingsStore = await blobsStore('cd1-bookings');
    const booking = await bookingsStore.get(rawId, { type: 'json' }).catch(() => null);

    if (!booking) {
      return json(200, {
        ok: false, error: 'no_booking',
        message: 'No booking found. Please check your booking ID and phone number.',
      });
    }

    const storedPhone = normalizePhone(booking.phone || booking.customerPhone || '');
    if (!storedPhone || storedPhone !== rawPhone) {
      return json(200, {
        ok: false, error: 'phone_mismatch',
        message: 'Booking ID and phone number do not match our records.',
      });
    }

    // Prevent duplicate submissions — one pending/approved review per booking
    const reviewsStore = await blobsStore('cd1-reviews');
    const existing = await reviewsStore.get(`review:${rawId}`, { type: 'json' }).catch(() => null);
    if (existing && existing.status !== 'rejected') {
      return json(200, {
        ok: false, error: 'already_submitted',
        message: 'A review for this booking has already been submitted.',
      });
    }

    const review = {
      id:          `review:${rawId}`,
      bookingId:   rawId,
      rating,
      text,
      displayName: displayName || null,
      service:     service || booking.package || booking.service || null,
      status:      'pending',
      createdAt:   new Date().toISOString(),
      source:      'Cardetail1 Customer Garage',
    };

    await reviewsStore.setJSON(`review:${rawId}`, review);

    return json(200, {
      ok: true,
      message: 'Thank you. Your feedback was received and may be reviewed before appearing publicly.',
    });
  } catch (e) {
    return json(500, {
      ok: false, error: 'submit_failed',
      message: 'Could not save your review. Please try again or call 551-313-2956.',
    });
  }
};
