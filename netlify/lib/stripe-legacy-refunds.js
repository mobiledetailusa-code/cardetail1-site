'use strict';

/**
 * Administrative refunds of historical Stripe payments.
 *
 * Closed unless STRIPE_LEGACY_REFUNDS_ENABLED is exactly the string "true".
 * Absence, "false", "TRUE", "1", and any other value stay closed.
 *
 * This flag does not open customer payments, PaymentIntents, saved cards,
 * Payment Links, no-show charges, or subscriptions. Those stay behind
 * STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED and the existing tombstones.
 *
 * Inbound signed refund webhooks are confirmation of a refund Stripe already
 * accepted. They are not gated here, so a refund issued while the flag was
 * on can still settle the ledger after the flag is turned off.
 */

const FLAG = 'STRIPE_LEGACY_REFUNDS_ENABLED';
const EXPLICIT_ENABLE = 'true';

function legacyStripeRefundsEnabled(env = process.env) {
  if (!env || typeof env[FLAG] !== 'string') return false;
  return env[FLAG] === EXPLICIT_ENABLE;
}

function legacyStripeRefundsDisabledResult() {
  return {
    ok: false,
    error: 'legacy_stripe_refunds_disabled',
    statusCode: 403,
    stripeCalled: false,
    refunded: false,
  };
}

/**
 * A Stripe refund may target only a Stripe PaymentIntent. Square and any
 * other provider are refused even when legacy refunds are explicitly enabled.
 * Historical rows with no provider value remain Stripe, which is the schema default.
 */
function stripeRefundAttemptEligible(attempt) {
  if (!attempt || typeof attempt !== 'object') return false;
  const provider = String(attempt.provider || 'stripe').trim().toLowerCase();
  if (provider !== 'stripe') return false;
  return String(attempt.providerObjectId || '').startsWith('pi_');
}

module.exports = {
  FLAG,
  EXPLICIT_ENABLE,
  legacyStripeRefundsEnabled,
  legacyStripeRefundsDisabledResult,
  stripeRefundAttemptEligible,
};
