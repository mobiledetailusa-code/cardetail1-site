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

function harness({ host = 'cardetail1.com', labels = true, sessionStore, localStore } = {}) {
  const conversions = [];
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
    Cardetail1Consent: { getConsent() { return { analytics: false, marketing: false }; }, onChange() {} },
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
    if (a[0] === 'event' && a[1] === 'conversion') conversions.push(a[2] || {});
  };
  vm.createContext(ctx);
  vm.runInContext(read('assets/revenue-events.js'), ctx);
  const leads = () => conversions.filter((c) => c.send_to !== PAGE_VIEW_SEND_TO);
  const tapPhone = (href = 'tel:+15513893986') => {
    const link = { getAttribute: () => href, closest: (sel) => (sel === 'a[href]' ? link : null) };
    clickHandler({ target: link });
  };
  return { ctx, leads, tapPhone, ss, ls, tracked };
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
    assert.equal(h.ctx.Cardetail1Revenue.trackQuoteRequested(saved({ status, submissionId: 'sub-' + status })), true);
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
