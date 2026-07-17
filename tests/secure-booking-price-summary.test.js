'use strict';

// Secure Your Booking (Step 5) price-summary protection:
// one prominent readable Estimated Total, mobile-service adjustment folded into
// the total with an accessible disclosure, and no inactive welcome-savings copy.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const html = read('index.html');
const offerJs = read('assets/checkout-offer.js');

// ── Extract the inline summary renderer so its math can be executed ──────────
function extractFn(name) {
  const re = new RegExp(`function ${name}\\([^)]*\\)\\{[\\s\\S]*?\\n}`, 'm');
  const m = html.match(re);
  assert.ok(m, `function ${name} must exist in index.html`);
  return m[0];
}

function buildSandbox() {
  const els = {};
  const doc = {
    getElementById(id) {
      if (!els[id]) els[id] = { textContent: '', innerHTML: '', hidden: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; } };
      return els[id];
    },
  };
  const ctx = { document: doc, els };
  vm.createContext(ctx);
  vm.runInContext(extractFn('bkMoney'), ctx);
  vm.runInContext(extractFn('bkFinRow'), ctx);
  vm.runInContext(extractFn('renderBkFinancialSummary'), ctx);
  return ctx;
}

function render(ctx, args) {
  return vm.runInContext(`renderBkFinancialSummary(${JSON.stringify(args)})`, ctx);
}

// ── WCAG relative-luminance contrast ─────────────────────────────────────────
function channel(v) {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function luminance(hex) {
  const h = hex.replace('#', '');
  return 0.2126 * channel(parseInt(h.slice(0, 2), 16))
    + 0.7152 * channel(parseInt(h.slice(2, 4), 16))
    + 0.0722 * channel(parseInt(h.slice(4, 6), 16));
}
function contrast(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

describe('price calculation invariant', () => {
  it('estimated total = service + add-ons + adjustment - discount', () => {
    const ctx = buildSandbox();
    const total = render(ctx, { servicePrice: 538, addonTotal: 0, travelFee: 25, discount: 0 });
    assert.equal(total, 563);
    assert.equal(ctx.els['bk-total-amount'].textContent, '$563.00');
  });

  it('reference RV fixture renders $538.00 + $25.00 = $563.00 in details', () => {
    const ctx = buildSandbox();
    render(ctx, { servicePrice: 538, addonTotal: 0, travelFee: 25, discount: 0 });
    const lines = ctx.els['bk-financial-lines'].innerHTML;
    assert.match(lines, /Service price<\/span><span>\$538\.00/);
    assert.match(lines, /Mobile service adjustment<\/span><span>\$25\.00/);
    assert.match(lines, /Estimated total<\/span><span>\$563\.00/);
  });

  it('expanded detail rows always sum to the displayed total', () => {
    const ctx = buildSandbox();
    const cases = [
      { servicePrice: 225, addonTotal: 45, travelFee: 0, discount: 0 },
      { servicePrice: 538, addonTotal: 0, travelFee: 25, discount: 0 },
      { servicePrice: 300, addonTotal: 135, travelFee: 55, discount: 22.5 },
    ];
    for (const c of cases) {
      const total = render(ctx, c);
      assert.equal(total, Math.round((c.servicePrice + c.addonTotal + c.travelFee - c.discount) * 100) / 100);
      const nums = [...ctx.els['bk-financial-lines'].innerHTML.matchAll(/\$([\d,]+\.\d{2})/g)]
        .map((m) => Number(m[1].replace(/,/g, '')));
      const displayedTotal = nums[nums.length - 1];
      assert.equal(displayedTotal, total);
    }
  });

  it('zero-value rows are omitted from the breakdown', () => {
    const ctx = buildSandbox();
    render(ctx, { servicePrice: 225, addonTotal: 0, travelFee: 0, discount: 0 });
    const lines = ctx.els['bk-financial-lines'].innerHTML;
    assert.doesNotMatch(lines, /Selected add-ons/);
    assert.doesNotMatch(lines, /Mobile service adjustment/);
    assert.doesNotMatch(lines, /discount/i);
    assert.match(lines, /Estimated total/);
  });

  it('adjustment presence controls the supporting sentence', () => {
    const ctx = buildSandbox();
    render(ctx, { servicePrice: 538, addonTotal: 0, travelFee: 25, discount: 0 });
    assert.equal(ctx.els['bk-total-incl'].textContent, 'Includes the mobile service adjustment for your location.');
    render(ctx, { servicePrice: 225, addonTotal: 0, travelFee: 0, discount: 0 });
    assert.equal(ctx.els['bk-total-incl'].textContent, 'Mobile service included.');
  });

  it('server travel fee and RV pricing formulas are unchanged', () => {
    const t = require('../netlify/lib/travel-fee');
    assert.deepEqual(t.TRAVEL_FEE_TIERS.map((x) => x.fee), [0, 15, 25, 35, 40, 55]);
    const c = require('../netlify/lib/booking-price-catalog');
    const r = c.validateAndRecalculateBookingPricing({
      zipCode: '06850',
      vehicleCategory: 'rvs',
      vehicles: [{ cat: 'rvs', pkgId: 'maint_light', subtotal: 538, lengthFt: 18, rvType: 'travel' }],
    });
    assert.equal(r.ok, true);
    assert.equal(r.serviceSubtotal, 538);
  });
});

describe('price presentation', () => {
  it('exactly one prominent estimated-total element exists', () => {
    assert.equal((html.match(/id="bk-total-amount"/g) || []).length, 1);
    assert.match(html, /\.bk-total-amount\{[^}]*font-size:clamp\(28px/);
    assert.match(html, /\.bk-total-amount\{[^}]*font-weight:700/);
  });

  it('primary total uses dark text on a light panel with WCAG AA contrast', () => {
    const fg = html.match(/\.bk-total-amount\{[^}]*color:(#[0-9a-f]{6})/i);
    const bg = html.match(/\.bk-total-main\{[^}]*background:(#[0-9a-f]{6})/i);
    assert.ok(fg && bg, 'total must use explicit hex colors immune to theme inheritance');
    assert.ok(contrast(fg[1], bg[1]) >= 4.5, `contrast ${contrast(fg[1], bg[1]).toFixed(2)} must be >= 4.5`);
  });

  it('no competing prominent Travel row in the collapsed summary', () => {
    const summary = html.match(/<div class="bk-financial-summary"[\s\S]*?<\/div>\s*<div class="bdesc"/)[0];
    assert.doesNotMatch(summary, />Travel</);
    assert.doesNotMatch(summary, /Service subtotal/);
  });

  it('has an accessible collapsed-by-default View price details disclosure', () => {
    assert.match(html, /<button type="button" class="bk-details-toggle" id="bk-details-toggle" aria-expanded="false" aria-controls="bk-financial-lines"[^>]*>View price details<\/button>/);
    assert.match(html, /<div id="bk-financial-lines" class="bk-price-details" hidden>/);
    assert.match(html, /function toggleBkPriceDetails\(\)/);
    assert.match(html, /btn\.setAttribute\('aria-expanded', open \? 'false' : 'true'\)/);
    assert.match(html, /\.bk-details-toggle:focus-visible\{outline/);
  });

  it('charged today stays visible with accurate no-charge copy', () => {
    assert.match(html, /<div class="bk-charged-row"><span>Charged today<\/span><span class="bk-charged-amt">\$0\.00<\/span><\/div>/);
    assert.match(html, /No payment is collected today\. A card may be securely placed on file to confirm the booking request\./);
  });

  it('step 5 renders a local summary immediately on entry', () => {
    assert.match(html, /if \(n === 5\) \{\s*ensureStep5Defaults\(\);\s*renderStep5Summary\(\);/);
  });
});

describe('inactive welcome savings removed', () => {
  it('no visible Welcome savings, 10% max $40, or blank discount space', () => {
    assert.doesNotMatch(html, /Welcome savings/);
    assert.doesNotMatch(html, /10% max \$40/);
    assert.doesNotMatch(html, /bk-offer-terms-note/);
  });

  it('offer panel stays dormant, hidden, and server-gated', () => {
    assert.match(html, /<div id="bk-welcome-offer" class="bk-welcome-offer" hidden/);
    assert.match(offerJs, /eligibility_status !== 'eligible'\) return;/);
  });

  it('no promo-code field or apply control while the feature is disabled', () => {
    assert.doesNotMatch(html, /Have a promo code\?/);
    assert.doesNotMatch(html, /<input[^>]*promo/i);
    assert.doesNotMatch(html, /id="[^"]*promo[^"]*"/i);
  });

  it('WELCOME10 remains disabled by default and validated server-side only', () => {
    const prev = process.env.FIRST_BOOKING_OFFER_ENABLED;
    delete process.env.FIRST_BOOKING_OFFER_ENABLED;
    const { getOfferConfig, clearOfferDeployHost } = require('../netlify/lib/revenue-offers');
    clearOfferDeployHost();
    assert.equal(getOfferConfig().firstBooking.enabled, false);
    if (prev !== undefined) process.env.FIRST_BOOKING_OFFER_ENABLED = prev;
    const { CLIENT_OFFER_BLOCKED_FIELDS } = require('../netlify/lib/booking-offers');
    assert.ok(CLIENT_OFFER_BLOCKED_FIELDS.includes('discount_amount'));
  });
});

describe('cross-step price consistency', () => {
  it('steps 4, 5, 6, success, and text summary use $X.00 formatting', () => {
    assert.match(html, /totalEl\.textContent = cartBase \? bkMoney\(cartBase\+fee\) : 'Estimate';/);
    assert.match(html, /el\.textContent = total \? bkMoney\(total\) : 'Estimate';/);
    assert.match(html, /getElementById\('c-total'\)\.textContent=total \? bkMoney\(total\) : 'Estimate';/);
    assert.match(html, /getElementById\('ok-total'\)\.textContent=\(b\.totalPrice\|\|0\)\?bkMoney\(b\.totalPrice\):'Estimate';/);
    assert.match(html, /Estimated total: \$\$\{\(Number\(b\.totalPrice\)\|\|0\)\.toFixed\(2\)\}/);
  });

  it('step 6 explains the adjustment instead of hiding it in Pkg price', () => {
    assert.match(html, /<div id="c-travel-line"><\/div>/);
    assert.match(html, /Mobile service adjustment<\/span><span class="ov">\+'\+bkMoney\(fee\)/);
    assert.doesNotMatch(html, /c-pprice'\)\.textContent=ST\.basePrice \? '\$'\+\(ST\.basePrice\+fee\)/);
  });

  it('server preview still overrides the local summary on step 5', () => {
    assert.match(offerJs, /renderBkFinancialSummary/);
    assert.match(offerJs, /servicePrice: \(serviceSubtotal \|\| 0\) - addons/);
    assert.match(html, /Cardetail1WelcomeOffer\.fetchPreview\('step5'\)/);
  });

  it('payload total remains service + travel with no client-side discount', () => {
    assert.match(html, /const totalPrice= cartBase \+ fee;/);
  });
});

describe('regression guards', () => {
  it('six steps, payment preferences, and Stripe flow remain', () => {
    assert.match(html, /BK_VISIBLE_STEPS\s*=\s*6/);
    assert.match(html, /pc-cash/);
    assert.match(html, /pc-onsite/);
    assert.match(html, /pc-online/);
    assert.match(html, /confirmSetupIntent/);
    assert.match(html, /create-setup-intent/);
  });

  it('no Twilio code introduced', () => {
    assert.doesNotMatch(html, /twilio/i);
    assert.doesNotMatch(offerJs, /twilio/i);
  });
});
