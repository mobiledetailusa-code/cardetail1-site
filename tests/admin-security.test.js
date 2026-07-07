// Admin security — session tokens, credential verify, booking redaction.
const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const ADMIN_SECURITY_PATH = require.resolve('../netlify/lib/admin-security');
const ADMIN_AUTH_PATH = require.resolve('../netlify/functions/admin-auth');

const TEST_SESSION_SECRET = 'a'.repeat(32);

const ENV_KEYS = [
  'ADMIN_USERNAME',
  'ADMIN_DASH_PASSWORD',
  'ADMIN_SESSION_SECRET',
  'BID_SECRET',
  'CONTEXT',
  'NETLIFY_DEV',
];

function snapshotEnv() {
  const snap = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap) {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
  delete require.cache[ADMIN_SECURITY_PATH];
  delete require.cache[ADMIN_AUTH_PATH];
}

function loadAdminSecurity() {
  delete require.cache[ADMIN_SECURITY_PATH];
  return require('../netlify/lib/admin-security');
}

function loadAdminAuth() {
  delete require.cache[ADMIN_AUTH_PATH];
  delete require.cache[ADMIN_SECURITY_PATH];
  return require('../netlify/functions/admin-auth').handler;
}

let envSnap = snapshotEnv();
afterEach(() => {
  restoreEnv(envSnap);
  envSnap = snapshotEnv();
});

const {
  verifyAdminCredentials,
  getAdminConfig,
  redactBookingForLegacyAdmin,
} = require('../netlify/lib/admin-security');

test('verifyAdminCredentials accepts username+password when env matches', () => {
  process.env.ADMIN_USERNAME = 'opsadmin';
  process.env.ADMIN_DASH_PASSWORD = 'Str0ng-Pass!';
  assert.equal(getAdminConfig().configured, true);
  assert.equal(verifyAdminCredentials('opsadmin', 'Str0ng-Pass!'), true);
  assert.equal(verifyAdminCredentials('OpsAdmin', 'Str0ng-Pass!'), true);
  assert.equal(verifyAdminCredentials('wrong', 'Str0ng-Pass!'), false);
  assert.equal(verifyAdminCredentials('opsadmin', 'wrong'), false);
});

test('redactBookingForLegacyAdmin strips Stripe secrets', () => {
  const out = redactBookingForLegacyAdmin({
    id: 'CD1-1',
    stripeCustomerId: 'cus_x',
    stripePaymentMethodId: 'pm_x',
    setupIntentId: 'seti_x',
    paymentIntentId: 'pi_x',
    stripeSubscriptionId: 'sub_x',
    firstName: 'A',
  });
  assert.equal(out.id, 'CD1-1');
  assert.equal(out.firstName, 'A');
  assert.equal(out.stripeCustomerId, undefined);
  assert.equal(out.paymentIntentId, undefined);
});

test('admin-auth handler rejects password-only legacy login', async () => {
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_DASH_PASSWORD = 'Test-Admin-99';
  process.env.ADMIN_SESSION_SECRET = TEST_SESSION_SECRET;
  const handler = loadAdminAuth();
  const res = await handler({
    httpMethod: 'POST',
    headers: {},
    body: JSON.stringify({ password: 'Test-Admin-99' }),
  });
  assert.equal(res.statusCode, 401);
});

test('list-bookings uses session auth and redacts stripe ids', () => {
  const lb = read('netlify/functions/list-bookings.js');
  assert.match(lb, /verifyAdminKey/);
  assert.match(lb, /redactBookingForLegacyAdmin/);
  assert.doesNotMatch(lb, /queryStringParameters\.key/);
});

test('create-payment-link requires admin session', () => {
  const fn = read('netlify/functions/create-payment-link.js');
  assert.match(fn, /verifyAdminKey/);
});

test('upload endpoint is disabled', () => {
  const up = read('netlify/functions/upload.ts');
  assert.match(up, /endpoint_disabled/);
});

test('production requires ADMIN_SESSION_SECRET for session signing', () => {
  process.env.CONTEXT = 'production';
  delete process.env.ADMIN_SESSION_SECRET;
  process.env.ADMIN_DASH_PASSWORD = 'Str0ng-Pass!';
  process.env.BID_SECRET = 'bid-secret-test-value-32chars!!';
  const { getSessionSecretStatus } = loadAdminSecurity();
  const status = getSessionSecretStatus();
  assert.equal(status.ok, false);
  assert.equal(status.error, 'missing_admin_session_secret');
});

test('production with ADMIN_SESSION_SECRET signs and validates v1 token', async () => {
  process.env.CONTEXT = 'production';
  process.env.ADMIN_SESSION_SECRET = TEST_SESSION_SECRET;
  process.env.ADMIN_DASH_PASSWORD = 'Str0ng-Pass!';
  delete process.env.BID_SECRET;
  const { createAdminSession, validateAdminToken } = loadAdminSecurity();
  const sess = await createAdminSession('opsadmin');
  assert.match(sess.token, /^v1\./);
  const validated = await validateAdminToken(sess.token);
  assert.equal(validated.username, 'opsadmin');
});

test('production rejects ADMIN_DASH_PASSWORD as session signing secret', async () => {
  process.env.CONTEXT = 'production';
  delete process.env.ADMIN_SESSION_SECRET;
  process.env.ADMIN_DASH_PASSWORD = 'Str0ng-Pass!';
  delete process.env.BID_SECRET;
  const { createAdminSession } = loadAdminSecurity();
  await assert.rejects(() => createAdminSession('opsadmin'), /missing_admin_session_secret/);
});

test('production rejects BID_SECRET as session signing secret', async () => {
  process.env.CONTEXT = 'production';
  delete process.env.ADMIN_SESSION_SECRET;
  delete process.env.ADMIN_DASH_PASSWORD;
  process.env.BID_SECRET = 'bid-secret-test-value-32chars!!';
  const { getSessionSecretStatus } = loadAdminSecurity();
  const status = getSessionSecretStatus();
  assert.equal(status.ok, false);
  assert.equal(status.error, 'missing_admin_session_secret');
});

test('production admin-auth login returns missing_admin_session_secret when secret absent', async () => {
  process.env.CONTEXT = 'production';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_DASH_PASSWORD = 'Test-Admin-99';
  delete process.env.ADMIN_SESSION_SECRET;
  const handler = loadAdminAuth();
  const res = await handler({
    httpMethod: 'POST',
    headers: {},
    body: JSON.stringify({ action: 'login', username: 'admin', password: 'Test-Admin-99' }),
  });
  assert.equal(res.statusCode, 503);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'missing_admin_session_secret');
});

test('production admin-auth login succeeds when ADMIN_SESSION_SECRET is configured', async () => {
  process.env.CONTEXT = 'production';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_DASH_PASSWORD = 'Test-Admin-99';
  process.env.ADMIN_SESSION_SECRET = TEST_SESSION_SECRET;
  const handler = loadAdminAuth();
  const res = await handler({
    httpMethod: 'POST',
    headers: {},
    body: JSON.stringify({ action: 'login', username: 'admin', password: 'Test-Admin-99' }),
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.match(body.token, /^v1\./);
});

test('dev/preview may use fallback secret with console warning', () => {
  delete process.env.CONTEXT;
  delete process.env.ADMIN_SESSION_SECRET;
  process.env.ADMIN_DASH_PASSWORD = 'dev-only-password';
  delete process.env.BID_SECRET;
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const { getSessionSecretStatus } = loadAdminSecurity();
    const status = getSessionSecretStatus();
    assert.equal(status.ok, true);
    assert.equal(status.usedFallback, true);
    assert.ok(warnings.some((w) => w.includes('ADMIN_SESSION_SECRET not set')));
  } finally {
    console.warn = originalWarn;
  }
});

test('createAdminSession returns v1 signed token with ADMIN_SESSION_SECRET in dev', async () => {
  delete process.env.CONTEXT;
  process.env.ADMIN_USERNAME = 'opsadmin';
  process.env.ADMIN_DASH_PASSWORD = 'Str0ng-Pass!';
  process.env.ADMIN_SESSION_SECRET = TEST_SESSION_SECRET;
  delete process.env.BID_SECRET;
  const { createAdminSession, validateAdminToken } = loadAdminSecurity();
  const sess = await createAdminSession('opsadmin');
  assert.match(sess.token, /^v1\./);
  const validated = await validateAdminToken(sess.token);
  assert.equal(validated.username, 'opsadmin');
});

test('verifyAdminKey rejects raw password in x-admin-key header', async () => {
  process.env.ADMIN_DASH_PASSWORD = 'Test-Admin-99';
  process.env.ADMIN_SESSION_SECRET = TEST_SESSION_SECRET;
  const { verifyAdminKey } = require('../netlify/lib/tech-security');
  const auth = await verifyAdminKey({ 'x-admin-key': 'Test-Admin-99' });
  assert.equal(auth.ok, false);
});
