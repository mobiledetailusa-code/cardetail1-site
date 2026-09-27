'use strict';

/**
 * On-session Ceramic Coating PaymentIntent.
 *
 * The amount is chargeDueNow (prepay or deposit) or the exact remaining
 * balance. Browser amounts are rejected when they disagree. This endpoint
 * does not confirm the PaymentIntent and does not charge a saved card
 * off-session.
 */

const { authorizeBookingAccess, normalizeBookingId } = require('../lib/booking-customer-auth');
const { enforcePublicRateLimit } = require('../lib/public-rate-limit');
const { postgresPaymentEnabled } = require('../lib/db/operational-payment');
const { ensureBookingFinancial } = require('../lib/db/ensure-booking-financial');
const { ceramicIntentSpec } = require('../lib/ceramic-payment');

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
    endpoint: 'ceramic-checkout-intent',
    cors: false,
  });
  if (rateLimit.blocked) return rateLimit.response;

  if (!postgresPaymentEnabled()) {
    return json(503, {
      ok: false,
      error: 'postgres_payment_disabled',
      message: 'Ceramic card checkout requires the Postgres payment foundation.',
    });
  }

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'validation_error' }); }

  const bookingId = normalizeBookingId(p.bookingId);
  if (!bookingId) return json(400, { ok: false, error: 'validation_error' });

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
  if (!booking || booking.serviceFamily !== 'ceramic_coating') {
    return json(400, { ok: false, error: 'not_ceramic_booking' });
  }
  if (booking.isDraft) {
    return json(200, { ok: false, error: 'booking_not_ready' });
  }

  const phase = p.phase === 'balance' ? 'balance' : 'checkout';
  const expectedQuoteVersion = Math.round(Number(p.expectedQuoteVersion));
  const actualQuoteVersion = Math.round(Number(booking.quoteVersion) || 0);
  if (!Number.isFinite(expectedQuoteVersion) || expectedQuoteVersion !== actualQuoteVersion) {
    return json(409, {
      ok: false,
      error: 'stale_quote_version',
      actualQuoteVersion,
    });
  }

  const spec = ceramicIntentSpec(booking, {
    quoteVersion: actualQuoteVersion,
    phase,
  });
  if (!spec.ok) {
    return json(400, { ok: false, error: spec.error, message: 'Ceramic payment is not available for this booking.' });
  }
  if (p.amountCents != null && p.amountCents !== '' && Math.round(Number(p.amountCents) || 0) !== spec.amountCents) {
    return json(400, {
      ok: false,
      error: 'ceramic_charge_mismatch',
      amountCents: spec.amountCents,
    });
  }

  const ensured = await ensureBookingFinancial(booking);
  if (!ensured.ok) {
    return json(503, { ok: false, error: ensured.error || 'financial_foundation_unavailable' });
  }

  const { reserveCeramicPaymentIntent } = require('../lib/db/payment-authority-service');
  const created = await reserveCeramicPaymentIntent({
    booking,
    quoteVersion: actualQuoteVersion,
    phase,
    stripeCustomerId: booking.stripeCustomerId || null,
  });
  if (!created.ok) {
    return json(created.statusCode || 409, {
      ok: false,
      error: created.error,
      amountCents: spec.amountCents,
      purpose: spec.purpose,
    });
  }

  return json(200, {
    ok: true,
    mode: 'payment_element',
    clientSecret: created.clientSecret || null,
    paymentIntentId: created.stripePaymentIntentId || created.paymentAttempt?.providerObjectId || null,
    amountCents: spec.amountCents,
    purpose: spec.purpose,
    quoteVersion: actualQuoteVersion,
    approvedFinalAmount: booking.approvedFinalAmount,
    amountPaid: booking.amountPaid,
    balanceDue: booking.balanceDue,
    offSession: false,
    created: !!created.created,
  });
};
