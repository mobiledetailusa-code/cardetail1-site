// TEMPORARY — one-shot Stripe webhook setup. DELETE AFTER RUNNING.
// Recreates the webhook endpoint at the correct URL, writes the signing
// secret to Netlify Blobs (protected store, admin key required to read),
// so the caller can retrieve it and update STRIPE_WEBHOOK_SECRET in Netlify.
//
// Usage: POST /.netlify/functions/stripe-webhook-setup
// Header: x-admin-key: <ADMIN_DASH_PASSWORD>

const json = (s, b) => ({
  statusCode: s,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(b),
});

const OLD_ENDPOINT_ID = 'we_1TjhuwLbeoH0J6blYrUohX0D'; // delete this (has unknown secret)
const REQUIRED_EVENTS = [
  'setup_intent.succeeded',
  'setup_intent.setup_failed',
  'payment_intent.amount_capturable_updated',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  const adminKey = process.env.ADMIN_DASH_PASSWORD;
  if (!adminKey || (event.headers['x-admin-key'] || event.headers['X-Admin-Key']) !== adminKey) {
    return json(401, { error: 'unauthorized' });
  }

  const stripeSecret  = process.env.STRIPE_SECRET_KEY;
  const netlifySiteId = process.env.NETLIFY_SITE_ID;
  const netlifyToken  = process.env.NETLIFY_AUTH_TOKEN;
  const siteUrl       = (process.env.SITE_URL || 'https://cardetail1.com').replace(/\/$/, '');
  const webhookUrl    = `${siteUrl}/.netlify/functions/stripe-webhook`;

  if (!stripeSecret) return json(503, { error: 'STRIPE_SECRET_KEY not set' });
  const mode = stripeSecret.startsWith('sk_test_') ? 'test' : 'live';

  const stripeH = {
    Authorization: `Bearer ${stripeSecret}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  // ── 1. Delete the old endpoint (it has an unknown secret) ────────────────
  await fetch(`https://api.stripe.com/v1/webhook_endpoints/${OLD_ENDPOINT_ID}`, {
    method: 'DELETE',
    headers: stripeH,
  }).catch(() => {});

  // ── 2. Create new endpoint ─────────────────────────────────────────────
  const form = new URLSearchParams({ url: webhookUrl });
  REQUIRED_EVENTS.forEach(e => form.append('enabled_events[]', e));

  const createRes = await fetch('https://api.stripe.com/v1/webhook_endpoints', {
    method: 'POST',
    headers: stripeH,
    body: form,
  });
  if (!createRes.ok) {
    const err = await createRes.json().catch(() => ({}));
    return json(502, { error: 'stripe_create_failed', msg: err.error && err.error.message });
  }
  const created = await createRes.json().catch(() => ({}));
  const newId     = created.id;
  const newSecret = created.secret; // whsec_... only available at creation

  if (!newId || !newSecret) return json(502, { error: 'stripe_missing_id_or_secret' });

  // ── 3. Store the secret in Netlify Blobs (protected) ─────────────────────
  let blobsOk = false;
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = (netlifySiteId && netlifyToken)
      ? getStore({ name: 'cd1-setup', siteID: netlifySiteId, token: netlifyToken })
      : getStore('cd1-setup');

    await store.setJSON('webhook-secret', { secret: newSecret, endpointId: newId, createdAt: new Date().toISOString() });
    blobsOk = true;
  } catch (e) {
    console.error('[stripe-webhook-setup] blobs write failed:', e.message);
  }

  return json(200, {
    ok: true,
    mode,
    newEndpointId: newId,
    webhookUrl,
    blobsStored: blobsOk,
    note: blobsOk
      ? 'Secret stored in cd1-setup/webhook-secret blob. Retrieve it and update STRIPE_WEBHOOK_SECRET in Netlify.'
      : 'Blobs write failed. Retrieve the signing secret from Stripe Dashboard → Webhooks → endpoint → Signing secret.',
  });
};
