/**
 * Production stabilization regression suite (public surface).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const PUBLIC_COMMERCIAL = [
  'index.html',
  'boats-detailing.html',
  'rv-detailing.html',
  'powersports-detailing.html',
  'fleet-services.html',
  'new-jersey-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
  'bergen-county-hub.html',
  'essex-county-hub.html',
  'hudson-county-hub.html',
  'passaic-county-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
];

const SPECIALTY_PAGES = ['boats-detailing.html', 'rv-detailing.html', 'powersports-detailing.html'];

function extractSitemapUrls() {
  const xml = read('sitemap.xml');
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}

function h1Count(html) {
  return (html.match(/<h1[\s>]/gi) || []).length;
}

test('homepage no longer says Book in four steps', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /Book in four steps/i);
  assert.match(html, /Book online in a few simple steps/i);
});

test('index updateBkFromPrices derives specialty mins from LENGTH_PRICING / PRICING', () => {
  const html = read('index.html');
  assert.match(html, /function updateBkFromPrices\(\)\{/);
  assert.doesNotMatch(html, /function updateBkFromPrices\(\)\{\s*\}/);
  assert.match(html, /LENGTH_PRICING\.boats\.packages\.maint\.min/);
  assert.match(html, /LENGTH_PRICING\.rvs\.packages\.exterior\.min/);
  assert.match(html, /PRICING\.powersports\.tiers/);
  assert.match(html, /updateBkFromPrices\(\);/);
});

test('booking category starting prices align with catalog minimums', () => {
  const html = read('index.html');
  assert.match(html, /boats:[\s\S]*?maint:\s*\{perFt:\s*12,\s*min:\s*199\}/);
  assert.match(html, /rvs:[\s\S]*?exterior:\s*\{perFt:\s*12,\s*min:\s*349\}/);
  assert.match(html, /motorcycle:\s*\{[\s\S]*?wash:119/);
  assert.match(html, /id="bkfrom-boats"[\s\S]*?From \$199/);
  assert.match(html, /id="bkfrom-rvs"[\s\S]*?From \$349/);
  assert.match(html, /id="bkfrom-powersports"[\s\S]*?From \$119/);
  assert.match(html, /id="home-from-interior">\$225/);
  assert.match(html, /getCategoryFromBases\(\)[\s\S]*?\.interior\)/);
});

test('specialty dedicated pages use logo header shell', () => {
  for (const page of SPECIALTY_PAGES) {
    const html = read(page);
    assert.match(html, /class="nav-brand-img"/, `${page} missing logo header`);
    assert.match(html, /cardetail1-logo\.webp/, `${page} missing logo image`);
    assert.match(html, /Call \/ Text/, `${page} missing call/text`);
    assert.doesNotMatch(html, />Cardetail1 Home</, `${page} still uses text-only home link`);
  }
});

test('customer portal has no public Admin tab', () => {
  const html = read('my-garage.html');
  assert.doesNotMatch(html, /id="ltab-admin"/);
  assert.doesNotMatch(html, /setLoginRole\('admin'\)/);
  assert.match(html, /My Garage/);
});

test('customer.html is a redirect handoff only', () => {
  const html = read('customer.html');
  assert.match(html, /my-garage\.html/);
  assert.doesNotMatch(html, /#s-app|#s-lookup/);
});

test('fleet-services.html is quote-only (no public unit pricing or fleet booking)', () => {
  const html = read('fleet-services.html');
  assert.doesNotMatch(html, /\$60\/unit/i);
  assert.doesNotMatch(html, /From \$60/i);
  assert.doesNotMatch(html, /Book Fleet Wash/i);
  assert.match(html, /Request a Fleet Quote/i);
  assert.match(html, /submit-inquiry/);
  assert.match(html, /id="fleet-quote-form"/);
});

test('sitemap lists canonical public routes and excludes admin/customer portals', () => {
  const urls = extractSitemapUrls();
  assert.equal(urls.length, 18);
  assert.ok(urls.includes('https://cardetail1.com/'));
  for (const slug of [
    'boats-detailing.html',
    'rv-detailing.html',
    'powersports-detailing.html',
    'fleet-services.html',
    'multi-vehicle-detailing.html',
    'new-jersey-hub.html',
    'connecticut-hub.html',
    'pennsylvania-hub.html',
    'newark-mobile-detailing.html',
  ]) {
    assert.ok(urls.some((u) => u.endsWith('/' + slug)), `missing sitemap url ${slug}`);
  }
  for (const bad of ['admin.html', 'customer.html', 'technician.html', 'admin-ops.html']) {
    assert.ok(!urls.some((u) => u.includes(bad)), `sitemap must not include ${bad}`);
  }
});

test('every sitemap HTML target exists on disk', () => {
  for (const url of extractSitemapUrls()) {
    const file = url.replace('https://cardetail1.com/', '').replace(/\/$/, 'index.html') || 'index.html';
    const resolved = file === '' ? 'index.html' : file;
    assert.ok(fs.existsSync(path.join(root, resolved)), `missing file for ${url}`);
  }
});

test('public commercial pages have exactly one H1', () => {
  for (const page of PUBLIC_COMMERCIAL) {
    const count = h1Count(read(page));
    assert.equal(count, 1, `${page} has ${count} H1 elements`);
  }
});

test('netlify CSP allows same-origin booking iframe', () => {
  assert.match(read('netlify.toml'), /frame-src 'self'/);
});

test('index footer links to dedicated specialty pages', () => {
  const footer = read('index.html').slice(read('index.html').indexOf('<footer'));
  assert.match(footer, /href="boats-detailing\.html"/);
  assert.match(footer, /href="rv-detailing\.html"/);
  assert.match(footer, /href="powersports-detailing\.html"/);
  assert.match(footer, /href="fleet-services\.html"/);
  assert.match(footer, /Commercial &amp; Fleet/);
});
