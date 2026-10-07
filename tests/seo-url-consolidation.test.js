'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PRICING } = require('../netlify/lib/booking-price-catalog');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const PUBLIC_STEMS = [
  'boats-detailing',
  'rv-detailing',
  'powersports-detailing',
  'trucks-detailing',
  'fleet-services',
  'multi-vehicle-detailing',
  'new-jersey-hub',
  'ny-metro-hub',
  'connecticut-hub',
  'pennsylvania-hub',
  'bergen-county-hub',
  'essex-county-hub',
  'hudson-county-hub',
  'passaic-county-hub',
  'palisades-park-mobile-detailing',
  'fort-lee-mobile-detailing',
  'paramus-mobile-detailing',
  'hackensack-mobile-detailing',
  'englewood-mobile-detailing',
  'teaneck-mobile-detailing',
  'ridgewood-mobile-detailing',
  'edgewater-mobile-detailing',
  'newark-mobile-detailing',
  'trenton-mobile-detailing',
  'westchester-mobile-detailing',
  'blog',
  'detailing-vs-car-wash',
  'how-often-to-detail',
  'mobile-detailing-what-to-expect',
  'reviews',
  'terms-conditions',
  'privacy-policy',
];

const CITY_PAGES = [
  'palisades-park-mobile-detailing.html',
  'fort-lee-mobile-detailing.html',
  'paramus-mobile-detailing.html',
  'hackensack-mobile-detailing.html',
  'englewood-mobile-detailing.html',
  'teaneck-mobile-detailing.html',
  'ridgewood-mobile-detailing.html',
  'edgewater-mobile-detailing.html',
];

const PRIVATE_PAGES = [
  'admin.html',
  'admin-ops.html',
  'admin-owner-studio.html',
  'admin-owner-studio-catalog.html',
  'technician.html',
  'customer.html',
  'my-garage.html',
  'authorize.html',
  'receipt.html',
  'bid.html',
  'resume.html',
  'template-city.html',
];

function parseRedirects(toml) {
  return toml.split('[[redirects]]').slice(1).map((block) => {
    const body = block.split('[[')[0];
    const from = body.match(/from = "([^"]+)"/);
    const to = body.match(/to = "([^"]+)"/);
    const status = body.match(/status = (\d+)/);
    if (!from || !to || !status) return null;
    return {
      from: from[1],
      to: to[1],
      status: Number(status[1]),
      force: /force = true/.test(body),
    };
  }).filter(Boolean);
}

function resolve(rules, pathname) {
  const chain = [pathname];
  let current = pathname;
  for (let hop = 0; hop < 6; hop += 1) {
    const rule = rules.find((item) => item.from === current);
    if (!rule) return { path: current, hops: chain.length - 1, chain, rewrite: null };
    if (rule.status === 200) {
      return { path: current, hops: chain.length - 1, chain, rewrite: rule.to };
    }
    if (rule.status >= 300 && rule.status < 400) {
      current = rule.to.split('?')[0];
      chain.push(current);
      continue;
    }
    return { path: current, hops: chain.length - 1, chain, rewrite: null };
  }
  return { path: current, hops: 99, chain, rewrite: null };
}

test('public pages canonicalize to the extensionless URL with no campaign parameters', () => {
  const index = read('index.html');
  assert.match(index, /<link rel="canonical" href="https:\/\/cardetail1.com\/">/);
  assert.doesNotMatch(index, /rel="canonical" href="[^"]*[?#]/);
  for (const stem of PUBLIC_STEMS) {
    const html = read(`${stem}.html`);
    assert.match(html, new RegExp(`<link rel="canonical" href="https://cardetail1.com/${stem}">`));
    assert.doesNotMatch(html, /rel="canonical" href="[^"]*[?#]/);
    assert.doesNotMatch(html, new RegExp(`rel="canonical" href="https://cardetail1.com/${stem}\\.html"`));
  }
});

test('sitemap lists only extensionless canonical public URLs', () => {
  const sitemap = read('sitemap.xml');
  assert.match(sitemap, /<loc>https:\/\/cardetail1.com\/<\/loc>/);
  assert.doesNotMatch(sitemap, /\.html/);
  assert.doesNotMatch(sitemap, /[?&](utm_|gclid|gbraid|wbraid|book=)/);
  for (const stem of PUBLIC_STEMS) {
    assert.match(sitemap, new RegExp(`<loc>https://cardetail1.com/${stem}</loc>`));
  }
  for (const page of PRIVATE_PAGES) {
    assert.doesNotMatch(sitemap, new RegExp(page.replace('.html', '')));
  }
});

test('public pages link directly to extensionless canonical URLs', () => {
  const hrefRe = /href="([^"]+)"/g;
  const files = ['index.html', ...PUBLIC_STEMS.map((stem) => `${stem}.html`)];
  for (const file of files) {
    const html = read(file);
    hrefRe.lastIndex = 0;
    let match;
    while ((match = hrefRe.exec(html)) !== null) {
      const href = match[1];
      for (const target of PUBLIC_STEMS) {
        assert.equal(
          href.includes(`/${target}.html`) || href === `${target}.html` || href.startsWith(`${target}.html#`) || href.startsWith(`${target}.html?`),
          false,
          `${file} links to ${href}`,
        );
      }
    }
  }
});

test('html duplicates 301 once to the extensionless URL and do not loop', () => {
  const rules = parseRedirects(read('netlify.toml'));
  const index = resolve(rules, '/index.html');
  assert.equal(index.hops, 1);
  assert.equal(index.path, '/');
  assert.equal(resolve(rules, '/').hops, 0);

  for (const stem of PUBLIC_STEMS) {
    const html = resolve(rules, `/${stem}.html`);
    assert.equal(html.hops, 1, `${stem}.html should redirect once`);
    assert.equal(html.path, `/${stem}`);
    assert.ok(html.chain.length < 4, `${stem} redirect chain too long`);
    const clean = resolve(rules, `/${stem}`);
    assert.equal(clean.hops, 0, `/${stem} must not redirect`);
    assert.equal(clean.rewrite, null, `/${stem} must not rewrite back to .html`);
    const rule = rules.find((item) => item.from === `/${stem}.html`);
    assert.equal(rule.status, 301);
    assert.equal(rule.force, true);
    assert.equal(rule.to.includes('?'), false);
  }
});

test('campaign and booking parameters stay on the clean canonical', () => {
  const index = read('index.html');
  assert.match(index, /<link rel="canonical" href="https:\/\/cardetail1.com\/">/);
  assert.match(read('assets/revenue-events.js'), /gclid/);
  assert.match(read('assets/revenue-events.js'), /gbraid/);
  assert.match(read('assets/revenue-events.js'), /wbraid/);
  assert.match(read('assets/hub-booking-bridge.js'), /frame\.src = '\/\?'/);
  assert.match(read('assets/specialty-booking-bridge.js'), /frame\.src = '\/\?'/);
});

test('public pages use one business phone', () => {
  const pages = ['index.html', ...PUBLIC_STEMS.map((stem) => `${stem}.html`), ...CITY_PAGES];
  for (const page of new Set(pages)) {
    const html = read(page);
    assert.match(html, /\+15513893986/, `${page} missing the public phone`);
    assert.doesNotMatch(html, /373-5668|5513735668|\+15513735668/, `${page} still has the old public number`);
  }
});

test('Bergen city landing prices match the car catalog', () => {
  const cars = PRICING.cars.tiers;
  const interior = `Sedans from $${cars.small.interior} · SUVs from $${cars.suv2.interior} · trucks from $${cars.truck.interior}`;
  const full = `Sedans from $${cars.small.full} · SUVs from $${cars.suv2.full} · 3-row from $${cars.suv3.full}`;
  for (const page of CITY_PAGES) {
    const html = read(page);
    assert.match(html, new RegExp(`<div class="sp-pkg-price">From \\$${cars.small.interior}</div>`));
    assert.match(html, new RegExp(`<div class="sp-pkg-price">From \\$${cars.small.full}</div>`));
    assert.match(html, new RegExp(`<div class="sp-pkg-price">From \\$${cars.small.refresh}</div>`));
    assert.match(html, new RegExp(`"name": "Exterior Detail & Paint Enhancement",[\\s\\S]*?"price": "${cars.small.refresh}"`));
    assert.match(html, new RegExp(interior.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(html, new RegExp(full.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(html, /From \$320|from \$370|\$220 interior|\$275 full|\$385 sedan/);
  }
  assert.match(read('hackensack-mobile-detailing.html'), new RegExp(`starts at \\$${PRICING.fleet.tiers.vehicle.maint} per unit`));
});

test('public pages do not contain the corrupted pin sequence', () => {
  for (const file of fs.readdirSync(root).filter((name) => name.endsWith('.html'))) {
    assert.equal(read(file).includes('📍ž'), false, `${file} contains 📍ž`);
  }
});

test('private and operational pages stay out of the sitemap and are noindexed', () => {
  const sitemap = read('sitemap.xml');
  const robots = read('robots.txt');
  for (const page of PRIVATE_PAGES) {
    const html = read(page);
    assert.match(html, /noindex/i, `${page} missing noindex`);
    assert.doesNotMatch(sitemap, new RegExp(page.replace('.html', '')));
  }
  assert.match(robots, /Disallow: \/admin/);
  assert.match(robots, /Disallow: \/technician\.html/);
  assert.match(robots, /Disallow: \/template-city\.html/);
  const toml = read('netlify.toml');
  assert.match(toml, /for = "\/ops\/q"/);
  assert.match(toml, /X-Robots-Tag = "noindex"/);
  assert.match(toml, /for = "\/pay"/);
});

test('cookie banner offsets mobile sticky CTAs instead of covering them', () => {
  const css = read('assets/consent-manager.js');
  assert.match(css, /html\.cd1-consent-open \.mobile-sticky-cta,html\.cd1-consent-open \.cd1-ceramic-sticky\.is-on\{bottom:var\(--cd1-consent-offset,0px\)\}/);
  assert.match(css, /html\.cd1-consent-open \.booking-modal\{max-height:calc\(95svh - var\(--cd1-consent-offset,0px\)\)/);
  assert.match(css, /@media\(max-width:640px\)\{html\.cd1-consent-open body\{padding-bottom:calc\(68px \+ var\(--cd1-consent-offset,0px\)\)\}/);
});
