// Returns card-on-file state only after verified authorization.
// Auth: draft token, booking+phone, customer session, or admin key.

const { jsonCors, blobsStore } = require('../lib/tech-security');
const { getBooking } = require('../lib/ops-db');
const { authorizeBookingAccess, normalizeBookingId } = require('../lib/booking-customer-auth');
const { verifyDraftSaveToken } = require('../lib/draft-save-token');
const { normalizeUsPhoneDigits } = require('../lib/phone-auth');
const { validateCustomerSession } = require('../lib/customer-session');
const { enforcePublicRateLimit } = require('../lib/public-rate-limit');
const { verifyAdminRequest } = require('../lib/admin-security');

const SAFE_STATUSES = new Set(['pending', 'saved', 'failed']);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') {
    return jsonCors(405, { ok: false, error: 'method_not_allowed' });
  }

  const rateLimit = await enforcePublicRateLimit(event, { endpoint: 'booking-card-status', cors: true });
  if (rateLimit.blocked) return rateLimit.response;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'validation_error' }); }

  const bookingId = normalizeBookingId(body.bookingId);
  if (!bookingId) return jsonCors(400, { ok: false, error: 'validation_error' });

  const admin = await verifyAdminRequest(event.headers || {});
  let authorized = admin.ok;

  if (!authorized) {
    const session = await validateCustomerSession(event);
    if (session.ok) {
      const booking = await getBooking(bookingId);
      if (booking) {
        const auth = await authorizeBookingAccess(event, { bookingId, phone: body.phone });
        authorized = auth.ok;
      }
    }
  }

  if (!authorized && body.draftSaveToken) {
    const phone = normalizeUsPhoneDigits(body.phone || body.customerPhone || '');
    const draft = verifyDraftSaveToken({
      token: body.draftSaveToken,
      bookingId,
      phone,
    });
    if (draft.ok) authorized = true;
  }

  if (!authorized) {
    const auth = await authorizeBookingAccess(event, { bookingId, phone: body.phone || body.customerPhone });
    authorized = auth.ok;
  }

  if (!authorized) {
    return jsonCors(200, { ok: false, error: 'authentication_failed' });
  }

  try {
    const booking = await getBooking(bookingId);
    if (!booking) return jsonCors(200, { ok: false, error: 'booking_not_found' });
    const status = SAFE_STATUSES.has(booking.cardOnFileStatus) ? booking.cardOnFileStatus : 'pending';
    return jsonCors(200, { ok: true, cardOnFileStatus: status });
  } catch {
    return jsonCors(503, { ok: false, error: 'status_unavailable' });
  }
};
