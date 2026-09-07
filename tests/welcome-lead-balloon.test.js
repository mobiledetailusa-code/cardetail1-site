'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const {
  normalizeEmail,
  emailKey,
  saveWelcomeLeadCapture,
  hasWelcomeLeadCapture,
} = require('../netlify/lib/welcome-lead-store');
const { evaluateBookingOfferPreview } = require('../netlify/lib/booking-offers');
const revenueStore = require('../netlify/lib/revenue-store');
const publicRateLimit = require('../netlify/lib/public-rate-limit');

const CAPTURE_PATH = require.resolve('../netlify/functions/welcome-lead-capture');
const { JSDOM } = (() => {
  try { return { JSDOM: require('jsdom').JSDOM }; }
  catch { return { JSDOM: null }; }
})();

const PUBLIC_PAGES = [
  'index.html',
  'bergen-county-hub.html',
  'new-jersey-hub.html',
  'ny-metro-hub.html',
  'boats-detailing.html',
  'rv-detailing.html',
  'powersports-detailing.html',
  'palisades-park-mobile-detailing.html',
  'fleet-services.html',
  'blog.html',
];

const SKIP_PAGES = [
  'terms-conditions.html',
  'privacy-policy.html',
  'my-garage.html',
  'customer.html',
  'technician.html',
  'admin.html',
];

function createMemoryStores() {
  const stores = new Map();
  return async function getRevenueStore(name) {
    if (!stores.has(name)) {
      const data = new Map();
      stores.set(name, {
        data,
        async get(key, { type } = {}) {
          if (!data.has(key)) return null;
          const raw = data.get(key);
          return type === 'json' ? JSON.parse(raw) : raw;
        },
        async set(key, value, opts = {}) {
          if (opts.onlyIfNew && data.has(key)) return { modified: false };
          data.set(key, value);
          return { modified: true, etag: 't1' };
        },
        async list() {
          return Array.from(data.keys()).map((key) => ({ key }));
        },
      });
    }
    return stores.get(name);
  };
}

function withStore(fn) {
  return async () => {
    const prev = revenueStore.getRevenueStore;
    revenueStore.getRevenueStore = createMemoryStores();
    try {
      await fn();
    } finally {
      revenueStore.getRevenueStore = prev;
    }
  };
}

async function invokeCapture(body, overrides = {}) {
  const prevRate = publicRateLimit.enforcePublicRateLimit;
  const prevFetch = global.fetch;
  publicRateLimit.enforcePublicRateLimit = overrides.rateLimit || (async () => ({ blocked: false, allowed: true }));
  global.fetch = overrides.fetch || (async () => ({ ok: true, text: async () => '' }));
  delete require.cache[CAPTURE_PATH];
  const { handler } = require('../netlify/functions/welcome-lead-capture');
  try {
    return await handler({
      httpMethod: overrides.method || 'POST',
      headers: { 'x-forwarded-for': '203.0.113.44' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  } finally {
    publicRateLimit.enforcePublicRateLimit = prevRate;
    global.fetch = prevFetch;
  }
}

for (const page of PUBLIC_PAGES) {
  test(`${page} loads first-visit welcome balloon`, () => {
    assert.match(read(page), /welcome-lead-balloon\.js/);
  });
}

for (const page of SKIP_PAGES) {
  test(`${page} does not load first-visit welcome balloon`, () => {
    assert.doesNotMatch(read(page), /welcome-lead-balloon\.js/);
  });
}

test('balloon copy is first-visit 10% email capture with terms', () => {
  const js = read('assets/welcome-lead-balloon.js');
  assert.match(js, /First visit/);
  assert.match(js, /Get 10% off your first detail/);
  assert.match(js, /cd1_welcome10/);
  assert.match(js, /welcome-lead-capture/);
  assert.match(js, /SHOW_DELAY_MS = 8000/);
  assert.match(js, /terms-conditions#welcome-offer/);
  assert.match(js, /up to \$40/);
  assert.match(js, /__CD1_WLB_INIT__/);
});

test('checkout restores balloon claim onto the welcome offer', () => {
  const js = read('assets/checkout-offer.js');
  assert.match(js, /restoreBalloonClaim/);
  assert.match(js, /cd1_welcome10/);
  assert.match(js, /first_visit_balloon/);
  assert.match(js, /ST\.offerApplied = true/);
});

test('welcome lead lookup skips blobs outside Netlify without a store double', async () => {
  const start = Date.now();
  assert.equal(await hasWelcomeLeadCapture('ci-hang@example.com'), false);
  assert.ok(Date.now() - start < 1000);
});

test('offer preview with flag off does not hang without blobs', async () => {
  const prev = process.env.FIRST_BOOKING_OFFER_ENABLED;
  delete process.env.FIRST_BOOKING_OFFER_ENABLED;
  const start = Date.now();
  const preview = await evaluateBookingOfferPreview({
    zipCode: '07030',
    phone: '2015550100',
    email: 'ci-hang-preview@example.com',
    vehicleCategory: 'cars',
    packageId: 'interior',
    vehicles: [{ cat: 'cars', pkgId: 'interior', subtotal: 225 }],
  });
  assert.ok(Date.now() - start < 2000);
  assert.equal(preview.offer.eligibility_status, 'ineligible');
  assert.equal(preview.offer.eligibility_reason, 'offer_disabled');
  if (prev === undefined) delete process.env.FIRST_BOOKING_OFFER_ENABLED;
  else process.env.FIRST_BOOKING_OFFER_ENABLED = prev;
});

test('saveWelcomeLeadCapture fails closed when blobs are unavailable', async () => {
  await assert.rejects(
    () => saveWelcomeLeadCapture({ email: 'offline@example.com' }),
    (err) => err && err.code === 'welcome_lead_store_unavailable'
  );
});

test('normalizeEmail and emailKey', () => {
  assert.equal(normalizeEmail('  Pat@Example.COM '), 'pat@example.com');
  assert.equal(normalizeEmail('not-an-email'), '');
  assert.equal(emailKey('pat@example.com').startsWith('wl-'), true);
});

test('saveWelcomeLeadCapture is idempotent per email', withStore(async () => {
  const first = await saveWelcomeLeadCapture({ email: 'lead@example.com', source: 'first_visit_balloon' });
  assert.equal(first.created, true);
  assert.equal(await hasWelcomeLeadCapture('lead@example.com'), true);
  const second = await saveWelcomeLeadCapture({ email: 'LEAD@example.com' });
  assert.equal(second.idempotent, true);
  assert.equal(second.record.captureId, first.record.captureId);
}));

test('welcome-lead-capture rejects invalid email', withStore(async () => {
  const res = await invokeCapture({ email: 'nope' });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'invalid_email');
}));

test('welcome-lead-capture honeypot returns ok without storing', withStore(async () => {
  const res = await invokeCapture({ email: 'bot@example.com', website: 'http://spam.test' });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);
  assert.equal(await hasWelcomeLeadCapture('bot@example.com'), false);
}));

test('welcome-lead-capture stores email and returns offer', withStore(async () => {
  const res = await invokeCapture({
    email: 'first@example.com',
    marketingConsent: true,
    source: 'first_visit_balloon',
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.offer.percent, 10);
  assert.equal(body.offer.capCents, 4000);
  assert.equal(await hasWelcomeLeadCapture('first@example.com'), true);
}));

test('balloon-claimed email enables WELCOME10 while global flag is off', withStore(async () => {
  const prev = process.env.FIRST_BOOKING_OFFER_ENABLED;
  delete process.env.FIRST_BOOKING_OFFER_ENABLED;
  await saveWelcomeLeadCapture({ email: 'claimed@example.com' });
  const preview = await evaluateBookingOfferPreview({
    zipCode: '07030',
    phone: '2015550100',
    email: 'claimed@example.com',
    vehicleCategory: 'cars',
    packageId: 'interior',
    vehicles: [{ cat: 'cars', pkgId: 'interior', subtotal: 225 }],
  });
  assert.equal(preview.offer.eligibility_status, 'eligible');
  assert.equal(preview.offer.discount_amount, 2250);
  if (prev === undefined) delete process.env.FIRST_BOOKING_OFFER_ENABLED;
  else process.env.FIRST_BOOKING_OFFER_ENABLED = prev;
}));

test('unknown email stays ineligible when first-booking offer is disabled', withStore(async () => {
  const prev = process.env.FIRST_BOOKING_OFFER_ENABLED;
  delete process.env.FIRST_BOOKING_OFFER_ENABLED;
  const preview = await evaluateBookingOfferPreview({
    zipCode: '07030',
    phone: '2015550100',
    email: 'nobody@example.com',
    vehicleCategory: 'cars',
    packageId: 'interior',
    vehicles: [{ cat: 'cars', pkgId: 'interior', subtotal: 225 }],
  });
  assert.equal(preview.offer.eligibility_status, 'ineligible');
  assert.equal(preview.offer.eligibility_reason, 'offer_disabled');
  if (prev === undefined) delete process.env.FIRST_BOOKING_OFFER_ENABLED;
  else process.env.FIRST_BOOKING_OFFER_ENABLED = prev;
}));

test('rate limit default for welcome-lead-capture is 8 / 15min', () => {
  assert.equal(publicRateLimit.DEFAULT_LIMITS['welcome-lead-capture'].max, 8);
});

test('terms and privacy mention first-visit email offer', () => {
  assert.match(read('terms-conditions.html'), /first-visit offer/);
  assert.match(read('terms-conditions.html'), /No promo code/);
  assert.match(read('privacy-policy.html'), /first-visit welcome offer/);
});

if (JSDOM) {
  test('balloon reveals on demand and persists dismiss', () => {
    const src = read('assets/welcome-lead-balloon.js');
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      url: 'https://cardetail1.com/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
    });
    const script = dom.window.document.createElement('script');
    script.textContent = src;
    dom.window.document.body.appendChild(script);
    const api = dom.window.Cardetail1WelcomeBalloon;
    assert.ok(api);
    api.revealForTest();
    const root = dom.window.document.getElementById('cd1-wlb');
    assert.ok(root);
    assert.equal(root.hidden, false);
    const close = dom.window.document.getElementById('cd1-wlb-close');
    close.click();
    assert.equal(dom.window.document.getElementById('cd1-wlb'), null);
    const dismissed = JSON.parse(dom.window.localStorage.getItem(api.DISMISS_KEY));
    assert.ok(dismissed && dismissed.at);
  });
}
