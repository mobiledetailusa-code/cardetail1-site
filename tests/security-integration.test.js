// End-to-end security invariants — deploy-62 design + ops/security stack.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const index = read('index.html');
const adminOps = read('admin-ops.html');
const customer = read('customer.html');
const technician = read('technician.html');
const adminSec = read('netlify/lib/admin-security.js');
const techSec = read('netlify/lib/tech-security.js');

const protectedFns = [
  'admin-ops-jobs.js', 'tech-accounts.js', 'ops-settings.js',
  'list-bookings.js', 'capture-payment.js', 'create-payment-intent.js',
  'create-payment-link.js', 'upload.ts',
];

test('public homepage login routes to enterprise admin-ops console', () => {
  assert.match(index, /admin-auth/);
  assert.match(index, /admin-ops\.html/);
  assert.match(index, /login-user/);
  assert.doesNotMatch(index.slice(index.indexOf('async function doLogin'), index.indexOf('async function doLogin') + 900), /admin-ov.*classList\.add\('open'\)/);
});

test('admin-ops and admin.html use session token auth', () => {
  assert.match(adminOps, /CD1AdminSession|cd1_admin_sess/);
  assert.match(adminOps, /x-admin-key/);
  assert.match(adminOps, /admin-auth/);
  assert.match(read('admin.html'), /admin-ops\.html/);
});

test('technician portal uses tech token header', () => {
  assert.match(technician, /cd1_tech_token/);
  assert.match(technician, /x-tech-token/);
  assert.match(technician, /tech-auth/);
});

test('customer portal verifies possession without exposing stripe ids', () => {
  assert.match(customer, /customer-bookings|lookup-booking/);
  assert.doesNotMatch(customer, /setupIntentId/);
  assert.doesNotMatch(customer, /stripeCustomerId/);
});

test('admin security module provides stateless tokens and redaction', () => {
  assert.match(adminSec, /verifyAdminRequest/);
  assert.match(adminSec, /redactBookingForLegacyAdmin/);
  assert.match(adminSec, /timingSafeEqual/);
});

test('tech security delegates admin verify to admin-security', () => {
  assert.match(techSec, /verifyAdminRequest/);
  assert.match(techSec, /validateTechSession/);
});

test('protected admin endpoints require verifyAdminKey', () => {
  for (const fn of protectedFns) {
    const src = read(`netlify/functions/${fn}`);
    assert.match(src, /verifyAdminKey|endpoint_disabled/, `${fn} should be protected or disabled`);
  }
});

test('deploy-62 premium visuals present on booking surfaces', () => {
  assert.match(index, /svc-ico-photo/);
  assert.match(index, /assets\/vehicles\/premium\/cars-suvs\.webp/);
  assert.match(index, /CATEGORY_VISUALS/);
});

test('monthly maintenance plan routes to customer subscription portal', () => {
  assert.match(index, /customer\.html\?subscribe=1/);
});

test('customer subscription checkout rejects client price fields server-side', () => {
  const subCheckout = read('netlify/functions/customer-subscription-checkout.js');
  const subLib = read('netlify/lib/subscription-checkout.js');
  assert.match(subLib, /client_price_not_allowed/);
  assert.match(subCheckout, /rejectClientPriceFields/);
  assert.match(subCheckout, /booking_id_required/);
  assert.match(customer, /customer-subscription-checkout/);
  assert.match(customer, /action:'list_catalog'/);
  assert.doesNotMatch(customer, /monthlyPrice:/);
});

test('checkout keeps optimistic client save with server retry', () => {
  assert.match(index, /waitForVerifiedCardSave/);
  assert.match(read('netlify/functions/submit-booking.js'), /reconcileCardOnFileFromStripe/);
});
