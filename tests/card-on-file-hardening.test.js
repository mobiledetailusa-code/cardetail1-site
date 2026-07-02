const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const index = read('index.html');
const submit = read('netlify/functions/submit-booking.js');

const confirmSetupBlock = index.slice(
  index.indexOf('async function confirmSetupIntent'),
  index.indexOf('async function recheckCardStatus')
);

test('confirmSetup marks card saved optimistically then verifies in background', () => {
  assert.match(confirmSetupBlock, /ST\.cardOnFileSaved\s*=\s*true/);
  assert.match(confirmSetupBlock, /waitForVerifiedCardSave/);
});

test('saved card gates continue; submit retries when server lags', () => {
  assert.match(index, /function goToConfirmFromTerms/);
  assert.match(index, /if\(!ST\.cardOnFileSaved\)/);
  const submitBlock = index.slice(
    index.indexOf('async function submitBooking'),
    index.indexOf('function buildBookingPayload')
  );
  assert.match(submitBlock, /card_on_file_not_saved/);
  assert.match(submitBlock, /waitForVerifiedCardSave/);
});

test('initCardOnFile has race protection and stale-response guards', () => {
  assert.match(index, /cardInitInProgress/);
  assert.match(index, /cardInitNonce/);
  const initBlock = index.slice(
    index.indexOf('async function initCardOnFile'),
    index.indexOf('function selectPaymentPreference')
  );
  assert.match(initBlock, /if\(cardInitInProgress\) return/);
  assert.match(initBlock, /isStale/);
  assert.match(initBlock, /if\(!ST\.draftRegistered\)/);
  assert.match(initBlock, /draftErrMap/);
});

test('openBookingFromHome syncs ZIP into booking modal with onBkZipInput', () => {
  assert.match(index, /onBkZipInput\(zip5\)/);
  assert.match(read('new-jersey-hub.html'), /initHubZipFromQuery/);
  assert.match(read('new-jersey-hub.html'), /onBkZipInput\(zip5\)/);
});

test('Stripe Payment Element unmounts before remount', () => {
  assert.match(index, /destroyStripePaymentUI/);
  assert.match(index, /stripePaymentElement/);
  assert.match(index, /\.unmount\(/);
  const initBlock = index.slice(
    index.indexOf('async function initCardOnFile'),
    index.indexOf('function selectPaymentPreference')
  );
  assert.match(initBlock, /destroyStripePaymentUI\(\)/);
});

test('booking modal progress step 5 label matches secure booking step', () => {
  assert.match(index, /id="bpt5"[^>]*>[\s\S]*?Secure Your Booking/);
});

test('booking modal action buttons use type="button"', () => {
  const modal = index.slice(
    index.indexOf('id="bk-ov"'),
    index.indexOf('<!-- ADMIN PANEL')
  );
  assert.match(modal, /<button type="button" class="btn-sub" id="sub-btn"/);
  assert.match(modal, /<button type="button" class="btn-n" onclick="goToConfirmFromTerms\(\)"/);
  assert.doesNotMatch(modal, /<button class="btn-sub" id="sub-btn"/);
});

test('submit-booking keeps strict saved check with Stripe reconcile fallback', () => {
  assert.match(submit, /reconcileCardOnFileFromStripe/);
  assert.match(submit, /existing\.cardOnFileStatus !== 'saved'/);
  assert.match(submit, /card_on_file_not_saved/);
  assert.match(submit, /setup_intents/);
  assert.match(submit, /cardOnFileStatus:\s+existing\.cardOnFileStatus/);
});

test('no package pricing or public homepage drift in hardening diff scope', () => {
  assert.doesNotMatch(index.slice(0, index.indexOf('id="bk-ov"')), /cardInitInProgress/);
  assert.doesNotMatch(index.slice(0, index.indexOf('id="bk-ov"')), /verifyCardOnFileWithServer/);
  assert.match(index, /const PRICING\s*=/);
});
