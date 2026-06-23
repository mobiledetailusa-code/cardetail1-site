// Admin security — session tokens, credential verify, booking redaction.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

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
  delete require.cache[require.resolve('../netlify/functions/admin-auth')];
  const { handler } = require('../netlify/functions/admin-auth');
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

test('verifyAdminKey rejects raw password in x-admin-key header', async () => {
  process.env.ADMIN_DASH_PASSWORD = 'Test-Admin-99';
  const { verifyAdminKey } = require('../netlify/lib/tech-security');
  const auth = await verifyAdminKey({ 'x-admin-key': 'Test-Admin-99' });
  assert.equal(auth.ok, false);
});
