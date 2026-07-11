#!/usr/bin/env node
/**
 * Ingest web-safe media from pics/new into assets/.
 * HEIC files must be exported to JPEG first (browsers cannot display HEIC).
 *
 * Usage:
 *   node scripts/ingest-pics-new.mjs
 *   node scripts/ingest-pics-new.mjs --check
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'pics', 'new');

const ROUTES = [
  { glob: /\.(jpe?g|jpg|webp|png)$/i, dest: (name) => path.join(ROOT, 'assets', 'media', 'ingest', name) },
  { glob: /\.(mp4|mov)$/i, dest: (name) => path.join(ROOT, 'assets', 'media', 'boats', name) },
];

const PENDING_HEIC = [];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function ingest(checkOnly = false) {
  if (!fs.existsSync(SRC)) {
    console.error('[ingest] missing pics/new');
    process.exit(1);
  }
  const files = fs.readdirSync(SRC);
  let copied = 0;
  let skipped = 0;

  for (const name of files) {
    const srcPath = path.join(SRC, name);
    if (!fs.statSync(srcPath).isFile()) continue;
    if (/\.heic$/i.test(name)) {
      PENDING_HEIC.push(name);
      skipped++;
      continue;
    }
    const route = ROUTES.find((r) => r.glob.test(name));
    if (!route) {
      skipped++;
      continue;
    }
    const destPath = route.dest(name);
    if (checkOnly) {
      if (!fs.existsSync(destPath)) {
        console.error(`[ingest] missing deployed copy: ${path.relative(ROOT, destPath)}`);
        process.exit(1);
      }
      continue;
    }
    ensureDir(path.dirname(destPath));
    fs.copyFileSync(srcPath, destPath);
    copied++;
    console.log(`[ingest] ${name} -> ${path.relative(ROOT, destPath)}`);
  }

  if (PENDING_HEIC.length) {
    console.warn('[ingest] HEIC pending JPEG export:', PENDING_HEIC.join(', '));
  }
  if (checkOnly) {
    console.log('[ingest] OK — web-safe pics/new assets present');
    return;
  }
  console.log(`[ingest] copied=${copied} skipped=${skipped}`);
}

const checkOnly = process.argv.includes('--check');
ingest(checkOnly);
