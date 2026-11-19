'use strict';

/**
 * Google Ads lead conversions: phone taps and confirmed quote requests.
 * Paid visitors who call or ask for a quote were invisible to Google Ads.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const PAGE_VIEW_SEND_TO = 'AW-11321647982/r6SRCJeL998YEO7GypYq';
const BOOKING_SEND_TO = 'AW-11321647982/AAOmCJW9roAdEO7GypYq';
const CALL_SEND_TO = 'AW-11321647982/TestCallLabel1';
const QUOTE_SEND_TO = 'AW-11321647982/TestQuoteLabel1';

function harness({ host = 'cardetail1.com', labels = true, sessionStore, localStore, marketing = false } = {}) {
  const conversions = [];
  const calls = [];
  const consent = { analytics: marketing, marketing };
  let gtagHook = null;
  const tracked = [];
  const ss = sessionStore || Object.create(null);
  const ls = localStore || Object.create(null);
  const store = (o) => ({
    getItem: (k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null),
    setItem: (k, v) => { o[k] = String(v); },
    removeItem: (k) => { delete o[k]; },
  });
  let clickHandler = null;
  const ctx = {
    console: { log() {}, warn() {}, info() {}, error() {} },
    Date, Math, JSON, Number, Object, Array, String, Boolean, Error,
    setTimeout: () => 0,
    clearTimeout() {},
    fetch: (url, init) => {
      if (String(url).includes('track-event')) {
        try { tracked.push(JSON.parse(init.body)); } catch (e) { /* ignore */ }
      }
      return Promise.resolve({ ok: true, status: 200, headers: { get() { return null; } }, json: async () => ({ ok: true }) });
    },
    document: {
      readyState: 'complete',
      head: { appendChild() {} },
      getElementById() { return null; },
      createElement() { return { id: '', async: false, src: '', setAttribute() {} }; },
      addEventListener(type, fn, capture) { if (type === 'click' && capture === true) clickHandler = fn; },
    },
    location: { hostname: host, pathname: '/', search: '', href: 'https://' + host + '/' },
    navigator: { userAgent: 'Mozilla/5.0 (iPhone)' },
    sessionStorage: store(ss),
    localStorage: store(ls),
    dataLayer: [],
    Cardetail1Consent: { getConsent() { return Object.assign({}, consent); }, onChange() {} },
    innerWidth: 390,
  };
  if (labels) {
    ctx.CD1_GOOGLE_ADS_CALL_SEND_TO = CALL_SEND_TO;
    ctx.CD1_GOOGLE_ADS_QUOTE_SEND_TO = QUOTE_SEND_TO;
  }
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.gtag = function () {
    const a = Array.prototype.slice.call(arguments);
    if (gtagHook) gtagHook(a);
    calls.push(a);
    if (a[0] === 'event' && a[1] === 'conversion') conversions.push(a[2] || {});
  };
  vm.createContext(ctx);
  vm.runInContext(read('assets/revenue-events.js'), ctx);
  const leads = () => conversions.filter((c) => c.send_to !== PAGE_VIEW_SEND_TO);
  const tapPhone = (href = 'tel:+15513893986') => {
    const link = { getAttribute: () => href, closest: (sel) => (sel === 'a[href]' ? link : null) };
    clickHandler({ target: link });
  };
  const quoteEvents = () => Object.values(JSON.parse(ctx.sessionStorage.getItem('cd1_rev_delivery_v2') || '{"events":{}}').events)
    .filter((e) => e.eventName === 'quote_requested');
  const setGtagHook = (fn) => { gtagHook = fn; };
  return { ctx, leads, tapPhone, ss, ls, tracked, calls, consent, setGtagHook, quoteEvents };
}

const saved = (o = {}) => Object.assign({ ok: true, status: 'sent', submissionId: 'sub-1', source: 'vehicle_not_listed' }, o);

test('a phone tap sends the call conversion once per browser session', () => {
  const h = harness();
  h.tapPhone();
  const calls = h.leads().filter((c) => c.send_to === CALL_SEND_TO);
  assert.equal(calls.length, 1);
  // A second tap later in the same session, and a new page in the same session, add nothing.
  h.ctx.Cardetail1Revenue.trackGoogleAdsCallConversion();
  const next = harness({ sessionStore: h.ss });
  next.tapPhone();
  assert.equal(h.leads().length + next.leads().length, 1);
});

test('non-phone links do not send a call conversion', () => {
  const h = harness();
  h.tapPhone('sms:+15513893986');
  h.tapPhone('/book');
  assert.equal(h.leads().length, 0);
});

test('a saved quote request sends the quote conversion with its submission id', () => {
  for (const status of ['sent', 'saved_not_notified', 'saved_alert_unconfirmed']) {
    const h = harness();
    assert.equal(h.ctx.Cardetail1Revenue.trackQuoteRequested(saved({ status, submissionId: 'sub-' + status })), 'cookieless');
    const q = h.leads();
    assert.equal(q.length, 1);
    assert.equal(q[0].send_to, QUOTE_SEND_TO);
    assert.equal(q[0].transaction_id, 'sub-' + status);
  }
});

test('failed, unconfirmed or id-less quote requests send nothing', () => {
  const h = harness();
  const R = h.ctx.Cardetail1Revenue;
  assert.equal(R.trackQuoteRequested(saved({ ok: false })), false);
  assert.equal(R.trackQuoteRequested(saved({ status: 'error' })), false);
  assert.equal(R.trackQuoteRequested(saved({ status: undefined })), false);
  assert.equal(R.trackQuoteRequested(saved({ submissionId: '' })), false);
  assert.equal(R.trackQuoteRequested({}), false);
  assert.equal(h.leads().length, 0);
});

test('retrying the same quote form counts once, even after a reload', () => {
  const h = harness();
  h.ctx.Cardetail1Revenue.trackQuoteRequested(saved());
  h.ctx.Cardetail1Revenue.trackQuoteRequested(saved());
  const again = harness({ localStore: h.ls });
  again.ctx.Cardetail1Revenue.trackQuoteRequested(saved());
  assert.equal(h.leads().length + again.leads().length, 1);
});

test('nothing is sent off the production host', () => {
  for (const host of ['deploy-preview-1--cardetail1.netlify.app', 'localhost', 'cardetail1.netlify.app']) {
    const h = harness({ host });
    h.tapPhone();
    h.ctx.Cardetail1Revenue.trackQuoteRequested(saved());
    assert.equal(h.leads().length, 0, host);
  }
});

test('the built-in labels are the "Website phone tap" and "Quote request (website)" actions', () => {
  const h = harness({ labels: false });
  h.tapPhone();
  h.ctx.Cardetail1Revenue.trackQuoteRequested(saved());
  assert.deepEqual(h.leads().map((c) => c.send_to), [
    'AW-11321647982/q7pICLzVtrsdEO7GypYq',
    'AW-11321647982/P6WWCLnVtrsdEO7GypYq',
  ]);
});

test('booking and page-view labels can never be reused as lead labels', () => {
  for (const bad of [PAGE_VIEW_SEND_TO, BOOKING_SEND_TO, 'not-a-label', 'AW-1/bad label']) {
    const h = harness({ labels: false });
    h.ctx.CD1_GOOGLE_ADS_CALL_SEND_TO = bad;
    h.ctx.CD1_GOOGLE_ADS_QUOTE_SEND_TO = bad;
    h.tapPhone();
    h.ctx.Cardetail1Revenue.trackQuoteRequested(saved());
    assert.equal(h.leads().length, 0, bad);
  }
});

test('both homepage quote forms report only after the server saved the request', () => {
  const idx = read('index.html');
  for (const src of ['commercial_specialty', 'vehicle_not_listed']) {
    const at = idx.indexOf("source:'" + src + "'");
    assert.ok(at > 0, src);
    const before = idx.slice(Math.max(0, at - 700), at);
    assert.match(before, /const saved=ok&&\(body\.status==='saved_not_notified'\|\|body\.status==='saved_alert_unconfirmed'\);/);
    assert.match(before, /trackQuoteRequested\(\{ok,status:body\.status,submissionId:form\.dataset\.submissionId/);
  }
});

// ── Consent Mode ───────────────────────────────────────────────────────────

const lastConsentUpdateBefore = (h, sendTo) => {
  const at = h.calls.findIndex((c) => c[1] === 'conversion' && c[2] && c[2].send_to === sendTo);
  assert.ok(at >= 0, 'conversion sent');
  const updates = h.calls.slice(0, at).filter((c) => c[0] === 'consent' && c[1] === 'update');
  assert.ok(updates.length > 0, 'consent update pushed before the conversion');
  return updates[updates.length - 1][2];
};

test('marketing consent granted: conversions are attributable (ad_storage granted first)', () => {
  const h = harness({ marketing: true });
  h.tapPhone();
  assert.equal(h.ctx.__cd1GoogleAdsLeadConversions.call, 'attributable');
  assert.equal(lastConsentUpdateBefore(h, CALL_SEND_TO).ad_storage, 'granted');
  assert.equal(h.ctx.Cardetail1Revenue.trackQuoteRequested(saved()), 'attributable');
  assert.equal(lastConsentUpdateBefore(h, QUOTE_SEND_TO).ad_user_data, 'granted');
});

test('marketing consent denied: only a cookieless ping (ad_storage denied first)', () => {
  const h = harness({ marketing: false });
  h.tapPhone();
  assert.equal(h.ctx.__cd1GoogleAdsLeadConversions.call, 'cookieless');
  const update = lastConsentUpdateBefore(h, CALL_SEND_TO);
  assert.equal(update.ad_storage, 'denied');
  assert.equal(update.ad_user_data, 'denied');
  assert.equal(h.ctx.Cardetail1Revenue.trackQuoteRequested(saved()), 'cookieless');
  assert.equal(lastConsentUpdateBefore(h, QUOTE_SEND_TO).ad_storage, 'denied');
});

test('granting consent later never re-sends a cookieless conversion', () => {
  const h = harness({ marketing: false });
  h.tapPhone();
  h.ctx.Cardetail1Revenue.trackQuoteRequested(saved());
  h.consent.marketing = true;
  h.consent.analytics = true;
  h.ctx.Cardetail1Revenue.trackGoogleAdsCallConversion();
  h.ctx.Cardetail1Revenue.trackQuoteRequested(saved());
  assert.equal(h.leads().filter((c) => c.send_to === CALL_SEND_TO).length, 1);
  assert.equal(h.leads().filter((c) => c.send_to === QUOTE_SEND_TO).length, 1);
});

// ── gtag exceptions ────────────────────────────────────────────────────────

const throwOnConversion = (sendTo) => (a) => {
  if (a[0] === 'event' && a[1] === 'conversion' && a[2] && a[2].send_to === sendTo) throw new Error('gtag broke');
};

test('a gtag exception on a quote remembers nothing, so a later retry still counts', () => {
  const h = harness();
  h.setGtagHook(throwOnConversion(QUOTE_SEND_TO));
  assert.equal(h.ctx.Cardetail1Revenue.trackQuoteRequested(saved()), false);
  assert.equal(h.ls.cd1_ads_quote_tx_ids, undefined, 'submissionId not persisted');
  h.setGtagHook(null);
  assert.equal(h.ctx.Cardetail1Revenue.trackQuoteRequested(saved()), 'cookieless');
  assert.equal(h.leads().filter((c) => c.send_to === QUOTE_SEND_TO).length, 1);
  assert.deepEqual(JSON.parse(h.ls.cd1_ads_quote_tx_ids), ['sub-1']);
});

test('a gtag exception on a phone tap leaves the session flag unset', () => {
  const h = harness();
  h.setGtagHook(throwOnConversion(CALL_SEND_TO));
  h.tapPhone();
  assert.equal(h.ss.cd1_ads_call_fired, undefined);
  h.setGtagHook(null);
  assert.equal(h.ctx.Cardetail1Revenue.trackGoogleAdsCallConversion(), 'cookieless');
  assert.equal(h.ss.cd1_ads_call_fired, '1');
});

test('a gtag exception never throws into the form', () => {
  const h = harness();
  h.setGtagHook(() => { throw new Error('gtag broke'); });
  assert.doesNotThrow(() => h.ctx.Cardetail1Revenue.trackQuoteRequested(saved()));
  assert.doesNotThrow(() => h.tapPhone());
});

// ── Deduplication ──────────────────────────────────────────────────────────

test('a re-entrant call while the quote conversion is in flight is dropped', () => {
  const h = harness();
  let inner;
  h.setGtagHook((a) => {
    if (a[1] === 'conversion' && a[2].send_to === QUOTE_SEND_TO && inner === undefined) {
      inner = h.ctx.Cardetail1Revenue.trackQuoteRequested(saved());
    }
  });
  assert.equal(h.ctx.Cardetail1Revenue.trackQuoteRequested(saved()), 'cookieless');
  assert.equal(inner, false);
  assert.equal(h.leads().filter((c) => c.send_to === QUOTE_SEND_TO).length, 1);
});

test('off production or without a valid label, the quote id is not remembered for Ads', () => {
  const preview = harness({ host: 'deploy-preview-9--cardetail1.netlify.app' });
  preview.ctx.Cardetail1Revenue.trackQuoteRequested(saved());
  assert.equal(preview.ls.cd1_ads_quote_tx_ids, undefined);

  const badLabel = harness({ labels: false });
  badLabel.ctx.CD1_GOOGLE_ADS_QUOTE_SEND_TO = PAGE_VIEW_SEND_TO;
  badLabel.ctx.Cardetail1Revenue.trackQuoteRequested(saved());
  assert.equal(badLabel.ls.cd1_ads_quote_tx_ids, undefined);
});

test('different quote forms count separately; the first-party event is once per form', () => {
  const h = harness();
  const R = h.ctx.Cardetail1Revenue;
  R.trackQuoteRequested(saved({ submissionId: 'sub-a' }));
  R.trackQuoteRequested(saved({ submissionId: 'sub-a' }));
  R.trackQuoteRequested(saved({ submissionId: 'sub-b', source: 'commercial_specialty' }));
  assert.deepEqual(h.leads().map((c) => c.transaction_id), ['sub-a', 'sub-b']);
  assert.equal(h.quoteEvents().length, 2);
});

// ── Server confirmation ────────────────────────────────────────────────────

test('quotes count only with server confirmation of a saved request', () => {
  const h = harness();
  const R = h.ctx.Cardetail1Revenue;
  for (const bad of [
    { ok: true, status: 'error' },
    { ok: true, status: 'rate_limited' },
    { ok: false, status: 'sent' },
    { ok: 'true', status: 'sent' },
    { status: 'sent' },
  ]) {
    assert.equal(R.trackQuoteRequested(Object.assign({ submissionId: 'sub-x' }, bad)), false, JSON.stringify(bad));
  }
  assert.equal(h.leads().length, 0);
  assert.equal(h.quoteEvents().length, 0);
});

test('Fleet and chat forms stay outside this integration (documented)', () => {
  const src = read('assets/revenue-events.js');
  assert.match(src, /fleet-services\.html: its quote form does not load this script/);
  assert.match(src, /chat "leave your details" form/);
  assert.doesNotMatch(read('fleet-services.html'), /trackQuoteRequested/);
});

test('a re-entrant phone tap while the call conversion is in flight is dropped', () => {
  const h = harness();
  let inner;
  h.setGtagHook((a) => {
    if (a[1] === 'conversion' && a[2].send_to === CALL_SEND_TO && inner === undefined) {
      inner = h.ctx.Cardetail1Revenue.trackGoogleAdsCallConversion();
    }
  });
  h.tapPhone();
  assert.equal(inner, false);
  assert.equal(h.ctx.__cd1GoogleAdsCallInFlight, false);
  assert.equal(h.leads().filter((c) => c.send_to === CALL_SEND_TO).length, 1);
});
