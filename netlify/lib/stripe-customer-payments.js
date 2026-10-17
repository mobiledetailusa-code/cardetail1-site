'use strict';

/**
 * Customer-facing Stripe availability.
 *
 * Production is fail-closed. The only future re-enable is the exact env string
 * STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED=true. Missing, empty, and any
 * other value stay disabled. Preview and branch deploys are not production, so
 * this flag cannot turn them into live charges; stripe-mode.js still forces
 * test keys there. The browser, query, body, Host, and cookies are not inputs.
 */

const { deploymentContext } = require('./stripe-mode');

const FLAG = 'STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED';
const EXPLICIT_ENABLE = 'true';

const CUSTOMER_BOOKING_COPY = 'Nothing is charged when you book. Pay by card or cash at your appointment. A secure invoice can be sent if needed.';
const GARAGE_COPY = 'Online payment is temporarily unavailable. Pay at your appointment or contact us for a secure invoice.';
const ADMIN_HANDLING = 'external_manual';
const ADMIN_HANDLING_LABEL = 'Payment will be handled externally / manually. The saved card preference stays on the appointment and is not reclassified as cash.';

const ONLINE_PREFERENCES = new Set([
  'online_after_service',
  'card_online',
  'card_on_file',
]);

function explicitProductionEnable(env) {
  if (!env || typeof env[FLAG] !== 'string') return false;
  return env[FLAG] === EXPLICIT_ENABLE;
}

function customerPaymentsPolicy(env = process.env) {
  const ctx = deploymentContext(env || process.env);
  const source = env || process.env;
  if (ctx.isProduction && explicitProductionEnable(source)) {
    return {
      enabled: true,
      error: null,
      reason: 'explicit_flag',
      context: ctx.context,
    };
  }
  let reason = 'non_production';
  if (ctx.isProduction) {
    const raw = source[FLAG];
    reason = raw == null || raw === '' ? 'flag_absent' : 'flag_invalid';
  } else if (ctx.isPreview) {
    reason = 'preview_isolated';
  }
  return {
    enabled: false,
    error: 'customer_payments_unavailable',
    reason,
    context: ctx.context,
    productionClosed: ctx.isProduction === true,
  };
}

/** True only for a production deploy whose explicit flag is not exactly "true". */
function productionCustomerPaymentsBlocked(env = process.env) {
  const ctx = deploymentContext(env || process.env);
  if (!ctx.isProduction) return false;
  return !explicitProductionEnable(env || process.env);
}

function isOnlineCardPreference(value) {
  return ONLINE_PREFERENCES.has(String(value || '').trim());
}

function refusal(extra = {}) {
  return {
    ok: false,
    error: 'customer_payments_unavailable',
    statusCode: 403,
    stripeCalled: false,
    ...extra,
  };
}

/**
 * Display-only annotation. Does not rewrite payment method, status, or money.
 * Returns null when the appointment is not an online-card preference.
 */
function annotateAdminPaymentHandling(booking, env = process.env) {
  if (!productionCustomerPaymentsBlocked(env)) return null;
  const pref = String((booking && (booking.paymentMethodPreference || booking.paymentMethod)) || '').trim();
  if (!isOnlineCardPreference(pref)) return null;
  return {
    customerPaymentHandling: ADMIN_HANDLING,
    customerPaymentHandlingLabel: ADMIN_HANDLING_LABEL,
  };
}

module.exports = {
  FLAG,
  EXPLICIT_ENABLE,
  CUSTOMER_BOOKING_COPY,
  GARAGE_COPY,
  ADMIN_HANDLING,
  ADMIN_HANDLING_LABEL,
  customerPaymentsPolicy,
  productionCustomerPaymentsBlocked,
  explicitProductionEnable,
  isOnlineCardPreference,
  refusal,
  annotateAdminPaymentHandling,
};
