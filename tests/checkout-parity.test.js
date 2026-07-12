'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const HUB_PAGES = [
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

test('index.html is authoritative four-step checkout', () => {
  const html = read('index.html');
  assert.match(html, /BK_VISIBLE_STEPS\s*=\s*4/);
  assert.doesNotMatch(html, /id="bpt5"/);
  assert.doesNotMatch(html, /id="bpt6"/);
  assert.match(html, /checkout-analytics\.js/);
  assert.match(html, /checkout-offer\.js/);
});

for (const page of HUB_PAGES) {
  test(`${page} delegates booking to index via hub-booking-bridge`, () => {
    const html = read(page);
    assert.match(html, /hub-booking-bridge\.js/, `${page} must load hub-booking-bridge.js`);
    assert.match(read('assets/hub-booking-bridge.js'), /cd1-hub-booking-delegated/);
  });
}

test('specialty pages use specialty-booking-bridge not legacy six-step labels', () => {
  for (const page of ['boats-detailing.html', 'rv-detailing.html', 'powersports-detailing.html']) {
    const html = read(page);
    assert.match(html, /specialty-booking-bridge\.js/);
    assert.doesNotMatch(html, /id="bpt5"/);
  }
});

test('admin offer controls exist in admin ops', () => {
  const jobs = read('netlify/functions/admin-ops-jobs.js');
  const ui = read('admin-ops.html');
  assert.match(jobs, /apply_welcome_offer/);
  assert.match(jobs, /remove_welcome_offer/);
  assert.match(jobs, /reason_required/);
  assert.match(ui, /Welcome offer \(WELCOME10\)/);
  assert.match(ui, /dOfferApply/);
  assert.match(ui, /dOfferRemove/);
});

test('technician cannot grant welcome offer', () => {
  const tech = read('netlify/functions/tech-complete-job.js');
  assert.doesNotMatch(tech, /welcome_offer|apply_welcome_offer|WELCOME10/i);
});

test('welcome offer terms linked from checkout and terms page', () => {
  assert.match(read('index.html'), /terms-conditions#welcome-offer/);
  assert.match(read('terms-conditions.html'), /id="welcome-offer"/);
  assert.match(read('terms-conditions.html'), /maximum savings of \$40/);
});

test('WELCOME10 enabled only on operations-core-job-lifecycle branch context', () => {
  const toml = read('netlify.toml');
  assert.match(toml, /\[context\."operations-core-job-lifecycle"\.environment\]/);
  assert.match(toml, /FIRST_BOOKING_OFFER_ENABLED = "true"/);
  assert.doesNotMatch(toml, /\[context\.production\.environment\][\s\S]*FIRST_BOOKING_OFFER_ENABLED = "true"/);
});

test('offer engine scopes branch QA to operations-core-job-lifecycle deploy only', () => {
  const src = read('netlify/lib/revenue-offers.js');
  assert.match(src, /isOperationsCoreBranchDeploy/);
  assert.match(src, /operations-core-job-lifecycle--/);
});
