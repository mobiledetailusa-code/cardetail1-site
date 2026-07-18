/**
 * Phase 3 — webhook signature verification + dispatch on top of the
 * Postgres-backed payment-authority-service. Not wired into
 * netlify/functions/stripe-webhook.js (Blob-authoritative, live) — this is
 * the parallel, additive path for the new relational foundation, built and
 * tested standalone per the Phase 3 gate scope.
 *
 * Signature algorithm mirrors netlify/functions/stripe-webhook.js exactly
 * (HMAC-SHA256 over `${timestamp}.${rawBody}`, 300s tolerance, timing-safe
 * compare) so behavior is identical without importing a Netlify function
 * file from a lib module.
 */

const crypto = require('crypto');
const { reconcilePaymentIntentEvent } = require('./payment-authority-service');

function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const parts = {};
  sigHeader.split(',').forEach((kv) => {
    const [k, v] = kv.split('=');
    parts[k] = v;
  });
  if (!parts.t || !parts.v1) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(parts.t));
  if (age > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`, 'utf8').digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Handle one raw webhook delivery: verify signature, parse, dispatch.
 * Returns a plain result object — callers decide the HTTP status. Rejects
 * (ok:false, reason:'bad_signature') before touching the database at all
 * on signature failure.
 */
async function handleWebhookDelivery({ rawBody, sigHeader, secret }) {
  if (!verifyStripeSignature(rawBody, sigHeader, secret)) {
    return { ok: false, statusCode: 400, error: 'bad_signature' };
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { ok: false, statusCode: 400, error: 'invalid_json' };
  }

  const stripeEventId = event.id;
  const type = event.type;
  const obj = event.data?.object;
  if (!stripeEventId || !type || !obj) {
    return { ok: false, statusCode: 400, error: 'malformed_event' };
  }

  if (type.startsWith('payment_intent.')) {
    const result = await reconcilePaymentIntentEvent({ stripeEventId, type, paymentIntent: obj });
    return { ok: true, statusCode: 200, dispatched: 'payment_intent', result };
  }

  // Unrecognized event types are acknowledged (200), not treated as errors —
  // Stripe retries on non-2xx, and an unhandled type isn't a delivery failure.
  return { ok: true, statusCode: 200, dispatched: 'ignored', type };
}

module.exports = { verifyStripeSignature, handleWebhookDelivery };
