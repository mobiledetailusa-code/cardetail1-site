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

  const expectedBookingVersion = Math.round(Number(p.expectedBookingVersion));
  const actualBookingVersion = Math.round(Number(booking.bookingVersion) || 0);
  if (p.expectedBookingVersion == null || p.expectedBookingVersion === ''
    || !Number.isFinite(expectedBookingVersion)
    || expectedBookingVersion !== actualBookingVersion) {
    return json(409, {
      ok: false,
      error: 'version_conflict',
      expectedBookingVersion: Number.isFinite(expectedBookingVersion) ? expectedBookingVersion : null,
      actualBookingVersion,
      // Without this the portal falls through to "Payment is not available yet",
      // which reads as a hard block for what is a recoverable stale snapshot.
      message: 'Your appointment was updated. Refresh this page and try again.',
    });
  }

  const shared = await getSharedFinancialProjection(booking);
  if (!shared.ok || !shared.projection) {
    return json(503, {
      ok: false,
      error: shared.error || 'financial_projection_unavailable',
      message: 'Payment status is temporarily unavailable. Please retry.',
    });
  }
  const projection = shared.projection;
  const expectedQuoteVersion = Math.round(Number(p.expectedQuoteVersion));
  if (p.expectedQuoteVersion == null || p.expectedQuoteVersion === ''
    || !Number.isFinite(expectedQuoteVersion)
    || expectedQuoteVersion !== projection.quoteVersion) {
    return json(409, {
      ok: false,
      error: 'stale_quote_version',
      expectedQuoteVersion: Number.isFinite(expectedQuoteVersion) ? expectedQuoteVersion : null,
      actualQuoteVersion: projection.quoteVersion,
      projection,
      message: 'Your quote was updated. Refresh and try again.',
    });
  }
  const policy = canPayBalance({
    ...booking,
    paymentStatus: projection.paymentStatus,
    paymentWorkflowStatus: projection.paymentStatus === 'paid' ? 'payment_succeeded' : 'due',
    ledger: {
      approvedCents: projection.approvedCents,
      settledCents: projection.settledCents,
      creditedCents: 0,
    },
  });
  if (!policy.ok) {
    if (projection.paymentStatus === 'paid') {
      return json(200, {
        ok: false,
        error: 'already_paid',
        projection,
        message: 'This invoice is already paid.',
      });
    }
    return json(200, {
      ok: false,
      error: policy.error || 'payment_not_due',
      projection,
      message: 'No balance is due for this appointment.',
    });
  }

  const prepared = await prepareEmbeddedPayment({
    booking,
    expectedQuoteVersion,
  });
  if (!prepared.ok) {
    const prepareMessages = {
      stale_quote_version: 'Your quote was updated. Refresh and try again.',
      already_paid: 'This invoice is already paid.',
      zero_balance: 'No balance is due for this appointment.',
      payment_prepare_failed: 'Payment is temporarily unavailable. Please retry.',
      missing_client_secret: 'Payment is temporarily unavailable. Please retry.',
      postgres_payment_disabled: 'Payment is temporarily unavailable. Please retry.',
      not_found: 'Payment is not available for this appointment.',
    };
    return json(prepared.statusCode || 200, {
      ok: false,
      error: prepared.error,
      projection: prepared.projection || null,
      message: prepareMessages[prepared.error] || 'Payment is not available yet.',
    });
  }

  return json(200, {
    ok: true,
    mode: 'payment_element',
    clientSecret: prepared.clientSecret,
    customerSessionClientSecret: prepared.customerSessionClientSecret,
    amountCents: prepared.amountCents,
    quoteVersion: prepared.quoteVersion,
    bookingVersion: prepared.bookingVersion,
    projection: prepared.projection,
    created: prepared.created,
  });
};
