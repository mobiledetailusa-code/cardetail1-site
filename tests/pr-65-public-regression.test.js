// Guards: PR #64 public UX restored on index.html without PR #65 homepage regressions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('Choose Your Service copy matches PR #64 compact section', () => {
  assert.match(
    index,
    /Select your vehicle type and see packages, pricing, and add-ons in the booking flow\. Serving Bergen County and nearby NJ\/NY areas\./
  );
});

test('Recent Work section and carousel loader are present', () => {
  assert.match(index, /class="results-section"/);
  assert.match(index, /id="rw-carousel-wrap"/);
  assert.match(index, /id="rw-placeholder"/);
  assert.match(index, /function initRecentWorkCarousel/);
  assert.match(index, /\/\.netlify\/functions\/recent-work/);
});

test('reviews cred-row no longer advertises placeholder gallery line', () => {
  assert.doesNotMatch(index, /Photo gallery of recent work now live/);
});

test('Step 5 uses short booking policy bullets, not collapsible long terms', () => {
  assert.match(index, /No charge today<\/strong> — saving your card secures the booking request only/);
  assert.match(index, /Read Full Terms →/);
  assert.doesNotMatch(index, /<details class="checkout-terms-disclosure"/);
  assert.doesNotMatch(index, /Suggested Booking Terms Summary/);
});

test('public header and card-on-file flow unchanged', () => {
  assert.match(index, /onclick="openBooking\(null\)"/);
  assert.match(index, /onclick="openPortal\(\)"/);
  assert.match(index, /href="tel:5513132956"/);
  assert.match(index, /waitForVerifiedCardSave/);
  assert.match(index, /Secure Your Booking/);
  assert.match(index, /create-setup-intent/);
});

test('no legacy admin overlay surfaces reintroduced on homepage', () => {
  assert.doesNotMatch(index, /id="admin-ov"/);
  assert.doesNotMatch(index, /function openAdminPanel/);
});
