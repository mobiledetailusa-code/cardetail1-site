#!/usr/bin/env node
'use strict';

/**
 * Legacy → Owner Studio draft importer.
 * Dry-run by default. Never writes production DB.
 *
 * Usage:
 *   node scripts/owner-studio-import.js
 *   node scripts/owner-studio-import.js --apply-memory   # staging memory store only
 */

const path = require('path');
const { importLegacyCatalog } = require('../netlify/lib/owner-studio/importer');

const repoRoot = path.join(__dirname, '..');
const applyMemory = process.argv.includes('--apply-memory');

const report = importLegacyCatalog({
  repoRoot,
  dryRun: !applyMemory,
  applyToStore: applyMemory,
  writeArtifacts: true,
  artifactsDir: path.join(repoRoot, 'artifacts'),
});

console.log(JSON.stringify({
  dryRun: report.dryRun,
  stats: report.stats,
  artifactPaths: report.artifactPaths,
  priceConflictCount: (report.priceConflicts || []).length,
  unmappedCount: (report.unmappedContent || []).length,
}, null, 2));

if (report.errors && report.errors.length) {
  process.exitCode = 2;
}
