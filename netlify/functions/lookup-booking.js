// netlify/functions/lookup-booking.js — updated to use ops-schema projection.
const crypto = require('crypto');
const { jsonCors } = require('../lib/tech-security');
const { getBooking, normalizePhone, phonesMatch } = require('../lib/ops-db');
const { projectBookingForCustomer } = require('../lib/ops-schema');
const { enforcePublicRateLimit, hashRateLimitSubject } = require('../lib/public-rate-limit');
const { isVisibleSubmittedBooking } = require('../lib/booking-visibility');
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
  catch { return jsonCors(400, { ok: false, error: 'invalid_request' }); }

  const rawId = String(body.bookingId || body.id || '').trim().toUpperCase().replace(/[^A-Z0-9\-]/g, '');
  const rawPhone = normalizePhone(body.phone || body.customerPhone || '');
  const rateLimit = await enforcePublicRateLimit(event, {
    endpoint: 'lookup-booking',
    cors: true,
    subject: hashRateLimitSubject(rawId, rawPhone),
    failClosed: true,
  });
  if (rateLimit.blocked) return rateLimit.response;

  try {
    const booking = await getBooking(rawId || PAD_LOOKUP_ID);
    if (!rawId || !rawPhone || rawPhone.length !== 10) {
      return uniformMiss(!rawId ? 'invalid_id' : 'invalid_phone');
    }

    const storedPhone = normalizePhone((booking && (booking.phone || booking.customerPhone)) || '');
    const compared = crypto.timingSafeEqual(phoneDigest(rawPhone), phoneDigest(storedPhone));
    const phoneOk = compared && phonesMatch(rawPhone, storedPhone);
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

    return jsonCors(200, { ok: true, booking: projectBookingForCustomer(booking) });
  } catch {
    return jsonCors(500, { ok: false, error: 'lookup_failed' });
  }
};
