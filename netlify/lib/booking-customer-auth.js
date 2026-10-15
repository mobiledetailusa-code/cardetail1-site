// Booking-scoped customer authorization helpers.

const crypto = require('crypto');
const { getBooking } = require('./ops-db');
const { phonesMatch, phonesMatchForPortal, normalizeUsPhoneDigits } = require('./phone-auth');
const { validateCustomerSession } = require('./customer-session');

const AUTH_FAIL = Object.freeze({
  ok: false,
  error: 'authentication_failed',
  message: 'Phone does not match this booking. Use the same mobile number from checkout, or call/text (551) 389-3986.',
});

const LIMITED_LOOKUP_MISS = Object.freeze({
  ok: false,
  found: false,
  error: 'authentication_failed',
  message: 'No booking found. Please check your booking ID and phone number.',
});

function publicLimitedLookupMiss(reason) {
  console.info('[limited-lookup] miss', {
    reason: String(reason || 'unknown').slice(0, 48),
  });
  return { statusCode: 200, body: { ...LIMITED_LOOKUP_MISS } };
}

const NOT_FOUND = Object.freeze({
  ok: false,
  error: 'booking_not_found',
  message: 'No booking found for that ID. Copy the Booking ID from your confirmation email or Admin Ops, then try again.',
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
    return { ok: false, error: 'validation_error', message: 'A valid US mobile number is required (10 digits).', statusCode: 400 };
  }

  const booking = await getBooking(id);
  if (!booking) return { ...NOT_FOUND, statusCode: 200 };

  const stored = booking.phone || booking.customerPhone || booking.phoneNumber || '';
  if (!String(stored).replace(/\D/g, '')) {
    return {
      ok: false,
      error: 'phone_not_on_file',
      message: 'This booking has no phone on file. Ask Admin to save your mobile number, or call/text (551) 389-3986.',
      statusCode: 200,
    };
  }
  if (!phonesMatchForPortal(phoneDigits, stored)) {
    return { ...AUTH_FAIL, statusCode: 200 };
  }

  return { ok: true, booking, scope: 'booking', phoneDigits };
}

function emailHashOf(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized).digest('base64url');
}

/**
 * Verified email is required. A phone on the session must also match this
 * booking. Phone alone never opens someone else's appointment.
 */
function sessionContactAllows(session, booking) {
  const bookingEmailHash = emailHashOf(booking && booking.email);
  const emailOk = !!(session.emailHash && bookingEmailHash && session.emailHash === bookingEmailHash);
  if (!emailOk) return false;
  if (session.phoneDigits) {
    const bookingPhone = booking.phone || booking.customerPhone || '';
    return phonesMatchForPortal(session.phoneDigits, bookingPhone);
  }
  return true;
}

function sessionBookingAllowed(session, booking) {
  if (!session || !booking) return false;
  const bid = booking.id || booking.bookingId;
  const normalizedBid = normalizeBookingId(bid);
  const sessionAccount = String(session.customerAccountId || '').trim();
  const bookingAccount = String(booking.customerAccountId || '').trim();

  if (sessionAccount && bookingAccount && sessionAccount !== bookingAccount) return false;
  if (sessionAccount && bookingAccount && sessionAccount === bookingAccount) return true;

  if (session.bookingIds && session.bookingIds.some((x) => normalizeBookingId(x) === normalizedBid)) {
    return true;
  }

  if (bookingAccount && sessionAccount !== bookingAccount) return false;
  return sessionContactAllows(session, booking);
}

module.exports = {
  normalizeBookingId,
  authorizeBookingAccess,
  sessionBookingAllowed,
  sessionContactAllows,
  publicLimitedLookupMiss,
  LIMITED_LOOKUP_MISS,
  AUTH_FAIL,
  NOT_FOUND,
};
