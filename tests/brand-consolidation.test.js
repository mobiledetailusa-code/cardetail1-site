'use strict';

/**
 * CARDDETAIL1 customer-facing brand consolidation.
 * Commercial identity = Cardetail1. Legal entity = Detailing Zone L.L.C.
 * Twilio / A2P / booking / payment / review authority must stay untouched.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const sha256 = (file) => crypto.createHash('sha256').update(read(file)).digest('hex');

const reviews = require('../assets/customer-reviews.js');
const smsProgram = require('../netlify/lib/sms-program');
const smsTemplates = require('../netlify/lib/sms-templates');
const { customerFacingBrand } = require('../netlify/lib/booking-transactional-notifications');

const COMMERCIAL_PAGES = [
  'index.html',
  'boats-detailing.html',
  'rv-detailing.html',
  'powersports-detailing.html',
  'fleet-services.html',
  'multi-vehicle-detailing.html',
  'new-jersey-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
  'bergen-county-hub.html',
  'essex-county-hub.html',
  'hudson-county-hub.html',
  'passaic-county-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'template-city.html',
];

const JSON_LD_PAGES = [
  'index.html',
  'template-city.html',
  'bergen-county-hub.html',
  'hudson-county-hub.html',
  'essex-county-hub.html',
  'passaic-county-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
  'new-jersey-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
];

const TWILIO_FILES = [
  'netlify/lib/sms-program.js',
  'netlify/lib/sms-templates.js',
];

const BOOKING_FILES = [
  'assets/booking-review-runtime.js',
  'netlify/functions/submit-booking.js',
];

const PAYMENT_FILES = [
  'netlify/lib/receipt-projection.js',
  'netlify/lib/booking-transactional-notifications.js',
];

const REVIEW_AUTHORITY_FILES = [
  'netlify/lib/first-party-reviews.js',
  'netlify/functions/public-reviews.js',
  'netlify/functions/admin-reviews.js',
  'netlify/functions/submit-review.js',
];

const FROZEN_SHA256 = {
  'netlify/lib/sms-program.js': '70f2b9307e09b673998423792ee5e9a56859b7fd1aed8f8084197343754d0950',
  'netlify/lib/sms-templates.js': 'ab527c1618187c89d16c52b72e8fc8ca82564ef381b70950fda3d5e9155acdc6',
  'assets/booking-review-runtime.js': '73878c27d63b265ec3df04bed56e03a25fe7ce834a73900deabd2d1bbf025f39',
  'netlify/lib/receipt-projection.js': 'ebb8b34f6e9b880f87a056d2b885862f916ac3c753ed080eafb4e24c5b73865f',
  'netlify/lib/booking-transactional-notifications.js': 'a7537beda9a8b5d88d2c998103a6ef317d1b3807ba77d38b179b883ce3ba6367',
  'netlify/lib/first-party-reviews.js': 'c9d36c5212eb193b7fb26beedb3ba470f301ab96211f57e42fc19416ff5458f6',
  'netlify/functions/public-reviews.js': '2f79b256236a00f5ba7b1ff6752aebd9566a543a3a0189b26c0d75905b7847c5',
  'netlify/functions/admin-reviews.js': '8fedcd09f08c145aabfab7b98f7298759be1d14ea95d738b3cd466f726da5f60',
  'netlify/functions/submit-review.js': 'd810b8240975f9372f7ce14a1998eaf69512f1715505b29724cb2d153295f376',
};

function reviewsSection(html) {
  const start = html.indexOf('<div id="reviews"');
  const areas = html.indexOf('<section class="home-service-areas"');
  assert.ok(start > -1, 'homepage reviews section missing');
  assert.ok(areas > start, 'service areas should follow reviews');
  return html.slice(start, areas);
}

function jsonLdBlocks(html) {
  const blocks = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) blocks.push(JSON.parse(m[1]));
  return blocks;
}

function stripAllowedDetailingZone(html) {
  return html
    .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '')
    .replace(/<div class="foot-legal">[\s\S]*?<\/div>/g, '')
    .replace(/<span>I agree to receive text messages from Detailing Zone[\s\S]*?<\/span>/g, '');
}

test('1. homepage primary brand is Cardetail1', () => {
  const index = read('index.html');
  assert.match(index, /<title>[^<]*Cardetail1[^<]*<\/title>/);
  assert.match(index, /og:site_name" content="Cardetail1"/);
  assert.match(index, /aria-label="Cardetail1 Home"/);
  assert.doesNotMatch(index, /Cardetail1\s*[—\/]\s*Detailing Zone/);
  assert.doesNotMatch(index, /Detailing Zone by Cardetail1/);
});

test('2. review heading uses Cardetail1', () => {
  const section = reviewsSection(read('index.html'));
  assert.match(section, /Customer experiences with Cardetail1/);
});

test('3. Google Business review copy uses Cardetail1', () => {
  const section = reviewsSection(read('index.html'));
  assert.match(section, /5\.0 on Google · 9 reviews/);
  assert.match(section, /Google review snapshot · August 2026/);
  assert.match(section, /New verified Cardetail1 reviews are submitted through My Garage after[\s\S]*completed services/);
  assert.doesNotMatch(section, /Customer experiences with Detailing Zone/);
  assert.doesNotMatch(section, /copied from the current Cardetail1 Google listing/);
  assert.doesNotMatch(section, /current Cardetail1 Google listing/);
});

test('4. Google review source labels are preserved', () => {
  assert.equal(reviews.sourceLabel({ source: 'google' }), 'Google review');
  for (const review of reviews.googleReviews()) {
    assert.equal(reviews.sourceLabel(review), 'Google review');
    assert.doesNotMatch(reviews.sourceLabel(review), /Verified Cardetail1/);
  }
});

test('5. My Garage first-party source labels are preserved', () => {
  assert.equal(reviews.sourceLabel({ source: 'cardetail1' }), 'Verified Cardetail1 customer');
  assert.equal(reviews.sourceLabel({ source: 'legacy' }), 'Customer');
});

test('6. public commercial headlines do not say Detailing Zone', () => {
  for (const file of COMMERCIAL_PAGES) {
    const html = stripAllowedDetailingZone(read(file));
    const headlines = [
      ...(html.match(/<title>[^<]+<\/title>/g) || []),
      ...(html.match(/class="sec-title"[^>]*>[\s\S]*?<\/(?:div|h1|h2)>/g) || []),
      ...(html.match(/<h1[^>]*>[\s\S]*?<\/h1>/g) || []),
      ...(html.match(/og:title" content="[^"]+"/g) || []),
      ...(html.match(/twitter:title" content="[^"]+"/g) || []),
    ].join('\n');
    assert.doesNotMatch(
      headlines,
      /Detailing Zone/,
      `${file} still uses Detailing Zone in a commercial headline`,
    );
    assert.doesNotMatch(html, /Customer experiences with Detailing Zone/);
    assert.doesNotMatch(html, /Cardetail1\s*[—\/]\s*Detailing Zone/);
    assert.doesNotMatch(html, /Detailing Zone by Cardetail1/);
  }
});

test('7. footer contains Cardetail1 as the customer-facing brand', () => {
  const footer = read('assets/partials/specialty-public-footer.html');
  assert.match(footer, /alt="Cardetail1 Mobile Detailing"/);
  assert.match(footer, /&copy; 2026 Cardetail1/);
  assert.doesNotMatch(footer, /we come to you\. Detailing Zone/);
  assert.doesNotMatch(footer, /Cardetail1 &middot; Detailing Zone LLC &middot; All rights reserved/);
  const indexFooter = read('index.html').match(/<footer class="specialty-public-footer"[\s\S]*?<\/footer>/)[0];
  assert.match(indexFooter, /Cardetail1/);
});

test('8. legal disclosure still contains Detailing Zone L.L.C.', () => {
  const footer = read('assets/partials/specialty-public-footer.html');
  assert.match(footer, /Cardetail1 is a registered DBA of Detailing Zone L\.L\.C\./);
  assert.match(read('index.html'), /Cardetail1 is a registered DBA of Detailing Zone L\.L\.C\./);
});

test('9. Terms retain the legal entity', () => {
  const terms = read('terms-conditions.html');
  assert.match(terms, /Cardetail1 is a registered DBA of Detailing Zone L\.L\.C\./);
  assert.match(terms, /11\. Detailing Zone Transactional SMS Program/);
  assert.match(terms, /operated by Detailing Zone LLC for Cardetail1 customers/);
});

test('10. Privacy retains the legal entity where appropriate', () => {
  const privacy = read('privacy-policy.html');
  assert.match(privacy, /Cardetail1 is a registered DBA of Detailing Zone L\.L\.C\./);
  assert.match(privacy, /a registered DBA of Detailing Zone L\.L\.C\./);
  assert.match(privacy, /transactional messages from <strong>Detailing Zone<\/strong>/);
  assert.match(privacy, /<title>Privacy Policy — Cardetail1<\/title>/);
});

test('11. JSON-LD customer-facing name is Cardetail1 with legalName preserved', () => {
  for (const file of JSON_LD_PAGES) {
    const blocks = jsonLdBlocks(read(file));
    const local = blocks.find((b) => {
      const types = [].concat(b['@type'] || []);
      return types.includes('LocalBusiness');
    });
    assert.ok(local, `${file} missing LocalBusiness JSON-LD`);
    assert.equal(local.name, 'Cardetail1', `${file} JSON-LD name`);
    assert.equal(local.legalName, 'Detailing Zone L.L.C.', `${file} JSON-LD legalName`);
  }
});

test('12. city/hub generator template produces Cardetail1 branding', () => {
  const template = read('template-city.html');
  const generator = read('scripts/generate-hub-pages.js');
  assert.match(template, /<title>Mobile Detailing in \{CITY_NAME\} \| Cardetail1<\/title>/);
  assert.match(template, /og:site_name" content="Cardetail1"/);
  assert.match(template, /"name": "Cardetail1"/);
  assert.match(template, /"legalName": "Detailing Zone L\.L\.C\."/);
  assert.match(template, /Cardetail1 is a registered DBA of Detailing Zone L\.L\.C\./);
  assert.doesNotMatch(template, /we come to you\. Detailing Zone/);
  assert.match(generator, /Premium Mobile Detailing in \$\{hub\.name\} \| Cardetail1/);
  assert.match(generator, /content="Cardetail1 — premium mobile auto/);
  for (const file of ['bergen-county-hub.html', 'newark-mobile-detailing.html', 'westchester-mobile-detailing.html']) {
    const html = read(file);
    assert.match(html, /Cardetail1/);
    assert.doesNotMatch(html, /Customer experiences with Detailing Zone/);
    assert.match(html, /"name": "Cardetail1"/);
  }
});

test('13. Twilio SMS templates and program name were not modified', () => {
  assert.equal(smsProgram.PROGRAM_NAME, 'Detailing Zone');
  assert.equal(smsProgram.LEGAL_BUSINESS_NAME, 'Detailing Zone LLC');
  assert.match(smsProgram.BOOKING_CONSENT_COPY, /text messages from Detailing Zone/);
  const rendered = smsTemplates.renderSmsTemplate(smsTemplates.TEMPLATE_KEYS.CONFIRMED, { date: 'Aug 28' });
  assert.equal(rendered.ok, true);
  assert.match(rendered.body, /^Detailing Zone:/);
  for (const file of TWILIO_FILES) {
    assert.equal(sha256(file), FROZEN_SHA256[file], `${file} must not change in this branding PR`);
  }
});

test('14. booking logic files were not modified', () => {
  const runtime = read('assets/booking-review-runtime.js');
  assert.match(runtime, /function submit\(/);
  assert.match(runtime, /function showSuccess\(/);
  assert.match(read('index.html'), /function submitBooking\(\)/);
  assert.match(read('index.html'), /bk-success-step/);
  for (const file of BOOKING_FILES) {
    if (FROZEN_SHA256[file]) {
      assert.equal(sha256(file), FROZEN_SHA256[file], `${file} must not change in this branding PR`);
    }
  }
});

test('15. payment / receipt logic files were not modified', () => {
  const receipt = read('netlify/lib/receipt-projection.js');
  assert.match(receipt, /name: 'Detailing Zone L\.L\.C\.'/);
  assert.match(receipt, /Thank you for choosing Detailing Zone\./);
  assert.equal(customerFacingBrand(), 'Cardetail1');
  for (const file of PAYMENT_FILES) {
    assert.equal(sha256(file), FROZEN_SHA256[file], `${file} must not change in this branding PR`);
  }
});

test('16. review authority and imported Google review bodies were not modified', () => {
  for (const file of REVIEW_AUTHORITY_FILES) {
    assert.equal(sha256(file), FROZEN_SHA256[file], `${file} must not change in this branding PR`);
  }
  const google = reviews.googleReviews();
  assert.equal(google.length, 9);
  const john = google.find((r) => r.id === 'g-john-daquila');
  assert.ok(john);
  assert.equal(john.rating, 5);
  assert.match(john.text, /\S/);
  assert.equal(reviews.sourceLabel(john), 'Google review');
});

test('authorize page uses DBA legal formulation, not a competing brand', () => {
  const html = read('authorize.html');
  assert.match(html, /Cardetail1, a registered DBA of Detailing Zone L\.L\.C\./);
  assert.doesNotMatch(html, /Cardetail1 \(Detailing Zone LLC\)/);
});

test('meta and Open Graph site_name stay Cardetail1', () => {
  const index = read('index.html');
  assert.match(index, /og:site_name" content="Cardetail1"/);
  assert.match(index, /og:title" content="Cardetail1/);
  assert.match(index, /twitter:title" content="Cardetail1/);
  assert.doesNotMatch(index, /og:site_name" content="Detailing Zone/);
});

test('homepage reviews do not dump Google-copy provenance as commercial copy', () => {
  const section = reviewsSection(read('index.html'));
  assert.doesNotMatch(section, /Google comments below/);
  assert.doesNotMatch(section, /not a live Google feed/);
});
