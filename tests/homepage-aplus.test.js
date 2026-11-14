'use strict';

// Homepage A+ (Dark Refined Optimized): structure + presentation behaviour.
// Guards the A+ additions without touching booking, pricing or analytics.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const index = read('index.html');
const aplusJs = read('assets/home-aplus.js');
const aplusCss = read('assets/home-aplus.css');

function section(startNeedle, endNeedle) {
  const s = index.indexOf(startNeedle);
  assert.ok(s >= 0, 'missing ' + startNeedle);
  return index.slice(s, index.indexOf(endNeedle, s));
}

test('A+ assets are loaded only by the homepage and scoped to it', () => {
  assert.match(index, /<link rel="stylesheet" href="assets\/home-aplus\.css">/);
  assert.match(index, /<script src="assets\/home-aplus\.js" defer><\/script>/);
  assert.match(index, /<body class="luxury-surface" data-home-variant="aplus">/);
  for (const rule of aplusCss.match(/^[^@\s/}][^{]*\{/gm) || []) {
    assert.match(rule, /body\[data-home-variant="aplus"\]/, 'unscoped rule: ' + rule.trim());
  }
  for (const page of ['bergen-county-hub.html', 'boats-detailing.html', 'ceramic-coating.html', 'my-garage.html']) {
    assert.doesNotMatch(read(page), /home-aplus\.(css|js)/, page + ' must not load homepage A+ assets');
  }
});

test('A+ presentation script has no network, analytics or booking side effects', () => {
  assert.doesNotMatch(aplusJs, /fetch\(|XMLHttpRequest|sendBeacon|dataLayer|gtag\(|Cardetail1Revenue|\.track\(/);
  assert.doesNotMatch(aplusJs, /openBooking|ST\.|selectPkg|tierKey|PRICING\s*=/);
});

test('hero keeps one ZIP CTA and shows starting prices from PRICING ids', () => {
  const hero = section('<section class="hero">', '</section>');
  assert.equal((hero.match(/onclick="onHeroZipSubmit\(\)"/g) || []).length, 1);
  assert.match(hero, /hero-zip-btn-lbl">Check Prices &amp; Availability</);
  for (const id of ['hero-from-interior', 'hero-from-full', 'hero-from-refresh']) assert.match(hero, new RegExp(`id="${id}"`));
  assert.match(index, /setPkgAmt\('hero-from-interior','interior'\)/);
  assert.match(index, /setPkgAmt\('hero-from-refresh','refresh'\)/);
  assert.match(index, /heroFull\.textContent=fmtFull\(tiers\.small\.full\)/);
});

test('vehicle selector is display-only and covers the four homepage tiers', () => {
  const seg = section('<div class="home-tier-seg"', '</div>');
  assert.match(seg, /role="radiogroup"/);
  assert.deepEqual([...seg.matchAll(/data-tier="([a-z0-9]+)"/g)].map((m) => m[1]), ['small', 'suv2', 'suv3', 'truck']);
  assert.match(index, /const selTier=window\.CD1HomeTier&&tiers\[window\.CD1HomeTier\]/);
  // Package CTAs keep the booking entry that lets the catalog classify the vehicle.
  for (const id of ['interior', 'full', 'refresh']) {
    assert.equal((index.match(new RegExp(`class="car-pkg-cta" onclick="openBookingCarPkg\\('${id}'\\)"`, 'g')) || []).length, 1);
  }
  assert.match(index, /Vans and other vehicles are priced in booking/);
});

function mountAplus(extraBody = '') {
  const hero = section('<section class="hero">', '</section>') + '</section>';
  const seg = section('<div class="home-tier-seg"', '</div>') + '</div>';
  const note = section('<p class="home-tier-note"', '</p>') + '</p>';
  const sticky = section('<div class="mobile-sticky-cta"', '</div>') + '</div>';
  const nav = section('<nav class="nav" id="main-nav">', '</nav>') + '</nav>';
  const dom = new JSDOM(`<!doctype html><body class="luxury-surface" data-home-variant="aplus">${nav}${hero}${seg}${note}
    <div class="phone-cta" data-primary><button>final</button></div>${sticky}${extraBody}</body>`, { runScripts: 'outside-only' });
  const win = dom.window;
  const observed = [];
  win.IntersectionObserver = class { constructor(cb) { this.cb = cb; } observe(el) { observed.push({ el, io: this }); } };
  win.matchMedia = () => ({ matches: true, addEventListener() {} });
  win.priceCalls = 0;
  win._updateHomeFromPrices = () => { win.priceCalls += 1; };
  win.eval(aplusJs);
  // The script waits for DOMContentLoaded while the document is still loading.
  if (win.document.readyState === 'loading') win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
  return { win, doc: win.document, observed };
}

test('selector updates aria state and re-renders prices through the page function', () => {
  const { win, doc } = mountAplus();
  const btn = doc.querySelector('[data-tier="suv3"]');
  btn.click();
  assert.equal(btn.getAttribute('aria-checked'), 'true');
  assert.equal(doc.querySelector('[data-tier="small"]').getAttribute('aria-checked'), 'false');
  assert.equal(win.CD1HomeTier, 'suv3');
  assert.equal(win.priceCalls, 1);
  assert.match(doc.querySelector('[data-home-tier-note]').textContent, /3-row SUV or minivan/);
  btn.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(doc.querySelector('[data-tier="truck"]').getAttribute('aria-checked'), 'true');
});

test('sticky bar and header CTA hide while a primary CTA is on screen', () => {
  const { doc, observed } = mountAplus();
  const sticky = doc.getElementById('mobile-sticky-cta');
  const navCta = doc.querySelector('#main-nav .nav-cta');
  assert.equal(observed.length, 2, 'hero ZIP and final CTA are observed');
  const fire = (i, on) => observed[i].io.cb([{ target: observed[i].el, isIntersecting: on }]);
  fire(0, true);
  assert.equal(sticky.classList.contains('is-on'), false);
  assert.equal(sticky.getAttribute('aria-hidden'), 'true');
  assert.equal(navCta.classList.contains('is-off'), true);
  assert.ok([...sticky.querySelectorAll('a,button')].every((el) => el.tabIndex === -1));
  fire(0, false);
  assert.equal(sticky.classList.contains('is-on'), true);
  assert.equal(navCta.classList.contains('is-off'), false);
  fire(1, true);
  assert.equal(sticky.classList.contains('is-on'), false);
  // the sticky bar keeps exactly two actions: call and the shared booking CTA
  assert.equal(sticky.querySelectorAll('a[href="tel:+15513893986"]').length, 1);
  assert.equal(sticky.querySelectorAll('a,button').length, 2);
  assert.match(section('<div class="mobile-sticky-cta"', '</div>'), /class="msc-book booking-popup-trigger" onclick="openBooking\(null\)">Check Prices &amp; Availability</);
});

test('hero disclosure closes on Escape and returns focus to its summary', () => {
  const { win, doc } = mountAplus();
  const d = doc.getElementById('hero-more');
  d.open = true;
  d.querySelector('a').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(d.open, false);
  assert.equal(doc.activeElement, d.querySelector('summary'));
});
