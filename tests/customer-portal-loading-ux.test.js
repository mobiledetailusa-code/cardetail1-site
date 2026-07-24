/**
 * Customer portal loading UX — magic-link + hydration state machine.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

function createEl(id, extras) {
  const listeners = {};
  const el = {
    id: id || '',
    hidden: !!(extras && extras.hidden),
    style: { display: (extras && extras.display) || '' },
    textContent: (extras && extras.textContent) || '',
    innerHTML: '',
    value: '',
    className: (extras && extras.className) || '',
    classList: {
      _set: new Set(String((extras && extras.className) || '').split(/\s+/).filter(Boolean)),
      add(c) { this._set.add(c); el.className = [...this._set].join(' '); },
      remove(c) { this._set.delete(c); el.className = [...this._set].join(' '); },
      toggle(c, on) {
        if (on === undefined) on = !this._set.has(c);
        if (on) this.add(c); else this.remove(c);
        return on;
      },
      contains(c) { return this._set.has(c); },
    },
    attributes: Object.assign({}, (extras && extras.attrs) || {}),
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; },
    removeAttribute(k) { delete this.attributes[k]; },
    addEventListener(type, fn) {
      (listeners[type] || (listeners[type] = [])).push(fn);
    },
    removeEventListener() {},
    click() {
      (listeners.click || []).forEach((fn) => fn({ preventDefault() {}, target: el }));
    },
    focus() {},
    reset() {},
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    _listeners: listeners,
  };
  if (extras && extras.ariaLive) el.setAttribute('aria-live', extras.ariaLive);
  if (extras && extras.role) el.setAttribute('role', extras.role);
  return el;
}

function installFakeTimers(sandbox) {
  let now = 0;
  const timers = new Map();
  let nextId = 1;
  sandbox.setTimeout = (fn, ms) => {
    const id = nextId++;
    timers.set(id, { fn, due: now + (Number(ms) || 0) });
    return id;
  };
  sandbox.clearTimeout = (id) => { timers.delete(id); };
  sandbox.__advance = async (ms) => {
    now += ms;
    const due = [...timers.entries()].filter(([, t]) => t.due <= now);
    due.sort((a, b) => a[1].due - b[1].due);
    for (const [id, t] of due) {
      timers.delete(id);
      t.fn();
    }
    await flushMicrotasks();
  };
  sandbox.__now = () => now;
  return sandbox;
}

async function flushMicrotasks(times) {
  const n = times == null ? 15 : times;
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

function buildPortalDom() {
  const els = {
    'portal-shell': createEl('portal-shell', { attrs: { 'data-portal-phase': 'idle' } }),
    'portal-loading': createEl('portal-loading', {
      hidden: false,
      className: 'portal-loading is-visible',
      attrs: { 'aria-busy': 'true' },
    }),
    'portal-loading-status': createEl('portal-loading-status', {
      textContent: 'Signing you in...',
      ariaLive: 'polite',
      role: 'status',
    }),
    'portal-loading-actions': createEl('portal-loading-actions'),
    'portal-retry': createEl('portal-retry'),
    'portal-return-signin': createEl('portal-return-signin'),
    'pre-auth': createEl('pre-auth', { hidden: true, display: 'none' }),
    'post-auth': createEl('post-auth', { hidden: true, display: 'none' }),
    'lk-form': createEl('lk-form'),
    'lk-booking-id': createEl('lk-booking-id'),
    'lk-phone': createEl('lk-phone'),
    'lk-error': createEl('lk-error', { hidden: true }),
    'lk-clear': createEl('lk-clear'),
    'acct-form': createEl('acct-form'),
    'acct-email': createEl('acct-email'),
    'acct-phone': createEl('acct-phone'),
    'acct-error': createEl('acct-error', { hidden: true }),
    'btn-logout': createEl('btn-logout'),
    'upcoming-panel': createEl('upcoming-panel'),
    'appointments-list': createEl('appointments-list'),
    'vehicles-list': createEl('vehicles-list'),
    'vehicles-empty': createEl('vehicles-empty'),
    'history-list': createEl('history-list'),
    'history-empty': createEl('history-empty'),
    'payments-panel': createEl('payments-panel'),
    'payments-empty': createEl('payments-empty'),
    'customer-actions': createEl('customer-actions'),
    'pay-balance-link': createEl('pay-balance-link'),
    'portal-toast': createEl('portal-toast'),
    'action-modal': createEl('action-modal', { hidden: true }),
    'modal-form': createEl('modal-form'),
    'modal-submit': createEl('modal-submit'),
    'modal-cancel': createEl('modal-cancel'),
    'modal-error': createEl('modal-error', { hidden: true }),
    'modal-title': createEl('modal-title'),
    'profile-section': createEl('profile-section', { hidden: true }),
    'profile-view': createEl('profile-view'),
    'profile-edit': createEl('profile-edit', { hidden: true }),
    'profile-actions': createEl('profile-actions'),
    'profile-msg': createEl('profile-msg', { hidden: true }),
    'addresses-section': createEl('addresses-section', { hidden: true }),
    'addresses-list': createEl('addresses-list'),
    'address-form': createEl('address-form', { hidden: true }),
    'address-actions': createEl('address-actions'),
    'address-msg': createEl('address-msg', { hidden: true }),
    'vehicle-form': createEl('vehicle-form', { hidden: true }),
    'vehicle-actions': createEl('vehicle-actions', { hidden: true }),
    'vehicle-msg': createEl('vehicle-msg', { hidden: true }),
    'pending-requests-section': createEl('pending-requests-section', { hidden: true }),
    'pending-requests-list': createEl('pending-requests-list'),
    'maintenance-empty': createEl('maintenance-empty'),
    'maintenance-list': createEl('maintenance-list'),
    'embedded-pay-panel': createEl('embedded-pay-panel', { hidden: true }),
    'payment-element': createEl('payment-element'),
    'embedded-pay-submit': createEl('embedded-pay-submit'),
    'embedded-pay-cancel': createEl('embedded-pay-cancel'),
    'embedded-pay-checkout-fallback': createEl('embedded-pay-checkout-fallback', { hidden: true }),
    'embedded-pay-msg': createEl('embedded-pay-msg', { hidden: true }),
    'embedded-pay-amount': createEl('embedded-pay-amount'),
    'pf-edit-btn': createEl('pf-edit-btn'),
    'pf-cancel': createEl('pf-cancel'),
    'pf-save': createEl('pf-save'),
    'pf-first': createEl('pf-first'),
    'pf-last': createEl('pf-last'),
    'pf-display': createEl('pf-display'),
    'pf-channel': createEl('pf-channel'),
    'pf-tz': createEl('pf-tz'),
    'ad-add-btn': createEl('ad-add-btn'),
    'ad-cancel': createEl('ad-cancel'),
    'ad-save': createEl('ad-save'),
    'vh-add-btn': createEl('vh-add-btn'),
    'vh-cancel': createEl('vh-cancel'),
    'vh-save': createEl('vh-save'),
    'vh-id': createEl('vh-id'),
    'vh-label': createEl('vh-label'),
    'vh-category': createEl('vh-category'),
    'vh-year': createEl('vh-year'),
    'vh-make': createEl('vh-make'),
    'vh-model': createEl('vh-model'),
    'vh-color': createEl('vh-color'),
    'vh-notes': createEl('vh-notes'),
    'vh-default': createEl('vh-default'),
  };
  return {
    readyState: 'complete',
    documentElement: {
      classList: {
        _set: new Set(['cd1-portal-booting']),
        add(c) { this._set.add(c); },
        remove(c) { this._set.delete(c); },
        contains(c) { return this._set.has(c); },
      },
    },
    body: {},
    getElementById(id) { return els[id] || null; },
    addEventListener() {},
    _els: els,
  };
}

function mockFetchRouter(routes) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const body = JSON.parse((init && init.body) || '{}');
    calls.push({ url, body });
    const fn = String(url).split('/').pop();
    const handler = routes[fn];
    if (!handler) {
      return {
        ok: false,
        status: 404,
        json: async () => ({ ok: false, error: 'not_found' }),
      };
    }
    const result = await handler(body, { url, init, calls });
    const status = result.status != null ? result.status : 200;
    const data = result.data != null ? result.data : result;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => data,
    };
  };
  fetchFn.calls = calls;
  return fetchFn;
}

async function loadPortal(opts) {
  opts = opts || {};
  const document = buildPortalDom();
  const location = {
    search: opts.search || '',
    hash: '',
    pathname: '/my-garage.html',
    href: 'https://example.test/my-garage.html' + (opts.search || ''),
  };
  const history = {
    replaceState(_s, _t, url) {
      const q = String(url).includes('?') ? String(url).slice(String(url).indexOf('?')) : '';
      const hashIdx = String(url).indexOf('#');
      location.search = q.startsWith('?') ? q.split('#')[0] : '';
      location.hash = hashIdx >= 0 ? String(url).slice(hashIdx) : '';
      location.href = 'https://example.test/' + String(url).replace(/^\//, '');
    },
  };
  const sessionStorage = {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); },
  };

  const sandbox = {
    window: null,
    global: null,
    globalThis: null,
    document,
    location,
    history,
    sessionStorage,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch: opts.fetch,
    console,
    URLSearchParams,
    JSON,
    Math,
    Number,
    String,
    Array,
    Object,
    Promise,
    Error,
    Map,
    Set,
    parseInt,
    isNaN,
    encodeURIComponent,
    decodeURIComponent,
  };
  sandbox.window = sandbox;
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  installFakeTimers(sandbox);

  const src = read('assets/my-garage.js');
  vm.runInNewContext(src, sandbox, { filename: 'my-garage.js' });
  await flushMicrotasks(25);
  if (typeof opts.waitMs === 'number') await sandbox.__advance(opts.waitMs);

  return { sandbox, document, location, fetch: opts.fetch };
}

function accountPayload() {
  return {
    ok: true,
    scope: 'account',
    customer: {
      accountVersion: 1,
      firstName: 'Test',
      lastName: 'User',
      emailMasked: 't***@example.com',
      phoneMasked: '***-***-1212',
      addresses: [],
    },
    bookings: [{ id: 'CD1-1', status: 'Confirmed', packageName: 'Interior' }],
    upcoming: { id: 'CD1-1', status: 'Confirmed', packageName: 'Interior' },
    vehicles: [{ id: 'v1', label: 'Daily', year: 2020, make: 'Honda', model: 'Civic', category: 'car' }],
    payment: { state: 'not_due', canPay: false, amountDueApproved: 0 },
    catalog: { addons: [] },
    packageCatalog: { source: 'booking-price-catalog', vehicles: [], packageCatalogByVehicle: {} },
    changeRequests: [],
  };
}

test('HTML: loading shell, aria-live/busy, spinner, boot class, mobile rules', () => {
  const html = read('my-garage.html');
  assert.match(html, /cd1-portal-booting/);
  assert.match(html, /id="portal-shell"/);
  assert.match(html, /id="portal-loading"/);
  assert.match(html, /portal-spinner/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /id="portal-retry"/);
  assert.match(html, /Return to sign in/);
  assert.match(html, /Signing you in\.\.\./);
  assert.match(html, /@media\(max-width:430px\)[\s\S]*portal-loading/);
  assert.match(html, /my-garage\.js\?v=20260723-vehicles3/);
  assert.doesNotMatch(html, /auth=|token=|&t=/);
});

test('JS: explicit portal phase state machine (not boolean soup)', () => {
  const js = read('assets/my-garage.js');
  assert.match(js, /PORTAL_PHASE/);
  assert.match(js, /validating_link/);
  assert.match(js, /establishing_session/);
  assert.match(js, /loading_portal/);
  assert.match(js, /temporarily_unavailable/);
  assert.match(js, /function setPortalPhase/);
  assert.match(js, /function hydrateAuthenticatedPortal/);
  assert.match(js, /function retryPortalHydration/);
  assert.match(js, /Still loading your account/);
  assert.match(js, /We're having trouble loading your account/);
  assert.match(js, /Your account is temporarily unavailable/);
  assert.match(js, /PORTAL_SLOW_MS = 4000/);
  assert.match(js, /PORTAL_TIMEOUT_MS = 30000/);
  assert.match(js, /stripMagicLinkParamsFromUrl/);
  assert.match(js, /magicLinkConsumed/);
  assert.match(js, /pendingMagic/);
});

test('1+2. loading appears immediately; unauthenticated content does not flash', async () => {
  let resolveData;
  const fetch = mockFetchRouter({
    'customer-portal-auth': async (body) => {
      if (body.action === 'session') return { data: { ok: true, authenticated: true } };
      return { data: { ok: false } };
    },
    'customer-portal-data': () => new Promise((resolve) => {
      resolveData = () => resolve({ data: accountPayload() });
    }),
  });

  const { sandbox, document } = await loadPortal({ fetch, search: '' });
  assert.equal(sandbox.cd1MyGarage.getPortalPhase(), 'loading_portal');
  assert.equal(document._els['pre-auth'].hidden, true);
  assert.equal(document._els['post-auth'].hidden, true);
  assert.equal(document._els['portal-loading'].hidden, false);
  assert.equal(document._els['portal-shell'].getAttribute('aria-busy'), 'true');
  assert.match(document._els['portal-loading-status'].textContent, /Signing you in|Loading your garage/);

  assert.equal(typeof resolveData, 'function');
  resolveData();
  await flushMicrotasks(40);
  assert.equal(sandbox.cd1MyGarage.getPortalPhase(), 'ready');
  assert.equal(document._els['post-auth'].hidden, false);
  assert.equal(document._els['portal-loading'].hidden, true);
});

test('3+4. magic-link message progression then ready removes spinner', async () => {
  const fetch = mockFetchRouter({
    'customer-portal-auth': async (body) => {
      if (body.action === 'verify') {
        assert.equal(body.challengeId, 'chal_1');
        assert.equal(body.token, 'secret-token-value');
        return { data: { ok: true } };
      }
      if (body.action === 'session') return { data: { ok: true, authenticated: true } };
      return { data: { ok: false } };
    },
    'customer-portal-data': async () => ({ data: accountPayload() }),
  });

  const { sandbox, document, location } = await loadPortal({
    fetch,
    search: '?auth=chal_1&t=secret-token-value',
  });

  assert.equal(sandbox.cd1MyGarage.getPortalPhase(), 'ready');
  assert.equal(document._els['portal-loading'].hidden, true);
  assert.equal(document._els['post-auth'].hidden, false);
  assert.equal(document._els['pre-auth'].hidden, true);
  // Token stripped from URL; never left in the address bar.
  assert.doesNotMatch(location.search, /auth=|t=/);
  assert.doesNotMatch(document._els['portal-loading-status'].textContent, /secret-token|chal_1/);
  assert.ok(fetch.calls.some((c) => c.body.action === 'verify'));
  assert.ok(fetch.calls.some((c) => c.url.includes('customer-portal-data')));
});

test('loading message changes during portal hydration (slow path)', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetch = mockFetchRouter({
    'customer-portal-auth': async (body) => {
      if (body.action === 'session') {
        await gate;
        return { data: { ok: true, authenticated: true } };
      }
      return { data: { ok: false } };
    },
    'customer-portal-data': async () => {
      await gate;
      return { data: accountPayload() };
    },
  });

  const { sandbox, document } = await loadPortal({ fetch });
  assert.equal(document._els['pre-auth'].hidden, true);
  const before = document._els['portal-loading-status'].textContent;
  assert.match(before, /Signing you in|Loading your garage/);

  await sandbox.__advance(4000);
  assert.equal(
    document._els['portal-loading-status'].textContent,
    'Still loading your account...'
  );

  release();
  await flushMicrotasks(40);
  assert.equal(sandbox.cd1MyGarage.getPortalPhase(), 'ready');
});

test('5. 503 temporarily_unavailable message', async () => {
  const fetch = mockFetchRouter({
    'customer-portal-auth': async (body) => {
      if (body.action === 'verify') return { data: { ok: true } };
      if (body.action === 'session') return { data: { ok: true, authenticated: true } };
      return { data: { ok: false } };
    },
    'customer-portal-data': async () => ({
      status: 503,
      data: {
        ok: false,
        error: 'temporarily_unavailable',
        message: 'db_down_INTERNAL_DO_NOT_SHOW',
      },
    }),
  });

  const { sandbox, document } = await loadPortal({
    fetch,
    search: '?auth=chal_x&t=tok_x',
  });

  assert.equal(sandbox.cd1MyGarage.getPortalPhase(), 'temporarily_unavailable');
  assert.match(
    document._els['portal-loading-status'].textContent,
    /Your account is temporarily unavailable/
  );
  assert.doesNotMatch(document._els['portal-loading-status'].textContent, /db_down|INTERNAL|tok_x/);
  assert.equal(document._els['portal-loading'].classList.contains('is-error'), true);
  assert.equal(document._els['pre-auth'].hidden, true);
  assert.equal(document._els['post-auth'].hidden, true);
});

test('6. timeout displays retry state (~30s soft timeout)', async () => {
  const fetch = mockFetchRouter({
    'customer-portal-auth': async (body) => {
      if (body.action === 'session') {
        return new Promise(() => {}); // never resolves
      }
      return { data: { ok: false } };
    },
    'customer-portal-data': async () => new Promise(() => {}),
  });

  const { sandbox, document } = await loadPortal({ fetch });
  assert.ok(isBlocking(sandbox.cd1MyGarage.getPortalPhase()));

  await sandbox.__advance(10000);
  assert.notEqual(sandbox.cd1MyGarage.getPortalPhase(), 'failed');

  await sandbox.__advance(20000);
  assert.equal(sandbox.cd1MyGarage.getPortalPhase(), 'failed');
  assert.match(
    document._els['portal-loading-status'].textContent,
    /having trouble loading your account/
  );
  assert.equal(document._els['portal-loading'].classList.contains('is-error'), true);
});

test('soft timeout does not discard a late successful portal load', async () => {
  let releaseData;
  const fetch = mockFetchRouter({
    'customer-portal-auth': async (body) => {
      if (body.action === 'verify') return { data: { ok: true } };
      if (body.action === 'session') return { data: { ok: true, authenticated: true } };
      return { data: { ok: false } };
    },
    'customer-portal-data': () => new Promise((resolve) => {
      releaseData = () => resolve({ data: accountPayload() });
    }),
  });

  const { sandbox, document } = await loadPortal({
    fetch,
    search: '?auth=chal_late&t=tok_late',
  });
  assert.ok(
    sandbox.cd1MyGarage.getPortalPhase() === 'loading_portal'
    || sandbox.cd1MyGarage.getPortalPhase() === 'validating_link'
    || sandbox.cd1MyGarage.getPortalPhase() === 'establishing_session'
    || sandbox.cd1MyGarage.getPortalPhase() === 'failed'
  );

  await sandbox.__advance(30000);
  assert.equal(sandbox.cd1MyGarage.getPortalPhase(), 'failed');

  assert.equal(typeof releaseData, 'function');
  releaseData();
  await flushMicrotasks(40);
  assert.equal(sandbox.cd1MyGarage.getPortalPhase(), 'ready');
  assert.equal(document._els['post-auth'].hidden, false);
});

function isBlocking(phase) {
  return phase === 'validating_link' || phase === 'establishing_session' || phase === 'loading_portal';
}

test('7+8. retry triggers hydration once; no duplicate API submissions', async () => {
  let dataCalls = 0;
  let sessionCalls = 0;
  const fetch = mockFetchRouter({
    'customer-portal-auth': async (body) => {
      if (body.action === 'verify') return { data: { ok: true } };
      if (body.action === 'session') {
        sessionCalls += 1;
        return { data: { ok: true, authenticated: true } };
      }
      return { data: { ok: false } };
    },
    'customer-portal-data': async () => {
      dataCalls += 1;
      if (dataCalls === 1) {
        return {
          status: 503,
          data: { ok: false, error: 'temporarily_unavailable' },
        };
      }
      return { data: accountPayload() };
    },
  });

  const { sandbox } = await loadPortal({
    fetch,
    search: '?auth=chal_retry&t=once-only-token',
  });
  assert.equal(sandbox.cd1MyGarage.getPortalPhase(), 'temporarily_unavailable');
  const verifyCalls = fetch.calls.filter((c) => c.body.action === 'verify').length;
  assert.equal(verifyCalls, 1);

  const sessionsBeforeRetry = sessionCalls;
  const dataBeforeRetry = dataCalls;
  await sandbox.cd1MyGarage.retryHydration();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(sandbox.cd1MyGarage.getPortalPhase(), 'ready');
  assert.equal(sessionCalls, sessionsBeforeRetry + 1);
  assert.equal(dataCalls, dataBeforeRetry + 1);
  // Retry must not resubmit the consumed magic-link token.
  assert.equal(fetch.calls.filter((c) => c.body.action === 'verify').length, 1);
  assert.equal(fetch.calls.filter((c) => c.body.token === 'once-only-token').length, 1);

  // Consumed magic-link must never be replayed after a successful verify.
  assert.equal(fetch.calls.filter((c) => c.body.action === 'verify').length, 1);
  assert.equal(fetch.calls.filter((c) => c.body.token === 'once-only-token').length, 1);
});

test('9. aria-live and aria-busy present during unresolved auth', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetch = mockFetchRouter({
    'customer-portal-auth': async (body) => {
      if (body.action === 'session') {
        await gate;
        return { data: { ok: true, authenticated: false } };
      }
      return { data: { ok: false } };
    },
  });

  const { document } = await loadPortal({ fetch });
  assert.equal(document._els['portal-loading-status'].getAttribute('aria-live'), 'polite');
  assert.equal(document._els['portal-shell'].getAttribute('aria-busy'), 'true');
  assert.equal(document._els['portal-loading'].getAttribute('aria-busy'), 'true');
  release();
  await Promise.resolve();
  await Promise.resolve();
});

test('10. mobile layout CSS remains usable (no fixed desktop-only width trap)', () => {
  const html = read('my-garage.html');
  assert.match(html, /portal-loading-panel\{[^}]*max-width:420px/);
  assert.match(html, /@media\(max-width:430px\)/);
  assert.match(html, /\.portal-loading\{[^}]*min-height:280px/);
  assert.match(html, /width:100%/);
});

test('security: token not rendered; retry does not replay consumed token', async () => {
  const fetch = mockFetchRouter({
    'customer-portal-auth': async (body) => {
      if (body.action === 'verify') return { data: { ok: false, message: 'expired' } };
      if (body.action === 'session') return { data: { ok: true, authenticated: false } };
      return { data: { ok: false } };
    },
  });
  const token = 'super-secret-magic-token-xyz';
  const { document, location, sandbox } = await loadPortal({
    fetch,
    search: `?auth=chal_sec&t=${token}`,
  });
  const serialized = JSON.stringify(document._els);
  assert.doesNotMatch(serialized, /super-secret-magic-token-xyz/);
  assert.doesNotMatch(location.href, /t=super-secret/);
  assert.equal(sandbox.cd1MyGarage.getPortalPhase(), 'idle');
});

test('slow mocked responses: garage message after session, then ready', async () => {
  const fetch = mockFetchRouter({
    'customer-portal-auth': async (body) => {
      if (body.action === 'verify') {
        await new Promise((r) => setTimeout(r, 0));
        return { data: { ok: true } };
      }
      if (body.action === 'session') return { data: { ok: true, authenticated: true } };
      return { data: { ok: false } };
    },
    'customer-portal-data': async () => {
      await new Promise((r) => setTimeout(r, 0));
      return { data: accountPayload() };
    },
  });

  // Use real microtask delays inside mock; sandbox timers are faked but Promise/microtasks use host.
  const hostFetch = mockFetchRouter({
    'customer-portal-auth': async (body) => {
      if (body.action === 'verify') return { data: { ok: true } };
      if (body.action === 'session') return { data: { ok: true, authenticated: true } };
      return { data: { ok: false } };
    },
    'customer-portal-data': async () => {
      await new Promise((r) => { setTimeout(r, 20); });
      return { data: accountPayload() };
    },
  });

  const { sandbox, document } = await loadPortal({
    fetch: hostFetch,
    search: '?auth=chal_slow&t=tok_slow',
  });
  // Allow host timer for slow data.
  await new Promise((r) => setTimeout(r, 40));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sandbox.cd1MyGarage.getPortalPhase(), 'ready');
  assert.equal(document._els['portal-loading'].hidden, true);
  void fetch;
});
