#!/usr/bin/env node
/**
 * Netlify branch-scoped QA env manager (no secret output).
 */
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const SITE_ID = 'd7e5f77c-1f0b-4209-a9df-3d6aae380dd0';
const ACCOUNT_ID = '6a2802ed5070702e9f45913b';
const QA_BRANCH = 'customer-my-garage-portal';
const BRANCH_CONTEXT = 'branch-deploy';
const FUNCTIONS_SCOPE = ['functions'];
const KEYS = [
  'MY_GARAGE_QA_ENABLED',
  'MY_GARAGE_QA_EMAIL_A',
  'MY_GARAGE_QA_EMAIL_B',
  'MY_GARAGE_QA_ADMIN_TOKEN',
];
const FORBIDDEN_CONTEXTS = new Set(['production', 'deploy-preview', 'dev', 'dev-server', 'all']);

function token() {
  return String(process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_API_TOKEN || '').trim();
}

function loadDotEnvToken() {
  const candidates = [
    path.join(process.cwd(), '.env'),
    path.join(process.env.APPDATA || '', 'netlify', 'Config', 'config.json'),
    path.join(process.env.USERPROFILE || '', '.config', 'netlify', 'config.json'),
    path.join(process.env.USERPROFILE || '', '.netlify', 'config.json'),
  ];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    const raw = fs.readFileSync(f, 'utf8');
    if (f.endsWith('config.json')) {
      try {
        const j = JSON.parse(raw);
        const t = j?.users?.[Object.keys(j.users || {})[0]]?.auth?.token;
        if (t) process.env.NETLIFY_AUTH_TOKEN = t;
      } catch { /* noop */ }
    } else {
      for (const line of raw.split('\n')) {
        const m = line.match(/^NETLIFY_AUTH_TOKEN=(.+)$/);
        if (m) process.env.NETLIFY_AUTH_TOKEN = m[1].trim().replace(/^['"]|['"]$/g, '');
      }
    }
  }
}

async function api(pathname, { method = 'GET', body } = {}) {
  loadDotEnvToken();
  const t = token();
  if (!t) throw new Error('netlify_auth_missing');
  const res = await fetch(`https://api.netlify.com/api/v1${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${t}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(`netlify_api_${res.status}`);
  return data;
}

async function listSiteEnv() {
  return api(`/accounts/${ACCOUNT_ID}/env?site_id=${SITE_ID}`);
}

async function getEnvKey(key) {
  return api(`/accounts/${ACCOUNT_ID}/env/${encodeURIComponent(key)}?site_id=${SITE_ID}`);
}

function isBranchScopedValue(v) {
  if (!v || !String(v.value || '').length) return false;
  if (v.context !== BRANCH_CONTEXT) return false;
  const branch = String(v.branch_context || '').trim();
  return !branch || branch === QA_BRANCH;
}

function metaOnly(envList) {
  return (envList || []).filter((e) => KEYS.includes(e.key)).map((e) => ({
    key: e.key,
    scopes: e.scopes || [],
    isSecret: !!e.is_secret,
    contexts: (e.values || []).map((v) => ({
      id: v.id,
      context: v.context,
      branch: v.branch_context || null,
      hasValue: String(v.value || '').length > 0,
    })),
  }));
}

function hasBranchValue(row) {
  return (row?.values || []).some((v) => isBranchScopedValue(v));
}

function hasProductionLeak(row) {
  return (row?.values || []).some((v) =>
    FORBIDDEN_CONTEXTS.has(v.context) && String(v.value || '').length > 0
  );
}

export async function verifyQaEnv() {
  const env = await listSiteEnv();
  const meta = metaOnly(env);
  const byKey = Object.fromEntries(meta.map((m) => [m.key, m]));
  const configured = KEYS.every((k) => byKey[k]);
  const branchOk = KEYS.every((k) => hasBranchValue(env.find((e) => e.key === k)));
  const scopeOk = KEYS.every((k) => {
    const scopes = byKey[k]?.scopes || [];
    return scopes.length === 1 && scopes[0] === 'functions';
  });
  const noProd = KEYS.every((k) => !hasProductionLeak(env.find((e) => e.key === k)));
  return { configured, correctContext: branchOk, correctScope: scopeOk, noProduction: noProd, meta };
}

async function deleteValue(key, valueId) {
  await api(
    `/accounts/${ACCOUNT_ID}/env/${encodeURIComponent(key)}/value/${valueId}?site_id=${SITE_ID}`,
    { method: 'DELETE' },
  );
}

async function purgeForbiddenContexts(key) {
  const row = await getEnvKey(key);
  for (const v of row.values || []) {
    if (!FORBIDDEN_CONTEXTS.has(v.context)) continue;
    if (!v.id) continue;
    try { await deleteValue(key, v.id); } catch { /* already removed */ }
  }
  for (const v of row.values || []) {
    if (v.context !== BRANCH_CONTEXT || !v.id) continue;
    const branch = String(v.branch_context || '').trim();
    if (branch && branch !== QA_BRANCH) continue;
    if (!branch) {
      try { await deleteValue(key, v.id); } catch { /* noop */ }
    }
  }
}

async function patchBranchValue(key, value) {
  await api(`/accounts/${ACCOUNT_ID}/env/${encodeURIComponent(key)}?site_id=${SITE_ID}`, {
    method: 'PATCH',
    body: {
      context: BRANCH_CONTEXT,
      branch_context: QA_BRANCH,
      value,
    },
  });
}

async function ensureScopesAndSecret(key, { secret = false } = {}) {
  const row = await getEnvKey(key);
  const branchValue = (row.values || []).find((v) =>
    v.context === BRANCH_CONTEXT && String(v.branch_context || '') === QA_BRANCH
  );
  if (!branchValue) return;
  await api(`/accounts/${ACCOUNT_ID}/env/${encodeURIComponent(key)}?site_id=${SITE_ID}`, {
    method: 'PUT',
    body: {
      key,
      is_secret: secret,
      scopes: FUNCTIONS_SCOPE,
      values: [{
        id: branchValue.id,
        context: BRANCH_CONTEXT,
        branch_context: QA_BRANCH,
        value: branchValue.value,
      }],
    },
  });
}

export async function setQaEnv({ emailA, emailB, adminToken }) {
  for (const key of KEYS) await purgeForbiddenContexts(key);
  const specs = [
    { key: 'MY_GARAGE_QA_ENABLED', value: 'true', secret: false },
    { key: 'MY_GARAGE_QA_EMAIL_A', value: emailA, secret: true },
    { key: 'MY_GARAGE_QA_EMAIL_B', value: emailB, secret: true },
    { key: 'MY_GARAGE_QA_ADMIN_TOKEN', value: adminToken, secret: true },
  ];
  for (const spec of specs) {
    await patchBranchValue(spec.key, spec.value);
    await ensureScopesAndSecret(spec.key, { secret: spec.secret });
  }
  return verifyQaEnv();
}

export async function unsetQaEnv() {
  for (const key of KEYS) {
    const row = await getEnvKey(key).catch(() => null);
    if (!row) continue;
    for (const v of row.values || []) {
      if (v.context !== BRANCH_CONTEXT || !v.id) continue;
      if (String(v.branch_context || '') !== QA_BRANCH) continue;
      try { await deleteValue(key, v.id); } catch { /* noop */ }
    }
  }
  return { removed: KEYS.length };
}

export function generateQaAdminToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export async function readExistingEmailsSilently() {
  const out = {};
  for (const key of ['MY_GARAGE_QA_EMAIL_A', 'MY_GARAGE_QA_EMAIL_B']) {
    const row = await getEnvKey(key).catch(() => null);
    if (!row) continue;
    const hit = (row.values || []).find((v) => isBranchScopedValue(v));
    if (hit) out[key] = String(hit.value).trim().toLowerCase();
  }
  return out;
}

export async function readAdminEmailSilently() {
  const row = await getEnvKey('ADMIN_EMAIL').catch(() => null);
  if (!row) return '';
  const hit = (row.values || []).find((v) => v.value);
  return hit ? String(hit.value).trim().toLowerCase() : '';
}

async function main() {
  const cmd = process.argv[2] || 'verify';
  if (cmd === 'verify') {
    const v = await verifyQaEnv();
    console.log(JSON.stringify({
      configured: v.configured,
      correctContext: v.correctContext,
      correctScope: v.correctScope,
      noProduction: v.noProduction,
    }));
    process.exit(v.configured && v.correctContext && v.noProduction ? 0 : 1);
  }
  if (cmd === 'unset') {
    await unsetQaEnv();
    console.log(JSON.stringify({ ok: true }));
    return;
  }
  throw new Error('usage: verify|unset');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
