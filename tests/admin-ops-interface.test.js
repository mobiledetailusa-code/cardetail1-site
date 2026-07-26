const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const adminOps = read('admin-ops.html');
const adminRequests = read('netlify/functions/admin-customer-requests.js');
const adminSecurity = read('netlify/lib/admin-security.js');
const rateLimit = read('netlify/lib/public-rate-limit.js');
const catalog = read('netlify/lib/customer-catalog.js');

function extractInlineScript(html) {
  const m = html.match(/<script>\s*\(function\(\)\{[\s\S]*\}\)\(\);\s*<\/script>/);
  return m ? m[0].replace(/<\/?script>/g, '') : '';
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
  assert.match(adminOps, /class="tab on"[^>]*data-tab="overview"/);
  assert.match(adminOps, /class="panel on" id="p-overview"/);
});

test('refreshAll tracks settings and change requests independently', () => {
  assert.match(adminOps, /const \[jobsR, techsR, settingsR, changeR, incompleteR\] = await Promise\.allSettled/);
  assert.match(adminOps, /if \(changeR\.status === 'rejected'\) changeRequests = \[\]/);
  assert.doesNotMatch(adminOps, /if \(reqR\.status === 'rejected'\) changeRequests/);
  assert.match(adminOps, /settingsR\.status === 'rejected'\).*settings \(/);
  assert.match(adminOps, /changeR\.status === 'rejected'\).*change requests \(/);
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
  assert.match(adminOps, /admin-customer-requests\?action=list/);
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
