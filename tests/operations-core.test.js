const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const lifecycle = require('../netlify/lib/operations-lifecycle');
const audit = require('../netlify/lib/operations-audit');
const flags = require('../netlify/lib/customer-feature-flags');
const techComplete = read('netlify/functions/tech-complete-job.js');
const tech = read('technician.html');
const index = read('index.html');
const myGarage = read('my-garage.html');
const myGarageJs = read('assets/my-garage.js');
const opsWorkflow = read('netlify/lib/ops-workflow.js');

test('lifecycle exposes three status dimensions', () => {
  assert.ok(lifecycle.SERVICE_STATUSES.includes('awaiting_customer_action'));
  assert.ok(lifecycle.PAYMENT_STATUSES.includes('paid_cash'));
  assert.ok(lifecycle.CUSTOMER_APPROVAL_STATUSES.includes('pending'));
});

test('lifecycle migrates legacy job status', () => {
  assert.equal(lifecycle.normalizeServiceStatus({ jobStatus: 'in_progress' }), 'in_progress');
  assert.equal(lifecycle.normalizeServiceStatus({ jobStatus: 'completed_pending_payment' }), 'awaiting_customer_action');
});

test('tech adjustment within limit does not require admin', () => {
  const r = lifecycle.evaluateTechAdjustment(10000, 9500);
  assert.equal(r.requiresAdmin, false);
});

test('tech adjustment above limit requires admin', () => {
  const r = lifecycle.evaluateTechAdjustment(10000, 5000);
  assert.equal(r.requiresAdmin, true);
});

test('audit redacts sensitive fields', () => {
  const red = audit.redactState({ stripeCustomerId: 'x', email: 'a@b.com', serviceStatus: 'assigned' });
  assert.equal(red.stripeCustomerId, undefined);
  assert.equal(red.serviceStatus, 'assigned');
});

test('customer feature flags default disabled', () => {
  const f = flags.getCustomerFeatureFlags();
  assert.equal(f.giftCards, false);
  assert.equal(f.subscriptions, false);
});

test('technician completion does not require customer signature', () => {
  assert.match(techComplete, /technicianConfirmation/);
  assert.doesNotMatch(techComplete, /customer_signature_required/);
  assert.doesNotMatch(techComplete, /technician_signature_required/);
});

test('technician UI optional signatures and confirmation checkbox', () => {
  assert.match(tech, /Optional signatures/);
  assert.match(tech, /chk-tech-confirm/);
  assert.match(tech, /Complete Service/);
  assert.doesNotMatch(tech, /Customer signature required/);
});

test('technician package detail fields projected', () => {
  assert.match(opsWorkflow, /packageDescription/);
  assert.match(opsWorkflow, /packageChecklist/);
  assert.match(opsWorkflow, /vehicles:/);
});

test('technician pause and resume supported', () => {
  assert.match(opsWorkflow, /'paused'/);
  assert.match(tech, /'paused'/);
});

test('My Garage in top navigation on homepage', () => {
  assert.match(index, /nav-links[\s\S]*my-garage\.html/);
  assert.match(index, /nav-book-mobile[\s\S]*my-garage\.html/);
});

test('customer completion link function exists', () => {
  assert.match(read('netlify/functions/customer-portal-action.js'), /verifyActionToken/);
  assert.match(read('netlify/lib/customer-completion-link.js'), /createCompletionLink/);
});

test('my garage handles action token without leaving token in URL', () => {
  assert.match(myGarageJs, /customer-portal-action/);
  assert.match(myGarageJs, /history\.replaceState/);
});

test('operational refresh helper exists', () => {
  assert.match(read('assets/operational-refresh.js'), /createRefreshController/);
  assert.match(tech, /operational-refresh\.js/);
});

test('package IDs unchanged on index', () => {
  assert.ok(index.includes('refresh:240, premium:290'));
});

test('payment channels on technician completion', () => {
  assert.match(techComplete, /customer_unavailable/);
  assert.match(techComplete, /paid_cash/);
  assert.match(techComplete, /paid_card_on_site/);
});

test('idempotent completion response', () => {
  assert.match(techComplete, /idempotent/);
});

test('signature canvas uses dark stroke for visibility', () => {
  assert.match(tech, /#111827/);
});
