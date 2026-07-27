#!/usr/bin/env node
'use strict';

/**
 * Staging-only Catalog persistence proof against the live PostgreSQL database.
 * Exercises save / version increment / revision / restore / stale 409.
 * Reversible: restores the original draft payload at the end.
 *
 * Usage:
 *   node scripts/owner-studio-staging-catalog-persistence-proof.js --confirm-staging-proof
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const PRODUCTION_SITE_ID = 'd7e5f77c-1f0b-4209-a9df-3d6aae380dd0';
const STAGING_SITE_ID = '982e6338-4a4a-432e-855b-db532b994391';

function loadEnvFile() {
  const p = path.join(root, '.env.owner-studio-staging');
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    out[line.slice(0, i).trim()] = line.slice(i + 1).replace(/^["']|["']$/g, '');
  }
  return out;
}

function fail(code, message, extra = {}) {
  console.log(JSON.stringify({ ok: false, error: code, message, ...extra }, null, 2));
  process.exit(1);
}

async function main() {
  if (!process.argv.includes('--confirm-staging-proof')) {
    fail('confirmation_required', 'Pass --confirm-staging-proof');
  }
  const fileEnv = loadEnvFile();
  const siteId = fileEnv.NETLIFY_SITE_ID || STAGING_SITE_ID;
  if (siteId === PRODUCTION_SITE_ID) fail('production_site_id_rejected', 'Production site forbidden');

  const assert = spawnSync(process.execPath, [
    path.join(root, 'scripts/assert-owner-studio-staging-db.js'),
    '--require-schema',
  ], {
    cwd: root,
    env: { ...process.env, ...fileEnv, NETLIFY_SITE_ID: siteId },
    encoding: 'utf8',
  });
  if (assert.status !== 0) fail('staging_assert_failed', 'Schema assert failed');

  process.env.DATABASE_URL = fileEnv.OWNER_STUDIO_STAGING_DATABASE_URL || fileEnv.DATABASE_URL;
  const { getPrisma, _resetPrismaForTests } = require('../netlify/lib/prisma');
  _resetPrismaForTests();
  const prisma = getPrisma();
  const { createPostgresCatalogRepository } = require('../netlify/lib/owner-studio/catalog-repository');
  const { SITE_ID } = require('../netlify/lib/owner-studio/ids');
  const repo = createPostgresCatalogRepository(prisma);

  const before = await repo.getCatalogDraft(SITE_ID);
  if (!before) fail('draft_missing', 'Catalog draft missing; run staging seed first');

  const originalPayload = JSON.parse(JSON.stringify(before));
  const startVersion = before.version;
  const marker = `staging-proof-${Date.now()}`;

  // Mutate a reversible description field on first package.
  const edited = JSON.parse(JSON.stringify(before));
  delete edited.version;
  delete edited.draftId;
  delete edited.updatedAt;
  delete edited.updatedBy;
  if (!Array.isArray(edited.packages) || !edited.packages[0]) {
    fail('packages_missing', 'Draft has no packages');
  }
  const originalDesc = edited.packages[0].description || '';
  edited.packages[0].description = `${originalDesc} [${marker}]`.slice(0, 400);

  const saved = await repo.saveCatalogDraft(SITE_ID, startVersion, edited, 'staging-proof');
  if (saved.draft.version !== startVersion + 1) {
    fail('version_not_incremented', 'Expected version +1', {
      startVersion,
      nextVersion: saved.draft.version,
    });
  }
  if (!saved.revisionId) fail('revision_missing', 'Save did not create revision');

  const reloaded = await repo.getCatalogDraft(SITE_ID);
  if (!String(reloaded.packages[0].description || '').includes(marker)) {
    fail('reload_persistence_failed', 'Edited description missing after reload');
  }

  let staleRejected = false;
  try {
    await repo.saveCatalogDraft(SITE_ID, startVersion, edited, 'staging-proof-stale');
  } catch (err) {
    if (err && err.statusCode === 409 && err.code === 'stale_draft_version') staleRejected = true;
    else throw err;
  }
  if (!staleRejected) fail('stale_save_not_rejected', 'Expected 409 stale_draft_version');

  const restored = await repo.restoreRevisionAsNewDraft(
    SITE_ID,
    saved.revisionId,
    reloaded.version,
    'staging-proof-restore'
  );
  if (!(restored.draft.version > reloaded.version)) {
    fail('restore_version_not_advanced', 'Restore must create a new draft version');
  }

  // Revert to original package description while preserving proof audit trail.
  const cleanupPayload = JSON.parse(JSON.stringify(restored.draft));
  delete cleanupPayload.version;
  delete cleanupPayload.draftId;
  delete cleanupPayload.updatedAt;
  delete cleanupPayload.updatedBy;
  cleanupPayload.packages[0].description = originalDesc;
  const cleanup = await repo.saveCatalogDraft(
    SITE_ID,
    restored.draft.version,
    cleanupPayload,
    'staging-proof-cleanup'
  );

  const finalDraft = await repo.getCatalogDraft(SITE_ID);
  const revisionCount = await prisma.osCatalogRevision.count({ where: { siteId: SITE_ID } });

  console.log(JSON.stringify({
    ok: true,
    catalogSiteId: SITE_ID,
    netlifySiteId: siteId,
    startVersion,
    afterSaveVersion: saved.draft.version,
    revisionId: saved.revisionId,
    reloadPersisted: true,
    stale409: true,
    restoreVersion: restored.draft.version,
    cleanupVersion: cleanup.draft.version,
    finalVersion: finalDraft.version,
    packageCount: Array.isArray(finalDraft.packages) ? finalDraft.packages.length : 0,
    addOnCount: Array.isArray(finalDraft.addOns) ? finalDraft.addOns.length : 0,
    revisionCount,
    descriptionRestored: finalDraft.packages[0].description === originalDesc,
  }, null, 2));
}

main().catch((e) => {
  fail(e.code || 'proof_failed', String(e.message || e).slice(0, 220), {
    statusCode: e.statusCode || null,
  });
});
