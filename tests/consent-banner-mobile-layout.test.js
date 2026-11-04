'use strict';

// Regression: on 320-375px phones the first-visit consent banner (three choices
// wrapped onto two rows) plus the sticky CTA covered the hero ZIP button, and
// once the banner was made compact the chat launcher (pinned with !important
// in public-surface-contrast.css) collided with the raised sticky CTA.
// Layout only: consent choices, defaults and storage must not change.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'assets', 'consent-manager.js'), 'utf8');

test('phones get a single-row banner with three equal-width choices', () => {
  assert.match(
    src,
    /@media\(max-width:640px\)\{#cd1-consent-banner\{padding:10px 12px calc\(10px \+ env\(safe-area-inset-bottom,0px\)\)/,
  );
  assert.match(src, /#cd1-consent-banner \.cd1-consent-actions\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
});

test('decline, analytics-only and accept remain equally available; nothing is pre-accepted', () => {
  for (const mode of ['decline', 'analytics', 'accept']) {
    assert.match(src, new RegExp(`<button type="button" data-consent="${mode}">`));
  }
  assert.match(src, /else saveConsent\(\{ analytics: false, marketing: false \}\);/);
  assert.doesNotMatch(src, /#cd1-consent-banner [^{]*\[data-consent="decline"\][^{]*\{[^}]*display:none/);
  assert.doesNotMatch(src, /#cd1-consent-banner button\{[^}]*font-size:(?:[0-9]|1[01])px/, 'choices stay readable');
});

test('chat launcher stays out of the way until a consent choice is made (phones)', () => {
  // Same effective state as before the compact banner: the launcher was fully
  // behind the taller banner. Exposed, it overlapped the sticky Call button.
  assert.match(
    src,
    /@media\(max-width:640px\)\{html\.cd1-consent-open body:has\(\.mobile-sticky-cta\) #cd-chat\{visibility:hidden\}\}/,
  );
  // Scoped to the open banner only: nothing else may hide chat.
  assert.equal((src.match(/#cd-chat\{visibility:hidden\}/g) || []).length, 1);
  assert.doesNotMatch(src, /#cd-chat\{[^}]*display:none/);
});
