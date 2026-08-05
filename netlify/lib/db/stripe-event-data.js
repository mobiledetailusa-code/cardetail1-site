'use strict';

/**
 * Stripe inbox data minimization boundary.
 *
 * The raw webhook is used only for signature verification and dispatch. The
 * database receives this small operational summary; nested customer, billing,
 * payment-method, charge, error-message and client_secret fields are discarded.
 */
function cleanText(value, max = 160) {
  const text = String(value == null ? '' : value).trim();
  return text ? text.slice(0, max) : null;
}

function integerOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function sanitizeStripeEventPayload(object = {}) {
  const metadata = object && typeof object.metadata === 'object' && object.metadata
    ? object.metadata
    : {};
  const amount = object.amount_received != null
    ? object.amount_received
    : object.amount;

  return {
    objectType: cleanText(object.object, 48),
    objectId: cleanText(object.id, 128),
    status: cleanText(object.status, 64),
    amountCents: integerOrNull(amount),
    currency: cleanText(object.currency, 12)?.toLowerCase() || null,
    purpose: cleanText(metadata.purpose, 64),
    bookingId: cleanText(metadata.bookingId || metadata.booking_id, 64),
    quoteVersion: integerOrNull(metadata.quoteVersion || metadata.quote_version),
    livemode: object.livemode === true,
  };
}

function sanitizeStripeErrorCode(value) {
  const code = String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_:-]/g, '_')
    .slice(0, 96);
  return code || 'processing_failed';
}

function stripeEventCreatedAt(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const date = new Date(Math.round(seconds * 1000));
  return Number.isNaN(date.getTime()) ? null : date;
}

module.exports = {
  sanitizeStripeEventPayload,
  sanitizeStripeErrorCode,
  stripeEventCreatedAt,
};
