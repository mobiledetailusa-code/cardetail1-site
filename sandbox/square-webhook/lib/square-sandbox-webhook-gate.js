'use strict';

/**
 * Runtime gate for the Square Sandbox webhook site.
 *
 * Netlify injects SITE_ID into functions. The build-time site id alias is not read.
 * A production deploy context is not an allow signal: the sandbox site uses
 * its own production context. The allowed site id and the confirmation string
 * are both required. Known commercial site ids are refused even if configured.
 */

const { assessNotificationUrl } = require('../../../netlify/lib/square-webhook-verifier');

const PRODUCTION_SITE_ID = 'd7e5f77c-1f0b-4209-a9df-3d6aae380dd0';
const STAGING_SITE_ID = '982e6338-4a4a-432e-855b-db532b994391';
const BLOCKED_SITE_IDS = new Set([PRODUCTION_SITE_ID, STAGING_SITE_ID]);
const CONFIRMATION = 'square-sandbox';
const SANDBOX_WEBHOOK_HOST = 'cardetail1-square-sandbox.netlify.app';

const COMMERCIAL_ENV_KEYS = Object.freeze([
  'DATABASE_URL',
  'DIRECT_URL',
  'OWNER_STUDIO_STAGING_DATABASE_URL',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'SQUARE_ACCESS_TOKEN',
  'SQUARE_PRODUCTION_ACCESS_TOKEN',
  'SQUARE_PROD_ACCESS_TOKEN',
  'SQUARE_SANDBOX_ACCESS_TOKEN',
]);

const CREDENTIAL_PREFIX = /^(?:sk_live_|sk_test_|pk_live_|pk_test_|sq0idp-|sq0csp-|sandbox-sq0idb-|EAAA)/;

function present(value) {
  return typeof value === 'string' && value.length > 0;
}

function assessSandboxWebhookEnvironment(env) {
  const source = env && typeof env === 'object' ? env : {};
  const siteId = present(source.SITE_ID) ? source.SITE_ID : '';
  const allowedSiteId = present(source.SQUARE_SANDBOX_ALLOWED_SITE_ID)
    ? source.SQUARE_SANDBOX_ALLOWED_SITE_ID
    : '';
  const confirmation = source.SQUARE_SANDBOX_WEBHOOK_CONFIRMATION;
  const merchantId = source.SQUARE_SANDBOX_MERCHANT_ID;
  const notificationUrl = source.SQUARE_SANDBOX_WEBHOOK_NOTIFICATION_URL;
  const signatureKey = source.SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY;
  const databaseUrl = source.SQUARE_SANDBOX_WEBHOOK_DATABASE_URL;

  if (!siteId || !allowedSiteId || siteId !== allowedSiteId) return { ok: false };
  if (BLOCKED_SITE_IDS.has(siteId) || BLOCKED_SITE_IDS.has(allowedSiteId)) return { ok: false };
  if (confirmation !== CONFIRMATION) return { ok: false };
  if (!present(merchantId) || !present(signatureKey) || !present(databaseUrl)) return { ok: false };
  if (!/^postgres(?:ql)?:\/\//.test(databaseUrl)) return { ok: false };

  for (let i = 0; i < COMMERCIAL_ENV_KEYS.length; i += 1) {
    if (present(source[COMMERCIAL_ENV_KEYS[i]])) return { ok: false };
  }
  if (CREDENTIAL_PREFIX.test(signatureKey) || CREDENTIAL_PREFIX.test(databaseUrl)) return { ok: false };

  const urlCheck = assessNotificationUrl(notificationUrl);
  if (!urlCheck.ok) return { ok: false };
  let parsed;
  try {
    parsed = new URL(notificationUrl);
  } catch {
    return { ok: false };
  }
  if (parsed.hostname.toLowerCase() !== SANDBOX_WEBHOOK_HOST) return { ok: false };

  return {
    ok: true,
    siteId,
    merchantId,
    notificationUrl,
    signatureKey,
    databaseUrl,
  };
}

module.exports = {
  BLOCKED_SITE_IDS,
  COMMERCIAL_ENV_KEYS,
  CONFIRMATION,
  PRODUCTION_SITE_ID,
  SANDBOX_WEBHOOK_HOST,
  STAGING_SITE_ID,
  assessSandboxWebhookEnvironment,
};
