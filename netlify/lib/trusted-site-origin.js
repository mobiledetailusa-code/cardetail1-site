// Canonical origin for outbound customer links (email/SMS).
// Never derive customer notification URLs from request Host / X-Forwarded-Host.

'use strict';

const FALLBACK_ORIGIN = 'https://cardetail1.com';
const PRODUCTION_HOSTS = new Set(['cardetail1.com', 'www.cardetail1.com']);

function deployContext() {
  return String(process.env.CONTEXT || '').trim().toLowerCase();
}

function isProductionHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  return PRODUCTION_HOSTS.has(host);
}

/**
 * Normalize a candidate URL/origin to scheme://host (no path/query/fragment/userinfo).
 * Returns null when unusable for the current context.
 */
function normalizeOriginCandidate(raw, { requireHttps = false, rejectProductionHost = false } = {}) {
  const value = String(raw || '').trim().replace(/\/$/, '');
  if (!value) return null;
  if (/[\s<>"'`]/.test(value)) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (requireHttps && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (!url.hostname) return null;
  if (rejectProductionHost && isProductionHost(url.hostname)) return null;
  return `${url.protocol}//${url.host}`;
}

/**
 * Stable environment binding for appointment tokens / storage isolation.
 * Never embedded in public URLs — stored only on server-side token records.
 */
function deployEnvironmentKey() {
  const ctx = deployContext() || 'dev';
  if (ctx === 'production') return 'production';
  if (ctx === 'deploy-preview') {
    const review = String(process.env.REVIEW_ID || process.env.DEPLOY_ID || '').trim();
    return review ? `deploy-preview:${review}` : 'deploy-preview';
  }
  if (ctx === 'branch-deploy') {
    const branch = String(process.env.BRANCH || '').trim();
    return branch ? `branch-deploy:${branch}` : 'branch-deploy';
  }
  return 'dev';
}

/**
 * Resolve a trusted site origin from explicit deployment configuration only.
 *
 * production:
 *   PUBLIC_SITE_URL / TRUSTED_PUBLIC_SITE_ORIGIN → URL → https fallback
 *
 * branch-deploy / deploy-preview:
 *   explicit PUBLIC_SITE_URL / TRUSTED_PUBLIC_SITE_ORIGIN only when NOT the
 *   primary production host → DEPLOY_URL → DEPLOY_PRIME_URL
 *   Never silently use Netlify primary-site URL / SITE_URL (often production).
 *
 * dev / other:
 *   PUBLIC_SITE_URL / TRUSTED_PUBLIC_SITE_ORIGIN → URL → DEPLOY_URL → local fallback
 */
function trustedSiteOrigin() {
  const ctx = deployContext();

  if (ctx === 'production') {
    const candidates = [
      process.env.PUBLIC_SITE_URL,
      process.env.TRUSTED_PUBLIC_SITE_ORIGIN,
      process.env.URL,
    ];
    for (const raw of candidates) {
      const origin = normalizeOriginCandidate(raw, { requireHttps: true });
      if (origin) return origin;
    }
    return FALLBACK_ORIGIN;
  }

  if (ctx === 'branch-deploy' || ctx === 'deploy-preview') {
    const explicit = [
      process.env.PUBLIC_SITE_URL,
      process.env.TRUSTED_PUBLIC_SITE_ORIGIN,
    ];
    for (const raw of explicit) {
      const origin = normalizeOriginCandidate(raw, {
        requireHttps: true,
        rejectProductionHost: true,
      });
      if (origin) return origin;
    }
    for (const raw of [process.env.DEPLOY_URL, process.env.DEPLOY_PRIME_URL]) {
      const origin = normalizeOriginCandidate(raw, { requireHttps: true });
      if (origin) return origin;
    }
    // Last resort for preview contexts: never fall back to production primary.
    // Prefer an http local/preview only if https candidates were absent.
    for (const raw of [process.env.DEPLOY_URL, process.env.DEPLOY_PRIME_URL]) {
      const origin = normalizeOriginCandidate(raw, { requireHttps: false });
      if (origin && !isProductionHost(new URL(origin).hostname)) return origin;
    }
    return FALLBACK_ORIGIN;
  }

  // dev / unknown — allow explicit local http
  const candidates = [
    process.env.PUBLIC_SITE_URL,
    process.env.TRUSTED_PUBLIC_SITE_ORIGIN,
    process.env.URL,
    process.env.DEPLOY_URL,
    process.env.DEPLOY_PRIME_URL,
  ];
  for (const raw of candidates) {
    const origin = normalizeOriginCandidate(raw, { requireHttps: false });
    if (origin) return origin;
  }
  return FALLBACK_ORIGIN;
}

function buildTrustedAbsoluteUrl(pathnameAndQuery) {
  const origin = trustedSiteOrigin();
  const path = String(pathnameAndQuery || '');
  if (!path.startsWith('/')) return `${origin}/${path.replace(/^\//, '')}`;
  return `${origin}${path}`;
}

module.exports = {
  FALLBACK_ORIGIN,
  PRODUCTION_HOSTS,
  deployContext,
  deployEnvironmentKey,
  isProductionHost,
  normalizeOriginCandidate,
  trustedSiteOrigin,
  buildTrustedAbsoluteUrl,
};
