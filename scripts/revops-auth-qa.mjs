#!/usr/bin/env node
// Authenticated RevOps branch QA runner — never logs credentials or PII.
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://operations-core-job-lifecycle--cardetail1.netlify.app';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function redact(body) {
  if (!body || typeof body !== 'object') return body;
  const copy = JSON.parse(JSON.stringify(body));
  for (const key of ['token', 'email', 'phone', 'name']) {
    if (copy[key]) copy[key] = '[redacted]';
  }
  if (Array.isArray(copy.priorityQueue)) {
    copy.priorityQueue = copy.priorityQueue.map((row) => ({
      opportunityId: row.opportunityId ? String(row.opportunityId).slice(-8) : null,
      attentionReason: row.attentionReason,
      segment: row.segment,
      garagePlanStatus: row.garagePlanStatus,
      notificationStatus: row.notificationStatus,
      stage: row.stage,
    }));
  }
  if (Array.isArray(copy.garagePlanOpportunities)) {
    copy.garagePlanOpportunities = copy.garagePlanOpportunities.map((row) => ({
      opportunityId: row.opportunityId ? String(row.opportunityId).slice(-8) : null,
      garagePlanStatus: row.garagePlanStatus,
    }));
  }
  return copy;
}

async function fetchJson(path, { method = 'GET', token, body } = {}) {
  const started = Date.now();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-admin-key'] = token;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { parseError: true }; }
  return {
    status: res.status,
    ms: Date.now() - started,
    size: text.length,
    cacheControl: res.headers.get('cache-control'),
    json,
  };
}

function promptSecurePassword() {
  if (process.env.CD1_ADMIN_TOKEN) return null;
  if (process.env.ADMIN_DASH_PASSWORD) return null;
  const ps = spawnSync('powershell', [
    '-NoProfile', '-Command',
    '$sec = Read-Host -AsSecureString "Admin password (input hidden)"; ' +
    '$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec); ' +
    '$p = [Runtime.InteropServices.Marshal]::PtrToStringAuto($b); ' +
    '[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b); ' +
    'Write-Output $p',
  ], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
  const password = (ps.stdout || '').trim();
  return password || null;
}

async function login(username, password) {
  const res = await fetchJson('/.netlify/functions/admin-auth', {
    method: 'POST',
    body: { action: 'login', username, password },
  });
  if (res.status !== 200 || !res.json?.ok || !res.json?.token) {
    throw new Error(`admin_login_failed:${res.status}:${res.json?.error || 'unknown'}`);
  }
  return res.json.token;
}

function summarizeDashboard(json) {
  const s = json?.summary || {};
  return {
    ok: json?.ok,
    sessions: s.sessions || 0,
    bookingStarts: s.bookingStarts || 0,
    contactCaptures: s.contactCaptures || 0,
    paymentStepReaches: s.paymentStepReaches || 0,
    bookingSubmissions: s.bookingSubmissions || 0,
    garagePlanRequests: s.garagePlanRequests || 0,
    pipelineValue: s.estimatedPipelineValue || 0,
    priorityCount: (json?.priorityQueue || []).length,
    garageCount: (json?.garagePlanOpportunities || []).length,
    funnelSteps: (json?.funnel || []).length,
    sources: (json?.sources || []).length,
    categories: (json?.categories || []).length,
    pages: (json?.pages || []).length,
    warnings: json?.warnings || [],
    attentionReasons: [...new Set((json?.priorityQueue || []).map((i) => i.attentionReason))],
  };
}

async function main() {
  const report = {
    at: new Date().toISOString(),
    base: BASE,
    steps: [],
    pass: true,
  };

  let token = process.env.CD1_ADMIN_TOKEN || '';
  let password = null;

  try {
    if (!token) {
      password = process.env.ADMIN_DASH_PASSWORD || promptSecurePassword();
      if (!password) throw new Error('no_admin_credential_available');
      token = await login(process.env.ADMIN_USERNAME || 'admin', password);
      report.authMethod = process.env.ADMIN_DASH_PASSWORD ? 'env_password_login' : 'secure_prompt_login';
    } else {
      report.authMethod = 'env_token';
    }

    const unauth = await fetchJson('/.netlify/functions/revenue-admin?view=dashboard');
    report.steps.push({ step: 'unauthenticated', status: unauth.status, pass: unauth.status === 401 });

    const empty = await fetchJson('/.netlify/functions/revenue-admin?view=dashboard', { token });
    report.steps.push({
      step: 'empty_or_baseline_dashboard',
      status: empty.status,
      ms: empty.ms,
      size: empty.size,
      cacheControl: empty.cacheControl,
      summary: summarizeDashboard(empty.json),
      pass: empty.status === 200 && empty.json?.ok === true,
    });

    const cleanupFirst = await fetchJson('/.netlify/functions/qa-revops-lifecycle', {
      method: 'POST',
      token,
      body: { action: 'cleanup', qaFixture: true },
    });
    report.steps.push({
      step: 'precleanup',
      status: cleanupFirst.status,
      removed: cleanupFirst.json?.removed,
      pass: cleanupFirst.status === 200,
    });

    const seed = await fetchJson('/.netlify/functions/qa-revops-lifecycle', {
      method: 'POST',
      token,
      body: { action: 'seed', qaFixture: true },
    });
    report.steps.push({
      step: 'seed',
      status: seed.status,
      pass: seed.status === 200 && seed.json?.ok === true,
      eventsSeeded: seed.json?.eventsSeeded,
      opportunityCount: seed.json?.opportunities ? Object.keys(seed.json.opportunities).length : 0,
    });

    const populated = await fetchJson('/.netlify/functions/revenue-admin?view=dashboard&limit=50', { token });
    const summary = summarizeDashboard(populated.json);
    const reasons = new Set(summary.attentionReasons || []);
    report.steps.push({
      step: 'populated_dashboard',
      status: populated.status,
      ms: populated.ms,
      size: populated.size,
      cacheControl: populated.cacheControl,
      summary,
      pass: populated.status === 200
        && populated.json?.ok === true
        && summary.sessions > 0
        && summary.garagePlanRequests > 0
        && summary.priorityCount > 0
        && reasons.has('garage_plan_request')
        && reasons.has('payment_step_abandonment')
        && reasons.has('failed_customer_notification'),
    });

    const malformed = await fetchJson('/.netlify/functions/qa-revops-lifecycle', {
      method: 'POST',
      token,
      body: { action: 'seed_malformed', qaFixture: true },
    });
    const withMalformed = await fetchJson('/.netlify/functions/revenue-admin?view=dashboard', { token });
    const malformedWarnings = (withMalformed.json?.warnings || []).some((w) => String(w).includes('skipped_malformed'));
    report.steps.push({
      step: 'malformed_resilience',
      status: withMalformed.status,
      warnings: withMalformed.json?.warnings || [],
      pass: malformed.status === 200 && withMalformed.status === 200 && withMalformed.json?.ok === true && malformedWarnings,
    });

    const rangeBound = await fetchJson(
      '/.netlify/functions/revenue-admin?view=dashboard&from=2020-01-01&to=2026-12-31',
      { token },
    );
    const from = rangeBound.json?.range?.from;
    const to = rangeBound.json?.range?.to;
    const spanDays = from && to ? (new Date(to) - new Date(from)) / 86400000 : 0;
    report.steps.push({
      step: 'range_bound_90d',
      status: rangeBound.status,
      spanDays,
      pass: rangeBound.status === 200 && spanDays <= 90.1,
    });

    const cleanup = await fetchJson('/.netlify/functions/qa-revops-lifecycle', {
      method: 'POST',
      token,
      body: { action: 'cleanup', qaFixture: true },
    });
    report.steps.push({
      step: 'cleanup',
      status: cleanup.status,
      removed: cleanup.json?.removed,
      pass: cleanup.status === 200 && cleanup.json?.ok === true,
    });

    const postCleanup = await fetchJson('/.netlify/functions/revenue-admin?view=dashboard', { token });
    report.steps.push({
      step: 'post_cleanup_dashboard',
      status: postCleanup.status,
      summary: summarizeDashboard(postCleanup.json),
      pass: postCleanup.status === 200 && postCleanup.json?.ok === true,
    });

    report.pass = report.steps.every((s) => s.pass !== false);
    report.dashboardSample = redact(populated.json);
  } finally {
    token = '';
    password = null;
    delete process.env.CD1_ADMIN_TOKEN;
    delete process.env.ADMIN_DASH_PASSWORD;
  }

  const outDir = join(ROOT, 'reports');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `revops-auth-qa-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.pass, reportPath: outPath, steps: report.steps.map((s) => ({ step: s.step, pass: s.pass, status: s.status })) }));
  process.exit(report.pass ? 0 : 1);
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
