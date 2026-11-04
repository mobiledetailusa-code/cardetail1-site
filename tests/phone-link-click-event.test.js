'use strict';

// click_call was approved on client and server but nothing emitted it, so
// tel: link clicks were invisible in GA4. It is an informational phone-link
// click: never a call, booking, revenue or Google Ads conversion, never PII.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'assets', 'revenue-events.js'), 'utf8');
const PHONE = '+15513893986';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

function el(attrs = {}, ancestors = []) {
  const node = {
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    matches: (sel) => sel === 'a[href]' && 'href' in attrs,
    closest(sel) {
      const chain = [node, ...ancestors];
      for (const n of chain) {
        if (n === node && sel === 'a[href]' && 'href' in attrs) return node;
        if (n !== node && n.selectors && sel.split(',').some((s) => n.selectors.includes(s.trim()))) return n;
      }
      if (sel === 'a[href]') {
        const a = ancestors.find((n) => n.href !== undefined);
        if (a) return a.node;
      }
      return null;
    },
  };
  return node;
}

function load({ analytics = false, marketing = false } = {}) {
  const listeners = [];
  const fetches = [];
  const gtagCalls = [];
  const window = {
    crypto: { randomUUID: (() => { let i = 0; return () => `uuid-${++i}`; })() },
    location: { pathname: '/', search: '', hostname: 'cardetail1.com' },
    innerWidth: 390,
    dataLayer: [],
    CD1_GA4_MEASUREMENT_ID: 'G-TEST',
    __cd1Ga4Configured: true,
    gtag: (...args) => gtagCalls.push(args),
    Cardetail1Consent: { getConsent: () => ({ analytics, marketing, decided: true }) },
    console: { debug() {}, warn() {} },
    setTimeout: () => 0,
    clearTimeout() {},
    fetch: (url, opts) => { fetches.push({ url, body: JSON.parse(opts.body) }); return Promise.resolve({ ok: true, status: 200, headers: { get: () => null } }); },
  };
  window.document = {
    referrer: '',
    head: { appendChild() {} },
    getElementById: () => null,
    createElement: () => ({}),
    addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }),
  };
  const session = memoryStorage();
  const sandbox = { window, globalThis: window, crypto: window.crypto, document: window.document, sessionStorage: session, localStorage: memoryStorage(), navigator: {}, URL, Date, JSON, Math, console: window.console };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const click = (target) => listeners.filter((l) => l.type === 'click').forEach((l) => l.fn({ target }));
  const queued = () => Object.values(JSON.parse(session.getItem('cd1_rev_delivery_v2') || '{"events":{}}').events);
  return { window, listeners, fetches, gtagCalls, click, queued };
}

function telLink(container) {
  const anc = container ? [{ selectors: [container] }] : [];
  return el({ href: `tel:${PHONE}` }, anc);
}

// First-party delivery queue (sessionStorage) is the record of what is sent to /revenue-event.
const callEvents = (h) => h.queued().filter((e) => e.eventName === 'click_call').map((e) => ({ body: e.payload }));

test('binds one capture-phase click listener', () => {
  const h = load();
  const clicks = h.listeners.filter((l) => l.type === 'click');
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].capture, true);
});

test('tel: click emits click_call with placement only and no phone number', () => {
  const h = load({ analytics: true });
  h.click(telLink('.mobile-sticky-cta'));
  const events = callEvents(h);
  assert.equal(events.length, 1);
  const payload = JSON.stringify(events[0].body);
  assert.match(payload, /"sticky_cta"/);
  assert.doesNotMatch(payload, /5513893986|tel:/, 'phone number must never leave the browser');
  const ga4 = h.gtagCalls.filter((c) => c[0] === 'event' && c[1] === 'click_call');
  assert.equal(ga4.length, 1);
  assert.doesNotMatch(JSON.stringify(ga4[0][2]), /5513893986|tel:/);
});

test('no third-party delivery without analytics consent', () => {
  const h = load({ analytics: false });
  h.click(telLink());
  assert.equal(h.gtagCalls.filter((c) => c[1] === 'click_call').length, 0);
  assert.equal(h.window.dataLayer.filter((d) => d.cardetail1_event === 'click_call').length, 0);
});

test('never sends a Google Ads conversion', () => {
  const h = load({ analytics: true, marketing: true });
  h.click(telLink());
  assert.equal(h.gtagCalls.filter((c) => c[1] === 'conversion').length, 0);
});

test('a single tap that fires twice counts once; non-tel links count zero', () => {
  const h = load({ analytics: true });
  const link = telLink('footer');
  h.click(link);
  h.click(link);
  h.click(el({ href: 'sms:+15513893986' }));
  h.click(el({ href: '/book' }));
  h.click(el({}));
  const events = callEvents(h);
  assert.equal(events.length, 1);
  assert.match(JSON.stringify(events[0].body), /"footer"/);
});

test('click_call stays in the shared client/server contract', () => {
  const schema = require('../netlify/lib/revenue-event-schema.js');
  const server = JSON.stringify(schema);
  assert.match(SRC, /click_call: 1/);
  assert.match(server, /click_call/);
});
