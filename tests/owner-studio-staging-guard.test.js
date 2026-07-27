'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const script = path.join(root, 'scripts', 'assert-owner-studio-staging-db.js');
const migrateScript = path.join(root, 'scripts', 'owner-studio-staging-migrate.js');
const envScript = path.join(root, 'scripts', 'owner-studio-staging-netlify-env.js');
const PRODUCTION_SITE_ID = 'd7e5f77c-1f0b-4209-a9df-3d6aae380dd0';
const STAGING_SITE_ID = '982e6338-4a4a-432e-855b-db532b994391';

function sha12(v) {
  return crypto.createHash('sha256').update(String(v || '')).digest('hex').slice(0, 12);
}

function makePostgresUrl({ user, host = 'db.example.test', db = 'staging_db', pass = 'secret-pass' }) {
  return `postgres://${user}:${pass}@${host}:5432/${db}?sslmode=require`;
}

function baseEnv(extra = {}) {
  return {
    ...process.env,
    OWNER_STUDIO_STAGING_IGNORE_ENV_FILE: '1',
    CLAIM_URL: '',
    STAGING_DB_DELETION_DATE: '',
    OWNER_STUDIO_STAGING_EMAIL_POLICY: 'disabled',
    RESEND_API_KEY: '',
    CUSTOMER_TRANSACTIONAL_SMS_ENABLED: 'false',
    PUBLIC_CONTENT_SOURCE: 'legacy',
    ...extra,
  };
}

function runAssert(env) {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    env: baseEnv(env),
    encoding: 'utf8',
  });
}

function parseJsonOut(res) {
  const text = `${res.stdout || ''}\n${res.stderr || ''}`.trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < 0) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

describe('owner-studio staging guard', () => {
  it('1. missing OWNER_STUDIO_STAGING_DATABASE_URL fails', () => {
    const res = runAssert({
      OWNER_STUDIO_STAGING_DATABASE_URL: '',
      OWNER_STUDIO_PRODUCTION_DB_USER_HASH: 'aaaaaaaaaaaa',
      NETLIFY_SITE_ID: STAGING_SITE_ID,
    });
    const body = parseJsonOut(res);
    assert.equal(res.status, 1);
    assert.equal(body.error, 'missing_owner_studio_staging_database_url');
  });

  it('1b. missing staging URL via migrate script fails closed (no fallback)', () => {
    const res = spawnSync(process.execPath, [migrateScript], {
      cwd: root,
      env: baseEnv({ OWNER_STUDIO_STAGING_DATABASE_URL: '' }),
      encoding: 'utf8',
    });
    const body = parseJsonOut(res);
    assert.equal(res.status, 1);
    assert.equal(body.error, 'missing_owner_studio_staging_database_url');
  });

  it('2. staging fingerprint equal to production fails', () => {
    const sharedUser = 'same-user-identity-0001';
    const url = makePostgresUrl({ user: sharedUser, host: 'db.prisma.io', db: 'postgres' });
    const res = runAssert({
      OWNER_STUDIO_STAGING_DATABASE_URL: url,
      DIRECT_URL: url,
      DATABASE_URL: url,
      OWNER_STUDIO_PRODUCTION_DB_USER_HASH: sha12(sharedUser),
      NETLIFY_SITE_ID: STAGING_SITE_ID,
    });
    const body = parseJsonOut(res);
    assert.equal(res.status, 1);
    assert.equal(body.error, 'staging_db_equals_production');
    assert.equal(body.differentFromProduction, false);
  });

  it('3. staging site ID equal to production fails', () => {
    const url = makePostgresUrl({ user: 'staging-user-xyz', host: 'db.staging.test', db: 'os_staging' });
    const res = runAssert({
      OWNER_STUDIO_STAGING_DATABASE_URL: url,
      DIRECT_URL: url,
      DATABASE_URL: url,
      OWNER_STUDIO_PRODUCTION_DB_USER_HASH: sha12('production-user'),
      NETLIFY_SITE_ID: PRODUCTION_SITE_ID,
    });
    const body = parseJsonOut(res);
    assert.equal(res.status, 1);
    assert.equal(body.error, 'staging_site_id_equals_production');
  });

  it('4. unreachable staging URL fails closed (live connection required)', () => {
    const url = makePostgresUrl({ user: 'staging-user-xyz', host: 'db.staging.test', db: 'os_staging' });
    const res = runAssert({
      OWNER_STUDIO_STAGING_DATABASE_URL: url,
      DIRECT_URL: url,
      DATABASE_URL: url,
      OWNER_STUDIO_PRODUCTION_DB_USER_HASH: sha12('production-user'),
      NETLIFY_SITE_ID: STAGING_SITE_ID,
      STRIPE_SECRET_KEY: 'sk_test_example_not_real',
    });
    const body = parseJsonOut(res);
    assert.equal(res.status, 1);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'staging_direct_connection_failed');
    assert.equal(body.differentFromProduction, false);
  });

  it('4b. placeholder URL fails before connect', () => {
    const url = 'postgres://USER:PASSWORD@db.example.com:5432/postgres?sslmode=require';
    const res = runAssert({
      OWNER_STUDIO_STAGING_DATABASE_URL: url,
      DIRECT_URL: url,
      DATABASE_URL: url,
      OWNER_STUDIO_PRODUCTION_DB_USER_HASH: sha12('production-user'),
      NETLIFY_SITE_ID: STAGING_SITE_ID,
    });
    const body = parseJsonOut(res);
    assert.equal(res.status, 1);
    assert.equal(body.error, 'placeholder_staging_database_url');
  });

  it('5. failed assert output does not expose credentials', () => {
    const pass = 'super-secret-password-xyz';
    const url = makePostgresUrl({ user: 'staging-user-xyz', host: 'db.staging.test', db: 'os_staging', pass });
    const res = runAssert({
      OWNER_STUDIO_STAGING_DATABASE_URL: url,
      DIRECT_URL: url,
      DATABASE_URL: url,
      OWNER_STUDIO_PRODUCTION_DB_USER_HASH: sha12('production-user'),
      NETLIFY_SITE_ID: STAGING_SITE_ID,
    });
    const joined = `${res.stdout || ''}${res.stderr || ''}`;
    assert.equal(res.status, 1);
    assert.equal(joined.includes(pass), false);
    assert.equal(joined.includes('staging-user-xyz'), false);
    assert.equal(joined.includes('postgres://'), false);
    assert.equal(joined.includes('db.staging.test'), false);
  });

  it('5b. invalid credentials against real Prisma host fail live connect', () => {
    const url = makePostgresUrl({
      user: 'definitely-invalid-staging-user-0001',
      host: 'db.prisma.io',
      db: 'postgres',
      pass: 'not-a-real-password',
    });
    const res = runAssert({
      OWNER_STUDIO_STAGING_DATABASE_URL: url,
      DIRECT_URL: url,
      DATABASE_URL: url,
      OWNER_STUDIO_PRODUCTION_DB_USER_HASH: sha12('production-user'),
      NETLIFY_SITE_ID: STAGING_SITE_ID,
    });
    const body = parseJsonOut(res);
    assert.equal(res.status, 1);
    assert.equal(body.error, 'staging_direct_connection_failed');
  });

  it('5c. runtime/direct credential mismatch fails before connect', () => {
    const staging = makePostgresUrl({ user: 'staging-user-aaa', host: 'db.prisma.io', db: 'postgres' });
    const other = makePostgresUrl({ user: 'staging-user-bbb', host: 'db.prisma.io', db: 'postgres' });
    const res = runAssert({
      OWNER_STUDIO_STAGING_DATABASE_URL: staging,
      DIRECT_URL: staging,
      DATABASE_URL: other,
      OWNER_STUDIO_PRODUCTION_DB_USER_HASH: sha12('production-user'),
      NETLIFY_SITE_ID: STAGING_SITE_ID,
    });
    const body = parseJsonOut(res);
    assert.equal(res.status, 1);
    assert.equal(body.error, 'runtime_staging_identity_mismatch');
  });

  it('6. migration command cannot execute before assertion', () => {
    const src = fs.readFileSync(migrateScript, 'utf8');
    assert.match(src, /assert-owner-studio-staging-db\.js/);
    assert.match(src, /OWNER_STUDIO_STAGING_DATABASE_URL/);
    assert.match(src, /refusing DATABASE_URL fallback|missing_owner_studio_staging_database_url/);
    const assertIdx = src.indexOf('assert-owner-studio-staging-db.js');
    const deployIdx = src.indexOf("migrate', 'deploy'");
    assert.ok(assertIdx >= 0 && deployIdx > assertIdx);
  });

  it('7. PUBLIC_CONTENT_SOURCE remains legacy', () => {
    const url = makePostgresUrl({ user: 'staging-user-xyz', host: 'db.staging.test', db: 'os_staging' });
    const res = runAssert({
      OWNER_STUDIO_STAGING_DATABASE_URL: url,
      DIRECT_URL: url,
      DATABASE_URL: url,
      OWNER_STUDIO_PRODUCTION_DB_USER_HASH: sha12('production-user'),
      NETLIFY_SITE_ID: STAGING_SITE_ID,
      PUBLIC_CONTENT_SOURCE: 'owner_studio',
    });
    const body = parseJsonOut(res);
    assert.equal(res.status, 1);
    assert.equal(body.error, 'public_content_source_not_legacy');
  });

  it('8. Stripe live key classification fails staging readiness', () => {
    const url = makePostgresUrl({ user: 'staging-user-xyz', host: 'db.staging.test', db: 'os_staging' });
    const res = runAssert({
      OWNER_STUDIO_STAGING_DATABASE_URL: url,
      DIRECT_URL: url,
      DATABASE_URL: url,
      OWNER_STUDIO_PRODUCTION_DB_USER_HASH: sha12('production-user'),
      NETLIFY_SITE_ID: STAGING_SITE_ID,
      STRIPE_SECRET_KEY: 'sk_live_should_fail',
    });
    const body = parseJsonOut(res);
    assert.equal(res.status, 1);
    assert.equal(body.error, 'stripe_live_forbidden');
  });

  it('9. Twilio enabled fails staging readiness', () => {
    const url = makePostgresUrl({ user: 'staging-user-xyz', host: 'db.staging.test', db: 'os_staging' });
    const res = runAssert({
      OWNER_STUDIO_STAGING_DATABASE_URL: url,
      DIRECT_URL: url,
      DATABASE_URL: url,
      OWNER_STUDIO_PRODUCTION_DB_USER_HASH: sha12('production-user'),
      NETLIFY_SITE_ID: STAGING_SITE_ID,
      CUSTOMER_TRANSACTIONAL_SMS_ENABLED: 'true',
    });
    const body = parseJsonOut(res);
    assert.equal(res.status, 1);
    assert.equal(body.error, 'twilio_enabled_forbidden');
  });

  it('10. production fallback is rejected', () => {
    const url = makePostgresUrl({ user: 'staging-user-xyz', host: 'db.staging.test', db: 'os_staging' });
    const res = runAssert({
      OWNER_STUDIO_STAGING_DATABASE_URL: url,
      DIRECT_URL: url,
      DATABASE_URL: url,
      OWNER_STUDIO_PRODUCTION_DB_USER_HASH: sha12('production-user'),
      NETLIFY_SITE_ID: STAGING_SITE_ID,
      OWNER_STUDIO_ALLOW_DATABASE_URL_FALLBACK: 'true',
    });
    const body = parseJsonOut(res);
    assert.equal(res.status, 1);
    assert.equal(body.error, 'fallback_flag_forbidden');
  });

  it('11. missing email policy fails', () => {
    const url = makePostgresUrl({ user: 'staging-user-xyz', host: 'db.staging.test', db: 'os_staging' });
    const res = runAssert({
      OWNER_STUDIO_STAGING_DATABASE_URL: url,
      DIRECT_URL: url,
      DATABASE_URL: url,
      OWNER_STUDIO_PRODUCTION_DB_USER_HASH: sha12('production-user'),
      NETLIFY_SITE_ID: STAGING_SITE_ID,
      OWNER_STUDIO_STAGING_EMAIL_POLICY: '',
    });
    const body = parseJsonOut(res);
    assert.equal(res.status, 1);
    assert.equal(body.error, 'missing_email_policy');
  });

  it('12. temporary create-db markers fail permanent gate', () => {
    const url = makePostgresUrl({ user: 'staging-user-xyz', host: 'db.staging.test', db: 'os_staging' });
    const res = runAssert({
      OWNER_STUDIO_STAGING_DATABASE_URL: url,
      DIRECT_URL: url,
      DATABASE_URL: url,
      OWNER_STUDIO_PRODUCTION_DB_USER_HASH: sha12('production-user'),
      NETLIFY_SITE_ID: STAGING_SITE_ID,
      CLAIM_URL: 'https://example.test/claim-not-printed',
    });
    const body = parseJsonOut(res);
    assert.equal(res.status, 1);
    assert.equal(body.error, 'staging_db_not_permanent');
  });

  function withUnlinkedNetlifyFolder(fn) {
    const statePath = path.join(root, '.netlify', 'state.json');
    const bakPath = path.join(root, '.netlify', `state.json.testbak-${process.pid}`);
    let moved = false;
    if (fs.existsSync(statePath)) {
      fs.renameSync(statePath, bakPath);
      moved = true;
    }
    try {
      return fn();
    } finally {
      if (moved && fs.existsSync(bakPath)) fs.renameSync(bakPath, statePath);
    }
  }

  it('13. staging env script rejects production site ID without mutation', () => {
    withUnlinkedNetlifyFolder(() => {
      const res = spawnSync(process.execPath, [envScript, '--site', PRODUCTION_SITE_ID, '--confirm-staging-env-write'], {
        cwd: root,
        env: baseEnv(),
        encoding: 'utf8',
      });
      const body = parseJsonOut(res);
      assert.equal(res.status, 1);
      assert.equal(body.error, 'production_site_id_rejected');
    });
  });

  it('14. staging env script requires explicit site ID', () => {
    withUnlinkedNetlifyFolder(() => {
      const res = spawnSync(process.execPath, [envScript, '--confirm-staging-env-write'], {
        cwd: root,
        env: baseEnv({ OWNER_STUDIO_STAGING_SITE_ID: '' }),
        encoding: 'utf8',
      });
      const body = parseJsonOut(res);
      assert.equal(res.status, 1);
      assert.equal(body.error, 'missing_staging_site_id');
    });
  });

  it('15. staging env script requires confirmation flag', () => {
    withUnlinkedNetlifyFolder(() => {
      const res = spawnSync(process.execPath, [envScript, '--site', STAGING_SITE_ID], {
        cwd: root,
        env: baseEnv(),
        encoding: 'utf8',
      });
      const body = parseJsonOut(res);
      assert.equal(res.status, 1);
      assert.equal(body.error, 'confirmation_required');
    });
  });

  it('17. assert script requires live connection (no URL-only success path)', () => {
    const src = fs.readFileSync(script, 'utf8');
    assert.match(src, /liveConnectionVerified|staging_direct_connection_failed/);
    assert.match(src, /connectIdentity|current_database/);
    assert.match(src, /--require-schema|OWNER_STUDIO_STAGING_REQUIRE_SCHEMA/);
    assert.match(src, /OsCatalogDraft/);
  });

  it('16. prisma runtime helper supports adapter path for postgres URLs', () => {
    const src = fs.readFileSync(path.join(root, 'netlify', 'lib', 'prisma.js'), 'utf8');
    assert.match(src, /@prisma\/adapter-pg/);
    assert.match(src, /accelerateUrl/);
    assert.doesNotMatch(src, /datasources:\s*\{\s*db:\s*\{\s*url/);
  });
});
