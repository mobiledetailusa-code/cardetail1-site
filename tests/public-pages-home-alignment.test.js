'use strict';

// Public hub/city/landing pages stay aligned with the current homepage presentation
// (scripts/align-public-pages-with-home.mjs). Presentation only: pricing, the ZIP
// travel gate, checkout and analytics are covered by their own suites.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const visible = (html) => html
  .replace(/<script(?![^>]*ld\+json)[\s\S]*?<\/script>/g, ' ')
  .replace(/<style[\s\S]*?<\/style>/g, ' ');

const LEGACY_HUBS = ['bergen-county-hub.html', 'essex-county-hub.html', 'hudson-county-hub.html', 'passaic-county-hub.html'];
const LEGACY_CITIES = ['newark-mobile-detailing.html', 'trenton-mobile-detailing.html', 'westchester-mobile-detailing.html'];
const STATE_HUBS = ['new-jersey-hub.html', 'ny-metro-hub.html', 'connecticut-hub.html', 'pennsylvania-hub.html'];
const FULL_CLONES = [...LEGACY_HUBS, ...LEGACY_CITIES, ...STATE_HUBS, 'template-city.html'];
const COUNTY_HUBS = ['union-county-hub.html', 'morris-county-hub.html', 'rockland-county-hub.html', 'fairfield-county-hub.html'];
const BERGEN_CITIES = ['palisades-park', 'fort-lee', 'paramus', 'hackensack', 'englewood', 'teaneck', 'ridgewood', 'edgewater']
  .map((c) => `${c}-mobile-detailing.html`);

test('alignment script reports no drift', () => {
  execFileSync(process.execPath, [path.join(root, 'scripts/align-public-pages-with-home.mjs'), '--check'], { cwd: root, stdio: 'pipe' });
});

test('legacy hubs no longer promise a 120-mile radius in visible copy, and keep the Palisades Park base', () => {
  for (const f of LEGACY_HUBS) {
    const html = visible(read(f));
    assert.doesNotMatch(html, /up to\s*(?:<strong>)?120 miles/i, f);
    assert.doesNotMatch(html, /We operate from our <strong>(?!Palisades)/, f);
    assert.match(html, /Based in <strong>Palisades Park, NJ<\/strong>/, f);
    assert.match(html, /Extended service areas are available by quote/, f);
  }
});

test('the operational ZIP gate is unchanged (presentation-only change)', () => {
  assert.match(read('assets/travel-fee-client.js'), /var TRAVEL_MAX_MILES = 120;/);
});

test('legacy "Four steps / Zero hassle" section is replaced by the current three-step process', () => {
  for (const f of FULL_CLONES) {
    const html = read(f);
    assert.doesNotMatch(html, /FOUR STEPS/, f);
    assert.doesNotMatch(html, /ZERO HASSLE/, f);
    assert.match(html, /<div class="sec-title">Three simple steps<\/div>/, f);
    assert.match(html, /\.how-grid--three\{/, f);
  }
});

test('full-clone pages use the shared first-party reviews component', () => {
  for (const f of FULL_CLONES) {
    const html = read(f);
    assert.doesNotMatch(html, /const REVIEWS\s*=\s*\[/, `${f} still ships an inline review list`);
    assert.doesNotMatch(html, /id="rv-counter"/, f);
    assert.doesNotMatch(html, /Magno Junior/, f);
    assert.match(html, /<script src="assets\/customer-reviews\.js"><\/script>/, f);
    assert.match(html, /CD1CustomerReviews\.mount\(\)/, f);
    assert.match(html, /id="rv-viewport"/, f);
    assert.match(html, /href="\/reviews"/, f);
    assert.match(html, /class="rv-local-note"/, f);
    // reviews script must load before the inline script that calls renderReviews()
    assert.ok(html.indexOf('assets/customer-reviews.js') < html.indexOf('function renderReviews()'), f);
  }
});

test('no corrupted characters in visible copy or booking UI strings', () => {
  for (const f of FULL_CLONES) {
    const html = read(f);
    assert.doesNotMatch(html, /📍¸/, f);
    assert.doesNotMatch(html, /Ã—/, f);
    assert.doesNotMatch(html, /🚥/, f);
    assert.doesNotMatch(visible(html), /Ã|â€|�/, `${f} has mojibake outside scripts`);
  }
});

test('non-Bergen legacy pages do not present themselves as Bergen County', () => {
  for (const f of [...LEGACY_HUBS.slice(1), ...LEGACY_CITIES]) {
    const html = visible(read(f));
    assert.doesNotMatch(html, /Bergen County neighbors/, f);
    assert.doesNotMatch(html, /<div class="trust-lbl">Bergen County<\/div>/, f);
    assert.doesNotMatch(html, /Serving Bergen County &amp; North Jersey/, f);
    assert.doesNotMatch(html, /By Appointment Only · Bergen County, NJ/, f);
    assert.match(html, /Palisades Park/, `${f} should keep the real base`);
  }
  for (const f of LEGACY_CITIES) {
    const html = read(f);
    const title = html.match(/<title>([^<]+)<\/title>/)[1];
    assert.match(html, new RegExp(`<meta property="og:title" content="${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">`), f);
    assert.doesNotMatch(html, /og:title" content="Cardetail1 — Mobile Detailing \| Palisades Park/, f);
  }
});

test('full-clone nav matches the homepage link set without the duplicate My Booking entry', () => {
  for (const f of FULL_CLONES) {
    const nav = read(f).match(/<nav class="nav" id="main-nav">[\s\S]*?<\/nav>/)[0];
    for (const href of ['/ceramic-coating', '/blog', 'my-garage.html', 'tel:+15513893986']) {
      assert.ok(nav.includes(`href="${href}"`), `${f} nav missing ${href}`);
    }
    assert.doesNotMatch(nav, />My Booking</, f);
    assert.match(nav, /booking-popup-trigger/, f);
    assert.match(read(f), /href="\/trucks-detailing">Semi Trucks</, f);
  }
});

test('landing-style navs link Ceramic Coating and My Garage', () => {
  for (const f of [...COUNTY_HUBS, ...BERGEN_CITIES, 'boats-detailing.html', 'rv-detailing.html', 'powersports-detailing.html',
    'trucks-detailing.html', 'fleet-services.html', 'blog.html', 'reviews.html']) {
    const nav = read(f).match(/<div class="nav-links" id="nav-links">[\s\S]*?<\/div>/)[0];
    assert.ok(nav.includes('href="/ceramic-coating"'), `${f} nav missing Ceramic Coating`);
    assert.ok(nav.includes('href="my-garage.html"'), `${f} nav missing My Garage`);
  }
});

test('county hub footers use the same hours as every other public page', () => {
  for (const f of COUNTY_HUBS) {
    const html = read(f);
    assert.doesNotMatch(html, /Mon–Fri 8AM–5PM/, f);
    assert.match(html, /<span class="foot-static">Monday–Saturday · By Appointment Only<\/span>/, f);
  }
});

test('Bergen city landings carry ad parameters onto the booking handoff', () => {
  for (const f of BERGEN_CITIES) {
    const html = read(f);
    assert.match(html, /<script src="assets\/county-hub-booking-attribution\.js" defer><\/script>/, f);
    assert.match(html, /href="\/\?book=cars&amp;zip=\d{5}"/, `${f} handoff link changed`);
  }
});

test('Bergen hub city links are styled on a page that does not load luxury-theme.css', () => {
  const html = read('bergen-county-hub.html');
  assert.doesNotMatch(html, /<link[^>]+assets\/luxury-theme\.css/);
  assert.match(html, /#bergen-cities \.service-area-city-link\{display:flex/);
});

test('the hub booking bridge and inline fallback are still wired on every full clone', () => {
  for (const f of FULL_CLONES) {
    const html = read(f);
    assert.match(html, /assets\/hub-booking-bridge\.js/, f);
    assert.match(html, /id="bk-ov"/, `${f} lost the inline fallback modal`);
  }
});
