'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { __setBakedDeployEnvForTests } = require('../netlify/lib/trusted-site-origin');

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
  __setBakedDeployEnvForTests(null);
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

test('production CONTEXT with a Netlify alias Host is not classified as preview', async () => {
  process.env.CONTEXT = 'production';
  process.env.BRANCH = 'master';
  const fn = require.resolve('../netlify/functions/submit-booking');
  delete require.cache[fn];
  const submit = require(fn);
  submit.__test.setBlobsStoreOverride(null);
  const res = await submit.handler(event({ firstName: 'Live', phone: '2015550148', zipCode: '07601' }, {
    headers: { host: 'master--cardetail1.netlify.app', 'x-forwarded-host': 'evil.example' },
  }));
  const body = JSON.parse(res.body);
  assert.notEqual(body.error, 'preview_booking_disabled');
  assert.notEqual(res.statusCode, 403);
});

test('local/dev without bake or CONTEXT does not refuse, even with a Netlify alias Host', async () => {
  delete process.env.CONTEXT;
  delete process.env.BRANCH;
  delete process.env.URL;
  delete process.env.DEPLOY_URL;
  __setBakedDeployEnvForTests({});
  const { refuseSharedWrite, sharedPreviewContext } = require('../netlify/lib/preview-write-guard');
  assert.equal(sharedPreviewContext(), '');
  assert.equal(refuseSharedWrite('booking'), null);
});

test('baked production plus live CONTEXT=branch-deploy still refuses writes', () => {
  process.env.CONTEXT = 'branch-deploy';
  process.env.BRANCH = 'qa-preview';
  __setBakedDeployEnvForTests({
    CONTEXT: 'production',
    BRANCH: 'master',
    URL: 'https://cardetail1.com',
  });
  const { refuseSharedWrite, sharedPreviewContext } = require('../netlify/lib/preview-write-guard');
  assert.equal(sharedPreviewContext(), 'branch-deploy');
  assert.equal(refuseSharedWrite('stripe-webhook').statusCode, 403);
});

test('preview customer-auth still allows session reads and refuses start', async () => {
  process.env.CONTEXT = 'deploy-preview';
  const auth = require('../netlify/functions/customer-portal-auth').handler;
  const sessionRes = await auth(event({ action: 'session' }));
  assert.equal(sessionRes.statusCode, 200);
  assert.equal(JSON.parse(sessionRes.body).authenticated, false);

  const startRes = await auth(event({ action: 'start', email: 'preview@example.com' }));
  assert.equal(startRes.statusCode, 403);
  assert.equal(JSON.parse(startRes.body).error, 'preview_writes_disabled');
});

test('baked production plus a Netlify alias Host still allows the booking gate', async () => {
  delete process.env.CONTEXT;
  delete process.env.BRANCH;
  __setBakedDeployEnvForTests({
    CONTEXT: 'production',
    BRANCH: 'master',
    URL: 'https://cardetail1.com',
  });
  const fn = require.resolve('../netlify/functions/submit-booking');
  delete require.cache[fn];
  const submit = require(fn);
  submit.__test.setBlobsStoreOverride(null);
  const res = await submit.handler(event({ firstName: 'Live', phone: '2015550148', zipCode: '07601' }, {
    headers: { host: 'master--cardetail1.netlify.app', 'x-forwarded-host': 'evil.example' },
  }));
  const body = JSON.parse(res.body);
  assert.notEqual(body.error, 'preview_booking_disabled');
  assert.notEqual(res.statusCode, 403);
});

test('baked preview plus live CONTEXT=production still refuses writes', () => {
  process.env.CONTEXT = 'production';
  process.env.BRANCH = 'master';
  __setBakedDeployEnvForTests({
    CONTEXT: 'deploy-preview',
    BRANCH: 'cursor/preview-branch-isolation-62a8',
    URL: 'https://deploy-preview-360--cardetail1.netlify.app',
  });
  const { refuseSharedWrite, sharedPreviewContext } = require('../netlify/lib/preview-write-guard');
  assert.equal(sharedPreviewContext(), 'deploy-preview');
  const refused = refuseSharedWrite('booking');
  assert.equal(refused.statusCode, 403);
  assert.equal(JSON.parse(refused.body).error, 'preview_writes_disabled');
});

test('Host and x-forwarded-host cannot clear a branch-deploy bake', async () => {
  delete process.env.CONTEXT;
  __setBakedDeployEnvForTests({
    CONTEXT: 'branch-deploy',
    BRANCH: 'cursor/preview-branch-isolation-62a8',
    URL: 'https://cursor-preview-branch-isolation-62a8--cardetail1.netlify.app',
  });
  const fn = require.resolve('../netlify/functions/submit-booking');
  delete require.cache[fn];
  const submit = require(fn);
  submit.__test.setBlobsStoreOverride(null);
  const res = await submit.handler(event({ firstName: 'Preview', phone: '2015550148', zipCode: '07601' }, {
    headers: { host: 'cardetail1.com', 'x-forwarded-host': 'www.cardetail1.com' },
  }));
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 403);
  assert.equal(body.error, 'preview_booking_disabled');
  assert.equal(body.bookingCreated, false);
});

test('mutations of the preview write guard go red then restore', () => {
  const guardPath = path.join(root, 'netlify/lib/preview-write-guard.js');
  const original = fs.readFileSync(guardPath, 'utf8');
  function probe(script) {
    return spawnSync(process.execPath, ['-e', script], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
    });
  }
  try {
    const disabled = original.replace(
      'if (SHARED_CONTEXTS.has(bakedCtx)) return bakedCtx;',
      'if (false && SHARED_CONTEXTS.has(bakedCtx)) return bakedCtx;',
    );
    assert.notEqual(disabled, original);
    fs.writeFileSync(guardPath, disabled);
    const bakePreview = probe(`
      const assert = require('node:assert/strict');
      const { __setBakedDeployEnvForTests } = require('./netlify/lib/trusted-site-origin');
      __setBakedDeployEnvForTests({ CONTEXT: 'deploy-preview', BRANCH: 'x', URL: 'https://deploy-preview-1--cardetail1.netlify.app' });
      process.env.CONTEXT = 'production';
      const { sharedPreviewContext } = require('./netlify/lib/preview-write-guard');
      assert.equal(sharedPreviewContext(), 'deploy-preview');
    `);
    assert.notEqual(bakePreview.status, 0, bakePreview.stdout + bakePreview.stderr);

    fs.writeFileSync(guardPath, original.replace(
      'if (!sharedPreviewContext()) return null;',
      'if (true) return null;',
    ));
    const allowPreview = probe(`
      const assert = require('node:assert/strict');
      process.env.CONTEXT = 'branch-deploy';
      const { refuseSharedWrite } = require('./netlify/lib/preview-write-guard');
      const res = refuseSharedWrite('booking');
      assert.equal(res && res.statusCode, 403);
    `);
    assert.notEqual(allowPreview.status, 0, allowPreview.stdout + allowPreview.stderr);

    fs.writeFileSync(guardPath, original.replace(
      "const liveCtx = contextOf(process.env.CONTEXT || process.env.NETLIFY_CONTEXT);",
      "const liveCtx = contextOf(process.env.CONTEXT || process.env.NETLIFY_CONTEXT);\n  if (contextOf(process.env.FAKE_HOST) === 'cardetail1.com') return '';",
    ));
    const hostAsAuthority = probe(`
      const assert = require('node:assert/strict');
      process.env.CONTEXT = 'branch-deploy';
      process.env.FAKE_HOST = 'cardetail1.com';
      const { __setBakedDeployEnvForTests } = require('./netlify/lib/trusted-site-origin');
      __setBakedDeployEnvForTests({ CONTEXT: 'branch-deploy', BRANCH: 'x', URL: 'https://x--cardetail1.netlify.app' });
      const { sharedPreviewContext } = require('./netlify/lib/preview-write-guard');
      assert.equal(sharedPreviewContext(), 'branch-deploy');
    `);
    assert.notEqual(hostAsAuthority.status, 0, hostAsAuthority.stdout + hostAsAuthority.stderr);
  } finally {
    fs.writeFileSync(guardPath, original);
  }
});

