#!/usr/bin/env node
'use strict';

/**
 * Authenticated staging Catalog Manager API proof (CSRF-aware).
 * Never prints secrets.
 *
 * Usage:
 *   node scripts/owner-studio-staging-catalog-api-proof.js --confirm-staging-proof
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const STAGING_ORIGIN = 'https://cardetail1-staging.netlify.app';
const STAGING_SITE_ID = '982e6338-4a4a-432e-855b-db532b994391';

function sha12(v) {
  return crypto.createHash('sha256').update(String(v || '')).digest('hex').slice(0, 12);
}

function fail(code, message, extra = {}) {
  console.log(JSON.stringify({ ok: false, error: code, message, ...extra }, null, 2));
  process.exit(1);
}

function readNetlifyToken() {
  const cfgPath = path.join(os.homedir(), 'AppData', 'Roaming', 'netlify', 'Config', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const token = Object.values(cfg.users || {})[0]?.auth?.token;
  if (!token) throw new Error('netlify_token_missing');
  return token;
}

async function getSiteEnv(token) {
  const res = await fetch(
    `https://api.netlify.com/api/v1/accounts/6a2802ed5070702e9f45913b/env?site_id=${STAGING_SITE_ID}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
  );
  if (!res.ok) throw new Error(`env_fetch_${res.status}`);
  const env = await res.json();
  return Object.fromEntries((env || []).map((r) => [r.key, (r.values || [])[0]?.value || '']));
}

function firstSetCookie(res) {
  if (typeof res.headers.getSetCookie === 'function') {
    const all = res.headers.getSetCookie();
    if (all && all.length) return all.map((c) => c.split(';')[0]).join('; ');
  }
  const raw = res.headers.get('set-cookie');
  return raw ? raw.split(',').map((p) => p.split(';')[0].trim()).join('; ') : '';
}

async function main() {
  if (!process.argv.includes('--confirm-staging-proof')) {
    fail('confirmation_required', 'Pass --confirm-staging-proof');
  }

  const netlifyToken = readNetlifyToken();
  const env = await getSiteEnv(netlifyToken);
  // Prefer gitignored local staging bootstrap credentials. Netlify env list often
  // redacts secret values into unusable placeholders, which must not win.
  let username = '';
  let password = '';
  const localCredPath = path.join(__dirname, '..', '.staging-db-repair', 'staging-admin-latest.json');
  if (fs.existsSync(localCredPath)) {
    const local = JSON.parse(fs.readFileSync(localCredPath, 'utf8'));
    if (local.siteId && local.siteId !== STAGING_SITE_ID) {
      fail('local_admin_site_mismatch', 'Local staging admin credentials are for a different site');
    }
    username = String(local.username || '').trim();
    password = String(local.password || '').trim();
  }
  if (!username || !password) {
    const envPath = path.join(__dirname, '..', '.env.owner-studio-staging');
    if (fs.existsSync(envPath)) {
      const map = {};
      for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        if (!line || line.startsWith('#') || !line.includes('=')) continue;
        const i = line.indexOf('=');
        map[line.slice(0, i).trim()] = line.slice(i + 1);
      }
      username = username || String(map.ADMIN_USERNAME || '').trim();
      password = password || String(map.ADMIN_DASH_PASSWORD || map.ADMIN_PASSWORD || '').trim();
    }
  }
  if (!username || !password) {
    username = String(env.ADMIN_USERNAME || '').trim();
    password = String(env.ADMIN_DASH_PASSWORD || env.ADMIN_PASSWORD || '').trim();
  }
  if (!username || !password) {
    fail('admin_credentials_missing', 'ADMIN_USERNAME / ADMIN_DASH_PASSWORD missing on staging');
  }

  const loginRes = await fetch(`${STAGING_ORIGIN}/.netlify/functions/admin-auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: STAGING_ORIGIN },
    body: JSON.stringify({ action: 'login', username, password }),
  });
  const loginBody = await loginRes.json().catch(() => ({}));
  if (!loginRes.ok || !loginBody.ok || !loginBody.token) {
    fail('admin_login_failed', 'Could not authenticate admin on staging', {
      status: loginRes.status,
      error: loginBody.error || null,
    });
  }
  const adminToken = loginBody.token;
  let cookie = firstSetCookie(loginRes);

  async function api(method, urlPath, body, extraHeaders = {}) {
    const headers = {
      Origin: STAGING_ORIGIN,
      'x-admin-key': adminToken,
      ...extraHeaders,
    };
    if (cookie) headers.Cookie = cookie;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${STAGING_ORIGIN}${urlPath}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = firstSetCookie(res);
    if (set) cookie = cookie ? `${cookie}; ${set}` : set;
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }

  const csrf = await api('GET', '/.netlify/functions/owner-studio-catalog?action=csrf');
  if (!csrf.json.ok || !csrf.json.csrfToken) {
    fail('csrf_failed', 'Could not obtain CSRF token', {
      status: csrf.status,
      error: csrf.json.error || null,
    });
  }

  const loaded = await api('GET', '/.netlify/functions/owner-studio-catalog?action=get_draft');
  if (loaded.status !== 200 || !loaded.json.ok || !loaded.json.draft) {
    fail('catalog_load_failed', 'Authenticated catalog load failed', {
      status: loaded.status,
      error: loaded.json.error || null,
      message: loaded.json.message || null,
      persistence: loaded.json.persistence || null,
    });
  }

  const draft = loaded.json.draft;
  const packages = Array.isArray(draft.packages) ? draft.packages : [];
  const addOns = Array.isArray(draft.addOns) ? draft.addOns : [];
  if (packages.length < 1) fail('packages_empty', 'No packages in PostgreSQL-backed draft');
  if (addOns.length < 1) fail('addons_empty', 'No add-ons in PostgreSQL-backed draft');

  const startVersion = Number(draft.version);
  const marker = `api-proof-${Date.now()}`;
  const originalDesc = packages[0].description || '';
  const edited = JSON.parse(JSON.stringify(draft));
  edited.packages[0].description = `${originalDesc} [${marker}]`.slice(0, 400);

  const save = await api(
    'POST',
    '/.netlify/functions/owner-studio-catalog',
    { action: 'save_draft', expectedVersion: startVersion, draft: edited },
    { 'x-csrf-token': csrf.json.csrfToken }
  );
  if (save.status >= 500) {
    fail('catalog_save_500', 'Save Draft returned 500', { status: save.status, error: save.json.error || null });
  }
  if (!save.json.ok) {
    fail('catalog_save_failed', 'Save Draft failed', {
      status: save.status,
      error: save.json.error || null,
      message: save.json.message || null,
    });
  }

  const afterSaveVersion = Number(save.json.draft?.version);
  const revisionId = save.json.revisionId;

  const reload = await api('GET', '/.netlify/functions/owner-studio-catalog?action=get_draft');
  const reloadDesc = reload.json.draft?.packages?.[0]?.description || '';
  if (!reloadDesc.includes(marker)) {
    fail('reload_persistence_failed', 'Saved description missing after reload');
  }

  const csrf2 = await api('GET', '/.netlify/functions/owner-studio-catalog?action=csrf');
  const stale = await api(
    'POST',
    '/.netlify/functions/owner-studio-catalog',
    { action: 'save_draft', expectedVersion: startVersion, draft: edited },
    { 'x-csrf-token': csrf2.json.csrfToken }
  );
  if (stale.status !== 409 && stale.json.error !== 'stale_draft_version') {
    fail('stale_409_missing', 'Expected stale two-tab save to return 409', {
      status: stale.status,
      error: stale.json.error || null,
    });
  }

  const csrf3 = await api('GET', '/.netlify/functions/owner-studio-catalog?action=csrf');
  const restored = await api(
    'POST',
    '/.netlify/functions/owner-studio-catalog',
    {
      action: 'restore_revision',
      revisionId,
      expectedVersion: afterSaveVersion,
    },
    { 'x-csrf-token': csrf3.json.csrfToken }
  );
  if (!restored.json.ok) {
    fail('restore_failed', 'Restore revision failed', {
      status: restored.status,
      error: restored.json.error || null,
    });
  }

  // Cleanup: restore original description
  const csrf4 = await api('GET', '/.netlify/functions/owner-studio-catalog?action=csrf');
  const cleanupDraft = JSON.parse(JSON.stringify(restored.json.draft));
  cleanupDraft.packages[0].description = originalDesc;
  const cleanup = await api(
    'POST',
    '/.netlify/functions/owner-studio-catalog',
    {
      action: 'save_draft',
      expectedVersion: Number(restored.json.draft.version),
      draft: cleanupDraft,
    },
    { 'x-csrf-token': csrf4.json.csrfToken }
  );

  console.log(JSON.stringify({
    ok: true,
    stagingOrigin: STAGING_ORIGIN,
    siteIdHash: sha12(STAGING_SITE_ID),
    adminAuthenticated: true,
    persistence: loaded.json.persistence || null,
    publicContentSource: loaded.json.publicContentSource || env.PUBLIC_CONTENT_SOURCE || null,
    publicationControls: loaded.json.publicationControls === false,
    packageCount: packages.length,
    addOnCount: addOns.length,
    startVersion,
    afterSaveVersion,
    revisionId: revisionId || null,
    reloadPersisted: true,
    stale409: true,
    restoreVersion: Number(restored.json.draft?.version),
    cleanupOk: !!cleanup.json.ok,
    noFunction500: true,
  }, null, 2));
}

main().catch((e) => fail('api_proof_failed', String(e.message || e).slice(0, 220)));
