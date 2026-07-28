'use strict';

/**
 * Staging Owner Studio Customer Lifecycle authenticated E2E (API).
 * Uses synthetic reversible draft values. Never prints full admin tokens.
 */

const https = require('https');

const BASE = 'https://cardetail1-staging.netlify.app';
const USER = process.env.STAGING_ADMIN_USER || 'staging-owner';
const PASS = process.env.STAGING_ADMIN_PASS || '';

function req(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const data = body != null ? Buffer.from(JSON.stringify(body)) : null;
    const r = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: {
        ...headers,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* ignore */ }
        resolve({ status: res.statusCode, json, text, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  if (!PASS) {
    console.log(JSON.stringify({ ok: false, error: 'missing_STAGING_ADMIN_PASS' }));
    process.exit(1);
  }
  const results = {};

  const login = await req('POST', '/.netlify/functions/admin-auth', {
    body: { username: USER, password: PASS },
  });
  assert(login.status === 200 && login.json?.ok && login.json.token, `login_failed:${login.status}`);
  const token = login.json.token;
  results.login = { status: login.status, ok: true, tokenLen: token.length };

  const authHeaders = { 'x-admin-key': token };

  const csrf = await req('GET', '/.netlify/functions/owner-studio-customer-lifecycle?action=csrf', {
    headers: authHeaders,
  });
  assert(csrf.status === 200 && csrf.json?.csrfToken, `csrf_failed:${csrf.status}:${csrf.text.slice(0, 120)}`);
  const csrfToken = csrf.json.csrfToken;
  results.csrf = { status: csrf.status, ok: true };

  const get1 = await req('GET', '/.netlify/functions/owner-studio-customer-lifecycle', { headers: authHeaders });
  assert(get1.status === 200 && get1.json?.ok, `get_failed:${get1.status}`);
  results.get = {
    status: get1.status,
    version: get1.json.draft?.version,
    publishAvailable: get1.json.publishAvailable,
    liveBillingEnabled: get1.json.liveBillingEnabled,
    publicContentSource: get1.json.publicContentSource,
  };
  const v1 = Number(get1.json.draft.version);

  const mutHeaders = { ...authHeaders, 'x-csrf-token': csrfToken };
  const save = await req('POST', '/.netlify/functions/owner-studio-customer-lifecycle', {
    headers: mutHeaders,
    body: {
      mutation: 'save_draft',
      expectedVersion: v1,
      draft: {
        siteId: 'browser-forged-should-ignore',
        maintenanceRules: {
          ruleVersion: 'maint-rules-audit-e2e',
          windows: { eligibleMaxDays: 45, recurringMaxDays: 90, graceMaxDays: 120 },
        },
        membershipPlans: [{
          planId: 'priority_access',
          priceCents: 999,
          billingModel: 'access_fee',
          label: 'Priority Access',
        }],
        simulatorAssumptions: { membersAt25: 25 },
        auditNote: 'lifecycle-audit-e2e',
      },
    },
  });
  assert(save.status === 200 && save.json?.ok, `save_failed:${save.status}:${save.text.slice(0, 200)}`);
  results.save = {
    status: save.status,
    version: save.json.draft?.version,
    revisionId: save.json.revisionId ? 'present' : null,
    versionIncremented: Number(save.json.draft?.version) === v1 + 1,
  };
  const v2 = Number(save.json.draft.version);

  const reload = await req('GET', '/.netlify/functions/owner-studio-customer-lifecycle', { headers: authHeaders });
  results.reload = {
    status: reload.status,
    version: reload.json?.draft?.version,
    auditNote: reload.json?.draft?.auditNote,
    ruleVersion: reload.json?.draft?.maintenanceRules?.ruleVersion,
    persisted: reload.json?.draft?.maintenanceRules?.ruleVersion === 'maint-rules-audit-e2e'
      && Number(reload.json?.draft?.version) === v2,
  };

  const stale = await req('POST', '/.netlify/functions/owner-studio-customer-lifecycle', {
    headers: mutHeaders,
    body: { mutation: 'save_draft', expectedVersion: v1, draft: { auditNote: 'stale-tab' } },
  });
  results.stale409 = {
    status: stale.status,
    error: stale.json?.error || null,
    ok: stale.status === 409,
  };

  const revs = await req('GET', '/.netlify/functions/owner-studio-customer-lifecycle?action=list_revisions', {
    headers: authHeaders,
  });
  const revisionId = revs.json?.revisions?.[0]?.revisionId;
  results.revisions = { status: revs.status, count: revs.json?.revisions?.length || 0, hasRevision: !!revisionId };

  let restore = { status: 0 };
  if (revisionId) {
    restore = await req('POST', '/.netlify/functions/owner-studio-customer-lifecycle', {
      headers: mutHeaders,
      body: {
        mutation: 'restore_revision',
        revisionId,
        expectedVersion: Number(reload.json?.draft?.version || v2),
      },
    });
  }
  results.restore = {
    status: restore.status,
    ok: !!(restore.json && restore.json.ok),
    newVersion: restore.json?.draft?.version,
    newRevision: restore.json?.revisionId ? 'present' : null,
  };

  const denies = {};
  for (const mutation of ['publish', 'create_stripe_subscription', 'activate_membership']) {
    const r = await req('POST', '/.netlify/functions/owner-studio-customer-lifecycle', {
      headers: mutHeaders,
      body: { mutation },
    });
    denies[mutation] = { status: r.status, error: r.json?.error || null };
  }
  results.denies = denies;

  const noCsrf = await req('POST', '/.netlify/functions/owner-studio-customer-lifecycle', {
    headers: authHeaders,
    body: { mutation: 'save_draft', expectedVersion: 999, draft: {} },
  });
  results.csrfRequired = { status: noCsrf.status, error: noCsrf.json?.error || null };

  const ok = results.login.ok
    && results.csrf.ok
    && results.get.publishAvailable === false
    && results.get.liveBillingEnabled === false
    && results.get.publicContentSource === 'legacy'
    && results.save.versionIncremented
    && results.reload.persisted
    && results.stale409.ok
    && results.restore.ok
    && denies.publish.status === 403
    && denies.create_stripe_subscription.status === 403
    && results.csrfRequired.status === 403;

  console.log(JSON.stringify({ ok, results }, null, 2));
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: String(e.message || e) }));
  process.exit(1);
});
