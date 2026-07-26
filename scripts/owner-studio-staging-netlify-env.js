#!/usr/bin/env node
'use strict';

/**
 * Configure staging-only Netlify env vars via REST API (explicit site_id).
 *
 * Safety:
 * - never uses linked CLI folder
 * - requires --site <staging-site-id>
 * - rejects production site ID
 * - requires --confirm-staging-env-write
 * - never prints secret values
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ACCOUNT = '6a2802ed5070702e9f45913b';
const DEFAULT_STAGING_SITE_ID = '982e6338-4a4a-432e-855b-db532b994391';
const PRODUCTION_SITE_ID = 'd7e5f77c-1f0b-4209-a9df-3d6aae380dd0';

const REQUIRED_KEYS = [
  'OWNER_STUDIO_ENABLED',
  'PUBLIC_CONTENT_SOURCE',
  'APP_ENV',
  'NODE_ENV',
  'OWNER_STUDIO_STAGING_DATABASE_URL',
  'DATABASE_URL',
  'DIRECT_URL',
  'PUBLIC_SITE_URL',
  'TRUSTED_PUBLIC_SITE_ORIGIN',
  'CUSTOMER_SESSION_SECRET',
  'DRAFT_TOKEN_SECRET',
  'BID_SECRET',
  'CUSTOMER_TRANSACTIONAL_SMS_ENABLED',
  'NETLIFY_SITE_ID',
  'OWNER_STUDIO_STAGING_EMAIL_POLICY',
];

function sha12(v) {
  return crypto.createHash('sha256').update(String(v || '')).digest('hex').slice(0, 12);
}

function parseArgs(argv) {
  const out = { siteId: '', confirm: false, envFile: path.join(__dirname, '..', '.env.owner-studio-staging') };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--confirm-staging-env-write') out.confirm = true;
    else if (a === '--site' || a === '--site-id') out.siteId = String(argv[++i] || '').trim();
    else if (a === '--env-file') out.envFile = String(argv[++i] || '').trim();
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function readToken() {
  const cfgPath = path.join(os.homedir(), 'AppData', 'Roaming', 'netlify', 'Config', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const token = Object.values(cfg.users || {})[0]?.auth?.token;
  if (!token) throw new Error('netlify_token_missing');
  return token;
}

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    out[line.slice(0, i)] = line.slice(i + 1).replace(/^["']|["']$/g, '');
  }
  return out;
}

function classifyStripe(v) {
  if (!v) return 'absent';
  if (/^sk_test_|^pk_test_/.test(v)) return 'test';
  if (/^sk_live_|^pk_live_/.test(v)) return 'live';
  if (/^whsec_/.test(v)) return 'webhook_present';
  return 'present';
}

async function putVar(token, siteId, key, value) {
  const res = await fetch(
    `https://api.netlify.com/api/v1/accounts/${ACCOUNT}/env/${encodeURIComponent(key)}?site_id=${siteId}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        key,
        scopes: ['builds', 'functions', 'runtime', 'post-processing'],
        values: [{ context: 'all', value }],
      }),
    }
  );
  if (res.ok) return { ok: true, status: res.status, method: 'PUT' };
  const create = await fetch(
    `https://api.netlify.com/api/v1/accounts/${ACCOUNT}/env?site_id=${siteId}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        {
          key,
          scopes: ['builds', 'functions', 'runtime', 'post-processing'],
          values: [{ context: 'all', value }],
        },
      ]),
    }
  );
  return { ok: create.ok, status: create.status, method: 'POST' };
}

async function getSite(token, siteId) {
  const res = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) return null;
  return res.json();
}

async function getEnv(token, siteId) {
  const res = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/env`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) return [];
  return res.json();
}

function fail(code, message, extra = {}) {
  console.error(JSON.stringify({ ok: false, error: code, message, ...extra }, null, 2));
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(JSON.stringify({
      usage: 'node scripts/owner-studio-staging-netlify-env.js --site <staging-site-id> --confirm-staging-env-write',
      rejects: [PRODUCTION_SITE_ID],
    }, null, 2));
    return;
  }

  // Refuse any linked-folder inference.
  const statePath = path.join(__dirname, '..', '.netlify', 'state.json');
  if (fs.existsSync(statePath)) {
    try {
      const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (st.siteId) {
        fail('linked_netlify_folder_forbidden', 'Repository is linked to a Netlify site; unlink before staging env writes', {
          linkedSiteIdFingerprint: sha12(st.siteId),
        });
      }
    } catch {
      /* ignore parse errors */
    }
  }

  const siteId = args.siteId || process.env.OWNER_STUDIO_STAGING_SITE_ID || '';
  if (!siteId) {
    fail('missing_staging_site_id', 'Pass --site <staging-site-id> (required; no linked-folder inference)');
  }
  if (siteId === PRODUCTION_SITE_ID) {
    fail('production_site_id_rejected', 'Refusing to write staging env to production site ID', {
      productionSiteId: PRODUCTION_SITE_ID,
    });
  }
  if (siteId !== DEFAULT_STAGING_SITE_ID) {
    fail('unexpected_staging_site_id', 'Site ID is not the approved Owner Studio staging site', {
      expectedSiteIdFingerprint: sha12(DEFAULT_STAGING_SITE_ID),
      providedSiteIdFingerprint: sha12(siteId),
    });
  }
  if (!args.confirm) {
    fail('confirmation_required', 'Pass --confirm-staging-env-write to mutate staging environment variables');
  }

  const token = readToken();
  const site = await getSite(token, siteId);
  if (!site) fail('site_lookup_failed', 'Could not load staging site metadata');
  console.log(JSON.stringify({
    phase: 'preflight',
    targetSiteName: site.name || null,
    targetSiteIdFingerprint: sha12(siteId),
    targetUrlHost: (() => {
      try { return new URL(site.ssl_url || site.url || '').host; } catch { return null; }
    })(),
    productionSiteIdRejected: true,
  }, null, 2));

  const fileEnv = readEnvFile(args.envFile);
  const report = { siteIdFingerprint: sha12(siteId), set: [], skipped: [], classification: {}, ok: true };

  const forced = {
    OWNER_STUDIO_ENABLED: 'true',
    PUBLIC_CONTENT_SOURCE: 'legacy',
    APP_ENV: 'staging',
    NODE_ENV: 'production',
    CUSTOMER_TRANSACTIONAL_SMS_ENABLED: 'false',
    NETLIFY_SITE_ID: siteId,
    PUBLIC_SITE_URL: 'https://cardetail1-staging.netlify.app',
    TRUSTED_PUBLIC_SITE_ORIGIN: 'https://cardetail1-staging.netlify.app',
    // Policy B default: email disabled / no production Resend fallback.
    OWNER_STUDIO_STAGING_EMAIL_POLICY: fileEnv.OWNER_STUDIO_STAGING_EMAIL_POLICY || 'disabled',
  };

  const toSet = { ...fileEnv, ...forced };
  // Never copy Twilio or claim URLs into Netlify.
  delete toSet.TWILIO_SID;
  delete toSet.TWILIO_TOKEN;
  delete toSet.TWILIO_FROM;
  delete toSet.CLAIM_URL;
  // Staging runtime MUST use the same database identity as migrate/seed.
  // Prefer DIRECT_URL / OWNER_STUDIO_STAGING_DATABASE_URL over a mismatched
  // Accelerate pooled URL that can point at a different empty project.
  const stagingDb = toSet.DIRECT_URL || toSet.OWNER_STUDIO_STAGING_DATABASE_URL || '';
  if (!stagingDb) {
    fail('missing_staging_database_url', 'DIRECT_URL or OWNER_STUDIO_STAGING_DATABASE_URL required');
  }
  toSet.OWNER_STUDIO_STAGING_DATABASE_URL = toSet.OWNER_STUDIO_STAGING_DATABASE_URL || stagingDb;
  toSet.DIRECT_URL = toSet.DIRECT_URL || stagingDb;
  toSet.DATABASE_URL = stagingDb;

  for (const key of REQUIRED_KEYS) {
    if (!toSet[key]) {
      report.skipped.push({ key, reason: 'absent' });
      report.ok = false;
      continue;
    }
    const res = await putVar(token, siteId, key, toSet[key]);
    if (!res.ok) {
      report.skipped.push({ key, reason: 'netlify_set_failed', status: res.status });
      report.ok = false;
      continue;
    }
    report.set.push(key);
  }

  for (const key of ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY', 'ADMIN_SESSION_SECRET']) {
    const v = toSet[key];
    if (!v) {
      report.classification[key] = 'absent';
      continue;
    }
    if (key.startsWith('STRIPE_') && classifyStripe(v) === 'live') {
      report.classification[key] = 'live_forbidden';
      report.ok = false;
      continue;
    }
    // Email policy B: do not set production Resend on staging.
    if (key === 'RESEND_API_KEY' && String(toSet.OWNER_STUDIO_STAGING_EMAIL_POLICY || '').toLowerCase() === 'disabled') {
      report.classification[key] = 'skipped_email_disabled';
      continue;
    }
    const res = await putVar(token, siteId, key, v);
    if (res.ok) {
      report.set.push(key);
      report.classification[key] = key.startsWith('STRIPE_') ? classifyStripe(v) : 'present';
    } else {
      report.skipped.push({ key, reason: 'netlify_set_failed', status: res.status });
      report.ok = false;
    }
  }

  // Verify by presence/classification only.
  const after = await getEnv(token, siteId);
  const map = Object.fromEntries((after || []).map((r) => [r.key, (r.values || [])[0]?.value || '']));
  report.verify = {
    OWNER_STUDIO_ENABLED: map.OWNER_STUDIO_ENABLED || 'absent',
    APP_ENV: map.APP_ENV || 'absent',
    PUBLIC_CONTENT_SOURCE: map.PUBLIC_CONTENT_SOURCE || 'absent',
    NETLIFY_SITE_ID_match: map.NETLIFY_SITE_ID === siteId,
    PUBLIC_SITE_URL_staging: /cardetail1-staging\.netlify\.app/.test(map.PUBLIC_SITE_URL || ''),
    OWNER_STUDIO_STAGING_DATABASE_URL: map.OWNER_STUDIO_STAGING_DATABASE_URL ? 'present' : 'absent',
    DATABASE_URL: map.DATABASE_URL ? 'present' : 'absent',
    DIRECT_URL: map.DIRECT_URL ? 'present' : 'absent',
    stripeSecret: classifyStripe(map.STRIPE_SECRET_KEY || ''),
    stripePublishable: classifyStripe(map.STRIPE_PUBLISHABLE_KEY || ''),
    resend: map.RESEND_API_KEY ? 'present' : 'absent',
    emailPolicy: map.OWNER_STUDIO_STAGING_EMAIL_POLICY || 'absent',
    twilio: (map.TWILIO_SID || map.TWILIO_TOKEN || map.TWILIO_FROM) ? 'present' : 'absent',
    smsEnabled: map.CUSTOMER_TRANSACTIONAL_SMS_ENABLED || 'absent',
  };

  if (report.verify.stripeSecret === 'live' || report.verify.stripePublishable === 'live') report.ok = false;
  if (report.verify.twilio === 'present') report.ok = false;
  if (report.verify.emailPolicy !== 'disabled' && report.verify.emailPolicy !== 'controlled') report.ok = false;

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
