// Booking-scoped customer authorization helpers.

const { getBooking } = require('./ops-db');
const { phonesMatch, normalizeUsPhoneDigits } = require('./phone-auth');
const { validateCustomerSession } = require('./customer-session');

const AUTH_FAIL = Object.freeze({
  ok: false,
  error: 'authentication_failed',
  message: 'Verification failed. Please check your booking ID and phone number.',
});

const NOT_FOUND = Object.freeze({
  ok: false,
  error: 'booking_not_found',
  message: 'No booking found. Please check your booking ID and phone number.',
});

function normalizeBookingId(raw) {
  return String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9\-]/g, '').slice(0, 48);
}

/**
 * Verify booking ID + phone (limited access) or valid session with booking scope.
 * @returns {Promise<{ ok: true, booking, scope: 'booking'|'session' } | { ok: false, error, message?, statusCode? }>}
 */
async function authorizeBookingAccess(event, { bookingId, phone, requireSessionForAccount = false } = {}) {
  const id = normalizeBookingId(bookingId);
  if (!id) {
    return { ok: false, error: 'validation_error', message: 'Booking ID is required.', statusCode: 400 };
  }

  const session = await validateCustomerSession(event);
  if (session.ok && session.scope === 'account') {
    const booking = await getBooking(id);
    if (!booking) return { ...NOT_FOUND, statusCode: 200 };
    if (!sessionBookingAllowed(session, booking)) {
      return { ...AUTH_FAIL, statusCode: 403 };
    }
    return { ok: true, booking, scope: 'session', session };
  }

  if (requireSessionForAccount) {
    return { ok: false, error: 'authentication_failed', message: 'Account sign-in required.', statusCode: 401 };
  }

  const phoneDigits = normalizeUsPhoneDigits(phone);
  if (!phoneDigits) {
    return { ok: false, error: 'validation_error', message: 'A valid phone number is required.', statusCode: 400 };
  }

  const booking = await getBooking(id);
  if (!booking) return { ...NOT_FOUND, statusCode: 200 };

  const stored = booking.phone || booking.customerPhone || '';
  if (!phonesMatch(phoneDigits, stored)) {
    return { ...AUTH_FAIL, statusCode: 200 };
  }

  return { ok: true, booking, scope: 'booking', phoneDigits };
}

function sessionBookingAllowed(session, booking) {
  if (!session || !booking) return false;
  if (session.bookingIds && session.bookingIds.includes(booking.id || booking.bookingId)) return true;
  const sessionPhone = session.phoneDigits;
  const bookingPhone = booking.phone || booking.customerPhone || '';
  return sessionPhone && phonesMatch(sessionPhone, bookingPhone);
}

module.exports = {
  normalizeBookingId,
  authorizeBookingAccess,
  AUTH_FAIL,
  NOT_FOUND,
};
