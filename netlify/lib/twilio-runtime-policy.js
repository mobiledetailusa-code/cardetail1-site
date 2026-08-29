'use strict';

const { readDeployEnv } = require('./trusted-site-origin');

function enabled(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function clean(value) {
  return String(value || '').trim();
}

function identityValue(env, liveKey, bakedKey = liveKey) {
  const live = clean(env[liveKey]);
  if (live) return live;
  return clean(readDeployEnv(bakedKey));
}

function runtimeIdentity(env = process.env) {
  // Functions on this site do not receive CONTEXT/BRANCH at runtime; the
  // Netlify build command bakes them via generate-deploy-runtime-env.js.
  const context = (identityValue(env, 'CONTEXT') || identityValue(env, 'DEPLOY_CONTEXT', 'CONTEXT')).toLowerCase();
  const branch = (identityValue(env, 'BRANCH') || identityValue(env, 'HEAD', 'BRANCH')).toLowerCase();
  let host = '';
  try {
    const url = clean(env.URL || env.PUBLIC_SITE_URL) || readDeployEnv('URL');
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = '';
  }
  return { context, branch, host };
}

function productionRuntimeAllowed(env = process.env) {
  const identity = runtimeIdentity(env);
  const allowedBranch = clean(env.TWILIO_ALLOWED_BRANCH || 'master').toLowerCase();
  const allowedHost = clean(env.TWILIO_ALLOWED_HOST || 'cardetail1.com').toLowerCase();
  if (identity.context !== 'production') return { ok: false, reason: 'non_production_context' };
  if (!identity.branch || identity.branch !== allowedBranch) {
    return { ok: false, reason: 'non_production_branch' };
  }
  if (!identity.host || ![allowedHost, `www.${allowedHost}`].includes(identity.host)) {
    return { ok: false, reason: 'non_production_host' };
  }
  return { ok: true, identity };
}

function smsOutboxPolicy(env = process.env) {
  if (!enabled(env.TWILIO_OUTBOX_ENABLED)) return { ok: false, reason: 'outbox_disabled' };
  if (!enabled(env.TWILIO_ENABLED)) return { ok: false, reason: 'twilio_disabled' };
  return productionRuntimeAllowed(env);
}

function outboundTwilioPolicy(env = process.env) {
  const outbox = smsOutboxPolicy(env);
  if (!outbox.ok) return outbox;
  if (!enabled(env.TWILIO_PRODUCTION_SENDS_ENABLED)) {
    return { ok: false, reason: 'production_sends_disabled' };
  }
  const accountSid = clean(env.TWILIO_ACCOUNT_SID || env.TWILIO_SID);
  const apiKey = clean(env.TWILIO_API_KEY);
  const apiSecret = clean(env.TWILIO_API_SECRET);
  const messagingServiceSid = clean(env.TWILIO_MESSAGING_SERVICE_SID);
  const statusCallbackUrl = clean(env.TWILIO_STATUS_CALLBACK_URL);
  if (!/^AC[a-zA-Z0-9]{8,}$/.test(accountSid)) return { ok: false, reason: 'account_sid_missing' };
  if (!/^SK[a-zA-Z0-9]{8,}$/.test(apiKey) || !apiSecret) {
    return { ok: false, reason: 'api_key_missing' };
  }
  if (!/^MG[a-zA-Z0-9]{8,}$/.test(messagingServiceSid)) {
    return { ok: false, reason: 'messaging_service_missing' };
  }
  try {
    const callback = new URL(statusCallbackUrl);
    if (callback.protocol !== 'https:') throw new Error('https_required');
  } catch {
    return { ok: false, reason: 'status_callback_invalid' };
  }
  return {
    ok: true,
    accountSid,
    apiKey,
    apiSecret,
    messagingServiceSid,
    statusCallbackUrl,
  };
}

function webhookUrlEnvKey(kind) {
  if (kind === 'inbound') return 'TWILIO_INBOUND_WEBHOOK_URL';
  if (kind === 'voice') return 'TWILIO_VOICE_WEBHOOK_URL';
  return 'TWILIO_STATUS_CALLBACK_URL';
}

function webhookUrl(kind, env = process.env) {
  const explicit = clean(env[webhookUrlEnvKey(kind)]);
  if (explicit) return explicit;
  if (kind !== 'voice') return '';
  // Voice signature URL is a sibling of the existing inbound webhook.
  // Production does not need a new Netlify env var when inbound is already set.
  const inbound = clean(env.TWILIO_INBOUND_WEBHOOK_URL);
  if (inbound.includes('twilio-inbound')) {
    return inbound.replace(/twilio-inbound/g, 'twilio-voice');
  }
  return '';
}

function webhookPolicy(kind, env = process.env) {
  const runtime = productionRuntimeAllowed(env);
  if (!runtime.ok) return runtime;
  const authToken = clean(env.TWILIO_AUTH_TOKEN || env.TWILIO_TOKEN);
  const url = webhookUrl(kind, env);
  if (!authToken) return { ok: false, reason: 'auth_token_missing' };
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('https_required');
  } catch {
    return { ok: false, reason: 'webhook_url_invalid' };
  }
  return { ok: true, authToken, url };
}

module.exports = {
  enabled,
  runtimeIdentity,
  productionRuntimeAllowed,
  smsOutboxPolicy,
  outboundTwilioPolicy,
  webhookPolicy,
  webhookUrlEnvKey,
  webhookUrl,
};
