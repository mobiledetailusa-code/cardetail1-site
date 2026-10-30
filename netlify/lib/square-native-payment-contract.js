'use strict';

/**
 * Phase S1 — Square-native payment preference contract (pure, inactive).
 *
 * Records how the customer intends to pay. It does not create, retrieve, confirm,
 * or settle any payment. An optional paymentReference is an opaque server-side
 * handle only; it is never proof of payment.
 *
 * Booking UI today uses cash_onsite, card_onsite, and online_after_service.
 * Admin policy also accepts cash_on_site and card_on_site. This module models
 * the Square-native scope: cash on-site, card on-site, and payment-link
 * requested (not online card-on-file). online_after_service is rejected here
 * until a later phase explicitly maps it.
 */

const CANONICAL_PREFERENCES = Object.freeze([
  'cash_onsite',
  'card_onsite',
  'payment_link_requested',
]);

const PREFERENCE_ALIASES = Object.freeze({
  cash_onsite: Object.freeze(['cash_onsite', 'cash_on_site']),
  card_onsite: Object.freeze(['card_onsite', 'card_on_site']),
  payment_link_requested: Object.freeze([
    'payment_link_requested',
    'payment_link',
    'request_payment_link',
  ]),
});

const ALIAS_TO_CANONICAL = Object.freeze(
  Object.fromEntries(
    CANONICAL_PREFERENCES.flatMap((canonical) =>
      PREFERENCE_ALIASES[canonical].map((alias) => [alias, canonical])
    )
  )
);

const PAYMENT_REFERENCE_MIN_LENGTH = 1;
const PAYMENT_REFERENCE_MAX_LENGTH = 128;
const PAYMENT_REFERENCE_PATTERN = /^[A-Za-z0-9._:-]+$/;

const FINANCIAL_AUTHORITY_KEYS = Object.freeze([
  'paid',
  'financiallySettled',
  'settlementCommitted',
  'paymentStatus',
  'providerPaymentId',
  'settlementId',
  'evidenceId',
  'commitId',
  'financiallyAuthorized',
  'settlementAuthorized',
]);

const URL_LIKE_REFERENCE = /^(https?:\/\/|\/\/|javascript:)/i;

function normalizePreferenceToken(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function resolveCanonicalPreference(rawPreference) {
  const token = normalizePreferenceToken(rawPreference);
  if (!token) {
    return { ok: false, error: 'payment_preference_required' };
  }
  const canonical = ALIAS_TO_CANONICAL[token];
  if (!canonical) {
    return {
      ok: false,
      error: 'invalid_payment_preference',
      supportedPreferences: [...CANONICAL_PREFERENCES],
      supportedAliases: { ...PREFERENCE_ALIASES },
    };
  }
  return { ok: true, canonical, normalizedToken: token };
}

function validatePaymentReference(rawReference) {
  if (rawReference == null || rawReference === '') {
    return { ok: true, paymentReference: null };
  }
  if (typeof rawReference !== 'string') {
    return { ok: false, error: 'invalid_payment_reference', reason: 'type' };
  }
  const trimmed = rawReference.trim();
  if (trimmed.length < PAYMENT_REFERENCE_MIN_LENGTH) {
    return { ok: false, error: 'invalid_payment_reference', reason: 'empty' };
  }
  if (trimmed.length > PAYMENT_REFERENCE_MAX_LENGTH) {
    return { ok: false, error: 'invalid_payment_reference', reason: 'length' };
  }
  if (URL_LIKE_REFERENCE.test(trimmed) || trimmed.includes('://')) {
    return { ok: false, error: 'invalid_payment_reference', reason: 'url_like' };
  }
  if (!PAYMENT_REFERENCE_PATTERN.test(trimmed)) {
    return { ok: false, error: 'invalid_payment_reference', reason: 'charset' };
  }
  return { ok: true, paymentReference: trimmed };
}

function readPreferenceInput(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return '';
  }
  if (typeof input.paymentMethodPreference === 'string') return input.paymentMethodPreference;
  if (typeof input.preference === 'string') return input.preference;
  if (typeof input.method === 'string') return input.method;
  return '';
}

function readReferenceInput(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(input, 'paymentReference')) return undefined;
  return input.paymentReference;
}

/**
 * Normalize a booking payment preference for the Square-native path.
 * Always returns paid: false. Never performs I/O.
 *
 * @param {object|string} input — preference string or { paymentMethodPreference, paymentReference? }
 * @returns {object}
 */
function resolveSquareNativePaymentContract(input) {
  const rawPreference = typeof input === 'string' ? input : readPreferenceInput(input);
  const preferenceResult = resolveCanonicalPreference(rawPreference);
  if (!preferenceResult.ok) {
    return { ok: false, ...preferenceResult };
  }

  const rawReference = typeof input === 'string' ? undefined : readReferenceInput(input);
  const referenceResult = validatePaymentReference(rawReference);
  if (!referenceResult.ok) {
    return { ok: false, ...referenceResult };
  }

  return {
    ok: true,
    preference: preferenceResult.canonical,
    paymentMethodPreference: preferenceResult.canonical,
    paymentReference: referenceResult.paymentReference,
    paid: false,
    financiallySettled: false,
    providerCalled: false,
    paymentLinkRequested: preferenceResult.canonical === 'payment_link_requested',
    createsPayment: false,
    createsPaymentLink: false,
  };
}

module.exports = {
  CANONICAL_PREFERENCES,
  PREFERENCE_ALIASES,
  PAYMENT_REFERENCE_MAX_LENGTH,
  FINANCIAL_AUTHORITY_KEYS,
  normalizePreferenceToken,
  resolveCanonicalPreference,
  validatePaymentReference,
  resolveSquareNativePaymentContract,
};
