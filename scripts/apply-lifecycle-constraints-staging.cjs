'use strict';

/**
 * Staging-only: apply customer lifecycle constraint migration.
 * Refuses production DB fingerprint.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PROD_HASH = 'c4be3c552070';
const STAGING_HASH = 'ace558fae8fd';

function userHashFromUrl(url) {
  const m = String(url || '').match(/^postgres(?:ql)?:\/\/([^:]+):/);
  if (!m) return null;
  return crypto.createHash('sha256').update(m[1]).digest('hex').slice(0, 12);
}

async function main() {
  const url = String(process.env.OWNER_STUDIO_STAGING_DATABASE_URL || process.env.DIRECT_URL || process.env.DATABASE_URL || '').trim();
  if (!url) {
    console.log(JSON.stringify({ ok: false, error: 'missing_database_url' }));
    process.exit(1);
  }
  const hash = userHashFromUrl(url);
  if (hash === PROD_HASH) {
    console.log(JSON.stringify({ ok: false, error: 'production_db_rejected', userHash: hash }));
    process.exit(2);
  }
  if (hash !== STAGING_HASH) {
    console.log(JSON.stringify({ ok: false, error: 'unexpected_staging_db', userHash: hash, expected: STAGING_HASH }));
    process.exit(2);
  }

  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    const dup = await pool.query(`
      SELECT "siteId", COUNT(*)::int AS c
      FROM "OsCustomerLifecycleDraft"
      GROUP BY "siteId"
      HAVING COUNT(*) > 1
    `);
    if (dup.rows.length) {
      console.log(JSON.stringify({ ok: false, error: 'duplicate_lifecycle_drafts', rows: dup.rows }));
      process.exit(3);
    }

    const sql = fs.readFileSync(
      path.join(__dirname, '..', 'prisma', 'migrations', '20260728140000_customer_lifecycle_constraints', 'migration.sql'),
      'utf8'
    );
    await pool.query(sql);

    const cols = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'AppointmentEvent' AND column_name = 'idempotencyKey'
    `);
    const indexes = await pool.query(`
      SELECT indexname FROM pg_indexes
      WHERE indexname LIKE '%LifecycleDraft_siteId%'
         OR indexname LIKE '%idempotencyKey%'
    `);

    try {
      await pool.query(`
        INSERT INTO "_prisma_migrations"
          (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
        VALUES
          ($1, 'manual-staging', NOW(), '20260728140000_customer_lifecycle_constraints', NULL, NULL, NOW(), 1)
        ON CONFLICT DO NOTHING
      `, [crypto.randomUUID()]);
    } catch (e) {
      // ignore migration table shape differences
    }

    console.log(JSON.stringify({
      ok: true,
      userHash: hash,
      idempotencyColumn: cols.rows.length === 1,
      indexes: indexes.rows.map((r) => r.indexname),
    }));
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 200) }));
  process.exit(1);
});
