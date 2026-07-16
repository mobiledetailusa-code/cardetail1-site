'use strict';

/**
 * Specialty visual regression guards — structure, media constraints, sync safety.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const exists = (f) => fs.existsSync(path.join(root, f));

const PAGES = [
  'boats-detailing.html',
  'rv-detailing.html',
  'powersports-detailing.html',
];

const PRICES = {
  'boats-detailing.html': ['From $199', 'From $449', 'From $699'],
  'rv-detailing.html': ['Starting at $8/ft', 'Starting at $15/ft', 'Starting at $20/ft', 'Starting at $31/ft', 'Starting at $44/ft'],
  'powersports-detailing.html': ['From $119', 'From $266', 'From $367'],
};

test('specialty pages exist with unique SEO essentials', () => {
  const titles = new Set();
  const descriptions = new Set();
  const canonicals = new Set();
  for (const page of PAGES) {
    const html = read(page);
    assert.equal((html.match(/<h1[\s>]/gi) || []).length, 1);
    const title = html.match(/<title>([^<]+)<\/title>/i)?.[1];
    const desc = html.match(/name="description"\s+content="([^"]+)"/i)?.[1];
    const canon = html.match(/rel="canonical"\s+href="([^"]+)"/i)?.[1];
    assert.ok(title && desc && canon);
    titles.add(title);
    descriptions.add(desc);
    canonicals.add(canon);
    assert.match(html, /my-garage\.html/);
    assert.match(html, /class="specialty-service-nav"/);
    assert.match(html, /specialty-category\.css/);
    assert.match(html, /data-booking-category="/);
    assert.doesNotMatch(html, /id="bpt6"|BK_VISIBLE_STEPS/i);
  }
  assert.equal(titles.size, 3);
  assert.equal(descriptions.size, 3);
  assert.equal(canonicals.size, 3);
});

test('intrusive yacht media is fully removed', () => {
  assert.equal(exists('assets/media/boats/gallery/yacht-cruise.jpg'), false);
  assert.equal(exists('assets/media/boats/gallery/yacht-speed-cruise.jpg'), false);
  for (const page of PAGES) {
    const html = read(page);
    assert.doesNotMatch(html, /yacht-cruise|yacht-speed-cruise/i);
  }
});

test('category media stays scoped and dimensioned', () => {
  for (const page of PAGES) {
    const html = read(page);
    const imgs = [...html.matchAll(/<img\b([^>]+)>/gi)].map((m) => m[1]);
    for (const attrs of imgs) {
      if (/cardetail1-logo/i.test(attrs)) continue;
      assert.match(attrs, /\b(width|height|style)=|aspect-ratio/i);
      assert.match(attrs, /\bsrc="([^"]+)"/);
    }
    assert.match(html, /sp-media-frame|sp-pkg-visual|sp-video-frame|ba-compare|sp-ba-card/);
  }
  const boats = read('boats-detailing.html');
  assert.doesNotMatch(boats, /powersports\/gallery|before-after\/.*car/i);
  const rv = read('rv-detailing.html');
  assert.doesNotMatch(rv, /powersports\/gallery|luxury-urus|sedan/i);
  const ps = read('powersports-detailing.html');
  assert.doesNotMatch(ps, /boats\/gallery|momentum-gclass|luxury-urus/i);
});

test('package IDs and listed prices remain unchanged', () => {
  assert.match(read('boats-detailing.html'), /data-booking-package="maint"/);
  assert.match(read('boats-detailing.html'), /data-booking-package="full"/);
  assert.match(read('boats-detailing.html'), /data-booking-package="premium"/);
  assert.match(read('rv-detailing.html'), /data-booking-package="maint_light"/);
  assert.match(read('rv-detailing.html'), /data-booking-package="full"/);
  assert.match(read('powersports-detailing.html'), /data-booking-package="wash"/);
  for (const page of PAGES) {
    const html = read(page);
    for (const price of PRICES[page]) assert.match(html, new RegExp(price.replace('$', '\\$')));
  }
});

test('shared nav/footer/BTT present once; category preselection intact', () => {
  for (const page of PAGES) {
    const html = read(page);
    assert.equal((html.match(/id="main-nav"/g) || []).length, 1);
    assert.equal((html.match(/id="cd1-public-footer"/g) || []).length, 1);
    assert.equal((html.match(/back-to-top\.js/g) || []).length, 1);
    assert.match(html, /assets\/specialty-booking-bridge\.js/);
  }
  assert.match(read('boats-detailing.html'), /data-booking-category="boats"/);
  assert.match(read('rv-detailing.html'), /data-booking-category="rvs"/);
  assert.match(read('powersports-detailing.html'), /data-booking-category="powersports"/);
});

test('public-surface sync is idempotent for specialty pages', () => {
  const node = process.execPath;
  const script = path.join(root, 'scripts', 'sync-public-surface.mjs');
  const run = () => spawnSync(node, [script], { cwd: root, encoding: 'utf8' });
  const first = run();
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const before = Object.fromEntries(PAGES.map((p) => [p, read(p)]));
  const second = run();
  assert.equal(second.status, 0, second.stderr || second.stdout);
  for (const page of PAGES) {
    assert.equal(read(page), before[page], `${page} changed on second sync`);
  }
});

test('ops policy guards remain in specialty HTML footprint', () => {
  const index = read('index.html');
  assert.doesNotMatch(index, /FIRST_BOOKING_OFFER_ENABLED\s*=\s*true/);
  for (const page of PAGES) {
    const html = read(page);
    assert.doesNotMatch(html, /enable.*WELCOME10|WELCOME10.*production/i);
    assert.doesNotMatch(html, /klarna|affirm|paypal|sendgrid/i);
  }
});
