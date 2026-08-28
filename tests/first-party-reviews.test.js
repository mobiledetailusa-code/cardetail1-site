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

const { JSDOM } = (() => {
  try { return { JSDOM: require('jsdom').JSDOM }; }
  catch { return { JSDOM: null }; }
})();

function reviewsSection(html) {
  const start = html.indexOf('<div id="reviews"');
  const areas = html.indexOf('<section class="home-service-areas"');
  assert.ok(start > -1, 'homepage reviews section missing');
  assert.ok(areas > start, 'service areas should follow reviews');
  return html.slice(start, areas);
}

const section = reviewsSection(index);

test('homepage loads the first-party reviews module and keeps the reviews anchor', () => {
  assert.match(index, /id="reviews"/);
  assert.match(index, /href="#reviews"/);
  assert.match(index, /<script src="assets\/customer-reviews\.js"><\/script>/);
  assert.match(index, /function renderReviews\(\)\{[\s\S]*CD1CustomerReviews\.mount/);
  assert.match(index, /function rvViewAll\(\)\{[\s\S]*CD1CustomerReviews\.viewAll/);
  assert.doesNotMatch(index, /const REVIEWS\s*=\s*\[/);
});

test('homepage reviews copy is first-party plus a labeled static Google snapshot', () => {
  assert.match(section, /Customer Reviews/);
  assert.match(section, /Customer experiences with Cardetail1/);
  assert.doesNotMatch(section, /Customer experiences with Detailing Zone/);
  assert.match(section, /5\.0 on Google/);
  assert.match(section, /9 reviews/);
  assert.match(section, /Google review snapshot · August 2026/);
  assert.match(section, /My Garage/);
  assert.match(section, /View all reviews/);
  assert.doesNotMatch(section, /copied from the current/);
  assert.doesNotMatch(section, /not a live Google feed/);
  assert.doesNotMatch(section, /live Google reviews/i);
  assert.doesNotMatch(section, /powered by Google/i);
  assert.doesNotMatch(section, /id="rv-featured"/);
});

test('homepage reviews keep booking, Cardetail1, and optional Google CTAs', () => {
  assert.match(section, /onclick="openBooking\(null\)"/);
  assert.match(section, /booking-popup-trigger/);
  assert.match(section, /Book Your Detail/);
  assert.match(section, /href="my-garage.html#lookup"/);
  assert.match(section, /Leave a Cardetail1 review/);
  assert.match(
    section,
    /href="https:\/\/g\.page\/r\/CTJwfJerrQeCEAI\/review"/,
  );
  assert.match(section, /Leave a Google Review/);
  assert.equal(reviews.GOOGLE_REVIEW_URL, 'https://g.page/r/CTJwfJerrQeCEAI/review');
  assert.equal(reviews.PORTAL_REVIEWS_URL, '/.netlify/functions/public-reviews');
});

test('curated reviews have names, ratings, and non-empty text', () => {
  const all = reviews.all();
  assert.ok(all.length >= 8, `expected a real customer set, got ${all.length}`);
  for (const review of all) {
    assert.ok(review.id, `${review.name} missing id`);
    assert.ok(String(review.name || '').trim(), 'review missing name');
    assert.equal(typeof review.rating, 'number');
    assert.ok(review.rating >= 1 && review.rating <= 5);
    assert.ok(String(review.text || '').trim().length > 8, `${review.name} has empty text`);
    assert.ok(String(review.date || '').trim(), `${review.name} missing date`);
  }
});

test('public cards exclude empty quotes, owner self-review, and duplicate bodies', () => {
  const names = reviews.all().map((r) => r.name);
  assert.ok(!names.includes('Magno Junior'), 'owner self-review should not be featured');
  assert.ok(!names.includes('Brian Baker'), 'empty Brian Baker quote should not render');
  assert.ok(!names.includes('Jeanne Anderson'), 'duplicate Jeanne Anderson quote should not render');
  assert.ok(names.includes('Adilsom pedro'), 'current Google listing quotes should remain');
  assert.ok(names.includes('Claudio Campos'), 'current Google listing quotes should remain');

  const bodies = reviews.all().map((r) => r.text.trim());
  assert.equal(new Set(bodies).size, bodies.length, 'duplicate review bodies on the public list');
});

test('compact carousel replaces the featured grid and mixes portal reviews', () => {
  const featured = reviews.featured();
  const carousel = reviews.carousel();
  assert.equal(featured.length, 0, 'featured grid must not lengthen the homepage');
  assert.ok(carousel.length >= 8, `carousel count ${carousel.length}`);
  const googleIds = new Set(reviews.googleReviews().map((r) => r.id));
  assert.ok(googleIds.has('g-claudio-campos'));
  assert.ok(googleIds.has('g-john-daquila'));
});

test('reviews section reserves a bounded height and clears the sticky nav', () => {
  assert.match(index, /#reviews\{content-visibility:auto;contain-intrinsic-size:760px;scroll-margin-top:76px\}/);
});

test('homepage and reviews module do not add paid Places API or review schema', () => {
  const sources = [
    index,
    reviewsJs,
    read('netlify/functions/public-reviews.js'),
    read('netlify/functions/admin-reviews.js'),
    read('netlify/lib/first-party-reviews.js'),
  ];
  for (const src of sources) {
    assert.doesNotMatch(src, /GOOGLE_PLACES/);
    assert.doesNotMatch(src, /places\.googleapis\.com/);
    assert.doesNotMatch(src, /GOOGLE_BUSINESS_PLACE_ID/);
    assert.doesNotMatch(src, /"@type":\s*"AggregateRating"/);
    assert.doesNotMatch(src, /"@type":\s*"Review"/);
  }
  assert.doesNotMatch(index, /netlify\/functions\/google-places/);
  assert.doesNotMatch(index, /netlify\/functions\/places-reviews/);
});

if (JSDOM) {
  test('mounting paints carousel cards with attribution and portal append', () => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
      <div id="reviews">
        <div class="rv-viewport" id="rv-viewport">
          <div class="rv-track" id="rv-track"></div>
        </div>
        <div id="rv-dots"></div>
        <button type="button" id="rv-view-all">View all reviews</button>
      </div>
    </body></html>`, { runScripts: 'outside-only' });

    reviews.applyPortalItems([]);
    reviews.mount(dom.window.document, { fetch: false });

    const carouselCards = [...dom.window.document.querySelectorAll('#rv-track .rv-card')];
    assert.equal(carouselCards.length, reviews.carousel().length);
    assert.equal(dom.window.document.querySelectorAll('#rv-featured .rv-card').length, 0);

    for (const card of carouselCards) {
      assert.match(card.textContent, /\S/);
      assert.ok(card.querySelector('.rv-name').textContent.trim());
      assert.ok(card.querySelector('.rv-stars').textContent.includes('★'));
      assert.ok(card.querySelector('.rv-quote').textContent.trim().length > 8);
      assert.doesNotMatch(card.textContent, /Magno Junior/);
    }

    const beforeCarousel = reviews.carousel().length;
    reviews.applyPortalItems([{
      id: 'REV-PORTAL',
      name: 'Ada L.',
      rating: 5,
      text: 'The mobile detail left my SUV looking brand new again.',
      location: 'Palisades Park, NJ',
      date: 'Aug 2026',
      service: 'Interior Detail',
    }]);
    const carouselCardsAfter = [...dom.window.document.querySelectorAll('#rv-track .rv-card')];
    assert.ok(carouselCardsAfter.length > beforeCarousel);
    assert.ok(carouselCardsAfter.some((card) => card.getAttribute('data-review-id') === 'REV-PORTAL'));
    reviews.applyPortalItems([]);
  });
}
