const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('RV specialty fields stack and suggestions stay in flow on narrow screens', () => {
  const css = read('assets/booking-summary.css');
  assert.match(css, /@media \(max-width: 480px\)[\s\S]*#generic-search-wrap > \.sel-row[\s\S]*grid-template-columns: minmax\(0, 1fr\) !important/);
  assert.match(css, /#generic-search-wrap \.srch-dd\.open[\s\S]*position: static[\s\S]*max-height: 160px/);
});

test('specialty suggestions close through delegated keyboard and focus events', () => {
  const js = read('assets/booking-conversion-ux.js');
  assert.match(js, /function wireSpecialtySuggestionDismissal\(\)/);
  assert.match(js, /\['Enter', 'Escape', 'Tab'\]\.includes\(event\.key\)/);
  assert.match(js, /addEventListener\('focusout'/);
  assert.match(js, /addEventListener\('pointerup'/);
});

test('Ceramic review keeps labels separated and money values unbroken', () => {
  const js = read('assets/ceramic-booking.js');
  assert.match(js, /#ceramic-checkout-lines>div:not\(\.fl\).*display:flex.*gap:12px/);
  assert.match(js, /#ceramic-checkout-lines>div:not\(\.fl\)>strong.*white-space:nowrap.*word-break:keep-all/);
  assert.match(js, /moneyLine\('Approved final total', approved\)/);
  assert.match(js, /moneyLine\('Due today', 0\)/);
});

test('mobile sticky CTA reserves content space and chat clears the bar', () => {
  const css = read('assets/public-surface-contrast.css');
  assert.match(css, /body:has\(\.mobile-sticky-cta\)[\s\S]*padding-bottom: calc\(81px \+ env\(safe-area-inset-bottom, 0px\)\)/);
  assert.match(css, /body:has\(\.mobile-sticky-cta\) #cd-chat[\s\S]*bottom: calc\(81px \+ env\(safe-area-inset-bottom, 0px\)\)/);
  assert.match(css, /@media \(max-width: 360px\)[\s\S]*bottom: calc\(96px \+ env\(safe-area-inset-bottom, 0px\)\)/);
});
