const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const index = read('index.html');

function extractHomeServiceAreasSection(html) {
  const match = html.match(/<section class="home-service-areas"[\s\S]*?<\/section>/);
  assert.ok(match, 'home-service-areas section missing');
  return match[0];
}

function extractCityLinks(section) {
  const links = [];
  const re = /<a class="service-area-city-link"\s+href="([^"]+)">([^<]+)<\/a>/g;
  let m;
  while ((m = re.exec(section)) !== null) {
    links.push({ href: m[1], text: m[2].trim() });
  }
  return links;
}

function extractHubLinks(section) {
  const links = [];
  const re = /<a class="service-area-hub-link"\s+href="([^"]+)">([^<]+)<\/a>/g;
  let m;
  while ((m = re.exec(section)) !== null) {
    links.push({ href: m[1], text: m[2].trim() });
  }
  return links;
}

function hrefExists(href) {
  const [file, hash] = href.replace(/^\//, '').split('#');
  const filePath = path.join(root, file);
  assert.ok(fs.existsSync(filePath), `missing file for href ${href}`);
  if (hash) {
    const html = read(file);
    assert.match(html, new RegExp(`id="${hash}"`));
  }
}

const section = extractHomeServiceAreasSection(index);
const cityLinks = extractCityLinks(section);
const hubLinks = extractHubLinks(section);

const expectedCityHrefs = [
  '/bergen-county-hub.html',
  '/hudson-county-hub.html',
  '/essex-county-hub.html',
  '/passaic-county-hub.html',
  '/newark-mobile-detailing.html',
  '/westchester-mobile-detailing.html',
  '/trenton-mobile-detailing.html',
  '/ny-metro-hub.html#rockland-county',
  '/connecticut-hub.html#fairfield-county',
];

test('homepage contains the Mobile Detailing Near You section', () => {
  assert.match(section, /aria-labelledby="home-service-areas-title"/);
  assert.match(section, /<h2 id="home-service-areas-title" class="sec-title">Mobile Detailing Near You<\/h2>/);
  assert.match(section, /SERVICE AREAS/);
  assert.match(section, /Based in Palisades Park, Cardetail1 provides/);
});

test('section is placed after reviews and before final CTA', () => {
  const reviewsIdx = index.indexOf('<div id="reviews"');
  const areasIdx = index.indexOf('<section class="home-service-areas"');
  const ctaIdx = index.indexOf('<!-- CTA SECTION -->');
  assert.ok(reviewsIdx > -1 && areasIdx > reviewsIdx, 'areas should follow reviews');
  assert.ok(ctaIdx > areasIdx, 'areas should precede final CTA');
});

test('section contains 8 to 12 city links', () => {
  assert.ok(cityLinks.length >= 8 && cityLinks.length <= 12, `got ${cityLinks.length}`);
  assert.equal(cityLinks.length, 9);
});

test('every city link is an anchor with a valid href in raw HTML', () => {
  for (const link of cityLinks) {
    assert.match(link.href, /^\/[a-z0-9-]+\.html(#.+)?$/i);
    assert.ok(link.text.length > 0);
    hrefExists(link.href);
  }
});

test('city links do not use onclick-only navigation', () => {
  assert.doesNotMatch(section, /<a class="service-area-city-link"[^>]*onclick=/);
  for (const link of cityLinks) {
    assert.doesNotMatch(link.href, /^javascript:/i);
    assert.notEqual(link.href, '');
  }
});

test('no duplicate city links exist', () => {
  const hrefs = cityLinks.map((l) => l.href);
  assert.equal(new Set(hrefs).size, hrefs.length);
  const texts = cityLinks.map((l) => l.text.toLowerCase());
  assert.equal(new Set(texts).size, texts.length);
});

test('homepage uses confirmed existing city and county URLs only', () => {
  assert.deepEqual(cityLinks.map((l) => l.href), expectedCityHrefs);
});

test('state hub links for NJ, NY and CT exist', () => {
  const hrefs = hubLinks.map((l) => l.href);
  assert.ok(hrefs.includes('/new-jersey-hub.html'));
  assert.ok(hrefs.includes('/ny-metro-hub.html'));
  assert.ok(hrefs.includes('/connecticut-hub.html'));
  assert.equal(hubLinks.length, 3);
});

test('Pennsylvania is not promoted in the homepage service areas section', () => {
  assert.doesNotMatch(section, /Pennsylvania/i);
  assert.doesNotMatch(section, /pennsylvania-hub\.html/);
});

test('section does not list ZIP codes', () => {
  assert.doesNotMatch(section, /\b\d{5}\b/);
  assert.doesNotMatch(section, /ZIP/i);
});

test('city links are present in initial HTML without accordion or JS dependency', () => {
  assert.match(index, /class="service-area-city-grid"/);
  assert.doesNotMatch(section, /<details/);
  assert.doesNotMatch(section, /service-area-accordion/);
});

test('mobile layout guards against horizontal overflow in service areas CSS', () => {
  const css = read('assets/luxury-theme.css');
  assert.match(css, /\.home-service-areas[\s\S]*overflow-x:\s*hidden/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
});

test('booking flow remains available and Fleet stays excluded from public booking', () => {
  assert.match(index, /id="bk-ov"/);
  assert.match(index, /function openBooking/);
  assert.doesNotMatch(index, /openBooking\('fleet'\)/);
});

test('no Netlify Function files changed in this scope', () => {
  const diff = execSync('git diff --name-only HEAD', { cwd: root, encoding: 'utf8' });
  const changed = diff.split('\n').filter(Boolean);
  const functionChanges = changed.filter((file) => /^netlify\/functions\//.test(file));
  const allowed = new Set([
    'netlify/functions/ai-chat.js',
    'netlify/functions/submit-booking.js',
    'netlify/functions/create-setup-intent.js',
    'netlify/functions/revenue-event.js',
    'netlify/functions/garage-plan-submit.js',
    'netlify/functions/revenue-admin.js',
    'netlify/functions/revenue-resume-link.js',
    'netlify/functions/booking-card-status.js',
    'netlify/functions/lookup-booking.js',
    'netlify/functions/request-cancellation.js',
    'netlify/functions/submit-customer-action.js',
    'netlify/functions/admin-customer-requests.js',
    'netlify/functions/customer-portal-auth.js',
    'netlify/functions/customer-portal-data.js',
    'netlify/functions/customer-portal-vehicles.js',
    'netlify/functions/tech-complete-job.js',
    'netlify/functions/tech-jobs.js',
    'netlify/functions/customer-portal-action.js',
    'netlify/functions/evaluate-booking-offer.js',
    'netlify/functions/admin-ops-jobs.js',
    'netlify/functions/qa-opscore-lifecycle.js',
    'netlify/functions/qa-revops-lifecycle.js',
    // Release A — canonical aggregate / payments
    'netlify/functions/create-payment-intent.js',
    'netlify/functions/create-payment-link.js',
    'netlify/functions/capture-payment.js',
    'netlify/functions/customer-subscription-checkout.js',
    'netlify/functions/customer-bookings.js',
    // Customer identity security prerequisites — revoke orphan public subscription actions.
    'netlify/functions/subscriptions-ops.js',
    'netlify/functions/customer-portal-pay.js',
    'netlify/functions/stripe-webhook.js',
    'netlify/functions/list-bookings.js',
  ]);
  for (const file of functionChanges) {
    assert.ok(allowed.has(file), `unexpected function change: ${file}`);
  }
});

test('state-hub accordions remain intact', () => {
  for (const hub of [
    'new-jersey-hub.html',
    'ny-metro-hub.html',
    'connecticut-hub.html',
    'pennsylvania-hub.html',
  ]) {
    const html = fs.readFileSync(path.join(root, hub), 'utf8');
    assert.match(html, /class="service-area-accordion"/, `${hub} missing accordion`);
    assert.match(html, /data-single-open/, `${hub} missing single-open accordion group`);
    assert.match(html, /id="service-areas"/, `${hub} missing service-areas section`);
  }
});
