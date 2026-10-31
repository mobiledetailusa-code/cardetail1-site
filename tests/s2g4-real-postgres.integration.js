'use strict';

/**
 * Real PostgreSQL checks for S2G.4. Refuses every database except the
 * disposable instance named on the command line via DATABASE_URL.
 * Not part of npm test.
 */

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

if (process.env.S2G4_PRISMA_CLIENT) {
  const clientEntry = path.join(process.env.S2G4_PRISMA_CLIENT, 'index.js');
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function resolveIsolatedClient(request, parent, isMain, options) {
    if (request === '@prisma/client') return clientEntry;
    return resolveFilename.call(this, request, parent, isMain, options);
  };
}

const { Client } = require('pg');
const manual = require('../netlify/lib/db/manual-collection');
const authority = require('../netlify/lib/db/payment-authority-service');
const { ensureBookingFinancial } = require('../netlify/lib/db/ensure-booking-financial');
const { getSharedFinancialProjection } = require('../netlify/lib/db/operational-payment');
const { getPrisma } = require('../netlify/lib/prisma');

const CENTS = 15000;
const results = [];

function assertDisposable(url) {
  const parsed = new URL(url);
  if (
    parsed.hostname !== '127.0.0.1'
    || parsed.port !== '54333'
    || parsed.pathname !== '/cardetail1_s2g4_disposable'
    || parsed.username !== 's2g4_owner'
  ) {
    throw new Error('refusing connection: target is not the s2g4 disposable database');
  }
}

function record(result) {
  results.push(result);
  console.log(JSON.stringify({ test: result.test, pass: result.pass }));
}

async function main() {
  const url = String(process.env.DATABASE_URL || '');
  assertDisposable(url);
  delete process.env.SQUARE_ACCESS_TOKEN;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  process.env.CD1_POSTGRES_PAYMENT = '1';

  const admin = new Client({ connectionString: url });
  await admin.connect();
  const identity = await admin.query(`
    SELECT current_database() AS db, inet_server_addr()::text AS addr,
           inet_server_port() AS port, current_user AS usr,
           current_setting('data_directory') AS data_directory
  `);
  const idRow = identity.rows[0];
  if (idRow.db !== 'cardetail1_s2g4_disposable' || String(idRow.port) !== '54333' || !String(idRow.addr).startsWith('127.0.0.1')) {
    throw new Error('connected database failed the isolation check');
  }
  if (!String(idRow.data_directory).toLowerCase().includes('s2g4-disposable-pg')) {
    throw new Error('data directory is not the disposable cluster');
  }

  getPrisma();
  let seq = 0;
  const nextId = (label) => {
    seq += 1;
    return `s2g4-${String(seq).padStart(2, '0')}-${label}`;
  };

  async function seed(id) {
    await admin.query(`
      INSERT INTO "Booking" ("id", "status", "isDraft", "createdAt", "updatedAt")
      VALUES ($1, 'confirmed', false, now(), now())
    `, [id]);
    await admin.query(`
      INSERT INTO "Quote" ("id", "bookingId", "quoteVersion", "approvedCents", "status", "createdAt", "updatedAt")
      VALUES ($1, $2, 1, $3, 'approved', now(), now())
    `, [`${id}-q`, id, CENTS]);
  }

  async function snapshot(id) {
    const booking = await admin.query(`
      SELECT "manualCollectionState" AS state, "manualCollectionOperationId" AS operation_id
      FROM "Booking" WHERE id = $1
    `, [id]);
    const quotes = await admin.query(`
      SELECT "quoteVersion", "approvedCents", status FROM "Quote" WHERE "bookingId" = $1 ORDER BY "quoteVersion"
    `, [id]);
    const ledger = await admin.query(`
      SELECT kind, "amountCents", "providerEventId", "providerObjectId", actor
      FROM "LedgerEntry" WHERE "bookingId" = $1 ORDER BY "recordedAt", id
    `, [id]);
    const bookings = await admin.query('SELECT count(*)::int AS n FROM "Booking" WHERE id = $1', [id]);
    return {
      booking: booking.rows[0] || null,
      quotes: quotes.rows,
      ledger: ledger.rows,
      bookingCount: bookings.rows[0].n,
    };
  }

  function blob(id, settledCents = 0) {
    return {
      id,
      isDraft: false,
      status: 'confirmed',
      schemaVersion: 1,
      bookingVersion: 1,
      quoteVersion: 1,
      ledger: { approvedCents: CENTS, settledCents, currency: 'usd' },
    };
  }

  function reserve(id) {
    return manual.reserveManualCollection({
      bookingId: id,
      booking: blob(id),
      actorId: 's2g4-admin',
      env: process.env,
    });
  }

  function settle(id, method) {
    return authority.recordFullBalanceOnSiteSettlement({
      bookingId: id,
      method,
      body: {
        reason: 'synthetic s2g4 validation',
        ...(method === 'card_on_site' ? { reference: 'SYN-4' } : {}),
      },
    });
  }

  function importBlob(id, settledCents = CENTS) {
    return ensureBookingFinancial(blob(id, settledCents));
  }

  async function waitFor(sql, timeoutMs = 8000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const found = await admin.query(sql);
      if (found.rows.length) return found.rows;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return [];
  }

  async function installPause(kind) {
    await clearPause();
    if (kind === 'booking') {
      await admin.query(`
        CREATE OR REPLACE FUNCTION s2g4_pause_booking() RETURNS trigger AS $fn$
        BEGIN
          IF NEW."manualCollectionState" IS DISTINCT FROM OLD."manualCollectionState" THEN
            PERFORM pg_sleep(3);
          END IF;
          RETURN NEW;
        END;
        $fn$ LANGUAGE plpgsql
      `);
      await admin.query(`
        CREATE TRIGGER s2g4_pause_booking
        BEFORE UPDATE ON "Booking"
        FOR EACH ROW EXECUTE FUNCTION s2g4_pause_booking()
      `);
    }
    if (kind === 'ledger') {
      await admin.query(`
        CREATE OR REPLACE FUNCTION s2g4_pause_ledger() RETURNS trigger AS $fn$
        BEGIN
          PERFORM pg_sleep(3);
          RETURN NEW;
        END;
        $fn$ LANGUAGE plpgsql
      `);
      await admin.query(`
        CREATE TRIGGER s2g4_pause_ledger
        BEFORE INSERT ON "LedgerEntry"
        FOR EACH ROW EXECUTE FUNCTION s2g4_pause_ledger()
      `);
    }
    if (kind === 'reject-seed') {
      await admin.query(`
        CREATE OR REPLACE FUNCTION s2g4_reject_seed() RETURNS trigger AS $fn$
        BEGIN
          IF NEW.actor = 'blob_import_seed' THEN
            RAISE EXCEPTION 'synthetic_import_rollback';
          END IF;
          RETURN NEW;
        END;
        $fn$ LANGUAGE plpgsql
      `);
      await admin.query(`
        CREATE TRIGGER s2g4_reject_seed
        BEFORE INSERT ON "LedgerEntry"
        FOR EACH ROW EXECUTE FUNCTION s2g4_reject_seed()
      `);
    }
  }

  async function clearPause() {
    await admin.query('DROP TRIGGER IF EXISTS s2g4_pause_booking ON "Booking"');
    await admin.query('DROP TRIGGER IF EXISTS s2g4_pause_ledger ON "LedgerEntry"');
    await admin.query('DROP TRIGGER IF EXISTS s2g4_reject_seed ON "LedgerEntry"');
  }

  try {
    const initId = nextId('init');
    const initialized = await importBlob(initId, 0);
    const initAfter = await snapshot(initId);
    record({
      test: 'L3 import without an existing booking',
      pass: initialized.ok === true
        && initialized.seededSettlement === false
        && initialized.importBlocked == null
        && initAfter.bookingCount === 1
        && initAfter.quotes.length === 1
        && initAfter.quotes[0].status === 'approved'
        && initAfter.ledger.length === 0,
    });

    const repeatId = nextId('repeat');
    await seed(repeatId);
    const first = await importBlob(repeatId);
    const second = await importBlob(repeatId);
    const repeatAfter = await snapshot(repeatId);
    record({
      test: 'L4 repeated financial import',
      pass: first.seededSettlement === true
        && second.seededSettlement === false
        && repeatAfter.ledger.length === 1
        && repeatAfter.ledger[0].providerEventId === `blob_seed_${repeatId}_${CENTS}`,
    });

    const closedEmptyId = nextId('closed-empty');
    await seed(closedEmptyId);
    await admin.query(`UPDATE "Booking" SET "manualCollectionState" = 'closed' WHERE id = $1`, [closedEmptyId]);
    const closedEmpty = await importBlob(closedEmptyId, 0);
    const closedEmptyAfter = await snapshot(closedEmptyId);
    const closedPaidId = nextId('closed-history');
    await seed(closedPaidId);
    await admin.query(`UPDATE "Booking" SET "manualCollectionState" = 'closed' WHERE id = $1`, [closedPaidId]);
    const closedPaid = await importBlob(closedPaidId);
    const closedPaidAfter = await snapshot(closedPaidId);
    record({
      test: 'L5 import after collection closure',
      pass: closedEmpty.seededSettlement === false
        && closedEmptyAfter.ledger.length === 0
        && closedEmptyAfter.quotes[0].status === 'approved'
        && closedPaid.seededSettlement === true
        && closedPaidAfter.ledger.length === 1
        && closedPaidAfter.booking.state === 'closed',
    });

    const reserveWinsId = nextId('reserve-wins');
    await seed(reserveWinsId);
    await installPause('booking');
    const reservePromise = reserve(reserveWinsId);
    const reserveSleep = await waitFor(`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event = 'PgSleep'
    `);
    const importPromise = importBlob(reserveWinsId);
    const importBlockedBy = await waitFor(`
      SELECT pid, pg_blocking_pids(pid) AS blocked_by, wait_event
      FROM pg_stat_activity
      WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0
    `);
    const reserved = await reservePromise;
    const imported = await importPromise;
    await clearPause();
    const reserveWinsAfter = await snapshot(reserveWinsId);
    record({
      test: 'L1 manual reservation wins',
      pass: reserveSleep.length > 0
        && importBlockedBy.length > 0
        && reserved.ok === true
        && imported.seededSettlement === false
        && imported.importBlocked === 'manual_collection_active'
        && imported.synchronizationBlocked === true
        && reserveWinsAfter.booking.state === 'reserved'
        && reserveWinsAfter.ledger.length === 0
        && reserveWinsAfter.quotes[0].status === 'approved',
    });

    const importWinsId = nextId('import-wins');
    await seed(importWinsId);
    await installPause('ledger');
    const winningImport = importBlob(importWinsId);
    const importSleep = await waitFor(`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event = 'PgSleep'
    `);
    const waitingReserve = reserve(importWinsId);
    const reserveBlockedBy = await waitFor(`
      SELECT pid, pg_blocking_pids(pid) AS blocked_by, wait_event
      FROM pg_stat_activity
      WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0
    `);
    const importedWin = await winningImport;
    const reservedAfterImport = await waitingReserve;
    await clearPause();
    const importWinsAfter = await snapshot(importWinsId);
    record({
      test: 'L2 financial import wins',
      pass: importSleep.length > 0
        && reserveBlockedBy.length > 0
        && importedWin.seededSettlement === true
        && reservedAfterImport.ok === false
        && reservedAfterImport.error === 'zero_remaining_balance'
        && importWinsAfter.booking.state == null
        && importWinsAfter.ledger.length === 1
        && importWinsAfter.quotes[0].status === 'settled',
    });

    const recordedId = nextId('recorded');
    await seed(recordedId);
    await admin.query(`UPDATE "Booking" SET "manualCollectionState" = 'recorded' WHERE id = $1`, [recordedId]);
    const recorded = await importBlob(recordedId);
    const recordedAfter = await snapshot(recordedId);
    record({
      test: 'L6 recorded stays blocked',
      pass: recorded.importBlocked === 'manual_collection_active'
        && recorded.seededSettlement === false
        && recordedAfter.booking.state === 'recorded'
        && recordedAfter.ledger.length === 0,
    });

    const reportedId = nextId('reported');
    await seed(reportedId);
    await admin.query(`UPDATE "Booking" SET "manualCollectionState" = 'payment_reported' WHERE id = $1`, [reportedId]);
    const reported = await importBlob(reportedId);
    const reportedAfter = await snapshot(reportedId);
    record({
      test: 'L6 payment_reported stays blocked',
      pass: reported.importBlocked === 'manual_collection_active'
        && reported.seededSettlement === false
        && reportedAfter.booking.state === 'payment_reported'
        && reportedAfter.ledger.length === 0
        && reportedAfter.quotes[0].status === 'approved',
    });

    await admin.query('ALTER TABLE "Booking" DROP CONSTRAINT IF EXISTS "Booking_manual_collection_state"');
    const unknownId = nextId('unknown');
    await seed(unknownId);
    await admin.query(`UPDATE "Booking" SET "manualCollectionState" = 'not_a_known_state' WHERE id = $1`, [unknownId]);
    const unknown = await importBlob(unknownId);
    const unknownAfter = await snapshot(unknownId);
    record({
      test: 'L7 unknown collection state fails closed',
      pass: unknown.importBlocked === 'manual_collection_active'
        && unknown.seededSettlement === false
        && unknownAfter.ledger.length === 0
        && unknownAfter.booking.state === 'not_a_known_state',
    });

    const rollbackId = nextId('rollback');
    await seed(rollbackId);
    await installPause('reject-seed');
    const rolled = await importBlob(rollbackId);
    await clearPause();
    const rollbackAfter = await snapshot(rollbackId);
    record({
      test: 'L8 failed import rolls back',
      pass: rolled.ok === false
        && rolled.error === 'financial_import_failed'
        && rollbackAfter.ledger.length === 0
        && rollbackAfter.quotes.length === 1
        && rollbackAfter.quotes[0].status === 'approved',
    });

    const raceA = nextId('race');
    await installPause('ledger');
    const left = importBlob(raceA);
    const right = importBlob(raceA);
    await waitFor(`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event = 'PgSleep'
    `);
    const raced = await Promise.all([left, right]);
    await clearPause();
    const raceAfter = await snapshot(raceA);
    const seeds = raced.filter((result) => result.seededSettlement === true).length;
    record({
      test: 'L9 concurrent initialization',
      pass: raceAfter.bookingCount === 1
        && raceAfter.quotes.length === 1
        && raceAfter.ledger.length === 1
        && seeds === 1
        && raced.every((result) => result.ok === true),
    });

    async function settlementWins(method, testName) {
      const id = nextId(method);
      await seed(id);
      await installPause('ledger');
      const settlementPromise = settle(id, method);
      const sleeping = await waitFor(`
        SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event = 'PgSleep'
      `);
      const reservationPromise = reserve(id);
      const blocked = await waitFor(`
        SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0
      `);
      const settled = await settlementPromise;
      const waiting = await reservationPromise;
      await clearPause();
      const after = await snapshot(id);
      record({
        test: testName,
        pass: sleeping.length > 0
          && blocked.length > 0
          && settled.ok === true
          && settled.created === true
          && waiting.error === 'zero_remaining_balance'
          && after.booking.state == null
          && after.ledger.length === 1
          && after.quotes[0].status === 'settled',
      });
    }

    async function reservationWins(method, testName) {
      const id = nextId(`${method}-reserve`);
      await seed(id);
      await installPause('booking');
      const reservationPromise = reserve(id);
      const sleeping = await waitFor(`
        SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event = 'PgSleep'
      `);
      const settlementPromise = settle(id, method);
      const blocked = await waitFor(`
        SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0
      `);
      const waitingReserve = await reservationPromise;
      const settled = await settlementPromise;
      await clearPause();
      const after = await snapshot(id);
      record({
        test: testName,
        pass: sleeping.length > 0
          && blocked.length > 0
          && waitingReserve.ok === true
          && settled.error === 'manual_collection_active'
          && after.booking.state === 'reserved'
          && after.ledger.length === 0
          && after.quotes[0].status === 'approved',
      });
    }

    await settlementWins('cash', 'L10 cash settlement still excludes an in-flight reservation');
    await reservationWins('cash', 'L10 an active reservation still excludes cash settlement');
    await settlementWins('card_on_site', 'L10 card settlement still excludes an in-flight reservation');
    await reservationWins('card_on_site', 'L10 an active reservation still excludes card settlement');

    const rawId = nextId('raw-sql');
    await seed(rawId);
    const holder = new Client({ connectionString: url });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM "Booking" WHERE id = $1 FOR UPDATE', [rawId]);
    const waiter = reserve(rawId);
    const rawBlocked = await waitFor(`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0
    `);
    await holder.query(`
      INSERT INTO "LedgerEntry"
        ("id", "bookingId", "kind", "amountCents", "quoteVersion", "providerEventId", "actor", "occurredAt", "recordedAt")
      VALUES ($1, $2, 'settlement', $3, 1, $4, 'raw_sql_writer', now(), now())
    `, [`${rawId}-raw`, rawId, CENTS, `raw_${rawId}`]);
    await holder.query('COMMIT');
    const rawReserve = await waiter;
    await holder.end();
    const rawAfter = await snapshot(rawId);
    record({
      test: 'L11 raw SQL writer is outside the application protocol',
      pass: rawBlocked.length > 0
        && rawReserve.error === 'zero_remaining_balance'
        && rawAfter.booking.state == null
        && rawAfter.ledger.length === 1
        && rawAfter.ledger[0].actor === 'raw_sql_writer'
        && rawAfter.quotes[0].status === 'approved',
    });

    const readerId = nextId('reader');
    await seed(readerId);
    await reserve(readerId);
    const shared = await getSharedFinancialProjection(blob(readerId, CENTS), { env: process.env });
    const readerAfter = await snapshot(readerId);
    record({
      test: 'L12 a blocked import stays a PostgreSQL projection',
      pass: shared.ok === true
        && shared.authority === 'postgres'
        && shared.synchronizationBlocked === true
        && shared.importBlocked === 'manual_collection_active'
        && Number(shared.projection.remainingCents) === CENTS
        && readerAfter.ledger.length === 0
        && readerAfter.booking.state === 'reserved',
    });
  } finally {
    await clearPause();
    await admin.end();
    const out = path.join('C:\\Projects\\Cardetail1\\tmp', 's2g4-results.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({
      failed: results.filter((item) => !item.pass).length,
      recorded: results.length,
      results,
    }, null, 2));
    const prisma = getPrisma();
    if (prisma) await prisma.$disconnect();
  }

  const failed = results.filter((item) => !item.pass);
  if (failed.length || results.length !== 16) {
    console.error(JSON.stringify({ failed: failed.map((item) => item.test), recorded: results.length }));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
