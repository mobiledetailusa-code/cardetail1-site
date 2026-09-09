'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const reviews = require('../assets/customer-reviews.js');
const { renderSmsTemplate, TEMPLATE_KEYS, measureSms, bookingTemplateData } = require('../netlify/lib/sms-templates');
const { canonicalBookingSmsConsent } = require('../netlify/lib/sms-program');
const { shouldAskForReview } = require('../netlify/lib/review-request-notifications');
const {
  setAppointmentAccessStoreFactories,
  resetAppointmentAccessStoreFactories,
  createAppointmentAccessToken,
  loadTokenRecord,
  PURPOSE_APPOINTMENT_ACCESS,
  PURPOSE_REVIEW_REQUEST,
  buildReviewUrl,
  generateOpaqueToken,
} = require('../netlify/lib/appointment-access-token');
const { createCasMemoryStore } = require('./helpers/cas-memory-store');

const { JSDOM } = (() => {
  try { return { JSDOM: require('jsdom').JSDOM }; }
  catch { return { JSDOM: null }; }
})();

test('dedicated reviews page exists and is linked from the homepage', () => {
  const page = read('reviews.html');
  const index = read('index.html');
  const toml = read('netlify.toml');
  const sitemap = read('sitemap.xml');
  assert.match(page, /<h1>Customer experiences with Cardetail1<\/h1>/);
  assert.match(page, /id="rv-grid"/);
  assert.match(page, /id="rv-invite"/);
  assert.match(page, /assets\/customer-reviews\.js/);
  assert.match(page, /assets\/reviews-page\.js/);
  assert.match(index, /href="\/reviews"/);
  assert.match(toml, /from = "\/reviews"/);
  assert.match(toml, /to = "\/reviews\.html"/);
  assert.match(sitemap, /reviews\.html/);
});

test('homepage carousel is a subset of the dedicated page list', () => {
  reviews.applyPortalItems([]);
  const all = reviews.mixed();
  const home = reviews.homepage();
  assert.equal(reviews.HOME_LIMIT, 6);
  assert.ok(all.length > home.length);
  assert.equal(home.length, reviews.HOME_LIMIT);
  assert.deepEqual(home.map((r) => r.id), all.slice(0, reviews.HOME_LIMIT).map((r) => r.id));
});

test('dedicated page grid paints every published review', () => {
  if (!JSDOM) return;
  reviews.applyPortalItems([{
      id: 'REV-GRID',
      name: 'Ada L.',
      rating: 5,
      text: 'The interior looks brand new after the visit.',
      createdAt: '2026-08-24T12:00:00.000Z',
    }]);
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
      <div id="reviews"><div class="rv-grid" id="rv-grid"></div></div>
    </body></html>`, { runScripts: 'outside-only', url: 'https://cardetail1.com/reviews' });
    reviews.mount(dom.window.document, { fetch: false });
    const cards = [...dom.window.document.querySelectorAll('#rv-grid .rv-card')];
    assert.equal(cards.length, reviews.mixed().length);
    assert.ok(cards.some((card) => card.getAttribute('data-review-id') === 'REV-GRID'));
    assert.ok(cards.some((card) => card.getAttribute('data-review-id') === 'g-rose-alves'));
    reviews.applyPortalItems([]);
});

test('review request SMS is GSM-7 and stays within two segments', () => {
  const token = 'aat_' + 'A'.repeat(43);
  const url = `https://cardetail1.com/reviews?t=${token}`;
  const rendered = renderSmsTemplate(TEMPLATE_KEYS.REVIEW_REQUESTED, { url });
  assert.equal(rendered.ok, true);
  assert.match(rendered.body, /^Cardetail1:/);
  assert.match(rendered.body, /Leave a review/);
  assert.match(rendered.body, /\/reviews\?t=/);
  assert.doesNotMatch(rendered.body, /\/a\?t=/);
  assert.match(rendered.body, /Reply STOP or HELP/);
  const measure = measureSms(rendered.body);
  assert.equal(measure.encoding, 'GSM-7', rendered.body);
  assert.ok(measure.segmentCount <= 2, `${measure.segmentCount} ${rendered.body}`);
});

test('review request template does not include booking PII', () => {
  const data = bookingTemplateData(TEMPLATE_KEYS.REVIEW_REQUESTED, {
    firstName: 'Ada',
    lastName: 'Lovelace',
    phone: '2015550177',
    email: 'ada@example.com',
    address: '12 Main St',
  }, 'https://cardetail1.com/reviews?t=aat_test');
  const rendered = renderSmsTemplate(TEMPLATE_KEYS.REVIEW_REQUESTED, {
    ...data,
    url: 'https://cardetail1.com/reviews?t=aat_test',
  });
  assert.doesNotMatch(rendered.body, /2015550177|ada@example.com|12 Main St|Lovelace/i);
});

test('review SMS is only asked after a completed job without an existing review', () => {
  const consent = canonicalBookingSmsConsent(true, '2026-09-01T12:00:00.000Z', '2015550177');
  assert.equal(shouldAskForReview({
    jobStatus: 'confirmed',
    transactionalSmsConsent: consent,
    transactionalSmsConsentAccepted: true,
    phone: '2015550177',
  }), false);
  assert.equal(shouldAskForReview({
    jobStatus: 'completed_paid',
    completedAt: '2026-09-09T12:00:00.000Z',
    reviewLeft: true,
    phone: '2015550177',
  }), false);
  assert.equal(shouldAskForReview({
    jobStatus: 'issue_reported',
    completedAt: '2026-09-09T12:00:00.000Z',
    phone: '2015550177',
  }), false);
  assert.equal(shouldAskForReview({
    jobStatus: 'completed_paid',
    completedAt: '2026-09-09T12:00:00.000Z',
    phone: '2015550177',
  }), true);
});

test('review invite tokens survive appointment-access supersede', async () => {
  process.env.CUSTOMER_SESSION_SECRET = 'test-customer-session-secret-32chars-min';
  process.env.CONTEXT = 'production';
  process.env.PUBLIC_SITE_URL = 'https://cardetail1.com';
  const store = createCasMemoryStore();
  setAppointmentAccessStoreFactories({ tokenStore: () => store });
  try {
    const access = await createAppointmentAccessToken({
      bookingId: 'CD1-REVTOKEN01',
      eventType: 'booking.confirmed',
      purpose: PURPOSE_APPOINTMENT_ACCESS,
      supersede: true,
    });
    const review = await createAppointmentAccessToken({
      bookingId: 'CD1-REVTOKEN01',
      eventType: TEMPLATE_KEYS.REVIEW_REQUESTED,
      purpose: PURPOSE_REVIEW_REQUEST,
      supersede: false,
    });
    const later = await createAppointmentAccessToken({
      bookingId: 'CD1-REVTOKEN01',
      eventType: 'booking.details_updated',
      purpose: PURPOSE_APPOINTMENT_ACCESS,
      supersede: true,
    });
    const accessLoaded = await loadTokenRecord(access.token);
    const reviewLoaded = await loadTokenRecord(review.token, { expectedPurpose: PURPOSE_REVIEW_REQUEST });
    const laterLoaded = await loadTokenRecord(later.token);
    assert.equal(accessLoaded.ok, false);
    assert.equal(laterLoaded.ok, true);
    assert.equal(reviewLoaded.ok, true);
    assert.equal(reviewLoaded.record.purpose, PURPOSE_REVIEW_REQUEST);
    assert.match(buildReviewUrl(review.token), /^https:\/\/cardetail1\.com\/reviews\?t=/);
    assert.doesNotMatch(buildReviewUrl(review.token), /\/a\?t=/);
  } finally {
    resetAppointmentAccessStoreFactories();
  }
});

test('appointment access loader rejects a review-purpose token', async () => {
  process.env.CUSTOMER_SESSION_SECRET = 'test-customer-session-secret-32chars-min';
  process.env.CONTEXT = 'production';
  process.env.PUBLIC_SITE_URL = 'https://cardetail1.com';
  const store = createCasMemoryStore();
  setAppointmentAccessStoreFactories({ tokenStore: () => store });
  try {
    const review = await createAppointmentAccessToken({
      bookingId: 'CD1-REVTOKEN02',
      eventType: TEMPLATE_KEYS.REVIEW_REQUESTED,
      purpose: PURPOSE_REVIEW_REQUEST,
      supersede: false,
    });
    const asAccess = await loadTokenRecord(review.token);
    assert.equal(asAccess.ok, false);
    assert.equal(asAccess.error, 'invalid_token');
  } finally {
    resetAppointmentAccessStoreFactories();
  }
});

test('opaque review URLs never include booking identity', () => {
  const token = generateOpaqueToken();
  const url = buildReviewUrl(token);
  assert.match(url, /^https:\/\/cardetail1\.com\/reviews\?t=/);
  assert.doesNotMatch(url, /phone=|email=|bookingId=|address=/i);
});

test('submit-review accepts a review invite token', () => {
  const src = read('netlify/functions/submit-review.js');
  assert.match(src, /authorizeReviewInviteToken/);
  assert.match(src, /consumeReviewInviteToken/);
  assert.match(src, /body\.token/);
});
