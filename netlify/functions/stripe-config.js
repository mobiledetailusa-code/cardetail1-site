// Returns the public Stripe publishable key for the current Netlify context.
// Publishable keys are safe for browser use. Secret/server keys are never returned.

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  },
  body: JSON.stringify(body),
});

exports.handler = async () => {
  const key = String(process.env.STRIPE_PUBLISHABLE_KEY || '').trim();
  const mode = key.startsWith('pk_test_') ? 'test' : key.startsWith('pk_live_') ? 'live' : '';
  if (!mode) return json(503, { ok: false, error: 'stripe_publishable_key_not_configured' });

  const isDeployPreview =
    process.env.CONTEXT === 'deploy-preview' ||
    /^https:\/\/deploy-preview-\d+--/i.test(process.env.DEPLOY_PRIME_URL || '');
  if (isDeployPreview && mode !== 'test') {
    return json(503, { ok: false, error: 'stripe_test_mode_required' });
  }

  return json(200, { ok: true, publishableKey: key, mode });
};
