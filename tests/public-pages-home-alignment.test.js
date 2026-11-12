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
    assert.match(html, /Serving [^.<]+. Extended service areas available by quote./, f);
    assert.doesNotMatch(html, /GeoCircle|geoRadius|"@type": "State"/, `${f} JSON-LD still claims a radius or a whole state`);
  }
});

test('the operational ZIP gate is unchanged (presentation-only change)', () => {
  assert.match(read('assets/travel-fee-client.js'), /var TRAVEL_MAX_MILES = 120;/);
});

test('hub/city clones carry no "How it works" block, as on the homepage', () => {
  for (const f of FULL_CLONES) {
    const html = read(f);
    assert.doesNotMatch(html, /FOUR STEPS/, f);
    assert.doesNotMatch(html, /ZERO HASSLE/, f);
    assert.doesNotMatch(html, /Three simple steps/, f);
    assert.equal(html.includes('id="how"'), false, f);
    assert.doesNotMatch(html, /href="[^"]*#how"/, `${f} links to the removed block`);
    // booking itself is untouched: the inline fallback keeps all six steps
    assert.match(html, /id="bk-ov"/, f);
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

test('inline fallback booking markup keeps #make-search-wrap inside step 3 (75829276 regression)', () => {
  const { JSDOM } = require('jsdom');
  for (const f of FULL_CLONES) {
    const html = read(f);
    assert.doesNotMatch(html, /\n        <div \n/, `${f} has a stray "<div " line`);
    assert.doesNotMatch(html, /\n        id="make-search-wrap"/, `${f} has a broken make-search tag`);
    const doc = new JSDOM(html).window.document;
    const make = doc.getElementById('make-search-wrap');
    assert.ok(make && make.closest('#bs3'), `${f}: #make-search-wrap must parse inside #bs3`);
    assert.equal(make.parentElement, doc.getElementById('generic-search-wrap').parentElement, f);
    assert.equal(doc.getElementById('bs4').parentElement, doc.getElementById('bs3').parentElement, `${f}: step 4 nested in step 3`);
  }
});

test('hub booking bridge: Escape inside the frame, focus containment, strict close message', () => {
  const src = read('assets/hub-booking-bridge.js');
  // only our own frame, same origin, one message type
  assert.match(src, /ev\.origin !== global\.location\.origin/);
  assert.match(src, /ev\.source !== frame\.contentWindow/);
  assert.match(src, /ev\.data\.type !== 'cd1-booking-closed'/);
  // background is inert while open (including widgets injected later) and restored on close
  assert.match(src, /el\.inert = true/);
  assert.match(src, /new MutationObserver/);
  assert.match(src, /setBackgroundInert\(false\)/);
  assert.match(src, /'cd1-consent-banner': 1/, 'consent banner must stay interactive while booking is open');
  // Escape in the frame yields to inner layers first
  assert.match(src, /win\.addEventListener\('keydown'[\s\S]*?\}, true\);/);
  assert.match(src, /now < layersAtKeydown\) return;/);
  for (const sel of ['#car-pkg-detail-ov:not([hidden])', '#bk-addr-dd:not([hidden])', '#g-make-dd.open', '[aria-expanded="true"]']) {
    assert.ok(src.includes(`'${sel}'`), `inner layer ${sel} not respected`);
  }
  // the about:blank load on close must not raise the failure message
  assert.match(src, /frame\.onload = null;[^\n]*\n\s*frame\.src = 'about:blank'/);
  assert.match(src, /if \(!overlay\.classList\.contains\('is-open'\)\) return;/);
});

test('no public page advertises a numeric radius or whole-state coverage (text, metadata, JSON-LD)', () => {
  const pages = fs.readdirSync(root).filter((f) => f.endsWith('.html')
    && !/admin|technician|customer|my-garage|receipt|resume|bid|authorize/.test(f));
  for (const f of pages) {
    const html = read(f);
    const outsideScripts = html.replace(/<script(?![^>]*ld\+json)[\s\S]*?<\/script>/g, ' ');
    assert.doesNotMatch(outsideScripts, /GeoCircle|geoRadius/, f);
    assert.doesNotMatch(outsideScripts, /"@type": "State"/, f);
    assert.doesNotMatch(outsideScripts, /up to 1[25]0 ?mi|1[25]0[ -]mile|1[25]0 miles/i, f);
    for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) JSON.parse(m[1]);
  }
});

test('$335 car package uses the catalog name everywhere public; pop-up not loaded on public pages', () => {
  const name = read('index.html').match(/\{id:'refresh',\s*name:'([^']+)'/)[1];
  assert.equal(name, 'Exterior Refresh & Protect');
  const pages = fs.readdirSync(root).filter((f) => f.endsWith('.html')
    && !/^(admin|technician|customer|my-garage|receipt|resume|bid|authorize)/.test(f));
  for (const f of pages) {
    const html = read(f);
    assert.doesNotMatch(html, /Exterior Detail (&|&amp;) Paint Enhancement|or Exterior Detail from \$335|>Book Exterior Detail</, f);
    assert.doesNotMatch(html, /welcome-lead-balloon\.js/, `${f} still loads the floating pop-up`);
  }
  // the offer itself is untouched
  assert.ok(fs.existsSync(path.join(root, 'assets/welcome-lead-balloon.js')));
  assert.match(read('index.html'), /New Customer Welcome — 10%/);
});

test('Bergen generator: prices from the canonical catalog, index.html mirror in parity, pages in sync', () => {
  const out = execFileSync(process.execPath, [path.join(root, 'scripts/generate-bergen-city-pages.mjs'), '--check', '--parity'], { cwd: root, encoding: 'utf8' });
  const { PRICING } = require('../netlify/lib/booking-price-catalog');
  const lines = out.split('\n').filter((l) => l.startsWith('parity '));
  assert.ok(lines.length >= 15, 'generator should report the price keys it used');
  for (const l of lines) {
    const [, key, val] = l.match(/^parity (\S+) canonical=(\d+)/);
    const p = key.split('.');
    const canon = p[0] === 'addon' ? PRICING.cars.addons.find((a) => a.id === p[1]).price
      : p[0] === 'fleet' ? PRICING.fleet.tiers[p[1]][p[2]]
        : PRICING.cars.tiers[p[1]][p[0]];
    assert.equal(Number(val), canon, `${key} must equal booking-price-catalog`);
  }
  const src = read('scripts/generate-bergen-city-pages.mjs');
  assert.match(src, /require\(path\.join\(root, 'netlify\/lib\/booking-price-catalog\.js'\)\)/);
  assert.doesNotMatch(src, /\b(?:price|interior|full|refresh):\s*\d{2,4}\b/, 'generator must not carry its own price table');
});

test('specialty booking bridge accepts only its own frame, same origin, two known messages', () => {
  const src = read('assets/specialty-booking-bridge.js');
  assert.match(src, /ev\.origin !== window\.location\.origin/);
  assert.match(src, /ev\.source !== frame\.contentWindow/);
  assert.match(src, /ev\.data\.type !== 'cd1-booking-closed' && ev\.data\.type !== 'cd1-booking-error'/);
});

test('hub bridge mirrors a consent answer between page and booking frame through the banner buttons', () => {
  const src = read('assets/hub-booking-bridge.js');
  assert.match(src, /button\[data-consent="' \+ mode \+ '"\]/);
  assert.match(src, /d\.marketing \? 'accept' : \(d\.analytics \? 'analytics' : 'decline'\)/);
  // consent rules themselves are untouched
  assert.doesNotMatch(src, /saveConsent|cd1_consent_v1/);
});

test('back to top stacks above the consent banner, booking bar and chat launcher', () => {
  const css = read('assets/public-surface.css');
  assert.match(css, /html\.cd1-consent-open #cd1-btt\{bottom:calc\(96px \+ var\(--cd1-consent-offset,0px\)\)\}/);
  assert.match(css, /body:has\(#cd-chat\) #cd1-btt\{bottom:calc\(146px/);
  for (const f of ['bergen-county-hub.html', 'new-jersey-hub.html', 'westchester-mobile-detailing.html']) {
    const html = read(f);
    assert.doesNotMatch(html, /📍 Call|>My Booking<|pc-ico">📍/, `${f}: call/portal labels must match their action`);
    assert.match(html, /onclick="openPortal\(\)">My Garage</, f);
  }
});
