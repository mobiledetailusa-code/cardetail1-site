'use strict';

// Google Ads attribution under Consent Mode denied: url_passthrough must be set
// once, after the consent default and before the first 'config', so ad click ids
// survive in internal URLs when ad cookies are not allowed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'assets', 'revenue-events.js'), 'utf8');

function run({ href, consent }) {
  const calls = [];
  const url = new URL(href);
  const ctx = {
    console: { log() {}, warn() {}, info() {}, error() {} },
    Date, Math, JSON, Number, Object, Array, String, Boolean, Error, Promise,
    setTimeout() { return 0; },
    clearTimeout() {},
    fetch() { return Promise.resolve({ ok: false, status: 503, headers: { get() { return null; } }, json: async () => ({}) }); },
    document: {
      readyState: 'complete',
      head: { appendChild() {} },
      getElementById() { return null; },
      createElement() { return { id: '', async: false, src: '', setAttribute() {} }; },
      addEventListener() {},
      querySelectorAll() { return []; },
    },
    location: { hostname: url.hostname, pathname: url.pathname, search: url.search, href },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    dataLayer: [],
    Cardetail1Consent: { getConsent() { return consent; }, onChange() {} },
    innerWidth: 1024,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.gtag = function () { calls.push(Array.prototype.slice.call(arguments)); };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  ctx.Cardetail1Revenue.initAdapters();
  return calls.map((c) => (c[0] === 'set' || c[0] === 'consent' ? `${c[0]}:${c[1]}` : `${c[0]}:${typeof c[1] === 'string' ? c[1] : ''}`));
}

const DENIED = { necessary: true, analytics: false, marketing: false, decided: false };

test('production host: url_passthrough is set once, after consent default and before config', () => {
  const seq = run({ href: 'https://cardetail1.com/?gclid=TEST', consent: DENIED });
  const iDefault = seq.indexOf('consent:default');
  const iPass = seq.indexOf('set:url_passthrough');
  const iConfig = seq.findIndex((s) => s.startsWith('config:AW-'));
  assert.ok(iDefault >= 0, `consent default missing: ${seq}`);
  assert.ok(iPass > iDefault, `url_passthrough must follow consent default: ${seq}`);
  assert.ok(iConfig > iPass, `url_passthrough must precede Ads config: ${seq}`);
  assert.equal(seq.filter((s) => s === 'set:url_passthrough').length, 1);
});

test('url_passthrough is set with the literal value true', () => {
  assert.match(SRC, /gtag\('set', 'url_passthrough', true\)/);
});

test('consent defaults stay denied (passthrough does not grant storage)', () => {
  assert.match(SRC, /'consent', 'default', \{\s*ad_storage: 'denied',\s*ad_user_data: 'denied',\s*ad_personalization: 'denied',\s*analytics_storage: 'denied'/);
});

test('non-production hosts load no Ads tag and set no passthrough', () => {
  const seq = run({ href: 'https://6aea980bd4d5b0f3a80aae8d--cardetail1-staging.netlify.app/', consent: DENIED });
  assert.equal(seq.indexOf('set:url_passthrough'), -1, String(seq));
  assert.equal(seq.findIndex((s) => s.startsWith('config:AW-')), -1, String(seq));
});
