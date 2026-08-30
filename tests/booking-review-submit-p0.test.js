'use strict';

/**
 * P0 booking Review & Submit / Request Sent regressions:
 * bkMoney false-failure, total parity, single submit surface, payment preference
 * metadata, and hub/city runtime identity.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const runtimeSrc = read('assets/booking-review-runtime.js');
const Review = require('../assets/booking-review-runtime.js');

const BOOKING_PAGES = [
  'index.html',
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

const HOMEPAGE = 'index.html';
const COUNTY_HUB = 'bergen-county-hub.html';
const STATE_HUB = 'ny-metro-hub.html';
const CITY_PAGE = 'westchester-mobile-detailing.html';

function countSubmitButtons(html) {
  const modalStart = html.indexOf('id="bk-ov"');
  const modal = html.slice(modalStart, html.indexOf('id="bk-ov"') > 0 ? html.length : html.length);
  const bs5 = html.slice(html.indexOf('id="bs5"'), html.indexOf('id="bs6"'));
  const bs6 = html.slice(html.indexOf('id="bs6"'), html.indexOf('BK_SUCCESS_END'));
  return {
    total: (html.match(/id="sub-btn"/g) || []).length,
    onclick: (html.match(/onclick="submitBooking\(\)"/g) || []).length,
    inStep5: /id="sub-btn"/.test(bs5),
    inStep6: /id="sub-btn"/.test(bs6) || /onclick="submitBooking\(\)"/.test(bs6),
  };
}

describe('canonical runtime identity', () => {
  it('defines bkMoney and is loaded on homepage, county hub, state hub, and city pages', () => {
    assert.equal(typeof Review.money, 'function');
    assert.equal(Review.money(396), '$396.00');
    assert.match(runtimeSrc, /function money\(n\)/);
    for (const page of [HOMEPAGE, COUNTY_HUB, STATE_HUB, CITY_PAGE, ...BOOKING_PAGES]) {
      const html = read(page);
      assert.match(html, /assets\/booking-review-runtime\.js/, `${page} missing canonical booking runtime`);
      assert.match(html, /assets\/booking-review\.css/, `${page} missing review CSS`);
    }
  });

  it('bkMoney is defined after the runtime loads even when the page never declared it', () => {
    const ctx = { window: {}, document: { readyState: 'complete', addEventListener() {} } };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(runtimeSrc + '\nthis.__money = (this.bkMoney || this.Cardetail1BookingReview.money)(396);', ctx);
    assert.equal(ctx.__money, '$396.00');
    assert.equal(typeof ctx.bkMoney, 'function');
  });

  it('legacy hub showSuccess cannot throw bkMoney is not defined once the runtime is present', () => {
    const hub = read(STATE_HUB);
    const show = hub.slice(hub.indexOf('function showSuccess(payload){'), hub.indexOf('function showSuccess(payload){') + 900);
    assert.match(show, /bkMoney\(b\.totalPrice\)/);
    const ctx = {
      window: {},
      document: {
        readyState: 'complete',
        addEventListener() {},
        querySelectorAll() { return []; },
        getElementById() { return { textContent: '', classList: { add() {}, remove() {} }, innerHTML: '' }; },
      },
      ST: {},
      console,
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(runtimeSrc, ctx);
    assert.doesNotThrow(() => ctx.bkMoney(396));
    assert.equal(ctx.bkMoney(396), '$396.00');
  });
});

describe('estimated total presentation', () => {
  it('canonical $396 selection displays $396.00 on review and success', () => {
    const totals = Review.presentationTotals({
      vehicles: [{ basePrice: 371, addonTotal: 0, subtotal: 371 }],
      travelFeeAmount: 25,
      totalPrice: 396,
    });
    assert.equal(totals.estimatedTotal, 396);
    assert.equal(totals.payloadTotal, 396);
    assert.equal(Review.money(totals.estimatedTotal), '$396.00');

    const els = {};
    const fakeDoc = {
      getElementById(id) {
        if (!els[id]) els[id] = { textContent: '', innerHTML: '', hidden: false, setAttribute() {}, getAttribute() { return null; } };
        return els[id];
      },
    };
    const prev = global.document;
    global.document = fakeDoc;
    try {
      Review.renderBkFinancialSummary({ servicePrice: 371, addonTotal: 0, travelFee: 25, discount: 0 });
    } finally {
      global.document = prev;
    }
    assert.equal(els['bk-total-amount'].textContent, '$396.00');
    assert.equal(els['c-total'].textContent, '$396.00');
  });

  it('reads page-scoped let ST even when window.ST is empty', () => {
    const ctx = {
      console,
      document: { readyState: 'complete', addEventListener() {}, getElementById() { return null; } },
    };
    vm.createContext(ctx);
    vm.runInContext(
      'let ST = { vehicles: [{ basePrice: 371, addonTotal: 0, subtotal: 371 }], travelFee: 25, payMethod: "online_after_service" };',
      ctx
    );
    vm.runInContext(runtimeSrc, ctx);
    const totals = vm.runInContext('Cardetail1BookingReview.presentationTotals()', ctx);
    assert.equal(totals.service, 371);
    assert.equal(totals.fee, 25);
    assert.equal(totals.estimatedTotal, 396);
    assert.equal(totals.payloadTotal, 396);
  });

  it('review and success use the same money formatter and payload total', () => {
    assert.equal(Review.money(396), '$396.00');
    const persisted = { totalPrice: 396, preferredDate: '2026-08-31', preferredArrivalWindow: 'anytime', id: 'CD1-TEST' };
    assert.equal(Review.money(persisted.totalPrice), '$396.00');
  });
});

describe('false-failure contract', () => {
  it('persisted then render exception is classified as ui_after_persist, never not-submitted', () => {
    const kind = Review.classifyError(new Error('bkMoney is not defined'), { persisted: true });
    assert.equal(kind.kind, 'ui_after_persist');
    assert.equal(kind.retry, false);
    const msg = Review.notSubmittedMessage('bkMoney is not defined');
    assert.doesNotMatch(msg, /bkMoney/);
    assert.match(Review.notSubmittedMessage('booking_store_unavailable'), /not submitted|unavailable/i);
  });

  it('showFallbackSuccess never asks the customer to resubmit', () => {
    const els = {};
    const doc = {
      getElementById(id) {
        if (!els[id]) {
          els[id] = {
            textContent: '',
            innerHTML: '',
            classList: { add() {}, remove() {} },
            setAttribute() {},
            getAttribute() { return null; },
            style: {},
          };
        }
        return els[id];
      },
      querySelectorAll() { return []; },
    };
    const fake = { document: doc, ST: {}, bkGoTo() {} };
    const prevDoc = global.document;
    const prevST = global.ST;
    global.document = doc;
    global.ST = fake.ST;
    try {
      const result = Review.showFallbackSuccess({ id: 'CD1-QA1', totalPrice: 396 });
      assert.equal(result.ok, true);
      assert.equal(result.fallback, true);
      assert.match(els['ok-sub'].textContent, /received/);
      assert.doesNotMatch(els['ok-sub'].textContent, /not submitted|try again/i);
      assert.match(els['ok-sub'].textContent, /CD1-QA1/);
    } finally {
      global.document = prevDoc;
      global.ST = prevST;
    }
  });

  it('isPersistedResponse is true for bookingCreated and idempotent replays', () => {
    assert.equal(Review.isPersistedResponse({ ok: true }, { ok: true, bookingCreated: true, id: 'CD1-1' }), true);
    assert.equal(Review.isPersistedResponse({ ok: true }, { ok: true, idempotent: true, id: 'CD1-1' }), true);
    assert.equal(Review.isPersistedResponse({ ok: false }, { ok: false, error: 'booking_store_unavailable' }), false);
  });
});

describe('single submit surface', () => {
  for (const page of BOOKING_PAGES) {
    it(`${page} has exactly one submit booking button on Step 5 and none on Step 6`, () => {
      const html = read(page);
      const counts = countSubmitButtons(html);
      assert.equal(counts.total, 1, `${page} submit button count`);
      assert.equal(counts.onclick, 1, `${page} submit onclick count`);
      assert.equal(counts.inStep5, true, `${page} Step 5 must be the submit surface`);
      assert.equal(counts.inStep6, false, `${page} Step 6 must not submit`);
      assert.match(html, /id="bpt5"[\s\S]*?Review &amp; Submit/);
      assert.match(html, /id="bpt6"[\s\S]*?Request Sent/);
      assert.doesNotMatch(html, /onclick="goToConfirmFromTerms\(\)"/);
      assert.match(html, /bk-success-step/);
    });
  }
});

describe('payment preference metadata', () => {
  it('exposes pay online later, card at service, and cash at service', () => {
    assert.deepEqual(Review.PREFERENCE_VALUES.slice().sort(), [
      'card_onsite',
      'cash_onsite',
      'online_after_service',
    ]);
    assert.equal(Review.preferenceLabel('online_after_service'), 'Pay online later');
    assert.equal(Review.preferenceLabel('card_onsite'), 'Card at service');
    assert.equal(Review.preferenceLabel('cash_onsite'), 'Cash at service');
  });

  it('runtime never creates Stripe, ledger, or receipt objects', () => {
    assert.doesNotMatch(runtimeSrc, /create-setup-intent|\/v1\/(payment|setup)_intents|js\.stripe\.com/);
    assert.doesNotMatch(runtimeSrc, /confirmSetupIntent/);
  });
});

describe('submit-booking preference persistence without Stripe', () => {
  const submitBooking = require('../netlify/functions/submit-booking');
  const { isVisibleSubmittedBooking } = require('../netlify/lib/booking-visibility');

  function createMemoryStore() {
    const data = new Map();
    return {
      data,
      async get(key) {
        const value = data.get(key);
        return value == null ? null : structuredClone(value);
      },
      async setJSON(key, value) {
        data.set(key, structuredClone(value));
        return { modified: true };
      },
      async list() {
        return { blobs: [...data.keys()].map((key) => ({ key })) };
      },
    };
  }

  function requestPayload(overrides = {}) {
    return {
      firstName: 'Pref',
      lastName: 'Customer',
      phone: '2015550177',
      email: 'pref@example.com',
      address: '1 Main St, Newark, NJ',
      zipCode: '07102',
      preferredDate: '2099-06-16',
      preferredTime: '10:00 AM',
      preferredArrivalWindow: 'anytime',
      scheduleFlexibility: 'exact',
      vehicle: '2024 Honda Civic',
      vehicleCategory: 'cars',
      vehicleTier: 'Small Car',
      package: 'Premium Detail',
      packageId: 'full',
      vehicles: [{
        vehicleId: 'vehicle-1',
        cat: 'cars',
        pkgId: 'full',
        pkgName: 'Premium Detail',
        tierKey: 'small',
        tierLabel: 'Small Car',
        vehicleLabel: '2024 Honda Civic',
        addons: [],
        addonTotal: 0,
        basePrice: 240,
        subtotal: 240,
      }],
      totalPrice: 240,
      travelFeeAmount: 0,
      zoneSurcharge: 0,
      paymentMethod: '',
      paymentMethodPreference: '',
      cardOnFileRequired: false,
      acceptedCardOnFilePolicy: false,
      acceptedCardOnFilePolicyAt: null,
      acceptedBookingPolicy: true,
      policyVersion: '2026-08-booking-request',
      ...overrides,
    };
  }

  async function post(body) {
    const response = await submitBooking.handler({
      httpMethod: 'POST',
      headers: { 'x-nf-client-connection-ip': '203.0.113.61' },
      body: JSON.stringify(body),
    });
    return { response, body: JSON.parse(response.body) };
  }

  const store = createMemoryStore();
  const originalFetch = globalThis.fetch;
  const env = {};
  const envKeys = [
    'DRAFT_TOKEN_SECRET', 'ADMIN_EMAIL', 'RESEND_API_KEY', 'TWILIO_SEND_ENABLED',
    'CONTEXT', 'NETLIFY_DEV', 'STRIPE_SECRET_KEY',
  ];
  const externalCalls = [];

  before(() => {
    for (const key of envKeys) env[key] = process.env[key];
    process.env.DRAFT_TOKEN_SECRET = 'n'.repeat(40);
    process.env.ADMIN_EMAIL = '';
    process.env.RESEND_API_KEY = '';
    process.env.TWILIO_SEND_ENABLED = 'false';
    process.env.CONTEXT = 'deploy-preview';
    delete process.env.NETLIFY_DEV;
    delete process.env.STRIPE_SECRET_KEY;
    submitBooking.__test.setBlobsStoreOverride(async () => store);
    globalThis.fetch = async (url) => {
      externalCalls.push(String(url));
      throw new Error('unexpected_external_call');
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
    submitBooking.__test.setBlobsStoreOverride(null);
    for (const key of envKeys) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
  });

  for (const pref of ['online_after_service', 'card_onsite', 'cash_onsite']) {
    it(`persists ${pref} without Stripe, ledger, or a charge`, async () => {
      const draft = await post(requestPayload({
        isDraft: true,
        phone: pref === 'card_onsite' ? '2015550101' : pref === 'cash_onsite' ? '2015550102' : '2015550103',
        paymentMethodPreference: pref,
      }));
      assert.equal(draft.response.statusCode, 200, draft.body.error);
      const final = await post(requestPayload({
        phone: pref === 'card_onsite' ? '2015550101' : pref === 'cash_onsite' ? '2015550102' : '2015550103',
        draftBookingId: draft.body.id,
        draftSaveToken: draft.body.draftSaveToken,
        paymentMethodPreference: pref,
      }));
      assert.equal(final.response.statusCode, 200, final.body.error);
      assert.equal(final.body.bookingCreated, true);
      const saved = await store.get(final.body.id);
      assert.equal(saved.paymentMethodPreference, pref);
      assert.equal(saved.paymentStatus, 'no_payment_required_yet');
      assert.equal(saved.cardOnFileRequired, false);
      assert.equal(saved.cardOnFileStatus, 'not_collected');
      assert.equal('setupIntentId' in saved, false);
      assert.equal('paymentIntentId' in saved, false);
      assert.equal('stripeCustomerId' in saved, false);
      assert.equal('ledger' in saved, false);
      assert.equal('receipt' in saved, false);
      assert.equal(externalCalls.some((url) => url.includes('stripe.com')), false);
      const { projectBookingForCustomer } = require('../netlify/lib/ops-schema');
      assert.equal(projectBookingForCustomer(saved).paymentMethodPreference, pref);
    });
  }

  it('double finalize of the same draft is idempotent (no duplicate booking)', async () => {
    const [saved] = [...store.data.values()].filter((b) => b.isDraft === false);
    assert.ok(saved);
    const replay = await post(requestPayload({
      phone: saved.phone,
      draftBookingId: saved.id,
      draftSaveToken: 'replay-does-not-need-a-fresh-token-on-finalized',
      paymentMethodPreference: saved.paymentMethodPreference,
    }));
    assert.equal(replay.response.statusCode, 200);
    assert.equal(replay.body.idempotent, true);
    assert.equal(replay.body.id, saved.id);
    const finals = [...store.data.values()].filter((b) => b.isDraft === false && b.phone === saved.phone);
    assert.equal(finals.length, 1);
  });
});

describe('success rendering does not emit notifications', () => {
  it('review runtime has no SMS/email/outbox/notification side effects', () => {
    assert.doesNotMatch(runtimeSrc, /twilio|resend\.com|sendNotifications|smsOutbox|notifyAdmin/i);
    assert.doesNotMatch(runtimeSrc, /BACKEND_BASE\+'\/submit-booking'|create-setup-intent/);
  });
});

describe('saved-card verify copy remains intact', () => {
  it('submit-booking still defines CARD_ON_FILE_VERIFY_MSG', () => {
    const submit = read('netlify/functions/submit-booking.js');
    assert.match(submit, /const CARD_ON_FILE_VERIFY_MSG/);
    assert.match(submit, /Your card is still being verified/);
  });
});
