'use strict';

/**
 * Payment Provider Adapter — disabled foundation.
 *
 * This module is the boundary for a future external processor. It is not
 * imported by booking, My Garage, Quick Ops, Admin, the Stripe webhook, or
 * the historical refund path. It does not read or write PaymentAttempt,
 * LedgerEntry, StripeEvent, or RefundRequest, and it does not change the
 * database default of PaymentAttempt.provider, which remains "stripe".
 *
 * The only implementation in this phase is DisabledPaymentProvider. The
 * active selection is the constant "none": no external processor is active.
 * There is no environment variable, credential, or registry that can turn a
 * processor on from this module.
 *
 * Offline settlement stays on the existing ledger paths. The real identifiers
 * are cash and card_on_site. Customer preferences cash_onsite and card_onsite
 * are intentions, not collected money. external_manual is the existing admin
 * handling label when online card payment is closed. None of those are routed
 * through this adapter. An online preference is not a paid booking.
 */

const ACTIVE_PAYMENT_PROVIDER = 'none';
const HISTORICAL_PROVIDER_DEFAULT = 'stripe';
const DISABLED_ERROR = 'payment_provider_disabled';
const OFFLINE_ERROR = 'offline_settlement_outside_adapter';

const MONEY_MOVING_OPERATIONS = Object.freeze([
  'createPayment',
  'refundPayment',
  'saveCard',
  'chargeSavedCard',
  'createPaymentLink',
]);

const OPERATIONS = Object.freeze([
  'createPayment',
  'getPayment',
  'refundPayment',
  'saveCard',
  'chargeSavedCard',
  'createPaymentLink',
]);

const OFFLINE_SETTLEMENT_METHODS = Object.freeze(['cash', 'card_on_site']);
const OFFLINE_PREFERENCES = Object.freeze(['cash_onsite', 'card_onsite']);
const ONLINE_PREFERENCES = Object.freeze([
  'online_after_service',
  'card_online',
  'card_on_file',
]);
const MANUAL_HANDLING = 'external_manual';

function normalizeToken(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function readDeclaredMethod(input) {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.method === 'string') return input.method;
  if (typeof input.settlementMethod === 'string') return input.settlementMethod;
  if (typeof input.paymentMethod === 'string') return input.paymentMethod;
  if (typeof input.paymentMethodPreference === 'string') return input.paymentMethodPreference;
  return '';
}

function baseResult(operation, error, extra) {
  return {
    ok: false,
    error,
    statusCode: error === OFFLINE_ERROR ? 409 : 403,
    operation,
    provider: ACTIVE_PAYMENT_PROVIDER,
    providerCalled: false,
    externalCall: false,
    paid: false,
    created: false,
    ...extra,
  };
}

function classifySettlementMethod(method) {
  const token = normalizeToken(method);
  if (OFFLINE_SETTLEMENT_METHODS.includes(token)) {
    return { kind: 'offline_settlement', method: token, adapter: false, paid: false };
  }
  if (OFFLINE_PREFERENCES.includes(token)) {
    return { kind: 'offline_preference', method: token, adapter: false, paid: false };
  }
  if (token === MANUAL_HANDLING) {
    return { kind: 'manual_handling', method: token, adapter: false, paid: false };
  }
  if (ONLINE_PREFERENCES.includes(token)) {
    return { kind: 'online_preference', method: token, adapter: false, paid: false };
  }
  return { kind: 'unspecified', method: token, adapter: false, paid: false };
}

/**
 * Separate the provider already stored on a transaction from the provider
 * selected for a new operation. This phase does not write either value.
 *
 * historicalProvider describes an existing row. An empty value is reported as
 * the schema default "stripe" and is not persisted.
 * selectedProvider is the active selection for new operations. It is always
 * "none" here and is not the PaymentAttempt.provider column.
 * effectiveProvider is the processor responsible for an existing transaction
 * when one was supplied. A new operation with no historical row has no
 * processor, so its effective provider is "none".
 */
function describeProviderRoles(record = {}) {
  const source = record && typeof record === 'object' ? record : {};
  const explicit = source.historicalProvider != null
    ? source.historicalProvider
    : source.provider;
  const hasHistorical = explicit != null && String(explicit).trim() !== '';
  const historicalProvider = hasHistorical
    ? normalizeToken(explicit)
    : HISTORICAL_PROVIDER_DEFAULT;
  const hasTransaction = hasHistorical
    || (source.providerObjectId != null && String(source.providerObjectId).trim() !== '');
  return {
    historicalProvider,
    selectedProvider: ACTIVE_PAYMENT_PROVIDER,
    effectiveProvider: hasTransaction ? historicalProvider : ACTIVE_PAYMENT_PROVIDER,
  };
}

function refuseOperation(operation, input) {
  const classified = classifySettlementMethod(readDeclaredMethod(input));
  if (
    classified.kind === 'offline_settlement'
    || classified.kind === 'offline_preference'
    || classified.kind === 'manual_handling'
  ) {
    return baseResult(operation, OFFLINE_ERROR, { method: classified.method });
  }
  return baseResult(operation, DISABLED_ERROR, {
    method: classified.kind === 'online_preference' ? classified.method : undefined,
  });
}

class DisabledPaymentProvider {
  constructor() {
    this.id = ACTIVE_PAYMENT_PROVIDER;
  }

  createPayment(input) {
    return Promise.resolve(refuseOperation('createPayment', input));
  }

  getPayment(input) {
    return Promise.resolve(refuseOperation('getPayment', input));
  }

  refundPayment(input) {
    return Promise.resolve(refuseOperation('refundPayment', input));
  }

  saveCard(input) {
    return Promise.resolve(refuseOperation('saveCard', input));
  }

  chargeSavedCard(input) {
    return Promise.resolve(refuseOperation('chargeSavedCard', input));
  }

  createPaymentLink(input) {
    return Promise.resolve(refuseOperation('createPaymentLink', input));
  }
}

function getActivePaymentProvider() {
  return new DisabledPaymentProvider();
}

function activePaymentProviderId() {
  return ACTIVE_PAYMENT_PROVIDER;
}

module.exports = {
  ACTIVE_PAYMENT_PROVIDER,
  HISTORICAL_PROVIDER_DEFAULT,
  DISABLED_ERROR,
  OFFLINE_ERROR,
  MONEY_MOVING_OPERATIONS,
  OPERATIONS,
  OFFLINE_SETTLEMENT_METHODS,
  OFFLINE_PREFERENCES,
  ONLINE_PREFERENCES,
  MANUAL_HANDLING,
  DisabledPaymentProvider,
  getActivePaymentProvider,
  activePaymentProviderId,
  describeProviderRoles,
  classifySettlementMethod,
};
