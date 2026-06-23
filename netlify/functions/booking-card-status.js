// Returns only the card-on-file state for a pre-registered booking draft.
// The browser waits for the verified Stripe webhook before final submission.
// No Stripe IDs, customer data, or client secrets are exposed.

const {
  blobsStore,
  cleanBookingId,
  json: secureJson,
  phonesMatchExact,
  rateLimit,
} = require('./_security');

let currentEvent;
const json = (statusCode, body) => secureJson(currentEvent, statusCode, body, { allowHeaders: 'Content-Type' });

exports.handler = async (event) => {
  currentEvent = event;
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });
  const rl = await rateLimit(event, 'booking-card-status', 60, 60);
  if (!rl.ok) return json(rl.status, rl.body);

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'invalid_request' }); }

  const bookingId = cleanBookingId(body.bookingId);
  if (!bookingId) return json(400, { ok: false, error: 'bookingId_required' });
  if (!body.phone) return json(400, { ok: false, error: 'phone_required' });

  try {
    const booking = await (await blobsStore('cd1-bookings')).get(bookingId, { type: 'json' });
    if (!booking) return json(404, { ok: false, error: 'booking_not_found' });
    if (!phonesMatchExact(body.phone, booking.phone)) return json(403, { ok: false, error: 'verification_failed' });
    const status = ['pending', 'saved', 'failed'].includes(booking.cardOnFileStatus)
      ? booking.cardOnFileStatus
      : 'pending';
    return json(200, { ok: true, cardOnFileStatus: status });
  } catch {
    return json(503, { ok: false, error: 'status_unavailable' });
  }
};
