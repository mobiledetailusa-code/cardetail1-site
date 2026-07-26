'use strict';

/**
 * Phase A — multi-tab admin session (HttpOnly cookie) + Owner Studio catalog
 * load error handling + concurrency. Root cause of the multi-tab blocker: the
 * admin token lived only in per-tab sessionStorage, so a new tab sent no
 * x-admin-key and got 401. Fix: a shared HttpOnly session cookie that
 * verifyAdminRequest also accepts.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SECRET = 'phasea-secret-phasea-secret-phasea-32ch';
process.env.ADMIN_SESSION_SECRET = SECRET;
process.env.ADMIN_DASH_PASSWORD = 'supersecretpw';
process.env.ADMIN_USERNAME = 'admin';

const security = require('../netlify/lib/admin-security');
const adminAuth = require('../netlify/functions/admin-auth');
const { createMemoryCatalogRepository } = require('../netlify/lib/owner-studio/catalog-repository');
const { SITE_ID } = require('../netlify/lib/owner-studio/ids');

const catalogHtml = fs.readFileSync(path.join(__dirname, '..', 'admin-owner-studio-catalog.html'), 'utf8');
const sessionClient = fs.readFileSync(path.join(__dirname, '..', 'netlify', 'lib', 'admin-session-client.js'), 'utf8');

function cookieHeaderFor(token) {
  return { cookie: `${security.ADMIN_COOKIE_NAME}=${encodeURIComponent(token)}` };
}

describe('Phase A — admin session is browser-scoped via HttpOnly cookie', () => {
  let token;
  before(async () => {
    token = (await security.createAdminSession('admin')).token;
  });

  it('a second tab authenticates from the shared cookie with no x-admin-key header', async () => {
    const res = await security.verifyAdminRequest(cookieHeaderFor(token));
    assert.equal(res.ok, true);
    assert.equal(res.username, 'admin');
  });

  it('the first tab still authenticates from the x-admin-key header (back-compat)', async () => {
    const res = await security.verifyAdminRequest({ 'x-admin-key': token });
    assert.equal(res.ok, true);
  });

  it('a missing session (no header, no cookie) returns unauthorized', async () => {
    const res = await security.verifyAdminRequest({});
    assert.equal(res.ok, false);
    assert.equal(res.error, 'unauthorized');
  });

  it('a tampered cookie token is rejected', async () => {
    const res = await security.verifyAdminRequest(cookieHeaderFor(token.slice(0, -3) + 'xyz'));
    assert.equal(res.ok, false);
  });

  it('login sets an HttpOnly, Secure, SameSite session cookie carrying the token', async () => {
    const resp = await adminAuth.handler({
      httpMethod: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'login', username: 'admin', password: 'supersecretpw' }),
    });
    assert.equal(resp.statusCode, 200);
    const setCookie = resp.headers['Set-Cookie'] || resp.headers['set-cookie'];
    assert.ok(setCookie, 'login must set a session cookie');
    assert.match(setCookie, new RegExp('^' + security.ADMIN_COOKIE_NAME + '='));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Secure/); // CONTEXT unset in tests → treated as deployed https
    assert.match(setCookie, /Max-Age=\d+/);
    // The cookie must authenticate a fresh tab.
    const body = JSON.parse(resp.body);
    const viaCookie = await security.verifyAdminRequest(cookieHeaderFor(body.token));
    assert.equal(viaCookie.ok, true);
  });

  it('logout clears the shared cookie (Max-Age=0) so other tabs lose auth', async () => {
    const resp = await adminAuth.handler({
      httpMethod: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'logout', token }),
    });
    assert.equal(resp.statusCode, 200);
    const setCookie = resp.headers['Set-Cookie'] || resp.headers['set-cookie'];
    assert.match(setCookie, /Max-Age=0/);
  });

  it('cookie is HttpOnly so the raw session secret is never exposed to JS', () => {
    assert.match(security.adminSessionCookieHeader('tok'), /HttpOnly/);
    // The browser client stores the convenience token in sessionStorage, never localStorage.
    assert.doesNotMatch(sessionClient, /localStorage/);
    // And never puts the token in a URL/query string.
    assert.doesNotMatch(catalogHtml, /[?&](token|adminKey|x-admin-key)=/i);
  });

  it('the browser client exposes a non-secret cross-tab logout signal (BroadcastChannel)', () => {
    assert.match(sessionClient, /BroadcastChannel/);
    assert.match(sessionClient, /onSessionEvent/);
    assert.match(sessionClient, /broadcastSession\('logout'\)/);
    // The catalog page listens and signs out this tab on a logout from another tab.
    assert.match(catalogHtml, /onSessionEvent/);
    assert.match(catalogHtml, /Signed out in another tab/);
  });
});

describe('Phase A — catalog load failures never render an empty catalog', () => {
  it('differentiates 401 / 403 / 409 / 429 / 500 / network in the UI', () => {
    assert.match(catalogHtml, /function classifyFailure/);
    assert.match(catalogHtml, /status === 401/);
    assert.match(catalogHtml, /status === 403/);
    assert.match(catalogHtml, /status === 409/);
    assert.match(catalogHtml, /status === 429/);
    assert.match(catalogHtml, /status >= 500/);
    assert.match(catalogHtml, /status === 0/); // network
  });

  it('only an auth failure clears the loaded catalog (429/500/network keep session)', () => {
    assert.match(catalogHtml, /if \(f\.authRequired\) \{ state\.draft = null/);
    assert.match(catalogHtml, /keepSession: true/);
  });

  it('a valid empty catalog is distinguishable from a request failure', () => {
    assert.match(catalogHtml, /No catalog draft exists yet \(empty\)/);
    // Failure path shows the classified message, not an empty render.
    assert.match(catalogHtml, /showFailure\(res, data\)/);
  });

  it('network errors are caught and never mistaken for an empty response', () => {
    assert.match(catalogHtml, /catch \(e\) \{[\s\S]*status: 0/);
  });
});

describe('Phase A — concurrent tabs: stale save is rejected, no overwrite', () => {
  it('two tabs load version N; tab A saves N+1; tab B stale save returns 409 and cannot overwrite', async () => {
    const repo = createMemoryCatalogRepository();
    await repo.createCatalogDraft(SITE_ID, 'owner');
    const base = {
      siteId: SITE_ID,
      packages: [{
        siteId: SITE_ID, packageId: 'pkg_full_detail', legacyKey: 'full', category: 'cars',
        name: 'Full Detail', slug: 'full-detail', description: '', shortDescription: '',
        active: true, featured: false, displayOrder: 0, features: [],
        prices: [{ packageId: 'pkg_full_detail', vehicleClassId: 'vc_sedan', currency: 'usd', amountCents: 28500, priceModel: 'flat' }],
        compatibleVehicleClassIds: ['vc_sedan'], compatibleAddOnIds: [],
      }],
      addOns: [], vehicleClasses: [{ siteId: SITE_ID, vehicleClassId: 'vc_sedan', legacyKey: 'small', category: 'cars', label: 'Sedan', active: true, displayOrder: 0 }],
      navigation: { siteId: SITE_ID, headerItems: [] }, footer: { siteId: SITE_ID, tagline: '', groups: [], legalLinks: [], copyright: '' },
      pages: [], galleries: [], serviceAreas: [], media: [], priceConflicts: [], unmappedContent: [],
    };
    await repo.saveCatalogDraft(SITE_ID, 1, base, 'seed'); // → version 2

    // Both tabs read the same draft (version N).
    const tabA = await repo.getCatalogDraft(SITE_ID);
    const tabB = await repo.getCatalogDraft(SITE_ID);
    assert.equal(tabA.version, tabB.version);
    const N = tabA.version;

    // Tab A saves a price change → N+1.
    const aEdit = JSON.parse(JSON.stringify(tabA));
    aEdit.packages[0].prices[0].amountCents = 30000;
    const savedA = await repo.saveCatalogDraft(SITE_ID, N, aEdit, 'tabA');
    assert.equal(savedA.draft.version, N + 1);

    // Tab B attempts a stale save at version N → must 409 and NOT overwrite.
    const bEdit = JSON.parse(JSON.stringify(tabB));
    bEdit.packages[0].prices[0].amountCents = 99999; // would clobber tab A
    await assert.rejects(
      () => repo.saveCatalogDraft(SITE_ID, N, bEdit, 'tabB'),
      (err) => err.code === 'stale_draft_version' && err.statusCode === 409
    );

    // Tab A's value remains authoritative — tab B did not auto-merge/overwrite.
    const current = await repo.getCatalogDraft(SITE_ID);
    assert.equal(current.packages[0].prices[0].amountCents, 30000);
    assert.equal(current.version, N + 1);
  });
});
