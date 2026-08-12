'use strict';

/**
 * Stage 6 — release API gates.
 *
 * The point of these tests is the gate order and the default-off switch, not the
 * repository behaviour (covered in owner-studio-release-repository.test.js).
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const FN = path.join(__dirname, '..', 'netlify', 'functions', 'owner-studio-release.js');
const SECURITY = path.join(__dirname, '..', 'netlify', 'lib', 'admin-security.js');
const PRISMA = path.join(__dirname, '..', 'netlify', 'lib', 'prisma.js');
const ORIGIN = path.join(__dirname, '..', 'netlify', 'lib', 'trusted-site-origin.js');

const { createFakePrisma } = require('./helpers/fake-prisma');
const { SITE_ID } = require('../netlify/lib/owner-studio/ids');
const { createCsrfToken } = require('../netlify/lib/owner-studio/authorization');

const SECRET = 'test-admin-session-secret-value';
const SESSION_TOKEN = 'sess-token-abcdef0123456789';
const ORIGIN_URL = 'https://staging.example.com';

let savedEnv;
let fakePrisma;

function draftPayload() {
  return {
    siteId: SITE_ID,
    vehicleClasses: [{ siteId: SITE_ID, vehicleClassId: 'vc_small', legacyKey: 'small', category: 'cars', label: 'Small', active: true, displayOrder: 1 }],
    packages: [{
      siteId: SITE_ID, packageId: 'pkg_full', legacyKey: 'full', category: 'cars', name: 'Full',
      slug: 'full', active: true, displayOrder: 1, features: [],
      compatibleVehicleClassIds: ['vc_small'], compatibleAddOnIds: [],
      prices: [{ packageId: 'pkg_full', vehicleClassId: 'vc_small', currency: 'usd', amountCents: 24000, priceModel: 'flat' }],
    }],
    addOns: [], navigation: { siteId: SITE_ID, headerItems: [] },
    footer: { siteId: SITE_ID, tagline: '', groups: [], legalLinks: [], copyright: '' },
    pages: [], galleries: [], serviceAreas: [], media: [],
  };
}

/** Load the handler with admin-security, prisma and origin policy stubbed. */
function loadHandler({ authOk = true } = {}) {
  for (const m of [FN, SECURITY, PRISMA, ORIGIN]) delete require.cache[require.resolve(m)];
  require.cache[require.resolve(SECURITY)] = {
    id: SECURITY, filename: SECURITY, loaded: true,
    exports: { verifyAdminRequest: async () => (authOk ? { ok: true, username: 'owner', token: SESSION_TOKEN } : { ok: false }) },
  };
  require.cache[require.resolve(PRISMA)] = {
    id: PRISMA, filename: PRISMA, loaded: true,
    exports: { tryGetPrisma: () => fakePrisma, prismaConfigured: () => true },
  };
  require.cache[require.resolve(ORIGIN)] = {
    id: ORIGIN, filename: ORIGIN, loaded: true,
    exports: { isMutationOriginAllowed: (o) => o === ORIGIN_URL },
  };
  return require(FN).handler;
}

function post(body, { csrf = true, origin = ORIGIN_URL } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (origin) headers.origin = origin;
  if (csrf) headers['x-csrf-token'] = createCsrfToken(SESSION_TOKEN, SECRET);
  return { httpMethod: 'POST', headers, body: JSON.stringify(body), queryStringParameters: {} };
}

beforeEach(() => {
  savedEnv = { ...process.env };
  process.env.ADMIN_SESSION_SECRET = SECRET;
  process.env.OWNER_STUDIO_ENABLED = 'true';
  process.env.OWNER_STUDIO_ROLE = 'owner';
  delete process.env.OWNER_STUDIO_PUBLISH_ENABLED;
  fakePrisma = createFakePrisma({
    osSite: [{ siteId: SITE_ID, name: 'Cardetail1', status: 'active' }],
    osCatalogDraft: [{ siteId: SITE_ID, version: 1, payload: draftPayload(), updatedBy: 'owner' }],
  });
});

afterEach(() => { process.env = savedEnv; });

describe('release API gates', () => {
  it('rejects an unauthenticated caller before anything else', async () => {
    const handler = loadHandler({ authOk: false });
    const res = await handler(post({ action: 'publish', expectedDraftVersion: 1 }));
    assert.equal(res.statusCode, 401);
    assert.equal(fakePrisma.__committed('osPublishedRelease').length, 0);
  });

  it('rejects a cross-origin mutation', async () => {
    const handler = loadHandler();
    const res = await handler(post({ action: 'publish', expectedDraftVersion: 1 }, { origin: 'https://evil.example' }));
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'untrusted_origin');
  });

  it('rejects a missing or forged CSRF token', async () => {
    const handler = loadHandler();
    const res = await handler(post({ action: 'publish', expectedDraftVersion: 1 }, { csrf: false }));
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'csrf_invalid');
  });

  /**
   * The switch this increment exists for. Every other gate is satisfied here — real
   * session, same origin, valid CSRF, owner role, Owner Studio enabled — and publish
   * still must not happen.
   */
  it('refuses to publish while OWNER_STUDIO_PUBLISH_ENABLED is unset', async () => {
    const handler = loadHandler();
    const res = await handler(post({ action: 'publish', expectedDraftVersion: 1 }));
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'publication_not_enabled');
    assert.equal(fakePrisma.__committed('osPublishedRelease').length, 0);
  });

  it('refuses rollback under the same switch', async () => {
    const handler = loadHandler();
    const res = await handler(post({ action: 'rollback', releaseId: 'rel_x' }));
    assert.equal(JSON.parse(res.body).error, 'publication_not_enabled');
  });

  it('reports the grant failure, not the switch, to a caller who lacks it', async () => {
    process.env.OWNER_STUDIO_ROLE = 'admin';       // admin without adminCanPublish
    process.env.OWNER_STUDIO_PUBLISH_ENABLED = 'true';
    const handler = loadHandler();
    const res = await handler(post({ action: 'publish', expectedDraftVersion: 1 }));
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'owner_studio_publish_denied',
      'an unauthorized caller must not learn whether publishing is switched on');
  });

  it('publishes once every gate is satisfied', async () => {
    process.env.OWNER_STUDIO_PUBLISH_ENABLED = 'true';
    const handler = loadHandler();
    const res = await handler(post({ action: 'publish', expectedDraftVersion: 1 }));
    assert.equal(res.statusCode, 201);
    const out = JSON.parse(res.body);
    assert.match(out.releaseId, /^rel_/);
    assert.equal(fakePrisma.__committed('osCurrentReleasePointer')[0].releaseId, out.releaseId);
  });

  it('surfaces a stale draft version without leaking the error message', async () => {
    process.env.OWNER_STUDIO_PUBLISH_ENABLED = 'true';
    const handler = loadHandler();
    const res = await handler(post({ action: 'publish', expectedDraftVersion: 99 }));
    assert.equal(res.statusCode, 409);
    const out = JSON.parse(res.body);
    assert.equal(out.error, 'stale_catalog_draft_version');
    assert.equal(out.actualVersion, 1);
    assert.equal(out.message, undefined, 'error bodies carry codes, not internal messages');
  });

  it('is denied entirely while Owner Studio is disabled', async () => {
    process.env.OWNER_STUDIO_ENABLED = 'false';
    process.env.OWNER_STUDIO_PUBLISH_ENABLED = 'true';
    const handler = loadHandler();
    const res = await handler(post({ action: 'publish', expectedDraftVersion: 1 }));
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'owner_studio_disabled');
  });
});

describe('release history is readable without the publish grant', () => {
  it('returns the current release and the switch state', async () => {
    const handler = loadHandler();
    const res = await handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { action: 'current' } });
    assert.equal(res.statusCode, 200);
    const out = JSON.parse(res.body);
    assert.equal(out.release, null, 'nothing published yet');
    assert.equal(out.publishEnabled, false);
  });

  it('never returns full snapshots in history', async () => {
    process.env.OWNER_STUDIO_PUBLISH_ENABLED = 'true';
    const handler = loadHandler();
    await handler(post({ action: 'publish', expectedDraftVersion: 1 }));
    const res = await handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { action: 'history' } });
    const out = JSON.parse(res.body);
    assert.equal(out.releases.length, 1);
    assert.ok(out.releases[0].manifest, 'the manifest is the summary');
    assert.equal(out.releases[0].catalogJson, undefined);
    assert.equal(out.releases[0].contentJson, undefined);
  });
});
