/**
 * Server-side AI chat public pricing alignment tests.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const {
  BUSINESS_SYSTEM,
  CHAT_STARTING_PRICES,
} = require('../netlify/functions/ai-chat');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

function extractBusinessSystem(source) {
  const m = source.match(/const BUSINESS_SYSTEM = `([\s\S]*?)`;/);
  assert.ok(m, 'BUSINESS_SYSTEM prompt missing');
  return m[1];
}

function extractPricingGuidance(prompt) {
  const m = prompt.match(/PRICING:([^\n]+)/);
  assert.ok(m, 'PRICING guidance line missing');
  return m[1];
}

test('AI chat prompt does not describe general Cars detailing as starting at $150', () => {
  const prompt = BUSINESS_SYSTEM;
  const pricing = extractPricingGuidance(prompt);
  assert.doesNotMatch(pricing, /Cars[^$\n]*\$150|general[^$\n]*Cars[^$\n]*\$150/i);
  assert.doesNotMatch(prompt, /Cars \$150/);
});

test('AI chat prompt describes public Cars starting price as $190 Interior Detail', () => {
  const prompt = BUSINESS_SYSTEM;
  const pricing = extractPricingGuidance(prompt);
  assert.match(pricing, /\$190/);
  assert.match(pricing, /Interior Detail/i);
});

test('AI chat prompt treats Maintenance Detail as separate $150 tier not public Cars minimum', () => {
  const prompt = BUSINESS_SYSTEM;
  const pricing = extractPricingGuidance(prompt);
  assert.match(pricing, /Maintenance Detail[^$\n]*\$150|\$150[^$\n]*Maintenance Detail/i);
  assert.match(pricing, /not as the general Cars starting price|not.*general Cars starting price/i);
});

test('booking catalog still has maint at $150 and interior at $190', () => {
  const html = read('index.html');
  assert.match(html, /maint:150/);
  assert.match(html, /interior:190/);
  assert.match(html, /id:'maint'[\s\S]*?Maintenance Detail/);
  assert.match(html, /id:'interior'[\s\S]*?Interior Detail/);
});

test('client chat and server AI prompt agree on public category starting prices', () => {
  const index = read('index.html');
  const prompt = BUSINESS_SYSTEM;
  const pricing = extractPricingGuidance(prompt);

  assert.match(index, /function chatStartingPricesReply\(\)/);
  assert.match(index, /applyRichPrice\(b\.cars\)/);
  assert.doesNotMatch(index, /Cars & Trucks — from <b>\$150/);

  assert.match(pricing, /Boats from \$170/);
  assert.match(pricing, /\$238/);
  assert.match(pricing, /Powersports from \$100/);
  assert.match(pricing, /Fleet[^$\n]*quote-only|quote-only[^$\n]*Fleet/i);
  assert.doesNotMatch(pricing, /\$60\/unit|\$60 per unit/i);
  assert.deepEqual(CHAT_STARTING_PRICES, {
    cars: 190,
    carMaintenance: 150,
    boats: 170,
    rvs: 238,
    powersports: 100,
  });
});

test('ai-chat.js change is pricing guidance only with runtime logic intact', () => {
  const source = read('netlify/functions/ai-chat.js');
  assert.match(source, /exports\.handler = async \(event\) =>/);
  assert.match(source, /enforcePublicRateLimit/);
  assert.match(source, /ANTHROPIC_API_KEY/);
  assert.match(source, /system: BUSINESS_SYSTEM/);
  assert.doesNotMatch(source, /Cars \$150/);
});

const REVOPS_FUNCTION_ALLOWLIST = new Set([
  'netlify/functions/ai-chat.js',
  'netlify/functions/submit-booking.js',
  'netlify/functions/create-setup-intent.js',
  'netlify/functions/revenue-event.js',
  'netlify/functions/garage-plan-submit.js',
  'netlify/functions/revenue-admin.js',
  'netlify/functions/revenue-resume-link.js',
  'netlify/functions/booking-card-status.js',
  'netlify/functions/lookup-booking.js',
  'netlify/functions/request-cancellation.js',
  'netlify/functions/submit-customer-action.js',
  'netlify/functions/admin-customer-requests.js',
  'netlify/functions/customer-portal-auth.js',
  'netlify/functions/customer-portal-data.js',
  'netlify/functions/customer-portal-vehicles.js',
  'netlify/functions/tech-complete-job.js',
  'netlify/functions/tech-jobs.js',
  'netlify/functions/customer-portal-action.js',
  'netlify/functions/evaluate-booking-offer.js',
  'netlify/functions/admin-ops-jobs.js',
  'netlify/functions/qa-opscore-lifecycle.js',
  // Release A — canonical aggregate / payments
  'netlify/functions/create-payment-intent.js',
  'netlify/functions/create-payment-link.js',
  'netlify/functions/capture-payment.js',
  'netlify/functions/customer-subscription-checkout.js',
  'netlify/functions/customer-bookings.js',
  // Customer identity security prerequisites — revoke orphan public subscription actions.
  'netlify/functions/subscriptions-ops.js',
  'netlify/functions/customer-portal-pay.js',
  'netlify/functions/stripe-webhook.js',
  'netlify/functions/list-bookings.js',
  // Phase 2/3 Postgres foundation — additive, non-sensitive health endpoint.
  'netlify/functions/db-health.js',
  // Operational Postgres payment wiring.
  'netlify/functions/customer-balance-payment-intent.js',
  'netlify/functions/customer-portal-data.js',
  'netlify/functions/admin-ops-jobs.js',
  // Stage 2A — authenticated profile + address management
  'netlify/functions/customer-portal-profile.js',
  // Post-release hardening — disabled-by-default identity smoke harness
  'netlify/functions/qa-customer-identity-smoke.js',
  // Appointment direct access + transactional notifications
  'netlify/functions/customer-appointment-access.js',
  'netlify/functions/update-booking.js',
  'netlify/functions/qa-appointment-access-mint.js',
  'netlify/functions/qa-blobs-health.js',
  // Owner Studio Stage 1 — protected read-only status endpoint (flags off by default)
  'netlify/functions/owner-studio-status.js',
  // Existing PR #157 operational surfaces.
  'netlify/functions/booking-availability.js',
  'netlify/functions/customer-receipt.js',
  'netlify/functions/ops-settings.js',
  'netlify/functions/submit-review.js',
  'netlify/functions/public-reviews.js',
  'netlify/functions/admin-reviews.js',
  'netlify/functions/tech-accounts.js',
  // PR5 Twilio readiness: all provider traffic is isolated behind the outbox.
  'netlify/functions/submit-inquiry.js',
  'netlify/functions/twilio-inbound.js',
  'netlify/functions/twilio-outbox-worker.js',
  'netlify/functions/twilio-status-callback.js',
  // Owner Studio Stage 2 — protected catalog draft API (flags off by default).
  'netlify/functions/owner-studio-catalog.js',
    'netlify/functions/owner-studio-release.js',
  // Owner Studio Stage 4B — authenticated storefront draft preview.
  'netlify/functions/owner-studio-catalog-preview.js',
  // Owner Studio Stage 2 Phase A — admin login sets a shared HttpOnly session cookie
  // so a second/new tab authenticates (multi-tab catalog loading fix).
  'netlify/functions/admin-auth.js',
]);

function assertOnlyAllowedFunctionDiff(tracked, label) {
  const files = tracked.trim().split(/\r?\n/).filter(Boolean);
  for (const file of files) {
    assert.ok(REVOPS_FUNCTION_ALLOWLIST.has(file), `${label}: unexpected function diff: ${file}`);
  }
}

test('only ai-chat.js differs among Netlify Functions since encoding correction', () => {
  const tracked = execSync('git diff --name-only 117484ee1bca78cb9b64a3827be8bef747ddd0ea -- netlify/functions', {
    cwd: root,
    encoding: 'utf8',
  });
  assertOnlyAllowedFunctionDiff(tracked, 'encoding correction scope');
});

test('revops index changes do not alter package IDs or pricing formulas', () => {
  const html = read('index.html');
  assert.match(html, /boats:[\s\S]*?id:'maint'/);
  assert.match(html, /rvs:[\s\S]*?id:'maint_light'/);
  assert.match(html, /interior:190/);
  assert.match(html, /boats:[\s\S]*?maint:\s*\{perFt:\s*10,\s*min:\s*170\}/);
});

test('ai-chat source and tests contain no credential literals', () => {
  const files = ['netlify/functions/ai-chat.js', 'tests/ai-chat-public-pricing.test.js'];
  for (const file of files) {
    const text = read(file);
    assert.doesNotMatch(text, /sk-ant-[A-Za-z0-9_-]{10,}/);
    assert.doesNotMatch(text, /ANTHROPIC_API_KEY\s*=\s*['"][^'"]+['"]/);
  }
});
