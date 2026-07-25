'use strict';

const { getStore } = require('./store');
const { assertSiteId, newId, SITE_ID, SCHEMA_VERSION } = require('./ids');
const { validateReleaseCandidate } = require('./schemas');
const { appendAuditEvent } = require('./audit');
const { authorizeOwnerStudio } = require('./authorization');
const { readDraft, createRevision } = require('./draft-service');
const { buildPublishedSnapshots, assertSnapshotSafe } = require('./snapshot');

function resolveCurrentRelease(siteId = SITE_ID) {
  const id = assertSiteId(siteId);
  const store = getStore();
  const releaseId = store.currentPointer.get(id) || null;
  if (!releaseId) return null;
  return store.releases.get(releaseId) || null;
}

function validateReleaseCandidateFromDraft(siteId = SITE_ID) {
  const draft = readDraft(siteId);
  return validateReleaseCandidate(
    { packages: draft.packages, addOns: draft.addOns },
    { navigation: draft.navigation, footer: draft.footer }
  );
}

function publishRelease(identity, siteId = SITE_ID) {
  authorizeOwnerStudio(identity, 'publish');
  const id = assertSiteId(siteId);
  const revision = createRevision(identity, id);
  if (!revision.validation.ok) {
    const err = new Error('release_validation_failed');
    err.code = 'release_validation_failed';
    err.errors = revision.validation.errors;
    throw err;
  }

  const draft = revision.snapshot;
  const publishedAt = new Date().toISOString();
  const releaseId = newId('rel');

  const catalog = {
    packages: draft.packages,
    addOns: draft.addOns,
    vehicleClasses: draft.vehicleClasses,
  };
  const content = {
    navigation: draft.navigation,
    footer: draft.footer,
    pages: draft.pages,
    galleries: draft.galleries,
    serviceAreas: draft.serviceAreas,
    media: (draft.media || []).filter((m) => m.published),
  };

  const snapshots = buildPublishedSnapshots({
    siteId: id,
    releaseId,
    publishedAt,
    catalog,
    content,
  });
  assertSnapshotSafe(snapshots.files['catalog/current.json']);
  assertSnapshotSafe(snapshots.files['site-content/current.json']);

  const release = {
    releaseId,
    siteId: id,
    schemaVersion: SCHEMA_VERSION,
    publishedAt,
    publishedBy: identity.username,
    revisionId: revision.revisionId,
    immutable: true,
    catalog,
    content,
    snapshots: snapshots.files,
    manifest: snapshots.manifest,
  };

  const store = getStore();
  // Atomic pointer update: write release then pointer (single-threaded memory store)
  store.releases.set(releaseId, Object.freeze(deepFreezeClone(release)));
  store.currentPointer.set(id, releaseId);

  appendAuditEvent({
    siteId: id,
    actor: identity.username,
    action: 'release.publish',
    entityType: 'PublishedCatalogRelease',
    entityId: releaseId,
    releaseId,
  });

  return resolveCurrentRelease(id);
}

function rollbackToRelease(identity, targetReleaseId, siteId = SITE_ID) {
  authorizeOwnerStudio(identity, 'rollback');
  const id = assertSiteId(siteId);
  const store = getStore();
  const target = store.releases.get(targetReleaseId);
  if (!target || target.siteId !== id) {
    const err = new Error('rollback_target_invalid');
    err.code = 'rollback_target_invalid';
    throw err;
  }
  if (!target.immutable) {
    const err = new Error('rollback_target_not_immutable');
    err.code = 'rollback_target_not_immutable';
    throw err;
  }
  store.currentPointer.set(id, targetReleaseId);
  appendAuditEvent({
    siteId: id,
    actor: identity.username,
    action: 'release.rollback',
    entityType: 'PublishedCatalogRelease',
    entityId: targetReleaseId,
    releaseId: targetReleaseId,
  });
  return resolveCurrentRelease(id);
}

function deepFreezeClone(obj) {
  const clone = JSON.parse(JSON.stringify(obj));
  return clone;
}

function deactivatePackage(identity, packageId, siteId = SITE_ID) {
  authorizeOwnerStudio(identity, 'edit_draft');
  const draft = readDraft(siteId);
  const pkg = draft.packages.find((p) => p.packageId === packageId);
  if (!pkg) {
    const err = new Error('package_not_found');
    err.code = 'package_not_found';
    throw err;
  }
  pkg.active = false;
  const { saveDraft } = require('./draft-service');
  return saveDraft(identity, draft);
}

module.exports = {
  resolveCurrentRelease,
  validateReleaseCandidateFromDraft,
  publishRelease,
  rollbackToRelease,
  deactivatePackage,
};
