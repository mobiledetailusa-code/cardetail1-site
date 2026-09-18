'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('public camouflaged-text contrast guards', () => {
  it('shared contrast sheet forces readable ZIP placeholders', () => {
    const css = read('assets/public-surface-contrast.css');
    assert.match(css, /\.hero-zip-input::placeholder\s*\{[^}]*color:\s*#94a3b8\s*!important/);
  });

  it('luxury hero body copy is brighter than ink-soft token alone', () => {
    const css = read('assets/luxury-theme.css');
    assert.match(css, /\.hero-sub--long[\s\S]*?color:\s*#c5d0dc\s*!important/);
    assert.match(css, /\.hpb-lbl[\s\S]*?color:\s*#a8b6c6\s*!important/);
  });

  it('first-visit 10% FAB leaves mobile FAQ text uncovered', () => {
    const balloon = read('assets/welcome-lead-balloon.js');
    const contrast = read('assets/public-surface-contrast.css');
    assert.match(balloon, /home-faq[\s\S]*padding-right:76px/);
    assert.match(contrast, /body:has\(#cd1-wlb\.cd1-wlb-on\)[\s\S]*\.home-faq[\s\S]*padding-right:\s*76px/);
  });

  it('Pay online later light-modal copy stays dark (no white-on-light regression)', () => {
    const css = read('assets/booking-modal-light.css');
    assert.match(css, /\.bk-online-rec-msg[\s\S]*?color:\s*var\(--ink,\s*#0f172a\)\s*!important/);
    assert.match(css, /\.bk-pay-pref-help\s*\{[^}]*color:\s*var\(--ink-soft,\s*#475569\)/);
  });
});
