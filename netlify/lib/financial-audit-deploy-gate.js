'use strict';

/**
 * Production gate for the read-only financial audit.
 *
 * Functions on this site do not receive CONTEXT/BRANCH at runtime. The Netlify
 * build command snapshots them into deploy-runtime-env.generated.js. That bake
 * is the deploy identity. Live process.env may confirm the bake; it may not
 * override it. Request Host / X-Forwarded-Host never grant production.
 */

const {
  isProductionHost,
  loadBakedDeployEnv,
  normalizeOriginCandidate,
} = require('./trusted-site-origin');

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function hostnameOf(raw) {
  const origin = normalizeOriginCandidate(raw, { requireHttps: false });
  if (!origin) return '';
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function headerValue(event, name) {
  const headers = (event && event.headers) || {};
  const want = String(name || '').toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === want) return Array.isArray(value) ? value[0] : value;
  }
  return '';
}

function presentedRequestHosts(event) {
  const hosts = [];
  for (const name of ['host', 'x-forwarded-host']) {
    const raw = headerValue(event, name);
    if (!raw) continue;
    for (const part of String(raw).split(',')) {
      const host = part.trim().toLowerCase().split(':')[0];
      if (host) hosts.push(host);
    }
  }
  return hosts;
}

function liveIdentity(env = {}) {
  return {
    context: clean(env.CONTEXT || env.NETLIFY_CONTEXT).toLowerCase(),
    branch: clean(env.BRANCH || env.HEAD).toLowerCase(),
    host: hostnameOf(env.URL || env.PUBLIC_SITE_URL),
  };
}

function bakedIdentity(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  return {
    context: clean(snapshot.CONTEXT).toLowerCase(),
    branch: clean(snapshot.BRANCH).toLowerCase(),
    host: hostnameOf(snapshot.URL),
  };
}

function identitiesDiverge(baked, live) {
  if (live.context && live.context !== baked.context) return true;
  if (live.branch && live.branch !== baked.branch) return true;
  if (live.host && live.host !== baked.host) {
    if (!(isProductionHost(live.host) && isProductionHost(baked.host))) return true;
  }
  return false;
}

function financialAuditProductionGate(event, env = process.env) {
  let snapshot;
  try {
    snapshot = loadBakedDeployEnv();
  } catch {
    return { ok: false, error: 'non_production_context' };
  }
  const baked = bakedIdentity(snapshot);
  if (!baked) return { ok: false, error: 'non_production_context' };
  if (!baked.context || baked.context === 'dev' || baked.context === 'development') {
    return { ok: false, error: 'non_production_context' };
  }
  if (baked.context === 'deploy-preview' || baked.context === 'branch-deploy') {
    return { ok: false, error: 'non_production_context' };
  }
  if (baked.context !== 'production') {
    return { ok: false, error: 'non_production_context' };
  }
  if (baked.branch !== 'master') {
    return { ok: false, error: 'non_production_context' };
  }
  if (!isProductionHost(baked.host)) {
    return { ok: false, error: 'non_production_context' };
  }

  const live = liveIdentity(env || {});
  if (identitiesDiverge(baked, live)) {
    return { ok: false, error: 'non_production_context' };
  }

  const hostHeader = clean(headerValue(event, 'host')).toLowerCase().split(':')[0];
  if (!isProductionHost(hostHeader)) {
    return { ok: false, error: 'non_production_context' };
  }
  const presented = presentedRequestHosts(event);
  if (!presented.length) return { ok: false, error: 'non_production_context' };
  if (presented.some((host) => !isProductionHost(host))) {
    return { ok: false, error: 'non_production_context' };
  }
  return { ok: true };
}

module.exports = {
  financialAuditProductionGate,
  presentedRequestHosts,
  bakedIdentity,
  liveIdentity,
};
