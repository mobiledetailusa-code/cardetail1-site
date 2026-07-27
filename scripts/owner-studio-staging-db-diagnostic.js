#!/usr/bin/env node
'use strict';

/**
 * Staging-only Owner Studio DB diagnostic (local execution).
 * Requires live staging assert + admin-equivalent local secrets file.
 * Never prints credentials or customer PII.
 *
 * Usage:
 *   node scripts/owner-studio-staging-db-diagnostic.js
 *   node scripts/owner-studio-staging-db-diagnostic.js --require-schema
 */

const { spawnSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const PRODUCTION_SITE_ID = 'd7e5f77c-1f0b-4209-a9df-3d6aae380dd0';

function sha12(v) {
  return crypto.createHash('sha256').update(String(v || '')).digest('hex').slice(0, 12);
}

function loadEnvFile() {
  const fs = require('fs');
  const p = path.join(root, '.env.owner-studio-staging');
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    out[line.slice(0, i).trim()] = line.slice(i + 1).replace(/^["']|["']$/g, '');
  }
  return out;
}

async function main() {
  const fileEnv = loadEnvFile();
  const siteId = process.env.NETLIFY_SITE_ID || fileEnv.NETLIFY_SITE_ID || '';
  if (!siteId || siteId === PRODUCTION_SITE_ID) {
    console.error(JSON.stringify({ ok: false, error: 'invalid_staging_site_id' }));
    process.exit(1);
  }

  const assertArgs = [path.join(root, 'scripts/assert-owner-studio-staging-db.js')];
  if (process.argv.includes('--require-schema')) assertArgs.push('--require-schema');
  const assert = spawnSync(process.execPath, assertArgs, {
    cwd: root,
    env: { ...process.env, ...fileEnv, NETLIFY_SITE_ID: siteId },
    encoding: 'utf8',
  });
  const out = `${assert.stdout || ''}\n${assert.stderr || ''}`;
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  let parsed = null;
  try { parsed = start >= 0 ? JSON.parse(out.slice(start, end + 1)) : null; } catch { parsed = null; }
  if (assert.status !== 0 || !parsed?.ok) {
    console.error(JSON.stringify({
      ok: false,
      error: parsed?.error || 'staging_assert_failed',
      message: parsed?.message || 'Staging assert failed',
    }, null, 2));
    process.exit(1);
  }

  process.env.DATABASE_URL = fileEnv.OWNER_STUDIO_STAGING_DATABASE_URL || fileEnv.DATABASE_URL;
  const { getPrisma, _resetPrismaForTests } = require('../netlify/lib/prisma');
  _resetPrismaForTests();
  const prisma = getPrisma();

  const draftCount = await prisma.osCatalogDraft.count();
  const revisionCount = await prisma.osCatalogRevision.count();
  const packageCount = await prisma.osPackage.count();
  const addOnCount = await prisma.osAddOn.count();
  const migrationCount = await prisma.$queryRawUnsafe('SELECT COUNT(*)::int AS n FROM "_prisma_migrations"');
  const draft = await prisma.osCatalogDraft.findFirst({ orderBy: { updatedAt: 'desc' } });
  let payloadPackages = null;
  let payloadAddOns = null;
  if (draft?.payload && typeof draft.payload === 'object') {
    payloadPackages = Array.isArray(draft.payload.packages) ? draft.payload.packages.length : null;
    payloadAddOns = Array.isArray(draft.payload.addOns)
      ? draft.payload.addOns.length
      : (Array.isArray(draft.payload.addons) ? draft.payload.addons.length : null);
  }

  console.log(JSON.stringify({
    ok: true,
    environment: 'staging',
    runtimeMode: parsed.runtimeConnectionMode,
    siteIdHash: sha12(siteId),
    userFingerprint: parsed.userFingerprint,
    connectedDatabaseFingerprint: parsed.connectedDatabaseFingerprint,
    liveConnectionVerified: true,
    differentFromProduction: true,
    migrationCount: migrationCount[0]?.n ?? null,
    draftCount,
    revisionCount,
    packageEntityCount: packageCount,
    addOnEntityCount: addOnCount,
    latestDraft: draft ? {
      siteId: draft.siteId,
      version: draft.version,
      updatedAt: draft.updatedAt,
      payloadPackageCount: payloadPackages,
      payloadAddOnCount: payloadAddOns,
    } : null,
    requiredTables: parsed.ownerStudioTablesPresent || [],
  }, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 200) }));
  process.exit(1);
});
