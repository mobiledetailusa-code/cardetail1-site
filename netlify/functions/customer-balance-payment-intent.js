/**
 * Customer My Garage — create/retrieve PaymentIntent + optional CustomerSession
 * for embedded Payment Element. Amount is always server-authoritative from
 * Postgres FinancialProjection.
 */

const { authorizeBookingAccess, normalizeBookingId } = require('../lib/booking-customer-auth');
const { canPayBalance } = require('../lib/appointment-status-policy');
const { enforcePublicRateLimit } = require('../lib/public-rate-limit');
const {
  postgresPaymentEnabled,
  prepareEmbeddedPayment,
  getSharedFinancialProjection,
} = require('../lib/db/operational-payment');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const json = (status, body) => ({ statusCode: status, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });

  const rateLimit = await enforcePublicRateLimit(event, {
    endpoint: 'customer-balance-payment-intent',
    cors: false,
  });
  if (rateLimit.blocked) return rateLimit.response;

  if (!postgresPaymentEnabled()) {
    return json(503, {
      ok: false,
      error: 'postgres_payment_disabled',
      message: 'Embedded payment requires the Postgres payment foundation.',
      fallback: 'checkout',
    });
  }

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'validation_error' }); }

  const bookingId = normalizeBookingId(p.bookingId);
  if (!bookingId) {
    return json(400, { ok: false, error: 'validation_error', message: 'Booking ID is required.' });
  }

  const auth = await authorizeBookingAccess(event, {
    bookingId,
    phone: p.phone || p.customerPhone,
  });
  if (!auth.ok) {
    return json(auth.statusCode || 401, {
      ok: false,
      error: auth.error || 'authentication_failed',
      message: auth.message,
    });
  }

  const booking = auth.booking;
  if (booking.isDraft) {
    return json(200, { ok: false, error: 'booking_not_ready', message: 'Finalize your booking request first.' });
  }

  const policy = canPayBalance(booking);
  if (!policy.ok) {
    const shared = await getSharedFinancialProjection(booking, { reconcileUncertain: true });
    if (shared.ok && shared.projection?.paymentStatus === 'paid') {
      return json(200, {
        ok: false,
        error: 'already_paid',
        projection: shared.projection,
        message: 'This invoice is already paid.',
      });
    }
    return json(200, {
      ok: false,
      error: policy.error || 'payment_not_due',
      message: 'No balance is due for this appointment.',
    });
  }

  const prepared = await prepareEmbeddedPayment({
    booking,
    expectedQuoteVersion: p.expectedQuoteVersion,
  });
  if (!prepared.ok) {
    return json(prepared.statusCode || 200, {
      ok: false,
      error: prepared.error,
      projection: prepared.projection || null,
      message: prepared.error === 'stale_quote_version'
        ? 'Your quote was updated. Refresh and try again.'
        : prepared.error === 'already_paid'
          ? 'This invoice is already paid.'
          : 'Payment is not available yet.',
    });
  }

  return json(200, {
    ok: true,
    mode: 'payment_element',
    clientSecret: prepared.clientSecret,
    customerSessionClientSecret: prepared.customerSessionClientSecret,
    paymentIntentId: prepared.paymentIntentId,
    amountCents: prepared.amountCents,
    quoteVersion: prepared.quoteVersion,
    bookingVersion: prepared.bookingVersion,
    projection: prepared.projection,
    created: prepared.created,
  });
};
