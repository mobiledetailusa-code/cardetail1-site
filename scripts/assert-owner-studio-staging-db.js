#!/usr/bin/env node
'use strict';

/**
 * Owner Studio staging isolation gate — live connection required.
 *
 * Fail-closed:
 * - missing / malformed / placeholder URLs
 * - staging site ID equals production
 * - staging credential identity equals production
 * - runtime/direct/staging URL identity mismatch
 * - live connection failure
 * - optional: missing Owner Studio schema tables
 *
 * Never prints credentials, full hosts, or connection strings.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PRODUCTION_SITE_ID = 'd7e5f77c-1f0b-4209-a9df-3d6aae380dd0';
const root = path.join(__dirname, '..');

const REQUIRED_OS_TABLES = [
  'OsSite',
  'OsCatalogDraft',
  'OsCatalogRevision',
  'OsPackage',
  'OsAddOn',
  'OsAuditLog',
  '_prisma_migrations',
];

function sha12(v) {
  return crypto.createHash('sha256').update(String(v || '')).digest('hex').slice(0, 12);
}

function parseDbUrl(raw) {
  if (!raw || !String(raw).trim()) return null;
  const cleaned = String(raw).trim().replace(/^["']|["']$/g, '');
  if (/YOUR_|CHANGE_ME|example\.com|<.*>|\$\{/.test(cleaned)) {
    return { placeholder: true };
  }
  try {
    const isAccelerate = /^(prisma\+|prisma:)/.test(cleaned) || /accelerate\.prisma-data\.net/.test(cleaned);
    const url = new URL(cleaned.replace(/^prisma\+/, ''));
    return {
      hostHash: sha12(url.hostname || ''),
      userHash: sha12(url.username || ''),
      dbHash: sha12((url.pathname || '/').replace(/^\//, '') || 'postgres'),
      port: url.port || '(default)',
      isAccelerate,
      isPostgres: /^postgres(ql)?:$/i.test(`${url.protocol}`) || cleaned.startsWith('postgres'),
      rawScheme: cleaned.split('://')[0],
    };
  } catch {
    return null;
  }
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

function fail(code, message, extra = {}) {
  const payload = {
    ok: false,
    configured: false,
    environment: 'staging',
    differentFromProduction: false,
    error: code,
    message,
    ...extra,
  };
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

async function connectIdentity(url) {
  const { Client } = require('pg');
  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 12000,
  });
  try {
    await client.connect();
    const meta = await client.query(
      'SELECT current_database() AS db, current_user AS usr, inet_server_port() AS port'
    );
    const tables = await client.query(
      `SELECT tablename
       FROM pg_tables
       WHERE schemaname = 'public'
         AND (tablename LIKE 'Os%' OR tablename = '_prisma_migrations')
       ORDER BY 1`
    );
    return {
      ok: true,
      dbHash: sha12(meta.rows[0].db),
      userHash: sha12(meta.rows[0].usr),
      port: meta.rows[0].port,
      tables: tables.rows.map((r) => r.tablename),
    };
  } catch (err) {
    // Never echo hosts, users, or connection strings from driver errors.
    const raw = String(err && err.message ? err.message : err);
    let safe = 'connection_failed';
    if (/credentials are incorrect|password authentication failed|auth/i.test(raw)) {
      safe = 'authentication_failed';
    } else if (/timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|getaddrinfo/i.test(raw)) {
      safe = 'network_unreachable';
    } else if (/SSL|certificate/i.test(raw)) {
      safe = 'tls_failed';
    }
    return { ok: false, error: safe };
  } finally {
    try { await client.end(); } catch (_) {}
  }
}

function wantsSchema() {
  return process.argv.includes('--require-schema')
    || /^(1|true|yes)$/i.test(String(process.env.OWNER_STUDIO_STAGING_REQUIRE_SCHEMA || ''));
}

async function main() {
  const ignoreFile = /^(1|true|yes)$/i.test(String(process.env.OWNER_STUDIO_STAGING_IGNORE_ENV_FILE || ''));
  const fileEnv = ignoreFile ? {} : readEnvFile(path.join(root, '.env.owner-studio-staging'));

  const stagingUrl =
    process.env.OWNER_STUDIO_STAGING_DATABASE_URL ||
    fileEnv.OWNER_STUDIO_STAGING_DATABASE_URL ||
    '';

  if (!stagingUrl) {
    fail('missing_owner_studio_staging_database_url', 'OWNER_STUDIO_STAGING_DATABASE_URL is required');
  }

  if (
    process.env.OWNER_STUDIO_ALLOW_DATABASE_URL_FALLBACK === '1' ||
    process.env.OWNER_STUDIO_ALLOW_DATABASE_URL_FALLBACK === 'true'
  ) {
    fail('fallback_flag_forbidden', 'DATABASE_URL fallback is forbidden for Owner Studio staging');
  }

  const stagingFp = parseDbUrl(stagingUrl);
  if (!stagingFp) {
    fail('invalid_staging_database_url', 'OWNER_STUDIO_STAGING_DATABASE_URL could not be parsed');
  }
  if (stagingFp.placeholder) {
    fail('placeholder_staging_database_url', 'OWNER_STUDIO_STAGING_DATABASE_URL looks like an unresolved placeholder');
  }

  const stagingSiteId =
    process.env.NETLIFY_SITE_ID ||
    process.env.OWNER_STUDIO_STAGING_SITE_ID ||
    fileEnv.NETLIFY_SITE_ID ||
    '';

  if (!stagingSiteId) {
    fail('missing_staging_site_id', 'NETLIFY_SITE_ID / OWNER_STUDIO_STAGING_SITE_ID is required for staging gate');
  }
  if (stagingSiteId === PRODUCTION_SITE_ID) {
    fail('staging_site_id_equals_production', 'Staging Netlify site ID must differ from production', {
      productionSiteId: PRODUCTION_SITE_ID,
      stagingSiteIdHash: sha12(stagingSiteId),
    });
  }

  let productionUserHash = process.env.OWNER_STUDIO_PRODUCTION_DB_USER_HASH || fileEnv.OWNER_STUDIO_PRODUCTION_DB_USER_HASH || '';
  if (!productionUserHash) {
    const prodEnv = readEnvFile(path.join(root, '.env'));
    const prodUrl = prodEnv.DIRECT_URL || prodEnv.DATABASE_URL || process.env.DIRECT_URL || process.env.DATABASE_URL;
    const prodFp = parseDbUrl(prodUrl);
    if (prodFp && !prodFp.placeholder) productionUserHash = prodFp.userHash;
  }
  if (!productionUserHash) {
    fail('missing_production_fingerprint', 'Set OWNER_STUDIO_PRODUCTION_DB_USER_HASH for comparison');
  }

  if (stagingFp.userHash === productionUserHash) {
    fail('staging_db_equals_production', 'Staging database credential identity matches production', {
      hostFingerprint: stagingFp.hostHash,
      databaseFingerprint: stagingFp.dbHash,
      userFingerprint: stagingFp.userHash,
    });
  }

  const stripeSecret = process.env.STRIPE_SECRET_KEY || fileEnv.STRIPE_SECRET_KEY || '';
  if (stripeSecret && /^sk_live_/.test(stripeSecret)) {
    fail('stripe_live_forbidden', 'Stripe live secret key is forbidden in staging');
  }
  const twilioEnabled = String(
    process.env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED || fileEnv.CUSTOMER_TRANSACTIONAL_SMS_ENABLED || ''
  ).toLowerCase();
  if (twilioEnabled === 'true' || twilioEnabled === '1' || twilioEnabled === 'yes' || twilioEnabled === 'on') {
    fail('twilio_enabled_forbidden', 'CUSTOMER_TRANSACTIONAL_SMS_ENABLED must remain false in staging');
  }

  const publicSource = String(
    process.env.PUBLIC_CONTENT_SOURCE || fileEnv.PUBLIC_CONTENT_SOURCE || 'legacy'
  ).toLowerCase();
  if (publicSource && publicSource !== 'legacy') {
    fail('public_content_source_not_legacy', 'PUBLIC_CONTENT_SOURCE must remain legacy during staging Stage 1/2 prep');
  }

  const emailPolicy = String(
    process.env.OWNER_STUDIO_STAGING_EMAIL_POLICY || fileEnv.OWNER_STUDIO_STAGING_EMAIL_POLICY || ''
  ).toLowerCase();
  if (!emailPolicy || !['disabled', 'controlled'].includes(emailPolicy)) {
    fail('missing_email_policy', 'OWNER_STUDIO_STAGING_EMAIL_POLICY must be disabled or controlled');
  }
  if (emailPolicy === 'disabled') {
    const resend = process.env.RESEND_API_KEY || fileEnv.RESEND_API_KEY || '';
    if (resend) {
      fail('resend_forbidden_when_email_disabled', 'RESEND_API_KEY must be absent when email policy is disabled');
    }
  }

  const runtimeUrl = process.env.DATABASE_URL || fileEnv.DATABASE_URL || '';
  const directUrl = process.env.DIRECT_URL || fileEnv.DIRECT_URL || stagingUrl;
  if (!runtimeUrl) {
    fail('missing_runtime_database_url', 'DATABASE_URL is required for staging runtime alignment');
  }
  if (!directUrl) {
    fail('missing_direct_database_url', 'DIRECT_URL is required for staging migrations');
  }

  const runtimeFp = parseDbUrl(runtimeUrl);
  const directFp = parseDbUrl(directUrl);
  if (!runtimeFp || runtimeFp.placeholder) {
    fail('invalid_runtime_database_url', 'DATABASE_URL is missing, malformed, or a placeholder');
  }
  if (!directFp || directFp.placeholder) {
    fail('invalid_direct_database_url', 'DIRECT_URL is missing, malformed, or a placeholder');
  }
  if (!directFp.isPostgres && !directFp.isAccelerate) {
    fail('direct_url_role_invalid', 'DIRECT_URL must be a postgres direct connection for migrations');
  }
  if (directFp.isAccelerate) {
    fail('direct_url_is_accelerate', 'DIRECT_URL must be direct PostgreSQL, not Accelerate');
  }

  // Credential identity alignment (URL username hash) for non-Accelerate URLs.
  if (!runtimeFp.isAccelerate && runtimeFp.userHash !== stagingFp.userHash) {
    fail('runtime_staging_identity_mismatch', 'DATABASE_URL credential identity must match OWNER_STUDIO_STAGING_DATABASE_URL', {
      runtimeUserFingerprint: runtimeFp.userHash,
      stagingUserFingerprint: stagingFp.userHash,
    });
  }
  if (directFp.userHash !== stagingFp.userHash) {
    fail('direct_staging_identity_mismatch', 'DIRECT_URL credential identity must match OWNER_STUDIO_STAGING_DATABASE_URL', {
      directUserFingerprint: directFp.userHash,
      stagingUserFingerprint: stagingFp.userHash,
    });
  }

  const deletionDate = process.env.STAGING_DB_DELETION_DATE || fileEnv.STAGING_DB_DELETION_DATE || '';
  const claimUrlPresent = !!(process.env.CLAIM_URL || fileEnv.CLAIM_URL);
  if (deletionDate || claimUrlPresent) {
    fail('staging_db_not_permanent', 'Staging database still looks temporary (CLAIM_URL or STAGING_DB_DELETION_DATE present). Claim or replace with a permanent project.', {
      hasDeletionDate: !!deletionDate,
      hasClaimUrl: claimUrlPresent,
    });
  }

  // Live connection — URL fingerprint alone is never sufficient.
  const liveDirect = await connectIdentity(directUrl);
  if (!liveDirect.ok) {
    fail('staging_direct_connection_failed', 'Could not authenticate to staging DIRECT_URL', {
      connectionError: liveDirect.error,
      userFingerprint: stagingFp.userHash,
      hostFingerprint: stagingFp.hostHash,
    });
  }

  let liveRuntime = null;
  if (!runtimeFp.isAccelerate) {
    liveRuntime = await connectIdentity(runtimeUrl);
    if (!liveRuntime.ok) {
      fail('staging_runtime_connection_failed', 'Could not authenticate to staging DATABASE_URL', {
        connectionError: liveRuntime.error,
      });
    }
    if (liveRuntime.dbHash !== liveDirect.dbHash) {
      fail('runtime_direct_db_mismatch', 'Connected runtime and direct databases differ', {
        runtimeDbFingerprint: liveRuntime.dbHash,
        directDbFingerprint: liveDirect.dbHash,
      });
    }
  }

  const liveStaging = stagingUrl === directUrl
    ? liveDirect
    : await connectIdentity(stagingUrl);
  if (!liveStaging.ok) {
    fail('staging_connection_failed', 'Could not authenticate to OWNER_STUDIO_STAGING_DATABASE_URL', {
      connectionError: liveStaging.error,
    });
  }
  if (liveStaging.dbHash !== liveDirect.dbHash) {
    fail('staging_direct_db_mismatch', 'Connected staging and direct databases differ', {
      stagingDbFingerprint: liveStaging.dbHash,
      directDbFingerprint: liveDirect.dbHash,
    });
  }

  if (wantsSchema()) {
    const missing = REQUIRED_OS_TABLES.filter((t) => !liveDirect.tables.includes(t));
    if (missing.length) {
      fail('owner_studio_schema_incomplete', 'Required Owner Studio tables missing on staging', {
        missingTables: missing,
        presentTables: liveDirect.tables,
      });
    }
  }

  const result = {
    ok: true,
    configured: true,
    environment: 'staging',
    differentFromProduction: true,
    liveConnectionVerified: true,
    hostFingerprint: stagingFp.hostHash,
    databaseFingerprint: stagingFp.dbHash,
    userFingerprint: stagingFp.userHash,
    connectedDatabaseFingerprint: liveDirect.dbHash,
    connectedUserFingerprint: liveDirect.userHash,
    stagingSiteIdHash: sha12(stagingSiteId),
    productionSiteId: PRODUCTION_SITE_ID,
    productionUserFingerprint: productionUserHash,
    publicContentSource: publicSource || 'legacy',
    emailPolicy,
    runtimeConnectionMode: runtimeFp.isAccelerate ? 'accelerate_pooled' : 'postgres_adapter',
    directConnectionMode: 'postgres_direct',
    runtimeDirectAligned: true,
    schemaRequired: wantsSchema(),
    ownerStudioTablesPresent: REQUIRED_OS_TABLES.filter((t) => liveDirect.tables.includes(t)),
    stripeMode: stripeSecret
      ? (/^sk_test_/.test(stripeSecret) ? 'test' : 'unknown')
      : 'absent',
    twilioEnabled: false,
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  fail('assert_unexpected_error', String(err && err.message ? err.message : err).slice(0, 200));
});
