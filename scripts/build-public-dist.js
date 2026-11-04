#!/usr/bin/env node
/**
 * Compose the public static artifact for Netlify.
 *
 * netlify.toml used to publish the repository root ("."), so every tracked
 * file was downloadable: Function sources (netlify/functions/*.js), the Prisma
 * schema, package.json, internal docs, tests and the Square sandbox.
 *
 * This script copies an explicit allowlist of public files into dist/ and
 * netlify.toml publishes dist/. Netlify Functions are unaffected: they are
 * still bundled from netlify/functions in the repository root.
 *
 * Adding a public file outside the allowlist? Add it here. The regression test
 * tests/public-dist-allowlist.test.js fails if a page references a local file
 * that is missing from dist/.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_OUT = path.join(ROOT, 'dist');

/** Root-level files served as-is (besides every root *.html). */
const ROOT_FILES = ['favicon.ico', 'robots.txt', 'sitemap.xml', 'llms.txt'];

/** Whole directories that are public by design. */
const PUBLIC_DIRS = [
  'assets',
  // /portal-prototype redirects here (mock data only, noindex via headers).
  'prototype',
];

/** Individual files outside those directories that the browser loads. */
const PUBLIC_FILES = [
  // Browser modules that live next to server code in netlify/lib.
  'netlify/lib/admin-session-client.js',
  'netlify/lib/site-access-client.js',
  'netlify/lib/owner-studio-catalog-ux-logic.js',
  'netlify/lib/owner-studio/storefront-preview-adapter.js',
];

function copyFile(rel, outDir) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) throw new Error(`public file missing from repository: ${rel}`);
  const dest = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(rel, outDir) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) throw new Error(`public directory missing from repository: ${rel}`);
  // Docs that sit next to public files (e.g. prototype/README.md) stay private.
  fs.cpSync(src, path.join(outDir, rel), { recursive: true, filter: (f) => !/\.md$/i.test(f) });
}

function buildPublicDist(outDir = DEFAULT_OUT) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const rootHtml = fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.html'))
    .map((d) => d.name);
  for (const rel of [...rootHtml, ...ROOT_FILES, ...PUBLIC_FILES]) copyFile(rel, outDir);
  for (const rel of PUBLIC_DIRS) copyDir(rel, outDir);
  return { outDir, rootHtml: rootHtml.length };
}

module.exports = { buildPublicDist, ROOT_FILES, PUBLIC_DIRS, PUBLIC_FILES };

if (require.main === module) {
  const out = process.env.PUBLIC_DIST_OUT ? path.resolve(process.env.PUBLIC_DIST_OUT) : DEFAULT_OUT;
  const { rootHtml } = buildPublicDist(out);
  console.log(`[build-public-dist] ${rootHtml} pages + allowlisted assets -> ${path.relative(ROOT, out) || '.'}`);
}
