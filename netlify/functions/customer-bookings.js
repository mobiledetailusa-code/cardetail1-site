// Customer cloud lookup — requires booking ID + phone (no phone-only enumeration).
// Retained legacy route: My Garage uses customer-portal-data; lookup-booking is the
// primary public single-booking lookup. This endpoint remains for supported legacy
// booking-ID + phone access and is rate-limited like lookup-booking.
const { jsonCors } = require('../lib/tech-security');
const { getBooking, normalizePhone, phonesMatch } = require('../lib/ops-db');
const { projectBookingForCustomer } = require('../lib/ops-schema');
const { isVisibleSubmittedBooking } = require('../lib/booking-visibility');
const { enforcePublicRateLimit, hashRateLimitSubject } = require('../lib/public-rate-limit');

const LOOKUP_MISS = Object.freeze({
  ok: false,
  found: false,
  message: 'No booking found. Please check your booking ID and phone number.',
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') return jsonCors(405, { ok: false, error: 'method_not_allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'invalid_json' }); }

  const rawId = String(body.bookingId || body.id || '').trim().toUpperCase().replace(/[^A-Z0-9\-]/g, '');
  const phone = normalizePhone(body.phone || body.customerPhone || '');

  // Rate-limit by hashed IP + hashed normalized lookup identifiers (case/format aliases collapse).
  const subject = hashRateLimitSubject(rawId, phone);
  const rateLimit = await enforcePublicRateLimit(event, {
    endpoint: 'customer-bookings',
    cors: true,
    subject,
  });
  if (rateLimit.blocked) return rateLimit.response;

  if (!rawId || !phone || phone.length < 7) {
    return jsonCors(400, {
      ok: false,
      error: 'lookup_failed',
      message: LOOKUP_MISS.message,
    });
  }

  try {
    const booking = await getBooking(rawId);
    if (!booking || !isVisibleSubmittedBooking(booking)) {
      return jsonCors(200, {
        ...LOOKUP_MISS,
        error: booking && booking.isDraft ? 'booking_not_ready' : undefined,
      });
    }

    const storedPhone = normalizePhone(booking.phone || booking.customerPhone || '');
    if (!storedPhone || !phonesMatch(phone, storedPhone)) {
      return jsonCors(200, { ...LOOKUP_MISS });
    }

    const projected = projectBookingForCustomer(booking);
    return jsonCors(200, { ok: true, count: 1, bookings: [projected] });
  } catch {
    return jsonCors(500, { ok: false, error: 'lookup_failed' });
  }
};
