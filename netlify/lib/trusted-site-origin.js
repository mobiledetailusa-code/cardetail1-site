// Canonical origin for outbound customer links (email/SMS).
// Never derive customer notification URLs from request Host / X-Forwarded-Host.

'use strict';

const FALLBACK_ORIGIN = 'https://cardetail1.com';

/**
 * Resolve a trusted site origin from explicit deployment configuration only.
 * Priority: PUBLIC_SITE_URL → URL → DEPLOY_URL → DEPLOY_PRIME_URL → fallback.
 */
function trustedSiteOrigin() {
  const candidates = [
    process.env.PUBLIC_SITE_URL,
    process.env.URL,
    process.env.DEPLOY_URL,
    process.env.DEPLOY_PRIME_URL,
  ];
  const ctx = String(process.env.CONTEXT || '').toLowerCase();
  const requireHttps = ctx === 'production';

  for (const raw of candidates) {
    const value = String(raw || '').trim().replace(/\/$/, '');
    if (!value) continue;
    if (/[\s<>"'`]/.test(value)) continue;
    let url;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    if (requireHttps && url.protocol !== 'https:') continue;
    if (url.username || url.password) continue;
    return `${url.protocol}//${url.host}`;
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
  trustedSiteOrigin,
  buildTrustedAbsoluteUrl,
};
