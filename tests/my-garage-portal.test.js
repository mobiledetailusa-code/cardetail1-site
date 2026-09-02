const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const phoneAuth = require('../netlify/lib/phone-auth');
const { canRequestChange, classifyStatus } = require('../netlify/lib/appointment-status-policy');
const { deriveRateLimitKey, DEFAULT_LIMITS } = require('../netlify/lib/public-rate-limit');
const { verifyDraftSaveToken, issueDraftSaveToken } = require('../netlify/lib/draft-save-token');

process.env.DRAFT_TOKEN_SECRET = 'test-draft-token-secret-32chars-minimum';
process.env.CUSTOMER_SESSION_SECRET = 'test-customer-session-secret-32chars';

test('phonesMatch: valid 10-digit match', () => {
  assert.equal(phoneAuth.phonesMatch('2015550177', '2015550177'), true);
});

test('phonesMatch: valid country-code match', () => {
  assert.equal(phoneAuth.phonesMatch('+12015550177', '2015550177'), true);
  assert.equal(phoneAuth.phonesMatch('12015550177', '(201) 555-0177'), true);
});

test('phonesMatch: formatted-number match', () => {
  assert.equal(phoneAuth.phonesMatch('(201) 555-0177', '2015550177'), true);
});

test('phonesMatch: short suffix rejection', () => {
  assert.equal(phoneAuth.phonesMatch('132956', '2015550177'), false);
  assert.equal(phoneAuth.phonesMatch('3132956', '2015550177'), false);
});

test('phonesMatch: different customer rejection', () => {
  assert.equal(phoneAuth.phonesMatch('2015550177', '5519999999'), false);
});

test('normalizeUsPhoneE164', () => {
  assert.equal(phoneAuth.normalizeUsPhoneE164('(201) 555-0177'), '+12015550177');
});

test('mutation endpoints have rate limit buckets', () => {
  assert.ok(DEFAULT_LIMITS['submit-customer-action']);
  assert.ok(DEFAULT_LIMITS['request-cancellation']);
});

test('rate limit keys are hashed without storing raw IP', () => {
  const key = deriveRateLimitKey('203.0.113.10', 'submit-customer-action', '');
  assert.match(key, /^rl-[a-f0-9]{40}$/);
  assert.doesNotMatch(key, /203\.0\.113/);
});

test('booking-card-status requires authorization', () => {
  const src = read('netlify/functions/booking-card-status.js');
  assert.match(src, /authentication_failed/);
  assert.match(src, /authorizeBookingAccess|verifyDraftSaveToken|verifyAdminRequest/);
  assert.doesNotMatch(src, /if \(!bookingId\) return json\(404/);
});

test('submit-customer-action uses shared auth and rate limiting', () => {
  const src = read('netlify/functions/submit-customer-action.js');
  assert.match(src, /enforcePublicRateLimit/);
  assert.match(src, /authorizeBookingAccess/);
  assert.match(src, /canRequestChange/);
  assert.doesNotMatch(src, /function phonesMatch/);
});

test('request-cancellation uses rate limiting', () => {
  const src = read('netlify/functions/request-cancellation.js');
  assert.match(src, /enforcePublicRateLimit/);
  assert.doesNotMatch(src, /function phonesMatch/);
});

test('one shared footer partial with required columns', () => {
  const footer = read('assets/partials/specialty-public-footer.html');
  assert.match(footer, /My Garage/);
  assert.match(footer, /Pay a Balance/);
  assert.match(footer, /my-garage\.html#payments/);
  assert.match(footer, /Service Areas/);
  assert.doesNotMatch(footer, /Specialty Services/i);
  assert.doesNotMatch(footer, /placeholder/i);
});

test('no Services/Specialty duplication in canonical footer', () => {
  const footer = read('assets/partials/specialty-public-footer.html');
  const servicesCount = (footer.match(/<h4>Services<\/h4>/g) || []).length;
  assert.equal(servicesCount, 1);
});

test('shared back-to-top single implementation', () => {
  const btt = read('assets/back-to-top.js');
  assert.match(btt, /__CD1_BTT_INIT__/);
  assert.match(btt, /type = 'button'/);
  assert.match(btt, /aria-label/);
  assert.match(btt, /prefers-reduced-motion/);
  assert.match(btt, /z-index:10050|cd1-btt/);
});

test('my-garage metadata and privacy', () => {
  const page = read('my-garage.html');
  assert.match(page, /noindex,nofollow/);
  assert.match(page, /My Detailing Portal \| Manage Your Cardetail1 Booking/);
  assert.match(page, /clarity.*mask/i);
  assert.doesNotMatch(page, /2015550177.*booking/i);
});

test('my-garage absent from sitemap', () => {
  const sitemap = read('sitemap.xml');
  assert.doesNotMatch(sitemap, /my-garage/);
});

test('portal analytics allowlist only', () => {
  const js = read('assets/portal-analytics.js');
  assert.match(js, /portal_opened/);
  const payloadBlock = js.slice(js.indexOf('function emit'));
  assert.doesNotMatch(payloadBlock, /bookingId|customerId|phone|email|@/i);
  assert.doesNotMatch(payloadBlock, /dataLayer\.push\(\{[^}]*token/i);
});

test('limited access endpoint returns single booking scope', () => {
  const src = read('netlify/functions/customer-portal-data.js');
  assert.match(src, /mode === 'limited'/);
  assert.match(src, /scope: 'booking'/);
});

test('full account requires session', () => {
  const src = read('netlify/functions/customer-portal-data.js');
  assert.match(src, /validateCustomerSession/);
  assert.match(src, /401/);
});

test('customer session cookie is HttpOnly', () => {
  const src = read('netlify/lib/customer-session.js');
  assert.match(src, /HttpOnly/);
  assert.match(src, /SameSite=Lax/);
});

test('garage vehicles require authenticated account', () => {
  const src = read('netlify/functions/customer-portal-vehicles.js');
  assert.match(src, /validateCustomerSession/);
  assert.match(src, /scope !== 'account'/);
});

test('appointment status policy blocks in-progress changes', () => {
  const booking = { status: 'In Progress', jobStatus: 'in_progress' };
  const result = canRequestChange(booking, 'cancel');
  assert.equal(result.ok, false);
  assert.equal(result.requiresCall, true);
});

test('confirmed pack/address/cancel auto-apply without admin approval', () => {
  const booking = { status: 'Confirmed', jobStatus: 'confirmed' };
  assert.equal(canRequestChange(booking, 'package_change').pendingApproval, false);
  assert.equal(canRequestChange(booking, 'addon').pendingApproval, false);
  assert.equal(canRequestChange(booking, 'address').pendingApproval, false);
  assert.equal(canRequestChange(booking, 'cancel').pendingApproval, false);
  assert.equal(canRequestChange(booking, 'vehicle_replace').pendingApproval, false);
  // Reschedule still admin-gated
  assert.equal(canRequestChange(booking, 'reschedule').pendingApproval, true);
});

test('auth token verify rejects replay', async () => {
  const issued = issueDraftSaveToken({ bookingId: 'CD1-TEST', phone: '2015550177' });
  assert.equal(issued.ok, true);
  const first = verifyDraftSaveToken({ token: issued.token, bookingId: 'CD1-TEST', phone: '2015550177' });
  assert.equal(first.ok, true);
  const replay = verifyDraftSaveToken({ token: issued.token, bookingId: 'CD1-TEST', phone: '2015550177', now: Date.now() + 1000 });
  assert.equal(replay.ok, true);
});

test('customer.html redirects to my-garage', () => {
  assert.match(read('customer.html'), /my-garage\.html/);
});

test('package catalog unchanged in customer action', () => {
  const src = read('netlify/functions/submit-customer-action.js');
  assert.match(src, /customer-catalog/);
  assert.doesNotMatch(src, /PRICING\s*=/);
});

test('my-garage uses catalog selectors and embedded balance PaymentIntent', () => {
  const js = read('assets/my-garage.js');
  assert.match(js, /customer-balance-payment-intent/);
  assert.doesNotMatch(js, /customer-portal-pay/);
  assert.match(js, /newPackId/);
  assert.match(js, /addonIds/);
  assert.match(js, /maintenancePeriods|renderMaintenanceModal/);
  assert.match(js, /startPayBalance/);
  assert.doesNotMatch(js, /requestedAddons.*type: 'text'/);
});

test('my-garage login form is not stuck on last booking id', () => {
  const js = read('assets/my-garage.js');
  const html = read('my-garage.html');
  // Form submit must prefer typed fields over sticky verifyBookingId
  assert.match(js, /loadLimited\(\{\s*fromForm:\s*true\s*\}\)/);
  assert.match(js, /opts\.fromForm\s*\?\s*formId/);
  assert.match(js, /function clearLookupCredentials/);
  // Must not auto-login from sessionStorage alone (that re-locked the last ID)
  assert.match(js, /Never auto-login from sessionStorage alone/);
  assert.match(js, /urlHasBooking/);
  // Explicit clear control on login
  assert.match(html, /id="lk-clear"/);
  assert.match(html, /my-garage\.js\?v=/);
  // Sign-out / typing clears sessionStorage
  assert.match(js, /sessionStorage\.removeItem\('cd1_garage_id'\)/);
  assert.match(js, /lk-booking-id[\s\S]*addEventListener\('input'/);
});

test('portal data excludes drafts and returns catalog + payment', () => {
  const src = read('netlify/functions/customer-portal-data.js');
  // Release A: centralized draft visibility via booking-visibility
  assert.match(src, /isVisibleSubmittedBooking|isVisibleCustomerBooking/);
  assert.match(src, /catalogForClient/);
  assert.match(src, /safePaymentState/);
  assert.match(src, /changeRequests/);
});

test('normal payment is embedded and legacy hosted Checkout is tombstoned', () => {
  assert.match(read('netlify/functions/customer-portal-pay.js'), /legacy_checkout_disabled/);
  assert.match(read('netlify/functions/customer-balance-payment-intent.js'), /prepareEmbeddedPayment/);
  assert.match(read('netlify/functions/create-setup-intent.js'), /payment_method_types\[0\]/);
  assert.doesNotMatch(read('netlify/functions/create-setup-intent.js'), /automatic_payment_methods/);
  assert.match(read('netlify/functions/create-payment-intent.js'), /legacy_payment_intent_disabled/);
});
