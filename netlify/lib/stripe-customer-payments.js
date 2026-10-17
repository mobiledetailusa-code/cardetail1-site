'use strict';

/**
 * Customer-facing Stripe availability.
 *
 * Production opens only when three independent facts are all true:
 *   1. the baked deploy identity is production and matches the runtime context
 *   2. the baked snapshot boolean STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED === true
 *   3. the runtime env string is exactly "true"
 *
 * The bake is written by scripts/generate-deploy-runtime-env.js. A missing or
 * non-boolean bake is false. A missing or non-exact runtime value is false.
 * Runtime true cannot override a false bake, and a true bake cannot override a
 * false runtime. Preview baked against production runtime, or the reverse,
 * stays closed. The browser, query, body, Host, and cookies are not inputs.
 *
 * Re-enabling later requires the production variable in both the Builds and
 * Functions scopes, then a new approved deploy so the bake and the runtime
 * are true together. This module does not set that variable.
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

const PREVIEW_CONTEXTS = new Set(['deploy-preview', 'branch-deploy']);

/** Controlled sandbox bake. Tests opt in; the committed snapshot stays false. */
const SANDBOX_BAKE = Object.freeze({
  CONTEXT: 'production',
  BRANCH: 'master',
  URL: 'https://cardetail1.com',
  DEPLOY_URL: 'https://cardetail1.com',
  DEPLOY_PRIME_URL: 'https://cardetail1.com',
  DEPLOY_ID: 'sandbox',
  REVIEW_ID: '',
  SITE_NAME: 'cardetail1',
  [FLAG]: true,
});

let bakedOverride;

function setBakedCustomerPaymentsSnapshot(snapshot) {
  bakedOverride = snapshot;
}

function clearBakedCustomerPaymentsSnapshot() {
  bakedOverride = undefined;
}

function loadBakedSnapshot() {
  if (bakedOverride !== undefined) return bakedOverride;
  try {
    return require('./deploy-runtime-env.generated');
  } catch {
    return null;
  }
}

function bakedContext(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return '';
  return String(snapshot.CONTEXT || '').trim().toLowerCase();
}

function explicitProductionEnable(env) {
  if (!env || typeof env[FLAG] !== 'string') return false;
  return env[FLAG] === EXPLICIT_ENABLE;
}

function closedPolicy(reason, ctx) {
  return {
    enabled: false,
    error: 'customer_payments_unavailable',
    reason,
    context: ctx.context,
    productionClosed: ctx.isProduction === true || bakedContext(loadBakedSnapshot()) === 'production',
  };
}

function customerPaymentsPolicy(env = process.env) {
  const source = env && typeof env === 'object' ? env : process.env;
  const ctx = deploymentContext(source);
  const snapshot = loadBakedSnapshot();
  const bakedCtx = bakedContext(snapshot);
  const runtimeCtx = String(ctx.context || '').trim().toLowerCase();
  const runtimeOn = explicitProductionEnable(source);

  if (bakedCtx && runtimeCtx && bakedCtx !== runtimeCtx) {
    return closedPolicy('identity_mismatch', ctx);
  }

  if (ctx.isPreview || PREVIEW_CONTEXTS.has(bakedCtx)) {
    return closedPolicy('preview_isolated', ctx);
  }

  if (!ctx.isProduction) {
    return closedPolicy('non_production', ctx);
  }

  if (bakedCtx !== 'production') {
    return closedPolicy('baked_identity_absent', ctx);
  }

  if (!snapshot || snapshot[FLAG] !== true) {
    const rawBaked = snapshot ? snapshot[FLAG] : undefined;
    if (rawBaked == null || rawBaked === false) return closedPolicy('baked_false', ctx);
    return closedPolicy('flag_invalid', ctx);
  }

  if (!runtimeOn) {
    const raw = source[FLAG];
    return closedPolicy(raw == null || raw === '' ? 'flag_absent' : 'flag_invalid', ctx);
  }

  return {
    enabled: true,
    error: null,
    reason: 'explicit_flag',
    context: ctx.context,
  };
}

/**
 * Block customer Stripe routes when either side claims production and the
 * dual gate is not fully open. Local and preview deploys with no production
 * bake stay unblocked so isolated test-mode suites can still run.
 */
function productionCustomerPaymentsBlocked(env = process.env) {
  const policy = customerPaymentsPolicy(env);
  if (policy.enabled === true) return false;
  const source = env && typeof env === 'object' ? env : process.env;
  const ctx = deploymentContext(source);
  return ctx.isProduction === true || bakedContext(loadBakedSnapshot()) === 'production';
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
  SANDBOX_BAKE,
  customerPaymentsPolicy,
  productionCustomerPaymentsBlocked,
  explicitProductionEnable,
  isOnlineCardPreference,
  refusal,
  annotateAdminPaymentHandling,
  setBakedCustomerPaymentsSnapshot,
  clearBakedCustomerPaymentsSnapshot,
  loadBakedSnapshot,
};
