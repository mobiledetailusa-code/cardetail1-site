const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const runtimeSrc = fs.readFileSync(path.join(root, 'assets/booking-review-runtime.js'), 'utf8');
const ceramicSrc = fs.readFileSync(path.join(root, 'assets/ceramic-booking.js'), 'utf8');
const PREVIEW = 'Preview only — booking submission is disabled.';

function boot(url) {
  const dom = new JSDOM(html, {
    url,
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const ctx = dom.getInternalVMContext();
  vm.runInContext(runtimeSrc, ctx);
  const w = dom.window;
  w.ST = { payMethod: '', pkgId: '', basePrice: 0, addonTotal: 0, addons: [] };
  w.selectPaymentPreference = function (pref) { w.ST.payMethod = pref; };
  w.selectPayChoice = function () {};
  w.cofCheckboxChanged = function () {};
  w.alert = function () { w.__alerts.push(arguments[0]); };
  w.__alerts = [];
  w.Cardetail1BookingReview.install(w);
  return { w, ctx };
}

function panel(w) {
  return {
    wrap: w.document.getElementById('bk-online-card-wrap'),
    card: w.document.getElementById('bk-onsite-card-copy'),
    cash: w.document.getElementById('bk-onsite-cash-copy'),
    cof: w.document.getElementById('cof-policy-ok'),
    btn: w.document.getElementById('stripe-auth-btn'),
    rec: w.document.getElementById('bk-online-rec-msg'),
    details: w.document.getElementById('bk-pay-details'),
    charged: w.document.getElementById('bk-charged-copy'),
    badge: w.document.querySelector('#bs5 .pay-badge'),
  };
}

test('only the selected payment option is shown', () => {
  const { w } = boot('https://cardetail1.com/');
  const R = w.Cardetail1BookingReview;
  R.selectRequestPaymentPreference('cash_onsite');
  let p = panel(w);
  assert.equal(p.wrap.hidden, true);
  assert.equal(p.cash.hidden, false);
  assert.equal(p.card.hidden, true);
  assert.equal(p.cof.disabled, true);
  assert.equal(p.cof.checked, false);
  assert.equal(p.cof.required, false);
  assert.equal(p.details.contains(p.cof), false);
  assert.match(p.cash.textContent, /no card needed to submit/i);

  R.selectRequestPaymentPreference('card_onsite');
  p = panel(w);
  assert.equal(p.wrap.hidden, true);
  assert.equal(p.card.hidden, false);
  assert.equal(p.cash.hidden, true);
  assert.equal(p.cof.disabled, true);
  assert.equal(p.cof.checked, false);

  R.selectRequestPaymentPreference('online_after_service');
  p = panel(w);
  assert.equal(p.wrap.hidden, false);
  assert.equal(p.card.hidden, true);
  assert.equal(p.cash.hidden, true);
  assert.equal(p.cof.disabled, false);
  assert.equal(p.cof.checked, false);
  assert.equal(p.details.contains(p.cof), false);
  assert.match(p.rec.textContent, /Save a card securely now\. Nothing is charged today\./);
  assert.equal(p.btn.textContent, 'Save my card securely');
  assert.match(p.details.querySelector('summary').textContent, /Payment & cancellation details/);
  assert.match(p.cof.parentElement.textContent, /booking policy/);
  assert.match(p.cof.parentElement.innerHTML, /href="\/terms-conditions"/);
});

test('cash and card at service do not require the hidden card authorization', async () => {
  const { w } = boot('https://cardetail1.com/');
  const R = w.Cardetail1BookingReview;
  w.document.getElementById('terms-ok').checked = true;
  w.buildBookingPayload = function () {
    return { id: 'CD1-CASH', totalPrice: 250, paymentMethodPreference: w.ST.payMethod };
  };
  w.fetch = async () => ({
    ok: true,
    json: async () => ({ ok: true, bookingCreated: true, id: 'CD1-CASH' }),
  });
  R.selectRequestPaymentPreference('cash_onsite');
  const cof = w.document.getElementById('cof-policy-ok');
  cof.checked = true;
  cof.required = true;
  const result = await w.submitBooking();
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'persisted');
  assert.equal(cof.disabled, true);
  assert.equal(w.document.getElementById('bk-online-card-wrap').hidden, true);
});

test('ceramic deposit and prepay do not say nothing is charged today', () => {
  const { w, ctx } = boot('https://cardetail1.com/');
  w.ST.pkgId = 'ceramic_1yr';
  w.ST.basePrice = 1625;
  w.getTravelFeeAmount = function () { return 0; };
  vm.runInContext(ceramicSrc, ctx);
  w.CD1CeramicBooking.boot();
  const deposit = w.document.querySelector('input[name="ceramic-plan"][value="deposit"]');
  deposit.checked = true;
  deposit.dispatchEvent(new w.Event('change', { bubbles: true }));
  const charged = w.document.getElementById('bk-charged-copy').textContent;
  const badge = w.document.querySelector('#bs5 .pay-badge').textContent;
  const online = w.document.getElementById('bk-online-rec-msg').textContent;
  assert.match(charged, /deposit of \$406\.25/i);
  assert.doesNotMatch(charged + badge + online, /nothing is charged today|no payment is collected|no charge today/i);

  const prepay = w.document.querySelector('input[name="ceramic-plan"][value="prepay_full"]');
  prepay.checked = true;
  prepay.dispatchEvent(new w.Event('change', { bubbles: true }));
  const full = w.document.getElementById('bk-charged-copy').textContent;
  assert.match(full, /full approved total of \$1625\.00/i);
  assert.doesNotMatch(full, /nothing is charged today|no payment is collected/i);
});

test('deploy preview states the block at checkout start and does not offer a card retry', () => {
  const { w } = boot('https://deploy-preview-327--cardetail1.netlify.app/');
  const banner = w.document.getElementById('bk-preview-banner');
  const content = w.document.querySelector('#bk-ov .bcontent');
  assert.ok(banner);
  assert.equal(banner.textContent, PREVIEW);
  assert.equal(content.firstElementChild, banner);
  const called = { n: 0 };
  w.initCardOnFile = function () {
    called.n += 1;
    w.document.getElementById('stripe-auth-btn').textContent = 'Try secure card setup again';
  };
  w.Cardetail1BookingReview.install(w);
  const btn = w.document.getElementById('stripe-auth-btn');
  w.initCardOnFile();
  assert.equal(called.n, 0);
  assert.match(html, /async function confirmSetupIntent\(\)\{\s*if\(OS_PREVIEW_ACTIVE\)\{[^}]*return;\s*\}\s*if\(IS_DEPLOY_PREVIEW\)\{ showPreviewBookingDisabled\(\); return; \}/);
  assert.equal(btn.textContent, 'Save my card securely');
  assert.doesNotMatch(btn.textContent, /Try secure card setup again/);
  w.Cardetail1BookingReview.selectRequestPaymentPreference('online_after_service');
  assert.equal(w.document.getElementById('bk-preview-banner').textContent, PREVIEW);
});
