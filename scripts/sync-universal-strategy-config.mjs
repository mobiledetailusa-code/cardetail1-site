#!/usr/bin/env node
/** Sync shared/universal-customer-strategy-config.json → frontend generated bundle. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const src = path.join(root, 'shared/universal-customer-strategy-config.json');
const logicPath = path.join(root, 'netlify/lib/universal-customer-strategy-logic.js');
const outPath = path.join(root, 'assets/universal-customer-strategy.generated.js');
const checkMode = process.argv.includes('--check');

const logicSrc = fs.readFileSync(logicPath, 'utf8');
const config = JSON.parse(fs.readFileSync(src, 'utf8'));

const logicBody = logicSrc
  .replace(/^\/\/[^\n]*\n/, '')
  .replace('module.exports = { createUniversalStrategy };', '')
  .trim();

function buildGeneratedBundle() {
  return `/** AUTO-GENERATED — do not edit. Source: shared/universal-customer-strategy-config.json */
(function (global) {
  'use strict';
  ${logicBody}
  var config = ${JSON.stringify(config, null, 2)};
  var classifyFn = (global.Cardetail1Segments && global.Cardetail1Segments.classifySegment) || function (input) {
    input = input || {};
    if (input.unsupportedZip || input.unsupportedService) {
      return { segment: config.segmentIds.MANUAL_REVIEW_OR_ALTERNATIVE_PATH, reasons: ['operational_alternative_path'] };
    }
    if (input.isCommercial) {
      return { segment: config.segmentIds.COMMERCIAL_FLEET, reasons: ['commercial_or_fleet_scale'] };
    }
    return { segment: config.segmentIds.SINGLE_VEHICLE_NEW, reasons: ['strategy_fallback'] };
  };
  var strategy = createUniversalStrategy(config, { classifySegment: classifyFn });
  global.Cardetail1UniversalStrategy = strategy;
  global.Cardetail1StrategyConfig = config;
})(typeof window !== 'undefined' ? window : globalThis);
`;
}

const expected = buildGeneratedBundle();

if (checkMode) {
  if (!fs.existsSync(outPath)) {
    console.error('[sync] STALE: missing assets/universal-customer-strategy.generated.js');
    console.error('[sync] Run: node scripts/sync-universal-strategy-config.mjs');
    process.exit(1);
  }
  const existing = fs.readFileSync(outPath, 'utf8');
  if (existing !== expected) {
    console.error('[sync] STALE: assets/universal-customer-strategy.generated.js does not match shared config.');
    console.error('[sync] Run: node scripts/sync-universal-strategy-config.mjs');
    process.exit(1);
  }
  console.log('[sync] OK: generated bundle is synchronized');
  process.exit(0);
}

fs.writeFileSync(outPath, expected, 'utf8');
console.log('[sync] wrote', outPath);
