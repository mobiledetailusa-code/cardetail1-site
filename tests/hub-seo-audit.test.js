const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const stateHubs = [
  'new-jersey-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
];

const ogImages = {
  'new-jersey-hub.html': 'hero-nj-desktop.webp',
  'ny-metro-hub.html': 'hero-ny-desktop.webp',
  'connecticut-hub.html': 'hero-ct-desktop.webp',
  'pennsylvania-hub.html': 'hero-pa-desktop.webp',
};

for (const page of stateHubs) {
  test(`${page} has og:image and FAQPage schema`, () => {
    const html = read(page);
    assert.match(html, /property="og:image"/);
    assert.match(html, new RegExp(ogImages[page]));
    assert.match(html, /"@type": "FAQPage"/);
    assert.match(html, /id="local-faq"/);
    assert.match(html, /g\.page\/r\/CTJwfJerrQeCEAI\/review/);
  });

  test(`${page} syncs hero ZIP when opening booking modal`, () => {
    const html = read(page);
    assert.match(html, /function syncBookingZipFromHero/);
    assert.match(html, /function openBooking\(cat\)\{[\s\S]*syncBookingZipFromHero\(\)/);
  });
}

test('ny-metro-hub.html uses NY-local customer copy in reviews and CTA', () => {
  const html = read('ny-metro-hub.html');
  assert.match(html, /Serving NYC &amp; NY Metro by appointment/);
  assert.doesNotMatch(html, /Serving Bergen County &amp; North Jersey/);
  assert.match(html, /NYC &amp; NY Metro by appointment from our NJ base/);
});

test('index.html syncs hero ZIP in openBooking and has og:image', () => {
  const index = read('index.html');
  assert.match(index, /function syncBookingZipFromHero/);
  assert.match(index, /property="og:image"/);
  assert.match(index, /g\.page\/r\/CTJwfJerrQeCEAI\/review/);
});
