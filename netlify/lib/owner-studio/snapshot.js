'use strict';

const crypto = require('crypto');
const { SCHEMA_VERSION, assertSiteId } = require('./ids');

const FORBIDDEN_SNAPSHOT_KEYS = new Set([
  'draft', 'drafts', 'audit', 'auditLog', 'password', 'secret', 'token',
  'DATABASE_URL', 'stripeSecret', 'actorEmail', 'session', 'csrf',
  'internalDbId', 'prisma',
]);

function stripForbidden(value, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => stripForbidden(v, seen));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN_SNAPSHOT_KEYS.has(k)) continue;
    if (/secret|password|token|authorization/i.test(k)) continue;
    out[k] = stripForbidden(v, seen);
  }
  return out;
}

function digest(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Build CDN/Blob-safe snapshots. Atomic publish should write manifest last.
 */
function buildPublishedSnapshots({ siteId, releaseId, publishedAt, catalog, content }) {
  const sid = assertSiteId(siteId);
  const safeCatalog = stripForbidden(catalog || {});
  const safeContent = stripForbidden(content || {});

  // Ensure drafts never leak
  if (safeCatalog.draftStatus || safeContent.draftStatus) {
    delete safeCatalog.draftStatus;
    delete safeContent.draftStatus;
  }

  const catalogSnapshot = {
    siteId: sid,
    releaseId,
    schemaVersion: SCHEMA_VERSION,
    publishedAt,
    kind: 'catalog',
    catalog: safeCatalog,
  };
  const contentSnapshot = {
    siteId: sid,
    releaseId,
    schemaVersion: SCHEMA_VERSION,
    publishedAt,
    kind: 'site-content',
    content: safeContent,
  };

  catalogSnapshot.integrity = { sha256: digest(catalogSnapshot.catalog) };
  contentSnapshot.integrity = { sha256: digest(contentSnapshot.content) };

  const manifest = {
    siteId: sid,
    releaseId,
    schemaVersion: SCHEMA_VERSION,
    publishedAt,
    catalog: {
      path: 'catalog/current.json',
      releaseId,
      sha256: catalogSnapshot.integrity.sha256,
    },
    content: {
      path: 'site-content/current.json',
      releaseId,
      sha256: contentSnapshot.integrity.sha256,
    },
    integrity: {
      sha256: digest({
        catalog: catalogSnapshot.integrity.sha256,
        content: contentSnapshot.integrity.sha256,
      }),
    },
  };

  return {
    manifest,
    files: {
      'catalog/current.json': catalogSnapshot,
      'site-content/current.json': contentSnapshot,
      'release-manifest.json': manifest,
    },
  };
}

function assertSnapshotSafe(snapshot) {
  const json = JSON.stringify(snapshot);
  if (/ADMIN_SESSION_SECRET|DATABASE_URL|STRIPE_SECRET|sk_live|csrf/i.test(json)) {
    const err = new Error('snapshot_contains_secrets');
    err.code = 'snapshot_contains_secrets';
    throw err;
  }
  if (snapshot.draft || snapshot.audit || (snapshot.catalog && snapshot.catalog.draftStatus === 'draft')) {
    const err = new Error('snapshot_contains_draft');
    err.code = 'snapshot_contains_draft';
    throw err;
  }
  return true;
}

module.exports = {
  FORBIDDEN_SNAPSHOT_KEYS,
  stripForbidden,
  digest,
  buildPublishedSnapshots,
  assertSnapshotSafe,
};
