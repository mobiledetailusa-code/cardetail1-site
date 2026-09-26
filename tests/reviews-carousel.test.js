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

function mountReviewsPage() {
  assert.ok(JSDOM, 'jsdom is required for reviews page DOM tests');
  reviews.applyPortalItems([]);
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <div id="reviews"><div id="rv-grid"></div></div>
  </body></html>`, {
    runScripts: 'outside-only',
    url: 'https://cardetail1.com/reviews',
  });
  reviews.mount(dom.window.document, { fetch: false });
  return dom;
}

test('1. static Google review renders', () => {
  const google = reviews.googleReviews();
  assert.equal(google.length, 12);
  const claudio = google.find((r) => r.id === 'g-claudio-campos');
  assert.ok(claudio);
  assert.equal(claudio.name, 'Claudio Campos');
  if (!JSDOM) return;
  const home = mountDom();
  const homeCard = home.window.document.querySelector('[data-review-id="tt-jackie-b"]');
  assert.ok(homeCard);
  assert.match(homeCard.textContent, /Jackie B\./);
  assert.equal(
    home.window.document.querySelector('[data-review-id="g-john-daquila"]'),
    null,
    'John is past the homepage HOME_LIMIT once newer Thumbtack cards lead the mix',
  );
  assert.equal(
    home.window.document.querySelector('[data-review-id="g-claudio-campos"]'),
    null,
    'Claudio is past the homepage HOME_LIMIT once Thumbtack cards lead the mix',
  );
  const page = mountReviewsPage();
  const card = page.window.document.querySelector('[data-review-id="g-claudio-campos"]');
  assert.ok(card);
  assert.match(card.textContent, /Claudio Campos/);
});

test('2. Google source label renders', () => {
  assert.equal(reviews.sourceLabel({ source: 'google' }), 'Google review');
  if (!JSDOM) return;
  const dom = mountReviewsPage();
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
  const homeIds = new Set(reviews.homepage().map((r) => r.id));
  if (homeIds.has('g-rose-alves')) {
    assert.equal(
      dom.window.document.querySelector('[data-review-id="g-rose-alves"] .rv-quote').textContent,
      rose.text,
    );
  }
  assert.equal(reviews.googleReviews().find((r) => r.id === 'g-rose-alves').text, rose.text);
});

test('new Google reviews from the 2026-09-26 panel render exactly', () => {
  const google = reviews.googleReviews();
  const lauren = google.find((r) => r.id === 'g-lauren-murphy');
  const michael = google.find((r) => r.id === 'g-michael-purcell');
  const kasey = google.find((r) => r.id === 'g-kasey-wasserbeck');
  assert.equal(lauren.name, 'Lauren Murphy');
  assert.equal(lauren.rating, 5);
  assert.equal(lauren.date, 'Sep 2026');
  assert.equal(lauren.relativeDate, 'a day ago');
  assert.equal(
    lauren.text,
    'My car looks incredible \u2014 it honestly feels brand new again. Everything from the exterior, seats and console to the dash and little details was spotless. He was extremely thorough, professional, and clearly takes pride in his work.',
  );
  assert.doesNotMatch(lauren.text, /The last/);
  assert.equal(michael.name, 'Michael Purcell');
  assert.equal(michael.rating, 5);
  assert.equal(michael.text, 'He did a fantastic job cleaning an RV I have from head to toe 10 out of 10 would recommend');
  assert.equal(kasey.name, 'Kasey Wasserbeck');
  assert.equal(kasey.rating, 5);
  assert.equal(kasey.text, 'Amazing detail service. Quick and spotless clean. Car looks brand new on the inside again!');

  const ids = reviews.mixed().map((r) => r.id);
  assert.ok(ids.indexOf('g-lauren-murphy') < ids.indexOf('g-michael-purcell'));
  assert.ok(ids.indexOf('g-michael-purcell') < ids.indexOf('g-kasey-wasserbeck'));
  assert.ok(ids.indexOf('g-kasey-wasserbeck') < ids.indexOf('g-john-daquila'));
  assert.ok(ids.indexOf('tt-carol-g') < ids.indexOf('g-lauren-murphy'));

  if (!JSDOM) return;
  const page = mountReviewsPage();
  const card = page.window.document.querySelector('[data-review-id="g-lauren-murphy"]');
  assert.ok(card);
  assert.equal(card.getAttribute('data-source'), 'google');
  assert.match(card.textContent, /Google review/);
  assert.equal(card.querySelector('.rv-quote').textContent, lauren.text);
  assert.equal(
    page.window.document.querySelector('[data-review-id="g-michael-purcell"] .rv-quote').textContent,
    michael.text,
  );
});

test('4. Google rating preserved exactly', () => {
  for (const review of reviews.googleReviews()) {
    assert.equal(review.rating, 5);
  }
  if (!JSDOM) return;
  const dom = mountReviewsPage();
  const card = dom.window.document.querySelector('[data-review-id="g-john-daquila"]');
  assert.ok(card);
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

test('12. View all sends visitors to the dedicated reviews page', () => {
  assert.equal(reviews.REVIEWS_PAGE_URL, '/reviews');
  assert.match(index, /<a class="btn-outline" id="rv-view-all" href="\/reviews">View all reviews<\/a>/);
  assert.match(index, /function rvViewAll\(\)\{\s*window\.location\.assign\('\/reviews'\);/);
  assert.match(reviewsJs, /view\.location\.assign\(REVIEWS_PAGE_URL\)/);
  reviews.applyPortalItems([]);
  assert.ok(reviews.mixed().some((r) => r.id === 'g-john-daquila'));
  assert.ok(reviews.mixed().length > reviews.homepage().length);
});

test('13. View all excludes hidden and internal reviews', () => {
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
  assert.equal(reviews.mixed().some((r) => r.id === 'REV-HIDE'), false);
  assert.equal(reviews.mixed().some((r) => r.id === 'REV-INT'), false);
  reviews.applyPortalItems([]);
});

test('14. Read more preserves full review text', () => {
  const cynthia = reviews.thumbtackReviews().find((r) => r.id === 'tt-cynthia-c');
  if (!JSDOM) return;
  const dom = mountDom();
  const card = dom.window.document.querySelector('[data-review-id="tt-cynthia-c"]');
  assert.ok(card.querySelector('.rv-read-more'));
  reviews.openReview('tt-cynthia-c');
  const overlay = dom.window.document.getElementById('rv-overlay');
  assert.equal(overlay.querySelector('.rv-quote').textContent, cynthia.text);
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
  assert.match(index, /href="\/reviews"/);
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
  assert.ok(dom.window.document.querySelector('[data-review-id="tt-jackie-b"]'));
  assert.ok(reviews.mixed().some((r) => r.id === 'g-john-daquila'));
  assert.equal(reviews.googleReviews().length, 12);
});

test('Google listing snapshot is Cardetail1, not a lookalike shop', () => {
  assert.equal(reviews.GOOGLE_LISTING.name, 'Cardetail1');
  assert.equal(reviews.GOOGLE_LISTING.phone, '(551) 389-3986');
  assert.equal(reviews.GOOGLE_LISTING.reviewCount, 12);
  assert.equal(reviews.GOOGLE_LISTING.ratingLabel, '5.0');
  assert.match(reviews.GOOGLE_LISTING.cid, /0x8207adab977c7032/);
  assert.equal(reviews.GOOGLE_LISTING.reviewUrl, 'https://g.page/r/CTJwfJerrQeCEAI/review');
});

test('legacy testimonials are not labeled Google or Verified Cardetail1', () => {
  const pablo = reviews.legacyReviews().find((r) => r.id === 'legacy-pablo-sanchez');
  assert.ok(pablo);
  assert.equal(reviews.sourceLabel(pablo), 'Customer');
  if (!JSDOM) return;
  const dom = mountReviewsPage();
  const card = dom.window.document.querySelector('[data-review-id="legacy-pablo-sanchez"]');
  assert.ok(card);
  assert.equal(card.querySelector('.rv-source').textContent, 'Customer');
  assert.doesNotMatch(card.textContent, /Google review/);
  assert.doesNotMatch(card.textContent, /Verified Cardetail1 customer/);
});

test('static Thumbtack reviews render with Thumbtack labels, not Cardetail1 verified', () => {
  const thumbtack = reviews.thumbtackReviews();
  assert.equal(thumbtack.length, 6);
  assert.equal(reviews.sourceLabel({ source: 'thumbtack' }), 'Thumbtack review');

  const dachena = thumbtack.find((r) => r.id === 'tt-dachena-g');
  const jackie = thumbtack.find((r) => r.id === 'tt-jackie-b');
  const jasmin = thumbtack.find((r) => r.id === 'tt-jasmin-g');
  const cynthia = thumbtack.find((r) => r.id === 'tt-cynthia-c');
  const kasey = thumbtack.find((r) => r.id === 'tt-kasey-w');
  const carol = thumbtack.find((r) => r.id === 'tt-carol-g');
  assert.ok(dachena);
  assert.ok(jackie);
  assert.ok(jasmin);
  assert.ok(cynthia);
  assert.ok(kasey);
  assert.ok(carol);
  assert.equal(dachena.name, 'Dachena G.');
  assert.equal(dachena.rating, 5);
  assert.equal(dachena.date, 'Sep 26, 2026');
  assert.equal(
    dachena.text,
    'Highly recommend! He did an amazing job detailing my car. He was professional, took his time, and paid attention to every little detail. My car came out looking and feeling brand new. You can definitely tell he takes pride in his work. Great service and quality work \u2014 I\u2019ll definitely be coming back!',
  );
  assert.equal(jackie.name, 'Jackie B.');
  assert.equal(jackie.rating, 5);
  assert.equal(jackie.date, 'Sep 25, 2026');
  assert.equal(
    jackie.text,
    'Great service! Magno was quick to respond, easy to communicate with and did a wonderful job on the interior of my car. It looks brand new!',
  );
  assert.equal(jasmin.name, 'Jasmin G.');
  assert.equal(jasmin.rating, 5);
  assert.equal(jasmin.date, 'Sep 24, 2026');
  assert.match(jasmin.text, /quick replies\u2014- they did the best job/);
  assert.match(jasmin.text, /clean start \(literally\)\.  This is a humble/);
  assert.equal(cynthia.name, 'Cynthia C.');
  assert.equal(cynthia.rating, 5);
  assert.equal(cynthia.date, 'Sep 8, 2026');
  assert.match(cynthia.text, /detailed two vehicles in one visit/);
  assert.match(cynthia.text, /will definitely be using his services again!/);
  assert.equal(kasey.name, 'Kasey W.');
  assert.equal(kasey.rating, 5);
  assert.equal(kasey.date, 'Aug 30, 2026');
  assert.equal(kasey.text, 'Amazing car detail, looks brand new');
  assert.equal(carol.name, 'Carol G.');
  assert.equal(carol.rating, 5);
  assert.equal(carol.date, 'Aug 21, 2026');
  assert.equal(carol.text, 'Excellent job detailing my car!  Would highly recommend.');
  assert.doesNotMatch(reviews.sourceLabel(jackie), /Verified Cardetail1/);
  assert.doesNotMatch(reviews.sourceLabel(jackie), /Google review/);

  reviews.applyPortalItems([]);
  const mixed = reviews.mixed();
  const jackieIdx = mixed.findIndex((r) => r.id === 'tt-jackie-b');
  const cynthiaIdx = mixed.findIndex((r) => r.id === 'tt-cynthia-c');
  const carolIdx = mixed.findIndex((r) => r.id === 'tt-carol-g');
  const johnIdx = mixed.findIndex((r) => r.id === 'g-john-daquila');
  assert.ok(jackieIdx > -1 && cynthiaIdx > -1 && carolIdx > -1 && johnIdx > -1);
  assert.ok(jackieIdx < cynthiaIdx && cynthiaIdx < carolIdx && carolIdx < johnIdx, 'newer Thumbtack snapshot should precede Google snapshot');

  const homeIds = reviews.homepage().map((r) => r.id);
  assert.deepEqual(homeIds, [
    'tt-dachena-g',
    'tt-jackie-b',
    'tt-jasmin-g',
    'tt-cynthia-c',
    'tt-kasey-w',
    'tt-carol-g',
  ]);

  if (!JSDOM) return;
  const home = mountDom();
  const homeCard = home.window.document.querySelector('[data-review-id="tt-jackie-b"]');
  assert.ok(homeCard);
  assert.equal(homeCard.getAttribute('data-source'), 'thumbtack');
  assert.match(homeCard.textContent, /Thumbtack review/);
  assert.doesNotMatch(homeCard.textContent, /Verified Cardetail1 customer/);
  assert.equal(
    home.window.document.querySelector('[data-review-id="tt-jackie-b"] .rv-quote').textContent,
    jackie.text,
  );

  const page = mountReviewsPage();
  const pageCard = page.window.document.querySelector('[data-review-id="tt-kasey-w"]');
  assert.ok(pageCard);
  assert.equal(pageCard.getAttribute('data-source'), 'thumbtack');
  assert.match(pageCard.textContent, /Thumbtack review/);
  const jackiePage = page.window.document.querySelector('[data-review-id="tt-jackie-b"]');
  assert.ok(jackiePage);
  assert.equal(jackiePage.querySelector('.rv-quote').textContent, jackie.text);
});

test('Thumbtack import does not add a live Thumbtack API or change Google snapshot', () => {
  assert.doesNotMatch(reviewsJs, /thumbtack\.com\/api/i);
  assert.doesNotMatch(reviewsJs, /THUMBTACK_API/);
  assert.equal(reviews.googleReviews().length, 12);
  assert.doesNotMatch(index, /5\.0 on Google · 9 reviews/);
  assert.doesNotMatch(index, /9 reviews/);
});

