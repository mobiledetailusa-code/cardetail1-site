// TEMPORARY — one-shot Stripe webhook setup.
// 1. Creates a webhook endpoint at SITE_URL/.netlify/functions/stripe-webhook
//    (if not already there) with all required events.
// 2. Updates STRIPE_WEBHOOK_SECRET in Netlify env to match the new endpoint.
// DELETE THIS FILE after running — it is not meant to stay in production.
//
// Usage: POST /.netlify/functions/stripe-webhook-setup
// Header: x-admin-key: <ADMIN_DASH_PASSWORD>

const json = (s, b) => ({
  statusCode: s,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(b),
});

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

  const stripeSecret    = process.env.STRIPE_SECRET_KEY;
  const netlifyToken    = process.env.NETLIFY_AUTH_TOKEN;
  const netlifySiteId   = process.env.NETLIFY_SITE_ID;
  const siteUrl         = (process.env.SITE_URL || 'https://cardetail1.com').replace(/\/$/, '');
  const webhookUrl      = `${siteUrl}/.netlify/functions/stripe-webhook`;

  if (!stripeSecret) return json(503, { error: 'STRIPE_SECRET_KEY not set' });
  const mode = stripeSecret.startsWith('sk_test_') ? 'test' : 'live';

  const stripeH = {
    Authorization: `Bearer ${stripeSecret}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  // ── 1. Check if endpoint already exists ───────────────────────────────────
  const listRes = await fetch('https://api.stripe.com/v1/webhook_endpoints?limit=20', { headers: stripeH });
  if (!listRes.ok) return json(502, { error: 'stripe_list_failed' });
  const list = await listRes.json().catch(() => ({}));
  const existing = (list.data || []).find(ep => ep.url === webhookUrl);

  let endpointId, secretUpdated = false, action;

  if (existing) {
    // ── 2a. Already exists — patch events if needed ────────────────────────
    const current = existing.enabled_events || [];
    const missing  = REQUIRED_EVENTS.filter(e => !current.includes(e) && e !== '*');
    if (missing.length > 0) {
      const merged = [...new Set([...current, ...REQUIRED_EVENTS])].filter(e => e !== '*');
      const form = new URLSearchParams();
      merged.forEach(e => form.append('enabled_events[]', e));
      const patchRes = await fetch(`https://api.stripe.com/v1/webhook_endpoints/${existing.id}`, {
        method: 'POST', headers: stripeH, body: form,
      });
      if (!patchRes.ok) return json(502, { error: 'stripe_patch_failed', id: existing.id });
      action = 'patched_events';
    } else {
      action = 'already_complete';
    }
    endpointId = existing.id;
  } else {
    // ── 2b. Create new endpoint ────────────────────────────────────────────
    const form = new URLSearchParams({ url: webhookUrl, api_version: '2023-10-16' });
    REQUIRED_EVENTS.forEach(e => form.append('enabled_events[]', e));
    const createRes = await fetch('https://api.stripe.com/v1/webhook_endpoints', {
      method: 'POST', headers: stripeH, body: form,
    });
    if (!createRes.ok) {
      const err = await createRes.json().catch(() => ({}));
      return json(502, { error: 'stripe_create_failed', stripe: err.error && err.error.message });
    }
    const created = await createRes.json().catch(() => ({}));
    endpointId = created.id;
    action = 'created';

    // ── 3. Update STRIPE_WEBHOOK_SECRET in Netlify env ────────────────────
    if (netlifyToken && netlifySiteId && created.secret) {
      const netlifyH = {
        Authorization: `Bearer ${netlifyToken}`,
        'Content-Type': 'application/json',
      };
      // Netlify env API: patch a single env var
      const envBody = JSON.stringify([{
        key: 'STRIPE_WEBHOOK_SECRET',
        values: [{ value: created.secret, context: 'all' }],
      }]);
      const envRes = await fetch(
        `https://api.netlify.com/api/v1/sites/${netlifySiteId}/env`,
        { method: 'PATCH', headers: netlifyH, body: envBody }
      );
      secretUpdated = envRes.ok;
    }
  }

  return json(200, {
    ok: true,
    mode,
    action,
    endpointId,
    webhookUrl,
    secretUpdated,
    requiredEvents: REQUIRED_EVENTS,
  });
};
