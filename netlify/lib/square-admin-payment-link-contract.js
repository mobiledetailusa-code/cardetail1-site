'use strict';

/**
 * Inactive preparation of a future Square Checkout payment-link request.
 *
 * This module does not call Square, does not create a link, and does not
 * write a booking. Validating these arguments is not proof that the caller
 * is a trusted server. The future admin integration must supply booking id,
 * amount, currency, and location from server-owned records.
 *
 * Request model: CreatePaymentLink, POST /v2/online-checkout/payment-links,
 * using an Order rather than quick_pay. quick_pay has no order reference_id,
 * so it cannot carry the booking correlation. Order.reference_id is limited
 * here to 40 characters, the Orders API limit this contract enforces; confirm
 * that limit against current Square docs before any live call.
 *
 * Square-Version is the date already pinned for local Square calls,
 * 2026-09-16. This module does not send the header.
 */

const crypto = require('crypto');

const SQUARE_VERSION = '2026-09-16';
const SQUARE_PAYMENT_LINKS_PATH = '/v2/online-checkout/payment-links';
const ORDER_REFERENCE_MAX_LENGTH = 40;
const IDEMPOTENCY_KEY_LENGTH = 45;
const LINE_ITEM_NAME = 'Cardetail1 service balance';

const BOOKING_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const LOCATION_ID_PATTERN = /^[A-Za-z0-9]{1,40}$/;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,39}$/;

function failure(error) {
  return {
    ok: false,
    authoritative: false,
    paid: false,
    financiallySettled: false,
    providerCalled: false,
    createsPayment: false,
    createsPaymentLink: false,
    error,
  };
}

function readOwnData(input, key) {
  if (!Object.prototype.hasOwnProperty.call(input, key)) return { missing: true };
  const desc = Object.getOwnPropertyDescriptor(input, key);
  if (!desc || desc.get || desc.set) return { invalid: true, reason: 'unsupported_property_descriptor' };
  return { value: desc.value };
}

function idempotencyKey(parts) {
  const digest = crypto.createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
  return digest.slice(0, IDEMPOTENCY_KEY_LENGTH);
}

/**
 * Build a non-authoritative CreatePaymentLink body for a later server call.
 * The returned request is not transmitted.
 *
 * @param {object} input
 * @returns {object}
 */
function prepareAdministrativePaymentLinkRequest(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return failure('payment_link_input_invalid');
  }

  const booking = readOwnData(input, 'bookingId');
  if (booking.missing || booking.invalid || typeof booking.value !== 'string' || !BOOKING_ID_PATTERN.test(booking.value)) {
    return failure('booking_identity_invalid');
  }

  const amount = readOwnData(input, 'amountCents');
  if (amount.missing || amount.invalid || !Number.isSafeInteger(amount.value) || amount.value <= 0) {
    return failure('approved_amount_invalid');
  }

  const currencyField = readOwnData(input, 'currency');
  const currency = !currencyField.missing && !currencyField.invalid && typeof currencyField.value === 'string'
    ? currencyField.value.trim().toUpperCase()
    : '';
  if (currency !== 'USD') return failure('currency_invalid');

  const location = readOwnData(input, 'locationId');
  if (location.missing || location.invalid || typeof location.value !== 'string' || !LOCATION_ID_PATTERN.test(location.value)) {
    return failure('location_identity_invalid');
  }

  const correlation = readOwnData(input, 'correlationReference');
  if (
    correlation.missing
    || correlation.invalid
    || typeof correlation.value !== 'string'
    || correlation.value.length > ORDER_REFERENCE_MAX_LENGTH
    || !REFERENCE_PATTERN.test(correlation.value)
  ) {
    return failure('correlation_reference_invalid');
  }

  let supersedesPriorAmount = false;
  if (Object.prototype.hasOwnProperty.call(input, 'priorAmountCents')) {
    const prior = readOwnData(input, 'priorAmountCents');
    if (prior.invalid || !Number.isSafeInteger(prior.value) || prior.value <= 0) {
      return failure('prior_amount_invalid');
    }
    supersedesPriorAmount = prior.value !== amount.value;
  }

  const key = idempotencyKey([
    booking.value,
    String(amount.value),
    currency,
    location.value,
    correlation.value,
  ]);

  return {
    ok: true,
    authoritative: false,
    paid: false,
    financiallySettled: false,
    providerCalled: false,
    createsPayment: false,
    createsPaymentLink: false,
    supersedesPriorAmount,
    association: {
      bookingId: booking.value,
      amountCents: amount.value,
      currency,
      locationId: location.value,
      correlationReference: correlation.value,
      idempotencyKey: key,
    },
    squareRequest: {
      method: 'POST',
      path: SQUARE_PAYMENT_LINKS_PATH,
      squareVersion: SQUARE_VERSION,
      body: {
        idempotency_key: key,
        order: {
          location_id: location.value,
          reference_id: correlation.value,
          line_items: [
            {
              quantity: '1',
              name: LINE_ITEM_NAME,
              base_price_money: {
                amount: amount.value,
                currency,
              },
            },
          ],
        },
      },
    },
  };
}

module.exports = {
  IDEMPOTENCY_KEY_LENGTH,
  ORDER_REFERENCE_MAX_LENGTH,
  SQUARE_PAYMENT_LINKS_PATH,
  SQUARE_VERSION,
  prepareAdministrativePaymentLinkRequest,
};
