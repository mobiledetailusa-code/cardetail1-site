'use strict';

/**
 * Google Ads "Booking submitted" conversion — fire only after durable finalize
 * with backend approvedFinalAmount. Cash and Card share the same send_to.
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
    id: 'CD1-ADS-1',
    approvedFinalAmount: 250,
    currency: 'USD',
  }, overrides);
}

describe('Google Ads booking conversion send_to identity', () => {
  it('L) Page View and Booking submitted labels remain different', () => {
    const rev = read('assets/revenue-events.js');
    assert.match(rev, new RegExp(PAGE_VIEW_SEND_TO.replace(/\//g, '\\/')));
    assert.match(rev, new RegExp(BOOKING_SEND_TO.replace(/\//g, '\\/')));
    assert.notEqual(PAGE_VIEW_SEND_TO, BOOKING_SEND_TO);
    assert.match(rev, /CD1_GOOGLE_ADS_PAGE_VIEW_SEND_TO/);
    assert.match(rev, /CD1_GOOGLE_ADS_BOOKING_SEND_TO|CD1_GOOGLE_ADS_PURCHASE_SEND_TO/);
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

  it('A) Backend approvedFinalAmount fires the conversion', () => {
    const { ctx, conversions } = harness;
    ctx.Cardetail1CheckoutAnalytics.onBookingSubmitted(successEvidence({
      id: 'CD1-AUTH-1',
      approvedFinalAmount: 250,
    }));
    const booking = conversions.filter((c) => c.send_to === BOOKING_SEND_TO);
    assert.equal(booking.length, 1);
    assert.equal(booking[0].value, 250);
    assert.equal(booking[0].currency, 'USD');
    assert.equal(booking[0].transaction_id, 'CD1-AUTH-1');
  });

  it('B) Missing backend approvedFinalAmount fires zero even with client totals', () => {
    const { ctx, conversions } = harness;
    ctx.Cardetail1Revenue.trackGoogleAdsBookingConversion({
      ok: true,
      bookingCreated: true,
      id: 'CD1-CLIENT-TOTAL',
      totalPrice: 999,
      value: 999,
      // no approvedFinalAmount
    });
    ctx.Cardetail1CheckoutAnalytics.onBookingSubmitted({
      ok: true,
      bookingCreated: true,
      id: 'CD1-CLIENT-TOTAL-2',
      // client-looking fields must not unlock Ads
      value: 888,
    });
    assert.equal(conversions.filter((c) => c.send_to === BOOKING_SEND_TO).length, 0);
  });

  it('C) Missing ok fires zero conversions', () => {
    const { ctx, conversions } = harness;
    ctx.Cardetail1Revenue.trackGoogleAdsBookingConversion({
      bookingCreated: true,
      id: 'CD1-NOOK',
      approvedFinalAmount: 250,
    });
    assert.equal(conversions.filter((c) => c.send_to === BOOKING_SEND_TO).length, 0);
  });

  it('D) ok:false fires zero conversions', () => {
    const { ctx, conversions } = harness;
    ctx.Cardetail1Revenue.trackGoogleAdsBookingConversion({
      ok: false,
      bookingCreated: true,
      id: 'CD1-OKFALSE',
      approvedFinalAmount: 250,
    });
    assert.equal(conversions.filter((c) => c.send_to === BOOKING_SEND_TO).length, 0);
  });

  it('E) bookingCreated:false fires zero conversions', () => {
    const { ctx, conversions } = harness;
    ctx.Cardetail1CheckoutAnalytics.onBookingSubmitted({
      ok: true,
      bookingCreated: false,
      id: 'CD1-NOCREATE',
      approvedFinalAmount: 250,
    });
    assert.equal(conversions.filter((c) => c.send_to === BOOKING_SEND_TO).length, 0);
  });

  it('F) Missing durable ID fires zero conversions', () => {
    const { ctx, conversions } = harness;
    ctx.Cardetail1CheckoutAnalytics.onBookingSubmitted({
      ok: true,
      bookingCreated: true,
      approvedFinalAmount: 250,
    });
    assert.equal(conversions.filter((c) => c.send_to === BOOKING_SEND_TO).length, 0);
  });

  it('G+H) gtag throw does not break checkout; later retry can emit', () => {
    const { ctx, conversions } = harness;
    let threw = false;
    const broken = function () {
      threw = true;
      throw new Error('network_blocked');
    };
    ctx.gtag = broken;
    assert.doesNotThrow(() => {
      const r = ctx.Cardetail1Revenue.trackGoogleAdsBookingConversion(successEvidence({
        id: 'CD1-RETRY-1',
        approvedFinalAmount: 250,
      }));
      assert.equal(r, false);
    });
    assert.equal(threw, true);
    assert.equal(conversions.filter((c) => c.send_to === BOOKING_SEND_TO).length, 0);

    // Restore gtag — same booking id may emit on later retry.
    threw = false;
    ctx.gtag = function () {
      const args = Array.prototype.slice.call(arguments);
      if (args[0] === 'event' && args[1] === 'conversion') {
        conversions.push(Object.assign({ _event: 'conversion' }, args[2] || {}));
      }
    };
    const ok = ctx.Cardetail1Revenue.trackGoogleAdsBookingConversion(successEvidence({
      id: 'CD1-RETRY-1',
      approvedFinalAmount: 250,
    }));
    assert.equal(ok, true);
    const booking = conversions.filter((c) => c.transaction_id === 'CD1-RETRY-1');
    assert.equal(booking.length, 1);
    assert.equal(booking[0].value, 250);
  });

  it('I) After successful gtag queueing, same booking ID does not emit again', () => {
    const { ctx, conversions } = harness;
    const evidence = successEvidence({ id: 'CD1-ONCE-1', approvedFinalAmount: 250 });
    assert.equal(ctx.Cardetail1Revenue.trackGoogleAdsBookingConversion(evidence), true);
    assert.equal(ctx.Cardetail1Revenue.trackGoogleAdsBookingConversion(evidence), false);
    assert.equal(ctx.Cardetail1CheckoutAnalytics.onBookingSubmitted(Object.assign({}, evidence, { idempotent: true })) || true, true);
    const booking = conversions.filter((c) => c.transaction_id === 'CD1-ONCE-1');
    assert.equal(booking.length, 1);
  });

  it('1) Cash persisted booking fires exactly one conversion', () => {
    const { ctx, conversions } = harness;
    ctx.Cardetail1CheckoutAnalytics.onBookingSubmitted(successEvidence({
      id: 'CD1-CASH-1',
      approvedFinalAmount: 250,
    }));
    const booking = conversions.filter((c) => c.send_to === BOOKING_SEND_TO);
    assert.equal(booking.length, 1);
    assert.equal(booking[0].transaction_id, 'CD1-CASH-1');
    assert.equal(booking[0].value, 250);
  });

  it('2) Card persisted booking fires exactly one conversion', () => {
    const { ctx, conversions } = harness;
    ctx.Cardetail1CheckoutAnalytics.onBookingSubmitted(successEvidence({
      id: 'CD1-CARD-1',
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
      id: 'CD1-DRAFT-1',
      approvedFinalAmount: 250,
    });
    assert.equal(conversions.filter((c) => c.send_to === BOOKING_SEND_TO).length, 0);
  });

  it('value fallbacks (opts.value / totalPrice) never unlock conversion', () => {
    const { ctx, conversions } = harness;
    assert.equal(ctx.Cardetail1Revenue.trackGoogleAdsBookingConversion({
      ok: true,
      bookingCreated: true,
      id: 'CD1-VALFB',
      value: 250,
      totalPrice: 250,
    }), false);
    assert.equal(conversions.filter((c) => c.send_to === BOOKING_SEND_TO).length, 0);
  });

  it('page load alone does not fire booking conversion', () => {
    const { ctx, conversions } = harness;
    ctx.Cardetail1Revenue.initAdapters();
    assert.equal(conversions.filter((c) => c.send_to === BOOKING_SEND_TO).length, 0);
    assert.ok(conversions.filter((c) => c.send_to === PAGE_VIEW_SEND_TO).length >= 1);
  });

  it('conversion payload never includes PII fields', () => {
    const { ctx, conversions } = harness;
    ctx.Cardetail1CheckoutAnalytics.onBookingSubmitted(successEvidence({
      id: 'CD1-PII-1',
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
    assert.deepEqual(Object.keys(payload).sort(), ['_event', 'currency', 'send_to', 'transaction_id', 'value'].sort());
  });
});

describe('canonical persist path wires Ads evidence', () => {
  it('markPersisted uses only data.approvedFinalAmount for Ads value', () => {
    const runtime = read('assets/booking-review-runtime.js');
    assert.match(runtime, /data\.approvedFinalAmount/);
    assert.match(runtime, /approvedFinalAmount:\s*approvedAmount/);
    assert.match(runtime, /transaction_id:\s*data\.id\s*\|\|\s*payload\.id/);
    // Must not fall back to client payload totals for Ads.
    assert.doesNotMatch(
      runtime,
      /approvedAmount[\s\S]{0,200}payload\.totalPrice/
    );
    assert.doesNotMatch(
      runtime,
      /approvedAmount[\s\S]{0,200}data\.totalPrice/
    );
  });

  it('K) Idempotent finalize returns server-stored approvedFinalAmount', () => {
    const src = read('netlify/functions/submit-booking.js');
    assert.match(src, /idempotent:\s*true[\s\S]{0,600}approvedFinalAmount:/);
    assert.match(src, /storedApproved/);
    assert.match(src, /booking\.approvedFinalAmount \?\? existing\.approvedFinalAmount/);
  });

  it('tracker requires opts.ok === true and bookingCreated === true', () => {
    const rev = read('assets/revenue-events.js');
    assert.match(rev, /opts\.ok !== true/);
    assert.match(rev, /opts\.bookingCreated !== true/);
    assert.match(rev, /adsBookingTxMark\(txId\)/);
    assert.match(rev, /__cd1GoogleAdsBookingTxInFlight/);
  });
});

describe('Ceramic coating Google Ads conversion', () => {
  let harness;

  beforeEach(() => {
    if (harness && harness.cleanup) harness.cleanup();
    harness = loadAnalyticsHarness();
  });

  afterEach(() => {
    if (harness && harness.cleanup) harness.cleanup();
  });

  it('does not require paymentSucceeded for a persisted ceramic reservation', () => {
    const rev = read('assets/revenue-events.js');
    assert.doesNotMatch(rev, /serviceFamily === 'ceramic_coating' && opts\.paymentSucceeded !== true/);
  });

  it('fires once for ceramic cash at service using the server total', () => {
    const { ctx, conversions } = harness;
    assert.equal(ctx.Cardetail1CheckoutAnalytics.onBookingSubmitted(successEvidence({
      id: 'CD1-CER-CASH',
      approvedFinalAmount: 650,
      amountPaid: 0,
      serviceFamily: 'ceramic_coating',
      paymentSucceeded: false,
    })), undefined);
    const booking = conversions.filter((c) => c.send_to === BOOKING_SEND_TO);
    assert.equal(booking.length, 1);
    assert.equal(booking[0].transaction_id, 'CD1-CER-CASH');
    assert.equal(booking[0].value, 650);
    assert.equal(booking[0].currency, 'USD');
    assert.equal(booking[0].send_to, BOOKING_SEND_TO);
  });

  it('fires once for ceramic card at service without a captured payment', () => {
    const { ctx, conversions } = harness;
    assert.equal(ctx.Cardetail1Revenue.trackGoogleAdsBookingConversion(successEvidence({
      id: 'CD1-CER-CARD',
      approvedFinalAmount: 890,
      amountPaid: 0,
      serviceFamily: 'ceramic_coating',
    })), true);
    const booking = conversions.filter((c) => c.transaction_id === 'CD1-CER-CARD');
    assert.equal(booking.length, 1);
    assert.equal(booking[0].value, 890);
    assert.equal(booking[0].currency, 'USD');
  });

  it('does not fire for a ceramic draft, send failure, or occupancy failure', () => {
    const { ctx, conversions } = harness;
    assert.equal(ctx.Cardetail1Revenue.trackGoogleAdsBookingConversion(successEvidence({
      id: 'CD1-CER-DRAFT',
      approvedFinalAmount: 650,
      serviceFamily: 'ceramic_coating',
      isDraft: true,
    })), false);
    assert.equal(ctx.Cardetail1Revenue.trackGoogleAdsBookingConversion(successEvidence({
      id: 'CD1-CER-FAIL',
      approvedFinalAmount: 650,
      serviceFamily: 'ceramic_coating',
      ok: false,
    })), false);
    assert.equal(ctx.Cardetail1Revenue.trackGoogleAdsBookingConversion(successEvidence({
      id: 'CD1-CER-OCC',
      approvedFinalAmount: 650,
      serviceFamily: 'ceramic_coating',
      bookingCreated: false,
    })), false);
    assert.equal(conversions.filter((c) => c.send_to === BOOKING_SEND_TO).length, 0);
  });

  it('does not fire when the confirmation opens without persist evidence', () => {
    const { ctx, conversions } = harness;
    ctx.Cardetail1Revenue.initAdapters();
    assert.equal(ctx.Cardetail1Revenue.trackGoogleAdsBookingConversion({
      serviceFamily: 'ceramic_coating',
      paymentSucceeded: false,
    }), false);
    assert.equal(conversions.filter((c) => c.send_to === BOOKING_SEND_TO).length, 0);
  });

  it('retry, double submit, reopening confirmation, and later payment emit once', () => {
    const { ctx, conversions } = harness;
    const evidence = successEvidence({
      id: 'CD1-CER-ONCE',
      approvedFinalAmount: 1075,
      amountPaid: 0,
      serviceFamily: 'ceramic_coating',
      paymentSucceeded: false,
    });
    assert.equal(ctx.Cardetail1Revenue.trackGoogleAdsBookingConversion(evidence), true);
    assert.equal(ctx.Cardetail1Revenue.trackGoogleAdsBookingConversion(evidence), false);
    ctx.Cardetail1CheckoutAnalytics.onBookingSubmitted(Object.assign({}, evidence, { idempotent: true }));
    assert.equal(ctx.Cardetail1Revenue.trackGoogleAdsBookingConversion(Object.assign({}, evidence, {
      paymentSucceeded: true,
      amountPaid: 1075,
    })), false);
    assert.equal(conversions.filter((c) => c.transaction_id === 'CD1-CER-ONCE').length, 1);
    assert.equal(conversions.filter((c) => c.transaction_id === 'CD1-CER-ONCE')[0].value, 1075);

    const stored = ctx.localStorage.getItem('cd1_ads_booking_tx_ids');
    assert.match(stored, /CD1-CER-ONCE/);
    const later = loadAnalyticsHarness();
    later.ctx.localStorage.setItem('cd1_ads_booking_tx_ids', stored);
    assert.equal(later.ctx.Cardetail1Revenue.trackGoogleAdsBookingConversion(Object.assign({}, evidence, {
      paymentSucceeded: true,
      amountPaid: 1075,
    })), false);
    assert.equal(later.conversions.filter((c) => c.send_to === BOOKING_SEND_TO).length, 0);
    later.cleanup();
  });

  it('does not send production Ads events from preview or local hosts', () => {
    const { ctx, conversions } = harness;
    ctx.location.href = 'https://deploy-preview-346--cardetail1.netlify.app/';
    ctx.location.hostname = 'deploy-preview-346--cardetail1.netlify.app';
    assert.equal(ctx.Cardetail1Revenue.trackGoogleAdsBookingConversion(successEvidence({
      id: 'CD1-PREVIEW',
      approvedFinalAmount: 250,
    })), false);
    ctx.location.href = 'http://127.0.0.1:8765/';
    ctx.location.hostname = '127.0.0.1';
    assert.equal(ctx.Cardetail1Revenue.trackGoogleAdsBookingConversion(successEvidence({
      id: 'CD1-LOCAL',
      approvedFinalAmount: 250,
    })), false);
    assert.equal(conversions.filter((c) => c.send_to === BOOKING_SEND_TO).length, 0);
    assert.equal(conversions.filter((c) => c.send_to === PAGE_VIEW_SEND_TO).length, 0);

    ctx.location.href = 'https://www.cardetail1.com/';
    ctx.location.hostname = 'www.cardetail1.com';
    assert.equal(ctx.Cardetail1Revenue.trackGoogleAdsBookingConversion(successEvidence({
      id: 'CD1-WWW',
      approvedFinalAmount: 250,
    })), true);
    assert.equal(conversions.filter((c) => c.transaction_id === 'CD1-WWW').length, 1);
  });

  it('leaves non-ceramic cash conversion unchanged', () => {
    const { ctx, conversions } = harness;
    assert.equal(ctx.Cardetail1Revenue.trackGoogleAdsBookingConversion(successEvidence({
      id: 'CD1-CASH-STILL',
      approvedFinalAmount: 125,
    })), true);
    assert.equal(conversions.filter((c) => c.transaction_id === 'CD1-CASH-STILL')[0].value, 125);
  });
});
