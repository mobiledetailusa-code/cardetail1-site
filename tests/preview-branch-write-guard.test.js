'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function event(body, extra = {}) {
  return {
    httpMethod: 'POST',
    headers: {
      host: 'cardetail1.com',
      'x-nf-client-connection-ip': '203.0.113.80',
      ...(extra.headers || {}),
    },
    queryStringParameters: extra.query || { enabled: 'true', price: '1', duration: '15' },
    body: JSON.stringify(body || {}),
  };
}

let envSnap;

beforeEach(() => {
  envSnap = {
    CONTEXT: process.env.CONTEXT,
    BRANCH: process.env.BRANCH,
    URL: process.env.URL,
    DEPLOY_URL: process.env.DEPLOY_URL,
  };
});

afterEach(() => {
  for (const [key, value] of Object.entries(envSnap)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('branch-deploy booking ignores host, query, and payload and does not open the shared store', async () => {
  process.env.CONTEXT = 'branch-deploy';
  process.env.BRANCH = 'feature-preview';
  const submit = require('../netlify/functions/submit-booking');
  submit.__test.setBlobsStoreOverride(null);
  const refused = await submit.handler(event({
    enabled: true,
    totalPrice: 1,
    appointmentDurationMinutes: 15,
    firstName: 'Preview',
    phone: '2015550148',
    zipCode: '07601',
  }, { query: { enabled: 'true', price: '1', duration: '15' } }));
  const body = JSON.parse(refused.body);
  assert.equal(refused.statusCode, 403);
  assert.equal(body.error, 'preview_booking_disabled');
  assert.equal(body.bookingCreated, false);
  assert.match(body.userMessage, /Nothing will be booked, charged, or sent/);

  let writes = 0;
  submit.__test.setBlobsStoreOverride(async () => ({
    async get() { return null; },
    async setJSON() { writes += 1; return { modified: true }; },
    async set() { writes += 1; },
  }));
  const allowedPastGuard = await submit.handler(event({ enabled: true }, {
    headers: { host: 'cardetail1.com' },
  }));
  const allowedBody = JSON.parse(allowedPastGuard.body);
  assert.notEqual(allowedPastGuard.statusCode, 403);
  assert.notEqual(allowedBody.error, 'preview_booking_disabled');
  assert.equal(writes, 0);
  submit.__test.setBlobsStoreOverride(null);
});

test('production context does not refuse a write', () => {
  process.env.CONTEXT = 'production';
  const { refuseSharedWrite, sharedPreviewContext } = require('../netlify/lib/preview-write-guard');
  assert.equal(sharedPreviewContext(), '');
  assert.equal(refuseSharedWrite('booking'), null);
});

test('branch-deploy and deploy-preview refuse payment, card, reschedule, and revenue writes', async () => {
  const cases = [
    ['branch-deploy', '../netlify/functions/create-setup-intent', { enabled: true, price: 1, duration: 15 }],
    ['deploy-preview', '../netlify/functions/customer-balance-payment-intent', { enabled: true, amountCents: 100 }],
    ['branch-deploy', '../netlify/functions/ceramic-checkout-intent', { enabled: true, price: 1 }],
    ['deploy-preview', '../netlify/functions/update-booking', { enabled: true, bookingId: 'CD1-X', updates: { preferredDate: '2026-11-02' } }],
    ['branch-deploy', '../netlify/functions/payment-resume', { action: 'intent', enabled: true }],
  ];
  for (const [ctx, mod, body] of cases) {
    process.env.CONTEXT = ctx;
    const handler = require(mod).handler;
    const res = await handler(event(body));
    const parsed = JSON.parse(res.body);
    assert.equal(res.statusCode, 403, mod);
    assert.equal(parsed.error, 'preview_writes_disabled', mod);
    assert.equal(parsed.stored, false, mod);
    assert.equal(parsed.sent, false, mod);
    assert.match(parsed.message, /Nothing will be booked, charged, or sent/);
  }
});

test('a preview revenue event is not stored', async () => {
  process.env.CONTEXT = 'deploy-preview';
  let storeCalls = 0;
  const storePath = require.resolve('../netlify/lib/revenue-store');
  const real = require(storePath);
  const previous = require.cache[storePath].exports;
  require.cache[storePath].exports = {
    ...real,
    getRevenueStore: async () => { storeCalls += 1; throw new Error('store_must_not_open'); },
  };
  const eventPath = require.resolve('../netlify/functions/revenue-event');
  delete require.cache[eventPath];
  try {
    const { handler } = require('../netlify/functions/revenue-event');
    const res = await handler(event({
      event: 'page_view',
      event_id: 'evt-preview-1',
      anonymous_session_id: 'sess-preview-1',
      enabled: true,
      price: 1,
      duration: 30,
    }));
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 403);
    assert.equal(body.error, 'preview_writes_disabled');
    assert.equal(storeCalls, 0);
  } finally {
    require.cache[storePath].exports = previous;
    delete require.cache[eventPath];
  }
});

test('branch-deploy customer auth and inquiry do not send', async () => {
  process.env.CONTEXT = 'branch-deploy';
  process.env.BRANCH = 'qa-preview';
  const auth = require('../netlify/functions/customer-portal-auth').handler;
  const authRes = await auth(event({
    action: 'start',
    email: 'preview@example.com',
    enabled: true,
  }));
  assert.equal(authRes.statusCode, 403);
  assert.equal(JSON.parse(authRes.body).sent, false);

  const inquiry = require('../netlify/functions/submit-inquiry').handler;
  const inquiryRes = await inquiry(event({
    name: 'Preview',
    phone: '2015550199',
    message: 'hello',
    enabled: true,
  }));
  assert.equal(inquiryRes.statusCode, 403);
  assert.equal(JSON.parse(inquiryRes.body).error, 'preview_writes_disabled');
});

test('a scheduled preview worker processes nothing', async () => {
  const previous = {
    TWILIO_OUTBOX_ENABLED: process.env.TWILIO_OUTBOX_ENABLED,
    TWILIO_ENABLED: process.env.TWILIO_ENABLED,
    TWILIO_PRODUCTION_SENDS_ENABLED: process.env.TWILIO_PRODUCTION_SENDS_ENABLED,
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
    TWILIO_API_KEY: process.env.TWILIO_API_KEY,
    TWILIO_API_SECRET: process.env.TWILIO_API_SECRET,
    TWILIO_MESSAGING_SERVICE_SID: process.env.TWILIO_MESSAGING_SERVICE_SID,
    TWILIO_STATUS_CALLBACK_URL: process.env.TWILIO_STATUS_CALLBACK_URL,
  };
  process.env.CONTEXT = 'branch-deploy';
  process.env.BRANCH = 'qa-preview';
  process.env.URL = 'https://qa-preview--cardetail1.netlify.app';
  process.env.TWILIO_OUTBOX_ENABLED = 'true';
  process.env.TWILIO_ENABLED = 'true';
  process.env.TWILIO_PRODUCTION_SENDS_ENABLED = 'true';
  process.env.TWILIO_ACCOUNT_SID = 'AC00000000000000000000000000000000';
  process.env.TWILIO_API_KEY = 'SK00000000000000000000000000000000';
  process.env.TWILIO_API_SECRET = 'api-secret-test-only';
  process.env.TWILIO_MESSAGING_SERVICE_SID = 'MG00000000000000000000000000000000';
  process.env.TWILIO_STATUS_CALLBACK_URL = 'https://cardetail1.com/twilio-status';
  try {
    const worker = require('../netlify/functions/twilio-outbox-worker');
    const res = await worker.handler({
      httpMethod: 'POST',
      headers: {
        host: 'cardetail1.com',
        'x-nf-event': 'schedule',
      },
      body: JSON.stringify({ next_run: '2026-10-15T00:00:00.000Z', enabled: true }),
    });
    const body = JSON.parse(res.body);
    assert.equal(body.processed, 0);
    assert.equal(body.disabled, true);
    assert.equal(body.reason, 'non_production_context');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('preview pages do not post first-party events or ads conversions', () => {
  const revenue = fs.readFileSync(path.join(root, 'assets/revenue-events.js'), 'utf8');
  const checkout = fs.readFileSync(path.join(root, 'assets/checkout-analytics.js'), 'utf8');
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(revenue, /function isSharedPreviewHost/);
  assert.match(revenue, /if \(isSharedPreviewHost\(\)\) return null/);
  assert.match(revenue, /function isProductionAdsHost/);
  assert.match(checkout, /function sharedPreviewHost/);
  assert.match(checkout, /if \(sharedPreviewHost\(\)\) return/);
  assert.match(index, /Nothing will be booked, charged, or sent/);
  assert.match(index, /cd1-preview-site-banner/);
});
