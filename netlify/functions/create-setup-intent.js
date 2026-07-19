// netlify/functions/create-setup-intent.js
// Creates a Stripe Customer + SetupIntent for card-on-file saving.
// No charge is applied. The card is stored by Stripe and may only be
// charged later by admin, according to the posted cancellation/no-show policy.
//
// Security:
//   - bookingId + draftSaveToken required; draft is fetched from Blobs.
//   - client_secret is returned — standard Stripe SDK flow (single-use, expires).
//   - Raw Stripe errors are never forwarded to the client.
//
// Env: STRIPE_SECRET_KEY, DRAFT_TOKEN_SECRET

const { enforcePublicRateLimit } = require('../lib/public-rate-limit');
const {
  verifyDraftSaveToken,
  getDraftTokenSecretStatus,
} = require('../lib/draft-save-token');
const { validateBookingRouting } = require('../lib/booking-routing-validation');

let blobsStoreOverride = null;

async function blobsStore(name) {
  if (typeof blobsStoreOverride === 'function') {
    return blobsStoreOverride(name);
  }
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token) ? getStore({ name, siteID, token }) : getStore(name);
}

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const json = (status, body) => ({ statusCode: status, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  console.log('[create-setup-intent] called: yes');
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });

  const rateLimit = await enforcePublicRateLimit(event, {
    endpoint: 'create-setup-intent',
    cors: true,
  });
  if (rateLimit.blocked) return rateLimit.response;

  const secretStatus = getDraftTokenSecretStatus();
  if (!secretStatus.ok) {
    return json(503, { ok: false, error: 'missing_draft_token_secret' });
  }

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'invalid_json' }); }

  const bookingId = String(p.bookingId || '').replace(/[^A-Za-z0-9\-]/g, '').slice(0, 48);
  const draftSaveToken = String(p.draftSaveToken || '').trim();
  if (!bookingId || !draftSaveToken) {
    return json(403, { ok: false, error: 'invalid_draft_token' });
  }

  let booking, store;
  try {
    store = await blobsStore('cd1-bookings');
    booking = await store.get(bookingId, { type: 'json' });
  } catch (e) {
    console.error('[create-setup-intent] store unavailable:', e.message);
    return json(503, { ok: false, error: 'booking_store_unavailable', fallback: true });
  }

  if (!booking) {
    return json(403, { ok: false, error: 'invalid_draft_token' });
  }

  const tokenCheck = verifyDraftSaveToken({
    token: draftSaveToken,
    bookingId,
    phone: booking.phone || booking.customerPhone,
  });
  if (!tokenCheck.ok) {
    return json(403, { ok: false, error: 'invalid_draft_token' });
  }

  console.log('[create-setup-intent] booking found:', !!booking);
  if (!booking.isDraft || booking.cardOnFileRequired !== true || booking.cardOnFileStatus !== 'pending') {
    console.log('[create-setup-intent] booking not eligible: isDraft=%s status=%s', booking.isDraft, booking.cardOnFileStatus);
    return json(409, { ok: false, error: 'booking_not_eligible_for_card_save' });
  }

  const routingCheck = validateBookingRouting(booking);
  if (!routingCheck.ok) {
    return json(403, { ok: false, error: routingCheck.error });
  }

  const { guardStripeOrReject } = require('../lib/stripe-mode');
  const stripeGuard = guardStripeOrReject(process.env, { purpose: 'setup_intent' });
  if (stripeGuard.blocked) {
    console.log('[create-setup-intent] blocked by stripe-mode guard:', stripeGuard.body?.error);
    return json(stripeGuard.statusCode || 503, {
      ...stripeGuard.body,
      fallback: stripeGuard.body?.error === 'stripe_not_configured',
    });
  }
  const secret = stripeGuard.secret;
  const mode = stripeGuard.mode;

  console.log('[create-setup-intent] bookingId present:', !!bookingId, '| mode:', mode);

  const stripeHeaders = {
    Authorization: `Bearer ${secret}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  // ── Create Stripe Customer ─────────────────────────────────────────────────
  const custForm = new URLSearchParams();
  const email = String(booking.email || '');
  if (email.includes('@')) custForm.append('email', email.slice(0, 120));
  const name = [booking.firstName, booking.lastName].filter(Boolean).join(' ').trim();
  if (name) custForm.append('name', name.slice(0, 120));
  custForm.append('metadata[booking_id]', bookingId);

  const custRes = await fetch('https://api.stripe.com/v1/customers', {
    method: 'POST',
    headers: stripeHeaders,
    body: custForm,
  });
  if (!custRes.ok) {
    console.error('[create-setup-intent] customer creation failed: HTTP', custRes.status);
    return json(502, { ok: false, error: 'card_save_unavailable', fallback: true });
  }
  const cust = await custRes.json().catch(() => ({}));
  console.log('[create-setup-intent] stripe customer created: yes');

  // ── Create SetupIntent (off_session = card can be used for future charges) ──
  const siForm = new URLSearchParams({
    customer:                           cust.id,
    usage:                              'off_session',
    'payment_method_types[0]':          'card',
    'metadata[bookingId]':              bookingId,
  });

  const siRes = await fetch('https://api.stripe.com/v1/setup_intents', {
    method: 'POST',
    headers: stripeHeaders,
    body: siForm,
  });
  if (!siRes.ok) {
    console.error('[create-setup-intent] SetupIntent creation failed: HTTP', siRes.status);
    return json(502, { ok: false, error: 'card_save_unavailable', fallback: true });
  }
  const si = await siRes.json().catch(() => ({}));
  if (!si.client_secret) {
    console.error('[create-setup-intent] SetupIntent missing client_secret');
    return json(502, { ok: false, error: 'card_save_unavailable', fallback: true });
  }
  console.log('[create-setup-intent] SetupIntent created: yes | id prefix:', si.id ? si.id.slice(0, 15) : 'none', '| mode:', mode);

  // Persist SetupIntent on the draft without dropping unrelated draft fields.
  try {
    const nextDraft = {
      ...booking,
      setupIntentId: si.id,
      stripeCustomerId: cust.id,
      // Keep prior payment-method / saved markers if webhook already applied.
      stripePaymentMethodId: booking.stripePaymentMethodId,
      cardOnFileStatus: booking.cardOnFileStatus || 'pending',
      isDraft: true,
      updatedAt: new Date().toISOString(),
    };
    await store.setJSON(bookingId, nextDraft);
    console.log('[create-setup-intent] draft updated', {
      draftBookingId: bookingId,
      setupIntentIdPrefix: si.id ? String(si.id).slice(0, 15) : 'none',
      cardOnFileStatus: nextDraft.cardOnFileStatus,
    });
  } catch (e) {
    console.warn('[create-setup-intent] could not update draft with setupIntentId:', e.message);
  }

  console.log('[create-setup-intent] clientSecret returned to browser: yes');
  return json(200, {
    ok: true,
    clientSecret: si.client_secret,
    mode,
    bookingId,
  });
};

exports.__test = {
  setBlobsStoreOverride(fn) {
    blobsStoreOverride = typeof fn === 'function' ? fn : null;
  },
};
