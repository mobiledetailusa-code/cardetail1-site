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

const THROWING_NAVIGATOR = Symbol('throwing navigator');

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
  if (userAgent === THROWING_NAVIGATOR) {
    window.navigator = Object.defineProperty({}, 'userAgent', { get() { throw new Error('ua blocked'); } });
  } else if (userAgent !== undefined) {
    window.navigator = { userAgent };
  }
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

test('other real browsers and edge cases are still tracked without throwing', () => {
  const agents = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
    'Mozilla/5.0 (Linux; Android 14; SM-S921U) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/350.0.698229058 Mobile/15E148 Safari/604.1',
    '', // empty user agent: not enough evidence to call it a crawler
  ];
  for (const ua of agents) {
    const h = load(ua);
    assert.equal(typeof h.revenue.track('page_view', { page_type: 'home' }), 'string', ua || '(empty)');
  }
  // A user agent getter that throws must not break tracking.
  const h = load(THROWING_NAVIGATOR);
  assert.equal(typeof h.revenue.track('page_view', { page_type: 'home' }), 'string');
});

// ---------------------------------------------------------------------------
// End-to-end scenarios with the real analytics scripts: first-party events,
// Google Ads booking conversion, approved value, dedupe and click-ID capture.

const BOOKING_SEND_TO = 'AW-11321647982/AAOmCJW9roAdEO7GypYq';
const CHROME = REAL_BROWSERS[1];
const CUBOT = REAL_BROWSERS[2];
const GOOGLEBOT = CRAWLERS[0];

function loadFullStack(userAgent, search) {
  const conversions = [];
  const firstParty = [];
  const timers = [];
  const store = () => {
    const data = Object.create(null);
    return {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
      setItem: (k, v) => { data[k] = String(v); },
      removeItem: (k) => { delete data[k]; },
    };
  };
  const ctx = {
    console: { log() {}, warn() {}, info() {}, error() {}, debug() {} },
    Date, Math, JSON, Number, Object, Array, String, Boolean, Error, URL, Promise, isFinite,
    crypto: { randomUUID: (() => { let n = 0; return () => `uuid-${++n}`; })() },
    // checkout-analytics retries init() until the booking UI exists; keep the
    // timers on a list so each scenario can stop them (same as the Ads harness).
    setTimeout: (fn, ms) => { const t = setTimeout(fn, Math.min(Number(ms) || 0, 5)); timers.push(t); return t; },
    clearTimeout: (t) => clearTimeout(t),
    fetch(url, options) {
      if (String(url).includes('revenue-event')) firstParty.push(JSON.parse(options.body));
      return Promise.resolve({ ok: true, status: 200, headers: { get() { return null; } }, json: async () => ({ ok: true }) });
    },
    document: {
      readyState: 'complete',
      referrer: 'https://www.google.com/',
      head: { appendChild() {} },
      getElementById() { return null; },
      createElement() { return { id: '', async: false, src: '', setAttribute() {} }; },
      addEventListener() {},
    },
    location: { pathname: '/', search, href: `https://cardetail1.com/${search}` },
    sessionStorage: store(),
    localStorage: store(),
    dataLayer: [],
    Cardetail1Consent: { getConsent: () => ({ analytics: false, marketing: true }), onChange() {} },
    innerWidth: 1024,
    navigator: { userAgent },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.gtag = function gtag(...args) {
    if (args[0] === 'event' && args[1] === 'conversion') conversions.push(args[2]);
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(CLIENT_PATH, 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'assets', 'checkout-analytics.js'), 'utf8'), ctx);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
  const firstPartyNames = () => firstParty.map((b) => b.event || b.eventName || (b.events || []).map((e) => e.event).join(','));
  const cleanup = () => { timers.forEach((t) => clearTimeout(t)); timers.length = 0; };
  return { ctx, conversions, firstPartyNames, settle, cleanup };
}

const evidence = {
  ok: true, bookingCreated: true, id: 'CD1-SCENARIO-1', approvedFinalAmount: 250, currency: 'USD',
};
const CAMPAIGN = '?utm_source=google&utm_medium=cpc&utm_campaign=search&gclid=TESTGCLID123';

for (const [label, ua] of [['A) legitimate Chrome customer', CHROME], ['D) real CUBOT phone', CUBOT]]) {
  test(`${label}: funnel events, one Ads conversion with the approved value, click ID kept`, async (t) => {
    const h = loadFullStack(ua, CAMPAIGN);
    t.after(h.cleanup);
    h.ctx.Cardetail1Revenue.initPageView('home');
    h.ctx.Cardetail1Revenue.track('booking_started', { category: 'cars' });
    h.ctx.Cardetail1Revenue.track('package_selected', { package_id: 'full', category: 'cars' });
    h.ctx.Cardetail1CheckoutAnalytics.onBookingSubmitted(evidence);
    h.ctx.Cardetail1CheckoutAnalytics.onBookingSubmitted(evidence); // retry / double submit
    await h.settle();

    // The page-view conversion (a different label) fires on load; count bookings only.
    const bookings = h.conversions.filter((c) => c.send_to === BOOKING_SEND_TO);
    assert.equal(bookings.length, 1, 'exactly one Ads booking conversion');
    assert.equal(bookings[0].value, 250);
    assert.equal(bookings[0].transaction_id, 'CD1-SCENARIO-1');

    const attr = h.ctx.Cardetail1Revenue.captureAttribution();
    assert.equal(attr.gclid, 'TESTGCLID123', 'gclid kept with marketing consent');
    assert.equal(attr.utm_source, 'google');

    const sent = h.firstPartyNames().join(' ');
    for (const name of ['page_view', 'booking_started', 'package_selected', 'booking_submitted']) {
      assert.match(sent, new RegExp(name), `${name} delivered first-party`);
    }
  });
}

test('B) known crawler: no first-party funnel events and no commercial events', async (t) => {
  const h = loadFullStack(GOOGLEBOT, '?book=cars&pkg=full&zip=07650');
  t.after(h.cleanup);
  h.ctx.Cardetail1Revenue.initPageView('home');
  for (const name of ['booking_started', 'package_selected', 'contact_captured', 'booking_step_viewed', 'click_call']) {
    assert.equal(h.ctx.Cardetail1Revenue.track(name, { booking_step: 3 }), null, name);
  }
  await h.settle();
  assert.deepEqual(h.firstPartyNames(), []);
  assert.equal(h.conversions.filter((c) => c.send_to === BOOKING_SEND_TO).length, 0);
});

// ---------------------------------------------------------------------------
// robots.txt: evaluate the rules the way Google documents them (RFC 9309):
// pick the most specific matching user-agent group (several User-agent lines
// can share one group), match path+query from the start with * and $, the
// longest matching rule wins, and Allow wins a tie.

function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && current) {
      if (value) current.rules.push({ allow: key === 'allow', pattern: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function patternMatches(pattern, url) {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`).test(url);
}

function isAllowed(groups, agent, url) {
  const token = agent.toLowerCase();
  let selected = groups.filter((g) => g.agents.includes(token));
  if (!selected.length) selected = groups.filter((g) => g.agents.includes('*'));
  const rules = selected.flatMap((g) => g.rules).filter((r) => patternMatches(r.pattern, url));
  if (!rules.length) return true;
  rules.sort((a, b) => (b.pattern.length - a.pattern.length) || (Number(b.allow) - Number(a.allow)));
  return rules[0].allow;
}

const robotsGroups = parseRobots(fs.readFileSync(path.join(root, 'robots.txt'), 'utf8'));
const AGENTS = ['Googlebot', 'bingbot', 'GPTBot', 'ChatGPT-User', 'PerplexityBot', 'SomeOtherCrawler'];

test('robots evaluator sanity: longest match wins and Allow wins a tie', () => {
  const g = parseRobots('User-agent: *\nAllow: /a\nDisallow: /a\nDisallow: /b\nAllow: /b/c\n');
  assert.equal(isAllowed(g, 'x', '/a'), true);
  assert.equal(isAllowed(g, 'x', '/b/x'), false);
  assert.equal(isAllowed(g, 'x', '/b/c/d'), true);
  assert.equal(patternMatches('/*&book=', '/?gclid=1&book=cars'), true);
  assert.equal(patternMatches('/*?book=', '/?gclid=1&book=cars'), false);
});

test('robots.txt blocks booking deep links, wherever book= sits, for every crawler', () => {
  const urls = [
    '/?book=cars&pkg=full&zip=07650',
    '/?utm_source=google&book=cars&pkg=full',
    '/?gclid=example&book=cars',
    '/rv-detailing?book=rvs',
    '/?book=rvs&multi=1',
  ];
  for (const agent of AGENTS) {
    for (const url of urls) assert.equal(isAllowed(robotsGroups, agent, url), false, `${agent} ${url}`);
  }
});

test('robots.txt blocks private paths for every crawler, including the AI groups', () => {
  const urls = ['/admin/', '/admin/x', '/customer/', '/tech/jobs', '/admin.html', '/admin-ops.html',
    '/technician.html', '/template-city.html', '/resume.html', '/customer.html', '/receipt.html'];
  for (const agent of AGENTS) {
    for (const url of urls) assert.equal(isAllowed(robotsGroups, agent, url), false, `${agent} ${url}`);
  }
});

test('robots.txt keeps public pages, campaign URLs and rendering assets crawlable', () => {
  const urls = ['/', '/ceramic-coating', '/rv-detailing', '/boats-detailing', '/bergen-county-hub',
    '/essex-county-hub', '/paramus-mobile-detailing', '/reviews', '/blog', '/sitemap.xml',
    '/?utm_source=google&utm_medium=cpc', '/?gclid=abc123', '/?bookmark=1', '/?booking_ref=1',
    '/assets/revenue-events.js', '/assets/checkout-analytics.js'];
  for (const agent of AGENTS) {
    for (const url of urls) assert.equal(isAllowed(robotsGroups, agent, url), true, `${agent} ${url}`);
  }
});
