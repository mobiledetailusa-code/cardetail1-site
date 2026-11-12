'use strict';

// Crawlers render pages with JavaScript and follow the /?book=… deep links,
// which open the booking flow at step 3 by themselves. Their visits showed up
// in the first-party funnel as package_selected + contact_captured every few
// minutes. Named crawlers are not tracked, real browsers still are, and
// robots.txt keeps crawlers away from the booking deep links.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const CLIENT_PATH = path.join(root, 'assets', 'revenue-events.js');

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
}

function load(userAgent) {
  const fetchCalls = [];
  const window = {
    crypto: { randomUUID: (() => { let n = 0; return () => `uuid-${++n}`; })() },
    location: { pathname: '/', search: '' },
    innerWidth: 1200,
    Cardetail1Consent: { getConsent: () => ({ analytics: false, marketing: false }) },
    console: { debug() {}, warn() {} },
    setTimeout: () => 0,
    fetch(url, options) {
      fetchCalls.push({ url, body: JSON.parse(options.body) });
      return Promise.resolve({ status: 200, ok: true, headers: { get: () => null } });
    },
  };
  if (userAgent !== undefined) window.navigator = { userAgent };
  const sandbox = {
    window,
    globalThis: window,
    sessionStorage: memoryStorage(),
    localStorage: memoryStorage(),
    document: { referrer: '', head: { appendChild() {} }, getElementById() { return null; }, createElement() { return {}; } },
    crypto: window.crypto,
    URL, Date, Promise, JSON, Object, Math, Number, String, Boolean, Array, isFinite,
    setTimeout: window.setTimeout,
    console: window.console,
  };
  vm.runInNewContext(fs.readFileSync(CLIENT_PATH, 'utf8'), sandbox, { filename: CLIENT_PATH });
  return { revenue: window.Cardetail1Revenue, localStorage: sandbox.localStorage, fetchCalls };
}

const CRAWLERS = [
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (Linux; Android 5.0; SM-G920A) AppleWebKit (KHTML, like Gecko) Chrome Mobile Safari (compatible; AdsBot-Google-Mobile; +http://www.google.com/mobile/adsbot.html)',
  'Mozilla/5.0 (compatible; Google-InspectionTool/1.0;)',
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
];

const REAL_BROWSERS = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  // A real phone brand that contains "BOT" must still be tracked.
  'Mozilla/5.0 (Linux; Android 13; CUBOT X70) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
];

test('named crawlers do not record first-party funnel events', () => {
  for (const ua of CRAWLERS) {
    const h = load(ua);
    assert.equal(h.revenue.track('package_selected', { package_id: 'full' }), null, ua);
    assert.equal(h.revenue.track('contact_captured', { booking_step: 3 }), null, ua);
    assert.equal(h.fetchCalls.length, 0, ua);
  }
});

test('real browsers, including a CUBOT phone, are still tracked', () => {
  for (const ua of REAL_BROWSERS) {
    const h = load(ua);
    const id = h.revenue.track('page_view', { page_type: 'home' });
    assert.equal(typeof id, 'string', ua);
  }
});

test('a missing navigator is treated as a real browser', () => {
  const h = load(undefined);
  assert.equal(typeof h.revenue.track('page_view', { page_type: 'home' }), 'string');
});

test('the crawler check stays out of the Google Ads booking conversion', () => {
  const js = fs.readFileSync(CLIENT_PATH, 'utf8');
  const fn = js.slice(js.indexOf('function trackGoogleAdsBookingConversion'), js.indexOf('function initTagAdapters'));
  assert.ok(fn.length > 0);
  assert.doesNotMatch(fn, /isLikelyCrawler/);
});

test('robots.txt keeps every crawler group away from booking deep links', () => {
  const robots = fs.readFileSync(path.join(root, 'robots.txt'), 'utf8').replace(/\r\n/g, '\n');
  const groups = robots.split(/\n(?=User-agent:)/).filter((g) => g.startsWith('User-agent:'));
  assert.ok(groups.length >= 4);
  for (const group of groups) {
    assert.match(group, /^Disallow: \/\*\?book=$/m, group.split('\n')[0]);
  }
  // Public pages stay crawlable.
  assert.doesNotMatch(robots, /^Disallow: \/$/m);
});
