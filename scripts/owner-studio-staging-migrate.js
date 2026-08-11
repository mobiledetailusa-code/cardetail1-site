#!/usr/bin/env node
'use strict';

/**
 * Apply Owner Studio migrations to the isolated staging database only.
 * Sequence: assert → prisma validate → migrate status → migrate deploy.
 * Never falls back to production DATABASE_URL.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const PRODUCTION_SITE_ID = 'd7e5f77c-1f0b-4209-a9df-3d6aae380dd0';

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

function run(cmd, args, env) {
  const res = spawnSync(cmd, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  return res.status === 0;
}

function main() {
  const ignoreFile = /^(1|true|yes)$/i.test(String(process.env.OWNER_STUDIO_STAGING_IGNORE_ENV_FILE || ''));
  const fileEnv = ignoreFile ? {} : readEnvFile(path.join(root, '.env.owner-studio-staging'));
  const stagingUrl =
    process.env.OWNER_STUDIO_STAGING_DATABASE_URL || fileEnv.OWNER_STUDIO_STAGING_DATABASE_URL || '';
  if (!stagingUrl) {
    console.error(JSON.stringify({
      ok: false,
      error: 'missing_owner_studio_staging_database_url',
      message: 'OWNER_STUDIO_STAGING_DATABASE_URL required; refusing DATABASE_URL fallback',
    }, null, 2));
    process.exit(1);
  }

  const siteId = process.env.NETLIFY_SITE_ID || fileEnv.NETLIFY_SITE_ID || '';
  if (!siteId || siteId === PRODUCTION_SITE_ID) {
    console.error(JSON.stringify({
      ok: false,
      error: 'invalid_staging_site_id',
      message: 'Staging NETLIFY_SITE_ID missing or equals production',
    }, null, 2));
    process.exit(1);
  }

  // Build a clean env: do NOT inherit production DATABASE_URL/DIRECT_URL from process/.env.
  const base = { ...process.env };
  delete base.DATABASE_URL;
  delete base.DIRECT_URL;
  delete base.PRISMA_DATABASE_URL;

  const env = {
    ...base,
    ...fileEnv,
    OWNER_STUDIO_STAGING_DATABASE_URL: stagingUrl,
    DATABASE_URL: stagingUrl,
    DIRECT_URL: fileEnv.DIRECT_URL || stagingUrl,
    NETLIFY_SITE_ID: siteId,
    APP_ENV: 'staging',
    PUBLIC_CONTENT_SOURCE: 'legacy',
  };

  const assert = spawnSync(process.execPath, [path.join(root, 'scripts', 'assert-owner-studio-staging-db.js')], {
    cwd: root,
    env,
    encoding: 'utf8',
    shell: false,
  });
  if (assert.stdout) process.stdout.write(assert.stdout);
  if (assert.stderr) process.stderr.write(assert.stderr);
  if (assert.status !== 0) {
    console.error(JSON.stringify({ ok: false, error: 'staging_assert_failed', migrated: false }, null, 2));
    process.exit(assert.status || 1);
  }

  if (!run('npx', ['prisma', 'validate'], env)) {
    console.error(JSON.stringify({ ok: false, error: 'prisma_validate_failed' }, null, 2));
    process.exit(1);
  }
  // status may exit non-zero when pending migrations exist; continue to deploy after assert.
  run('npx', ['prisma', 'migrate', 'status'], env);
  if (!run('npx', ['prisma', 'migrate', 'deploy'], env)) {
    console.error(JSON.stringify({ ok: false, error: 'migrate_deploy_failed', migrated: false }, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify({
    ok: true,
    migrated: true,
    environment: 'staging',
    target: 'owner-studio-staging-only',
  }, null, 2));
}

main();
