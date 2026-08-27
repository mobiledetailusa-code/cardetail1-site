const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const pages = [
  'index.html',
  'new-jersey-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
];

for (const page of pages) {
  test(`${page} Step 5 uses short policy bullets, not collapsible long terms`, () => {
    const html = read(page);
    if (page !== 'index.html') {
      assert.match(html, /hub-booking-bridge\.js/);
      return;
    }
    assert.match(html, /Submit with no payment|no card or payment method is required/);
    assert.match(html, /Pay later|Pay Online in My Garage or pay at service when available/);
    assert.match(html, /Read Full Terms/);
    assert.doesNotMatch(html, /<details class="checkout-terms-disclosure"/);
    assert.doesNotMatch(html, /Suggested Booking Terms Summary/);
  });

  test(`${page} does not auto-select payment and preserves separate saved-card setup`, () => {
    const html = read(page);
    if (page !== 'index.html') return;
    assert.match(html, /function ensureStep5Defaults/);
    assert.match(html, /if \(n === 4\)[\s\S]*ensureStep5Defaults/);
    const defaultsBlock = html.match(/function ensureStep5Defaults\(\)\{[\s\S]*?\n\}/)?.[0] || '';
    assert.ok(defaultsBlock, 'ensureStep5Defaults block missing');
    assert.doesNotMatch(defaultsBlock, /ST\.payMethod\s*=/);
    assert.doesNotMatch(defaultsBlock, /selectPaymentPreference\(/);
    assert.match(html, /clearDraftRegistrationState/);
    assert.match(html, /function selectPaymentPreference/);
    const prefBlock = html.slice(
      html.indexOf('function selectPaymentPreference'),
      html.indexOf('function selectPaymentPreference') + 900
    );
    assert.match(prefBlock, /clearDraftRegistrationState\(\)/);
    assert.match(prefBlock, /cofCheckboxChanged\(\)/);
    const initBlock = html.slice(
      html.indexOf('async function initCardOnFile'),
      html.indexOf('function selectPaymentPreference')
    );
    assert.match(initBlock, /captureDraftSaveResponse\(draftData\)/);
    assert.match(initBlock, /draftSessionBookingId=session\.bookingId/);
    assert.match(initBlock, /draftSessionToken=session\.draftSaveToken/);
    // The SetupIntent request must be built from the freshly captured draft
    // session, never from possibly-stale ST fields.
    assert.match(initBlock, /requestSetupIntentWithVersionSync\(draftSessionBookingId,draftSessionToken,draftSessionBookingVersion\)/);
    assert.doesNotMatch(initBlock, /requestSetupIntentWithVersionSync\(ST\.bookingId/);
    assert.doesNotMatch(initBlock, /bookingId:ST\.bookingId,draftSaveToken:ST\.draftSaveToken/);
  });

  test(`${page} Stripe Payment Element uses light stripe theme`, () => {
    const html = read(page);
    if (page !== 'index.html') return;
    assert.match(html, /theme:'stripe'/);
    assert.doesNotMatch(html, /theme:'night'/);
  });

  test(`${page} advances to vehicle step after package selection`, () => {
    const html = read(page);
    if (page !== 'index.html') return;
    assert.match(html, /function selectPkg\(id\)\{[\s\S]*?currentBkStep < 3/);
    assert.match(html, /bkContinueFromPackage/);
    assert.doesNotMatch(html, /function selectPkg\(id\)\{[\s\S]*?renderPkgDetailPanel\(\)/);
  });
}

test('ny-metro-hub.html shows NYC travel fee notice in hero', () => {
  const html = read('ny-metro-hub.html');
  assert.match(html, /NYC and longer-distance NY jobs may include a travel fee/);
});
