/**
 * Specialty service pages + shared specialty-service-nav
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const PUBLIC_PAGES = [
  'index.html',
  'new-jersey-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
  'bergen-county-hub.html',
  'hudson-county-hub.html',
  'essex-county-hub.html',
  'passaic-county-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'template-city.html',
  'boats-detailing.html',
  'powersports-detailing.html',
  'rv-detailing.html',
];

const SPECIALTY_PAGES = [
  'boats-detailing.html',
  'powersports-detailing.html',
  'rv-detailing.html',
];

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}

describe('specialty dedicated pages exist', () => {
  it('boats dedicated page exists', () => {
    assert.ok(exists('boats-detailing.html'));
  });
  it('powersports dedicated page exists', () => {
    assert.ok(exists('powersports-detailing.html'));
  });
  it('RV/Trailer dedicated page exists', () => {
    assert.ok(exists('rv-detailing.html'));
  });
});

describe('specialty-service-nav shared component', () => {
  for (const page of PUBLIC_PAGES) {
    it(`appears on ${page}`, () => {
      const html = read(page);
      assert.match(html, /class="specialty-service-nav"/);
      assert.match(html, /aria-label="Specialty detailing services"/);
    });

    it(`${page} has specialty nav CSS link`, () => {
      const html = read(page);
      assert.match(html, /assets\/specialty-service-nav\.css/);
    });

    it(`${page} specialty nav has exactly three service links`, () => {
      const html = read(page);
      const block = html.match(/<nav class="specialty-service-nav"[\s\S]*?<\/nav>/);
      assert.ok(block, 'nav block missing');
      const hrefs = [...block[0].matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      assert.equal(hrefs.length, 3);
      assert.deepEqual(hrefs, [
        'rv-detailing.html',
        'boats-detailing.html',
        'powersports-detailing.html',
      ]);
    });

    it(`${page} specialty links are real anchors (not onclick-only)`, () => {
      const html = read(page);
      const block = html.match(/<nav class="specialty-service-nav"[\s\S]*?<\/nav>/)[0];
      assert.doesNotMatch(block, /onclick=/);
      assert.match(block, /<a class="specialty-service-link" href="rv-detailing\.html"/);
      assert.match(block, /<a class="specialty-service-link" href="boats-detailing\.html"/);
      assert.match(block, /<a class="specialty-service-link" href="powersports-detailing\.html"/);
    });
  }

  it('specialty nav appears after main header nav', () => {
    const html = read('index.html');
    const mainNav = html.indexOf('id="main-nav"');
    const specialty = html.indexOf('class="specialty-service-nav"');
    assert.ok(mainNav >= 0 && specialty > mainNav);
  });
});

describe('aria-current on dedicated pages', () => {
  it('boats page marks Boats as current', () => {
    const html = read('boats-detailing.html');
    assert.match(html, /href="boats-detailing\.html" aria-current="page"/);
    assert.doesNotMatch(html, /href="rv-detailing\.html" aria-current="page"/);
    assert.doesNotMatch(html, /href="powersports-detailing\.html" aria-current="page"/);
  });
  it('powersports page marks Powersports as current', () => {
    const html = read('powersports-detailing.html');
    assert.match(html, /href="powersports-detailing\.html" aria-current="page"/);
  });
  it('rv page marks RV & Trailers as current', () => {
    const html = read('rv-detailing.html');
    assert.match(html, /href="rv-detailing\.html" aria-current="page"/);
  });
  it('generic hubs do not set aria-current', () => {
    const html = read('new-jersey-hub.html');
    const block = html.match(/<nav class="specialty-service-nav"[\s\S]*?<\/nav>/)[0];
    assert.doesNotMatch(block, /aria-current=/);
  });
});

describe('package sections near top', () => {
  for (const page of SPECIALTY_PAGES) {
    it(`${page} has package section id="packages"`, () => {
      const html = read(page);
      assert.match(html, /id="packages"/);
    });
    it(`${page} has exactly one H1`, () => {
      const html = read(page);
      const h1s = html.match(/<h1[\s>]/gi) || [];
      assert.equal(h1s.length, 1);
    });
  }

  it('boats page package section appears before gallery', () => {
    const html = read('boats-detailing.html');
    assert.ok(html.indexOf('id="packages"') < html.indexOf('id="boat-gallery"'));
  });
  it('powersports page package section appears before gallery', () => {
    const html = read('powersports-detailing.html');
    assert.ok(html.indexOf('id="packages"') < html.indexOf('id="gallery"'));
  });
});

describe('powersports video removal and images', () => {
  it('powersports page contains no video element', () => {
    const html = read('powersports-detailing.html');
    assert.doesNotMatch(html, /<video[\s>]/i);
  });
  it('powersports page contains no iframe', () => {
    const html = read('powersports-detailing.html');
    assert.doesNotMatch(html, /<iframe[\s>]/i);
  });
  it('powersports page has no video gallery heading', () => {
    const html = read('powersports-detailing.html');
    assert.doesNotMatch(html, /Powersports Video Gallery/i);
  });

  it('every referenced powersports image exists with correct path', () => {
    const html = read('powersports-detailing.html');
    const srcs = [...html.matchAll(/<img[^>]+src="([^"]+)"/gi)].map((m) => m[1]);
    assert.ok(srcs.length > 0, 'expected gallery images');
    for (const src of srcs) {
      assert.doesNotMatch(src, /^(blob:|file:|https?:\/\/localhost)/i);
      assert.doesNotMatch(src, /[A-Za-z]:\\/);
      assert.ok(exists(src), `missing image: ${src}`);
      assert.match(src, /^assets\/media\/powersports\/gallery\/IMG_\d+\.jpeg$/);
    }
  });

  it('no HEIC or MOV image sources on powersports page', () => {
    const html = read('powersports-detailing.html');
    assert.doesNotMatch(html, /\.HEIC|\.MOV|\.heic|\.mov/i);
  });
});

describe('booking category CTAs', () => {
  it('boats package CTAs open boats booking', () => {
    const html = read('boats-detailing.html');
    assert.match(html, /href="index\.html\?book=boats"/);
  });
  it('powersports package CTAs open powersports booking', () => {
    const html = read('powersports-detailing.html');
    assert.match(html, /href="index\.html\?book=powersports"/);
  });
  it('rv package CTAs open rvs booking', () => {
    const html = read('rv-detailing.html');
    assert.match(html, /href="index\.html\?book=rvs"/);
  });
  it('homepage supports ?book= query opener', () => {
    const html = read('index.html');
    assert.match(html, /openBookingFromQuery/);
    assert.match(html, /params\.get\('book'\)/);
  });
});

describe('pricing catalog unchanged for specialty packages', () => {
  it('boats package IDs remain maint/essential/full/premium', () => {
    const html = read('index.html');
    const boats = html.match(/boats:\s*\{[\s\S]*?packages:\[([\s\S]*?)\],\s*addons:/);
    assert.ok(boats);
    assert.match(boats[1], /id:'maint'/);
    assert.match(boats[1], /id:'essential'/);
    assert.match(boats[1], /id:'full'/);
    assert.match(boats[1], /id:'premium'/);
  });
  it('powersports package IDs remain wash/essential/full/premium', () => {
    const html = read('index.html');
    const ps = html.match(/powersports:\s*\{[\s\S]*?packages:\[([\s\S]*?)\],\s*addons:/);
    assert.ok(ps);
    assert.match(ps[1], /id:'wash'/);
    assert.match(ps[1], /id:'essential'/);
    assert.match(ps[1], /id:'full'/);
    assert.match(ps[1], /id:'premium'/);
  });
  it('LENGTH_PRICING boat mins unchanged', () => {
    const html = read('index.html');
    assert.match(html, /boats:\s*\{[\s\S]*?maint:\s*\{perFt:\s*12,\s*min:\s*199\}/);
    assert.match(html, /full:\s*\{perFt:\s*30,\s*min:\s*449\}/);
    assert.match(html, /premium:\s*\{perFt:\s*38,\s*min:\s*699\}/);
  });
  it('LENGTH_PRICING rv mins unchanged', () => {
    const html = read('index.html');
    assert.match(html, /rvs:\s*\{[\s\S]*?exterior:\s*\{perFt:\s*12,\s*min:\s*349\}/);
    assert.match(html, /interior:\s*\{perFt:\s*21,\s*min:\s*299\}/);
    assert.match(html, /full:\s*\{perFt:\s*30,\s*min:\s*549\}/);
  });
});

describe('no Netlify Function changes required by specialty pages', () => {
  it('specialty pages are static HTML only', () => {
    for (const page of SPECIALTY_PAGES) {
      const html = read(page);
      assert.doesNotMatch(html, /\.netlify\/functions/);
    }
  });
});
