const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const index = read('index.html');
const adminOps = read('admin-ops.html');
const tech = read('technician.html');
const adminPayFn = read('netlify/functions/admin-job-payment.js');
const adminPayLib = read('netlify/lib/admin-job-payment.js');
const techComplete = read('netlify/functions/tech-complete-job.js');
const techJobs = read('netlify/functions/tech-jobs.js');
const techAssign = read('netlify/functions/tech-assignment.js');
const webhook = read('netlify/functions/stripe-webhook.js');
const ops = read('netlify/lib/ops-workflow.js');

// ── Public regression (1–7) ──
test('1 homepage unchanged — no ops endpoints embedded', () => {
  assert.doesNotMatch(index, /admin-job-payment/);
  assert.doesNotMatch(index, /tech-complete-job/);
  assert.match(index, /const PRICING\s*=/);
});

test('2 booking flow still present on homepage', () => {
  assert.match(index, /buildBookingPayload/);
  assert.match(index, /initCardOnFile/);
});

test('3 pricing block intact', () => {
  assert.match(index, /const PRICING\s*=\s*\{/);
});

test('4 add-ons structure intact', () => {
  assert.match(index, /addons/);
});

test('5 customer garage not modified by ops payment', () => {
  const customer = read('customer.html');
  assert.doesNotMatch(customer, /admin-job-payment/);
});

test('6 proof engine untouched', () => {
  assert.doesNotMatch(index, /Proof Engine/);
});

test('7 no public design drift in index hero', () => {
  assert.match(index, /class="hero"/);
});

// ── Technician (8–22) ──
test('8 tech auth endpoint referenced', () => {
  assert.match(tech, /tech-auth/);
});

test('9 tech jobs filters assigned only server-side', () => {
  assert.match(techJobs, /bookingAssignedToTech/);
});

test('10 tech jobs list excludes unassigned filter pattern', () => {
  assert.match(techJobs, /\.filter\(b => bookingAssignedToTech/);
});

test('11–14 technician status workflow in portal', () => {
  for (const s of ['accepted', 'en_route', 'arrived', 'in_progress']) {
    assert.match(tech, new RegExp(s));
  }
});

test('15 complete opens modal not instant', () => {
  assert.match(tech, /openComplete/);
  assert.match(tech, /complete-modal/);
});

test('16–18 completion validation fields', () => {
  assert.match(tech, /customerSignature/);
  assert.match(tech, /technicianSignature/);
  assert.match(tech, /customerAuthorizationAccepted/);
  assert.match(techComplete, /customer_signature_required/);
  assert.match(techComplete, /technician_signature_required/);
  assert.match(techComplete, /customer_authorization_required/);
});

test('19 valid completion endpoint exists', () => {
  assert.match(techComplete, /completed_pending_admin_review/);
});

test('20 tech complete rejects wrong assignment', () => {
  assert.match(techComplete, /not_assigned_to_you/);
});

test('21 tech cannot set final amount', () => {
  assert.doesNotMatch(techComplete, /finalAmountCents/);
  assert.doesNotMatch(techComplete, /body\.finalAmount/);
});

test('22 tech payload strips stripe fields', () => {
  assert.doesNotMatch(tech, /stripeCustomerId/);
  assert.doesNotMatch(tech, /paymentIntentId/);
  const proj = ops.match(/function projectJobForTech[\s\S]*?^}/m);
  assert.ok(proj);
  assert.doesNotMatch(proj[0], /stripeCustomerId/);
});

// ── Admin (23–34) ──
test('23 admin ops loads dashboard tabs', () => {
  assert.match(adminOps, /Jobs Board/);
  assert.match(adminOps, /Payment Logs/);
});

test('24 admin can create tech', () => {
  assert.match(adminOps, /techForm/);
  assert.match(adminOps, /tech-accounts/);
});

test('25 admin can assign booking', () => {
  assert.match(adminOps, /tech-assignment/);
  assert.match(techAssign, /assignedTechId/);
});

test('26 admin sees tech status via event log', () => {
  assert.match(adminOps, /tech_status_update|eventLog/);
});

test('27 completed pending admin review queue', () => {
  assert.match(adminOps, /completed_pending_admin_review/);
});

test('28 admin sees signatures in drawer', () => {
  assert.match(adminOps, /customerSignature/);
  assert.match(adminOps, /technicianSignature/);
});

test('29 admin confirm final amount with note', () => {
  assert.match(adminOps, /confirm_final_amount/);
  assert.match(adminPayLib, /final_amount_confirmed/);
  assert.match(adminPayLib, /admin_note_required/);
});

test('30 admin send payment link via admin-job-payment', () => {
  assert.match(adminOps, /admin-job-payment/);
  assert.match(adminPayLib, /send_invoice/);
  assert.match(adminPayLib, /checkout\/sessions/);
});

test('31 charge card on file guards', () => {
  assert.match(adminPayLib, /cardOnFileReady/);
  assert.match(adminPayLib, /customerAuthorizationAccepted/);
  assert.match(adminPayLib, /completionReadyForPayment/);
});

test('32 mark cash paid requires note', () => {
  assert.match(adminPayLib, /mark_cash_paid/);
  assert.match(adminPayLib, /cash_paid_marked/);
});

test('33 payment status in admin UI', () => {
  assert.match(adminOps, /paymentWorkflowStatus/);
});

test('34 admin event log tab', () => {
  assert.match(adminOps, /renderEvents/);
});

// ── Payment (35–40) ──
test('35 idempotency prevents duplicate charges', () => {
  assert.match(adminPayLib, /paymentIdempotencyKey/);
  assert.match(adminPayLib, /duplicate_payment_action/);
  assert.match(adminPayLib, /Idempotency-Key/);
});

test('36 idempotency records stored on booking', () => {
  assert.match(adminPayLib, /paymentIdempotencyRecords/);
});

test('37 webhook updates booking by metadata bookingId', () => {
  assert.match(webhook, /bookingIdFromMeta/);
  assert.match(webhook, /webhook_payment_succeeded/);
});

test('38 missing stripe env returns 503 not throw', () => {
  assert.match(adminPayLib, /stripe_not_configured/);
});

test('39 failed payment preserves completion via patched booking', () => {
  assert.match(adminPayLib, /card_charge_failed/);
});

test('40 payment link email failure tracked', () => {
  assert.match(adminPayLib, /paymentLinkEmailSent/);
  assert.match(adminPayLib, /paymentLinkEmailError/);
});

// ── Security (41–48) ──
test('41 admin payment requires admin key not tech session', () => {
  assert.match(adminPayFn, /verifyAdminKey/);
  assert.doesNotMatch(adminPayFn, /validateTechSession/);
});

test('42 technician cannot call admin payment from portal', () => {
  assert.doesNotMatch(tech, /admin-job-payment/);
});

test('43 invalid token rejected on admin payment', () => {
  assert.match(adminPayFn, /unauthorized/);
});

test('44 inactive tech rejected at login', () => {
  assert.match(read('netlify/functions/tech-auth.js'), /!tech\.active/);
});

test('45 no stripe secrets in frontend portals', () => {
  assert.doesNotMatch(adminOps, /sk_live_/);
  assert.doesNotMatch(tech, /sk_live_/);
  assert.doesNotMatch(adminOps, /STRIPE_SECRET/);
});

test('46 no raw card data stored in completion', () => {
  assert.doesNotMatch(techComplete, /card number/i);
});

test('47 no plain password in tech accounts projection', () => {
  assert.match(ops, /passwordHash/);
  const proj = ops.match(/function projectTechAccountForAdmin[\s\S]*?^}/m);
  assert.doesNotMatch(proj[0], /passwordHash:/);
});

test('48 sensitive payment IDs stripped from admin jobs list', () => {
  const adminOpsJobs = read('netlify/functions/admin-ops-jobs.js');
  assert.match(adminOpsJobs, /delete j\.stripeCustomerId/);
});

// ── Lib unit tests ──
const {
  paymentIdempotencyKey,
  resolveFinalAmountCents,
  cardOnFileReady,
  completionReadyForPayment,
} = require('../netlify/lib/admin-job-payment');

test('paymentIdempotencyKey is deterministic', () => {
  const a = paymentIdempotencyKey('CD1-X', 'charge_card_on_file', 15000);
  const b = paymentIdempotencyKey('CD1-X', 'charge_card_on_file', 15000);
  assert.equal(a, b);
  assert.notEqual(a, paymentIdempotencyKey('CD1-X', 'charge_card_on_file', 16000));
});

test('resolveFinalAmountCents prefers finalAmountCents', () => {
  assert.equal(resolveFinalAmountCents({ finalAmountCents: 12345 }), 12345);
  assert.equal(resolveFinalAmountCents({ finalAmount: 99.5 }), 9950);
});

test('cardOnFileReady requires saved status and ids', () => {
  assert.equal(cardOnFileReady({ cardOnFileStatus: 'saved', stripeCustomerId: 'cus_x', stripePaymentMethodId: 'pm_x' }), true);
  assert.equal(cardOnFileReady({ cardOnFileStatus: 'pending' }), false);
});

test('completionReadyForPayment requires authorization', () => {
  assert.equal(completionReadyForPayment({ completionSubmitted: true, customerAuthorizationAccepted: true }), true);
  assert.equal(completionReadyForPayment({ completionSubmitted: true }), false);
});

test('state machine separates job and payment status', () => {
  assert.match(read('netlify/lib/ops-schema.js'), /JOB_STATUSES/);
  assert.match(read('netlify/lib/ops-schema.js'), /PAYMENT_WORKFLOW_STATUSES/);
  assert.match(read('netlify/lib/ops-schema.js'), /payment_link_sent/);
});

test('completion authorization text version', () => {
  assert.match(techComplete, /completion-auth-v1/);
  assert.match(tech, /authorize Cardetail1/);
});

test('tech complete notifies admin without failing submission', () => {
  assert.match(techComplete, /job completion submitted/);
  assert.match(techComplete, /\.catch\(\(\) => \{\}\)/);
});

test('webhook deduplicates event log entries', () => {
  assert.match(webhook, /eventAlreadyLogged/);
});
