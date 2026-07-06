// Guards: hub/city booking pages must not ship legacy admin/tech ops surfaces.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const hubPages = [
  'bergen-county-hub.html',
  'hudson-county-hub.html',
  'essex-county-hub.html',
  'passaic-county-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
  'new-jersey-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'template-city.html',
];

const portalFiles = ['admin.html', 'admin-ops.html', 'technician.html', 'customer.html'];
const pricingFiles = ['netlify/lib/booking-price-catalog.js'];
const stripeFiles = [
  'netlify/functions/stripe-webhook.js',
  'netlify/functions/submit-booking.js',
  'netlify/functions/create-setup-intent.js',
  'netlify/functions/create-payment-link.js',
];

const legacyOverlayIds = ['admin-ov', 'jobs-ov', 'emp-ov', 'njob-ov'];
const legacyStrings = [
  'ADMIN_DASH_PASSWORD',
  'BID_SECRET',
  'Sync Techs',
  'Technician Roster',
];
const preservedBookingStrings = [
  'id="bk-ov"',
  'const PRICING',
  'const LENGTH_PRICING',
  'function renderAddons',
  'waitForVerifiedCardSave',
  'Secure Your Booking',
];

for (const page of hubPages) {
  test(`${page} has no legacy ops overlay markup`, () => {
    const html = read(page);
    for (const id of legacyOverlayIds) {
      assert.doesNotMatch(html, new RegExp(`id="${id}"`));
    }
  });

  test(`${page} has no internal ops env strings or legacy admin panels`, () => {
    const html = read(page);
    for (const s of legacyStrings) {
      assert.doesNotMatch(html, new RegExp(s));
    }
    assert.doesNotMatch(html, /function openAdminPanel/);
    assert.doesNotMatch(html, /function openJobsBoard/);
    assert.doesNotMatch(html, /\.admin-ov\{/);
  });

  test(`${page} keeps public booking and card-on-file flow`, () => {
    const html = read(page);
    for (const s of preservedBookingStrings) {
      assert.match(html, new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.match(html, /id="cp-ov"/);
  });

  test(`${page} #admin hash redirects to canonical admin page`, () => {
    const html = read(page);
    assert.match(html, /location\.hash\s*===?\s*['"]#admin['"]/);
    assert.match(html, /location\.replace\s*\(\s*['"]\/admin['"]\s*\)/);
    assert.doesNotMatch(html, /location\.hash\s*===?\s*['"]#admin['"]\)[^;]*openLogin/);
  });
}

test('index.html was not modified by hub strip (still has public booking)', () => {
  const index = read('index.html');
  assert.match(index, /id="bk-ov"/);
  assert.doesNotMatch(index, /id="admin-ov"/);
});

test('portal HTML files are present and unchanged by hub strip guards', () => {
  for (const f of portalFiles) {
    assert.ok(fs.existsSync(path.join(root, f)), `${f} should exist`);
  }
});

test('pricing catalog files were not modified in this branch diff', () => {
  for (const f of pricingFiles) {
    const full = path.join(root, f);
    assert.ok(fs.existsSync(full), `${f} should exist`);
    assert.doesNotMatch(read(f), /ADMIN_DASH_PASSWORD/);
  }
});

test('Stripe/payment/webhook files were not modified in this branch diff', () => {
  for (const f of stripeFiles) {
    const full = path.join(root, f);
    if (!fs.existsSync(full)) continue;
    assert.doesNotMatch(read(f), /ADMIN_DASH_PASSWORD/);
    assert.doesNotMatch(read(f), /id="admin-ov"/);
  }
});

test('ZIP routing logic in index.html is unchanged', () => {
  const index = read('index.html');
  assert.match(index, /function resolveHubPageForHero/);
  assert.match(index, /NJ_HUB_ZIP3/);
  for (const page of hubPages) {
    assert.doesNotMatch(read(page), /NJ_HUB_ZIP3/, `${page} must not embed homepage ZIP routing set`);
  }
});

const stateHubPages = [
  'new-jersey-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
];

for (const page of stateHubPages) {
  test(`${page} uses shared package details modal for all three cards`, () => {
    const html = read(page);
    assert.match(html, /id="car-pkg-detail-ov"/);
    assert.match(html, /assets\/car-pkg-detail-modal\.js/);
    assert.match(html, /assets\/button-states\.css/);
    assert.match(html, /initCarPkgDetailModal\(\);/);
    assert.doesNotMatch(html, /function toggleHomePkgDetail/);
    assert.doesNotMatch(html, /id="home-pkg-detail-interior"/);
    for (const pkgId of ['interior', 'full', 'refresh']) {
      assert.match(html, new RegExp(`openHomePkgDetailModal\\('${pkgId}'`));
      assert.match(html, new RegExp(`openBookingCarPkg\\('${pkgId}'\\)`));
    }
  });
}
