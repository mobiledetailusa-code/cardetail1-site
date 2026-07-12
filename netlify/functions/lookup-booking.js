// netlify/functions/lookup-booking.js — updated to use ops-schema projection.
const { jsonCors } = require('../lib/tech-security');
const { getBooking, normalizePhone, phonesMatch } = require('../lib/ops-db');
const { projectBookingForCustomer } = require('../lib/ops-schema');
const { enforcePublicRateLimit } = require('../lib/public-rate-limit');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') return jsonCors(405, { ok: false, error: 'method_not_allowed' });

  const rateLimit = await enforcePublicRateLimit(event, { endpoint: 'lookup-booking', cors: true });
  if (rateLimit.blocked) return rateLimit.response;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'invalid_request' }); }

  const rawId = String(body.bookingId || body.id || '').trim().toUpperCase().replace(/[^A-Z0-9\-]/g, '');
  const rawPhone = normalizePhone(body.phone || body.customerPhone || '');

  if (!rawId) return jsonCors(400, { ok: false, error: 'validation_error', message: 'Booking ID is required.' });
  if (!rawPhone || rawPhone.length !== 10) {
    return jsonCors(400, { ok: false, error: 'validation_error', message: 'A valid 10-digit phone number is required.' });
  }

  try {
    const booking = await getBooking(rawId);
    if (!booking) {
      return jsonCors(200, {
        ok: false, found: false,
        message: 'No booking found. Please check your booking ID and phone number.',
      });
    }

    const storedPhone = normalizePhone(booking.phone || booking.customerPhone || '');
    if (!storedPhone || !phonesMatch(rawPhone, storedPhone)) {
      return jsonCors(200, {
        ok: false, found: false,
        message: 'No booking found. Please check your booking ID and phone number.',
      });
    }

    return jsonCors(200, { ok: true, booking: projectBookingForCustomer(booking) });
  } catch {
    return jsonCors(500, { ok: false, error: 'lookup_failed' });
  }
};
