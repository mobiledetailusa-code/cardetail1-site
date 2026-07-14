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
    assert.match(html, /No charge today<\/strong> — saving your card secures the booking request only/);
    assert.match(html, /Read Full Terms →/);
    assert.doesNotMatch(html, /<details class="checkout-terms-disclosure"/);
    assert.doesNotMatch(html, /Suggested Booking Terms Summary/);
  });

  test(`${page} auto-selects card-on-file and clears draft token on payment preference change`, () => {
    const html = read(page);
    if (page !== 'index.html') return;
    assert.match(html, /function ensureStep5Defaults/);
    assert.match(html, /if \(n === 4\)[\s\S]*ensureStep5Defaults/);
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
    assert.match(initBlock, /bookingId:draftSessionBookingId,draftSaveToken:draftSessionToken/);
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
    assert.match(html, /function selectPkg\(id\)\{[\s\S]*?currentBkStep < 2/);
    assert.match(html, /bkContinueFromPackage/);
    assert.doesNotMatch(html, /function selectPkg\(id\)\{[\s\S]*?renderPkgDetailPanel\(\)/);
  });
}

test('ny-metro-hub.html shows NYC travel fee notice in hero', () => {
  const html = read('ny-metro-hub.html');
  assert.match(html, /NYC and longer-distance NY jobs may include a travel fee/);
});
