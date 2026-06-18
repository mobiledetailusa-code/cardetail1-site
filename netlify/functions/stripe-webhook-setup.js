// TEMPORARY — single-use webhook event subscription fix.
// Adds setup_intent.succeeded and setup_intent.setup_failed to the Stripe
// webhook endpoint if they are missing. Safe to call multiple times (idempotent).
// DELETE THIS FILE after running. It is not meant to stay in production.
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

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return json(503, { error: 'STRIPE_SECRET_KEY not set' });
  const mode = secret.startsWith('sk_test_') ? 'test' : 'live';

  const stripeH = {
    Authorization: `Bearer ${secret}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  // List all webhook endpoints
  const listRes = await fetch('https://api.stripe.com/v1/webhook_endpoints?limit=20', {
    headers: stripeH,
  });
  if (!listRes.ok) {
    return json(502, { error: 'stripe_list_failed', status: listRes.status });
  }
  const list = await listRes.json().catch(() => ({}));
  const endpoints = (list.data || []);

  const results = [];

  for (const ep of endpoints) {
    const current = ep.enabled_events || [];
    const missing = REQUIRED_EVENTS.filter(e => !current.includes(e) && e !== '*');
    const hasAll   = missing.length === 0 || current.includes('*');

    if (hasAll) {
      results.push({ id: ep.id, url: ep.url, action: 'already_complete', events: current });
      continue;
    }

    // Merge existing + required
    const merged = [...new Set([...current, ...REQUIRED_EVENTS])].filter(e => e !== '*');
    const form = new URLSearchParams();
    merged.forEach(e => form.append('enabled_events[]', e));

    const patchRes = await fetch(`https://api.stripe.com/v1/webhook_endpoints/${ep.id}`, {
      method: 'POST',
      headers: stripeH,
      body: form,
    });

    if (patchRes.ok) {
      const updated = await patchRes.json().catch(() => ({}));
      results.push({
        id: ep.id,
        url: ep.url,
        action: 'updated',
        added: missing,
        events: updated.enabled_events || merged,
      });
    } else {
      results.push({
        id: ep.id,
        url: ep.url,
        action: 'patch_failed',
        status: patchRes.status,
        missing,
      });
    }
  }

  return json(200, {
    ok: true,
    mode,
    endpointCount: endpoints.length,
    results,
  });
};
