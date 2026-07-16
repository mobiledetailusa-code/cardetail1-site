/**
 * Specialty galleries + six-step booking regression.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const exists = (f) => fs.existsSync(path.join(root, f));

const BOAT_VIDEOS = [
  'assets/videos/specialty/boats/vkpq0511.mp4',
  'assets/videos/specialty/boats/rwaj3347.mp4',
  'assets/videos/specialty/boats/xats4703.mp4',
];
const BOAT_POSTERS = [
  'assets/images/specialty/boats/vkpq0511-poster.jpg',
  'assets/images/specialty/boats/rwaj3347-poster.jpg',
  'assets/images/specialty/boats/xats4703-poster.jpg',
];
const RV_PAIRS = ['rockwood-front', 'wingamm-front', 'wingamm-side', 'vienna-front', 'vienna-roof'];
const PS_PAIRS = ['polaris-front', 'gator-interior'];

test('boats gallery exists as compact video gallery', () => {
  const html = read('boats-detailing.html');
  assert.match(html, /id="boat-gallery"/);
  assert.match(html, /data-specialty-gallery="boats-video"/);
  assert.match(html, /sp-video-grid/);
  assert.doesNotMatch(html, /id="boat-videos"/);
  assert.doesNotMatch(html, /sp-media-grid/);
  for (const v of BOAT_VIDEOS) assert.match(html, new RegExp(v.replace(/\./g, '\\.')));
  for (const p of BOAT_POSTERS) assert.match(html, new RegExp(p.replace(/\./g, '\\.')));
  assert.match(html, /preload="metadata"/);
  assert.match(html, /playsinline/);
  assert.doesNotMatch(html, /autoplay/);
  assert.match(read('assets/specialty-gallery.css'), /max-height:\s*300px/);
  assert.match(read('assets/specialty-gallery.js'), /pauseSiblingVideos|addEventListener\('play'/);
});

test('boats approved video files exist and contain no Windows paths in public pages', () => {
  for (const f of [...BOAT_VIDEOS, ...BOAT_POSTERS]) assert.ok(exists(f), f);
  for (const page of ['boats-detailing.html', 'rv-detailing.html', 'powersports-detailing.html', 'index.html']) {
    assert.doesNotMatch(read(page), /C:\\\\Users\\\\/);
  }
});

test('RV gallery uses only verified Before/After pairs', () => {
  const html = read('rv-detailing.html');
  assert.match(html, /data-specialty-gallery="rv-before-after"/);
  assert.match(html, /sp-ba-grid/);
  for (const id of RV_PAIRS) {
    assert.match(html, new RegExp(`data-ba-pair="${id}"`));
    assert.ok(exists(`assets/images/specialty/rv/${id}-before-768.jpg`));
    assert.ok(exists(`assets/images/specialty/rv/${id}-after-768.jpg`));
  }
  assert.doesNotMatch(html, /assets\/media\/rv\/gallery\/(momentum-gclass|rockwood-signature|jayco-eagle|wingamm-side)/);
  assert.match(html, /ba-tag--before/);
  assert.match(html, /ba-tag--after/);
  assert.match(html, /<input type="range"/);
});

test('Powersports gallery uses only verified Before/After pairs', () => {
  const html = read('powersports-detailing.html');
  assert.match(html, /data-specialty-gallery="powersports-before-after"/);
  const gallery = html.slice(html.indexOf('data-specialty-gallery="powersports-before-after"'));
  for (const id of PS_PAIRS) {
    assert.match(gallery, new RegExp(`data-ba-pair="${id}"`));
    assert.ok(exists(`assets/images/specialty/powersports/${id}-before-768.jpg`));
    assert.ok(exists(`assets/images/specialty/powersports/${id}-after-768.jpg`));
  }
  assert.doesNotMatch(gallery, /assets\/media\/powersports\/gallery\/(motorcycle-road-glide|polaris-atv|IMG_7482)/);
  assert.match(gallery, /<input type="range"/);
});

test('comparison component supports range/keyboard and pointer helpers', () => {
  const css = read('assets/specialty-gallery.css');
  const js = read('assets/specialty-gallery.js');
  assert.match(css, /input\[type=range\]/);
  assert.match(css, /touch-action:\s*none/);
  assert.match(js, /addEventListener\('input'/);
  assert.match(js, /--ba-pos/);
});

test('no random gallery selection code', () => {
  for (const f of ['boats-detailing.html', 'rv-detailing.html', 'powersports-detailing.html', 'assets/specialty-gallery.js']) {
    assert.doesNotMatch(read(f), /\.sort\(\s*\(\s*\)\s*=>\s*Math\.random|shuffle\(/);
  }
});

test('six-step booking progress and panel sequence restored', () => {
  const html = read('index.html');
  assert.match(html, /Booking progress — 6 steps/);
  assert.match(html, /BK_VISIBLE_STEPS = 6/);
  assert.match(html, /Book in six steps/i);
  assert.match(html, /id="bpt1"[\s\S]*Category/);
  assert.match(html, /id="bpt2"[\s\S]*Package/);
  assert.match(html, /id="bpt3"[\s\S]*Vehicle/);
  assert.match(html, /id="bpt4"[\s\S]*Info/);
  assert.match(html, /id="bpt5"[\s\S]*Secure Your Booking/);
  assert.match(html, /id="bpt6"[\s\S]*Confirm/);
  assert.match(html, /id="bs1"/);
  assert.match(html, /id="bs2"/);
  assert.match(html, /id="bs3"/);
  assert.match(html, /id="bs4"/);
  assert.match(html, /id="bs5"/);
  assert.match(html, /id="bs6"/);
  assert.match(html, /function bkPanelsForStep\(n\) \{\s*return \['bs' \+ n\];/);
  assert.match(html, /max-width:920px/);
  assert.match(html, /function launchBooking\(/);
  assert.match(html, /params\.get\('category'\)/);
});

test('canonical launcher exists on specialty bridge', () => {
  const bridge = read('assets/specialty-booking-bridge.js');
  assert.match(bridge, /window\.launchBooking\s*=\s*function launchBooking/);
});

test('package IDs and prices remain unchanged for specialty catalogs', () => {
  const html = read('index.html');
  assert.match(html, /boats:[\s\S]*?id:\s*['"]maint['"]/);
  assert.match(html, /rvs:[\s\S]*?id:\s*['"]maint_light['"]/);
  assert.match(html, /powersports:[\s\S]*?id:\s*['"]wash['"]/);
  assert.match(html, /PRICE_PER_FOOT|LENGTH_PRICING/);
});

test('media map documents selections without operator absolute Windows dump paths', () => {
  const doc = read('docs/specialty-gallery-media-map.md');
  assert.match(doc, /verified_pair/);
  assert.match(doc, /vkpq0511/);
  assert.match(doc, /vienna-front/);
  assert.match(doc, /rockwood-front|wingamm-front/);
  assert.match(doc, /gator-interior/);
  assert.match(doc, /polaris-front/);
  assert.doesNotMatch(doc, /C:\\\\Users\\\\magno\\\\Desktop\\\\dz project\\\\pics/);
});
