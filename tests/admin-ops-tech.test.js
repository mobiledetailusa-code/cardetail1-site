const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const index = read('index.html');
const admin = read('admin.html');
const adminOps = read('admin-ops.html');
const tech = read('technician.html');
const techAuth = read('netlify/functions/tech-auth.js');
const techAccounts = read('netlify/functions/tech-accounts.js');
const techJobs = read('netlify/functions/tech-jobs.js');
const techComplete = read('netlify/functions/tech-complete-job.js');
const techAssign = read('netlify/functions/tech-assignment.js');
const adminOpsJobs = read('netlify/functions/admin-ops-jobs.js');
const webhook = read('netlify/functions/stripe-webhook.js');
const submit = read('netlify/functions/submit-booking.js');
const setup = read('netlify/functions/create-setup-intent.js');

test('public index.html unchanged by admin/tech ops work', () => {
  assert.doesNotMatch(index, /tech-complete-job/);
  assert.doesNotMatch(index, /tech-jobs/);
  assert.match(index, /const PRICING\s*=/);
});

test('admin-ops has sign out and technician portal link with bypass', () => {
  assert.match(adminOps, /btnLogout/);
  assert.match(adminOps, /adminLogout/);
  assert.match(adminOps, /technician\.html\?portal=tech/);
  assert.match(tech, /portalTech/);
  assert.match(tech, /get\('portal'\)\s*===\s*'tech'/);
});

test('admin login routes to admin-ops.html with username+password token', () => {
  assert.match(admin, /location\.href\s*=\s*'admin-ops\.html'/);
  assert.match(admin, /location\.replace\('admin-ops\.html'\)/);
  assert.match(admin, /id="user"/);
  assert.match(admin, /data\.token/);
});

test('admin-ops dashboard loads required tabs and APIs', () => {
  assert.match(adminOps, /admin-ops-jobs/);
  assert.match(adminOps, /tech-accounts/);
  assert.match(adminOps, /tech-assignment/);
  assert.match(adminOps, /Overview/);
  assert.match(adminOps, /Jobs Board/);
  assert.match(adminOps, /Technician Management/);
  assert.match(adminOps, /Completed/);
  assert.match(adminOps, /approve_completion/);
  assert.match(adminOps, /admin-job-payment/);
  assert.match(adminOps, /charge_card_on_file|Charge card on file/);
  assert.match(adminOps, /mark_cash_paid|Mark cash paid/);
  assert.doesNotMatch(adminOps, /stripe\.confirmPayment/);
});

test('admin-ops has auction, settings, subscriptions tabs', () => {
  assert.match(adminOps, /data-tab="auctions"/);
  assert.match(adminOps, /data-tab="settings"/);
  assert.match(adminOps, /data-tab="subscriptions"/);
  assert.match(adminOps, /ops-settings/);
  assert.match(adminOps, /post_to_auction/);
});

test('technician portal has onboarding and auction bidding', () => {
  assert.match(tech, /s-onboard/);
  assert.match(tech, /tech-profile/);
  assert.match(tech, /tech-auctions/);
  assert.match(tech, /placeBid/);
  assert.match(tech, /equipmentHints/);
});

test('technician portal is tech-only with completion modal', () => {
  assert.doesNotMatch(tech, /id="s-admin"/);
  assert.doesNotMatch(tech, /renderAvail/);
  assert.doesNotMatch(tech, /acceptJob/);
  assert.match(tech, /tech-auth/);
  assert.match(tech, /tech-jobs/);
  assert.match(tech, /tech-complete-job/);
  assert.match(tech, /complete-modal/);
  assert.match(tech, /customerAuthorizationAccepted/);
  assert.doesNotMatch(tech, /stripeCustomerId/);
  assert.doesNotMatch(tech, /paymentIntentId/);
  assert.doesNotMatch(tech, /cardOnFileStatus/);
});

test('tech-complete-job does not call Stripe or set payment succeeded', () => {
  assert.match(techComplete, /completed_pending_admin_review/);
  assert.match(techComplete, /paymentWorkflowStatus:\s*'pending_admin_review'/);
  assert.doesNotMatch(techComplete, /stripe\.com/);
  assert.doesNotMatch(techComplete, /payment_succeeded/);
  assert.doesNotMatch(techComplete, /invoice/);
});

test('technician jobs endpoint blocks completion status', () => {
  assert.doesNotMatch(techJobs, /'completed'/);
  assert.match(techJobs, /TECH_STATUS_UPDATES/);
});

test('tech accounts admin can set password', () => {
  assert.match(techAccounts, /set_password/);
  assert.match(techAccounts, /hashPassword/);
  assert.match(adminOps, /openTechDrawer/);
  assert.match(adminOps, /setTechPassword/);
  assert.match(adminOps, /toggleTechFromDrawer/);
});

test('tech accounts use invite expiry and hide password hash', () => {
  assert.match(techAccounts, /INVITE_TTL_MS/);
  assert.match(techAccounts, /projectTechAccountForAdmin/);
  const proj = read('netlify/lib/ops-workflow.js').match(/function projectTechAccountForAdmin[\s\S]*?^}/m);
  assert.ok(proj);
  assert.match(proj[0], /passwordHash/);
  assert.doesNotMatch(proj[0], /passwordHash:/);
});

test('assignment writes assignedTechId and eventLog', () => {
  assert.match(techAssign, /assignedTechId/);
  assert.match(techAssign, /jobStatus:\s*'assigned'/);
  assert.match(techAssign, /appendEventLog/);
});

test('admin ops jobs strips stripe fields from response', () => {
  assert.match(adminOpsJobs, /delete j\.stripeCustomerId/);
  assert.match(adminOpsJobs, /approve_completion/);
  assert.match(adminOpsJobs, /reopen_job/);
});

test('no payment charge regression in protected stripe files', () => {
  assert.doesNotMatch(webhook, /admin-ops/);
  assert.match(submit, /cardOnFileStatus/);
  assert.match(setup, /setup_intents/);
});

test('tech auth stores hashed passwords not plain text', () => {
  assert.match(techAuth, /hashPassword/);
  assert.match(techAuth, /passwordHash = hashPassword/);
  assert.match(techAuth, /inviteToken = null/);
});

test('protected public surfaces unchanged vs card-on-file base', () => {
  const pricing = index.match(/const PRICING\s*=\s*\{[\s\S]*?\n\};/);
  assert.ok(pricing, 'PRICING block exists');
  assert.doesNotMatch(index, /tech-complete-job/);
  assert.doesNotMatch(index, /tech-jobs/);
});

test('ops workflow separates jobStatus and paymentWorkflowStatus', () => {
  const ops = read('netlify/lib/ops-workflow.js');
  assert.match(ops, /JOB_STATUSES/);
  assert.match(ops, /PAYMENT_WORKFLOW_STATUSES/);
  assert.match(ops, /normalizeJobStatus/);
  assert.match(ops, /normalizePaymentWorkflowStatus/);
});

test('technician payload strips stripe sensitive fields', () => {
  const ops = read('netlify/lib/ops-workflow.js');
  assert.match(ops, /STRIPE_SENSITIVE/);
  const techProj = ops.match(/function projectJobForTech[\s\S]*?^}/m);
  assert.ok(techProj);
  assert.doesNotMatch(techProj[0], /stripeCustomerId/);
});

test('technician cannot access admin endpoints from portal', () => {
  assert.doesNotMatch(tech, /admin-ops-jobs/);
  assert.doesNotMatch(tech, /tech-accounts/);
  assert.doesNotMatch(tech, /tech-assignment/);
  assert.doesNotMatch(tech, /x-admin-key/);
});

test('tech assignment requires admin key', () => {
  assert.match(techAssign, /verifyAdminKey/);
  assert.match(techAssign, /await verifyAdminKey/);
  assert.doesNotMatch(techAssign, /validateTechSession/);
});

test('admin ops jobs requires admin key not tech session', () => {
  assert.match(adminOpsJobs, /verifyAdminKey/);
  assert.match(adminOpsJobs, /await verifyAdminKey/);
  assert.doesNotMatch(adminOpsJobs, /validateTechSession/);
});

test('technician complete uses modal not instant status complete', () => {
  assert.match(tech, /openComplete/);
  assert.match(tech, /id="complete-modal"/);
  assert.doesNotMatch(tech, /status:\s*'completed'/);
  assert.doesNotMatch(techJobs, /completed_pending_admin_review/);
});

test('technician portal status workflow endpoints', () => {
  assert.match(tech, /en_route/);
  assert.match(tech, /arrived/);
  assert.match(tech, /in_progress/);
  assert.match(tech, /issue_reported/);
  assert.match(tech, /accepted/);
});

test('invite security: expiry and single use', () => {
  assert.match(techAuth, /inviteExpiresAt/);
  assert.match(techAuth, /inviteToken = null/);
  assert.match(read('netlify/lib/tech-security.js'), /INVITE_TTL_MS = 72 \* 60 \* 60 \* 1000/);
});

test('inactive technician rejected at login', () => {
  assert.match(techAuth, /!tech\.active/);
  assert.match(read('netlify/lib/tech-security.js'), /!tech \|\| !tech\.active/);
});

test('completion authorization text version saved server-side', () => {
  assert.match(techComplete, /completion-auth-v1/);
  assert.match(techComplete, /customerAuthorizationTextVersion/);
});

test('no stripe payment intent in non-payment ops functions', () => {
  for (const f of ['netlify/functions/tech-complete-job.js', 'netlify/functions/tech-assignment.js', 'netlify/functions/tech-jobs.js', 'netlify/functions/tech-accounts.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /paymentIntents\.create/);
  }
});

test('admin-job-payment handles stripe payment intents idempotently', () => {
  const lib = read('netlify/lib/admin-job-payment.js');
  assert.match(lib, /payment_intents/);
  assert.match(lib, /Idempotency-Key/);
  assert.match(read('netlify/functions/admin-job-payment.js'), /verifyAdminKey/);
});

test('admin ops supports operational actions', () => {
  assert.match(adminOpsJobs, /confirm_booking/);
  assert.match(adminOpsJobs, /reschedule/);
  assert.match(adminOpsJobs, /update_address/);
  assert.match(adminOpsJobs, /cancel_booking/);
  assert.match(adminOpsJobs, /bulk_archive_tests/);
  assert.match(adminOpsJobs, /archive_test/);
});

test('admin-ops UI has maintenance and requests tabs', () => {
  assert.match(adminOps, /Customer Requests/);
  assert.match(adminOps, /Maintenance/);
  assert.match(adminOps, /btnArchiveTests/);
  assert.match(adminOps, /confirm_booking/);
  assert.match(adminOps, /update_address/);
});

test('technician portal has directions link', () => {
  assert.match(tech, /google\.com\/maps/);
});

test('inline portal scripts compile', () => {
  const jsScripts = html => [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .filter(m => !/type\s*=\s*["']application\/ld\+json["']/i.test(m[0]));
  for (const [file, html] of [['admin-ops.html', adminOps], ['technician.html', tech]]) {
    jsScripts(html).forEach((m, i) => {
      assert.doesNotThrow(() => new Function(m[1]), `${file} script ${i + 1} should compile`);
    });
  }
});
