#!/usr/bin/env node
/**
 * Staging-only Netlify Blobs diagnostic.
 * Requires NETLIFY_SITE_ID + NETLIFY_AUTH_TOKEN for the staging site.
 * Refuses production site ID. Never prints tokens.
 *
 * Usage:
 *   node scripts/staging-blobs-diagnostic.mjs
 */

'use strict';

const crypto = require('crypto');

const STAGING_SITE_ID = '982e6338-4a4a-432e-855b-db532b994391';
const PRODUCTION_SITE_ID = 'd7e5f77c-1f0b-4209-a9df-3d6aae380dd0';
const PROBE_STORE = 'cd1-blobs-health';

function sha12(v) {
  return crypto.createHash('sha256').update(String(v || '')).digest('hex').slice(0, 12);
}

function fail(code, message, extra = {}) {
  console.log(JSON.stringify({ ok: false, error: code, message, ...extra }, null, 2));
  process.exit(1);
}

async function main() {
  const siteID = String(process.env.NETLIFY_SITE_ID || '').trim();
  const token = String(process.env.NETLIFY_AUTH_TOKEN || '').trim();
  if (!siteID) fail('missing_netlify_site_id', 'Set NETLIFY_SITE_ID to the staging site');
  if (!token) fail('missing_netlify_auth_token', 'Set NETLIFY_AUTH_TOKEN (PAT) for staging Blobs access');
  if (siteID === PRODUCTION_SITE_ID) {
    fail('production_site_id_rejected', 'Refusing to run Blobs diagnostic against production');
  }
  if (siteID !== STAGING_SITE_ID) {
    fail('unexpected_site_id', 'Site ID is not the approved staging site', {
      expectedSiteIdFingerprint: sha12(STAGING_SITE_ID),
      providedSiteIdFingerprint: sha12(siteID),
    });
  }

  let getStore;
  try {
    ({ getStore } = require('@netlify/blobs'));
  } catch (e) {
    fail('blobs_module_missing', e.message);
  }

  const store = getStore({ name: PROBE_STORE, siteID, token });
  const key = `staging_diag_${crypto.randomBytes(6).toString('hex')}`;
  const payload = { ok: true, purpose: 'staging_diag', at: new Date().toISOString() };

  let writable = false;
  let readable = false;
  let cleaned = false;
  let detail = null;

  try {
    await store.setJSON(key, payload, { ttl: 60_000 });
    writable = true;
    const got = await store.get(key, { type: 'json' });
    readable = !!(got && got.ok === true && got.purpose === 'staging_diag');
    if (typeof store.delete === 'function') {
      await store.delete(key);
      cleaned = true;
    }
  } catch (e) {
    detail = String(e && e.message || e)
      .replace(/nf[cp]_[A-Za-z0-9]+/gi, '[REDACTED]')
      .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
      .slice(0, 160);
  }

  const ok = writable && readable && cleaned;
  console.log(JSON.stringify({
    ok,
    blobsContextConfigured: true,
    siteRole: 'staging',
    siteIdFingerprint: sha12(siteID),
    store: PROBE_STORE,
    writable,
    readable,
    cleaned,
    ...(detail ? { detail } : {}),
  }, null, 2));
  process.exit(ok ? 0 : 1);
}

main().catch((e) => fail('diagnostic_crashed', String(e && e.message || e)));
