'use strict';

// Regression: production served repository internals (Function sources,
// prisma/schema.prisma, package.json, BACKEND-SETUP.md, tests, docs) because
// netlify.toml published ".". The public artifact is now an allowlist in dist/.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildPublicDist, PUBLIC_FILES } = require('../scripts/build-public-dist');

const ROOT = path.join(__dirname, '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'cd1-public-dist-'));
buildPublicDist(OUT);
test.after(() => fs.rmSync(OUT, { recursive: true, force: true }));

const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}
const published = walk(OUT);
const publishedSet = new Set(published);

test('netlify.toml publishes dist/ after building it, Functions still from netlify/functions', () => {
  const build = toml.slice(toml.indexOf('[build]'), toml.indexOf('[build.environment]'));
  assert.match(build, /^\s*publish = "dist"\s*$/m);
  assert.match(build, /^\s*functions = "netlify\/functions"\s*$/m);
  assert.match(build, /command = "node scripts\/generate-deploy-runtime-env\.js && node scripts\/build-public-dist\.js"/);
});

test('internal files from the audit are not in the published artifact', () => {
  for (const rel of [
    'netlify/functions/submit-booking.js',
    'prisma/schema.prisma',
    'package.json',
    'package-lock.json',
    'BACKEND-SETUP.md',
    'README.md',
    'netlify.toml',
    'prisma.config.ts',
    '.env.example',
    'scripts/apply-onpage-seo.mjs',
    'netlify/lib/deploy-runtime-env.generated.js',
    'shared/universal-customer-strategy-config.json',
  ]) {
    assert.equal(publishedSet.has(rel), false, `${rel} must not be published`);
  }
  const forbiddenPrefixes = ['netlify/functions/', 'prisma/', 'tests/', 'docs/', 'scripts/', 'sandbox/', 'artifacts/', 'reports/', '.github/', '.claude/', '.cursor/', 'node_modules/'];
  for (const rel of published) {
    assert.ok(!forbiddenPrefixes.some((p) => rel.startsWith(p)), `${rel} is internal and must not be published`);
    assert.ok(!/\.(md|ts|mjs|cjs|prisma|sql|toml|env)$/i.test(rel), `${rel} has a non-public file type`);
  }
  const netlifyFiles = published.filter((rel) => rel.startsWith('netlify/'));
  assert.deepEqual(netlifyFiles.sort(), PUBLIC_FILES.filter((f) => f.startsWith('netlify/')).sort());
});

test('every root page, public asset and prototype file is published unchanged', () => {
  const tracked = walk(ROOT).filter((rel) => !rel.startsWith('node_modules/') && !rel.startsWith('.git/') && !rel.startsWith('dist/'));
  const rootHtml = tracked.filter((rel) => !rel.includes('/') && rel.endsWith('.html'));
  assert.ok(rootHtml.includes('index.html'));
  for (const rel of [...rootHtml, 'favicon.ico', 'robots.txt', 'sitemap.xml', 'llms.txt', ...PUBLIC_FILES]) {
    assert.ok(publishedSet.has(rel), `${rel} must be published`);
    assert.ok(fs.readFileSync(path.join(OUT, rel)).equals(fs.readFileSync(path.join(ROOT, rel))), `${rel} changed`);
  }
  for (const rel of tracked.filter((r) => (r.startsWith('assets/') || r.startsWith('prototype/')) && !r.endsWith('.md'))) {
    assert.ok(publishedSet.has(rel), `${rel} must be published`);
  }
});

// Every same-origin reference in a published page/script/stylesheet must resolve
// inside dist/, to a Function, or to a netlify.toml redirect source.
test('every local reference in published HTML/JS/CSS resolves in dist/', () => {
  const redirectFrom = [...toml.matchAll(/^\s*from = "([^"]+)"/gm)].map((m) => m[1]).filter((f) => f.startsWith('/'));
  const redirectMatch = (p) => redirectFrom.some((f) => (f.endsWith('/*') ? p.startsWith(f.slice(0, -1)) : p === f));
  const exists = (rel) => {
    rel = rel.replace(/^\/+/, '');
    if (rel === '' || publishedSet.has(rel)) return true;
    if (publishedSet.has(`${rel.replace(/\/$/, '')}/index.html`)) return true;
    return publishedSet.has(`${rel}.html`); // Netlify pretty URLs
  };
  const refRe = /(?:src|href|action|poster|data-src)\s*=\s*["']([^"'#?]+)|url\(\s*["']?([^"')#?]+)|fetch\(\s*["'`]([^"'`$#?]+)|["'`](\/(?:assets|data|netlify|prototype|shared)\/[^"'`$#?\s]+)/g;
  const missing = [];
  for (const rel of published.filter((r) => /\.(html|js|css)$/.test(r))) {
    const text = fs.readFileSync(path.join(OUT, rel), 'utf8');
    for (const m of text.matchAll(refRe)) {
      let ref = (m[1] || m[2] || m[3] || m[4] || '').trim();
      if (!ref || /^(?:[a-z]+:|\/\/|\{|\$|\+)/i.test(ref) || ref.includes('${')) continue;
      if (ref.startsWith('/.netlify/')) continue;
      if (!/\.[a-z0-9]{2,5}$/i.test(ref) && !ref.startsWith('/')) continue; // JS identifiers etc.
      // Scripts and partials run inside root pages, so their relative URLs resolve from /.
      const baseDir = /\.js$/.test(rel) || rel.startsWith('assets/partials/') ? '' : path.posix.dirname(rel);
      const abs = ref.startsWith('/') ? ref : '/' + path.posix.normalize(path.posix.join(baseDir, ref));
      if (abs.startsWith('/..')) continue;
      if (exists(abs) || redirectMatch(abs.replace(/\/$/, '') || '/')) continue;
      missing.push(`${rel} -> ${ref}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});
