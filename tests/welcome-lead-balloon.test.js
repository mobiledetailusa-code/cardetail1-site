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
const { setOpsStoreOverride } = require('../netlify/lib/ops-db');

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

function emptyOpsStore() {
  return {
    async list() { return { blobs: [] }; },
    async get() { return null; },
  };
}

function withStore(fn) {
  return async () => {
    const prev = revenueStore.getRevenueStore;
    revenueStore.getRevenueStore = createMemoryStores();
    setOpsStoreOverride(emptyOpsStore());
    try {
      await fn();
    } finally {
      revenueStore.getRevenueStore = prev;
      setOpsStoreOverride(null);
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
  assert.match(js, /startOverlayWatch/);
  assert.match(js, /function destroy\(/);
  assert.match(js, /clearInterval\(overlayTimer\)/);
  assert.match(js, /hookDesktopExitIntent/);
  assert.match(js, /DESKTOP_MIN_WIDTH = 1024/);
  assert.match(js, /addEventListener\('mouseout'/);
  assert.match(js, /addEventListener\('mouseleave'/);
  assert.doesNotMatch(js, /userAgent/);
  assert.doesNotMatch(js, /navigator\.userAgent/);
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
  setOpsStoreOverride(emptyOpsStore());
  const start = Date.now();
  try {
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
  } finally {
    setOpsStoreOverride(null);
    if (prev === undefined) delete process.env.FIRST_BOOKING_OFFER_ENABLED;
    else process.env.FIRST_BOOKING_OFFER_ENABLED = prev;
  }
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

function applyViewport(window, { width, coarse }) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  window.matchMedia = (query) => {
    const q = String(query || '');
    const matches = coarse
      ? /pointer:\s*coarse/.test(q) || /hover:\s*none/.test(q)
      : /pointer:\s*fine/.test(q) || /hover:\s*hover/.test(q);
    return {
      matches,
      media: q,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    };
  };
}

function loadBalloonDom({ width = 1440, coarse = false } = {}) {
  const src = read('assets/welcome-lead-balloon.js');
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://cardetail1.com/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      applyViewport(window, { width, coarse });
    },
  });
  applyViewport(dom.window, { width, coarse });
  const script = dom.window.document.createElement('script');
  script.textContent = src;
  dom.window.document.body.appendChild(script);
  if (dom.window.document.readyState === 'loading') {
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  }
  return dom;
}

if (JSDOM) {
  test('balloon reveals on demand and persists dismiss', () => {
    const src = read('assets/welcome-lead-balloon.js');
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      url: 'https://cardetail1.com/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
    });
    try {
      const script = dom.window.document.createElement('script');
      script.textContent = src;
      dom.window.document.body.appendChild(script);
      const api = dom.window.Cardetail1WelcomeBalloon;
      assert.ok(api);
      api.revealForTest();
      const root = dom.window.document.getElementById('cd1-wlb');
      assert.ok(root);
      assert.equal(root.hidden, false);
      const dismiss = dom.window.document.getElementById('cd1-wlb-fab-dismiss');
      assert.ok(dismiss);
      dismiss.click();
      assert.equal(dom.window.document.getElementById('cd1-wlb'), null);
      const dismissed = JSON.parse(dom.window.localStorage.getItem(api.DISMISS_KEY));
      assert.ok(dismissed && dismissed.at);
    } finally {
      if (dom.window.Cardetail1WelcomeBalloon && typeof dom.window.Cardetail1WelcomeBalloon.destroy === 'function') {
        dom.window.Cardetail1WelcomeBalloon.destroy();
      }
      dom.window.close();
    }
  });

  test('desktop exit-intent reveals balloon after pointer leaves through the top', () => {
    const dom = loadBalloonDom({ width: 1440 });
    try {
      const api = dom.window.Cardetail1WelcomeBalloon;
      assert.equal(api.isDesktopExitCapable(), true);
      assert.equal(api.exitIntentHooked(), true);
      assert.equal(dom.window.document.getElementById('cd1-wlb'), null);
      assert.equal(dom.window.document.getElementById('cd1-wlb'), null);
      api.armDesktopExitFromPointer({ clientY: 220 });
      api.considerDesktopExit({ type: 'mouseleave', clientY: 2, relatedTarget: null });
      const root = dom.window.document.getElementById('cd1-wlb');
      assert.ok(root);
      assert.equal(root.hidden, false);
      assert.equal(root.classList.contains('cd1-wlb-on'), true);
    } finally {
      if (dom.window.Cardetail1WelcomeBalloon) dom.window.Cardetail1WelcomeBalloon.destroy();
      dom.window.close();
    }
  });

  test('desktop exit-intent does not fire on unarmed mouseout or in-page mouseout', () => {
    const dom = loadBalloonDom({ width: 1440 });
    try {
      const api = dom.window.Cardetail1WelcomeBalloon;
      api.considerDesktopExit({ type: 'mouseleave', clientY: 2, relatedTarget: null });
      assert.equal(dom.window.document.getElementById('cd1-wlb'), null);
      api.armDesktopExitFromPointer({ clientY: 220 });
      api.considerDesktopExit({
        type: 'mouseout',
        clientY: 2,
        relatedTarget: dom.window.document.body,
      });
      assert.equal(dom.window.document.getElementById('cd1-wlb'), null);
      api.considerDesktopExit({ type: 'mouseleave', clientY: 80, relatedTarget: null });
      assert.equal(dom.window.document.getElementById('cd1-wlb'), null);
    } finally {
      if (dom.window.Cardetail1WelcomeBalloon) dom.window.Cardetail1WelcomeBalloon.destroy();
      dom.window.close();
    }
  });

  test('mobile viewport does not register desktop mouse exit-intent', () => {
    const dom = loadBalloonDom({ width: 390, coarse: true });
    try {
      const api = dom.window.Cardetail1WelcomeBalloon;
      assert.equal(api.isDesktopExitCapable(), false);
      api.armDesktopExitFromPointer({ clientY: 220 });
      api.considerDesktopExit({ type: 'mouseleave', clientY: 2, relatedTarget: null });
      assert.equal(dom.window.document.getElementById('cd1-wlb'), null);
    } finally {
      if (dom.window.Cardetail1WelcomeBalloon) dom.window.Cardetail1WelcomeBalloon.destroy();
      dom.window.close();
    }
  });

  test('claimed visitor does not reveal balloon on desktop exit-intent', () => {
    const dom = loadBalloonDom({ width: 1440 });
    try {
      const api = dom.window.Cardetail1WelcomeBalloon;
      api.persistClaim('claimed@example.com');
      api.armDesktopExitFromPointer({ clientY: 220 });
      api.considerDesktopExit({ type: 'mouseleave', clientY: 2, relatedTarget: null });
      assert.equal(dom.window.document.getElementById('cd1-wlb'), null);
    } finally {
      if (dom.window.Cardetail1WelcomeBalloon) dom.window.Cardetail1WelcomeBalloon.destroy();
      dom.window.close();
    }
  });

  test('dwell timer still reveals balloon on desktop without exit-intent', async () => {
    const dom = loadBalloonDom({ width: 1440 });
    try {
      assert.equal(dom.window.document.getElementById('cd1-wlb'), null);
      await new Promise((resolve) => {
        dom.window.setTimeout(resolve, dom.window.Cardetail1WelcomeBalloon.SHOW_DELAY_MS + 20);
      });
      const root = dom.window.document.getElementById('cd1-wlb');
      assert.ok(root);
      assert.equal(root.hidden, false);
    } finally {
      if (dom.window.Cardetail1WelcomeBalloon) dom.window.Cardetail1WelcomeBalloon.destroy();
      dom.window.close();
    }
  });

  test('dismiss cooldown suppresses a later desktop exit-intent reveal', () => {
    const dom = loadBalloonDom({ width: 1440 });
    try {
      const api = dom.window.Cardetail1WelcomeBalloon;
      api.revealForTest();
      const dismiss = dom.window.document.getElementById('cd1-wlb-fab-dismiss');
      dismiss.click();
      assert.equal(dom.window.document.getElementById('cd1-wlb'), null);
      api.init();
      api.armDesktopExitFromPointer({ clientY: 220 });
      api.considerDesktopExit({ type: 'mouseleave', clientY: 2, relatedTarget: null });
      assert.equal(dom.window.document.getElementById('cd1-wlb'), null);
    } finally {
      if (dom.window.Cardetail1WelcomeBalloon) dom.window.Cardetail1WelcomeBalloon.destroy();
      dom.window.close();
    }
  });
}
