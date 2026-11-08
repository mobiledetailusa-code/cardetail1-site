'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const ADS = [
  'gclid=CLICK1',
  'gbraid=GB1',
  'wbraid=WB1',
  'msclkid=MS1',
  'fbclid=FB1',
  'utm_source=google',
  'utm_medium=cpc',
  'utm_campaign=county',
  'utm_content=ad-a',
  'utm_term=interior+detail',
].join('&');

const HUBS = [
  { file: 'union-county-hub.html', path: '/union-county-hub', zip: '07901', pkg: 'interior' },
  { file: 'fairfield-county-hub.html', path: '/fairfield-county-hub', zip: '06830', pkg: 'refresh' },
  { file: 'rockland-county-hub.html', path: '/rockland-county-hub', zip: '10960', pkg: 'full' },
  { file: 'morris-county-hub.html', path: '/morris-county-hub', zip: '07960', pkg: 'interior' },
];

const SCRIPTS = [
  'assets/consent-manager.js',
  'assets/revenue-events.js',
  'assets/revops-init.js',
  'assets/county-hub-booking-attribution.js',
];

function consentRecord(marketing, analytics) {
  return JSON.stringify({
    version: '2026-07-revops-v1',
    necessary: true,
    analytics: !!analytics,
    marketing: !!marketing,
    decided: true,
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

function boot(hub, consent) {
  const fetches = [];
  const dom = new JSDOM(read(hub.file), {
    url: `https://cardetail1.com${hub.path}?${ADS}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const window = dom.window;
  window.fetch = (url, options) => {
    let body = null;
    try { body = options && options.body ? JSON.parse(options.body) : null; } catch (e) { body = options && options.body; }
    fetches.push({ url: String(url), body });
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get() { return null; } },
      json: async () => ({ ok: true }),
    });
  };
  if (consent) window.localStorage.setItem('cd1_consent_v1', consent);
  for (const file of SCRIPTS) window.eval(read(file));
  if (window.document.readyState === 'loading') {
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  }
  return { window, fetches };
}

function stored(window) {
  return JSON.parse(window.localStorage.getItem('cd1_rev_attr'));
}

function packageLink(window, hub) {
  return window.document.querySelector(`a[href*="pkg=${hub.pkg}"][href*="zip=${hub.zip}"]`);
}

function openBooking(search, previous) {
  const fetches = [];
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: `https://cardetail1.com${search}`,
    runScripts: 'outside-only',
  });
  const window = dom.window;
  window.fetch = (url, options) => {
    let body = null;
    try { body = options && options.body ? JSON.parse(options.body) : null; } catch (e) { body = null; }
    fetches.push({ url: String(url), body });
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get() { return null; } },
      json: async () => ({ ok: true }),
    });
  };
  const attr = previous.localStorage.getItem('cd1_rev_attr');
  const consent = previous.localStorage.getItem('cd1_consent_v1');
  if (attr) window.localStorage.setItem('cd1_rev_attr', attr);
  if (consent) window.localStorage.setItem('cd1_consent_v1', consent);
  window.eval(read('assets/consent-manager.js'));
  window.eval(read('assets/revenue-events.js'));
  window.Cardetail1Revenue.captureAttribution();
  return { window, fetches };
}

describe('county hub ads attribution', () => {
  it('loads consent before attribution and leaves the homepage order unchanged', () => {
    const home = read('index.html');
    const consentAt = home.indexOf('assets/consent-manager.js');
    const revenueAt = home.indexOf('assets/revenue-events.js');
    assert.ok(consentAt > 0 && consentAt < revenueAt);
    assert.equal(home.includes('assets/county-hub-booking-attribution.js'), false);
    for (const hub of HUBS) {
      const html = read(hub.file);
      let cursor = 0;
      for (const file of SCRIPTS) {
        const at = html.indexOf(file, cursor);
        assert.ok(at > cursor, `${hub.file} missing ${file}`);
        cursor = at;
      }
    }
  });

  for (const hub of HUBS) {
    it(`keeps ${hub.path} campaign data through booking when marketing consent is already granted`, () => {
      const hubPage = boot(hub, consentRecord(true, true));
      const attr = stored(hubPage.window);
      assert.equal(attr.landing_page, hub.path);
      assert.equal(attr.utm_source, 'google');
      assert.equal(attr.utm_medium, 'cpc');
      assert.equal(attr.utm_campaign, 'county');
      assert.equal(attr.utm_content, 'ad-a');
      assert.equal(attr.utm_term, 'interior detail');
      assert.equal(attr.gclid, 'CLICK1');
      assert.equal(attr.gbraid, 'GB1');
      assert.equal(attr.wbraid, 'WB1');

      const form = hubPage.window.document.querySelector('form.city-zip');
      assert.equal(form.querySelector('[name="book"]').value, 'cars');
      assert.equal(form.querySelector('[name="zip"]').value, hub.zip);
      assert.equal(form.querySelector('[name="gclid"]').value, 'CLICK1');
      assert.equal(form.querySelector('[name="utm_campaign"]').value, 'county');

      const link = packageLink(hubPage.window, hub);
      const href = link.getAttribute('href');
      const query = new URL(href, 'https://cardetail1.com').searchParams;
      assert.equal(query.get('book'), 'cars');
      assert.equal(query.get('pkg'), hub.pkg);
      assert.equal(query.get('zip'), hub.zip);
      assert.equal(query.get('gclid'), 'CLICK1');
      assert.equal(query.get('utm_source'), 'google');

      const booking = openBooking(href, hubPage.window);
      const kept = stored(booking.window);
      assert.equal(kept.gclid, 'CLICK1');
      assert.equal(kept.utm_campaign, 'county');
      assert.equal(kept.landing_page, hub.path);
      const hubEvents = hubPage.fetches.map((call) => call.body && call.body.event).filter(Boolean);
      assert.deepEqual(hubEvents, ['hub_page_view']);
      const events = booking.fetches.map((call) => call.body && call.body.event).filter(Boolean);
      assert.equal(events.includes('purchase'), false);
      assert.equal(events.includes('booking_submitted'), false);
    });

    it(`stores UTMs for ${hub.path} and withholds click IDs when marketing consent is declined`, () => {
      const hubPage = boot(hub, consentRecord(false, false));
      const attr = stored(hubPage.window);
      assert.equal(attr.utm_source, 'google');
      assert.equal(attr.utm_campaign, 'county');
      assert.equal(attr.gclid, null);
      assert.equal(attr.gbraid, null);
      assert.equal(attr.wbraid, null);
      const booking = openBooking(packageLink(hubPage.window, hub).getAttribute('href'), hubPage.window);
      const kept = stored(booking.window);
      assert.equal(kept.utm_source, 'google');
      assert.equal(kept.gclid, null);
      assert.equal(kept.gbraid, null);
      assert.equal(kept.wbraid, null);
    });

    it(`waits to store the ${hub.path} click ID until marketing consent is granted`, () => {
      const hubPage = boot(hub, null);
      const before = stored(hubPage.window);
      assert.equal(before.utm_source, 'google');
      assert.equal(before.gclid, null);
      assert.equal(hubPage.window.document.getElementById('cd1-consent-banner') != null, true);
      const href = packageLink(hubPage.window, hub).getAttribute('href');
      const booking = openBooking(href, hubPage.window);
      assert.equal(stored(booking.window).gclid, null);
      booking.window.Cardetail1Consent.saveConsent({ analytics: true, marketing: true });
      const granted = stored(booking.window);
      assert.equal(granted.gclid, 'CLICK1');
      assert.equal(granted.gbraid, 'GB1');
      assert.equal(granted.wbraid, 'WB1');
      assert.equal(granted.utm_campaign, 'county');
      const sent = hubPage.fetches.concat(booking.fetches);
      for (const call of sent) {
        const props = call.body && call.body.properties;
        if (!props) continue;
        assert.equal(props.gclid, undefined);
        assert.equal(props.email, undefined);
        assert.equal(props.phone, undefined);
        assert.equal(call.body.event === 'purchase', false);
      }
    });
  }
});
