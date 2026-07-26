'use strict';

/**
 * Staging-only deterministic catalog seed into Owner Studio draft tables.
 *
 * Usage:
 *   node scripts/owner-studio-staging-seed-catalog.js --dry-run
 *   node scripts/owner-studio-staging-seed-catalog.js --site <staging-site-id> --confirm-staging-seed
 *
 * Never targets production. Never modifies bookings/payments.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const PRODUCTION_SITE_ID = 'd7e5f77c-1f0b-4209-a9df-3d6aae380dd0';
const STAGING_SITE_ID = '982e6338-4a4a-432e-855b-db532b994391';
const root = path.join(__dirname, '..');

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i < 0) return null;
  return process.argv[i + 1] || true;
}

function fail(code, message, extra = {}) {
  console.log(JSON.stringify({ ok: false, error: code, message, ...extra }, null, 2));
  process.exit(1);
}

function loadEnvFile() {
  const fs = require('fs');
  const p = path.join(root, '.env.owner-studio-staging');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).replace(/^["']|["']$/g, '');
    if (!process.env[k]) process.env[k] = v;
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run') || (!process.argv.includes('--confirm-staging-seed'));
  const siteArg = arg('--site');
  const forceOverwrite = process.argv.includes('--overwrite-draft');

  if (siteArg === true || !siteArg) {
    if (!dryRun) fail('missing_staging_site_id', 'Pass --site <staging-site-id>');
  }
  if (siteArg && siteArg !== true && siteArg === PRODUCTION_SITE_ID) {
    fail('production_site_id_rejected', 'Production Netlify site ID is forbidden');
  }
  if (!dryRun && siteArg !== STAGING_SITE_ID) {
    fail('staging_site_id_mismatch', 'Explicit staging site ID required', { expected: STAGING_SITE_ID });
  }

  loadEnvFile();

  // Fail-closed staging DB assertion (skips live DB check in pure dry-run without env)
  if (!dryRun || process.env.OWNER_STUDIO_STAGING_DATABASE_URL) {
    const assert = spawnSync(process.execPath, [path.join(root, 'scripts/assert-owner-studio-staging-db.js')], {
      cwd: root,
      env: {
        ...process.env,
        NETLIFY_SITE_ID: siteArg && siteArg !== true ? siteArg : STAGING_SITE_ID,
      },
      encoding: 'utf8',
    });
    const out = `${assert.stdout || ''}\n${assert.stderr || ''}`;
    const start = out.indexOf('{');
    const end = out.lastIndexOf('}');
    let parsed = null;
    try {
      parsed = start >= 0 ? JSON.parse(out.slice(start, end + 1)) : null;
    } catch {
      parsed = null;
    }
    if (assert.status !== 0 || !parsed?.ok) {
      fail(parsed?.error || 'staging_assert_failed', 'Staging DB assertion failed');
    }
    if (parsed.differentFromProduction !== true) {
      fail('staging_db_equals_production', 'Staging DB fingerprint must differ from production');
    }
  }

  const { importLegacyCatalog } = require('../netlify/lib/owner-studio/importer');
  const { SITE_ID } = require('../netlify/lib/owner-studio/ids');
  // dryRun:false returns full draft objects without writing memory/DB unless applyToStore.
  const report = importLegacyCatalog({
    repoRoot: root,
    dryRun: false,
    applyToStore: false,
    siteId: SITE_ID,
    writeArtifacts: false,
  });

  if (!report.draft || !Array.isArray(report.draft.packages)) {
    fail('import_draft_missing', 'Legacy importer did not produce a draft payload');
  }

  const conflicts = (report.priceConflicts || []).map((c, idx) => ({
    conflictId: `conflict_${idx + 1}_${String(c.file || c.addOnId || 'item').replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}`,
    entityType: c.type === 'addon' ? 'addon_price' : 'package_price',
    entityId: c.addOnId || 'pkg_full_detail',
    field: c.field || (c.type === 'addon' ? `addon.${c.addOnId}.${c.category}` : 'price'),
    serverValue: c.serverValue != null ? c.serverValue : (c.existingCents != null ? c.existingCents / 100 : null),
    presentationValue: c.htmlValue != null ? c.htmlValue : (c.incomingCents != null ? c.incomingCents / 100 : null),
    serverCents: c.existingCents != null
      ? c.existingCents
      : (c.serverValue != null ? Math.round(Number(c.serverValue) * 100) : null),
    presentationCents: c.incomingCents != null
      ? c.incomingCents
      : (c.htmlValue != null ? Math.round(Number(c.htmlValue) * 100) : null),
    sources: c.file ? [c.file] : (c.category ? [String(c.category)] : []),
    status: 'unresolved',
    resolution: null,
    resolvedBy: null,
    resolvedAt: null,
    message: c.message || 'Catalog presentation/transactional conflict preserved for owner review',
  }));

  const draftPayload = {
    siteId: SITE_ID,
    packages: report.draft.packages,
    addOns: (report.draft.addOns || []).map((a, i) => ({ ...a, displayOrder: Number.isInteger(a.displayOrder) ? a.displayOrder : i })),
    vehicleClasses: (report.draft.vehicleClasses || []).map((vc, i) => ({
      ...vc,
      displayOrder: Number.isInteger(vc.displayOrder) ? vc.displayOrder : i,
    })),
    priceConflicts: conflicts,
    unmappedContent: report.unmappedContent || [],
    navigation: report.draft.navigation || { siteId: SITE_ID, headerItems: [] },
    footer: report.draft.footer || { siteId: SITE_ID, tagline: '', groups: [], legalLinks: [], copyright: '' },
    pages: report.draft.pages || [],
    galleries: report.draft.galleries || [],
    serviceAreas: report.draft.serviceAreas || [],
    media: report.draft.media || [],
  };

  const summary = {
    ok: true,
    dryRun,
    siteId: SITE_ID,
    stagingNetlifySiteId: siteArg && siteArg !== true ? siteArg : null,
    packageCount: draftPayload.packages.length,
    addOnCount: draftPayload.addOns.length,
    vehicleClassCount: draftPayload.vehicleClasses.length,
    priceConflictCount: draftPayload.priceConflicts.length,
    unmappedCount: draftPayload.unmappedContent.length,
    applied: false,
  };

  if (dryRun) {
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  }

  // Apply to staging Postgres
  process.env.DATABASE_URL = process.env.OWNER_STUDIO_STAGING_DATABASE_URL || process.env.DATABASE_URL;
  const { getPrisma, _resetPrismaForTests } = require('../netlify/lib/prisma');
  _resetPrismaForTests();
  const prisma = getPrisma();
  const { createPostgresCatalogRepository } = require('../netlify/lib/owner-studio/catalog-repository');
  const repo = createPostgresCatalogRepository(prisma);

  await repo.ensureSite(SITE_ID, 'Cardetail1 Staging');
  const existing = await repo.getCatalogDraft(SITE_ID);
  if (existing && !forceOverwrite) {
    fail('draft_exists', 'Draft already exists; pass --overwrite-draft to replace owner-edited draft explicitly', {
      version: existing.version,
    });
  }

  if (existing && forceOverwrite) {
    // Save as new revision from seed (requires matching version)
    const result = await repo.saveCatalogDraft(SITE_ID, existing.version, draftPayload, 'staging-seed');
    summary.applied = true;
    summary.version = result.draft.version;
    summary.revisionId = result.revisionId;
  } else {
    const created = await repo.createCatalogDraft(SITE_ID, 'staging-seed');
    const result = await repo.saveCatalogDraft(SITE_ID, created.version, draftPayload, 'staging-seed');
    summary.applied = true;
    summary.version = result.draft.version;
    summary.revisionId = result.revisionId;
  }

  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

main().catch((e) => {
  fail(e.code || 'seed_failed', String(e.message || e).slice(0, 200));
});
