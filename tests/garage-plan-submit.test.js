const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const GARAGE_PATH = require.resolve('../netlify/functions/garage-plan-submit');
const HOUSEHOLD_PATH = require.resolve('../netlify/lib/revenue-household');

const {
  normalizeUsPhoneE164,
  validateGaragePlanInput,
} = require('../netlify/lib/garage-plan-validation');
const { sanitizeProperties } = require('../netlify/lib/revenue-event-schema');
const { hubspotEnabled } = require('../netlify/lib/hubspot-adapter');

function validPayload(overrides = {}) {
  return {
    vehicleCount: 2,
    vehicleCategories: ['boats'],
    sameLocationSameVisit: false,
    sameServiceLocation: true,
    maintenanceFrequency: 'one-time',
    name: 'Garage Test',
    phone: '5513132956',
    email: 'garage-test@example.com',
    zip: '07010',
    transactionalConsent: true,
    marketingConsent: false,
    smsConsent: false,
    emailConsent: false,
    source: 'boats-detailing.html',
    prefillBooking: false,
    ...overrides,
  };
}

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
        async set(key, value) {
          data.set(key, value);
        },
        async list() {
          return Array.from(data.keys()).map((key) => ({ key }));
        },
      });
    }
    return stores.get(name);
  };
}

function mockRateLimitOk() {
  return async () => ({ blocked: false, allowed: true });
}

async function invokeHandler(body, overrides = {}) {
  const revenueStore = require('../netlify/lib/revenue-store');
  const publicRateLimit = require('../netlify/lib/public-rate-limit');
  const prevStore = revenueStore.getRevenueStore;
  const prevRate = publicRateLimit.enforcePublicRateLimit;
  revenueStore.getRevenueStore = overrides.getRevenueStore || createMemoryStores();
  publicRateLimit.enforcePublicRateLimit = overrides.rateLimit || mockRateLimitOk();
  delete require.cache[HOUSEHOLD_PATH];
  delete require.cache[GARAGE_PATH];
  const { handler } = require('../netlify/functions/garage-plan-submit');
  try {
    return await handler({
      httpMethod: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.44' },
      body: JSON.stringify(body),
    });
  } finally {
    revenueStore.getRevenueStore = prevStore;
    publicRateLimit.enforcePublicRateLimit = prevRate;
    delete require.cache[HOUSEHOLD_PATH];
    delete require.cache[GARAGE_PATH];
  }
}

// ── Phone normalization ───────────────────────────────────────────────────────

test('10-digit US phone normalizes to E.164', () => {
  assert.equal(normalizeUsPhoneE164('5513132956'), '+15513132956');
});

test('11-digit US phone beginning with 1 normalizes to E.164', () => {
  assert.equal(normalizeUsPhoneE164('15513132956'), '+15513132956');
});

test('formatted US phone normalizes to E.164', () => {
  assert.equal(normalizeUsPhoneE164('(551) 313-2956'), '+15513132956');
  assert.equal(normalizeUsPhoneE164('+15513132956'), '+15513132956');
});

test('invalid phone returns invalid_phone validation error', () => {
  const r = validateGaragePlanInput(validPayload({ phone: '12345' }));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'invalid_phone');
  assert.equal(r.field, 'phone');
});

// ── ZIP and routing ───────────────────────────────────────────────────────────

test('valid ZIP 07010 is accepted', () => {
  const r = validateGaragePlanInput(validPayload({ zip: '07010' }));
  assert.equal(r.ok, true);
  assert.equal(r.manualReviewRequired, false);
});

test('unsupported ZIP routes to manual review without blocking validation', () => {
  const r = validateGaragePlanInput(validPayload({ zip: '90210' }));
  assert.equal(r.ok, true);
  assert.equal(r.manualReviewRequired, true);
});

test('valid two-vehicle Garage Plan submits', async () => {
  const res = await invokeHandler(validPayload({ vehicleCount: 2 }));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.route, 'garage_plan');
  assert.ok(body.leadId);
});

test('valid three-vehicle Garage Plan submits', async () => {
  const res = await invokeHandler(validPayload({ vehicleCount: 3, vehicleCategories: ['cars', 'boats'] }));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.route, 'garage_plan');
});

test('one vehicle is rejected for standard garage plan path', async () => {
  const res = await invokeHandler(validPayload({ vehicleCount: 1 }));
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'garage_plan_requires_two_vehicles');
});

test('7+ vehicles routes to Fleet quote response', async () => {
  const res = await invokeHandler(validPayload({ vehicleCount: 7 }));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.route, 'fleet_quote');
});

test('unsupported ZIP submission stores lead and returns manual_review route', async () => {
  const res = await invokeHandler(validPayload({ zip: '90210', vehicleCount: 2 }));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.route, 'manual_review');
  assert.equal(body.manualReviewRequired, true);
});

// ── Consent ───────────────────────────────────────────────────────────────────

test('optional marketing consent may be false', async () => {
  const res = await invokeHandler(validPayload({ marketingConsent: false, smsConsent: false, emailConsent: false }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);
});

test('required service-contact consent must be true', async () => {
  const res = await invokeHandler(validPayload({ transactionalConsent: false }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'transactional_consent_required');
});

// ── Integrations and storage ──────────────────────────────────────────────────

test('lead storage works without HubSpot enabled', async () => {
  const prev = process.env.HUBSPOT_INTEGRATION_ENABLED;
  delete process.env.HUBSPOT_INTEGRATION_ENABLED;
  assert.equal(hubspotEnabled(), false);
  const res = await invokeHandler(validPayload());
  assert.equal(res.statusCode, 200);
  if (prev) process.env.HUBSPOT_INTEGRATION_ENABLED = prev;
});

test('duplicate submissions are idempotent', async () => {
  const getStore = createMemoryStores();
  const first = await invokeHandler(validPayload(), { getRevenueStore: getStore });
  const second = await invokeHandler(validPayload(), { getRevenueStore: getStore });
  const a = JSON.parse(first.body);
  const b = JSON.parse(second.body);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(b.idempotent, true);
  assert.equal(a.leadId, b.leadId);
});

test('Blob/configuration errors produce controlled service_unavailable response', async () => {
  const res = await invokeHandler(validPayload(), {
    getRevenueStore: async () => {
      throw new Error('Netlify Blobs configuration missing');
    },
  });
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(res.body).error, 'service_unavailable');
});

// ── Frontend / analytics safety ───────────────────────────────────────────────

test('garage plan frontend maps structured server errors', () => {
  const src = fs.readFileSync(path.join(root, 'assets/garage-plan.js'), 'utf8');
  assert.match(src, /invalid_phone/);
  assert.match(src, /manual_review_required/);
  assert.match(src, /service_unavailable/);
  assert.match(src, /Call \/ Text/);
  assert.doesNotMatch(src, /alert\(/);
});

test('form values remain after a controlled error', () => {
  const src = fs.readFileSync(path.join(root, 'assets/garage-plan.js'), 'utf8');
  assert.doesNotMatch(src, /cd1-gp-name'\)\.value\s*=\s*''/);
  assert.doesNotMatch(src, /reset\(/);
});

test('no PII is sent to GA4 or Clarity from garage plan events', () => {
  const props = sanitizeProperties({
    vehicle_count_band: '2',
    household_segment: 'MULTI_VEHICLE_HOUSEHOLD',
    name: 'Secret',
    phone: '5513132956',
    email: 'secret@example.com',
  });
  assert.equal(props.name, undefined);
  assert.equal(props.phone, undefined);
  assert.equal(props.email, undefined);
  assert.equal(props.vehicle_count_band, '2');
});

// ── Deployment bundle ─────────────────────────────────────────────────────────

test('function strategy config exists beside universal-customer-strategy.js', () => {
  const configPath = path.join(root, 'netlify/lib/universal-customer-strategy-config.json');
  assert.ok(fs.existsSync(configPath), 'missing netlify/lib/universal-customer-strategy-config.json');
  const strategy = fs.readFileSync(path.join(root, 'netlify/lib/universal-customer-strategy.js'), 'utf8');
  assert.match(strategy, /universal-customer-strategy-config\.json/);
  assert.doesNotMatch(strategy, /\.\.\/\.\.\/shared\//);
});

test('garage-plan-submit function file exists and exports handler', () => {
  assert.ok(fs.existsSync(path.join(root, 'netlify/functions/garage-plan-submit.js')));
  const { handler } = require('../netlify/functions/garage-plan-submit');
  assert.equal(typeof handler, 'function');
});

test('lead storage works without Twilio or Resend configured', async () => {
  const res = await invokeHandler(validPayload());
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  const src = fs.readFileSync(path.join(root, 'netlify/functions/garage-plan-submit.js'), 'utf8');
  assert.doesNotMatch(src, /resend|twilio/i);
});
