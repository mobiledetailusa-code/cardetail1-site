// TEMPORARY — one-shot Stripe webhook setup. DELETE AFTER RUNNING.
// Rolls the signing secret for the new webhook endpoint and updates
// STRIPE_WEBHOOK_SECRET in Netlify via multiple API strategies.
//
// Usage: POST /.netlify/functions/stripe-webhook-setup
// Header: x-admin-key: <ADMIN_DASH_PASSWORD>

const json = (s, b) => ({
  statusCode: s,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(b),
});

const NEW_ENDPOINT_ID = 'we_1TjhuwLbeoH0J6blYrUohX0D'; // created by previous run
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
  const netlifyToken  = process.env.NETLIFY_AUTH_TOKEN;
  const netlifySiteId = process.env.NETLIFY_SITE_ID;

  if (!stripeSecret) return json(503, { error: 'STRIPE_SECRET_KEY not set' });
  if (!netlifyToken)  return json(503, { error: 'NETLIFY_AUTH_TOKEN not set' });
  if (!netlifySiteId) return json(503, { error: 'NETLIFY_SITE_ID not set' });

  const mode = stripeSecret.startsWith('sk_test_') ? 'test' : 'live';
  const stripeH = {
    Authorization: `Bearer ${stripeSecret}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  // ── 1. Roll the signing secret for the new endpoint ───────────────────────
  const rollRes = await fetch(
    `https://api.stripe.com/v1/webhook_endpoints/${NEW_ENDPOINT_ID}/secret`,
    { method: 'POST', headers: stripeH }
  );
  if (!rollRes.ok) {
    const err = await rollRes.json().catch(() => ({}));
    return json(502, { error: 'stripe_roll_failed', status: rollRes.status, msg: err.error && err.error.message });
  }
  const rolled = await rollRes.json().catch(() => ({}));
  const newSecret = rolled.secret; // whsec_...
  if (!newSecret) return json(502, { error: 'no_secret_in_roll_response' });

  const netlifyH = { Authorization: `Bearer ${netlifyToken}`, 'Content-Type': 'application/json' };
  const results = {};

  // ── 2. Try Netlify envelope API: PATCH /sites/{id}/env ────────────────────
  const patchBody = JSON.stringify([{
    key: 'STRIPE_WEBHOOK_SECRET',
    values: [{ value: newSecret, context: 'all' }],
  }]);
  const patchRes = await fetch(
    `https://api.netlify.com/api/v1/sites/${netlifySiteId}/env`,
    { method: 'PATCH', headers: netlifyH, body: patchBody }
  );
  results.envelope_patch = { status: patchRes.status, ok: patchRes.ok };

  if (patchRes.ok) {
    return json(200, { ok: true, mode, secretUpdated: true, method: 'envelope_patch', results });
  }

  // ── 3. Try Netlify site-level GET then PUT (old API) ─────────────────────
  const siteRes = await fetch(
    `https://api.netlify.com/api/v1/sites/${netlifySiteId}`,
    { headers: netlifyH }
  );
  const siteData = siteRes.ok ? await siteRes.json().catch(() => ({})) : {};
  const accountId = siteData.account_id || siteData.account_slug || '';
  results.account_id = accountId;

  if (accountId) {
    // ── 4. Try Netlify Envelope account-level API ──────────────────────────
    const accountPutBody = JSON.stringify({
      key: 'STRIPE_WEBHOOK_SECRET',
      values: [{ value: newSecret, context: 'all' }],
    });
    const accountPutRes = await fetch(
      `https://api.netlify.com/api/v1/accounts/${accountId}/env/STRIPE_WEBHOOK_SECRET`,
      { method: 'PUT', headers: netlifyH, body: accountPutBody }
    );
    results.account_put = { status: accountPutRes.status, ok: accountPutRes.ok };
    if (accountPutRes.ok) {
      return json(200, { ok: true, mode, secretUpdated: true, method: 'account_put', results });
    }

    // ── 5. Try PATCH account-level ─────────────────────────────────────────
    const accountPatchBody = JSON.stringify({
      values: [{ value: newSecret, context: 'all' }],
    });
    const accountPatchRes = await fetch(
      `https://api.netlify.com/api/v1/accounts/${accountId}/env/STRIPE_WEBHOOK_SECRET`,
      { method: 'PATCH', headers: netlifyH, body: accountPatchBody }
    );
    results.account_patch = { status: accountPatchRes.status, ok: accountPatchRes.ok };
    if (accountPatchRes.ok) {
      return json(200, { ok: true, mode, secretUpdated: true, method: 'account_patch', results });
    }
  }

  // All methods failed — return details for manual fallback
  return json(200, {
    ok: false,
    mode,
    secretUpdated: false,
    webhookEndpointId: NEW_ENDPOINT_ID,
    note: 'Signing secret was rolled but could not be written to Netlify. Update STRIPE_WEBHOOK_SECRET manually — see Stripe Dashboard → Webhooks → endpoint → Signing secret.',
    results,
  });
};
