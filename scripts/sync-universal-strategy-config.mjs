#!/usr/bin/env node
/** Sync shared/universal-customer-strategy-config.json → frontend + function bundles. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const src = path.join(root, 'shared/universal-customer-strategy-config.json');
const backendConfigPath = path.join(root, 'netlify/lib/universal-customer-strategy-config.json');
const logicPath = path.join(root, 'netlify/lib/universal-customer-strategy-logic.js');
const outPath = path.join(root, 'assets/universal-customer-strategy.generated.js');
const checkMode = process.argv.includes('--check');

/**
 * The generated bundle is compared to the committed artifact byte for byte, so
 * it has to be reproducible. Without this, every newline in the output came from
 * however Git happened to check the inputs out — and the template literal below
 * contributes the newlines of THIS file. Under core.autocrlf=true that made
 * --check report STALE on a clean checkout while `diff -w` showed zero lines of
 * real difference. Normalise on the way in and emit LF on the way out.
 */
const toLf = (s) => s.replace(/\r\n/g, '\n');

const logicSrc = toLf(fs.readFileSync(logicPath, 'utf8'));
const config = JSON.parse(toLf(fs.readFileSync(src, 'utf8')));
const backendConfigJson = `${JSON.stringify(config, null, 2)}\n`;

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
  let stale = false;
  if (!fs.existsSync(outPath)) {
    console.error('[sync] STALE: missing assets/universal-customer-strategy.generated.js');
    stale = true;
  } else {
    // Compare on content, not on line endings. A checkout that rewrote the
    // artifact to CRLF is not a stale artifact.
    const existing = toLf(fs.readFileSync(outPath, 'utf8'));
    if (existing !== expected) {
      console.error('[sync] STALE: assets/universal-customer-strategy.generated.js does not match shared config.');
      stale = true;
    }
  }
  if (!fs.existsSync(backendConfigPath)) {
    console.error('[sync] STALE: missing netlify/lib/universal-customer-strategy-config.json');
    stale = true;
  } else {
    const backendExisting = toLf(fs.readFileSync(backendConfigPath, 'utf8'));
    if (backendExisting !== backendConfigJson) {
      console.error('[sync] STALE: netlify/lib/universal-customer-strategy-config.json does not match shared config.');
      stale = true;
    }
  }
  if (stale) {
    console.error('[sync] Run: node scripts/sync-universal-strategy-config.mjs');
    process.exit(1);
  }
  console.log('[sync] OK: generated bundle and function config are synchronized');
  process.exit(0);
}

fs.writeFileSync(outPath, expected, 'utf8');
fs.writeFileSync(backendConfigPath, backendConfigJson, 'utf8');
console.log('[sync] wrote', outPath);
console.log('[sync] wrote', backendConfigPath);
