#!/usr/bin/env node
'use strict';

/**
 * Owner Studio staging isolation gate.
 * Fail-closed: missing staging URL / matching production identity / matching
 * production site ID aborts before any migration.
 *
 * Never prints credentials, full hosts, or connection strings.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PRODUCTION_SITE_ID = 'd7e5f77c-1f0b-4209-a9df-3d6aae380dd0';
const root = path.join(__dirname, '..');

function sha12(v) {
  return crypto.createHash('sha256').update(String(v || '')).digest('hex').slice(0, 12);
}

function parseDbUrl(raw) {
  if (!raw || !String(raw).trim()) return null;
  const cleaned = String(raw).trim().replace(/^["']|["']$/g, '').replace(/^prisma\+/, '');
  try {
    const url = new URL(cleaned);
    return {
      hostHash: sha12(url.hostname || ''),
      userHash: sha12(url.username || ''),
      dbHash: sha12((url.pathname || '/').replace(/^\//, '') || 'postgres'),
      port: url.port || '(default)',
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

function main() {
  // Prefer explicit staging env file for local ops; never require printing secrets.
  // Tests/proofs may set OWNER_STUDIO_STAGING_IGNORE_ENV_FILE=1 to force process env only.
  const ignoreFile = /^(1|true|yes)$/i.test(String(process.env.OWNER_STUDIO_STAGING_IGNORE_ENV_FILE || ''));
  const fileEnv = ignoreFile ? {} : readEnvFile(path.join(root, '.env.owner-studio-staging'));
  const stagingUrl =
    process.env.OWNER_STUDIO_STAGING_DATABASE_URL ||
    fileEnv.OWNER_STUDIO_STAGING_DATABASE_URL ||
    '';

  if (!stagingUrl) {
    fail('missing_owner_studio_staging_database_url', 'OWNER_STUDIO_STAGING_DATABASE_URL is required');
  }

  // Reject silent fallback patterns: staging URL must be distinct env var presence.
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

  // Production identity for comparison (sanitized). Prefer explicit hash; else local .env DIRECT_URL.
  let productionUserHash = process.env.OWNER_STUDIO_PRODUCTION_DB_USER_HASH || '';
  if (!productionUserHash) {
    const prodEnv = readEnvFile(path.join(root, '.env'));
    const prodUrl = prodEnv.DIRECT_URL || prodEnv.DATABASE_URL || process.env.DIRECT_URL || process.env.DATABASE_URL;
    const prodFp = parseDbUrl(prodUrl);
    if (prodFp) productionUserHash = prodFp.userHash;
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

  // Live Stripe / Twilio hard fails when classified.
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
  const runtimeIsAccelerate = /^(prisma\+|prisma:)/.test(runtimeUrl) || /accelerate\.prisma-data\.net/.test(runtimeUrl);
  const runtimeIsPostgres = /^postgres(ql)?:\/\//i.test(runtimeUrl);
  const directIsPostgres = /^postgres(ql)?:\/\//i.test(directUrl.replace(/^prisma\+/, ''));
  if (!directIsPostgres && !runtimeIsAccelerate) {
    // Direct should be TCP for migrations; accelerate-only stacks may still use direct TCP in DIRECT_URL.
    fail('direct_url_role_invalid', 'DIRECT_URL must be a postgres direct connection for migrations');
  }

  // Temporary create-db marker: deletion date present means not yet permanent.
  const deletionDate = process.env.STAGING_DB_DELETION_DATE || fileEnv.STAGING_DB_DELETION_DATE || '';
  const claimUrlPresent = !!(process.env.CLAIM_URL || fileEnv.CLAIM_URL);
  if (deletionDate || claimUrlPresent) {
    fail('staging_db_not_permanent', 'Staging database still looks temporary (CLAIM_URL or STAGING_DB_DELETION_DATE present). Claim or replace with a permanent project.', {
      hasDeletionDate: !!deletionDate,
      hasClaimUrl: claimUrlPresent,
    });
  }

  const result = {
    ok: true,
    configured: true,
    environment: 'staging',
    differentFromProduction: true,
    hostFingerprint: stagingFp.hostHash,
    databaseFingerprint: stagingFp.dbHash,
    userFingerprint: stagingFp.userHash,
    stagingSiteIdHash: sha12(stagingSiteId),
    productionSiteId: PRODUCTION_SITE_ID,
    publicContentSource: publicSource || 'legacy',
    emailPolicy,
    runtimeConnectionMode: runtimeIsAccelerate ? 'accelerate_pooled' : runtimeIsPostgres ? 'postgres_adapter' : 'unknown',
    directConnectionMode: directIsPostgres ? 'postgres_direct' : 'unknown',
    stripeMode: stripeSecret
      ? (/^sk_test_/.test(stripeSecret) ? 'test' : 'unknown')
      : 'absent',
    twilioEnabled: false,
  };
  console.log(JSON.stringify(result, null, 2));
}

main();
