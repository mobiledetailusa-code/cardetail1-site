#!/usr/bin/env node
'use strict';

/**
 * Staging-only Owner/Admin credential bootstrap.
 *
 * - Writes credentials only to gitignored `.staging-db-repair/`
 * - Updates Netlify staging site env only
 * - Never prints the password
 * - Never touches production
 *
 * Usage:
 *   node scripts/owner-studio-staging-admin-bootstrap.js --confirm-staging-admin-bootstrap
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const STAGING_SITE_ID = '982e6338-4a4a-432e-855b-db532b994391';
const PRODUCTION_SITE_ID = 'd7e5f77c-1f0b-4209-a9df-3d6aae380dd0';
const ACCOUNT = '6a2802ed5070702e9f45913b';
const root = path.join(__dirname, '..');
const repairDir = path.join(root, '.staging-db-repair');

function sha12(v) {
  return crypto.createHash('sha256').update(String(v || '')).digest('hex').slice(0, 12);
}

function fail(code, message, extra = {}) {
  console.error(JSON.stringify({ ok: false, error: code, message, ...extra }, null, 2));
  process.exit(1);
}

function readToken() {
  const cfgPath = path.join(os.homedir(), 'AppData', 'Roaming', 'netlify', 'Config', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const token = Object.values(cfg.users || {})[0]?.auth?.token;
  if (!token) throw new Error('netlify_token_missing');
  return token;
}

async function putVar(token, key, value) {
  const res = await fetch(
    `https://api.netlify.com/api/v1/accounts/${ACCOUNT}/env/${encodeURIComponent(key)}?site_id=${STAGING_SITE_ID}`,
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
    `https://api.netlify.com/api/v1/accounts/${ACCOUNT}/env?site_id=${STAGING_SITE_ID}`,
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

function upsertLocalEnv(username, password) {
  const envPath = path.join(root, '.env.owner-studio-staging');
  const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split(/\r?\n/) : [];
  const map = {};
  for (const line of lines) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    map[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  map.ADMIN_USERNAME = username;
  map.ADMIN_DASH_PASSWORD = password;
  const keys = Object.keys(map).sort();
  const body = [
    '# Owner Studio staging — authoritative isolated DB',
    `# Admin bootstrap: ${new Date().toISOString()}`,
    '',
    ...keys.map((k) => `${k}=${map[k]}`),
    '',
  ].join('\n');
  fs.writeFileSync(envPath, body, 'utf8');
}

async function main() {
  if (!process.argv.includes('--confirm-staging-admin-bootstrap')) {
    fail('confirmation_required', 'Pass --confirm-staging-admin-bootstrap');
  }
  if (STAGING_SITE_ID === PRODUCTION_SITE_ID) {
    fail('production_site_rejected', 'Refusing production site');
  }

  fs.mkdirSync(repairDir, { recursive: true });
  const username = 'staging-owner';
  const password = crypto.randomBytes(24).toString('base64url');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const credPath = path.join(repairDir, `staging-admin-${stamp}.json`);
  const latestPath = path.join(repairDir, 'staging-admin-latest.json');

  const payload = {
    siteId: STAGING_SITE_ID,
    username,
    password,
    createdAt: new Date().toISOString(),
    note: 'Staging-only Owner/Admin. Do not reuse in production. Rotate after audit if desired.',
  };
  fs.writeFileSync(credPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.writeFileSync(latestPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  upsertLocalEnv(username, password);

  const token = readToken();
  const site = await fetch(`https://api.netlify.com/api/v1/sites/${STAGING_SITE_ID}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  }).then((r) => r.json());
  if (!site || site.name !== 'cardetail1-staging') {
    fail('unexpected_site', 'Target site is not cardetail1-staging', {
      siteIdHash: sha12(STAGING_SITE_ID),
      name: site && site.name,
    });
  }

  const u = await putVar(token, 'ADMIN_USERNAME', username);
  const p = await putVar(token, 'ADMIN_DASH_PASSWORD', password);
  if (!u.ok || !p.ok) {
    fail('netlify_env_write_failed', 'Could not write staging admin credentials', {
      usernameStatus: u.status,
      passwordStatus: p.status,
    });
  }

  console.log(JSON.stringify({
    ok: true,
    siteIdHash: sha12(STAGING_SITE_ID),
    siteName: site.name,
    username,
    passwordWrittenTo: path.relative(root, latestPath).replace(/\\/g, '/'),
    passwordPrinted: false,
    netlifyUpdated: true,
    productionTouched: false,
  }, null, 2));
}

main().catch((e) => fail('bootstrap_failed', String(e.message || e).slice(0, 200)));
