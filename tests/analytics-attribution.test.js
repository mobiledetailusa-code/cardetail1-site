'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { publicAnalyticsConfig } = require('../netlify/lib/analytics-public-config');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function storage() {
  const data = new Map();
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
  };
}

function loadClient({
  search = '',
  referrer = '',
  pathname = '/',
  hostname = 'example.test',
  analytics = true,
  marketing = false,
  ga4Id = '',
  gtmId = '',
  configId = null,
} = {}) {
  const fetchCalls = [];
  const gtagCalls = [];
  let uuidN = 0;
  const consent = { analytics: !!analytics, marketing: !!marketing };
  const location = {
    hostname,
    pathname,
    search,
    href: `https://${hostname}${pathname}`,
  };
  const document = {
    referrer,
    readyState: 'complete',
    head: { appendChild() {} },
    body: { appendChild() {} },
    getElementById() { return null; },
    createElement() { return { id: '', async: true, src: '', setAttribute() {} }; },
    addEventListener() {},
    querySelectorAll() { return []; },
  };
  const window = {
    location,
    document,
    localStorage: storage(),
    sessionStorage: storage(),
    innerWidth: 1280,
    dataLayer: [],
    CD1_GA4_MEASUREMENT_ID: ga4Id,
    CD1_GTM_CONTAINER_ID: gtmId,
    Cardetail1Consent: { getConsent: () => consent },
    crypto: { randomUUID: () => `uuid-${++uuidN}` },
    console: { warn() {}, debug() {}, log() {}, info() {}, error() {} },
    setTimeout() { return 0; },
    clearTimeout() {},
    fetch(url, options) {
      const body = options && options.body ? JSON.parse(options.body) : null;
      fetchCalls.push({ url: String(url), body });
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get() { return null; } },
        json: async () => ({ ok: true, ga4MeasurementId: configId }),
      });
    },
    gtag(...args) { gtagCalls.push(args); },
    Date,
    Math,
    JSON,
    Number,
    Object,
    Array,
    String,
    Boolean,
    Error,
    URL,
    Promise,
    encodeURIComponent,
    decodeURIComponent,
    isFinite: Number.isFinite,
    parseInt,
    parseFloat,
  };
  window.window = window;
  window.globalThis = window;
  const ctx = vm.createContext(window);
  vm.runInContext(read('assets/revenue-events.js'), ctx);
  vm.runInContext(read('assets/checkout-analytics.js'), ctx);
  return { window, fetchCalls, gtagCalls, location, document, consent };
}

function eventBodies(fetchCalls) {
  return fetchCalls
    .filter((call) => call.body && call.body.event)
    .map((call) => call.body);
}

function gtagEvents(gtagCalls) {
  return gtagCalls.filter((args) => args[0] === 'event').map((args) => ({
    name: args[1],
    params: args[2] || {},
  }));
}

describe('public GA4 configuration', () => {
  it('stays off when the measurement id is missing or malformed', () => {
    assert.deepEqual(publicAnalyticsConfig({}), {
      ok: true,
      ga4MeasurementId: null,
      configured: { ga4: false },
    });
    assert.equal(publicAnalyticsConfig({ GA4_MEASUREMENT_ID: 'AW-11321647982' }).ga4MeasurementId, null);
    assert.equal(publicAnalyticsConfig({ GA4_MEASUREMENT_ID: 'G-1' }).ga4MeasurementId, null);
    assert.equal(publicAnalyticsConfig({ CD1_GA4_MEASUREMENT_ID: 'not-a-measurement-id' }).ga4MeasurementId, null);
  });

  it('accepts a real-format measurement id from either env name', () => {
    assert.equal(publicAnalyticsConfig({ GA4_MEASUREMENT_ID: 'G-AB12CD34' }).ga4MeasurementId, 'G-AB12CD34');
    assert.equal(publicAnalyticsConfig({ CD1_GA4_MEASUREMENT_ID: 'G-AB12CD34' }).configured.ga4, true);
  });
});

describe('acquisition survives internal navigation', () => {
  it('keeps UTM, term, landing page, referrer, session, and click id without sending the click id', () => {
    const h = loadClient({
      search: '?utm_source=google&utm_medium=cpc&utm_campaign=brand&utm_content=ad-a&utm_term=interior+detail&gclid=CLICK1&gbraid=GB1&wbraid=WB1',
      referrer: 'https://www.google.com/search',
      pathname: '/ceramic',
    });
    h.window.Cardetail1Revenue.track('page_view', { event_id: 'evt-land', email: 'hidden@example.com', phone: '2015550100', address: '1 Main', notes: 'dog hair' });
    h.location.search = '';
    h.location.pathname = '/boats-detailing.html';
    h.document.referrer = 'https://cardetail1.com/ceramic';
    h.window.Cardetail1Revenue.track('service_page_view', { event_id: 'evt-next', page_type: 'service' });

    const bodies = eventBodies(h.fetchCalls);
    assert.equal(bodies.length, 2);
    const first = bodies[0].properties;
    const second = bodies[1].properties;
    for (const props of [first, second]) {
      assert.equal(props.utm_source, 'google');
      assert.equal(props.utm_medium, 'cpc');
      assert.equal(props.utm_campaign, 'brand');
      assert.equal(props.utm_content, 'ad-a');
      assert.equal(props.utm_term, 'interior detail');
      assert.equal(props.landing_page, '/ceramic');
      assert.equal(props.referrer_domain, 'www.google.com');
      assert.equal(props.traffic_type, 'paid');
      assert.equal(props.anonymous_session_id, first.anonymous_session_id);
      assert.equal(props.first_seen_at, first.first_seen_at);
      assert.equal(props.gclid, undefined);
      assert.equal(props.gbraid, undefined);
      assert.equal(props.wbraid, undefined);
      assert.equal(props.email, undefined);
      assert.equal(props.phone, undefined);
      assert.equal(props.address, undefined);
      assert.equal(props.notes, undefined);
    }
    assert.equal(second.source_page, '/boats-detailing.html');
    const stored = JSON.parse(h.window.localStorage.getItem('cd1_rev_attr'));
    assert.equal(stored.gclid, 'CLICK1');
    assert.equal(stored.gbraid, 'GB1');
    assert.equal(stored.wbraid, 'WB1');
  });

  it('classifies organic, referral, and direct without a campaign', () => {
    const organic = loadClient({ referrer: 'https://www.bing.com/search?q=detail' });
    organic.window.Cardetail1Revenue.track('page_view', { event_id: 'evt-org' });
    assert.equal(eventBodies(organic.fetchCalls)[0].properties.traffic_type, 'organic');

    const referral = loadClient({ referrer: 'https://news.example/article' });
    referral.window.Cardetail1Revenue.track('page_view', { event_id: 'evt-ref' });
    assert.equal(eventBodies(referral.fetchCalls)[0].properties.traffic_type, 'referral');

    const direct = loadClient();
    direct.window.Cardetail1Revenue.track('page_view', { event_id: 'evt-dir' });
    assert.equal(eventBodies(direct.fetchCalls)[0].properties.traffic_type, 'direct');
    assert.equal(eventBodies(direct.fetchCalls)[0].properties.utm_source, undefined);

    const autoTag = loadClient({ search: '?gclid=CLICK-ONLY' });
    autoTag.window.Cardetail1Revenue.track('page_view', { event_id: 'evt-gclid' });
    const paid = eventBodies(autoTag.fetchCalls)[0].properties;
    assert.equal(paid.traffic_type, 'paid');
    assert.equal(paid.gclid, undefined);
    assert.equal(JSON.parse(autoTag.window.localStorage.getItem('cd1_rev_attr')).gclid, 'CLICK-ONLY');
  });
});

describe('GA4 funnel forwarding', () => {
  it('does not call gtag when no measurement id is configured', async () => {
    const h = loadClient({ analytics: true, configId: null });
    h.window.Cardetail1Revenue.initAdapters();
    await new Promise((resolve) => setImmediate(resolve));
    h.window.Cardetail1Revenue.track('service_page_view', { event_id: 'evt-noga', page_type: 'service' });
    assert.equal(h.window.CD1_GA4_MEASUREMENT_ID, '');
    assert.equal(gtagEvents(h.gtagCalls).length, 0);
    assert.equal(eventBodies(h.fetchCalls).some((body) => body.event === 'service_page_view'), true);
  });

  it('sends distinct funnel events after consent and ignores a second page_view', () => {
    const h = loadClient({ analytics: true, ga4Id: 'G-TEST1234' });
    h.window.Cardetail1Revenue.initAdapters();
    h.window.Cardetail1Revenue.track('page_view', { event_id: 'evt-pv' });
    h.window.Cardetail1Revenue.track('booking_started', { event_id: 'evt-start', category: 'cars' });
    h.window.Cardetail1Revenue.track('booking_submitted', {
      event_id: 'evt-sub',
      booking_reference: 'CD1-TEST',
      estimated_value: 440,
      currency: 'USD',
      email: 'hidden@example.com',
    });
    const events = gtagEvents(h.gtagCalls);
    assert.equal(events.some((event) => event.name === 'page_view'), false);
    assert.equal(events.some((event) => event.name === 'purchase'), false);
    assert.equal(events.filter((event) => event.name === 'begin_checkout').length, 1);
    const submitted = events.find((event) => event.name === 'booking_submitted');
    assert.ok(submitted);
    assert.equal(submitted.params.estimated_value, 440);
    assert.equal(submitted.params.booking_reference, undefined);
    assert.equal(submitted.params.email, undefined);
    assert.equal(submitted.params.gclid, undefined);
  });

  it('does not forward to GA4 when analytics consent is denied or GTM is configured', () => {
    const denied = loadClient({ analytics: false, ga4Id: 'G-TEST1234' });
    denied.window.Cardetail1Revenue.initAdapters();
    denied.window.Cardetail1Revenue.track('booking_started', { event_id: 'evt-deny' });
    assert.equal(gtagEvents(denied.gtagCalls).length, 0);
    assert.equal(denied.window.dataLayer.filter((row) => row && row.event === 'begin_checkout').length, 0);

    const gtm = loadClient({ analytics: true, ga4Id: 'G-TEST1234', gtmId: 'GTM-TEST' });
    gtm.window.Cardetail1Revenue.initAdapters();
    gtm.window.Cardetail1Revenue.track('booking_started', { event_id: 'evt-gtm' });
    assert.equal(gtagEvents(gtm.gtagCalls).some((event) => event.name === 'begin_checkout'), false);
  });

  it('applies a measurement id returned by the public config and still withholds an invalid one', async () => {
    const h = loadClient({ analytics: true, configId: 'G-AB12CD34' });
    h.window.Cardetail1Revenue.initAdapters();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.window.CD1_GA4_MEASUREMENT_ID, 'G-AB12CD34');
    h.window.Cardetail1Revenue.track('package_selected', { event_id: 'evt-pkg', package_id: 'interior', estimated_value: 440 });
    assert.equal(gtagEvents(h.gtagCalls).some((event) => event.name === 'select_item'), true);

    const bad = loadClient({ analytics: true, configId: 'AW-11321647982' });
    bad.window.Cardetail1Revenue.initAdapters();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bad.window.CD1_GA4_MEASUREMENT_ID, '');
    bad.window.Cardetail1Revenue.track('package_selected', { event_id: 'evt-bad' });
    assert.equal(gtagEvents(bad.gtagCalls).length, 0);
  });
});

describe('booking request is not a sale', () => {
  it('emits one first-party request only after persist evidence and omits personal fields', () => {
    const h = loadClient({ hostname: 'cardetail1.com', analytics: true, ga4Id: 'G-TEST1234' });
    h.window.Cardetail1Revenue.initAdapters();
    h.window.Cardetail1CheckoutAnalytics.onBookingSubmitted();
    h.window.Cardetail1CheckoutAnalytics.onBookingSubmitted({
      ok: true,
      bookingCreated: false,
      id: 'CD1-NO',
      approvedFinalAmount: 440,
      email: 'hidden@example.com',
    });
    assert.equal(eventBodies(h.fetchCalls).some((body) => body.event === 'booking_submitted'), false);
    assert.equal(gtagEvents(h.gtagCalls).some((event) => event.name === 'conversion' && event.params.transaction_id === 'CD1-NO'), false);

    h.window.Cardetail1CheckoutAnalytics.onBookingSubmitted({
      ok: true,
      bookingCreated: true,
      id: 'CD1-YES',
      approvedFinalAmount: 440,
      currency: 'USD',
      email: 'hidden@example.com',
      phone: '2015550100',
      address: 'Upper Saddle River',
      totalPrice: 999,
    });
    h.window.Cardetail1CheckoutAnalytics.onBookingSubmitted({
      ok: true,
      bookingCreated: true,
      idempotent: true,
      id: 'CD1-YES',
      approvedFinalAmount: 440,
    });

    const submitted = eventBodies(h.fetchCalls).filter((body) => body.event === 'booking_submitted');
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].properties.booking_reference, 'CD1-YES');
    assert.equal(submitted[0].properties.estimated_value, 440);
    assert.equal(submitted[0].properties.email, undefined);
    assert.equal(submitted[0].properties.phone, undefined);
    assert.equal(submitted[0].properties.address, undefined);
    assert.equal(submitted[0].properties.totalPrice, undefined);
    const conversions = gtagEvents(h.gtagCalls).filter((event) => event.name === 'conversion' && event.params.send_to && event.params.send_to.indexOf('yrODCJGL998YEO7GypYq') !== -1);
    assert.equal(conversions.length, 1);
    assert.equal(conversions[0].params.value, 440);
    assert.equal(conversions[0].params.transaction_id, 'CD1-YES');
    assert.equal(conversions[0].params.email, undefined);
    assert.equal(gtagEvents(h.gtagCalls).some((event) => event.name === 'purchase'), false);
  });

  it('records a persisted request without an approved amount and does not send an Ads conversion', () => {
    const h = loadClient({ hostname: 'cardetail1.com' });
    h.window.Cardetail1CheckoutAnalytics.onBookingSubmitted({
      ok: true,
      bookingCreated: true,
      id: 'CD1-NOAMT',
      value: 440,
      totalPrice: 440,
    });
    const submitted = eventBodies(h.fetchCalls).filter((body) => body.event === 'booking_submitted');
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].properties.estimated_value, undefined);
    assert.equal(gtagEvents(h.gtagCalls).some((event) => event.name === 'conversion' && event.params.transaction_id === 'CD1-NOAMT'), false);
  });
});

describe('package selection is part of the funnel', () => {
  it('tracks package_selected with the quoted amount and skips restore replays', () => {
    const h = loadClient();
    h.window.ST = { cat: 'cars', basePrice: null, _restoring: false };
    h.window.selectPkg = function selectPkg(id) {
      h.window.ST.pkgId = id;
      h.window.ST.basePrice = 440;
    };
    h.window.bkGoTo = function bkGoTo() {};
    h.window.openBooking = function openBooking() {};
    vm.runInContext(read('assets/revops-booking-hooks.js'), h.window);
    h.window.selectPkg('interior_detail');
    h.window.ST._restoring = true;
    h.window.selectPkg('interior_detail');
    const selected = eventBodies(h.fetchCalls).filter((body) => body.event === 'package_selected');
    assert.equal(selected.length, 1);
    assert.equal(selected[0].properties.package_id, 'interior_detail');
    assert.equal(selected[0].properties.estimated_value, 440);
    assert.equal(selected[0].properties.category, 'cars');
    assert.equal(selected[0].properties.email, undefined);
  });
});
