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
const {
  commitBooking,
} = require('../lib/booking-repository');
const { buildNextAggregate } = require('../lib/booking-aggregate');

let blobsStoreOverride = null;
let previewTransactionGuardOverride = null;

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
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });

  const previewCheck = await (previewTransactionGuardOverride
    || require('../lib/owner-studio/preview-transaction-guard').checkPreviewTransactionRequest)(event);
  if (previewCheck.previewRequest) {
    if (!previewCheck.authorized) {
      return json(403, { ok: false, error: previewCheck.error || 'preview_request_denied' });
    }
    return json(403, {
      ok: false,
      error: 'preview_transactions_disabled',
      message: 'Preview mode does not allow bookings or payments.',
    });
  }

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

  // Authenticate ownership before exposing version state for this booking.
  const expectedBookingVersion = Math.round(Number(p.expectedBookingVersion));
  const actualBookingVersion = Math.round(Number(booking.bookingVersion) || 0);
  const idempotentRetry = !!booking.setupIntentId
    && Number.isFinite(expectedBookingVersion)
    && expectedBookingVersion + 1 === actualBookingVersion;
  if (p.expectedBookingVersion == null || p.expectedBookingVersion === ''
    || !Number.isFinite(expectedBookingVersion)
    || (expectedBookingVersion !== actualBookingVersion && !idempotentRetry)) {
    return json(409, {
      ok: false,
      error: 'version_conflict',
      expectedBookingVersion: Number.isFinite(expectedBookingVersion) ? expectedBookingVersion : null,
      actualBookingVersion,
    });
  }

  if (!booking.isDraft || booking.cardOnFileRequired !== true || booking.cardOnFileStatus !== 'pending') {
    return json(409, { ok: false, error: 'booking_not_eligible_for_card_save' });
  }
  if (booking.acceptedCardOnFilePolicy !== true) {
    return json(409, { ok: false, error: 'card_on_file_consent_required' });
  }
  // The timestamp is consent *evidence*; acceptedCardOnFilePolicy is the authority.
  // Drafts pre-registered before the stamp was recorded still carry explicit
  // consent, so derive and persist one instead of dead-ending the card save.
  const consentGrantedAt = booking.acceptedCardOnFilePolicyAt
    || booking.updatedAt
    || booking.createdAt
    || new Date().toISOString();

  const routingCheck = validateBookingRouting(booking);
  if (!routingCheck.ok) {
    return json(403, { ok: false, error: routingCheck.error });
  }

  const { guardStripeOrReject } = require('../lib/stripe-mode');
  const stripeGuard = guardStripeOrReject(process.env, { purpose: 'setup_intent' });
  if (stripeGuard.blocked) {
    return json(stripeGuard.statusCode || 503, {
      ...stripeGuard.body,
      fallback: stripeGuard.body?.error === 'stripe_not_configured',
    });
  }
  const secret = stripeGuard.secret;
  const mode = stripeGuard.mode;

  const stripeHeaders = {
    Authorization: `Bearer ${secret}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  // ── Create Stripe Customer ─────────────────────────────────────────────────
  const policyVersion = String(booking.policyVersion || 'card-on-file-policy-v1').slice(0, 64);
  const custForm = new URLSearchParams();
  const email = String(booking.email || '');
  if (email.includes('@')) custForm.append('email', email.slice(0, 120));
  const name = [booking.firstName, booking.lastName].filter(Boolean).join(' ').trim();
  if (name) custForm.append('name', name.slice(0, 120));
  custForm.append('metadata[booking_id]', bookingId);

  let customerId = String(booking.stripeCustomerId || '').trim();
  if (!/^cus_[A-Za-z0-9]+$/.test(customerId)) {
    const custRes = await fetch('https://api.stripe.com/v1/customers', {
      method: 'POST',
      headers: {
        ...stripeHeaders,
        'Idempotency-Key': `setup_customer_${bookingId}_${policyVersion}`,
      },
      body: custForm,
    });
    if (!custRes.ok) {
      return json(502, { ok: false, error: 'card_save_unavailable', fallback: true });
    }
    const customer = await custRes.json().catch(() => ({}));
    customerId = String(customer.id || '').trim();
  }
  if (!/^cus_[A-Za-z0-9]+$/.test(customerId)) {
    return json(502, { ok: false, error: 'card_save_unavailable', fallback: true });
  }

  // ── Create SetupIntent (off_session = card can be used for future charges) ──
  const siForm = new URLSearchParams({
    customer:                           customerId,
    usage:                              'off_session',
    'payment_method_types[0]':          'card',
    'metadata[bookingId]':              bookingId,
    'metadata[purpose]':                'card_on_file',
    'metadata[consent_version]':        policyVersion,
  });

  // Scope the idempotency key to the booking version this attempt is based on.
  // Same version → duplicate submits replay one SetupIntent (double-click safe).
  // Advanced version → a fresh, confirmable SetupIntent, instead of Stripe
  // replaying an already-terminal one and leaving the customer unable to retry.
  // An idempotent retry deliberately re-keys to the prior attempt's version so
  // Stripe returns the exact SetupIntent already recorded on the draft.
  const attemptVersion = idempotentRetry ? actualBookingVersion - 1 : actualBookingVersion;

  const siRes = await fetch('https://api.stripe.com/v1/setup_intents', {
    method: 'POST',
    headers: {
      ...stripeHeaders,
      'Idempotency-Key': `setup_intent_${bookingId}_${policyVersion}_v${attemptVersion}`,
    },
    body: siForm,
  });
  if (!siRes.ok) {
    return json(502, { ok: false, error: 'card_save_unavailable', fallback: true });
  }
  const si = await siRes.json().catch(() => ({}));
  if (!si.client_secret) {
    return json(502, { ok: false, error: 'card_save_unavailable', fallback: true });
  }
  if (!/^seti_[A-Za-z0-9]+$/.test(String(si.id || '')) || si.customer !== customerId) {
    return json(502, { ok: false, error: 'card_save_unavailable', fallback: true });
  }

  if (idempotentRetry && booking.setupIntentId === si.id) {
    return json(200, {
      ok: true,
      clientSecret: si.client_secret,
      mode,
      bookingId,
      bookingVersion: actualBookingVersion,
      reused: true,
    });
  }

  // Persist SetupIntent on the draft without dropping unrelated draft fields.
  try {
    const nextDraft = buildNextAggregate(booking, {
      setupIntentId: si.id,
      stripeCustomerId: customerId,
      cardOnFileConsentVersion: policyVersion,
      acceptedCardOnFilePolicyAt: consentGrantedAt,
      cardOnFileConsentGrantedAt: consentGrantedAt,
      // Keep prior payment-method / saved markers if webhook already applied.
      stripePaymentMethodId: booking.stripePaymentMethodId,
      cardOnFileStatus: booking.cardOnFileStatus || 'pending',
      isDraft: true,
      updatedAt: new Date().toISOString(),
    });
    const committed = await commitBooking({
      bookingId,
      expectedBookingVersion: actualBookingVersion,
      nextAggregate: nextDraft,
      storeOverride: store,
    });
    if (!committed.ok) {
      return json(409, {
        ok: false,
        error: 'version_conflict',
        expectedBookingVersion,
        actualBookingVersion: committed.actualBookingVersion,
      });
    }
  } catch (e) {
    return json(503, { ok: false, error: 'booking_store_unavailable', fallback: true });
  }

  return json(200, {
    ok: true,
    clientSecret: si.client_secret,
    mode,
    bookingId,
    bookingVersion: actualBookingVersion + 1,
  });
};

exports.__test = {
  setPreviewTransactionGuardOverride(fn) {
    previewTransactionGuardOverride = typeof fn === 'function' ? fn : null;
  },
  setBlobsStoreOverride(fn) {
    blobsStoreOverride = typeof fn === 'function' ? fn : null;
  },
};
