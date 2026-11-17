#!/usr/bin/env node
/**
 * Copy the homepage /#business JSON-LD entity onto every public page that
 * redefines it, so all pages describe one identical business.
 *
 * Structured data only. It does not touch visible copy, booking, pricing,
 * payment, analytics, or the ZIP travel gate.
 *
 *   node scripts/sync-business-entity.mjs          # apply
 *   node scripts/sync-business-entity.mjs --check  # exit 1 on drift
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadCanonicalBusiness, syncBusinessEntity } from './lib/canonical-business-entity.mjs';

const root = path.resolve(import.meta.dirname, '..');
const checkOnly = process.argv.includes('--check');
const canonical = loadCanonicalBusiness(root);

const pages = fs.readdirSync(root).filter((f) => f.endsWith('.html') && f !== 'index.html').sort();
const drift = [];
for (const file of pages) {
  const full = path.join(root, file);
  const raw = fs.readFileSync(full, 'utf8');
  const crlf = raw.includes('\r\n');
  const { src, changed } = syncBusinessEntity(raw.replace(/\r\n/g, '\n'), canonical, file);
  if (!changed) continue;
  drift.push(`${file} (${changed} block${changed > 1 ? 's' : ''})`);
  if (!checkOnly) fs.writeFileSync(full, crlf ? src.replace(/\n/g, '\r\n') : src);
}

if (checkOnly) {
  if (drift.length) {
    console.error(`business entity drift:\n  ${drift.join('\n  ')}\nRun: node scripts/sync-business-entity.mjs`);
    process.exit(1);
  }
  console.log('business entity: all pages match index.html');
} else {
  console.log(drift.length ? `synced:\n  ${drift.join('\n  ')}` : 'business entity: nothing to change');
}
