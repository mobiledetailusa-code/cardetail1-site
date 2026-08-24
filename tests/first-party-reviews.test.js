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
  assert.doesNotMatch(index, /const REVIEWS\s*=\s*\[/);
});

test('homepage reviews copy is first-party and does not claim a live Google widget', () => {
  assert.match(section, /Customer reviews/);
  assert.match(section, /What local customers say/);
  assert.match(section, /first-party customer quotes/);
  assert.match(section, /not a live Google feed/);
  assert.doesNotMatch(section, /live Google reviews/i);
  assert.doesNotMatch(section, /powered by Google/i);
});

test('homepage reviews keep a booking CTA and an outbound Google review link', () => {
  assert.match(section, /onclick="openBooking\(null\)"/);
  assert.match(section, /booking-popup-trigger/);
  assert.match(section, /Book Your Detail/);
  assert.match(
    section,
    /href="https:\/\/g\.page\/r\/CTJwfJerrQeCEAI\/review"/,
  );
  assert.match(section, /Leave a Google Review/);
  assert.equal(reviews.GOOGLE_REVIEW_URL, 'https://g.page/r/CTJwfJerrQeCEAI/review');
});

test('curated reviews have names, ratings, and non-empty text', () => {
  const all = reviews.all();
  assert.ok(all.length >= 8, `expected a real customer set, got ${all.length}`);
  for (const review of all) {
    assert.ok(review.id, `${review.name} missing id`);
    assert.ok(String(review.name || '').trim(), 'review missing name');
    assert.equal(review.rating, 5);
    assert.ok(String(review.text || '').trim().length > 8, `${review.name} has empty text`);
    assert.ok(String(review.service || '').trim(), `${review.name} missing service`);
    assert.ok(String(review.date || '').trim(), `${review.name} missing date`);
  }
});

test('public cards exclude empty quotes, owner self-review, and duplicate bodies', () => {
  const names = reviews.all().map((r) => r.name);
  assert.ok(!names.includes('Magno Junior'), 'owner self-review should not be featured');
  assert.ok(!names.includes('Brian Baker'), 'empty Brian Baker quote should not render');
  assert.ok(!names.includes('Jeanne Anderson'), 'duplicate Jeanne Anderson quote should not render');
  assert.ok(names.includes('Adilsom Pedro'), 'newest listing quotes should remain');
  assert.ok(names.includes('Claudio Campos'), 'newest listing quotes should remain');

  const bodies = reviews.all().map((r) => r.text.trim());
  assert.equal(new Set(bodies).size, bodies.length, 'duplicate review bodies on the public list');
});

test('featured quotes are a short homepage set and the rest stay in the carousel', () => {
  const featured = reviews.featured();
  const carousel = reviews.carousel();
  assert.ok(featured.length >= 3 && featured.length <= 5, `featured count ${featured.length}`);
  assert.ok(carousel.length >= 3, `carousel count ${carousel.length}`);
  const featuredIds = new Set(featured.map((r) => r.id));
  for (const review of carousel) {
    assert.ok(!featuredIds.has(review.id), `${review.id} is both featured and carousel`);
  }
  assert.ok(featured.some((r) => r.id === 'claudio-campos'));
  assert.ok(featured.some((r) => r.id === 'pablo-sanchez'));
});

test('homepage and reviews module do not add paid Places API or review schema', () => {
  const sources = [index, reviewsJs];
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
  test('mounting paints featured cards and carousel with attribution', () => {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
      <div id="reviews">
        <div id="rv-featured"></div>
        <div id="rv-more">
          <div id="rv-counter"></div>
          <div id="rv-track"></div>
          <div id="rv-dots"></div>
        </div>
      </div>
    </body></html>`, { runScripts: 'outside-only' });

    reviews.mount(dom.window.document);

    const featuredCards = [...dom.window.document.querySelectorAll('#rv-featured .rv-card')];
    const carouselCards = [...dom.window.document.querySelectorAll('#rv-track .rv-card')];
    assert.equal(featuredCards.length, reviews.featured().length);
    assert.equal(carouselCards.length, reviews.carousel().length);

    for (const card of [...featuredCards, ...carouselCards]) {
      assert.match(card.textContent, /\S/);
      assert.ok(card.querySelector('.rv-name').textContent.trim());
      assert.ok(card.querySelector('.rv-stars').textContent.includes('★'));
      assert.ok(card.querySelector('.rv-text').textContent.trim().length > 8);
      assert.doesNotMatch(card.textContent, /Magno Junior/);
    }

    assert.equal(
      featuredCards[0].getAttribute('data-review-id'),
      reviews.featured()[0].id,
    );
    assert.match(dom.window.document.getElementById('rv-counter').textContent, /1 \/ \d+/);
  });
}
