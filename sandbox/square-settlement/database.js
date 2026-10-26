'use strict';

/**
 * Connection gate for the isolated Square Sandbox settlement prototype.
 *
 * This module opens only the disposable local database
 * cardetail1_square_settlement_7d on 127.0.0.1 port 5433.
 * It does not read DATABASE_URL. A remote host, another port, or another
 * database name fails before any SQL is sent.
 *
 * Depends on Square adapter commit f68c9b46af83d747e55139eaac5fb724db0e43e4
 * (Draft PR #373). This branch is not that pull request.
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const LOCAL_DATABASE_NAME = 'cardetail1_square_settlement_7d';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const LOCAL_PORT = '5433';
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

function assertLocalSettlementUrl(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('square_settlement_database_unproven');
  }
  const host = url.hostname.toLowerCase();
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error('square_settlement_database_unproven');
  }
  if (!LOCAL_HOSTS.has(host) || String(url.port) !== LOCAL_PORT) {
    throw new Error('square_settlement_database_unproven');
  }
  if (database !== LOCAL_DATABASE_NAME) {
    throw new Error('square_settlement_database_unproven');
  }
  if (/neon|amazonaws|supabase|squareup/i.test(connectionString)) {
    throw new Error('square_settlement_database_unproven');
  }
  return { host, database };
}

async function connectProven(connectionString) {
  assertLocalSettlementUrl(connectionString);
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5000,
    statement_timeout: 8000,
  });
  await client.connect();
  const proof = await client.query(
    'SELECT current_database() AS database, inet_server_addr()::text AS address, inet_server_port()::text AS port'
  );
  const row = proof.rows[0] || {};
  const address = String(row.address || '');
  const localAddress = address === '127.0.0.1' || address === '::1' || address === '127.0.0.1/32';
  if (row.database !== LOCAL_DATABASE_NAME || row.port !== LOCAL_PORT || !localAddress) {
    await client.end();
    throw new Error('square_settlement_database_unproven');
  }
  return client;
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
  assertLocalSettlementUrl,
  connectProven,
  applySettlementSchema,
  emptySettlementTables,
};
