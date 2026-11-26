'use strict';

// Paid and organic landing pages must load the shared consent + tracking
// scripts. Without them a phone tap on these pages was never counted, no
// consent banner was shown, and (on ceramic-coating) the ad click id was
// dropped before the visitor reached booking.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const BERGEN_CITY_PAGES = [
  'palisades-park-mobile-detailing.html',
  'fort-lee-mobile-detailing.html',
  'paramus-mobile-detailing.html',
  'hackensack-mobile-detailing.html',
  'englewood-mobile-detailing.html',
  'teaneck-mobile-detailing.html',
  'ridgewood-mobile-detailing.html',
  'edgewater-mobile-detailing.html',

  'franklin-lakes-mobile-detailing.html',

  'mahwah-mobile-detailing.html',

  'tenafly-mobile-detailing.html',
];
const LANDING_PAGES = [...BERGEN_CITY_PAGES, 'ceramic-coating.html', 'reviews.html'];
const TRACKING = ['assets/consent-manager.js', 'assets/revenue-events.js', 'assets/revops-init.js'];

function scriptSrcs(html) {
  return [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
}

for (const file of LANDING_PAGES) {
  test(`${file} loads consent, tracking and init once, in that order`, () => {
    const srcs = scriptSrcs(read(file));
    const idx = TRACKING.map((src) => srcs.indexOf(src));
    TRACKING.forEach((src, i) => {
      assert.ok(idx[i] >= 0, `${file} is missing ${src}`);
      assert.equal(srcs.filter((s) => s === src).length, 1, `${file} loads ${src} more than once`);
    });
    assert.ok(idx[0] < idx[1] && idx[1] < idx[2], `${file} must load ${TRACKING.join(' -> ')}`);
  });

  test(`${file} has no hardcoded Google tag (Ads loads only through revenue-events.js)`, () => {
    assert.doesNotMatch(read(file), /googletagmanager\.com\/gtag|googleadservices|AW-\d/);
  });
}

test('the Bergen city generator emits the tracking scripts (pages do not drift)', () => {
  const src = read('scripts/generate-bergen-city-pages.mjs');
  TRACKING.forEach((s) => assert.match(src, new RegExp(`<script src="${s.replace(/[.]/g, '\\.')}"></script>`)));
  execFileSync(process.execPath, [path.join(root, 'scripts/generate-bergen-city-pages.mjs'), '--check'], { cwd: root, stdio: 'pipe' });
});

test('Google Ads stays production-host only, so previews never fire it', () => {
  assert.match(read('assets/revenue-events.js'), /return host === 'cardetail1\.com' \|\| host === 'www\.cardetail1\.com';/);
});

test('ceramic-coating passes the ad click id on to booking', async () => {
  const html = read('ceramic-coating.html');
  assert.match(html, /<script src="assets\/county-hub-booking-attribution\.js" defer><\/script>/);
  const dom = new JSDOM(html.replace(/<script[\s\S]*?<\/script>/g, ''), {
    url: 'https://cardetail1.com/ceramic-coating?gclid=TEST123&utm_source=google',
    runScripts: 'outside-only',
  });
  dom.window.eval(read('assets/county-hub-booking-attribution.js'));
  // The script is deferred: it decorates links once the DOM is ready.
  if (dom.window.document.readyState === 'loading') {
    await new Promise((resolve) => dom.window.document.addEventListener('DOMContentLoaded', resolve));
  }
  const bookLinks = [...dom.window.document.querySelectorAll('a[href]')]
    .map((a) => a.getAttribute('href'))
    .filter((h) => /^\/\?book=/.test(h));
  assert.ok(bookLinks.length >= 3, 'expected the ceramic booking links');
  bookLinks.forEach((h) => {
    const u = new URL(h, 'https://cardetail1.com');
    assert.equal(u.searchParams.get('gclid'), 'TEST123', h);
    assert.equal(u.searchParams.get('utm_source'), 'google', h);
  });
});
