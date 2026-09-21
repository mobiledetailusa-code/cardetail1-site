'use strict';

/**
 * Google Ads "Booking submitted" conversion — fire only after durable finalize.
 * Cash and Card share the same send_to; Page view label stays separate.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const BOOKING_SEND_TO = 'AW-11321647982/yrODCJGL998YEO7GypYq';
const PAGE_VIEW_SEND_TO = 'AW-11321647982/r6SRCJeL998YEO7GypYq';

function loadAnalyticsHarness() {
  const conversions = [];
  const sessionStore = Object.create(null);
  const localStore = Object.create(null);
  const pendingTimers = [];
  const ctx = {
    console: { log() {}, warn() {}, info() {}, error() {} },
    Date,
    Math,
    JSON,
    Number,
    Object,
    Array,
    String,
    Boolean,
    Error,
    // Keep timers real enough for code paths, but flush/clear after each assertion.
    setTimeout(fn, ms) {
      const id = { cancelled: false };
      pendingTimers.push(id);
      const t = setTimeout(() => {
        if (!id.cancelled) fn();
      }, Math.min(Number(ms) || 0, 5));
      id.clear = () => clearTimeout(t);
      return id;
    },
    clearTimeout(id) {
      if (id && typeof id === 'object') {
        id.cancelled = true;
        if (id.clear) id.clear();
      }
    },
    fetch() {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get() { return null; } },
        json: async () => ({ ok: true }),
      });
    },
    document: {
      readyState: 'complete',
      head: { appendChild() {} },
      getElementById() { return null; },
      createElement() {
        return { id: '', async: false, src: '', setAttribute() {} };
      },
      addEventListener() {},
    },
    location: { pathname: '/index.html', search: '', href: 'https://cardetail1.com/' },
    sessionStorage: {
      getItem(k) { return Object.prototype.hasOwnProperty.call(sessionStore, k) ? sessionStore[k] : null; },
      setItem(k, v) { sessionStore[k] = String(v); },
      removeItem(k) { delete sessionStore[k]; },
    },
    localStorage: {
      getItem(k) { return Object.prototype.hasOwnProperty.call(localStore, k) ? localStore[k] : null; },
      setItem(k, v) { localStore[k] = String(v); },
      removeItem(k) { delete localStore[k]; },
    },
    dataLayer: [],
    Cardetail1Consent: {
      getConsent() { return { analytics: true, marketing: true }; },
      onChange() {},
    },
    innerWidth: 1024,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.gtag = function () {
    const args = Array.prototype.slice.call(arguments);
    if (args[0] === 'event' && args[1] === 'conversion') {
      conversions.push(Object.assign({ _event: 'conversion' }, args[2] || {}));
    }
  };
  vm.createContext(ctx);
  vm.runInContext(read('assets/revenue-events.js'), ctx);
  vm.runInContext(read('assets/checkout-analytics.js'), ctx);
  return {
    ctx,
    conversions,
    cleanup() {
      pendingTimers.forEach((id) => {
        id.cancelled = true;
        if (id.clear) id.clear();
      });
      pendingTimers.length = 0;
    },
  };
}

function successEvidence(overrides = {}) {
  return Object.assign({
    ok: true,
    bookingCreated: true,
    bookingId: 'CD1-ADS-1',
    id: 'CD1-ADS-1',
    approvedFinalAmount: 250,
    currency: 'USD',
  }, overrides);
}

describe('Google Ads booking conversion send_to identity', () => {
  it('12) Page view conversion remains separate from booking conversion', () => {
    const rev = read('assets/revenue-events.js');
    assert.match(rev, new RegExp(PAGE_VIEW_SEND_TO.replace(/\//g, '\\/')));
    assert.match(rev, new RegExp(BOOKING_SEND_TO.replace(/\//g, '\\/')));
    assert.notEqual(PAGE_VIEW_SEND_TO, BOOKING_SEND_TO);
    assert.match(rev, /CD1_GOOGLE_ADS_PAGE_VIEW_SEND_TO/);
    assert.match(rev, /CD1_GOOGLE_ADS_BOOKING_SEND_TO|CD1_GOOGLE_ADS_PURCHASE_SEND_TO/);
    // Booking tracker must refuse to reuse the page-view send_to override.
    assert.match(rev, /sendTo === global\.CD1_GOOGLE_ADS_PAGE_VIEW_SEND_TO/);
  });

  it('offline Google Ads export adapter stays disabled', () => {
    const src = read('netlify/lib/google-ads-export.js');
    assert.match(src, /google_ads_export_disabled|disabled until explicitly enabled/i);
    assert.doesNotMatch(src, /GOOGLE_ADS_EXPORT_ENABLED\s*=\s*true/);
  });
});

describe('Google Ads booking conversion fire gates', () => {
  let harness;

  beforeEach(() => {
    if (harness && harness.cleanup) harness.cleanup();
    harness = loadAnalyticsHarness();
  });

  afterEach(() => {
    if (harness && harness.cleanup) harness.cleanup();
  });

  it('1) Cash persisted booking fires exactly one conversion', () => {
    const { ctx, conversions } = harness;
    const ok = ctx.Cardetail1CheckoutAnalytics.onBookingSubmitted(successEvidence({
      bookingId: 'CD1-CASH-1',
      approvedFinalAmount: 250,
    }));
    void ok;
    const booking = conversions.filter((c) => c.send_to === BOOKING_SEND_TO);
    assert.equal(booking.length, 1);
    assert.equal(booking[0].transaction_id, 'CD1-CASH-1');
    assert.equal(booking[0].value, 250);
    assert.equal(booking[0].currency, 'USD');
  });

  it('2) Card persisted booking fires exactly one conversion', () => {
    const { ctx, conversions } = harness;
    ctx.Cardetail1CheckoutAnalytics.onBookingSubmitted(successEvidence({
      bookingId: 'CD1-CARD-1',
      approvedFinalAmount: 310,
    }));
    const booking = conversions.filter((c) => c.send_to === BOOKING_SEND_TO);
    assert.equal(booking.length, 1);
    assert.equal(booking[0].transaction_id, 'CD1-CARD-1');
    assert.equal(booking[0].value, 310);
  });

  it('3) Draft creation fires zero conversions', () => {
    const { ctx, conversions } = harness;
    ctx.Cardetail1Revenue.trackGoogleAdsBookingConversion({
      ok: true,
      bookingCreated: true,
      isDraft: true,
      bookingId: 'CD1-DRAFT-1',
      approvedFinalAmount: 250,
    });
    ctx.Cardetail1CheckoutAnalytics.onBookingSubmitted({
      ok: true,
      bookingCreated: true,
      isDraft: true,
      bookingId: 'CD1-DRAFT-1',
      approvedFinalAmount: 250,
    });
    assert.equal(conversions.filter((c) => c.send_to === BOOKING_SEND_TO).length, 0);
  });

  it('4) Card setup without finalize fires zero conversions', () => {
    const { ctx, conversions } = harness;
    // payment_info_saved / SetupIntent success alone — no onBookingSubmitted evidence
    ctx.Cardetail1CheckoutAnalytics.onPaymentInfoSaved();
    ctx.Cardetail1Revenue.trackGoogleAdsBookingConversion({
      ok: true,
      bookingCreated: false,
      bookingId: 'CD1-SETUP-ONLY',
      approvedFinalAmount: 250,
    });
    assert.equal(conversions.filter((c) => c.send_to === BOOKING_SEND_TO).length, 0);
  });

  it('5) price_mismatch fires zero conversions', () => {
    const { ctx, conversions } = harness;
    ctx.Cardetail1Revenue.trackGoogleAdsBookingConversion({
      ok: false,
      bookingCreated: false,
      bookingId: null,
      error: 'price_mismatch',
      approvedFinalAmount: 250,
    });
    assert.equal(conversions.filter((c) => c.send_to === BOOKING_SEND_TO).length, 0);
  });

  it('6) HTTP 400/409/503/504 fires zero conversions', () => {
    const { ctx, conversions } = harness;
    for (const status of [400, 409, 503, 504]) {
      ctx.Cardetail1Revenue.trackGoogleAdsBookingConversion({
        ok: false,
        bookingCreated: false,
        httpStatus: status,
        bookingId: 'CD1-HTTP-' + status,
        approvedFinalAmount: 250,
      });
    }
    assert.equal(conversions.filter((c) => c.send_to === BOOKING_SEND_TO).length, 0);
  });

  it('7) bookingCreated:false fires zero conversions', () => {
    const { ctx, conversions } = harness;
    ctx.Cardetail1CheckoutAnalytics.onBookingSubmitted({
      ok: true,
      bookingCreated: false,
      bookingId: 'CD1-NOCREATE',
      approvedFinalAmount: 250,
    });
    assert.equal(conversions.filter((c) => c.send_to === BOOKING_SEND_TO).length, 0);
  });

  it('8) Missing booking ID fires zero conversions', () => {
    const { ctx, conversions } = harness;
    ctx.Cardetail1CheckoutAnalytics.onBookingSubmitted({
      ok: true,
      bookingCreated: true,
      approvedFinalAmount: 250,
    });
    assert.equal(conversions.filter((c) => c.send_to === BOOKING_SEND_TO).length, 0);
  });

  it('9) Idempotent retry uses same transaction_id and does not create a different conversion identity', () => {
    const { ctx, conversions } = harness;
    const evidence = successEvidence({
      bookingId: 'CD1-IDEMP-1',
      approvedFinalAmount: 250,
    });
    ctx.Cardetail1CheckoutAnalytics.onBookingSubmitted(evidence);
    ctx.Cardetail1CheckoutAnalytics.onBookingSubmitted(Object.assign({}, evidence, { idempotent: true }));
    ctx.Cardetail1Revenue.trackGoogleAdsBookingConversion(Object.assign({}, evidence, {
      idempotent: true,
      transaction_id: 'CD1-IDEMP-1',
    }));
    const booking = conversions.filter((c) => c.send_to === BOOKING_SEND_TO);
    assert.equal(booking.length, 1);
    assert.equal(booking[0].transaction_id, 'CD1-IDEMP-1');
  });

  it('10) Conversion value equals authoritative approvedFinalAmount', () => {
    const { ctx, conversions } = harness;
    ctx.Cardetail1CheckoutAnalytics.onBookingSubmitted(successEvidence({
      bookingId: 'CD1-VAL-1',
      approvedFinalAmount: 396.5,
      // Client estimate must not win over approvedFinalAmount
      value: 1,
    }));
    const booking = conversions.filter((c) => c.send_to === BOOKING_SEND_TO);
    assert.equal(booking.length, 1);
    assert.equal(booking[0].value, 396.5);
    assert.equal(booking[0].currency, 'USD');
  });

  it('11) Google tracking failure does not affect booking success', () => {
    const { ctx, conversions } = harness;
    let threw = false;
    ctx.gtag = function () {
      threw = true;
      throw new Error('network_blocked');
    };
    assert.doesNotThrow(() => {
      ctx.Cardetail1CheckoutAnalytics.onBookingSubmitted(successEvidence({
        bookingId: 'CD1-BLOCK-1',
        approvedFinalAmount: 250,
      }));
    });
    assert.equal(threw, true);
    // Conversion attempt recorded as blocked; no successful conversion payload
    assert.equal(conversions.filter((c) => c.send_to === BOOKING_SEND_TO).length, 0);
    // Tracker still returns without throwing
    assert.equal(
      ctx.Cardetail1Revenue.trackGoogleAdsBookingConversion(successEvidence({
        bookingId: 'CD1-BLOCK-2',
        approvedFinalAmount: 250,
      })),
      false
    );
  });

  it('page load alone does not fire booking conversion (only Page view path)', () => {
    const { ctx, conversions } = harness;
    ctx.Cardetail1Revenue.initAdapters();
    const booking = conversions.filter((c) => c.send_to === BOOKING_SEND_TO);
    const pageView = conversions.filter((c) => c.send_to === PAGE_VIEW_SEND_TO);
    assert.equal(booking.length, 0);
    assert.ok(pageView.length >= 1);
  });

  it('missing authoritative value fires zero conversions', () => {
    const { ctx, conversions } = harness;
    ctx.Cardetail1CheckoutAnalytics.onBookingSubmitted({
      ok: true,
      bookingCreated: true,
      bookingId: 'CD1-NOVAL',
    });
    assert.equal(conversions.filter((c) => c.send_to === BOOKING_SEND_TO).length, 0);
  });

  it('conversion payload never includes PII fields', () => {
    const { ctx, conversions } = harness;
    ctx.Cardetail1CheckoutAnalytics.onBookingSubmitted(successEvidence({
      bookingId: 'CD1-PII-1',
      approvedFinalAmount: 250,
      email: 'leak@example.com',
      phone: '2015550100',
      firstName: 'Leak',
      address: '1 Main',
      zipCode: '07102',
    }));
    const booking = conversions.filter((c) => c.send_to === BOOKING_SEND_TO);
    assert.equal(booking.length, 1);
    const payload = booking[0];
    assert.equal(payload.email, undefined);
    assert.equal(payload.phone, undefined);
    assert.equal(payload.firstName, undefined);
    assert.equal(payload.address, undefined);
    assert.equal(payload.zipCode, undefined);
    assert.deepEqual(Object.keys(payload).sort(), ['_event', 'currency', 'send_to', 'transaction_id', 'value'].sort());
  });
});

describe('canonical persist path wires Ads evidence', () => {
  it('booking-review-runtime markPersisted passes bookingId + approvedFinalAmount', () => {
    const runtime = read('assets/booking-review-runtime.js');
    assert.match(runtime, /onBookingSubmitted\(\{/);
    assert.match(runtime, /approvedFinalAmount:\s*approvedAmount/);
    assert.match(runtime, /bookingId:\s*data\.id\s*\|\|\s*payload\.id/);
    assert.match(runtime, /bookingCreated:\s*data\.bookingCreated === true\s*\|\|\s*!!data\.idempotent/);
  });

  it('idempotent finalize response includes approvedFinalAmount', () => {
    const src = read('netlify/functions/submit-booking.js');
    assert.match(src, /idempotent:\s*true[\s\S]{0,400}approvedFinalAmount:/);
  });
});
