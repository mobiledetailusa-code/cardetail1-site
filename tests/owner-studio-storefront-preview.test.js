'use strict';

/**
 * Stage 4B-1 — authenticated storefront catalog preview API.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { SITE_ID } = require('../netlify/lib/owner-studio/ids');
const {
  createMemoryCatalogRepository,
  emptyPayload,
} = require('../netlify/lib/owner-studio/catalog-repository');
const { buildStorefrontPreviewCatalog } = require('../netlify/lib/owner-studio/storefront-preview');
const previewFn = require('../netlify/functions/owner-studio-catalog-preview');

const ROOT = path.join(__dirname, '..');

const SAMPLE_VC = {
  siteId: SITE_ID,
  vehicleClassId: 'vc_sedan',
  legacyKey: 'small',
  category: 'cars',
  label: 'Sedan',
  active: true,
  displayOrder: 0,
};

const SAMPLE_ADDON = {
  siteId: SITE_ID,
  addOnId: 'addon_pet_hair',
  legacyKey: 'pethair',
  name: 'Pet Hair',
  slug: 'pet-hair',
  description: 'Pet hair removal',
  active: true,
  allowQuantity: false,
  displayOrder: 1,
  prices: [{ category: 'cars', currency: 'usd', amountCents: 4500 }],
  compatibility: [{ category: 'cars' }],
};

const INACTIVE_ADDON = {
  ...SAMPLE_ADDON,
  addOnId: 'addon_ozone',
  legacyKey: 'ozone',
  name: 'Ozone',
  slug: 'ozone',
  active: false,
  displayOrder: 9,
  prices: [{ category: 'cars', currency: 'usd', amountCents: 4000 }],
};

const SAMPLE_PKG = {
  siteId: SITE_ID,
  packageId: 'pkg_full_detail',
  legacyKey: 'full',
  category: 'cars',
  name: 'Full Detail',
  slug: 'full-detail',
  description: 'Full detail',
  shortDescription: 'Full',
  active: true,
  featured: true,
  displayOrder: 2,
  features: [{ kind: 'included', label: 'Wash', sortOrder: 0 }],
  prices: [{
    packageId: 'pkg_full_detail',
    vehicleClassId: 'vc_sedan',
    currency: 'usd',
    amountCents: 28500,
    priceModel: 'flat',
  }],
  compatibleVehicleClassIds: ['vc_sedan'],
  compatibleAddOnIds: ['addon_pet_hair'],
};

const INACTIVE_PKG = {
  ...SAMPLE_PKG,
  packageId: 'pkg_paint_refresh',
  legacyKey: 'refresh',
  name: 'Paint Refresh',
  slug: 'paint-refresh',
  active: false,
  displayOrder: 0,
  featured: false,
  compatibleAddOnIds: ['addon_pet_hair'],
  prices: [{
    packageId: 'pkg_paint_refresh',
    vehicleClassId: 'vc_sedan',
    currency: 'usd',
    amountCents: 37500,
    priceModel: 'flat',
  }],
};

function sampleDraft(overrides = {}) {
  return {
    siteId: SITE_ID,
    packages: [SAMPLE_PKG, INACTIVE_PKG],
    addOns: [SAMPLE_ADDON, INACTIVE_ADDON],
    vehicleClasses: [SAMPLE_VC],
    priceConflicts: [{
      conflictId: 'conflict_1_hub',
      entityType: 'package_price',
      entityId: 'pkg_full_detail',
      field: 'cars.tiers.small.full',
      serverValue: 285,
      presentationValue: 300,
      serverCents: 28500,
      presentationCents: 30000,
      sources: ['bergen-county-hub.html'],
      status: 'unresolved',
      resolution: null,
      resolvedBy: null,
      resolvedAt: null,
      message: 'hub conflict',
    }],
    unmappedContent: [
      { path: 'index.html', reason: 'deferred' },
      { path: 'assets/partials/specialty-public-footer.html', reason: 'deferred' },
      { path: '*-hub.html', reason: 'deferred' },
      { path: 'terms-conditions.html', reason: 'deferred' },
    ],
    navigation: { siteId: SITE_ID, headerItems: [] },
    footer: { siteId: SITE_ID, tagline: '', groups: [], legalLinks: [], copyright: '' },
    pages: [],
    galleries: [],
    serviceAreas: [],
    media: [],
    ...overrides,
  };
}

function parseBody(res) {
  return JSON.parse(res.body || '{}');
}

describe('owner-studio storefront catalog preview API (4B-1)', () => {
  let repo;
  let saveSpyCalls;

  beforeEach(async () => {
    process.env.OWNER_STUDIO_ENABLED = 'true';
    process.env.PUBLIC_CONTENT_SOURCE = 'legacy';
    previewFn._test.reset();
    repo = createMemoryCatalogRepository();
    await repo.createCatalogDraft(SITE_ID, 'tester');
    await repo.saveCatalogDraft(SITE_ID, 1, sampleDraft(), 'owner');

    saveSpyCalls = 0;
    const originalSave = repo.saveCatalogDraft.bind(repo);
    repo.saveCatalogDraft = async (...args) => {
      saveSpyCalls += 1;
      return originalSave(...args);
    };
    const originalCreate = repo.createCatalogDraft.bind(repo);
    repo.createCatalogDraft = async (...args) => {
      saveSpyCalls += 1;
      return originalCreate(...args);
    };
    const originalRestore = repo.restoreRevisionAsNewDraft.bind(repo);
    repo.restoreRevisionAsNewDraft = async (...args) => {
      saveSpyCalls += 1;
      return originalRestore(...args);
    };

    previewFn._test.setRepoFactory(() => repo);
    previewFn._test.setVerifyAdmin(async () => ({
      ok: true,
      username: 'owner',
      token: 'test-session-token',
    }));
  });

  afterEach(() => {
    previewFn._test.reset();
  });

  it('1. unauthenticated request returns 401', async () => {
    previewFn._test.setVerifyAdmin(async () => ({ ok: false }));
    const res = await previewFn.handler({
      httpMethod: 'GET',
      headers: {},
      queryStringParameters: {},
    });
    assert.equal(res.statusCode, 401);
    const body = parseBody(res);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'unauthorized');
    assert.equal(body.preview, false);
  });

  it('2. authorized Admin receives preview', async () => {
    const res = await previewFn.handler({
      httpMethod: 'GET',
      headers: { cookie: 'cd1_admin_session=fake' },
      queryStringParameters: {},
    });
    assert.equal(res.statusCode, 200);
    const body = parseBody(res);
    assert.equal(body.ok, true);
    assert.equal(body.preview, true);
    assert.equal(body.siteId, SITE_ID);
    assert.equal(body.draftVersion, 2);
    assert.ok(body.savedAt);
    assert.equal(body.banner, 'DRAFT PREVIEW — NOT PUBLISHED');
    assert.ok(Array.isArray(body.packages));
    assert.ok(Array.isArray(body.addOns));
  });

  it('3. response is private/no-store', async () => {
    const res = await previewFn.handler({
      httpMethod: 'GET',
      headers: {},
      queryStringParameters: {},
    });
    assert.match(String(res.headers['Cache-Control'] || ''), /private/i);
    assert.match(String(res.headers['Cache-Control'] || ''), /no-store/i);
  });

  it('4. packages/add-ons come from OsCatalogDraft', async () => {
    const draft = await repo.getCatalogDraft(SITE_ID);
    const res = await previewFn.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: {} });
    const body = parseBody(res);
    assert.equal(body.packages[0].packageId, 'pkg_full_detail');
    assert.equal(body.packages[0].name, draft.packages.find((p) => p.active).name);
    // legacyKey is the stable mapping id used by the storefront adapter (Stage 4B-2).
    assert.equal(body.packages[0].legacyKey, 'full');
    assert.equal(body.addOns[0].addOnId, 'addon_pet_hair');
    assert.equal(body.addOns[0].legacyKey, 'pethair');
    assert.equal(body.addOns[0].prices[0].amountCents, 4500);
  });

  it('5. prices remain integer cents', async () => {
    const res = await previewFn.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: {} });
    const body = parseBody(res);
    for (const pkg of body.packages) {
      for (const price of pkg.prices) {
        assert.equal(typeof price.amountCents, 'number');
        assert.ok(Number.isInteger(price.amountCents));
        assert.ok(price.amountCents >= 0);
      }
    }
    for (const addon of body.addOns) {
      for (const price of addon.prices) {
        assert.ok(Number.isInteger(price.amountCents));
      }
    }
    assert.equal(body.packages[0].prices[0].amountCents, 28500);
  });

  it('6. malformed/negative prices fail closed', () => {
    assert.throws(
      () => buildStorefrontPreviewCatalog(sampleDraft({
        packages: [{
          ...SAMPLE_PKG,
          prices: [{ ...SAMPLE_PKG.prices[0], amountCents: -100 }],
        }],
        addOns: [SAMPLE_ADDON],
      })),
      (err) => err.code === 'money_negative' || /negative|amountCents/i.test(String(err.message))
    );
    assert.throws(
      () => buildStorefrontPreviewCatalog(sampleDraft({
        packages: [{
          ...SAMPLE_PKG,
          prices: [{ ...SAMPLE_PKG.prices[0], amountCents: 12.5 }],
        }],
        addOns: [SAMPLE_ADDON],
      })),
      (err) => err.code === 'money_not_integer' || err.code === 'floating_point_money_forbidden' || /integer|float/i.test(String(err.message))
    );
  });

  it('7. inactive items are excluded (unless diagnostic flag)', async () => {
    const res = await previewFn.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: {} });
    const body = parseBody(res);
    assert.equal(body.packages.length, 1);
    assert.equal(body.addOns.length, 1);
    assert.ok(!body.packages.some((p) => p.packageId === 'pkg_paint_refresh'));
    assert.ok(!body.addOns.some((a) => a.addOnId === 'addon_ozone'));

    const withInactive = await previewFn.handler({
      httpMethod: 'GET',
      headers: {},
      queryStringParameters: { includeInactive: '1' },
    });
    const body2 = parseBody(withInactive);
    assert.ok(body2.packages.some((p) => p.packageId === 'pkg_paint_refresh' && p.active === false));
    assert.ok(body2.addOns.some((a) => a.addOnId === 'addon_ozone' && a.active === false));
  });

  it('8. internal revision/audit data is absent', async () => {
    const res = await previewFn.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: {} });
    const body = parseBody(res);
    const raw = JSON.stringify(body);
    assert.equal(body.draftId, undefined);
    assert.equal(body.updatedBy, undefined);
    assert.equal(body.lastSavedBy, undefined);
    assert.equal(body.revisions, undefined);
    assert.equal(body.audit, undefined);
    assert.equal(body.priceConflicts.count, 1);
    assert.equal(body.priceConflicts.conflictId, undefined);
    assert.doesNotMatch(raw, /test-session-token/);
    assert.doesNotMatch(raw, /csrf/i);
    assert.doesNotMatch(raw, /resolvedBy/);
    assert.doesNotMatch(raw, /conflict_1_hub/);
    assert.doesNotMatch(raw, /"revisionId"/);
  });

  it('9. endpoint performs no database mutation', async () => {
    const before = await repo.getCatalogDraft(SITE_ID);
    const versionBefore = before.version;
    const auditsBefore = (repo._memory.audits || []).length;
    const revisionsBefore = (await repo.listCatalogRevisions(SITE_ID)).total;

    await previewFn.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: {} });

    const after = await repo.getCatalogDraft(SITE_ID);
    assert.equal(after.version, versionBefore);
    assert.equal(saveSpyCalls, 0);
    assert.equal((repo._memory.audits || []).length, auditsBefore);
    assert.equal((await repo.listCatalogRevisions(SITE_ID)).total, revisionsBefore);
  });

  it('10. endpoint does not call Stripe/payment/booking services', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'netlify', 'functions', 'owner-studio-catalog-preview.js'),
      'utf8'
    );
    const lib = fs.readFileSync(
      path.join(ROOT, 'netlify', 'lib', 'owner-studio', 'storefront-preview.js'),
      'utf8'
    );
    for (const file of [src, lib]) {
      assert.doesNotMatch(file, /require\(['"][^'"]*stripe/i);
      assert.doesNotMatch(file, /require\(['"][^'"]*payment/i);
      assert.doesNotMatch(file, /require\(['"][^'"]*booking-price-catalog/);
      assert.doesNotMatch(file, /require\(['"][^'"]*submit-booking/);
      assert.doesNotMatch(file, /createPaymentIntent|PaymentIntent|prepareBalanceCheckout/);
      assert.doesNotMatch(file, /publishRelease|OsCurrentReleasePointer/);
      assert.doesNotMatch(file, /saveCatalogDraft|restoreRevisionAsNewDraft/);
    }
  });

  it('11. legacy storefront behavior remains unchanged', () => {
    const booking = fs.readFileSync(path.join(ROOT, 'netlify', 'lib', 'booking-price-catalog.js'), 'utf8');
    assert.match(booking, /small:[\s\S]*full:\s*285/);
    const flags = fs.readFileSync(path.join(ROOT, 'netlify', 'lib', 'owner-studio', 'flags.js'), 'utf8');
    assert.match(flags, /PUBLIC_CONTENT_SOURCE/);
    const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    // 4B-2: PRICING is reassignable (let) so the saved draft replaces it before init.
    assert.match(index, /\blet PRICING\s*=/);
    // 4B-2: preview IS wired, but only behind the ?os_preview=1 gate — no request otherwise.
    assert.match(index, /if\(osPreviewRequested\(\)\)\{\s*osBootstrapPreview\(\)/);
    assert.equal((index.match(/owner-studio-catalog-preview/g) || []).length, 1);
  });

  it('12. missing draft returns stable 404; empty valid draft is previewable', async () => {
    const emptyRepo = createMemoryCatalogRepository();
    previewFn._test.setRepoFactory(() => emptyRepo);
    const missing = await previewFn.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: {} });
    assert.equal(missing.statusCode, 404);
    assert.equal(parseBody(missing).error, 'draft_not_found');

    await emptyRepo.createCatalogDraft(SITE_ID, 'owner');
    // Empty draft is structurally valid; returns empty active package lists.
    const empty = await previewFn.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: {} });
    assert.equal(empty.statusCode, 200);
    const body = parseBody(empty);
    assert.equal(body.packages.length, 0);
    assert.equal(body.addOns.length, 0);
    assert.equal(body.preview, true);
  });

  it('sorts by displayOrder and preserves stable ids', () => {
    const preview = buildStorefrontPreviewCatalog(sampleDraft({
      packages: [
        { ...SAMPLE_PKG, displayOrder: 5, packageId: 'pkg_full_detail', compatibleAddOnIds: ['addon_pet_hair'] },
        {
          ...SAMPLE_PKG,
          packageId: 'pkg_maintenance_detail',
          legacyKey: 'maint',
          name: 'Maintenance',
          slug: 'maintenance',
          displayOrder: 1,
          compatibleAddOnIds: ['addon_pet_hair'],
          prices: [{ ...SAMPLE_PKG.prices[0], packageId: 'pkg_maintenance_detail', amountCents: 17500 }],
        },
      ],
      addOns: [SAMPLE_ADDON],
    }), { includeInactive: false });
    assert.equal(preview.packages[0].packageId, 'pkg_maintenance_detail');
    assert.equal(preview.packages[1].packageId, 'pkg_full_detail');
  });

  it('rejects non-GET methods', async () => {
    const res = await previewFn.handler({ httpMethod: 'POST', headers: {}, queryStringParameters: {} });
    assert.equal(res.statusCode, 405);
  });

  it('emptyPayload helper still draft-only', () => {
    const p = emptyPayload(SITE_ID);
    assert.equal(p.status, 'draft');
  });

  it('error responses (401 / 405 / 404) are also private, no-store', async () => {
    previewFn._test.setVerifyAdmin(async () => ({ ok: false }));
    const unauth = await previewFn.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: {} });
    assert.equal(unauth.statusCode, 401);
    assert.match(String(unauth.headers['Cache-Control'] || ''), /private/i);
    assert.match(String(unauth.headers['Cache-Control'] || ''), /no-store/i);

    const notAllowed = await previewFn.handler({ httpMethod: 'POST', headers: {}, queryStringParameters: {} });
    assert.equal(notAllowed.statusCode, 405);
    assert.match(String(notAllowed.headers['Cache-Control'] || ''), /no-store/i);

    const emptyRepo = createMemoryCatalogRepository();
    previewFn._test.setRepoFactory(() => emptyRepo);
    previewFn._test.setVerifyAdmin(async () => ({ ok: true, username: 'owner', token: 't' }));
    const missing = await previewFn.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: {} });
    assert.equal(missing.statusCode, 404);
    assert.match(String(missing.headers['Cache-Control'] || ''), /no-store/i);
  });

  it('no permissive CORS: no wildcard Access-Control-Allow-Origin', async () => {
    const res = await previewFn.handler({ httpMethod: 'GET', headers: {}, queryStringParameters: {} });
    assert.ok((res.headers['Access-Control-Allow-Origin'] || '') !== '*', 'GET must not send a wildcard ACAO');
    const opt = await previewFn.handler({ httpMethod: 'OPTIONS', headers: {}, queryStringParameters: {} });
    assert.equal(opt.statusCode, 204);
    assert.ok((opt.headers['Access-Control-Allow-Origin'] || '') !== '*', 'OPTIONS must not send a wildcard ACAO');
    assert.match(String(opt.headers['Cache-Control'] || ''), /no-store/i);
  });

  it('sanitize does not mutate the input draft and returns fresh objects/arrays', () => {
    const draft = sampleDraft();
    const before = JSON.parse(JSON.stringify(draft));
    const out = buildStorefrontPreviewCatalog(draft, { includeInactive: true });
    assert.deepEqual(draft, before); // stored payload is never mutated
    assert.notEqual(out.packages, draft.packages); // fresh top-level array
    const srcPkg = draft.packages.find((p) => p.packageId === out.packages[0].packageId);
    assert.notEqual(out.packages[0], srcPkg); // fresh object, not a draft reference
    assert.notEqual(out.packages[0].prices, srcPkg.prices);
    assert.notEqual(out.packages[0].compatibleAddOnIds, srcPkg.compatibleAddOnIds);
  });

  it('re-export via owner-studio/index exposes the sanitizer with no circular dependency', () => {
    const idx = require('../netlify/lib/owner-studio/index.js');
    assert.equal(typeof idx.buildStorefrontPreviewCatalog, 'function');
    assert.equal(idx.buildStorefrontPreviewCatalog, buildStorefrontPreviewCatalog);
  });
});
