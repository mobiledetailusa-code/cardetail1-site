#!/usr/bin/env node
'use strict';

/**
 * Staging Owner Studio Catalog Manager authenticated E2E harness.
 *
 * Proves:
 *  - authenticated GET draft
 *  - durable price save + version increment
 *  - fresh GET persistence
 *  - stale write → 409 stale_catalog_draft_version
 *  - forged client siteId ignored
 *  - get_draft and list_entities agree on saved price
 *  - original price restored
 *
 * Refuses to run unless target is staging.
 * Never prints passwords, tokens, cookies, connection strings, or full payloads.
 *
 * Auth (first match wins):
 *   STAGING_ADMIN_USER / STAGING_ADMIN_PASS
 *   .staging-db-repair/staging-admin-latest.json
 *
 * Usage:
 *   node scripts/staging-owner-studio-catalog-e2e.cjs
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const BASE = process.env.STAGING_OWNER_STUDIO_BASE_URL || 'https://cardetail1-staging.netlify.app';
const STAGING_SITE_ID = '982e6338-4a4a-432e-855b-db532b994391';
const PRODUCTION_SITE_ID = 'd7e5f77c-1f0b-4209-a9df-3d6aae380dd0';
const root = path.join(__dirname, '..');

function sha12(v) {
  return crypto.createHash('sha256').update(String(v || '')).digest('hex').slice(0, 12);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function req(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + urlPath);
    assert(u.hostname.includes('cardetail1-staging') || u.hostname.includes('localhost'), 'non_staging_host');
    const data = body != null ? Buffer.from(JSON.stringify(body)) : null;
    const r = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: {
        ...headers,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* ignore */ }
        resolve({
          status: res.statusCode,
          json,
          text: text.slice(0, 240),
          setCookie: !!(res.headers['set-cookie'] || res.headers['Set-Cookie']),
        });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function loadAdminCreds() {
  const userEnv = process.env.STAGING_ADMIN_USER || '';
  const passEnv = process.env.STAGING_ADMIN_PASS || '';
  if (userEnv && passEnv) {
    return { username: userEnv, password: passEnv, source: 'env' };
  }
  const latestPath = path.join(root, '.staging-db-repair', 'staging-admin-latest.json');
  if (fs.existsSync(latestPath)) {
    const j = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
    if (j.username && j.password) {
      return { username: j.username, password: j.password, source: 'staging-admin-latest.json' };
    }
  }
  return null;
}

function refuseIfNotStaging() {
  const u = new URL(BASE);
  assert(
    u.hostname === 'cardetail1-staging.netlify.app'
      || u.hostname.endsWith('--cardetail1-staging.netlify.app')
      || u.hostname === 'localhost',
    `refused_non_staging_host:${u.hostname}`
  );
  if (process.env.NETLIFY_SITE_ID && process.env.NETLIFY_SITE_ID === PRODUCTION_SITE_ID) {
    throw new Error('production_site_id_rejected');
  }
}

function findPriceTarget(draft) {
  // Prefer a stable add-on price row (simpler than vehicle-class matrix).
  const addOns = Array.isArray(draft.addOns) ? draft.addOns : [];
  for (const a of addOns) {
    if (a && a.addOnId && Array.isArray(a.prices) && a.prices[0] && Number.isInteger(a.prices[0].amountCents)) {
      return {
        kind: 'addon',
        id: a.addOnId,
        originalCents: a.prices[0].amountCents,
        path: ['addOns', addOns.indexOf(a), 'prices', 0, 'amountCents'],
      };
    }
  }
  const packages = Array.isArray(draft.packages) ? draft.packages : [];
  for (const p of packages) {
    if (p && p.packageId && Array.isArray(p.prices) && p.prices[0] && Number.isInteger(p.prices[0].amountCents)) {
      return {
        kind: 'package',
        id: p.packageId,
        originalCents: p.prices[0].amountCents,
        path: ['packages', packages.indexOf(p), 'prices', 0, 'amountCents'],
      };
    }
  }
  return null;
}

function readCents(draft, target) {
  if (target.kind === 'addon') {
    const a = (draft.addOns || []).find((x) => x.addOnId === target.id);
    return a && a.prices && a.prices[0] ? a.prices[0].amountCents : null;
  }
  const p = (draft.packages || []).find((x) => x.packageId === target.id);
  return p && p.prices && p.prices[0] ? p.prices[0].amountCents : null;
}

function setCents(draft, target, cents) {
  if (target.kind === 'addon') {
    const a = (draft.addOns || []).find((x) => x.addOnId === target.id);
    assert(a && a.prices && a.prices[0], 'addon_price_row_missing');
    a.prices[0].amountCents = cents;
    return;
  }
  const p = (draft.packages || []).find((x) => x.packageId === target.id);
  assert(p && p.prices && p.prices[0], 'package_price_row_missing');
  p.prices[0].amountCents = cents;
}

function stripServerManaged(draft) {
  const clean = { ...draft };
  for (const k of ['draftId', 'updatedAt', 'updatedBy', 'lastSavedAt', 'lastSavedBy']) delete clean[k];
  return clean;
}

async function main() {
  refuseIfNotStaging();
  const results = {
    ok: false,
    baseHost: new URL(BASE).hostname,
    stagingSiteIdExpected: STAGING_SITE_ID,
  };

  const creds = loadAdminCreds();
  assert(creds, 'missing_staging_admin_credentials');
  results.authSource = creds.source;
  results.adminUserLen = String(creds.username).length;

  const login = await req('POST', '/.netlify/functions/admin-auth', {
    body: { action: 'login', username: creds.username, password: creds.password },
  });
  assert(login.status === 200 && login.json && login.json.ok && login.json.token, `login_failed:${login.status}:${login.json && login.json.error}`);
  const token = login.json.token;
  results.login = { status: login.status, ok: true, tokenLen: token.length, setCookie: login.setCookie };

  const auth = { 'x-admin-key': token };

  const csrf = await req('GET', '/.netlify/functions/owner-studio-catalog?action=csrf', { headers: auth });
  assert(csrf.status === 200 && csrf.json && csrf.json.csrfToken, `csrf_failed:${csrf.status}`);
  const csrfToken = csrf.json.csrfToken;
  results.csrf = { status: csrf.status, ok: true, siteId: csrf.json.siteId };
  assert(csrf.json.siteId === 'detailing-zone', 'unexpected_site_id');

  const get1 = await req('GET', '/.netlify/functions/owner-studio-catalog?action=get_draft', { headers: auth });
  assert(get1.status === 200 && get1.json && get1.json.ok && get1.json.draft, `get_draft_failed:${get1.status}:${get1.json && get1.json.error}`);
  const draft1 = get1.json.draft;
  const originalVersion = Number(draft1.version);
  assert(Number.isInteger(originalVersion) && originalVersion >= 1, 'invalid_original_version');
  results.get1 = {
    status: get1.status,
    version: originalVersion,
    packageCount: (draft1.packages || []).length,
    addOnCount: (draft1.addOns || []).length,
    persistence: get1.json.persistence,
    schemaReady: !!(get1.json.ownerStudioCatalogSchema && get1.json.ownerStudioCatalogSchema.ready),
  };

  const target = findPriceTarget(draft1);
  assert(target, 'no_safe_price_target');
  const originalCents = target.originalCents;
  // Temporary reversible test price — distinct from original, valid integer cents.
  let tempCents = originalCents === 4242 ? 4343 : 4242;
  results.target = {
    kind: target.kind,
    idHash: sha12(target.id),
    originalCents,
    tempCents,
    originalVersion,
  };

  const edited = JSON.parse(JSON.stringify(draft1));
  setCents(edited, target, tempCents);
  // Forge a client siteId — server must ignore/override.
  edited.siteId = 'forged-client-site-should-ignore';

  const mutHeaders = { ...auth, 'x-csrf-token': csrfToken };
  const save = await req('POST', '/.netlify/functions/owner-studio-catalog', {
    headers: mutHeaders,
    body: {
      action: 'save_draft',
      expectedVersion: originalVersion,
      draft: stripServerManaged(edited),
      siteId: 'forged-body-site-should-ignore',
    },
  });
  assert(save.status === 200 && save.json && save.json.ok && save.json.draft, `save_failed:${save.status}:${(save.json && (save.json.error || save.json.message)) || save.text}`);
  const saved = save.json.draft;
  const savedVersion = Number(saved.version);
  assert(savedVersion === originalVersion + 1, `version_not_incremented:${originalVersion}->${savedVersion}`);
  assert(readCents(saved, target) === tempCents, 'save_response_missing_temp_price');
  assert(saved.siteId === 'detailing-zone', 'forged_site_id_not_overridden');
  results.save = {
    status: save.status,
    version: savedVersion,
    versionIncremented: true,
    tempPricePresent: true,
    siteIdTrusted: saved.siteId === 'detailing-zone',
    revisionIdPresent: !!save.json.revisionId,
  };

  const get2 = await req('GET', '/.netlify/functions/owner-studio-catalog?action=get_draft', { headers: auth });
  assert(get2.status === 200 && get2.json && get2.json.draft, `reload_get_failed:${get2.status}`);
  assert(Number(get2.json.draft.version) === savedVersion, 'reload_version_mismatch');
  assert(readCents(get2.json.draft, target) === tempCents, 'reload_price_not_persisted');
  results.reloadGet = { status: get2.status, version: get2.json.draft.version, tempPricePersisted: true };

  // Stale write with original version must 409.
  const staleDraft = JSON.parse(JSON.stringify(get2.json.draft));
  setCents(staleDraft, target, originalCents === 9999 ? 8888 : 9999);
  const stale = await req('POST', '/.netlify/functions/owner-studio-catalog', {
    headers: mutHeaders,
    body: {
      action: 'save_draft',
      expectedVersion: originalVersion,
      draft: stripServerManaged(staleDraft),
    },
  });
  assert(stale.status === 409, `stale_expected_409_got_${stale.status}`);
  assert(stale.json && stale.json.error === 'stale_catalog_draft_version', `stale_error_mismatch:${stale.json && stale.json.error}`);
  results.staleWrite = {
    status: stale.status,
    error: stale.json.error,
  };

  // Both catalog data views must agree.
  const entities = await req('GET', '/.netlify/functions/owner-studio-catalog?action=list_entities', { headers: auth });
  assert(entities.status === 200 && entities.json && entities.json.ok, `list_entities_failed:${entities.status}`);
  let entitiesCents = null;
  if (target.kind === 'addon') {
    const a = (entities.json.addOns || []).find((x) => x.addOnId === target.id);
    entitiesCents = a && a.prices && a.prices[0] ? a.prices[0].amountCents : null;
  } else {
    const p = (entities.json.packages || []).find((x) => x.packageId === target.id);
    entitiesCents = p && p.prices && p.prices[0] ? p.prices[0].amountCents : null;
  }
  assert(entitiesCents === tempCents, 'list_entities_price_mismatch');
  results.viewsAgree = {
    getDraftCents: tempCents,
    listEntitiesCents: entitiesCents,
    same: true,
    getDraftKeys: Object.keys(get2.json.draft || {}).sort(),
    listEntitiesKeys: Object.keys(entities.json || {}).sort(),
  };

  // Cookie-only second-tab simulation: same saved value.
  const cookieGet = await req('GET', '/.netlify/functions/owner-studio-catalog?action=get_draft', {
    headers: { cookie: `cd1_admin_session=${encodeURIComponent(token)}` },
  });
  assert(cookieGet.status === 200 && cookieGet.json && cookieGet.json.draft, `cookie_tab_get_failed:${cookieGet.status}`);
  assert(readCents(cookieGet.json.draft, target) === tempCents, 'cookie_tab_price_mismatch');
  results.secondTabCookieOnly = {
    status: cookieGet.status,
    version: cookieGet.json.draft.version,
    tempPriceVisible: true,
  };

  // Restore original price.
  const restoreDraft = JSON.parse(JSON.stringify(get2.json.draft));
  setCents(restoreDraft, target, originalCents);
  const restore = await req('POST', '/.netlify/functions/owner-studio-catalog', {
    headers: mutHeaders,
    body: {
      action: 'save_draft',
      expectedVersion: savedVersion,
      draft: stripServerManaged(restoreDraft),
    },
  });
  assert(restore.status === 200 && restore.json && restore.json.ok, `restore_failed:${restore.status}`);
  assert(readCents(restore.json.draft, target) === originalCents, 'restore_response_price_mismatch');
  results.restore = {
    status: restore.status,
    version: restore.json.draft.version,
  };

  const get3 = await req('GET', '/.netlify/functions/owner-studio-catalog?action=get_draft', { headers: auth });
  assert(get3.status === 200 && get3.json && get3.json.draft, `final_get_failed:${get3.status}`);
  assert(readCents(get3.json.draft, target) === originalCents, 'final_get_not_restored');
  results.finalGet = {
    status: get3.status,
    version: get3.json.draft.version,
    originalRestored: true,
  };

  results.ok = true;
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.log(JSON.stringify({
    ok: false,
    error: String(e && e.message || e).slice(0, 240),
  }, null, 2));
  process.exit(1);
});
