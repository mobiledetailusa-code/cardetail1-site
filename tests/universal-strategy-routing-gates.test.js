const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const NODE = process.execPath;
const backend = require('../netlify/lib/universal-customer-strategy');
const { validateBookingRouting, bookingContextFromPayload } = require('../netlify/lib/booking-routing-validation');
const { SEGMENTS } = require('../netlify/lib/revenue-segments');
const sharedConfig = JSON.parse(
  fs.readFileSync(path.join(root, 'shared/universal-customer-strategy-config.json'), 'utf8')
);

const BOOKING_PAGES = [
  'index.html',
  'new-jersey-hub.html',
  'connecticut-hub.html',
  'bergen-county-hub.html',
  'newark-mobile-detailing.html',
  'boats-detailing.html',
  'rv-detailing.html',
  'powersports-detailing.html',
  'multi-vehicle-detailing.html',
];

function loadFrontendStrategy() {
  const segments = fs.readFileSync(path.join(root, 'assets/customer-segments.js'), 'utf8');
  const generated = fs.readFileSync(
    path.join(root, 'assets/universal-customer-strategy.generated.js'),
    'utf8'
  );
  const sandbox = { window: {}, globalThis: {} };
  sandbox.window = sandbox.globalThis = sandbox;
  vm.runInNewContext(segments, sandbox);
  vm.runInNewContext(generated, sandbox);
  return sandbox.Cardetail1UniversalStrategy;
}

function loadRoutingGate(extra) {
  const segments = fs.readFileSync(path.join(root, 'assets/customer-segments.js'), 'utf8');
  const generated = fs.readFileSync(
    path.join(root, 'assets/universal-customer-strategy.generated.js'),
    'utf8'
  );
  const gateSrc = fs.readFileSync(path.join(root, 'assets/booking-routing-gate.js'), 'utf8');
  const sandbox = Object.assign({
    window: {},
    globalThis: {},
    document: {
      readyState: 'complete',
      addEventListener: () => {},
      createElement: (tag) => ({
        id: '',
        style: { cssText: '' },
        setAttribute: () => {},
        appendChild: () => {},
        innerHTML: '',
        onclick: null,
      }),
      getElementById: () => null,
      body: { appendChild: () => {}, style: {} },
    },
    ST: { vehicles: [], units: 1 },
    sessionStorage: { getItem: () => null },
    localStorage: { getItem: () => null },
    openBooking: function () {},
    openBookingFromHome: function () {},
    openBookingCarPkg: function () {},
    openBookingPkg: function () {},
    selectCategory: function () {},
    openCommercialInquiry: function () {},
    resolveZipService: (zip) => zip === '07650',
    location: { search: '', pathname: '/index.html' },
    history: { replaceState: () => {} },
    setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; },
  }, extra || {});
  sandbox.window = sandbox.globalThis = sandbox;
  vm.runInNewContext(segments, sandbox);
  vm.runInNewContext(generated, sandbox);
  vm.runInNewContext(gateSrc, sandbox);
  return sandbox;
}

// ── Client gate architecture ───────────────────────────────────────────────────

test('booking-routing-gate wraps all primary entry points', () => {
  const gate = fs.readFileSync(path.join(root, 'assets/booking-routing-gate.js'), 'utf8');
  for (const fn of ['openBooking', 'openBookingFromHome', 'openBookingCarPkg', 'openBookingPkg', 'selectCategory']) {
    assert.match(gate, new RegExp(`wrapFn\\('${fn}'`));
  }
  assert.match(gate, /routeServiceIntent/);
  assert.match(gate, /__cd1PendingBookQuery/);
  assert.match(gate, /resume/);
});

test('public booking pages load shared routing gate script', () => {
  for (const page of BOOKING_PAGES) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    assert.match(html, /booking-routing-gate\.js/, `${page} missing routing gate`);
    assert.match(html, /universal-customer-strategy\.generated\.js/, `${page} missing strategy bundle`);
  }
});

test('specialty booking bridge enforces routeServiceIntent', () => {
  const bridge = fs.readFileSync(path.join(root, 'assets/specialty-booking-bridge.js'), 'utf8');
  assert.match(bridge, /routeServiceIntent|CD1BookingRoutingGate/);
  assert.match(bridge, /alternative service path/);
});

test('index defers URL booking deep links to routing gate', () => {
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(index, /__cd1PendingBookQuery/);
  assert.doesNotMatch(index, /setTimeout\(function\(\)\{\s*openBookingFromHome\(book\)/);
});

// ── routeServiceIntent behavior ───────────────────────────────────────────────

test('single-vehicle standard booking remains allowed', () => {
  const r = backend.routeServiceIntent({ category: 'cars', vehicleCount: 1, zip: '07650' });
  assert.equal(r.route, 'standard_booking');
  assert.equal(r.allowed, true);
  assert.equal(r.routing.standardBookingAllowed, true);
});

test('normal specialty booking remains allowed', () => {
  for (const cat of ['boats', 'rvs', 'powersports']) {
    const r = backend.routeServiceIntent({ category: cat, vehicleCount: 1 });
    assert.equal(r.route, 'specialty_booking', cat);
    assert.equal(r.allowed, true);
  }
});

test('residential multi-vehicle flow remains allowed', () => {
  const r = backend.routeServiceIntent({ category: 'cars', vehicleCount: 3 });
  assert.equal(r.route, 'standard_booking');
  assert.equal(r.allowed, true);
  assert.equal(r.altRoute, 'garage_plan');
});

test('fleet cannot enter residential checkout', () => {
  const r = backend.routeServiceIntent({ category: 'fleet', vehicleCount: 4 });
  assert.equal(r.route, 'fleet_quote');
  assert.equal(r.allowed, false);
  assert.equal(r.code, 'fleet_quote_required');
  assert.equal(r.routing.standardBookingAllowed, false);
});

test('fleet routes to quote path', () => {
  const r = backend.routeServiceIntent({ category: 'cars', vehicleCount: 8, isCommercial: true });
  assert.equal(r.route, 'fleet_quote');
  assert.equal(r.code, 'fleet_quote_required');
});

test('manual-review segment cannot enter residential checkout', () => {
  const r = backend.routeServiceIntent({ category: 'cars', vehicleCount: 1, unsupportedZip: true });
  assert.equal(r.route, 'manual_review');
  assert.equal(r.allowed, false);
  assert.equal(r.routing.standardBookingAllowed, false);
});

test('manual-review segment receives alternative path code', () => {
  const r = backend.routeServiceIntent({ category: 'cars', unsupportedZip: true });
  assert.equal(r.code, 'manual_review_required');
  assert.equal(r.segment, SEGMENTS.MANUAL_REVIEW_OR_ALTERNATIVE_PATH);
});

test('client-supplied segment values are not blindly trusted', () => {
  const r = backend.routeServiceIntent({
    segment: SEGMENTS.SINGLE_VEHICLE_NEW,
    category: 'fleet',
    vehicleCount: 12,
  });
  assert.equal(r.segment, SEGMENTS.COMMERCIAL_FLEET);
  assert.equal(r.route, 'fleet_quote');
});

test('frontend and backend routeServiceIntent parity for key scenarios', () => {
  const frontend = loadFrontendStrategy();
  const scenarios = [
    { category: 'cars', vehicleCount: 1 },
    { category: 'boats', vehicleCount: 1 },
    { category: 'cars', vehicleCount: 3 },
    { category: 'fleet', vehicleCount: 2 },
    { category: 'cars', unsupportedZip: true },
    { category: 'cars', vehicleCount: 8, isCommercial: true },
  ];
  for (const ctx of scenarios) {
    assert.equal(
      JSON.stringify(frontend.routeServiceIntent(ctx)),
      JSON.stringify(backend.routeServiceIntent(ctx)),
      `parity mismatch: ${JSON.stringify(ctx)}`
    );
  }
});

// ── Client gate runtime ───────────────────────────────────────────────────────

test('routing gate blocks fleet openBooking and surfaces alternative', () => {
  const sandbox = loadRoutingGate();
  let inquiryCalled = false;
  sandbox.openCommercialInquiry = () => { inquiryCalled = true; };
  sandbox.CD1BookingRoutingGate.init();
  sandbox.openBooking('fleet');
  assert.equal(inquiryCalled, true);
});

test('routing gate blocks unsupported ZIP manual-review path', () => {
  const sandbox = loadRoutingGate({
    document: {
      readyState: 'complete',
      addEventListener: () => {},
      createElement: (tag) => ({
        id: '',
        style: { cssText: '' },
        setAttribute: () => {},
        appendChild: () => {},
        innerHTML: '',
        onclick: null,
      }),
      getElementById: (id) => {
        if (id === 'bk-zip') return { value: '90210' };
        return null;
      },
      body: { appendChild: () => {}, style: {} },
    },
    resolveZipService: () => null,
  });
  let opened = false;
  sandbox.openBooking = function () { opened = true; };
  sandbox.CD1BookingRoutingGate.init();
  sandbox.openBooking('cars');
  assert.equal(opened, false);
});

test('URL query deep link cannot bypass routing gate', () => {
  const sandbox = loadRoutingGate();
  const result = sandbox.CD1BookingRoutingGate.evaluateAndMaybeBlock(
    sandbox.CD1BookingRoutingGate.gatherContext({ category: 'fleet', source: 'url_query', zip: '07650' })
  );
  assert.equal(result.blocked, true);
  assert.equal(result.route.route, 'fleet_quote');
});

// ── Backend enforcement ───────────────────────────────────────────────────────

test('backend rejects fleet residential submission', () => {
  const r = validateBookingRouting({
    zipCode: '07650',
    vehicleCategory: 'fleet',
    vehicles: [{ cat: 'fleet', pkgId: 'essential', vehicleLabel: '5 unit fleet · Ford Transit' }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'fleet_quote_required');
});

test('backend rejects manual-review residential submission', () => {
  const r = validateBookingRouting({
    zipCode: '90210',
    vehicleCategory: 'cars',
    vehicles: [{ cat: 'cars', pkgId: 'full', vehicleLabel: 'Small Car' }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'manual_review_required');
});

test('backend accepts valid standard bookings', () => {
  const r = validateBookingRouting({
    zipCode: '07650',
    vehicleCategory: 'cars',
    vehicles: [{ cat: 'cars', pkgId: 'full', vehicleLabel: 'Small Car', basePrice: 285 }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.route, 'standard_booking');
});

test('backend accepts valid specialty bookings', () => {
  const r = validateBookingRouting({
    zipCode: '07650',
    vehicleCategory: 'boats',
    vehicles: [{ cat: 'boats', pkgId: 'full', vehicleLabel: '24 ft boat', basePrice: 399 }],
  });
  assert.equal(r.ok, true);
});

test('backend ignores client-supplied segment field when validating', () => {
  const ctx = bookingContextFromPayload({
    segment: SEGMENTS.SINGLE_VEHICLE_NEW,
    zipCode: '07650',
    vehicleCategory: 'fleet',
    vehicles: [{ cat: 'fleet', vehicleLabel: '8 unit fleet' }],
  });
  assert.equal(ctx.isCommercial, true);
  const r = validateBookingRouting({
    segment: SEGMENTS.SINGLE_VEHICLE_NEW,
    zipCode: '07650',
    vehicleCategory: 'fleet',
    vehicles: [{ cat: 'fleet', vehicleLabel: '8 unit fleet' }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'fleet_quote_required');
});

// ── Generated config sync ─────────────────────────────────────────────────────

test('generated strategy bundle matches shared JSON version', () => {
  const frontend = loadFrontendStrategy();
  assert.equal(frontend.CONFIG_VERSION, sharedConfig.version);
});

test('sync --check passes when bundle is synchronized', () => {
  execSync(`"${NODE}" scripts/sync-universal-strategy-config.mjs`, { cwd: root, stdio: 'pipe' });
  execSync(`"${NODE}" scripts/sync-universal-strategy-config.mjs --check`, { cwd: root, stdio: 'pipe' });
});

test('sync --check fails against intentionally stale generated content', () => {
  const fp = path.join(root, 'assets/universal-customer-strategy.generated.js');
  const orig = fs.readFileSync(fp, 'utf8');
  try {
    fs.writeFileSync(fp, `${orig}\n/* stale-marker */\n`);
    let failed = false;
    try {
      execSync(`"${NODE}" scripts/sync-universal-strategy-config.mjs --check`, { cwd: root, stdio: 'pipe' });
    } catch (err) {
      failed = true;
      const out = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`;
      assert.match(out, /STALE/);
    }
    assert.equal(failed, true);
  } finally {
    fs.writeFileSync(fp, orig, 'utf8');
  }
});

test('sync --check does not mutate files', () => {
  const fp = path.join(root, 'assets/universal-customer-strategy.generated.js');
  const before = fs.readFileSync(fp, 'utf8');
  execSync(`"${NODE}" scripts/sync-universal-strategy-config.mjs --check`, { cwd: root, stdio: 'pipe' });
  const after = fs.readFileSync(fp, 'utf8');
  assert.equal(before, after);
});

// ── Regression guards ─────────────────────────────────────────────────────────

test('package prices and IDs remain unchanged in index PRICING', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /boats:[\s\S]*?id:'maint'/);
  assert.match(html, /rvs:[\s\S]*?id:'exterior'/);
  assert.match(html, /powersports:[\s\S]*?id:'wash'/);
  assert.match(html, /boats:[\s\S]*?maint:\s*\{perFt:\s*12,\s*min:\s*199\}/);
});

test('Stripe functions unchanged aside from routing guard injection', () => {
  const setup = fs.readFileSync(path.join(root, 'netlify/functions/create-setup-intent.js'), 'utf8');
  const submit = fs.readFileSync(path.join(root, 'netlify/functions/submit-booking.js'), 'utf8');
  assert.match(setup, /validateBookingRouting/);
  assert.match(submit, /validateBookingRouting/);
  assert.doesNotMatch(setup, /paymentIntent\.confirm|charges\.create/);
  assert.match(submit, /card_on_file_required/);
  assert.match(submit, /CLIENT_BLOCKED_FIELDS/);
  assert.match(submit, /stripe-webhook/);
});

test('submit-booking handler rejects fleet draft with fleet_quote_required', async () => {
  const SUBMIT_PATH = require.resolve('../netlify/functions/submit-booking');
  delete require.cache[SUBMIT_PATH];
  delete require.cache[require.resolve('../netlify/lib/public-rate-limit')];
  process.env.DRAFT_TOKEN_SECRET = 'test-draft-secret-32chars-minimum!!';
  const { handler, __test } = require('../netlify/functions/submit-booking');
  const store = {
    data: new Map(),
    async get() { return null; },
    async setJSON(key, value) { this.data.set(key, JSON.stringify(value)); },
  };
  __test.setBlobsStoreOverride(() => store);
  const res = await handler({
    httpMethod: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.10' },
    body: JSON.stringify({
      isDraft: true,
      firstName: 'Fleet',
      phone: '5513132956',
      email: 'fleet@example.com',
      zipCode: '07650',
      address: '100 Test St',
      paymentMethodPreference: 'card_onsite',
      acceptedCardOnFilePolicy: true,
      preferredDate: '2026-08-20',
      preferredTime: '2:00 PM',
      vehicleCategory: 'fleet',
      vehicles: [{ cat: 'fleet', pkgId: 'essential', vehicleLabel: '6 unit fleet' }],
    }),
  });
  assert.equal(res.statusCode, 403);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'fleet_quote_required');
  __test.setBlobsStoreOverride(null);
});

test('chat booking entry uses openBooking which is gated', () => {
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(index, /if\(act==='book'\)\{[^}]*openBooking/);
  assert.match(fs.readFileSync(path.join(root, 'assets/booking-routing-gate.js'), 'utf8'), /wrapFn\('openBooking'/);
});

test('resume path is handled by routing gate', () => {
  const gate = fs.readFileSync(path.join(root, 'assets/booking-routing-gate.js'), 'utf8');
  assert.match(gate, /processResumeQuery/);
  assert.match(gate, /resume_link/);
});
