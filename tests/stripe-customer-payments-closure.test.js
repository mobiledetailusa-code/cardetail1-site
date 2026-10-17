'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('node:child_process');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const {
  FLAG,
  CUSTOMER_BOOKING_COPY,
  GARAGE_COPY,
  SANDBOX_BAKE,
  customerPaymentsPolicy,
  productionCustomerPaymentsBlocked,
  setBakedCustomerPaymentsSnapshot,
  clearBakedCustomerPaymentsSnapshot,
} = require('../netlify/lib/stripe-customer-payments');
const { buildDeployRuntimeSnapshot, renderDeployRuntimeModule } = require('../scripts/generate-deploy-runtime-env');

const BOOKING_PAGES = [
  'index.html',
  'bergen-county-hub.html',
  'hudson-county-hub.html',
  'essex-county-hub.html',
  'passaic-county-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
  'new-jersey-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'template-city.html',
];

const ORIGINAL_ENV = {
  CONTEXT: process.env.CONTEXT,
  NETLIFY_CONTEXT: process.env.NETLIFY_CONTEXT,
  [FLAG]: process.env[FLAG],
};

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

test.afterEach(() => {
  clearBakedCustomerPaymentsSnapshot();
  restoreEnv();
});

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function bookingDom(file) {
  const css = read('assets/booking-review.css');
  const html = read(file).replace('</head>', () => `<style>${css}</style></head>`);
  const dom = new JSDOM(html, { url: 'https://cardetail1.com/', runScripts: 'outside-only' });
  vm.runInContext(read('assets/booking-review-runtime.js'), dom.getInternalVMContext());
  return dom;
}

function tabbable(doc) {
  return [...doc.querySelectorAll('button, a[href], input, select, textarea')].filter((el) => {
    if (el.hidden || el.disabled) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (el.tabIndex < 0) return false;
    const display = doc.defaultView.getComputedStyle(el).display;
    return display !== 'none';
  });
}

test('the hidden card-online control is display none, inert, and out of tab order', () => {
  const css = read('assets/booking-review.css');
  assert.match(css, /\.bk-pay-pref \.pay-choice\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  for (const file of ['index.html', 'template-city.html', 'bergen-county-hub.html']) {
    const dom = bookingDom(file);
    const w = dom.window;
    w.ST = { payMethod: 'card_online', cardOnFileSaved: true, cardSetupConfirmed: true };
    w.Cardetail1BookingReview.install(w);
    const online = w.document.getElementById('pc-online');
    assert.equal(w.getComputedStyle(online).display, 'none', file);
    assert.equal(online.hidden, true, file);
    assert.equal(online.disabled, true, file);
    assert.equal(online.getAttribute('aria-hidden'), 'true', file);
    assert.equal(online.tabIndex, -1, file);
    assert.equal(online.getAttribute('onclick'), null, file);
    assert.equal(online.onclick, null, file);
    assert.equal(tabbable(w.document).includes(online), false, file);
    assert.equal(tabbable(w.document).some((el) => el.id === 'pc-onsite'), true, file);
    assert.equal(tabbable(w.document).some((el) => el.id === 'pc-cash'), true, file);
    assert.equal(w.document.getElementById('bk-customer-pay-note').textContent, CUSTOMER_BOOKING_COPY);
    assert.equal(w.ST.payMethod, '');
  }
});

test('synced booking pages share one inert card-online control and do not load Stripe.js', () => {
  const canonical = read('index.html').match(/<button[^>]*id="pc-online"[^>]*>[\s\S]*?<\/button>/)[0];
  assert.match(canonical, /hidden/);
  assert.match(canonical, /disabled/);
  assert.match(canonical, /aria-hidden="true"/);
  assert.match(canonical, /tabindex="-1"/);
  assert.doesNotMatch(canonical, /onclick=/);
  for (const file of BOOKING_PAGES) {
    const html = read(file);
    const button = html.match(/<button[^>]*id="pc-online"[^>]*>[\s\S]*?<\/button>/)[0];
    assert.equal(button, canonical, file);
    assert.doesNotMatch(html, /<script[^>]+js\.stripe\.com/, file);
    assert.doesNotMatch(html, /rel="(?:preconnect|preload)"[^>]+stripe/i, file);
    assert.doesNotMatch(html, /<iframe[^>]+stripe/i, file);
    assert.doesNotMatch(html, /Pay Online in My Garage/, file);
  }
  const check = spawnSync(process.execPath, ['scripts/sync-booking-conversion-pages.js', '--check'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(check.status, 0, check.stderr || check.stdout);
});

test('a closed stripe-config response never inserts Stripe.js', async () => {
  const cases = [
    { customerPaymentsEnabled: false, publishableKey: 'pk_test_closed' },
    null,
    { customerPaymentsEnabled: 'true', publishableKey: 'pk_test_closed' },
  ];
  for (const payload of cases) {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      url: 'https://cardetail1.com/',
      runScripts: 'outside-only',
    });
    const w = dom.window;
    w.fetch = async () => ({
      headers: { get: () => 'application/json' },
      json: async () => payload,
    });
    vm.runInContext(read('assets/customer-payments-gate.js'), dom.getInternalVMContext());
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(w.document.querySelector('script[src*="js.stripe.com"]'), null, JSON.stringify(payload));
    assert.equal(w.document.querySelector('iframe'), null);
  }

  const bad = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://cardetail1.com/',
    runScripts: 'outside-only',
  });
  bad.window.fetch = async () => ({
    headers: { get: () => 'text/html' },
    json: async () => { throw new Error('not json'); },
  });
  vm.runInContext(read('assets/customer-payments-gate.js'), bad.getInternalVMContext());
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(bad.window.document.querySelector('script[src*="js.stripe.com"]'), null);

  const hung = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://cardetail1.com/',
    runScripts: 'outside-only',
  });
  hung.window.fetch = () => new Promise(() => {});
  vm.runInContext(read('assets/customer-payments-gate.js'), hung.getInternalVMContext());
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(hung.window.document.querySelector('script[src*="js.stripe.com"]'), null);
});

test('public copy does not promise online card payment while the gate is closed', () => {
  const garage = read('my-garage.html');
  assert.match(garage, /Online payment is temporarily unavailable\. Pay at your appointment or contact us for a secure invoice\./);
  assert.doesNotMatch(garage, /Payment Element/);
  assert.doesNotMatch(garage, /Pay securely stays there/);
  assert.doesNotMatch(garage, /<script[^>]+js\.stripe\.com/);
  const expect = read('mobile-detailing-what-to-expect.html');
  assert.match(expect, /Nothing is charged when you book\. Pay by card or cash at your appointment\./);
  assert.doesNotMatch(expect, /pay online in My Garage/i);
  assert.doesNotMatch(expect, /Pay Online in My Garage/);
  const terms = read('terms-conditions.html');
  assert.match(terms, /does not guarantee an appointment/i);
  assert.match(terms, /No card or payment method is required to submit an initial booking request/i);
  assert.match(terms, /Optional saved-card authorization/i);
  assert.match(terms, /handled securely by Stripe/i);
  assert.doesNotMatch(terms, /Card online — charged after service/);
  assert.doesNotMatch(terms, /Pay Online/);
  assert.doesNotMatch(terms, /Payment Element/);
  assert.match(terms, /not reclassified as cash/);
});

test('My Garage with and without a balance stays closed and does not load Stripe.js', async () => {
  process.env.CONTEXT = 'production';
  delete process.env[FLAG];
  process.env.CD1_POSTGRES_PAYMENT = '0';
  const portalPath = require.resolve('../netlify/functions/customer-portal-data');
  delete require.cache[portalPath];
  const portal = require('../netlify/functions/customer-portal-data');
  const due = {
    id: 'CD1-GARAGE-ZERO',
    status: 'Confirmed',
    jobStatus: 'confirmed',
    appointmentStatus: 'confirmed',
    paymentStatus: 'none',
    isDraft: false,
    totalPrice: 0,
    approvedFinalAmount: 0,
    amountPaid: 0,
    ledger: { currency: 'usd', approvedCents: 0, settledCents: 0, creditedCents: 0, entries: [] },
  };
  const before = JSON.stringify(due);
  const pay = await portal.__test.safePaymentStateAsync(due);
  assert.equal(JSON.stringify(due), before);
  assert.equal(pay.canPay, false);
  assert.equal(pay.customerPaymentsUnavailable, true);
  assert.equal(pay.customerPaymentsMessage, GARAGE_COPY);

  const dom = new JSDOM(read('my-garage.html'), { url: 'https://cardetail1.com/my-garage.html', runScripts: 'outside-only' });
  vm.runInContext(read('assets/my-garage.js'), dom.getInternalVMContext());
  const w = dom.window;
  w.cd1MyGarage.state.booking = { id: due.id, service: 'Interior Detail', status: 'Confirmed', jobStatus: 'confirmed' };
  w.cd1MyGarage.state.bookings = [w.cd1MyGarage.state.booking];
  w.cd1MyGarage.renderDashboard({
    payment: {
      ...pay,
      amountDueApproved: 0,
      approvedTotal: 0,
      state: 'none',
    },
    bookings: w.cd1MyGarage.state.bookings,
  });
  assert.equal(w.document.getElementById('btn-pay-balance'), null);
  assert.equal(w.document.getElementById('payments-empty').textContent, GARAGE_COPY);
  assert.equal(w.document.querySelector('script[src*="js.stripe.com"]'), null);
  assert.equal(w.document.querySelector('iframe'), null);
  delete process.env.CD1_POSTGRES_PAYMENT;
});

test('ceramic checkout does not keep a card-online choice or a charge promise', () => {
  const dom = bookingDom('index.html');
  const w = dom.window;
  w.ST = {
    payMethod: 'online_after_service',
    pkgId: 'ceramic_1yr',
    pkg: { name: 'Ceramic Coating' },
    basePrice: 800,
    addons: [],
    cat: 'cars',
  };
  w.Cardetail1BookingReview.install(w);
  vm.runInContext(read('assets/ceramic-booking.js'), dom.getInternalVMContext());
  w.CD1CeramicBooking.injectCheckoutSummary();
  const online = w.document.getElementById('pc-online');
  assert.equal(w.getComputedStyle(online).display, 'none');
  assert.equal(online.disabled, true);
  assert.equal(online.onclick, null);
  assert.equal(w.ST.payMethod, '');
  const lines = w.document.getElementById('ceramic-checkout-lines');
  assert.ok(lines, 'ceramic summary missing');
  assert.match(lines.textContent, /Balance due at service/);
  assert.doesNotMatch(lines.textContent, /Balance charged after service/);
  assert.doesNotMatch(lines.textContent, /A card is saved now/);
});

test('subscription checkout is refused before Stripe while catalog listing stays available', async () => {
  process.env.CONTEXT = 'production';
  delete process.env[FLAG];
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    throw new Error('stripe must not be called');
  };
  const subPath = require.resolve('../netlify/functions/customer-subscription-checkout');
  delete require.cache[subPath];
  const sub = require('../netlify/functions/customer-subscription-checkout');
  try {
    const closed = await sub.handler({
      httpMethod: 'POST',
      headers: { host: 'cardetail1.com', cookie: `${FLAG}=true` },
      body: JSON.stringify({ action: 'create_checkout', [FLAG]: 'true' }),
    });
    assert.equal(closed.statusCode, 403);
    assert.equal(JSON.parse(closed.body).error, 'customer_payments_unavailable');
    assert.equal(JSON.parse(closed.body).stripeCalled, false);
    const catalog = await sub.handler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify({ action: 'list_catalog' }),
    });
    assert.equal(catalog.statusCode, 200);
    assert.equal(calls.length, 0);
  } finally {
    global.fetch = original;
  }
});

test('the baked snapshot stores only a sanitized boolean', () => {
  const secret = 'sk_live_must_not_be_baked';
  const poisoned = buildDeployRuntimeSnapshot({
    CONTEXT: 'production',
    BRANCH: 'master',
    URL: 'https://cardetail1.com',
    STRIPE_SECRET_KEY: secret,
    STRIPE_PUBLISHABLE_KEY: 'pk_live_must_not_be_baked',
    [FLAG]: secret,
  });
  assert.equal(poisoned[FLAG], false);
  assert.equal(JSON.stringify(poisoned).includes('sk_'), false);
  assert.equal(JSON.stringify(poisoned).includes('pk_'), false);
  const opened = buildDeployRuntimeSnapshot({ CONTEXT: 'production', [FLAG]: 'true' });
  assert.equal(opened[FLAG], true);
  const absent = buildDeployRuntimeSnapshot({ CONTEXT: 'production' });
  assert.equal(absent[FLAG], false);
  const stub = read('netlify/lib/deploy-runtime-env.generated.js');
  assert.match(stub, /STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED: false/);
  assert.doesNotMatch(stub, /sk_|pk_|SECRET|TOKEN/);
  const rendered = renderDeployRuntimeModule(poisoned);
  assert.equal(rendered.includes(secret), false);
});

function isolatedCell(spec) {
  const child = `
    const payments = require('./netlify/lib/stripe-customer-payments');
    const cell = JSON.parse(process.env.CELL_JSON);
    if (cell.bake == null) payments.clearBakedCustomerPaymentsSnapshot();
    else payments.setBakedCustomerPaymentsSnapshot(cell.bake);
    const env = {};
    if (cell.runtimeContext) env.CONTEXT = cell.runtimeContext;
    if (cell.runtimeFlag != null) env[payments.FLAG] = cell.runtimeFlag;
    env.HOST = 'evil.example';
    env.query = { [payments.FLAG]: 'true' };
    env.cookie = payments.FLAG + '=true';
    const policy = payments.customerPaymentsPolicy(env);
    const blocked = payments.productionCustomerPaymentsBlocked(env);
    for (const key of Object.keys(process.env)) delete process.env[key];
    if (cell.runtimeContext) process.env.CONTEXT = cell.runtimeContext;
    if (cell.runtimeFlag != null) process.env[payments.FLAG] = cell.runtimeFlag;
    process.env.STRIPE_SECRET_KEY = 'sk_test_must_not_leave_the_process';
    process.env.STRIPE_PUBLISHABLE_KEY = cell.expectOpen ? 'pk_test_isolated_not_a_network_call' : 'pk_live_hidden';
    const configPath = require.resolve('./netlify/functions/stripe-config');
    delete require.cache[configPath];
    const config = require('./netlify/functions/stripe-config');
    config.handler().then((res) => {
      const body = JSON.parse(res.body);
      process.stdout.write(JSON.stringify({
        enabled: policy.enabled,
        reason: policy.reason,
        blocked,
        statusCode: res.statusCode,
        customerPaymentsEnabled: body.customerPaymentsEnabled,
        publishableKey: body.publishableKey || '',
        leaked: JSON.stringify(body).includes('sk_'),
      }));
    }).catch((err) => {
      process.stderr.write(String(err && err.stack || err));
      process.exit(2);
    });
  `;
  const result = spawnSync(process.execPath, ['-e', child], {
    cwd: root,
    env: { PATH: process.env.PATH, CELL_JSON: JSON.stringify(spec) },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('build and runtime divergence stays closed in isolated processes', () => {
  const production = { CONTEXT: 'production', BRANCH: 'master', URL: 'https://cardetail1.com' };
  const cells = [
    {
      name: 'baked false / runtime false',
      bake: { ...production, [FLAG]: false },
      runtimeContext: 'production',
      runtimeFlag: 'false',
      expectOpen: false,
    },
    {
      name: 'baked true / runtime false',
      bake: { ...production, [FLAG]: true },
      runtimeContext: 'production',
      runtimeFlag: 'false',
      expectOpen: false,
    },
    {
      name: 'baked false / runtime true',
      bake: { ...production, [FLAG]: false },
      runtimeContext: 'production',
      runtimeFlag: 'true',
      expectOpen: false,
    },
    {
      name: 'both absent',
      bake: { ...production },
      runtimeContext: 'production',
      runtimeFlag: null,
      expectOpen: false,
    },
    {
      name: 'both true sandbox',
      bake: { ...SANDBOX_BAKE },
      runtimeContext: 'production',
      runtimeFlag: 'true',
      expectOpen: true,
    },
    {
      name: 'bake preview / runtime production',
      bake: { CONTEXT: 'deploy-preview', [FLAG]: true },
      runtimeContext: 'production',
      runtimeFlag: 'true',
      expectOpen: false,
    },
    {
      name: 'bake production / runtime preview',
      bake: { ...production, [FLAG]: true },
      runtimeContext: 'deploy-preview',
      runtimeFlag: 'true',
      expectOpen: false,
    },
  ];
  for (const spec of cells) {
    const out = isolatedCell(spec);
    assert.equal(out.enabled, spec.expectOpen, spec.name);
    assert.equal(out.customerPaymentsEnabled, spec.expectOpen, spec.name);
    assert.equal(out.leaked, false, spec.name);
    if (spec.expectOpen) {
      assert.equal(out.blocked, false, spec.name);
      assert.equal(out.publishableKey.startsWith('pk_test_'), true, spec.name);
    } else {
      assert.equal(out.publishableKey, '', spec.name);
      assert.equal(out.customerPaymentsEnabled, false, spec.name);
    }
  }
  const previewRuntime = isolatedCell(cells[6]);
  assert.equal(previewRuntime.blocked, true);
  const stringBake = isolatedCell({
    bake: { ...production, [FLAG]: 'true' },
    runtimeContext: 'production',
    runtimeFlag: 'true',
    expectOpen: false,
  });
  assert.equal(stringBake.enabled, false);
  assert.equal(stringBake.customerPaymentsEnabled, false);
});
