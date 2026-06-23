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
  assert.doesNotMatch(index, /admin-ops\.html/);
  assert.doesNotMatch(index, /tech-complete-job/);
  assert.match(index, /const PRICING\s*=/);
});

test('admin login routes to admin-ops.html', () => {
  assert.match(admin, /location\.href\s*=\s*'admin-ops\.html'/);
  assert.match(admin, /location\.replace\('admin-ops\.html'\)/);
});

test('admin-ops dashboard loads required tabs and APIs', () => {
  assert.match(adminOps, /admin-ops-jobs/);
  assert.match(adminOps, /tech-accounts/);
  assert.match(adminOps, /tech-assignment/);
  assert.match(adminOps, /Overview/);
  assert.match(adminOps, /Jobs Board/);
  assert.match(adminOps, /Technician Management/);
  assert.match(adminOps, /Completed/);
  assert.match(adminOps, /Send Invoice — next PR/);
  assert.match(adminOps, /Charge Card on File — next PR/);
  assert.doesNotMatch(adminOps, /stripe\.confirmPayment/);
});

test('technician portal is tech-only with completion modal', () => {
  assert.doesNotMatch(tech, /id="s-admin"/);
  assert.doesNotMatch(tech, /renderAvail/);
  assert.doesNotMatch(tech, /acceptJob/);
  assert.match(tech, /tech-auth/);
  assert.match(tech, /tech-jobs/);
  assert.match(tech, /tech-complete-job/);
  assert.match(tech, /completion-modal/);
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

test('tech accounts use invite expiry and hide password hash', () => {
  assert.match(techAccounts, /INVITE_TTL_MS/);
  assert.match(techAccounts, /passwordHash/);
  assert.match(techAccounts, /projectTechAccountForAdmin/);
  assert.doesNotMatch(techAccounts, /passwordHash:/);
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
  assert.doesNotMatch(index, /admin-ops/);
  assert.doesNotMatch(index, /tech-complete-job/);
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
  assert.doesNotMatch(techAssign, /validateTechSession/);
});

test('admin ops jobs requires admin key not tech session', () => {
  assert.match(adminOpsJobs, /verifyAdminKey/);
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

test('no stripe payment intent or invoice in new ops functions', () => {
  for (const f of ['netlify/functions/tech-complete-job.js', 'netlify/functions/admin-ops-jobs.js', 'netlify/functions/tech-assignment.js', 'netlify/functions/tech-jobs.js', 'netlify/functions/tech-accounts.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /paymentIntents\.create/);
    assert.doesNotMatch(src, /invoices\.create/);
    assert.doesNotMatch(src, /paymentLinks\.create/);
  }
});

test('inline portal scripts compile', () => {
  for (const [file, html] of [['admin-ops.html', adminOps], ['technician.html', tech]]) {
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
    scripts.forEach((m, i) => {
      assert.doesNotThrow(() => new Function(m[1]), `${file} script ${i + 1} should compile`);
    });
  }
});
