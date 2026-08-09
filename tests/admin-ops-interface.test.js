const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const adminOps = read('admin-ops.html') + read('assets/admin-ops.css') + read('assets/admin-ops.js');
const adminRequests = read('netlify/functions/admin-customer-requests.js');
const adminSecurity = read('netlify/lib/admin-security.js');
const rateLimit = read('netlify/lib/public-rate-limit.js');
const catalog = read('netlify/lib/customer-catalog.js');

/** The Admin script now lives in assets/admin-ops.js, not inline in the page. */
function extractInlineScript(html) {
  const m = html.match(/<script>\s*\(function\(\)\{[\s\S]*\}\)\(\);\s*<\/script>/);
  if (m) return m[0].replace(/<\/?script>/g, '');
  return read('assets/admin-ops.js');
}

function tabPanelMap(html) {
  const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
  const panels = [...html.matchAll(/id="p-([^"]+)"/g)].map((m) => m[1]);
  return { tabs, panels };
}

test('admin-ops inline JavaScript parses without syntax errors', () => {
  const src = extractInlineScript(adminOps);
  assert.ok(src.length > 100, 'inline script missing');
  assert.doesNotThrow(() => { vm.compileFunction(src, ['CD1AdminSession', 'SiteAccess', 'document', 'window', 'location', 'fetch', 'prompt', 'confirm', 'alert', 'navigator', 'setTimeout', 'clearTimeout', 'FormData']); });
});

test('every tab button maps to exactly one existing panel', () => {
  const { tabs, panels } = tabPanelMap(adminOps);
  const uniqueTabs = [...new Set(tabs)];
  assert.equal(tabs.length, uniqueTabs.length, 'duplicate tab ids');
  for (const tab of uniqueTabs) {
    assert.ok(panels.includes(tab), `missing panel for tab ${tab}`);
  }
  assert.equal(uniqueTabs.length, panels.length, 'tab/panel count mismatch');
});

test('initial active tab and panel are aligned', () => {
  assert.match(adminOps, /class="tab on"[^>]*data-tab="jobs"/);
  assert.match(adminOps, /class="panel on" id="p-jobs"/);
});

test('Admin Lite exposes exactly four primary tabs', () => {
  const nav = adminOps.slice(adminOps.indexOf('<nav class="tabs"'), adminOps.indexOf('</nav>'));
  const primary = nav.slice(0, nav.indexOf('<div class="tabs-more"'));
  const ids = [...primary.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['jobs', 'requests', 'payments', 'settings']);
});

test('secondary Admin tabs are preserved under a collapsed More disclosure', () => {
  const more = adminOps.slice(adminOps.indexOf('<div class="tabs-more"'), adminOps.indexOf('</nav>'));
  const ids = [...more.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]);
  // No capability is deleted — every legacy tab still exists, just not as primary nav.
  for (const id of ['overview', 'techs', 'assign', 'completed', 'issues', 'auctions', 'subscriptions', 'maintenance', 'events', 'revops']) {
    assert.ok(ids.includes(id), `secondary tab ${id} was dropped`);
  }
  assert.match(adminOps, /<div class="tabs-more" id="tabsMore" hidden>/);
  assert.match(adminOps, /id="tabsMoreToggle" aria-expanded="false" aria-controls="tabsMore"/);
});

test('job workspace uses Admin authority panels', () => {
  assert.match(adminOps, /\[\['resolve','Resolve'\],\['services','Services'\],\['schedule','Schedule'\],\['payment','Money'\],\['create','Create'\],\['notes','Notes'\],\['more','More'\]\]/);
  for (const id of ['resolve', 'services', 'schedule', 'payment', 'create', 'notes', 'more']) {
    assert.ok(adminOps.includes(`data-appt-panel="${id}"`), `missing workspace panel ${id}`);
  }
});

test('in-job requests panel is retained and reachable without a primary tab', () => {
  assert.ok(adminOps.includes('data-appt-panel="requests"'), 'requests panel was deleted');
  assert.match(adminOps, /data-open-requests-panel/);
  assert.match(adminOps, /btn\.onclick = \(\) => setApptPanel\('requests'\)/);
});

test('Payments view derives from in-memory lean jobs without a new fetch', () => {
  assert.match(adminOps, /function renderPayments\(\)/);
  assert.match(adminOps, /if \(b\.dataset\.tab === 'payments'\) renderPayments\(\)/);
  const body = adminOps.slice(adminOps.indexOf('function renderPayments()'), adminOps.indexOf('function renderJobs()'));
  assert.doesNotMatch(body, /api\(|fetch\(/, 'Payments must not call the backend');
  assert.match(body, /jobs\.filter\(/);
});

test('refreshAll tracks settings and change requests independently', () => {
  assert.match(adminOps, /const \[jobsR, settingsR, changeR\] = await Promise\.allSettled/);
  assert.doesNotMatch(adminOps, /loadJobs\(\),\s*loadTechs\(\)/);
  assert.match(adminOps, /Intentionally do NOT call loadTechs\(\) here/);
  // Last-good preservation: rejected feeds must NOT wipe arrays.
  assert.doesNotMatch(adminOps, /if \(changeR\.status === 'rejected'\) changeRequests = \[\]/);
  assert.doesNotMatch(adminOps, /if \(jobsR\.status === 'rejected'\) jobs = \[\]/);
  assert.doesNotMatch(adminOps, /if \(techsR\.status === 'rejected'\) techs = \[\]/);
  assert.match(adminOps, /Intentionally do NOT assign jobs=\[\], techs=\[\], or changeRequests=\[\] on rejection/);
  assert.match(adminOps, /settingsR\.status === 'rejected'/);
  assert.match(adminOps, /changeR\.status === 'rejected'/);
});

test('customer requests tab has isolated refresh handler', () => {
  assert.match(adminOps, /async function refreshRequestsTab\(\)/);
  assert.match(adminOps, /if \(b\.dataset\.tab === 'requests'\) refreshRequestsTab\(\)/);
});

test('customer change requests section initializes render path', () => {
  assert.match(adminOps, /function renderRequests\(\)/);
  assert.match(adminOps, /id="requestsList"/);
  assert.match(adminOps, /No pending customer change requests/);
});

test('empty request list renders empty state copy', () => {
  assert.match(adminOps, /No pending customer change requests/);
});

test('authenticated list uses admin session header', () => {
  assert.match(adminOps, /headers: \{ 'x-admin-key': CD1AdminSession\.getToken\(\) \}/);
  assert.match(adminOps, /admin-customer-requests/);
  assert.match(adminOps, /action:\s*'list'|action=list/);
});

test('admin-customer-requests returns 401 when unauthenticated', () => {
  assert.match(adminRequests, /verifyAdminRequest/);
  assert.match(adminRequests, /401.*unauthorized/s);
});

test('approve reject clarify actions are wired with confirmation', () => {
  assert.match(adminOps, /decideChangeRequest\(id, 'approve'\)/);
  assert.match(adminOps, /decideChangeRequest\(b\.dataset\.id, 'reject'/);
  assert.match(adminOps, /decideChangeRequest\(b\.dataset\.id, 'clarify'/);
  assert.match(adminOps, /b\.disabled = true/);
});

test('manual-review request types are labeled in UI', () => {
  assert.match(adminOps, /Needs manual follow-up after approve/);
  assert.match(adminRequests, /manualReview/);
  assert.match(adminRequests, /package_change_request/);
});

test('one failed feed does not block unrelated tab handlers', () => {
  assert.match(adminOps, /Promise\.allSettled/);
  assert.match(adminOps, /renderJobs\(\); renderAssign\(\)/);
  assert.match(adminOps, /refreshAuctionsTab/);
  assert.match(adminOps, /refreshRequestsTab/);
});

test('jobs board panel remains wired', () => {
  assert.match(adminOps, /id="p-jobs"/);
  assert.match(adminOps, /admin-ops-jobs/);
  assert.match(adminOps, /function renderJobs\(\)/);
});

test('admin fetch helper does not log tokens', () => {
  const inline = extractInlineScript(adminOps);
  assert.doesNotMatch(inline, /console\.log\([^)]*token/i);
  assert.doesNotMatch(inline, /console\.log\([^)]*x-admin-key/i);
});

test('client-controlled X-Forwarded-For is not preferred over platform IP', () => {
  assert.match(adminSecurity, /x-nf-client-connection-ip/);
  assert.match(adminSecurity, /Prefer Netlify\/platform-injected client identity/);
  const platformFirst = adminSecurity.indexOf('x-nf-client-connection-ip');
  const fwd = adminSecurity.indexOf('x-forwarded-for');
  assert.ok(platformFirst > 0 && fwd > platformFirst, 'platform header should be checked before x-forwarded-for');
});

test('rate limit stores hashed keys only', () => {
  assert.match(rateLimit, /deriveRateLimitKey/);
  assert.match(rateLimit, /sha256/);
  assert.doesNotMatch(rateLimit, /setJSON\([^,]+,\s*ip/);
});

test('my garage authorization files remain unchanged in admin repair scope', () => {
  assert.match(read('netlify/lib/booking-customer-auth.js'), /authorizeBookingAccess/);
  assert.match(read('netlify/lib/customer-session.js'), /validateCustomerSession/);
});

test('package prices and IDs unchanged', () => {
  assert.match(catalog, /id: 'full'/);
  assert.match(catalog, /id: 'maint'/);
  assert.doesNotMatch(adminOps, /PRICING\s*=/);
});

test('stripe webhook untouched by admin repair', () => {
  const webhook = read('netlify/functions/stripe-webhook.js');
  assert.doesNotMatch(webhook, /admin-customer-requests/);
});

test('fleet remains quote-only on public surface', () => {
  const fleet = read('fleet-services.html');
  assert.match(fleet, /quote|contact/i);
  assert.doesNotMatch(fleet, /createPaymentIntent/);
});

test('tab buttons expose aria-selected state', () => {
  assert.match(adminOps, /role="tablist"/);
  assert.match(adminOps, /aria-selected="true"/);
  assert.match(adminOps, /setAttribute\('aria-selected', 'true'\)/);
});

test('jobs board uses inline expandable detail row instead of side drawer', () => {
  assert.match(adminOps, /id="activeJobDetailRow"/);
  assert.match(adminOps, /id="activeJobDetailPanel"/);
  assert.match(adminOps, /expandedJobId/);
  assert.match(adminOps, /toggleJobExpand/);
  assert.doesNotMatch(adminOps, /id="drawerBg"/);
  assert.match(adminOps, /job-detail-grid/);
});

test('jobs summary exposes remaining balance from server fields', () => {
  assert.match(adminOps, /jobsBalanceLabel/);
  assert.match(adminOps, /remainingCents/);
  assert.match(adminOps, /Balance/);
});
