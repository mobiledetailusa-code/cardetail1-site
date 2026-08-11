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

test('confirmSetup requires SetupIntent succeeded before marking card saved', () => {
  assert.match(confirmSetupBlock, /setupIntent\.status!=='succeeded'/);
  assert.match(confirmSetupBlock, /waitForVerifiedCardSave/);
  assert.match(confirmSetupBlock, /ST\.cardOnFileSaved\s*=\s*true/);
  // Must not mark saved before the succeeded-status gate.
  const beforeGate = confirmSetupBlock.split("setupIntent.status!=='succeeded'")[0];
  assert.doesNotMatch(beforeGate, /ST\.cardOnFileSaved\s*=\s*true/);
});

test('saved card gates continue; submit retries when server lags', () => {
  assert.match(index, /function bkScrollToConfirm|function goToConfirmFromTerms/);
  assert.match(index, /if\s*\(!ST\.cardOnFileSaved\)/);
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
  assert.match(initBlock, /captureDraftSaveResponse/);
  assert.match(initBlock, /draftSessionBookingId/);
  assert.match(initBlock, /draftSessionToken/);
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

test('booking modal progress shows six-step secure and confirm labels', () => {
  assert.match(index, /id="bpt5"[\s\S]*?Secure Your Booking/);
  assert.match(index, /id="bpt6"[\s\S]*?Confirm/);
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
  assert.match(submit, /cardOnFileStatus:\s+existing\.cardOnFileStatus/);
  assert.match(read('netlify/lib/card-on-file.js'), /setup_intents/);
});

test('no package pricing or public homepage drift in hardening diff scope', () => {
  assert.doesNotMatch(index.slice(0, index.indexOf('id="bk-ov"')), /cardInitInProgress/);
  assert.doesNotMatch(index.slice(0, index.indexOf('id="bk-ov"')), /verifyCardOnFileWithServer/);
  assert.match(index, /\b(?:const|let) PRICING\s*=/); // 4B-2: reassignable for saved-draft preview
});
