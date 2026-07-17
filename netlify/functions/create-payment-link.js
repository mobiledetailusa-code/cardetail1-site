// netlify/functions/create-payment-link.js
// Release A: dormant non-authoritative amount path disabled.
// Use Admin Generate Stripe link or Customer Pay Balance (authoritative remainingCents).

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const { verifyAdminKey } = require('../lib/tech-security');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
      body: '',
    };
  }
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  const auth = await verifyAdminKey(event.headers || {});
  if (!auth.ok) {
    const status = auth.error === 'missing_admin_config' ? 503 : 401;
    return json(status, { ok: false, error: auth.error || 'unauthorized' });
  }

  return json(410, {
    ok: false,
    error: 'endpoint_disabled',
    message: 'Use authoritative balance Checkout via Admin Generate Stripe link or Customer Pay Balance.',
  });
};
