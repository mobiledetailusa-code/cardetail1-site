'use strict';

/**
 * Final functional closure — customer and admin portals.
 *
 * Covers persistent device sessions and same-device re-entry through a spent
 * appointment link, the Pay Balance direct action, the customer portal
 * information hierarchy, and the admin review queue. Business logic for
 * booking, pricing, confirmation, payment authority and notifications is out
 * of scope here and is asserted by the existing suites.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createCasMemoryStore } = require('./helpers/cas-memory-store');
const { createIdentityMemoryPrisma } = require('./helpers/identity-memory-prisma');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const MODULES = [
  'netlify/lib/prisma',
  'netlify/lib/tech-security',
  'netlify/lib/ops-db',
  'netlify/lib/booking-repository',
  'netlify/lib/booking-prisma-mirror',
  'netlify/lib/appointment-access-token',
  'netlify/lib/appointment-booking-linkage',
  'netlify/lib/booking-transactional-notifications',
  'netlify/lib/customer-session',
  'netlify/lib/public-rate-limit',
  'netlify/lib/customer-account-service',
  'netlify/functions/customer-appointment-access',
  'netlify/functions/customer-portal-auth',
];

function bust() {
  for (const rel of MODULES) {
    delete require.cache[require.resolve(path.join(ROOT, rel))];
  }
}

function listableStore(seed = {}) {
  const store = createCasMemoryStore(seed);
  store.list = async () => ({ blobs: [...store._data.keys()].map((key) => ({ key })) });
  return store;
}

function baseBooking(overrides = {}) {
  return {
    isDraft: false,
    firstName: 'Owner',
    lastName: 'Example',
    email: 'owner@example.com',
    phone: '2015550143',
    package: 'Interior Detail',
    preferredTime: '10:00 AM',
    preferredDate: '2099-05-01',
    status: 'Pending Review',
    appointmentStatus: 'pending_review',
    jobStatus: 'pending_review',
    bookingVersion: 1,
    totalPrice: 199,
    ...overrides,
  };
}

function harness({ bookings = {} } = {}) {
  bust();

  process.env.CONTEXT = 'production';
  process.env.PUBLIC_SITE_URL = 'https://cardetail1.com';
  process.env.CUSTOMER_SESSION_SECRET = 'test-customer-session-secret-32chars-min';
  process.env.RESEND_API_KEY = 'test-resend-key';
  delete process.env.DEPLOY_URL;
  delete process.env.DEPLOY_PRIME_URL;
  delete process.env.BRANCH;

  const bookingsStore = listableStore(bookings);
  const tokenStore = createCasMemoryStore();
  const focusStore = createCasMemoryStore();
  const claimStore = createCasMemoryStore();
  const sessionStore = createCasMemoryStore();
  const rateStore = createCasMemoryStore();
  const prisma = createIdentityMemoryPrisma();

  const techSecurity = require(path.join(ROOT, 'netlify/lib/tech-security'));
  techSecurity.blobsStore = async (name) => {
    if (name === 'cd1-bookings') return bookingsStore;
    if (name === 'cd1-appointment-access-tokens') return tokenStore;
    if (name === 'cd1-appointment-focus-refs') return focusStore;
    if (name === 'cd1-notification-claims') return claimStore;
    return createCasMemoryStore();
  };

  const prismaMod = require(path.join(ROOT, 'netlify/lib/prisma'));
  prismaMod.tryGetPrisma = () => prisma;

  const opsDb = require(path.join(ROOT, 'netlify/lib/ops-db'));
  opsDb.setOpsStoreOverride(bookingsStore);
  const repo = require(path.join(ROOT, 'netlify/lib/booking-repository'));
  repo.setBookingStoreOverride(bookingsStore);

  const accessToken = require(path.join(ROOT, 'netlify/lib/appointment-access-token'));
  accessToken.setAppointmentAccessStoreFactories({
    tokenStore: () => tokenStore,
    focusStore: () => focusStore,
  });

  const notif = require(path.join(ROOT, 'netlify/lib/booking-transactional-notifications'));
  notif.setNotificationClaimStoreFactory(() => claimStore);

  const cs = require(path.join(ROOT, 'netlify/lib/customer-session'));
  cs.setCustomerSessionStoreFactory(() => sessionStore);

  const rl = require(path.join(ROOT, 'netlify/lib/public-rate-limit'));
  rl.setPublicRateLimitStoreFactory(() => rateStore);

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (!String(url).includes('api.resend.com')) throw new Error('unexpected_fetch');
    return { ok: true, status: 200, json: async () => ({ id: 'email_1' }) };
  };

  return {
    prisma,
    bookingsStore,
    tokenStore,
    sessionStore,
    accessToken,
    cs,
    accessFn: require(path.join(ROOT, 'netlify/functions/customer-appointment-access')),
    authFn: require(path.join(ROOT, 'netlify/functions/customer-portal-auth')),
    restore() {
      global.fetch = originalFetch;
      opsDb.setOpsStoreOverride(null);
      repo.setBookingStoreOverride(null);
      accessToken.resetAppointmentAccessStoreFactories();
      notif.resetNotificationClaimStoreFactory();
      cs.resetCustomerSessionStoreFactory();
      rl.resetPublicRateLimitStoreFactory();
      bust();
    },
  };
}

function openLink(h, token, cookie) {
  const headers = { 'x-nf-client-connection-ip': '203.0.113.10' };
  if (cookie) headers.cookie = `cd1_customer_session=${cookie}`;
  return h.accessFn.handler({ httpMethod: 'GET', headers, queryStringParameters: { token } });
}

function openShortLink(h, token, cookie) {
  const headers = { 'x-nf-client-connection-ip': '203.0.113.10' };
  if (cookie) headers.cookie = `cd1_customer_session=${cookie}`;
  return h.accessFn.handler({ httpMethod: 'GET', headers, queryStringParameters: { t: token } });
}

function exchange(h, token, cookie) {
  const headers = {
    'x-nf-client-connection-ip': '203.0.113.10',
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (cookie) headers.cookie = `cd1_customer_session=${cookie}`;
  return h.accessFn.handler({
    httpMethod: 'POST',
    headers,
    body: `action=exchange&token=${encodeURIComponent(token)}`,
  });
}

function sessionTokenFrom(response) {
  const setCookie = String(response.headers?.['Set-Cookie'] || '');
  if (!setCookie) return null;
  return setCookie.split(';')[0].split('=').slice(1).join('=');
}

function mint(h, bookingId, extra = {}) {
  return h.accessToken.createAppointmentAccessToken({
    bookingId,
    email: 'owner@example.com',
    phoneDigits: '2015550143',
    eventType: 'booking.request_received',
    ...extra,
  });
}

/* ------------------------------------------------------------------ *
 * Phase 2 — persistent session + same-device re-entry
 * ------------------------------------------------------------------ */

test('1. first click on a secure link creates exactly one session', async (t) => {
  const h = harness({ bookings: { 'CD1-SESS00001': baseBooking({ id: 'CD1-SESS00001' }) } });
  t.after(() => h.restore());

  const minted = await mint(h, 'CD1-SESS00001');

  const preview = await openLink(h, minted.token);
  assert.equal(preview.statusCode, 200);
  assert.match(preview.body, /Open my portal/i);
  assert.match(preview.body, /Open your detailing portal/i);
  assert.match(preview.body, /action" value="exchange"/);
  assert.doesNotMatch(preview.body, /appointment code/i);
  const previewShort = await openShortLink(h, minted.token);
  assert.equal(previewShort.statusCode, 200);
  assert.match(previewShort.body, /Open my portal/i);
  const previewRecord = await h.accessToken.loadTokenRecord(minted.token, {
    allowExpired: true,
    allowConsumed: true,
  });
  assert.equal(previewRecord.record.consumedAt, null, 'GET must not consume the token');

  const res = await exchange(h, minted.token);

  assert.equal(res.statusCode, 302);
  const sessions = [...h.sessionStore._data.keys()].filter((k) => k.startsWith('cs_'));
  assert.equal(sessions.length, 1, 'one session record');
  assert.ok(sessionTokenFrom(res), 'session cookie issued');
});

test('1b. missing, malformed, and tampered tokens are rejected without consuming a live token', async (t) => {
  const h = harness({ bookings: { 'CD1-SESS0001B': baseBooking({ id: 'CD1-SESS0001B' }) } });
  t.after(() => h.restore());

  const minted = await mint(h, 'CD1-SESS0001B');
  const missing = await h.accessFn.handler({
    httpMethod: 'GET',
    headers: { 'x-nf-client-connection-ip': '203.0.113.10' },
    queryStringParameters: {},
  });
  assert.equal(missing.statusCode, 400);
  assert.match(missing.body, /secure link is invalid/i);

  const malformed = await openShortLink(h, 'not-a-token');
  assert.equal(malformed.statusCode, 400);
  assert.match(malformed.body, /secure link is invalid/i);

  const flipped = minted.token.endsWith('A')
    ? `${minted.token.slice(0, -1)}B`
    : `${minted.token.slice(0, -1)}A`;
  const tampered = await openShortLink(h, flipped);
  assert.equal(tampered.statusCode, 400);
  assert.match(tampered.body, /secure link is invalid/i);
  assert.equal(tampered.headers['Set-Cookie'], undefined);

  const stillLive = await h.accessToken.loadTokenRecord(minted.token, {
    allowExpired: true,
    allowConsumed: true,
  });
  assert.equal(stillLive.record.consumedAt, null, 'rejection paths must not consume the real token');

  const preview = await openShortLink(h, minted.token);
  assert.equal(preview.statusCode, 200);
});

test('2. the device session outlives a browser restart (30-day server TTL and cookie)', async (t) => {
  const h = harness({ bookings: { 'CD1-SESS00002': baseBooking({ id: 'CD1-SESS00002' }) } });
  t.after(() => h.restore());

  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  assert.equal(h.cs.SESSION_TTL_MS, THIRTY_DAYS_MS);

  const minted = await mint(h, 'CD1-SESS00002');
  const res = await exchange(h, minted.token);
  const setCookie = String(res.headers['Set-Cookie']);

  // A cookie that outlives its server record would silently resurrect access.
  const maxAge = Number(/Max-Age=(\d+)/.exec(setCookie)[1]);
  assert.equal(maxAge, THIRTY_DAYS_MS / 1000);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);

  const sid = [...h.sessionStore._data.keys()].find((k) => k.startsWith('cs_'));
  const record = await h.sessionStore.get(sid, { type: 'json' });
  assert.ok(record.exp - Date.now() > THIRTY_DAYS_MS - 60_000, 'server record honours the same TTL');
});

test('2b. every https deploy context marks the session cookie Secure', (t) => {
  const original = process.env.CONTEXT;
  const originalDev = process.env.NETLIFY_DEV;
  t.after(() => {
    process.env.CONTEXT = original;
    if (originalDev === undefined) delete process.env.NETLIFY_DEV;
    else process.env.NETLIFY_DEV = originalDev;
  });

  const cs = require('../netlify/lib/customer-session');
  delete process.env.NETLIFY_DEV;
  for (const ctx of ['production', 'branch-deploy', 'deploy-preview']) {
    process.env.CONTEXT = ctx;
    assert.match(cs.sessionCookieHeader('t'), /Secure/, `${ctx} session cookie`);
    assert.match(cs.clearSessionCookieHeader(), /Secure/, `${ctx} logout cookie`);
  }

  // Local `netlify dev` serves over plain http, where Secure would drop the cookie.
  process.env.NETLIFY_DEV = 'true';
  process.env.CONTEXT = 'dev';
  assert.doesNotMatch(cs.sessionCookieHeader('t'), /Secure/);
});

test('3. re-clicking a consumed link on the same device opens the appointment', async (t) => {
  const h = harness({ bookings: { 'CD1-SESS00003': baseBooking({ id: 'CD1-SESS00003' }) } });
  t.after(() => h.restore());

  const minted = await mint(h, 'CD1-SESS00003');
  const first = await exchange(h, minted.token);
  const cookie = sessionTokenFrom(first);

  const second = await exchange(h, minted.token, cookie);
  assert.equal(second.statusCode, 302);
  assert.match(second.headers.Location, /^\/my-garage\?appointment=aptr_/);
  assert.equal(second.headers['Set-Cookie'], undefined, 'no second session is minted');

  const sessions = [...h.sessionStore._data.keys()].filter((k) => k.startsWith('cs_'));
  assert.equal(sessions.length, 1);
});

test('4. re-clicking a consumed link without a session still opens the appointment', async (t) => {
  const h = harness({ bookings: { 'CD1-SESS00004': baseBooking({ id: 'CD1-SESS00004' }) } });
  t.after(() => h.restore());

  const minted = await mint(h, 'CD1-SESS00004');
  await exchange(h, minted.token);

  const second = await exchange(h, minted.token);
  assert.equal(second.statusCode, 302);
  assert.match(second.headers.Location, /^\/my-garage\?appointment=aptr_/);
  assert.ok(sessionTokenFrom(second), 'unexpired spent SMS mints a session when none is present');

  const viaGet = await openLink(h, minted.token);
  assert.equal(viaGet.statusCode, 302);
  assert.ok(sessionTokenFrom(viaGet), 'GET of a spent unexpired link also resumes');
});

test('5. a different account session cannot ride a consumed link', async (t) => {
  const h = harness({
    bookings: {
      'CD1-SESS00005': baseBooking({ id: 'CD1-SESS00005' }),
      'CD1-OTHER0005': baseBooking({
        id: 'CD1-OTHER0005',
        email: 'stranger@example.com',
        phone: '2015550199',
      }),
    },
  });
  t.after(() => h.restore());

  const otherToken = await h.accessToken.createAppointmentAccessToken({
    bookingId: 'CD1-OTHER0005',
    email: 'stranger@example.com',
    phoneDigits: '2015550199',
    eventType: 'booking.request_received',
  });
  const otherSession = sessionTokenFrom(await exchange(h, otherToken.token));
  assert.ok(otherSession);

  const minted = await mint(h, 'CD1-SESS00005');
  await exchange(h, minted.token);

  const attempt = await exchange(h, minted.token, otherSession);
  assert.equal(attempt.statusCode, 410, 'stranger gets the generic new-link page');
  assert.equal(attempt.headers['Set-Cookie'], undefined);
});

test('6. an expired session is replaced by tapping the still-valid SMS link', async (t) => {
  const h = harness({ bookings: { 'CD1-SESS00006': baseBooking({ id: 'CD1-SESS00006' }) } });
  t.after(() => h.restore());

  const minted = await mint(h, 'CD1-SESS00006');
  const cookie = sessionTokenFrom(await exchange(h, minted.token));

  // Server record is authoritative for expiry, so expire it there.
  const sid = [...h.sessionStore._data.keys()].find((k) => k.startsWith('cs_'));
  const record = await h.sessionStore.get(sid, { type: 'json' });
  await h.sessionStore.setJSON(sid, { ...record, exp: Date.now() - 1000 });

  const attempt = await exchange(h, minted.token, cookie);
  assert.equal(attempt.statusCode, 302, 'expired session is replaced via the still-valid SMS link');
  assert.ok(sessionTokenFrom(attempt), 'new session cookie issued');
});

test('7. logout revokes the session; the SMS link still opens the appointment', async (t) => {
  const h = harness({ bookings: { 'CD1-SESS00007': baseBooking({ id: 'CD1-SESS00007' }) } });
  t.after(() => h.restore());

  const minted = await mint(h, 'CD1-SESS00007');
  const cookie = sessionTokenFrom(await exchange(h, minted.token));

  const out = await h.authFn.handler({
    httpMethod: 'POST',
    headers: { cookie: `cd1_customer_session=${cookie}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'logout' }),
  });
  assert.equal(out.statusCode, 200);
  assert.match(String(out.headers['Set-Cookie']), /Max-Age=0/);

  const attempt = await exchange(h, minted.token, cookie);
  assert.equal(attempt.statusCode, 302, 'revoked cookie is ignored; unexpired SMS mints a new session');
  assert.ok(sessionTokenFrom(attempt), 'new session cookie issued after logout');
});

test('8. the raw appointment token stays consumed after reuse', async (t) => {
  const h = harness({ bookings: { 'CD1-SESS00008': baseBooking({ id: 'CD1-SESS00008' }) } });
  t.after(() => h.restore());

  const minted = await mint(h, 'CD1-SESS00008');
  const first = await exchange(h, minted.token);
  assert.ok(sessionTokenFrom(first));

  // Later taps mint a portal session, but they do not consume the token again.
  const second = await exchange(h, minted.token);
  assert.ok(sessionTokenFrom(second), 'spent unexpired link mints a session');
  assert.equal(second.statusCode, 302);

  const record = await h.accessToken.loadTokenRecord(minted.token, {
    allowExpired: true,
    allowConsumed: true,
  });
  assert.ok(record.record.consumedAt, 'token remains consumed');
  assert.equal(record.record.uses, 1);
});

test('9. an expired link also re-enters on the same device, and not otherwise', async (t) => {
  const h = harness({ bookings: { 'CD1-SESS00009': baseBooking({ id: 'CD1-SESS00009' }) } });
  t.after(() => h.restore());

  const live = await mint(h, 'CD1-SESS00009');
  const cookie = sessionTokenFrom(await exchange(h, live.token));

  const stale = await mint(h, 'CD1-SESS00009', { supersede: false });
  const staleRecord = await h.accessToken.loadTokenRecord(stale.token, { allowExpired: true });
  const staleKey = `tok_${String(staleRecord.record.tokenHash).slice(0, 32)}`;
  const stored = await h.tokenStore.get(staleKey, { type: 'json' });
  await h.tokenStore.setJSON(staleKey, {
    ...stored,
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });

  const noSession = await exchange(h, stale.token);
  assert.equal(noSession.statusCode, 410, 'no session: expired page');
  assert.match(noSession.body, /has expired/i);
  assert.doesNotMatch(noSession.body, /already used/i);

  const withSession = await exchange(h, stale.token, cookie);
  assert.equal(withSession.statusCode, 302);
  assert.equal(withSession.headers['Set-Cookie'], undefined);
});

/* ------------------------------------------------------------------ *
 * Phase 3 — Pay Balance direct action
 * ------------------------------------------------------------------ */

function createEl(id) {
  const listeners = {};
  const el = {
    id: id || '',
    hidden: false,
    style: { display: '' },
    textContent: '',
    innerHTML: '',
    value: '',
    disabled: false,
    className: '',
    scrolledIntoView: 0,
    focused: 0,
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, on) {
        if (on === undefined) on = !this._set.has(c);
        if (on) this.add(c); else this.remove(c);
        return on;
      },
      contains(c) { return this._set.has(c); },
    },
    attributes: {},
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k); },
    removeAttribute(k) { delete this.attributes[k]; },
    addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
    removeEventListener() {},
    click() { (listeners.click || []).forEach((fn) => fn({ preventDefault() {}, target: el })); },
    focus() { el.focused += 1; },
    scrollIntoView() { el.scrolledIntoView += 1; },
    reset() {},
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    _listeners: listeners,
  };
  return el;
}

const PORTAL_ELEMENT_IDS = [
  'portal-shell', 'portal-loading', 'portal-loading-status', 'portal-loading-actions',
  'portal-retry', 'portal-return-signin', 'pre-auth', 'post-auth', 'lk-form', 'lk-booking-id',
  'lk-phone', 'lk-error', 'lk-clear', 'acct-form', 'acct-email', 'acct-phone', 'acct-error',
  'btn-logout', 'upcoming-panel', 'appointments-list', 'appointments-empty', 'history-list',
  'history-empty', 'payments-panel', 'payments-empty', 'customer-actions', 'pay-balance-link',
  'portal-toast', 'action-modal', 'modal-form', 'modal-submit', 'modal-cancel', 'modal-error',
  'modal-title', 'profile-section', 'profile-view', 'profile-edit', 'profile-actions',
  'profile-msg', 'addresses-section', 'addresses-list', 'address-form', 'address-actions',
  'address-msg', 'pending-requests-section', 'pending-requests-list', 'maintenance-empty',
  'maintenance-list', 'embedded-pay-panel', 'payment-element', 'embedded-pay-submit',
  'embedded-pay-cancel', 'embedded-pay-checkout-fallback', 'embedded-pay-msg',
  'embedded-pay-amount', 'embedded-pay-h', 'embedded-pay-context', 'pay-sticky-bar',
  'pay-sticky-btn', 'pf-edit-btn', 'pf-cancel', 'pf-save', 'pf-first', 'pf-last', 'pf-display',
  'pf-channel', 'pf-tz', 'ad-add-btn', 'ad-cancel', 'ad-save',
];

function loadPortalSandbox({ routes = {}, stripe } = {}) {
  const els = {};
  PORTAL_ELEMENT_IDS.forEach((id) => { els[id] = createEl(id); });
  els['embedded-pay-panel'].hidden = true;

  const bodyClasses = new Set();
  const document = {
    readyState: 'complete',
    documentElement: {
      classList: {
        _set: new Set(['cd1-portal-booting']),
        add(c) { this._set.add(c); },
        remove(c) { this._set.delete(c); },
        contains(c) { return this._set.has(c); },
      },
    },
    body: {
      classList: {
        add(c) { bodyClasses.add(c); },
        remove(c) { bodyClasses.delete(c); },
        toggle(c, on) {
          if (on === undefined) on = !bodyClasses.has(c);
          if (on) bodyClasses.add(c); else bodyClasses.delete(c);
          return on;
        },
        contains(c) { return bodyClasses.has(c); },
      },
    },
    getElementById(id) { return els[id] || null; },
    addEventListener() {},
  };

  const calls = [];
  const fetchFn = async (url, init) => {
    const body = JSON.parse((init && init.body) || '{}');
    const fn = String(url).split('/').pop().split('?')[0];
    calls.push({ fn, body });
    const handler = routes[fn];
    if (!handler) return { ok: false, status: 404, json: async () => ({ ok: false, error: 'not_found' }) };
    const out = await handler(body);
    const status = out.status != null ? out.status : 200;
    return { ok: status >= 200 && status < 300, status, json: async () => (out.data != null ? out.data : out) };
  };

  const sandbox = {
    window: null, global: null, globalThis: null,
    document,
    location: { search: '', hash: '', pathname: '/my-garage.html', href: 'https://x.test/my-garage.html', origin: 'https://x.test' },
    history: { replaceState() {} },
    sessionStorage: { _m: new Map(), getItem(k) { return this._m.get(k) ?? null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch: fetchFn,
    console,
    matchMedia: () => ({ matches: false }),
    Stripe: stripe,
    setTimeout: (fn) => { void fn; return 0; },
    clearTimeout() {},
    URLSearchParams, JSON, Math, Number, String, Array, Object, Promise, Error, Map, Set,
    parseInt, isNaN, encodeURIComponent, decodeURIComponent,
  };
  sandbox.window = sandbox;
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;

  vm.runInNewContext(read('assets/my-garage.js'), sandbox, { filename: 'my-garage.js' });
  return { sandbox, els, calls, bodyClasses };
}

function stripeStub(counters) {
  return function Stripe() {
    return {
      elements() {
        return {
          create() {
            return {
              mount() { counters.mounts += 1; },
              unmount() { counters.unmounts += 1; },
            };
          },
        };
      },
      confirmPayment: async () => ({ paymentIntent: { status: 'succeeded' } }),
    };
  };
}

function payRoutes(counters) {
  return {
    'customer-balance-payment-intent': () => {
      counters.intents += 1;
      return { data: { ok: true, clientSecret: 'cs_test_123', amountCents: 12500 } };
    },
    'stripe-config': () => ({ data: { publishableKey: 'pk_test_1' } }),
    'customer-portal-data': () => ({ data: { ok: true } }),
  };
}

async function flush(n = 20) {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

test('10. Pay Balance opens the payment section, scrolls to it and moves focus', async () => {
  const counters = { intents: 0, mounts: 0, unmounts: 0 };
  const { sandbox, els } = loadPortalSandbox({ routes: payRoutes(counters), stripe: stripeStub(counters) });

  sandbox.cd1MyGarage.state.booking = { id: 'CD1-PAY00001', service: 'Interior Detail', vehicleYear: 2020, vehicleMake: 'Honda', vehicleModel: 'Civic' };
  sandbox.cd1MyGarage.state.payment = { canPay: true, amountDueApproved: 125, remainingCents: 12500 };

  await sandbox.cd1MyGarage.startPayBalance();
  await flush();

  assert.equal(els['embedded-pay-panel'].hidden, false, 'panel is revealed');
  assert.ok(els['embedded-pay-panel'].scrolledIntoView > 0, 'panel is scrolled into view');
  assert.ok(els['embedded-pay-h'].focused > 0, 'payment heading receives focus');
  assert.equal(counters.mounts, 1);
});

test('11/12. amount context is shown and repeated clicks reuse one PaymentIntent', async () => {
  const counters = { intents: 0, mounts: 0, unmounts: 0 };
  const { sandbox, els } = loadPortalSandbox({ routes: payRoutes(counters), stripe: stripeStub(counters) });

  sandbox.cd1MyGarage.state.booking = { id: 'CD1-PAY00002', service: 'Full Detail', vehicleLabel: '2020 Honda Civic' };
  sandbox.cd1MyGarage.state.payment = { canPay: true, amountDueApproved: 125, remainingCents: 12500 };

  await sandbox.cd1MyGarage.startPayBalance();
  await flush();
  assert.match(els['embedded-pay-context'].textContent, /Balance due: \$125\.00/);
  assert.match(els['embedded-pay-submit'].textContent, /Pay \$125\.00/);

  await sandbox.cd1MyGarage.startPayBalance();
  await sandbox.cd1MyGarage.startPayBalance();
  await flush();

  assert.equal(counters.intents, 1, 'no duplicate PaymentIntent');
  assert.equal(counters.mounts, 1, 'no duplicate Payment Element mount');
  assert.ok(els['embedded-pay-panel'].scrolledIntoView >= 3, 'every click still reveals the panel');
});

test('13. a booking with no balance cannot start a payment', async () => {
  const counters = { intents: 0, mounts: 0, unmounts: 0 };
  const { sandbox, els } = loadPortalSandbox({ routes: payRoutes(counters), stripe: stripeStub(counters) });

  sandbox.cd1MyGarage.state.booking = { id: 'CD1-PAY00003' };
  sandbox.cd1MyGarage.state.payment = { canPay: false, canCreatePayLink: false, state: 'paid', amountDueApproved: 0 };

  await sandbox.cd1MyGarage.startPayBalance();
  await flush();

  assert.equal(counters.intents, 0, 'no PaymentIntent requested');
  assert.equal(els['embedded-pay-panel'].hidden, true);
});

test('14. the mobile sticky Pay CTA follows the authoritative balance', async () => {
  const counters = { intents: 0, mounts: 0, unmounts: 0 };
  const { sandbox, els, bodyClasses } = loadPortalSandbox({ routes: payRoutes(counters), stripe: stripeStub(counters) });

  sandbox.cd1MyGarage.syncPayBalanceButton({ canPay: true, amountDueApproved: 125 });
  assert.equal(els['pay-sticky-bar'].hidden, false);
  assert.match(els['pay-sticky-btn'].textContent, /Pay securely · \$125\.00/);
  assert.ok(bodyClasses.has('pay-sticky-on'));

  sandbox.cd1MyGarage.syncPayBalanceButton({ canPay: false, state: 'paid', amountPaid: 125 });
  assert.equal(els['pay-sticky-bar'].hidden, true);
  assert.ok(!bodyClasses.has('pay-sticky-on'));
});

test('15. payment section carries the accessibility affordances', () => {
  const html = read('my-garage.html');
  assert.match(html, /id="embedded-pay-panel"[^>]*role="region"/);
  assert.match(html, /id="embedded-pay-panel"[^>]*aria-labelledby="embedded-pay-h"/);
  assert.match(html, /id="embedded-pay-msg"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="pay-sticky-bar"/);
  assert.match(read('assets/my-garage.js'), /function revealPaymentPanel/);
});

/* ------------------------------------------------------------------ *
 * Phase 4 — customer portal information hierarchy
 * ------------------------------------------------------------------ */

test('16. the portal is named My Detailing Portal and keeps the /my-garage route', () => {
  const html = read('my-garage.html');
  assert.match(html, /<title>My Detailing Portal \| /);
  assert.match(html, /<h1>My Detailing Portal<\/h1>/);
  assert.doesNotMatch(html, /My Garage/);
  // Route compatibility is what the emails and public nav depend on.
  assert.match(read('netlify.toml'), /\/my-garage/);
  assert.match(read('netlify/lib/appointment-access-token.js'), /\/my-garage\?appointment=/);
});

test('17. operational sections outrank profile in the portal hierarchy', () => {
  const html = read('my-garage.html');
  const order = [
    'id="upcoming-h"',
    'id="appt-h"',
    'id="hist-h"',
    'id="payments"',
    'id="profile-section"',
    'id="addresses-section"',
  ].map((needle) => {
    const at = html.indexOf(needle);
    assert.ok(at > 0, `${needle} present`);
    return at;
  });
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(order[i] > order[i - 1], 'section order is current → upcoming → past → payments → profile → addresses');
  }
  assert.match(html, /<h3 id="upcoming-h">Current appointment<\/h3>/);
  assert.match(html, /<h3 id="appt-h">Upcoming appointments<\/h3>/);
  assert.match(html, /<h3 id="hist-h">Past services<\/h3>/);
});

test('18. every owned appointment stays reachable when one is selected', async () => {
  const counters = { intents: 0, mounts: 0, unmounts: 0 };
  const { sandbox, els } = loadPortalSandbox({ routes: payRoutes(counters), stripe: stripeStub(counters) });

  const current = { id: 'CD1-A', status: 'Pending Review', preferredDate: '2099-05-01', service: 'Interior', appointmentPublicRef: 'aptr_a' };
  const laterUpcoming = { id: 'CD1-B', status: 'Confirmed', preferredDate: '2099-06-01', service: 'Full', appointmentPublicRef: 'aptr_b' };
  const past = { id: 'CD1-C', status: 'Completed', jobStatus: 'completed_paid', preferredDate: '2020-01-01', service: 'Exterior', totalPrice: 250, appointmentPublicRef: 'aptr_c' };

  sandbox.cd1MyGarage.state.scope = 'account';
  sandbox.cd1MyGarage.state.bookings = [current, laterUpcoming, past];
  sandbox.cd1MyGarage.state.booking = current;
  sandbox.cd1MyGarage.renderDashboard({ payment: { canPay: false }, bookings: sandbox.cd1MyGarage.state.bookings });
  await flush();

  assert.match(els['upcoming-panel'].innerHTML, /Interior/, 'selected appointment is expanded');
  // Selection must never remove the others from the page.
  assert.match(els['appointments-list'].innerHTML, /aptr_b/);
  assert.doesNotMatch(els['appointments-list'].innerHTML, /aptr_a/, 'current one is not duplicated in the list');
  assert.match(els['history-list'].innerHTML, /aptr_c/);
  assert.match(els['history-list'].innerHTML, /\$250\.00/);
  assert.match(els['appointments-list'].innerHTML, /View Details/);
});

test('19. the primary action follows the appointment state', async () => {
  const counters = { intents: 0, mounts: 0, unmounts: 0 };
  const { sandbox } = loadPortalSandbox({ routes: payRoutes(counters), stripe: stripeStub(counters) });
  const label = sandbox.cd1MyGarage.primaryActionLabel;

  assert.equal(label({ status: 'Pending Review' }, {}), 'View Request');
  assert.equal(label({ status: 'Confirmed' }, {}), 'View Appointment');
  assert.equal(label({ status: 'Confirmed' }, { canPay: true }), 'Pay securely');
  assert.equal(label({ status: 'Confirmed', jobStatus: 'awaiting_customer_action' }, {}), 'Review Required Action');
  assert.equal(label({ status: 'Paid' }, {}), 'View Details');
  // Portal Lite: no receipt label until receipt authority ships in Slice 3.
  assert.equal(label({ status: 'Completed' }, {}), 'View Details');
});

/* ------------------------------------------------------------------ *
 * Phase 5 — admin review queue
 * ------------------------------------------------------------------ */

test('20. admin jobs board exposes a review queue with live counts', () => {
  const html = read('admin-ops.html');
  assert.match(html, /id="jobsQueueFilters"/);
  assert.match(html, /QUEUE_BUCKETS/);
  assert.match(html, /Pending Review/);
  assert.match(html, /Needs Action/);
  assert.match(html, /function renderQueueFilters/);
  assert.match(html, /qc-count/);
  assert.match(html, /aria-pressed/);
  // Chips must filter the same list the table renders.
  assert.match(html, /const bucket = QUEUE_BUCKETS\.find/);
  assert.match(html, /renderQueueFilters\(\);\s*\r?\n\s*parkActiveDetailRow\(\)/);
});

test('21. compact rows carry a priority indicator without extra requests', () => {
  const html = read('admin-ops.html');
  assert.match(html, /function jobNeedsAttention/);
  assert.match(html, /class="job-warn"/);
  assert.match(html, /job-cell-customer/);
  assert.match(html, /data-label="Balance"/);
  assert.match(html, /data-label="Status"/);
});

test('22. admin review is usable on a phone', () => {
  const html = read('admin-ops.html');
  const mobile = html.slice(html.indexOf('@media(max-width:700px)'));
  assert.match(mobile, /#jobsTable tr\.job-row\{[^}]*border-radius/, 'rows become cards');
  assert.match(mobile, /#jobsTable thead\{[^}]*clip:rect\(0 0 0 0\)/, 'table headers are visually hidden');
  assert.match(mobile, /job-sticky-actions/);
  assert.match(html, /class="job-sticky-actions" id="dStickyActions"/);
  assert.match(html, /id="dStickyConfirm"/);
  assert.match(html, /id="dStickyEdit"/);
  assert.match(html, /id="dStickyDecline"/);
  assert.match(html, /function bindStickyJobActions/);
});

test('23. confirmation cannot be double-submitted from the browser', () => {
  const html = read('admin-ops.html');
  assert.match(html, /let confirmInFlight = null/);
  assert.match(html, /async function confirmBookingOnce/);
  assert.match(html, /if \(!bookingId \|\| confirmInFlight\) return;/);
  assert.match(html, /list\.forEach\(b => \{ b\.disabled = true; \}\)/);
  assert.match(html, /confirmBookingOnce\(j\.id, \[dc, stickyConfirm\]\)/);
  // Server-side CAS + single-send ledger stay the real guarantee.
  assert.match(read('netlify/lib/booking-confirm.js'), /expectedBookingVersion/);
});

/* ------------------------------------------------------------------ *
 * Phase 6 — no scope expansion
 * ------------------------------------------------------------------ */

test('24. no deferred product surfaces were introduced', () => {
  const html = read('my-garage.html');
  const js = read('assets/my-garage.js');
  assert.doesNotMatch(html, /Vehicle History|Book Again|id="vehicles-list"|Saved Vehicles/i);
  assert.doesNotMatch(js, /vehicleHistory|bookAgain|recurringService/i);
  assert.doesNotMatch(js, /customer-portal-vehicles/);
  // Twilio stays SMS-ready but off.
  assert.doesNotMatch(html, /twilio/i);
});
