// TEMPORARY QA tooling — feat/postgres-payment-operational webhook E2E closure only.
// Not a product feature. Removed once the webhook E2E proof in
// docs/audit is complete. Mirrors the isolation pattern of
// qa-opscore-lifecycle.js: hard-denies Production by context AND host,
// hard-locks to this one branch, and requires the same admin session
// every other Admin Ops endpoint requires.
//
// Actions (admin-authenticated POST only):
//   create_endpoint — registers a Stripe test-mode webhook endpoint at this
//                     deploy's own stripe-webhook URL. Returns the signing
//                     secret ONCE (Stripe never returns it again) so it can
//                     be copied into STRIPE_WEBHOOK_SECRET immediately.
//   delete_endpoint — removes a webhook endpoint by id (cleanup).
//   replay_event    — re-fetches a real Stripe event by id and re-POSTs it
//                     to this deploy's stripe-webhook with a freshly
//                     computed valid signature, to prove duplicate-delivery
//                     handling against a real event (not a synthetic one).

const crypto = require('crypto');
const { verifyAdminKey, jsonCors } = require('../lib/tech-security');
const { guardStripeOrReject } = require('../lib/stripe-mode');

const QA_BRANCH = 'feat/postgres-payment-operational';

function isProductionContext() {
  return String(process.env.CONTEXT || '').toLowerCase() === 'production';
}

function isAllowedDeploy(event) {
  if (isProductionContext()) return false;
  const host = String(
    event.headers?.['x-forwarded-host'] || event.headers?.Host || event.headers?.host || ''
  ).toLowerCase();
  if (
    host === 'cardetail1.com' || host === 'www.cardetail1.com'
    || host === 'cardetail1.netlify.app' || host.endsWith('.cardetail1.com')
  ) {
    return false;
  }
  if (host.startsWith(`${QA_BRANCH.replace(/\//g, '-')}--`) || host.startsWith('deploy-preview-120--')) return true;
  const branch = String(process.env.BRANCH || process.env.COMMIT_REF || '').trim();
  return branch === QA_BRANCH;
}

function selfWebhookUrl(event) {
  const host = event.headers?.['x-forwarded-host'] || event.headers?.Host || event.headers?.host || '';
  return `https://${host}/.netlify/functions/stripe-webhook`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (!isAllowedDeploy(event)) return jsonCors(404, { ok: false, error: 'not_found' });
  if (event.httpMethod !== 'POST') return jsonCors(405, { ok: false, error: 'method_not_allowed' });

  const auth = await verifyAdminKey(event.headers || {});
  if (!auth) return jsonCors(401, { ok: false, error: 'unauthorized' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'invalid_json' }); }

  const guard = guardStripeOrReject(process.env, { purpose: 'qa_webhook_admin' });
  if (guard.blocked) return jsonCors(guard.statusCode, guard.body);

  if (body.action === 'create_endpoint') {
    const url = selfWebhookUrl(event);
    const form = new URLSearchParams({
      url,
      'enabled_events[0]': 'payment_intent.succeeded',
      'enabled_events[1]': 'payment_intent.payment_failed',
      'enabled_events[2]': 'payment_intent.canceled',
      'enabled_events[3]': 'payment_intent.requires_action',
      'enabled_events[4]': 'checkout.session.completed',
      description: 'TEMP QA — feat/postgres-payment-operational webhook E2E closure',
    });
    const res = await fetch('https://api.stripe.com/v1/webhook_endpoints', {
      method: 'POST',
      headers: { Authorization: `Bearer ${guard.secret}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const data = await res.json();
    if (!res.ok) return jsonCors(502, { ok: false, error: data?.error?.message || 'stripe_create_failed' });
    return jsonCors(200, { ok: true, id: data.id, url: data.url, secret: data.secret, status: data.status });
  }

  if (body.action === 'delete_endpoint') {
    if (!body.id) return jsonCors(400, { ok: false, error: 'missing_id' });
    const res = await fetch(`https://api.stripe.com/v1/webhook_endpoints/${encodeURIComponent(body.id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${guard.secret}` },
    });
    const data = await res.json();
    if (!res.ok) return jsonCors(502, { ok: false, error: data?.error?.message || 'stripe_delete_failed' });
    return jsonCors(200, { ok: true, deleted: data.deleted !== false });
  }

  if (body.action === 'replay_event') {
    if (!body.eventId) return jsonCors(400, { ok: false, error: 'missing_event_id' });
    const evRes = await fetch(`https://api.stripe.com/v1/events/${encodeURIComponent(body.eventId)}`, {
      headers: { Authorization: `Bearer ${guard.secret}` },
    });
    const evData = await evRes.json();
    if (!evRes.ok) return jsonCors(502, { ok: false, error: evData?.error?.message || 'stripe_event_fetch_failed' });

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) return jsonCors(503, { ok: false, error: 'webhook_secret_not_configured' });

    const rawBody = JSON.stringify(evData);
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', webhookSecret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
    const sigHeader = `t=${t},v1=${sig}`;

    const replayRes = await fetch(selfWebhookUrl(event), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': sigHeader },
      body: rawBody,
    });
    const replayData = await replayRes.json().catch(() => ({}));
    return jsonCors(200, {
      ok: true,
      eventId: evData.id,
      eventType: evData.type,
      replayStatusCode: replayRes.status,
      replayBody: replayData,
    });
  }

  return jsonCors(400, { ok: false, error: 'unknown_action' });
};
