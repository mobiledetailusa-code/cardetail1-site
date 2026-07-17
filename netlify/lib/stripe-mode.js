/**
 * Shared Stripe mode / configuration boundary.
 * Local and deploy-preview must reject live-prefixed secrets before any network call.
 */

function deploymentContext(env = process.env) {
  const context = String(env.CONTEXT || env.NETLIFY_CONTEXT || '').toLowerCase();
  const netlifyDev = env.NETLIFY_DEV === 'true' || env.NETLIFY_DEV === '1';
  const isLocal = netlifyDev
    || context === 'dev'
    || context === 'development'
    || !!env.CD1_FORCE_LOCAL_STRIPE_GUARD;
  const isPreview = context === 'deploy-preview' || context === 'branch-deploy';
  const isProduction = context === 'production';
  return { context, isLocal, isPreview, isProduction, netlifyDev };
}

function keyMode(secret) {
  const s = String(secret || '');
  if (s.startsWith('sk_live_')) return 'live';
  if (s.startsWith('sk_test_')) return 'test';
  if (s.startsWith('pk_live_')) return 'live';
  if (s.startsWith('pk_test_')) return 'test';
  if (!s) return 'missing';
  return 'unknown';
}

/**
 * @returns {{ ok: true, mode: string, secret: string } | { ok: false, error: string, statusCode: number }}
 */
function assertStripeSecretAllowed(env = process.env, { purpose = 'charge' } = {}) {
  const secret = env.STRIPE_SECRET_KEY || '';
  const mode = keyMode(secret);
  const ctx = deploymentContext(env);

  if (!secret || mode === 'missing') {
    return { ok: false, error: 'stripe_not_configured', statusCode: 503, mode, context: ctx };
  }

  if ((ctx.isLocal || ctx.isPreview) && mode === 'live') {
    return {
      ok: false,
      error: 'stripe_test_mode_required',
      statusCode: 503,
      mode,
      context: ctx,
      purpose,
    };
  }

  if ((ctx.isLocal || ctx.isPreview) && mode !== 'test') {
    return {
      ok: false,
      error: 'stripe_test_mode_required',
      statusCode: 503,
      mode,
      context: ctx,
      purpose,
    };
  }

  return { ok: true, mode, secret, context: ctx };
}

/**
 * Guard that must run before any Stripe network call.
 * Returns a ready-to-return HTTP body shape when blocked.
 */
function guardStripeOrReject(env = process.env, opts = {}) {
  const result = assertStripeSecretAllowed(env, opts);
  if (result.ok) return { blocked: false, ...result };
  return {
    blocked: true,
    statusCode: result.statusCode || 503,
    body: { ok: false, error: result.error },
    ...result,
  };
}

module.exports = {
  deploymentContext,
  keyMode,
  assertStripeSecretAllowed,
  guardStripeOrReject,
};
