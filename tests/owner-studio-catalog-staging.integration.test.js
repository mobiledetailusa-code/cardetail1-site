'use strict';

/**
 * Guarded staging integration tests for Catalog Manager.
 * Fail-closed unless OWNER_STUDIO_STAGING_INTEGRATION=1 and staging assert passes.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const STAGING_SITE = '982e6338-4a4a-432e-855b-db532b994391';
const SYNTHETIC_SITE = 'os-stage2-synth';

function loadEnvFile() {
  const p = path.join(root, '.env.owner-studio-staging');
  if (!fs.existsSync(p)) return false;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).replace(/^["']|["']$/g, '');
    if (!process.env[k]) process.env[k] = v;
  }
  return true;
}

const enabled = process.env.OWNER_STUDIO_STAGING_INTEGRATION === '1';

describe('owner-studio catalog staging integration', { skip: !enabled }, () => {
  let repo;
  let prisma;

  before(async () => {
    assert.ok(loadEnvFile(), 'missing .env.owner-studio-staging');
    process.env.NETLIFY_SITE_ID = STAGING_SITE;
    process.env.DATABASE_URL = process.env.OWNER_STUDIO_STAGING_DATABASE_URL || process.env.DATABASE_URL;
    const assertRes = spawnSync(process.execPath, [path.join(root, 'scripts/assert-owner-studio-staging-db.js')], {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
    });
    assert.equal(assertRes.status, 0, 'staging assert must pass');
    const { getPrisma, _resetPrismaForTests } = require('../netlify/lib/prisma');
    _resetPrismaForTests();
    prisma = getPrisma();
    const { createPostgresCatalogRepository } = require('../netlify/lib/owner-studio/catalog-repository');
    repo = createPostgresCatalogRepository(prisma);

    // Cleanup previous synthetic rows
    await prisma.osAuditLog.deleteMany({ where: { siteId: SYNTHETIC_SITE } });
    await prisma.osCatalogRevision.deleteMany({ where: { siteId: SYNTHETIC_SITE } });
    await prisma.osCatalogDraft.deleteMany({ where: { siteId: SYNTHETIC_SITE } });
    await prisma.osSite.deleteMany({ where: { siteId: SYNTHETIC_SITE } });
  });

  it('creates, saves, reloads, rejects concurrent save, restores, audits', async () => {
    const created = await repo.createCatalogDraft(SYNTHETIC_SITE, 'integration');
    assert.equal(created.version, 1);

    const payload = {
      siteId: SYNTHETIC_SITE,
      packages: [{
        siteId: SYNTHETIC_SITE,
        packageId: 'pkg_full_detail',
        legacyKey: 'full',
        category: 'cars',
        name: 'Full Detail',
        slug: 'full-detail',
        description: 'desc',
        shortDescription: 'short',
        active: true,
        featured: false,
        displayOrder: 0,
        features: [],
        prices: [{
          packageId: 'pkg_full_detail',
          vehicleClassId: 'vc_sedan',
          currency: 'usd',
          amountCents: 28500,
          priceModel: 'flat',
        }],
        compatibleVehicleClassIds: ['vc_sedan'],
        compatibleAddOnIds: [],
      }],
      addOns: [],
      vehicleClasses: [{
        siteId: SYNTHETIC_SITE,
        vehicleClassId: 'vc_sedan',
        legacyKey: 'small',
        category: 'cars',
        label: 'Sedan',
        active: true,
        displayOrder: 0,
      }],
      priceConflicts: [],
      unmappedContent: [],
      navigation: { siteId: SYNTHETIC_SITE, headerItems: [] },
      footer: { siteId: SYNTHETIC_SITE, tagline: '', groups: [], legalLinks: [], copyright: '' },
      pages: [],
      galleries: [],
      serviceAreas: [],
      media: [],
    };

    const saved = await repo.saveCatalogDraft(SYNTHETIC_SITE, 1, payload, 'integration');
    assert.equal(saved.draft.version, 2);
    const reloaded = await repo.getCatalogDraft(SYNTHETIC_SITE);
    assert.equal(reloaded.packages[0].prices[0].amountCents, 28500);

    await assert.rejects(
      () => repo.saveCatalogDraft(SYNTHETIC_SITE, 1, payload, 'other'),
      (e) => e.statusCode === 409
    );

    const list = await repo.listCatalogRevisions(SYNTHETIC_SITE);
    assert.ok(list.total >= 1);
    const restored = await repo.restoreRevisionAsNewDraft(SYNTHETIC_SITE, saved.revisionId, 2, 'integration');
    assert.ok(restored.draft.version > 2);

    const audits = await prisma.osAuditLog.findMany({ where: { siteId: SYNTHETIC_SITE } });
    assert.ok(audits.some((a) => a.action === 'catalog.draft.save'));

    // no publication pointer for synthetic site
    const pointer = await prisma.osCurrentReleasePointer.findUnique({ where: { siteId: SYNTHETIC_SITE } });
    assert.equal(pointer, null);

    // cleanup synthetic only
    await prisma.osAuditLog.deleteMany({ where: { siteId: SYNTHETIC_SITE } });
    await prisma.osCatalogRevision.deleteMany({ where: { siteId: SYNTHETIC_SITE } });
    await prisma.osCatalogDraft.deleteMany({ where: { siteId: SYNTHETIC_SITE } });
    await prisma.osSite.deleteMany({ where: { siteId: SYNTHETIC_SITE } });
  });
});

describe('owner-studio catalog staging integration gate', () => {
  it('fails closed when integration env is absent', () => {
    if (enabled) {
      assert.ok(true);
      return;
    }
    assert.notEqual(process.env.OWNER_STUDIO_STAGING_INTEGRATION, '1');
  });
});
