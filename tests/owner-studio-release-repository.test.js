'use strict';

/**
 * Stage 6 — transactional publish, rollback and release history.
 *
 * Runs against a Prisma double with real commit/discard semantics
 * (tests/helpers/fake-prisma.js), so atomicity is demonstrated rather than
 * asserted. The staging integration test covers the same contract against a real
 * PostgreSQL instance in CI.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakePrisma } = require('./helpers/fake-prisma');
const {
  createPostgresReleaseRepository,
  partitionDraft,
} = require('../netlify/lib/owner-studio/release-repository');
const { SITE_ID } = require('../netlify/lib/owner-studio/ids');

function validDraft() {
  return {
    siteId: SITE_ID,
    vehicleClasses: [
      { siteId: SITE_ID, vehicleClassId: 'vc_small', legacyKey: 'small', category: 'cars', label: 'Small Car', active: true, displayOrder: 1 },
    ],
    packages: [
      {
        siteId: SITE_ID,
        packageId: 'pkg_full', legacyKey: 'full', category: 'cars', name: 'Full Detail',
        slug: 'full-detail', active: true, displayOrder: 1, features: [],
        compatibleVehicleClassIds: ['vc_small'], compatibleAddOnIds: [],
        prices: [{ packageId: 'pkg_full', vehicleClassId: 'vc_small', currency: 'usd', amountCents: 24000, priceModel: 'flat' }],
      },
    ],
    addOns: [],
    navigation: { siteId: SITE_ID, headerItems: [] },
    footer: { siteId: SITE_ID, tagline: '', groups: [], legalLinks: [], copyright: '' },
    pages: [], galleries: [], serviceAreas: [],
    media: [
      { mediaId: 'm_pub', published: true, url: '/assets/a.webp' },
      { mediaId: 'm_draft', published: false, url: '/assets/wip.webp' },
    ],
  };
}

function seedWith(draft, version = 3) {
  return {
    osSite: [{ siteId: SITE_ID, name: 'Cardetail1', status: 'active' }],
    osCatalogDraft: [{ siteId: SITE_ID, version, payload: draft, updatedBy: 'owner' }],
  };
}

let prisma;
let repo;

beforeEach(() => {
  prisma = createFakePrisma(seedWith(validDraft()));
  repo = createPostgresReleaseRepository(prisma);
});

describe('publish', () => {
  it('writes revision, release and pointer together', async () => {
    const out = await repo.publishRelease(SITE_ID, 3, 'owner');
    assert.match(out.releaseId, /^rel_/);
    assert.match(out.revisionId, /^rev_/);
    assert.equal(prisma.__committed('osCatalogRevision').length, 1);
    assert.equal(prisma.__committed('osPublishedRelease').length, 1);
    const pointer = prisma.__committed('osCurrentReleasePointer')[0];
    assert.equal(pointer.releaseId, out.releaseId, 'the pointer must aim at the release just written');
  });

  it('refuses a stale draft version and writes nothing', async () => {
    await assert.rejects(() => repo.publishRelease(SITE_ID, 2, 'owner'), (e) => {
      assert.equal(e.code, 'stale_catalog_draft_version');
      assert.equal(e.actualVersion, 3);
      return true;
    });
    assert.equal(prisma.__committed('osPublishedRelease').length, 0);
    assert.equal(prisma.__committed('osCurrentReleasePointer').length, 0);
  });

  it('refuses an invalid release candidate and writes nothing', async () => {
    const empty = validDraft();
    empty.packages = [];
    prisma = createFakePrisma(seedWith(empty));
    repo = createPostgresReleaseRepository(prisma);
    await assert.rejects(() => repo.publishRelease(SITE_ID, 3, 'owner'), (e) => {
      assert.equal(e.code, 'release_validation_failed');
      return true;
    });
    assert.equal(prisma.__committed('osCatalogRevision').length, 0,
      'a rejected candidate must not leave a revision behind');
  });

  /**
   * The invariant this module exists for. If any step after the release row fails,
   * nothing may survive — a pointer aimed at a missing release is an unservable site.
   */
  it('leaves no partial state when a later step in the transaction fails', async () => {
    const boom = new Error('pointer write failed');
    prisma.__failOn('osCurrentReleasePointer.upsert', boom);
    await assert.rejects(() => repo.publishRelease(SITE_ID, 3, 'owner'), (e) => e === boom);
    prisma.__failOn('osCurrentReleasePointer.upsert', null);

    assert.deepEqual(prisma.__committed('osPublishedRelease'), [],
      'the release must not survive a failed pointer swap');
    assert.deepEqual(prisma.__committed('osCatalogRevision'), [],
      'nor may the revision written before it');
    assert.deepEqual(prisma.__committed('osAuditLog'), []);

    // And the site is still publishable afterwards — a failed publish leaves no lock.
    const out = await repo.publishRelease(SITE_ID, 3, 'owner');
    assert.equal(prisma.__committed('osCurrentReleasePointer')[0].releaseId, out.releaseId);
  });

  it('records an audit entry naming the release and both snapshot digests', async () => {
    const out = await repo.publishRelease(SITE_ID, 3, 'owner');
    const audit = prisma.__committed('osAuditLog').find((a) => a.action === 'catalog.release.publish');
    assert.ok(audit, 'publish must be auditable');
    assert.equal(audit.entityId, out.releaseId);
    assert.equal(audit.actor, 'owner');
    assert.ok(audit.detail.catalogSha256 && audit.detail.contentSha256);
  });

  it('never publishes unpublished media', () => {
    const { content } = partitionDraft(validDraft());
    assert.deepEqual(content.media.map((m) => m.mediaId), ['m_pub'],
      'draft-only media must not leak into a published snapshot');
  });
});

describe('rollback', () => {
  async function twoReleases() {
    const first = await repo.publishRelease(SITE_ID, 3, 'owner');
    // A second publish needs a moved draft version, as a real edit would produce.
    const row = prisma.__committed('osCatalogDraft')[0];
    await prisma.osCatalogDraft.update({ where: { siteId: SITE_ID }, data: { version: 4, payload: row.payload } });
    const second = await repo.publishRelease(SITE_ID, 4, 'owner');
    return { first, second };
  }

  it('moves the pointer back without touching release history', async () => {
    const { first, second } = await twoReleases();
    assert.equal(prisma.__committed('osCurrentReleasePointer')[0].releaseId, second.releaseId);

    const res = await repo.rollbackToRelease(SITE_ID, first.releaseId, 'owner');
    assert.equal(res.fromReleaseId, second.releaseId);
    assert.equal(prisma.__committed('osCurrentReleasePointer')[0].releaseId, first.releaseId);
    assert.equal(prisma.__committed('osPublishedRelease').length, 2,
      'rolling back must not delete the release rolled away from');
  });

  it('can roll forward again — history is a pointer, not a stack', async () => {
    const { first, second } = await twoReleases();
    await repo.rollbackToRelease(SITE_ID, first.releaseId, 'owner');
    await repo.rollbackToRelease(SITE_ID, second.releaseId, 'owner');
    assert.equal(prisma.__committed('osCurrentReleasePointer')[0].releaseId, second.releaseId);
  });

  it('refuses an unknown release', async () => {
    await assert.rejects(() => repo.rollbackToRelease(SITE_ID, 'rel_nope', 'owner'),
      (e) => e.code === 'release_not_found');
  });

  it('refuses a release belonging to another site', async () => {
    const { first } = await twoReleases();
    await prisma.osPublishedRelease.update({
      where: { releaseId: first.releaseId }, data: { siteId: 'other-site' },
    });
    await assert.rejects(() => repo.rollbackToRelease(SITE_ID, first.releaseId, 'owner'),
      (e) => e.code === 'release_site_mismatch');
  });

  it('refuses a no-op rollback to the current release', async () => {
    const { second } = await twoReleases();
    await assert.rejects(() => repo.rollbackToRelease(SITE_ID, second.releaseId, 'owner'),
      (e) => e.code === 'release_already_current');
  });

  it('audits the pointer move with both ends named', async () => {
    const { first, second } = await twoReleases();
    await repo.rollbackToRelease(SITE_ID, first.releaseId, 'owner');
    const audit = prisma.__committed('osAuditLog').find((a) => a.action === 'catalog.release.rollback');
    assert.equal(audit.detail.fromReleaseId, second.releaseId);
    assert.equal(audit.detail.toReleaseId, first.releaseId);
  });
});

describe('history', () => {
  it('lists releases newest first and marks the current one', async () => {
    const first = await repo.publishRelease(SITE_ID, 3, 'owner');
    const row = prisma.__committed('osCatalogDraft')[0];
    await prisma.osCatalogDraft.update({ where: { siteId: SITE_ID }, data: { version: 4, payload: row.payload } });
    const second = await repo.publishRelease(SITE_ID, 4, 'owner');

    const list = await repo.listReleases(SITE_ID);
    assert.equal(list.length, 2);
    assert.equal(list.filter((r) => r.current).length, 1);
    assert.equal(list.find((r) => r.current).releaseId, second.releaseId);
    assert.ok(list.every((r) => r.manifestJson), 'history rows carry their manifest');
    assert.ok(list.every((r) => !('catalogJson' in r)), 'history must not haul full snapshots');
    assert.ok([first.releaseId, second.releaseId].includes(list[0].releaseId));
  });

  it('returns null current release before anything is published', async () => {
    assert.equal(await repo.getCurrentRelease(SITE_ID), null);
  });

  it('resolves the current release after publishing', async () => {
    const out = await repo.publishRelease(SITE_ID, 3, 'owner');
    const current = await repo.getCurrentRelease(SITE_ID);
    assert.equal(current.releaseId, out.releaseId);
    assert.equal(current.manifestJson.catalog.sha256, out.manifest.catalog.sha256);
  });
});
