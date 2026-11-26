'use strict';

// Every public page with its own booking form must load checkout-analytics.js.
// booking-review-runtime.js reports a persisted booking only through
// Cardetail1CheckoutAnalytics.onBookingSubmitted, which forwards the Google Ads
// "Book appointment" conversion and the first-party booking_submitted event.
// Without the script the booking succeeds but both signals are skipped silently.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const bookingPages = fs.readdirSync(root)
  .filter((file) => file.endsWith('.html'))
  .filter((file) => {
    const html = read(file);
    return html.includes('assets/booking-review-runtime.js') && html.includes('assets/revenue-events.js');
  });

test('the runtime reports bookings only through Cardetail1CheckoutAnalytics', () => {
  const runtime = read('assets/booking-review-runtime.js');
  assert.match(runtime, /Cardetail1CheckoutAnalytics\.onBookingSubmitted\(/);
});

test('booking pages are discovered, including the homepage and county hubs', () => {
  for (const page of ['index.html', 'bergen-county-hub.html', 'new-jersey-hub.html', 'newark-mobile-detailing.html']) {
    assert.ok(bookingPages.includes(page), `${page} should be a booking page`);
  }
});

test('every booking page loads checkout-analytics.js before revenue-events.js', () => {
  for (const page of bookingPages) {
    const html = read(page);
    const analytics = html.indexOf('<script src="assets/checkout-analytics.js"></script>');
    const revenue = html.indexOf('<script src="assets/revenue-events.js"></script>');
    assert.ok(analytics !== -1, `${page} must load assets/checkout-analytics.js`);
    assert.ok(analytics < revenue, `${page} must load checkout-analytics.js before revenue-events.js`);
  }
});

test('the RevOps injector adds checkout-analytics.js to booking pages', () => {
  const injector = read('scripts/inject-revops.mjs');
  assert.match(injector, /assets\/booking-review-runtime\.js/);
  assert.match(injector, /<script src="assets\/checkout-analytics\.js"><\/script>\\n<script src="assets\/revenue-events\.js"><\/script>/);
});
