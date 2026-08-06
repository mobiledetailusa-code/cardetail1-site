#!/usr/bin/env node

/**
 * Read-only financial database preflight.
 *
 * Uses CD1_PREFLIGHT_DATABASE_URL first so an operator can target a provider
 * clone without changing application variables. It never prints payloads,
 * customer data, connection strings, or secrets.
 */
import pg from 'pg';

const { Client } = pg;
const connectionString = process.env.CD1_PREFLIGHT_DATABASE_URL
  || process.env.DIRECT_URL
  || process.env.DATABASE_URL;

if (!connectionString) {
  console.error('financial-preflight: CD1_PREFLIGHT_DATABASE_URL, DIRECT_URL, or DATABASE_URL is required');
  process.exit(2);
}

const client = new Client({ connectionString, application_name: 'cardetail1_financial_preflight' });

async function scalar(sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows[0] || {};
}

async function tableExists(name) {
  const row = await scalar(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1
    ) AS present
  `, [name]);
  return !!row.present;
}

async function main() {
  await client.connect();
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout = '120s'");
  await client.query("SET LOCAL lock_timeout = '2s'");

  try {
    const version = await scalar("SELECT current_setting('server_version') AS version");
    const tables = {};
    for (const name of ['_prisma_migrations', 'StripeEvent', 'PaymentAttempt', 'LedgerEntry', 'Quote']) {
      tables[name] = await tableExists(name);
    }

    const migrations = tables._prisma_migrations
      ? (await client.query(`
          SELECT migration_name AS name,
                 finished_at IS NOT NULL AS finished,
                 rolled_back_at IS NOT NULL AS rolled_back
          FROM "_prisma_migrations"
          ORDER BY started_at
        `)).rows
      : [];

    const stripeEvents = tables.StripeEvent
      ? await scalar(`
          SELECT count(*)::bigint AS count,
                 pg_total_relation_size('"StripeEvent"')::bigint AS bytes,
                 md5(count(*)::text || ':' || COALESCE(
                   sum(hashtextextended(
                     coalesce("id", '') || '|' || coalesce("stripeEventId", '') || '|' || coalesce("payload"::text, ''),
                     0
                   )::numeric), 0
                 )::text) AS fingerprint,
                 count(*) FILTER (WHERE jsonb_typeof("payload") <> 'object')::bigint AS invalid_payload_shape,
                 count(*) FILTER (
                   WHERE "payload"::text ~* 'client_secret|billing_details|payment_method_details|card|charges|raw'
                 )::bigint AS potentially_sensitive_payloads
          FROM "StripeEvent"
        `)
      : { count: '0', bytes: '0', fingerprint: null, invalid_payload_shape: '0', potentially_sensitive_payloads: '0' };

    const stripeEventTypes = tables.StripeEvent
      ? (await client.query(`
          SELECT "type", count(*)::bigint AS count
          FROM "StripeEvent"
          GROUP BY "type"
          ORDER BY count(*) DESC, "type"
        `)).rows
      : [];

    const duplicates = {
      stripeEventId: tables.StripeEvent
        ? Number((await scalar(`
            SELECT count(*)::bigint AS count FROM (
              SELECT "stripeEventId" FROM "StripeEvent" GROUP BY "stripeEventId" HAVING count(*) > 1
            ) d
          `)).count)
        : 0,
      paymentAttemptProviderObjectId: tables.PaymentAttempt
        ? Number((await scalar(`
            SELECT count(*)::bigint AS count FROM (
              SELECT "providerObjectId" FROM "PaymentAttempt"
              WHERE "providerObjectId" IS NOT NULL
              GROUP BY "providerObjectId" HAVING count(*) > 1
            ) d
          `)).count)
        : 0,
      paymentAttemptIdempotencyKey: tables.PaymentAttempt
        ? Number((await scalar(`
            SELECT count(*)::bigint AS count FROM (
              SELECT "idempotencyKey" FROM "PaymentAttempt"
              GROUP BY "idempotencyKey" HAVING count(*) > 1
            ) d
          `)).count)
        : 0,
      activePaymentAttempt: tables.PaymentAttempt
        ? Number((await scalar(`
            SELECT count(*)::bigint AS count FROM (
              SELECT "bookingId", "quoteVersion" FROM "PaymentAttempt"
              WHERE "status"::text IN ('creating', 'open', 'requires_action')
              GROUP BY "bookingId", "quoteVersion" HAVING count(*) > 1
            ) d
          `)).count)
        : 0,
      ledgerProviderEventId: tables.LedgerEntry
        ? Number((await scalar(`
            SELECT count(*)::bigint AS count FROM (
              SELECT "providerEventId" FROM "LedgerEntry"
              WHERE "providerEventId" IS NOT NULL
              GROUP BY "providerEventId" HAVING count(*) > 1
            ) d
          `)).count)
        : 0,
    };

    const invalid = {
      paymentAttemptAmount: tables.PaymentAttempt
        ? Number((await scalar('SELECT count(*)::bigint AS count FROM "PaymentAttempt" WHERE "amountCents" IS NULL OR "amountCents" <= 0')).count)
        : 0,
      paymentAttemptCurrency: tables.PaymentAttempt
        ? Number((await scalar("SELECT count(*)::bigint AS count FROM \"PaymentAttempt\" WHERE \"currency\" IS NULL OR lower(\"currency\") <> 'usd'")).count)
        : 0,
      ledgerAmount: tables.LedgerEntry
        ? Number((await scalar("SELECT count(*)::bigint AS count FROM \"LedgerEntry\" WHERE \"amountCents\" IS NULL OR (\"kind\"::text <> 'adjustment' AND \"amountCents\" <= 0)")).count)
        : 0,
      quoteApprovedAmount: tables.Quote
        ? Number((await scalar('SELECT count(*)::bigint AS count FROM "Quote" WHERE "approvedCents" IS NULL OR "approvedCents" < 0')).count)
        : 0,
    };

    const paymentAttempts = tables.PaymentAttempt
      ? await scalar(`
          SELECT count(*)::bigint AS count,
                 pg_total_relation_size('"PaymentAttempt"')::bigint AS bytes
          FROM "PaymentAttempt"
        `)
      : { count: '0', bytes: '0' };

    const ledger = tables.LedgerEntry
      ? await scalar(`
          SELECT count(*)::bigint AS count,
                 pg_total_relation_size('"LedgerEntry"')::bigint AS bytes,
                 md5(count(*)::text || ':' || COALESCE(
                   sum(hashtextextended(
                     coalesce("id", '') || '|' || coalesce("bookingId", '') || '|' ||
                     coalesce("kind"::text, '') || '|' || coalesce("amountCents"::text, '') || '|' ||
                     coalesce("providerEventId", ''),
                     0
                   )::numeric), 0
                 )::text) AS fingerprint
          FROM "LedgerEntry"
        `)
      : { count: '0', bytes: '0', fingerprint: null };

    const locks = (await client.query(`
      SELECT c.relname AS table_name, l.mode, l.granted, count(*)::bigint AS count
      FROM pg_locks l
      JOIN pg_class c ON c.oid = l.relation
      WHERE c.relname = ANY($1::text[])
      GROUP BY c.relname, l.mode, l.granted
      ORDER BY c.relname, l.mode, l.granted
    `, [['StripeEvent', 'PaymentAttempt', 'LedgerEntry', 'Quote']])).rows;

    const evidence = {
      generatedAt: new Date().toISOString(),
      mode: 'read_only_transaction',
      postgresVersion: version.version,
      migrationHistory: migrations,
      counts: {
        stripeEvents: Number(stripeEvents.count),
        paymentAttempts: Number(paymentAttempts.count),
        ledgerEntries: Number(ledger.count),
      },
      tableBytes: {
        stripeEvents: Number(stripeEvents.bytes),
        paymentAttempts: Number(paymentAttempts.bytes),
        ledgerEntries: Number(ledger.bytes),
      },
      fingerprints: {
        stripeEvents: stripeEvents.fingerprint,
        ledgerEntries: ledger.fingerprint,
      },
      stripeEventTypes: stripeEventTypes.map((row) => ({ type: row.type, count: Number(row.count) })),
      potentiallySensitiveStripeEventPayloads: Number(stripeEvents.potentially_sensitive_payloads),
      invalidStripeEventPayloadShapes: Number(stripeEvents.invalid_payload_shape),
      duplicates,
      invalid,
      locks: locks.map((row) => ({
        table: row.table_name,
        mode: row.mode,
        granted: row.granted,
        count: Number(row.count),
      })),
      ddlEstimate: {
        stripeEventTableBytes: Number(stripeEvents.bytes),
        operations: [
          'PaymentAttempt: add 4 columns',
          'StripeEvent: add 5 columns',
          'StripeEvent: create status index',
          'PaymentAttempt/LedgerEntry/StripeEvent: add NOT VALID checks',
        ],
        dataRewrite: false,
        payloadRewrite: false,
      },
    };

    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}

main().catch((error) => {
  console.error(`financial-preflight: ${error.code || error.name || 'error'}: ${error.message}`);
  process.exit(1);
});
