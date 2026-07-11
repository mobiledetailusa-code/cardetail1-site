const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const qa = require('../netlify/lib/qa-my-garage-fixtures');
const handlerMod = require('../netlify/functions/qa-my-garage-fixtures');

function withEnv(overrides, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(overrides)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); }
  finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('harness is disabled in production', () => {
  withEnv({
    CONTEXT: 'production',
    BRANCH: 'customer-my-garage-portal',
    MY_GARAGE_QA_ENABLED: 'true',
  }, () => {
    assert.equal(qa.isHarnessEnabled(), false);
  });
});

test('harness is disabled on another branch', () => {
  withEnv({
    CONTEXT: 'branch-deploy',
    BRANCH: 'master',
    MY_GARAGE_QA_ENABLED: 'true',
  }, () => {
    assert.equal(qa.isHarnessEnabled(), false);
  });
});

test('harness requires MY_GARAGE_QA_ENABLED', () => {
  withEnv({
    CONTEXT: 'branch-deploy',
    BRANCH: 'customer-my-garage-portal',
    MY_GARAGE_QA_ENABLED: '',
  }, () => {
    assert.equal(qa.isHarnessEnabled(), false);
  });
});

test('harness enabled only on approved branch context', () => {
  withEnv({
    CONTEXT: 'branch-deploy',
    BRANCH: 'customer-my-garage-portal',
    MY_GARAGE_QA_ENABLED: 'true',
  }, () => {
    assert.equal(qa.isHarnessEnabled(), true);
  });
});

test('function requires admin authorization when enabled', async () => {
  withEnv({
    CONTEXT: 'branch-deploy',
    BRANCH: 'customer-my-garage-portal',
    MY_GARAGE_QA_ENABLED: 'true',
    ADMIN_DASH_PASSWORD: 'test-admin-password-32chars-minimum',
    ADMIN_SESSION_SECRET: 'test-admin-session-secret-32chars-min',
  }, async () => {
    const res = await handlerMod.handler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify({ action: 'inspect' }),
    });
    assert.equal(res.statusCode, 401);
  });
});

test('only QA-MYGARAGE-prefixed records are allowed', () => {
  assert.equal(qa.isAllowedQaBookingId('QA-MYGARAGE-A'), true);
  assert.equal(qa.isAllowedQaBookingId('CD1-REAL'), false);
  assert.equal(qa.isAllowedQaBooking({
    id: 'QA-MYGARAGE-A',
    qaFixture: true,
    qaBranch: 'customer-my-garage-portal',
  }), true);
  assert.equal(qa.isAllowedQaBooking({
    id: 'QA-MYGARAGE-A',
    qaFixture: false,
    qaBranch: 'customer-my-garage-portal',
  }), false);
});

test('seed requires branch-scoped QA emails from env', async () => {
  withEnv({
    MY_GARAGE_QA_EMAIL_A: '',
    MY_GARAGE_QA_EMAIL_B: '',
  }, async () => {
    const result = await qa.seedFixtures();
    assert.equal(result.ok, false);
    assert.equal(result.error, 'validation_error');
  });
});

test('fixtures expire within 24 hours', () => {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + qa.QA_TTL_MS).toISOString();
  const booking = qa.buildBookingA('qa-a@example.com', now, expiresAt);
  const delta = Date.parse(booking.qaExpiresAt) - Date.parse(booking.qaCreatedAt);
  assert.ok(delta > 0 && delta <= qa.QA_TTL_MS + 1000);
});

test('harness responses do not expose environment variable names', () => {
  const src = read('netlify/functions/qa-my-garage-fixtures.js') + read('netlify/lib/qa-my-garage-fixtures.js');
  assert.doesNotMatch(src, /jsonCors\(200,\s*\{[^}]*emailA/);
  assert.doesNotMatch(src, /STRIPE_SECRET_KEY[^|]*,\s*$/m);
  assert.match(src, /stripeMode:\s*mode/);
  assert.match(src, /emailsConfigured:\s*true/);
  assert.match(src, /stripeCheckoutExercised:\s*false/);
});

test('seed targets exactly two fixture booking IDs', () => {
  const now = new Date().toISOString();
  const exp = new Date(Date.now() + qa.QA_TTL_MS).toISOString();
  assert.equal(qa.buildBookingA('a@example.com', now, exp).id, qa.BOOKING_A_ID);
  assert.equal(qa.buildBookingB('b@example.com', now, exp, 'https://example.test').id, qa.BOOKING_B_ID);
});

test('harness does not call Stripe in live mode', () => {
  const src = read('netlify/lib/qa-my-garage-fixtures.js');
  assert.doesNotMatch(src, /api\.stripe\.com/);
  assert.doesNotMatch(src, /stripe\.checkout/);
  withEnv({ STRIPE_SECRET_KEY: 'sk_live_placeholder_not_real_key_value' }, () => {
    assert.equal(qa.stripeMode(), 'live');
    const booking = qa.buildBookingB('b@example.com', new Date().toISOString(), new Date().toISOString(), 'https://qa-inert.cardetail1-branch.local/pay/QA-MYGARAGE-B?mode=inert&qa=1');
    assert.equal(booking.qaInertPayLink, true);
  });
});

test('QA bookings are marked test and excluded from reporting flags', () => {
  const now = new Date().toISOString();
  const exp = new Date(Date.now() + qa.QA_TTL_MS).toISOString();
  const a = qa.buildBookingA('a@example.com', now, exp);
  assert.equal(a.isTest, true);
  assert.equal(a.qaFixture, true);
  assert.equal(a.excludeFromReporting, true);
  assert.equal(a.suppressRecovery, true);
  assert.equal(a.suppressHubspot, true);
});

test('handler returns 404 when disabled', async () => {
  withEnv({ CONTEXT: 'production', BRANCH: 'customer-my-garage-portal', MY_GARAGE_QA_ENABLED: 'true' }, async () => {
    const res = await handlerMod.handler({
      httpMethod: 'POST',
      headers: { 'x-admin-key': 'x'.repeat(32) },
      body: JSON.stringify({ action: 'seed' }),
    });
    assert.equal(res.statusCode, 404);
  });
});

test('customer portal functions unchanged except new QA lib', () => {
  const portalSrc = read('netlify/functions/customer-portal-data.js');
  assert.doesNotMatch(portalSrc, /qa-my-garage/);
  assert.match(read('netlify/functions/submit-customer-action.js'), /createChangeRequest/);
});
