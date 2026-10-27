'use strict';

/**
 * Connection gate for the isolated Square Sandbox settlement prototype.
 *
 * This module opens only the disposable local database
 * cardetail1_square_settlement_7d on loopback port 5432 or 5433.
 * Port 5433 is the local disposable server. Port 5432 is the ephemeral
 * GitHub Actions service. The full-test job runs these tests in that
 * service's network namespace, so the server address check still requires
 * loopback. This module does not read DATABASE_URL.
 * Query parameters, fragments and ambiguous URLs fail before client creation.
 * The driver receives canonical settings, never the original connection string.
 *
 * Depends on Square adapter commit f68c9b46af83d747e55139eaac5fb724db0e43e4
 * (Draft PR #373). This branch is not that pull request.
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const LOCAL_DATABASE_NAME = 'cardetail1_square_settlement_7d';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const LOCAL_PORTS = new Set(['5432', '5433']);
const LOCAL_PORT = '5433';
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

function canonicalClientConfig(connectionString) {
  try {
    // Accept one explicit authority and the literal dedicated database path.
    // Reject even empty query/fragment delimiters, URL normalization tricks,
    // sockets and omitted identity fields rather than relying on pg defaults.
    if (typeof connectionString !== 'string'
      || /[\x00-\x20\x7f\\?#]/.test(connectionString)
      || !/^postgres(?:ql)?:\/\/[^@/]+@(127\.0\.0\.1|localhost):(5432|5433)\/cardetail1_square_settlement_7d$/.test(connectionString)) {
      throw new Error('refused');
    }
    const url = new URL(connectionString);
    const authority = connectionString.slice(connectionString.indexOf('://') + 3).split('@')[0];
    if (!/^[^:]+(?::[^:]+)?$/.test(authority)) throw new Error('refused');
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(user)
      || /[\x00-\x1f\x7f]/.test(password)
      || !LOCAL_HOSTS.has(url.hostname) || !LOCAL_PORTS.has(url.port)
      || url.pathname !== `/${LOCAL_DATABASE_NAME}`) {
      throw new Error('refused');
    }
    return {
      // Resolve the accepted localhost alias here, without a DNS lookup.
      host: '127.0.0.1',
      port: Number(url.port),
      database: LOCAL_DATABASE_NAME,
      user,
      // pg falls back to PGPASSWORD for a falsy password. A provider returning
      // the validated string preserves passwordless trust auth without reading
      // PGPASSWORD or a pgpass file. It also keeps the password out of JSON logs.
      password: () => password,
      ssl: false,
      sslnegotiation: 'postgres',
      client_encoding: 'UTF8',
      application_name: 'cardetail1-square-settlement',
      replication: 'false',
      options: '-c statement_timeout=8000',
      connectionTimeoutMillis: 5000,
      statement_timeout: 8000,
    };
  } catch {
    // Never include the supplied URL, credentials, or a parser's input in errors.
    throw new Error('square_settlement_database_unproven');
  }
}

function assertLocalSettlementUrl(connectionString) {
  const config = canonicalClientConfig(connectionString);
  return { host: config.host, database: config.database, port: String(config.port) };
}

async function connectProven(connectionString) {
  const config = canonicalClientConfig(connectionString);
  const client = new Client(config);
  try {
    await client.connect();
    const proof = await client.query(
      'SELECT current_database() AS database, inet_server_addr()::text AS address, inet_server_port()::text AS port, current_user AS "user"'
    );
    const row = proof.rows[0] || {};
    const localAddress = row.address === '127.0.0.1' || row.address === '127.0.0.1/32';
    if (row.database !== config.database || row.port !== String(config.port)
      || row.user !== config.user || !localAddress) {
      throw new Error('square_settlement_database_unproven');
    }
    return client;
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
}

function schemaSql() {
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  if (/drop\s+table|prisma|paymentattempt|ledgerentry|database_url/i.test(sql)) {
    throw new Error('square_settlement_schema_refused');
  }
  return sql;
}

async function applySettlementSchema(connectionString) {
  const client = await connectProven(connectionString);
  try {
    await client.query(schemaSql());
  } finally {
    await client.end();
  }
}

async function emptySettlementTables(connectionString) {
  const client = await connectProven(connectionString);
  try {
    await client.query('DROP TABLE IF EXISTS sandbox_settlement');
    await client.query('DROP TABLE IF EXISTS sandbox_payment_event');
    await client.query('DROP TABLE IF EXISTS sandbox_payment_operation');
    await client.query('DROP TABLE IF EXISTS sandbox_payment_obligation');
  } finally {
    await client.end();
  }
}

module.exports = {
  LOCAL_DATABASE_NAME,
  LOCAL_PORT,
  LOCAL_PORTS,
  assertLocalSettlementUrl,
  connectProven,
  applySettlementSchema,
  emptySettlementTables,
};
