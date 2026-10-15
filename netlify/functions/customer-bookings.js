// Customer cloud lookup — requires booking ID + phone (no phone-only enumeration).
// Retained legacy route: My Garage uses customer-portal-data; lookup-booking is the
// primary public single-booking lookup. This endpoint remains for supported legacy
// booking-ID + phone access and is rate-limited like lookup-booking.
const crypto = require('crypto');
const { jsonCors } = require('../lib/tech-security');
const { getBooking, normalizePhone, phonesMatch } = require('../lib/ops-db');
const { projectBookingForCustomer } = require('../lib/ops-schema');
const { isVisibleSubmittedBooking } = require('../lib/booking-visibility');
const { enforcePublicRateLimit, hashRateLimitSubject } = require('../lib/public-rate-limit');
const { publicLimitedLookupMiss } = require('../lib/booking-customer-auth');

const PAD_LOOKUP_ID = 'CD1-LOOKUP-PAD';

function phoneDigest(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest();
}

function uniformMiss(reason) {
  const miss = publicLimitedLookupMiss(reason);
  return jsonCors(miss.statusCode, miss.body);
}

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

  try {
    const booking = await getBooking(rawId || PAD_LOOKUP_ID);
    if (!rawId || !phone || phone.length !== 10) {
      return uniformMiss(!rawId ? 'invalid_id' : 'invalid_phone');
    }

    const storedPhone = normalizePhone((booking && (booking.phone || booking.customerPhone)) || '');
    const compared = crypto.timingSafeEqual(phoneDigest(phone), phoneDigest(storedPhone));
    const phoneOk = compared && phonesMatch(phone, storedPhone);
    if (!booking || !phoneOk) {
      return uniformMiss(!booking ? 'missing_booking' : 'phone_mismatch');
    }

    if (!isVisibleSubmittedBooking(booking)) {
      return jsonCors(200, {
        ok: false,
        found: false,
        error: 'booking_not_ready',
        message: 'No booking found. Please check your booking ID and phone number.',
      });
    }

    const projected = projectBookingForCustomer(booking);
    return jsonCors(200, { ok: true, count: 1, bookings: [projected] });
  } catch {
    return jsonCors(500, { ok: false, error: 'lookup_failed' });
  }
};
