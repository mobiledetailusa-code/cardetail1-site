/**
 * Pre-commit stabilization checks — focused release blockers.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const SPECIALTY_PAGES = ['boats-detailing.html', 'rv-detailing.html', 'powersports-detailing.html'];
const HUB_PAGES = [
  'new-jersey-hub.html', 'ny-metro-hub.html', 'connecticut-hub.html', 'pennsylvania-hub.html',
  'bergen-county-hub.html', 'essex-county-hub.html', 'hudson-county-hub.html', 'passaic-county-hub.html',
  'newark-mobile-detailing.html', 'trenton-mobile-detailing.html', 'westchester-mobile-detailing.html',
  'template-city.html', 'index.html',
];
const PACKAGE_MAP = {
  'boats-detailing.html': { cat: 'boats', pkgs: ['maint', 'full', 'premium'] },
  'rv-detailing.html': { cat: 'rvs', pkgs: ['exterior', 'interior', 'full', 'premium'] },
  'powersports-detailing.html': { cat: 'powersports', pkgs: ['wash', 'full', 'premium'] },
};

function sitemapUrls() {
  const xml = read('sitemap.xml');
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}

function sitemapToFile(url) {
  const pathPart = url.replace('https://cardetail1.com/', '').replace(/\/$/, '');
  return pathPart || 'index.html';
}

function extractHomeServiceLinks(html) {
  const section = html.match(/<section class="home-service-areas"[\s\S]*?<\/section>/);
  if (!section) return [];
  const links = [];
  const re = /<a class="service-area-(?:city|hub)-link"\s+href="([^"]+)">([^<]+)<\/a>/g;
  let m;
  while ((m = re.exec(section[0])) !== null) {
    links.push({ href: m[1], text: m[2].trim() });
  }
  return links;
}

function resolveHref(href) {
  const [file, hash] = href.replace(/^\//, '').split('#');
  const filePath = path.join(root, file);
  assert.ok(fs.existsSync(filePath), `missing destination for ${href}`);
  if (hash) {
    const html = read(file);
    assert.match(html, new RegExp(`id="${hash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  }
  return file;
}

test('sitemap reported count equals actual URL entries (17)', () => {
  const urls = sitemapUrls();
  assert.equal(urls.length, 17);
});

test('every sitemap route file exists on disk', () => {
  for (const url of sitemapUrls()) {
    const file = sitemapToFile(url);
    assert.ok(fs.existsSync(path.join(root, file)), `${url} -> ${file}`);
  }
});

test('no public booking page contains empty updateBkFromPrices stub', () => {
  for (const page of HUB_PAGES) {
    const html = read(page);
    if (!html.includes('function updateBkFromPrices')) continue;
    assert.doesNotMatch(
      html,
      /function updateBkFromPrices\(\)\{\s*\}/,
      `${page} has empty updateBkFromPrices stub`
    );
    if (html.includes('id="bkfrom-boats"')) {
      assert.match(html, /LENGTH_PRICING\.boats\.packages\.maint\.min/, `${page} missing boats price source`);
    }
  }
});

test('Boats RV Powersports share identical specialty-public-footer structure', () => {
  const canonical = read('assets/partials/specialty-public-footer.html')
    .replace(/<!--[\s\S]*?-->\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  for (const page of SPECIALTY_PAGES) {
    const html = read(page);
    assert.match(html, /class="specialty-public-footer"/);
    assert.match(html, /assets\/specialty-public-footer\.css/);
    assert.match(html, /Boat &amp; Marine Detailing/);
    assert.match(html, /RV &amp; Trailer Detailing/);
    assert.match(html, /Powersports Detailing/);
    assert.match(html, /Commercial &amp; Fleet Inquiry/);
    assert.match(html, /New Jersey service areas/);
    assert.match(html, /View your booking/);
    assert.match(html, /terms-conditions\.html/);
    const footer = html.match(/<footer class="specialty-public-footer"[\s\S]*?<\/footer>/);
    assert.ok(footer, `${page} missing shared footer`);
    const normalized = footer[0].replace(/\s+/g, ' ').trim();
    assert.equal(normalized, canonical, `${page} footer differs from canonical partial`);
  }
});

test('booking bridge never redirects to homepage on failure', () => {
  const js = read('assets/specialty-booking-bridge.js');
  assert.doesNotMatch(js, /navigateToHomepageBooking/);
  assert.doesNotMatch(js, /location\.assign\s*\(\s*['"]index\.html/);
  assert.doesNotMatch(js, /window\.location\s*=\s*['"]\/?['"]/);
  assert.match(js, /We could not load this booking option/);
  assert.match(js, /551-313-2956/);
  assert.match(js, /categoryId === 'cars'/);
  assert.doesNotMatch(js, /fallback.*cars|default.*cars/i);
});

test('every specialty package CTA maps to valid package IDs', () => {
  const index = read('index.html');
  for (const [page, cfg] of Object.entries(PACKAGE_MAP)) {
    const html = read(page);
    for (const pkg of cfg.pkgs) {
      assert.match(
        html,
        new RegExp(`data-booking-category="${cfg.cat}"[^>]*data-booking-package="${pkg}"|data-booking-package="${pkg}"[^>]*data-booking-category="${cfg.cat}"`)
      );
      const catBlock = index.match(new RegExp(`${cfg.cat}:\\s*\\{[\\s\\S]*?packages:\\[([\\s\\S]*?)\\],\\s*addons:`));
      assert.ok(catBlock, `missing ${cfg.cat} packages in index`);
      assert.match(catBlock[1], new RegExp(`id:'${pkg}'`));
    }
  }
});

test('every homepage service-area link resolves to an existing file and anchor', () => {
  const links = extractHomeServiceLinks(read('index.html'));
  assert.ok(links.length >= 8 && links.length <= 12);
  for (const link of links) {
    resolveHref(link.href);
  }
});

test('homepage has compact specialty switcher and no oversized duplicate block', () => {
  const html = read('index.html');
  assert.match(html, /class="specialty-service-nav"/);
  assert.doesNotMatch(html, /id="specialty-services"/);
  assert.doesNotMatch(html, /More than cars/i);
  assert.doesNotMatch(html, /Featured boat page/i);
  const switchers = html.match(/<nav class="specialty-service-nav"[\s\S]*?<\/nav>/g) || [];
  assert.equal(switchers.length, 1);
});

test('accidental local QA server file is not in working tree', () => {
  assert.ok(!fs.existsSync(path.join(root, 'scripts/_qa-server.mjs')));
});

test('no Netlify Function files changed vs production master', () => {
  let diff = '';
  try {
    diff = execSync('git diff --name-only e9ebbe0e50d2768d0bea9fb391ad50c63239b7f7 -- netlify/functions netlify/lib', {
      cwd: root,
      encoding: 'utf8',
    });
  } catch (e) {
    diff = e.stdout || '';
  }
  assert.equal(diff.trim(), '', `unexpected backend diff: ${diff}`);
});

test('package IDs in index PRICING unchanged for specialty categories', () => {
  const html = read('index.html');
  assert.match(html, /boats:[\s\S]*?id:'maint'/);
  assert.match(html, /rvs:[\s\S]*?id:'exterior'/);
  assert.match(html, /powersports:[\s\S]*?id:'wash'/);
});

test('LENGTH_PRICING formulas unchanged (boat maint min 199, rv exterior min 349)', () => {
  const html = read('index.html');
  assert.match(html, /boats:[\s\S]*?maint:\s*\{perFt:\s*12,\s*min:\s*199\}/);
  assert.match(html, /rvs:[\s\S]*?exterior:\s*\{perFt:\s*12,\s*min:\s*349\}/);
});

test('no secrets in public HTML/JS specialty surface', () => {
  const patterns = [
    /sk_live_[A-Za-z0-9]+/,
    /STRIPE_SECRET_KEY\s*=\s*['"][^'"]+['"]/,
    /ADMIN_DASH_PASSWORD\s*=\s*['"][^'"]+['"]/,
    /ADMIN_SESSION_SECRET\s*=\s*['"][^'"]+['"]/,
    /whsec_[A-Za-z0-9]+/,
  ];
  const files = [...SPECIALTY_PAGES, 'assets/specialty-booking-bridge.js', 'index.html'];
  for (const f of files) {
    const content = read(f);
    for (const re of patterns) {
      assert.doesNotMatch(content, re, `${f} may expose secret`);
    }
  }
});

test('cars public carousel uses interior minimum not maint in getCategoryFromBases', () => {
  const html = read('index.html');
  assert.match(html, /getCategoryFromBases\(\)[\s\S]*?cars:Math\.min\([\s\S]*?\.interior\)/);
  assert.doesNotMatch(html, /getCategoryFromBases\(\)[\s\S]*?cars:Math\.min\([\s\S]*?\.maint\)/);
});

test('updateBkFromPrices does not overwrite cars category note with maint price', () => {
  const html = read('index.html');
  const fn = html.match(/function updateBkFromPrices\(\)\{[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(fn, /cars:/);
  assert.match(html, /id="bkfrom-cars"[\s\S]*?Packages shown after ZIP check/);
});
