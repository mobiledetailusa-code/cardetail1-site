'use strict';

/**
 * Stage 6 — transactional release repository.
 *
 * Stage 1 shipped a release service backed by an in-memory store, which was enough
 * to prove the shape but cannot survive a process restart, let alone two of them
 * publishing at once. This is the durable equivalent, on the tables the Stage 1
 * migration already created (OsCatalogRevision, OsPublishedRelease,
 * OsCurrentReleasePointer). No new migration.
 *
 * Invariants, in the order they matter:
 *
 *  1. A publish is ONE transaction. The revision, the release and the pointer swap
 *     commit together or not at all. A half-published site — a pointer aimed at a
 *     release row that does not exist, or a release nobody points at — is the
 *     failure mode this whole module exists to prevent.
 *  2. A release is immutable. There is no update path, by construction: nothing in
 *     this file writes to OsPublishedRelease except `create`.
 *  3. Rollback moves the pointer and nothing else. It never rewrites history, never
 *     deletes a release, and never resurrects the draft that produced one.
 *  4. Publishing takes an expected draft version. Two operators publishing
 *     concurrently must not silently produce two releases from what one of them
 *     believed was the same draft.
 *  5. Nothing here consults OWNER_STUDIO_ENABLED or PUBLIC_CONTENT_SOURCE. This
 *     layer stores releases; whether the public site reads them is a flag decision
 *     made above it, and conflating the two is how an accidental cutover happens.
 */

const { assertSiteId, newId, SCHEMA_VERSION } = require('./ids');
const { validateReleaseCandidate } = require('./schemas');
const { buildPublishedSnapshots, assertSnapshotSafe } = require('./snapshot');

function releaseError(code, message, extra = {}) {
  const err = new Error(message || code);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

/** Split a validated draft payload into the catalog and content halves of a release. */
function partitionDraft(draft) {
  return {
    catalog: {
      packages: draft.packages || [],
      addOns: draft.addOns || [],
      vehicleClasses: draft.vehicleClasses || [],
    },
    content: {
      navigation: draft.navigation || null,
      footer: draft.footer || null,
      pages: draft.pages || [],
      galleries: draft.galleries || [],
      serviceAreas: draft.serviceAreas || [],
      // Unpublished media must never ride along inside a published snapshot.
      media: (draft.media || []).filter((m) => m && m.published),
    },
  };
}

/**
 * Build the immutable artefacts for a release. Pure — no IO, no clock of its own,
 * so a caller inside a transaction controls the timestamp and the id.
 */
function buildReleaseArtifacts({ siteId, releaseId, publishedAt, draft }) {
  const { catalog, content } = partitionDraft(draft);
  const validation = validateReleaseCandidate(
    { packages: catalog.packages, addOns: catalog.addOns },
    { navigation: content.navigation, footer: content.footer },
  );
  if (!validation.ok) {
    throw releaseError('release_validation_failed', 'Draft is not a valid release candidate', {
      errors: validation.errors,
    });
  }
  const built = buildPublishedSnapshots({ siteId, releaseId, publishedAt, catalog, content });
  const catalogSnapshot = built.files['catalog/current.json'];
  const contentSnapshot = built.files['site-content/current.json'];
  // Both halves are checked: a secret or a draft marker in either one must stop the
  // publish before anything is written, not be discovered after the pointer moved.
  assertSnapshotSafe(catalogSnapshot);
  assertSnapshotSafe(contentSnapshot);
  return { catalog, content, validation, manifest: built.manifest, catalogSnapshot, contentSnapshot };
}

function createPostgresReleaseRepository(prismaClient) {
  if (!prismaClient) throw releaseError('prisma_required', 'Prisma client is required');
  const prisma = prismaClient;

  /**
   * Publish the current draft as an immutable release and point the site at it.
   *
   * @param {string} siteId
   * @param {number} expectedDraftVersion  optimistic-concurrency guard
   * @param {string} actor
   */
  async function publishRelease(siteId, expectedDraftVersion, actor) {
    const id = assertSiteId(siteId);
    const expected = Number(expectedDraftVersion);
    if (!Number.isInteger(expected) || expected < 1) {
      throw releaseError('invalid_expected_version', 'expectedDraftVersion must be a positive integer', {
        statusCode: 400,
      });
    }

    return prisma.$transaction(async (tx) => {
      const draftRow = await tx.osCatalogDraft.findUnique({ where: { siteId: id } });
      if (!draftRow) {
        throw releaseError('draft_not_found', 'No catalog draft to publish', { statusCode: 404 });
      }
      if (Number(draftRow.version) !== expected) {
        throw releaseError('stale_catalog_draft_version', 'Draft changed since it was loaded', {
          statusCode: 409,
          expectedVersion: expected,
          actualVersion: Number(draftRow.version),
        });
      }

      const draft = typeof draftRow.payload === 'string'
        ? JSON.parse(draftRow.payload)
        : (draftRow.payload || {});

      const releaseId = newId('rel');
      const revisionId = newId('rev');
      // One timestamp for every artefact in this release, so the revision, the
      // release row and both snapshots agree rather than straddling a tick.
      const now = new Date();
      const publishedAt = now.toISOString();

      const artifacts = buildReleaseArtifacts({ siteId: id, releaseId, publishedAt, draft });

      await tx.osCatalogRevision.create({
        data: {
          revisionId, siteId: id, payload: draft,
          validation: artifacts.validation,
          createdBy: String(actor || 'unknown'),
        },
      });

      await tx.osPublishedRelease.create({
        data: {
          releaseId,
          siteId: id,
          schemaVersion: SCHEMA_VERSION,
          revisionId,
          catalogJson: artifacts.catalogSnapshot,
          contentJson: artifacts.contentSnapshot,
          manifestJson: artifacts.manifest,
          publishedAt: now,
          publishedBy: String(actor || 'unknown'),
        },
      });

      // The atomic swap. Same transaction as the create above: a pointer can never
      // reference a release that failed to write.
      await tx.osCurrentReleasePointer.upsert({
        where: { siteId: id },
        create: { siteId: id, releaseId, updatedBy: String(actor || 'unknown') },
        update: { releaseId, updatedBy: String(actor || 'unknown') },
      });

      await tx.osAuditLog.create({
        data: {
          siteId: id,
          actor: String(actor || 'unknown'),
          action: 'catalog.release.publish',
          entityType: 'PublishedRelease',
          entityId: releaseId,
          detail: {
            revisionId,
            draftVersion: expected,
            catalogSha256: artifacts.manifest.catalog.sha256,
            contentSha256: artifacts.manifest.content.sha256,
          },
        },
      });

      return {
        releaseId,
        revisionId,
        siteId: id,
        publishedAt,
        publishedBy: String(actor || 'unknown'),
        manifest: artifacts.manifest,
        counts: {
          packages: artifacts.catalog.packages.length,
          addOns: artifacts.catalog.addOns.length,
          vehicleClasses: artifacts.catalog.vehicleClasses.length,
        },
      };
    });
  }

  /**
   * Point the site at an existing release. History is not rewritten: the release
   * being rolled away from stays exactly where it is, and can be rolled back to.
   */
  async function rollbackToRelease(siteId, releaseId, actor) {
    const id = assertSiteId(siteId);
    const target = String(releaseId || '').trim();
    if (!target) throw releaseError('release_id_required', 'releaseId is required', { statusCode: 400 });

    return prisma.$transaction(async (tx) => {
      const release = await tx.osPublishedRelease.findUnique({ where: { releaseId: target } });
      if (!release) {
        throw releaseError('release_not_found', 'No such release', { statusCode: 404 });
      }
      // A release id from another site must never become this site's pointer.
      if (release.siteId !== id) {
        throw releaseError('release_site_mismatch', 'Release belongs to a different site', {
          statusCode: 400,
        });
      }

      const pointer = await tx.osCurrentReleasePointer.findUnique({ where: { siteId: id } });
      const from = pointer ? pointer.releaseId : null;
      if (from === target) {
        throw releaseError('release_already_current', 'That release is already current', {
          statusCode: 409,
        });
      }

      await tx.osCurrentReleasePointer.upsert({
        where: { siteId: id },
        create: { siteId: id, releaseId: target, updatedBy: String(actor || 'unknown') },
        update: { releaseId: target, updatedBy: String(actor || 'unknown') },
      });

      await tx.osAuditLog.create({
        data: {
          siteId: id,
          actor: String(actor || 'unknown'),
          action: 'catalog.release.rollback',
          entityType: 'PublishedRelease',
          entityId: target,
          detail: { fromReleaseId: from, toReleaseId: target },
        },
      });

      return { siteId: id, fromReleaseId: from, releaseId: target };
    });
  }

  async function getCurrentRelease(siteId) {
    const id = assertSiteId(siteId);
    const pointer = await prisma.osCurrentReleasePointer.findUnique({ where: { siteId: id } });
    if (!pointer) return null;
    const release = await prisma.osPublishedRelease.findUnique({ where: { releaseId: pointer.releaseId } });
    return release || null;
  }

  /** Release history, newest first. Manifests only — snapshots are large. */
  async function listReleases(siteId, limit = 20) {
    const id = assertSiteId(siteId);
    const take = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const rows = await prisma.osPublishedRelease.findMany({
      where: { siteId: id },
      orderBy: { publishedAt: 'desc' },
      take,
      select: {
        releaseId: true, revisionId: true, publishedAt: true,
        publishedBy: true, manifestJson: true, schemaVersion: true,
      },
    });
    const pointer = await prisma.osCurrentReleasePointer.findUnique({ where: { siteId: id } });
    const currentId = pointer ? pointer.releaseId : null;
    return rows.map((r) => ({ ...r, current: r.releaseId === currentId }));
  }

  return { publishRelease, rollbackToRelease, getCurrentRelease, listReleases };
}

module.exports = {
  createPostgresReleaseRepository,
  buildReleaseArtifacts,
  partitionDraft,
};
