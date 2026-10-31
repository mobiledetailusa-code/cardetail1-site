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
 *
 * S2 integration note: do not call this module from the global booking submit
 * path. online_after_service and payment_link_requested are different intents;
 * payment-method-policy.js remains authoritative for existing booking behavior.
 *
 * Unusual objects: only own data properties with string values are read.
 * Inherited keys, accessors (get/set), and non-string own values are ignored
 * or rejected without invoking getters.
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

const PREFERENCE_FIELD_ORDER = Object.freeze([
  'paymentMethodPreference',
  'preference',
  'method',
]);

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

function contractFailure(fields) {
  return {
    ok: false,
    paid: false,
    financiallySettled: false,
    providerCalled: false,
    createsPayment: false,
    createsPaymentLink: false,
    ...fields,
  };
}

function normalizePreferenceToken(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function resolveCanonicalPreference(rawPreference) {
  const token = normalizePreferenceToken(rawPreference);
  if (!token) {
    return contractFailure({ error: 'payment_preference_required' });
  }
  const canonical = ALIAS_TO_CANONICAL[token];
  if (!canonical) {
    return contractFailure({
      error: 'invalid_payment_preference',
      supportedPreferences: [...CANONICAL_PREFERENCES],
      supportedAliases: { ...PREFERENCE_ALIASES },
    });
  }
  return { ok: true, canonical, normalizedToken: token };
}

function validatePaymentReference(rawReference) {
  if (rawReference == null || rawReference === '') {
    return { ok: true, paymentReference: null };
  }
  if (typeof rawReference !== 'string') {
    return contractFailure({ error: 'invalid_payment_reference', reason: 'type' });
  }
  const trimmed = rawReference.trim();
  if (trimmed.length < PAYMENT_REFERENCE_MIN_LENGTH) {
    return contractFailure({ error: 'invalid_payment_reference', reason: 'empty' });
  }
  if (trimmed.length > PAYMENT_REFERENCE_MAX_LENGTH) {
    return contractFailure({ error: 'invalid_payment_reference', reason: 'length' });
  }
  if (URL_LIKE_REFERENCE.test(trimmed) || trimmed.includes('://')) {
    return contractFailure({ error: 'invalid_payment_reference', reason: 'url_like' });
  }
  if (!PAYMENT_REFERENCE_PATTERN.test(trimmed)) {
    return contractFailure({ error: 'invalid_payment_reference', reason: 'charset' });
  }
  return { ok: true, paymentReference: trimmed };
}

function readOwnStringDataProperty(input, key) {
  if (!Object.prototype.hasOwnProperty.call(input, key)) {
    return { present: false };
  }
  const desc = Object.getOwnPropertyDescriptor(input, key);
  if (!desc || desc.get || desc.set) {
    return {
      present: true,
      invalid: true,
      error: 'invalid_contract_input',
      reason: 'unsupported_property_descriptor',
      field: key,
    };
  }
  if (typeof desc.value !== 'string') {
    return {
      present: true,
      invalid: true,
      error: 'invalid_contract_input',
      reason: 'invalid_property_type',
      field: key,
    };
  }
  return { present: true, value: desc.value };
}

function readPreferenceInput(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return contractFailure({ error: 'payment_preference_required' });
  }
  for (const key of PREFERENCE_FIELD_ORDER) {
    const field = readOwnStringDataProperty(input, key);
    if (field.invalid) {
      return contractFailure({
        error: field.error,
        reason: field.reason,
        field: field.field,
      });
    }
    if (field.present) {
      return { ok: true, rawPreference: field.value };
    }
  }
  return contractFailure({ error: 'payment_preference_required' });
}

function readReferenceInput(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: true, rawReference: undefined };
  }
  if (!Object.prototype.hasOwnProperty.call(input, 'paymentReference')) {
    return { ok: true, rawReference: undefined };
  }
  const field = readOwnStringDataProperty(input, 'paymentReference');
  if (field.invalid) {
    return contractFailure({
      error: field.error,
      reason: field.reason,
      field: field.field,
    });
  }
  return { ok: true, rawReference: field.value };
}

/**
 * Normalize a booking payment preference for the Square-native path.
 * Always returns paid: false on success. Never performs I/O.
 *
 * @param {object|string} input — preference string or { paymentMethodPreference, paymentReference? }
 * @returns {object}
 */
function resolveSquareNativePaymentContract(input) {
  let rawPreference;
  if (typeof input === 'string') {
    rawPreference = input;
  } else {
    const preferenceRead = readPreferenceInput(input);
    if (preferenceRead.ok !== true) {
      return preferenceRead;
    }
    rawPreference = preferenceRead.rawPreference;
  }

  const preferenceResult = resolveCanonicalPreference(rawPreference);
  if (preferenceResult.ok !== true) {
    return preferenceResult;
  }

  let rawReference;
  if (typeof input === 'string') {
    rawReference = undefined;
  } else {
    const referenceRead = readReferenceInput(input);
    if (referenceRead.ok !== true) {
      return referenceRead;
    }
    rawReference = referenceRead.rawReference;
  }

  const referenceResult = validatePaymentReference(rawReference);
  if (referenceResult.ok !== true) {
    return referenceResult;
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
