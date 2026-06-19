// netlify/functions/create-setup-intent.js
// Creates a Stripe Customer + SetupIntent for card-on-file saving.
// No charge is applied. The card is stored by Stripe and may only be
// charged later by admin, according to the posted cancellation/no-show policy.
//
// Security:
//   - bookingId is required; draft is fetched from Blobs (not client-supplied data).
//   - client_secret is returned — standard Stripe SDK flow (single-use, expires).
//   - Raw Stripe errors are never forwarded to the client.
//
// Env: STRIPE_SECRET_KEY

async function blobsStore(name) {
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

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret || !(secret.startsWith('sk_test_') || secret.startsWith('sk_live_'))) {
    console.log('[create-setup-intent] stripe key: not configured');
    return json(503, { ok: false, error: 'stripe_not_configured', fallback: true });
  }
  const mode = secret.startsWith('sk_test_') ? 'test' : 'live';
  const isDeployPreview =
    process.env.CONTEXT === 'deploy-preview' ||
    /^https:\/\/deploy-preview-\d+--/i.test(process.env.DEPLOY_PRIME_URL || '');
  if (isDeployPreview && mode !== 'test') {
    console.log('[create-setup-intent] blocked: deploy-preview requires test mode, got live key');
    return json(503, { ok: false, error: 'stripe_test_mode_required' });
  }

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'invalid_json' }); }

  const bookingId = String(p.bookingId || '').replace(/[^A-Za-z0-9\-]/g, '').slice(0, 48);
  console.log('[create-setup-intent] bookingId present:', !!bookingId, '| mode:', mode);
  if (!bookingId) return json(400, { ok: false, error: 'bookingId_required' });

  // Fetch the pre-registered draft booking.
  let booking, store;
  try {
    store = await blobsStore('cd1-bookings');
    booking = await store.get(bookingId, { type: 'json' });
  } catch (e) {
    console.error('[create-setup-intent] store unavailable:', e.message);
    return json(503, { ok: false, error: 'booking_store_unavailable', fallback: true });
  }
  console.log('[create-setup-intent] booking found:', !!booking);
  if (!booking) return json(404, { ok: false, error: 'booking_not_found' });
  if (!booking.isDraft || booking.cardOnFileRequired !== true || booking.cardOnFileStatus !== 'pending') {
    console.log('[create-setup-intent] booking not eligible: isDraft=%s status=%s', booking.isDraft, booking.cardOnFileStatus);
    return json(409, { ok: false, error: 'booking_not_eligible_for_card_save' });
  }

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
    'automatic_payment_methods[enabled]': 'true',
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

  // Store setupIntentId on the draft so webhook can reconcile even if metadata lookup fails.
  try {
    await store.setJSON(bookingId, { ...booking, setupIntentId: si.id, stripeCustomerId: cust.id });
  } catch (e) {
    console.warn('[create-setup-intent] could not update draft with setupIntentId:', e.message);
  }

  console.log('[create-setup-intent] clientSecret returned to browser: yes');
  return json(200, {
    ok: true,
    clientSecret: si.client_secret,
    mode,
  });
};
