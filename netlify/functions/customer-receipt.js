/**
 * Customer receipt endpoint.
 *
 * Authorization reuses the established booking ownership authority
 * (authorizeBookingAccess): a valid account session scoped to the booking, or
 * bookingId + the phone on file. A booking id alone is never sufficient, and no
 * new token system is introduced.
 *
 * The response is an explicit allowlist built from the approved PostgreSQL
 * quote version and ledger. Client secrets, portal tokens, raw rows and Admin
 * notes are never returned.
 */

const { jsonCors } = require('../lib/tech-security');
const { authorizeBookingAccess } = require('../lib/booking-customer-auth');
const { enforcePublicRateLimit } = require('../lib/public-rate-limit');
const { isVisibleSubmittedBooking } = require('../lib/booking-visibility');
const { buildReceiptProjection, receiptEligibility } = require('../lib/receipt-projection');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') return jsonCors(405, { ok: false, error: 'method_not_allowed' });

  const rateLimit = await enforcePublicRateLimit(event, { endpoint: 'customer-receipt', cors: true });
  if (rateLimit.blocked) return rateLimit.response;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'validation_error', message: 'Malformed request.' }); }

  const receiptType = String(body.receiptType || body.type || '').toLowerCase();
  if (receiptType !== 'payment' && receiptType !== 'final') {
    return jsonCors(400, { ok: false, error: 'invalid_receipt_type', message: 'Unknown receipt type.' });
  }

  const auth = await authorizeBookingAccess(event, {
    bookingId: body.bookingId,
    phone: body.phone || body.customerPhone,
  });
  if (!auth.ok) {
    // Mirrors the portal's established denial shapes: 400 validation, 401 session
    // required, 403 cross-account, safe 200 for not-found / phone mismatch.
    return jsonCors(auth.statusCode || 200, {
      ok: false,
      error: auth.error || 'authentication_failed',
      message: auth.message,
    });
  }

  if (!isVisibleSubmittedBooking(auth.booking)) {
    return jsonCors(200, {
      ok: false,
      error: 'booking_not_ready',
      message: 'This booking is not available in My Garage yet.',
    });
  }

  try {
    const { postgresPaymentEnabled } = require('../lib/db/operational-payment');
    const { ensureBookingFinancial } = require('../lib/db/ensure-booking-financial');
    const { getReceiptAuthorityData } = require('../lib/db/payment-authority-service');
    if (!postgresPaymentEnabled()) {
      return jsonCors(503, {
        ok: false,
        error: 'financial_authority_unavailable',
        message: 'Receipt could not be verified against the payment ledger.',
      });
    }
    const ensured = await ensureBookingFinancial(auth.booking);
    if (!ensured.ok) {
      return jsonCors(503, {
        ok: false,
        error: 'financial_authority_unavailable',
        message: 'Receipt could not be verified against the payment ledger.',
      });
    }
    const authority = await getReceiptAuthorityData(ensured.bookingId);
    if (!authority) {
      return jsonCors(503, {
        ok: false,
        error: 'financial_authority_unavailable',
        message: 'Receipt could not be verified against the payment ledger.',
      });
    }
    const result = buildReceiptProjection(auth.booking, receiptType, authority);
    if (!result.ok) {
      return jsonCors(result.statusCode || 200, {
        ok: false,
        error: result.error,
        message: result.message,
      });
    }
    return jsonCors(200, { ok: true, receipt: result.receipt });
  } catch (err) {
    // Never leak stack traces or storage details to a customer.
    console.error('[customer-receipt] projection_failed', {
      bookingId: String(body.bookingId || '').slice(0, 48),
      receiptType,
      message: err && err.message ? String(err.message).slice(0, 200) : 'unknown',
    });
    return jsonCors(500, { ok: false, error: 'receipt_unavailable', message: 'Receipt could not be generated.' });
  }
};

/**
 * Availability probe for My Garage, so the portal can show a receipt action only
 * when the server says the receipt exists. Same ownership authority.
 */
exports.availability = async (event) => {
  const auth = await authorizeBookingAccess(event, {
    bookingId: (event && event.bookingId) || '',
  });
  if (!auth.ok) return { payment: false, final: false };
  try {
    const { postgresPaymentEnabled } = require('../lib/db/operational-payment');
    const { ensureBookingFinancial } = require('../lib/db/ensure-booking-financial');
    const { getReceiptAuthorityData } = require('../lib/db/payment-authority-service');
    if (!postgresPaymentEnabled()) return { payment: false, final: false };
    const ensured = await ensureBookingFinancial(auth.booking);
    if (!ensured.ok) return { payment: false, final: false };
    const authority = await getReceiptAuthorityData(ensured.bookingId);
    if (!authority) return { payment: false, final: false };
    const el = receiptEligibility(auth.booking, authority);
    return { payment: el.payment, final: el.final };
  } catch {
    return { payment: false, final: false };
  }
};
