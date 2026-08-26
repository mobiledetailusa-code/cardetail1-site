'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const index = read('index.html');
const reviewsJs = read('assets/customer-reviews.js');
const reviews = require('../assets/customer-reviews.js');
const adminReviews = read('netlify/functions/admin-reviews.js');
const submitReview = read('netlify/functions/submit-review.js');
const myGarage = read('assets/my-garage.js');
const publicReviews = read('netlify/functions/public-reviews.js');
const firstPartyLib = read('netlify/lib/first-party-reviews.js');

const { JSDOM } = (() => {
  try { return { JSDOM: require('jsdom').JSDOM }; }
  catch { return { JSDOM: null }; }
})();

const GOOGLE_RUNTIME = [
  /GOOGLE_PLACES/,
  /GOOGLE_MAPS_API/,
  /GOOGLE_API_KEY/,
  /AIza[0-9A-Za-z_-]{20,}/,
  /places\.googleapis\.com/,
  /maps\.googleapis\.com/,
  /foursquare/,
  /new google\.maps/,
];

function mountDom() {
  assert.ok(JSDOM, 'jsdom is required for carousel DOM tests');
  reviews.applyPortalItems([]);
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <div id="reviews">
      <div class="rv-viewport" id="rv-viewport" tabindex="0">
        <div class="rv-track" id="rv-track"></div>
      </div>
      <button type="button" id="rv-prev" aria-label="Previous reviews"></button>
      <div id="rv-dots"></div>
      <button type="button" id="rv-next" aria-label="Next reviews"></button>
      <button type="button" id="rv-view-all">View all reviews</button>
      <button type="button" class="btn-primary booking-popup-trigger" onclick="openBooking(null)">Book Your Detail</button>
    </div>
  </body></html>`, {
    runScripts: 'outside-only',
    url: 'https://cardetail1.com/',
  });
  reviews.mount(dom.window.document, { fetch: false });
  return dom;
}

test('1. static Google review renders', () => {
  const google = reviews.googleReviews();
  assert.equal(google.length, 9);
  const claudio = google.find((r) => r.id === 'g-claudio-campos');
  assert.ok(claudio);
  if (!JSDOM) return;
  const dom = mountDom();
  const card = dom.window.document.querySelector('[data-review-id="g-claudio-campos"]');
  assert.ok(card);
  assert.match(card.textContent, /Claudio Campos/);
});

test('2. Google source label renders', () => {
  assert.equal(reviews.sourceLabel({ source: 'google' }), 'Google review');
  if (!JSDOM) return;
  const dom = mountDom();
  const card = dom.window.document.querySelector('[data-review-id="g-john-daquila"]');
  assert.equal(card.getAttribute('data-source'), 'google');
  assert.match(card.textContent, /Google review/);
  assert.doesNotMatch(card.textContent, /Verified Cardetail1 customer/);
});

test('3. Google text preserved exactly', () => {
  const rose = reviews.googleReviews().find((r) => r.id === 'g-rose-alves');
  assert.equal(rose.text, 'Good job, my was car was terrible , now is brand new.');
  const john = reviews.googleReviews().find((r) => r.id === 'g-john-daquila');
  assert.match(john.text, /He did and incredible job/);
  const claudio = reviews.googleReviews().find((r) => r.id === 'g-claudio-campos');
  assert.equal(
    claudio.text,
    'Great Job !! Highly recommended ! My car looks like it came out of the new lot! Thank You so much 😊',
  );
  if (!JSDOM) return;
  const dom = mountDom();
  assert.equal(
    dom.window.document.querySelector('[data-review-id="g-rose-alves"] .rv-quote').textContent,
    rose.text,
  );
});

test('4. Google rating preserved exactly', () => {
  for (const review of reviews.googleReviews()) {
    assert.equal(review.rating, 5);
  }
  if (!JSDOM) return;
  const dom = mountDom();
  const card = dom.window.document.querySelector('[data-review-id="g-dani-sames"]');
  assert.equal(card.getAttribute('data-rating'), '5');
  assert.match(card.querySelector('.rv-stars').getAttribute('aria-label'), /5 out of 5 stars/);
});

test('5. no Google API or runtime dependency', () => {
  const haystacks = [reviewsJs, index, publicReviews, adminReviews, firstPartyLib];
  for (const src of haystacks) {
    for (const pattern of GOOGLE_RUNTIME) {
      assert.doesNotMatch(src, pattern);
    }
    assert.doesNotMatch(src, /fetch\([^)]*google/i);
  }
  assert.doesNotMatch(reviewsJs, /setInterval/);
});

test('6. no Google API credential introduced', () => {
  const files = [
    'assets/customer-reviews.js',
    'index.html',
    'netlify/functions/public-reviews.js',
    'netlify/functions/admin-reviews.js',
    'netlify/lib/first-party-reviews.js',
    'package.json',
  ];
  for (const file of files) {
    const src = read(file);
    assert.doesNotMatch(src, /AIza[0-9A-Za-z_-]{20,}/);
    assert.doesNotMatch(src, /GOOGLE_PLACES_API_KEY/);
    assert.doesNotMatch(src, /GOOGLE_BUSINESS_API/);
  }
});

test('7. published Cardetail1 review renders', () => {
  if (!JSDOM) return;
  const dom = mountDom();
  reviews.applyPortalItems([{
    id: 'REV-OK',
    name: 'Ada L.',
    rating: 5,
    text: 'The interior looks brand new after the visit.',
    location: 'Palisades Park',
    date: 'Aug 2026',
    source: 'cardetail1',
    createdAt: '2026-08-24T12:00:00.000Z',
  }]);
  const card = dom.window.document.querySelector('[data-review-id="REV-OK"]');
  assert.ok(card);
  assert.equal(card.getAttribute('data-source'), 'cardetail1');
  assert.match(card.textContent, /Verified Cardetail1 customer/);
  reviews.applyPortalItems([]);
});

test('8. hidden Cardetail1 review does not render', () => {
  if (!JSDOM) return;
  const dom = mountDom();
  reviews.applyPortalItems([
    {
      id: 'REV-HIDE',
      name: 'Hidden H.',
      rating: 5,
      text: 'This published-looking comment should stay off the homepage.',
      status: 'hidden',
    },
    {
      id: 'REV-OK',
      name: 'Ada L.',
      rating: 5,
      text: 'The interior looks brand new after the visit.',
    },
  ]);
  assert.equal(dom.window.document.querySelector('[data-review-id="REV-HIDE"]'), null);
  assert.ok(dom.window.document.querySelector('[data-review-id="REV-OK"]'));
  reviews.applyPortalItems([]);
});

test('9. low-star internal review does not render', () => {
  if (!JSDOM) return;
  const dom = mountDom();
  reviews.applyPortalItems([{
    id: 'REV-LOW',
    name: 'Sam S.',
    rating: 3,
    text: 'The car looks brand new after the detail but I am logging a complaint.',
  }]);
  assert.equal(dom.window.document.querySelector('[data-review-id="REV-LOW"]'), null);
  assert.equal(reviews.mixed().some((r) => r.id === 'REV-LOW'), false);
  reviews.applyPortalItems([]);
});

test('10. Google + Cardetail1 coexist without duplicate IDs', () => {
  reviews.applyPortalItems([{
    id: 'REV-OK',
    name: 'Ada L.',
    rating: 5,
    text: 'The interior looks brand new after the visit.',
    createdAt: '2026-08-24T12:00:00.000Z',
  }]);
  const mixed = reviews.mixed();
  const ids = mixed.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('REV-OK'));
  assert.ok(ids.includes('g-john-daquila'));
  const bodies = mixed.map((r) => r.text.toLowerCase().replace(/\s+/g, ' ').trim());
  assert.equal(new Set(bodies).size, bodies.length);
  reviews.applyPortalItems([]);
});

test('11. carousel bounded card count / viewport semantics', () => {
  assert.equal(reviews.visibleCount(1440), 3);
  assert.equal(reviews.visibleCount(800), 2);
  assert.equal(reviews.visibleCount(390), 1);
  assert.match(index, /flex:0 0 calc\(\(100% - 28px\) \/ 3\)/);
  assert.match(index, /flex-basis:calc\(\(100% - 14px\) \/ 2\)/);
  assert.match(index, /@media\(max-width:640px\)\{[\s\S]*\.rv-slide\{flex-basis:100%\}/);
  assert.doesNotMatch(index, /id="rv-featured"/);
});

test('12. View all contains all published reviews', () => {
  if (!JSDOM) return;
  const dom = mountDom();
  reviews.applyPortalItems([{
    id: 'REV-OK',
    name: 'Ada L.',
    rating: 5,
    text: 'The interior looks brand new after the visit.',
    createdAt: '2026-08-24T12:00:00.000Z',
  }]);
  reviews.viewAll();
  const overlay = dom.window.document.getElementById('rv-overlay');
  assert.equal(overlay.hidden, false);
  const cards = [...overlay.querySelectorAll('.rv-card')];
  assert.equal(cards.length, reviews.mixed().length);
  assert.ok(cards.some((card) => card.getAttribute('data-review-id') === 'REV-OK'));
  assert.ok(cards.some((card) => card.getAttribute('data-review-id') === 'g-john-daquila'));
  reviews.closeOverlay();
  reviews.applyPortalItems([]);
});

test('13. View all excludes hidden and internal reviews', () => {
  if (!JSDOM) return;
  const dom = mountDom();
  reviews.applyPortalItems([
    {
      id: 'REV-HIDE',
      name: 'Hidden H.',
      rating: 5,
      text: 'This published-looking comment should stay off the homepage.',
      hidden: true,
    },
    {
      id: 'REV-INT',
      name: 'Internal I.',
      rating: 2,
      text: 'Internal-only complaint that must never reach the homepage carousel.',
      internal: true,
    },
  ]);
  reviews.viewAll();
  const overlay = dom.window.document.getElementById('rv-overlay');
  assert.equal(overlay.querySelector('[data-review-id="REV-HIDE"]'), null);
  assert.equal(overlay.querySelector('[data-review-id="REV-INT"]'), null);
  reviews.closeOverlay();
  reviews.applyPortalItems([]);
});

test('14. Read more preserves full review text', () => {
  const john = reviews.googleReviews().find((r) => r.id === 'g-john-daquila');
  if (!JSDOM) return;
  const dom = mountDom();
  const card = dom.window.document.querySelector('[data-review-id="g-john-daquila"]');
  assert.ok(card.querySelector('.rv-read-more'));
  reviews.openReview('g-john-daquila');
  const overlay = dom.window.document.getElementById('rv-overlay');
  assert.equal(overlay.querySelector('.rv-quote').textContent, john.text);
  reviews.closeOverlay();
});

test('15. XSS is escaped', () => {
  if (!JSDOM) return;
  const payload = '<script>alert(1)</script><img src=x onerror=alert(1)> "quoted" & entities 🚗' + 'x'.repeat(400);
  const dom = mountDom();
  reviews.applyPortalItems([{
    id: 'REV-XSS',
    name: '<script>alert(1)</script>',
    rating: 5,
    text: payload,
    createdAt: '2026-08-25T00:00:00.000Z',
  }]);
  const card = dom.window.document.querySelector('[data-review-id="REV-XSS"]');
  assert.ok(card);
  assert.equal(card.querySelectorAll('script').length, 0);
  assert.equal(card.querySelectorAll('img').length, 0);
  assert.match(card.innerHTML, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(card.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(card.querySelector('.rv-quote').textContent, payload);
  reviews.openReview('REV-XSS');
  const overlay = dom.window.document.getElementById('rv-overlay');
  assert.equal(overlay.querySelectorAll('script').length, 0);
  assert.equal(overlay.querySelector('.rv-quote').textContent, payload);
  reviews.closeOverlay();
  reviews.applyPortalItems([]);
});

test('16. mobile structure is valid', () => {
  assert.match(index, /id="rv-viewport"/);
  assert.match(index, /aria-roledescription="carousel"/);
  assert.match(index, /aria-label="Previous reviews"/);
  assert.match(index, /aria-label="Next reviews"/);
  assert.match(index, /id="rv-view-all"/);
  assert.match(index, /@media\(max-width:640px\)\{[\s\S]*\.rv-slide\{flex-basis:100%\}/);
  assert.match(index, /scroll-snap-type:x mandatory/);
});

test('17. existing booking CTA remains available', () => {
  const sectionStart = index.indexOf('<div id="reviews"');
  const section = index.slice(sectionStart, index.indexOf('<section class="home-service-areas"'));
  assert.match(section, /onclick="openBooking\(null\)"/);
  assert.match(section, /Book Your Detail/);
  assert.match(section, /booking-popup-trigger/);
});

test('18. Admin Publish/Hide contract unchanged', () => {
  assert.match(adminReviews, /action !== 'publish' && action !== 'hide'/);
  assert.match(adminReviews, /Customer words are never edited/);
  assert.doesNotMatch(adminReviews, /review\.comment\s*=/);
  assert.match(adminReviews, /hideFromHomepage/);
  assert.match(adminReviews, /publishToHomepage/);
});

test('19. My Garage review submission contract unchanged', () => {
  assert.match(myGarage, /post\('submit-review'/);
  assert.match(myGarage, /leave_review/);
  assert.match(submitReview, /evaluateReviewSubmission/);
  assert.match(submitReview, /authorizeBookingAccess/);
  assert.match(firstPartyLib, /rating >= 4 && rating <= 5/);
});

test('20. Google unavailable has zero runtime impact', () => {
  if (!JSDOM) return;
  const dom = mountDom();
  let fetchCalled = false;
  dom.window.fetch = function () {
    fetchCalled = true;
    return Promise.reject(new Error('google offline'));
  };
  reviews.mount(dom.window.document, { fetch: false });
  assert.equal(fetchCalled, false);
  assert.ok(dom.window.document.querySelector('[data-review-id="g-john-daquila"]'));
  assert.equal(reviews.googleReviews().length, 9);
});

test('Google listing snapshot is Cardetail1, not a lookalike shop', () => {
  assert.equal(reviews.GOOGLE_LISTING.name, 'Cardetail1');
  assert.equal(reviews.GOOGLE_LISTING.phone, '(551) 373-5668');
  assert.equal(reviews.GOOGLE_LISTING.reviewCount, 9);
  assert.equal(reviews.GOOGLE_LISTING.ratingLabel, '5.0');
  assert.match(reviews.GOOGLE_LISTING.cid, /0x8207adab977c7032/);
  assert.equal(reviews.GOOGLE_LISTING.reviewUrl, 'https://g.page/r/CTJwfJerrQeCEAI/review');
});

test('legacy testimonials are not labeled Google or Verified Cardetail1', () => {
  const pablo = reviews.legacyReviews().find((r) => r.id === 'legacy-pablo-sanchez');
  assert.ok(pablo);
  assert.equal(reviews.sourceLabel(pablo), 'Customer');
  if (!JSDOM) return;
  const dom = mountDom();
  const card = dom.window.document.querySelector('[data-review-id="legacy-pablo-sanchez"]');
  assert.equal(card.querySelector('.rv-source').textContent, 'Customer');
  assert.doesNotMatch(card.textContent, /Google review/);
  assert.doesNotMatch(card.textContent, /Verified Cardetail1 customer/);
});
