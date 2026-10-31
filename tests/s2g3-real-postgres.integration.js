'use strict';

/**
 * Real PostgreSQL checks for S2G.3. Refuses every database except the
 * disposable instance named on the command line via DATABASE_URL.
 * Not part of npm test. Run only against a localhost cluster created for this phase.
 */

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

if (process.env.S2G3_PRISMA_CLIENT) {
  const clientEntry = path.join(process.env.S2G3_PRISMA_CLIENT, 'index.js');
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
const { getPrisma } = require('../netlify/lib/prisma');

const CENTS = 15000;
const results = [];

function assertDisposable(url) {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' || parsed.port !== '54331' || parsed.pathname !== '/cardetail1_s2g3_disposable' || parsed.username !== 's2g3_owner') {
    throw new Error('refusing connection: target is not the s2g3 disposable database');
  }
}

function record(result) {
  results.push(result);
  console.log(JSON.stringify({ test: result.test, pass: result.pass, actual: result.actual }));
}

async function main() {
  const url = String(process.env.DATABASE_URL || '');
  assertDisposable(url);
  delete process.env.SQUARE_ACCESS_TOKEN;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  process.env.CD1_POSTGRES_PAYMENT = '1';
  process.env.MANUAL_SQUARE_COLLECTION_ENABLED = 'true';

  const admin = new Client({ connectionString: url });
  await admin.connect();
  const identity = await admin.query(`
    SELECT current_database() AS db, inet_server_addr()::text AS addr,
           inet_server_port() AS port, current_user AS usr,
           current_setting('data_directory') AS data_directory
  `);
  const idRow = identity.rows[0];
  if (idRow.db !== 'cardetail1_s2g3_disposable' || String(idRow.port) !== '54331' || !String(idRow.addr).startsWith('127.0.0.1')) {
    throw new Error('connected database failed the isolation check');
  }
  if (!String(idRow.data_directory).toLowerCase().includes('s2g3-disposable-pg')) {
    throw new Error('data directory is not the disposable cluster');
  }

  const prisma = getPrisma();
  let seq = 0;
  const nextId = (label) => {
    seq += 1;
    return `s2g3-${String(seq).padStart(2, '0')}-${label}`;
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
      SELECT "manualCollectionState" AS state,
             "manualCollectionOperationId" AS operation_id,
             status
      FROM "Booking" WHERE id = $1
    `, [id]);
    const quote = await admin.query(`
      SELECT "quoteVersion", "approvedCents", status
      FROM "Quote" WHERE "bookingId" = $1
      ORDER BY "quoteVersion" DESC LIMIT 1
    `, [id]);
    const ledger = await admin.query(`
      SELECT kind, "amountCents", "providerObjectId"
      FROM "LedgerEntry" WHERE "bookingId" = $1
      ORDER BY "recordedAt", id
    `, [id]);
    return {
      booking: booking.rows[0] || null,
      quote: quote.rows[0] || null,
      ledger: ledger.rows,
    };
  }

  function blob(id, extra = {}) {
    return {
      id,
      isDraft: false,
      status: 'confirmed',
      schemaVersion: 1,
      bookingVersion: 1,
      quoteVersion: 1,
      ledger: { approvedCents: CENTS, settledCents: 0, currency: 'usd' },
      ...extra,
    };
  }

  function reserve(id) {
    return manual.reserveManualCollection({
      bookingId: id,
      booking: blob(id),
      actorId: 's2g3-admin',
      env: process.env,
    });
  }

  function settle(id, method) {
    return authority.recordFullBalanceOnSiteSettlement({
      bookingId: id,
      method,
      body: {
        reason: 'synthetic s2g3 validation',
        ...(method === 'card_on_site' ? { reference: 'SYN-3' } : {}),
      },
    });
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
    await admin.query('DROP TRIGGER IF EXISTS s2g3_pause_booking ON "Booking"');
    await admin.query('DROP TRIGGER IF EXISTS s2g3_pause_ledger ON "LedgerEntry"');
    if (kind === 'booking') {
      await admin.query(`
        CREATE OR REPLACE FUNCTION s2g3_pause_booking() RETURNS trigger AS $fn$
        BEGIN
          IF NEW."manualCollectionState" IS DISTINCT FROM OLD."manualCollectionState" THEN
            PERFORM pg_sleep(3);
          END IF;
          RETURN NEW;
        END;
        $fn$ LANGUAGE plpgsql
      `);
      await admin.query(`
        CREATE TRIGGER s2g3_pause_booking
        BEFORE UPDATE ON "Booking"
        FOR EACH ROW EXECUTE FUNCTION s2g3_pause_booking()
      `);
    }
    if (kind === 'ledger') {
      await admin.query(`
        CREATE OR REPLACE FUNCTION s2g3_pause_ledger() RETURNS trigger AS $fn$
        BEGIN
          PERFORM pg_sleep(3);
          RETURN NEW;
        END;
        $fn$ LANGUAGE plpgsql
      `);
      await admin.query(`
        CREATE TRIGGER s2g3_pause_ledger
        BEFORE INSERT ON "LedgerEntry"
        FOR EACH ROW EXECUTE FUNCTION s2g3_pause_ledger()
      `);
    }
  }

  async function clearPause() {
    await admin.query('DROP TRIGGER IF EXISTS s2g3_pause_booking ON "Booking"');
    await admin.query('DROP TRIGGER IF EXISTS s2g3_pause_ledger ON "LedgerEntry"');
  }

  try {
    async function settlementWins(method, testName) {
      const id = nextId(method === 'cash' ? 'cash-wins' : 'card-wins');
      await seed(id);
      await installPause('ledger');
      const settlementPromise = settle(id, method);
      const sleeping = await waitFor(`
        SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event = 'PgSleep'
      `);
      const reservationPromise = reserve(id);
      const blocked = await waitFor(`
        SELECT pid, pg_blocking_pids(pid) AS blocked_by, wait_event_type, wait_event, left(query, 160) AS query
        FROM pg_stat_activity
        WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0
      `);
      const settled = await settlementPromise;
      const reserved = await reservationPromise;
      await clearPause();
      const after = await snapshot(id);
      const pass = sleeping.length > 0
        && blocked.length > 0
        && settled.ok === true
        && settled.created === true
        && settled.settledAmountCents === CENTS
        && reserved.ok === false
        && reserved.error === 'zero_remaining_balance'
        && after.booking.state == null
        && after.quote.status === 'settled'
        && after.ledger.length === 1
        && after.ledger[0].amountCents === CENTS;
      record({
        test: testName,
        pass,
        actual: {
          database: idRow.db,
          transactions: 2,
          waited: blocked.length > 0,
          retryInApplication: false,
          lock: blocked,
          settlement: { ok: settled.ok, created: settled.created, amount: settled.settledAmountCents, error: settled.error },
          reservation: { ok: reserved.ok, error: reserved.error, operationId: reserved.operationId },
          booking: after.booking,
          quote: after.quote,
          ledger: after.ledger,
        },
      });
    }

    async function reservationWins(method, testName) {
      const id = nextId(method === 'cash' ? 'reserve-wins' : 'reserve-card');
      await seed(id);
      await installPause('booking');
      const reservationPromise = reserve(id);
      const sleeping = await waitFor(`
        SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event = 'PgSleep'
      `);
      const settlementPromise = settle(id, method);
      const blocked = await waitFor(`
        SELECT pid, pg_blocking_pids(pid) AS blocked_by, wait_event_type, wait_event, left(query, 180) AS query
        FROM pg_stat_activity
        WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0
      `);
      const reserved = await reservationPromise;
      const settled = await settlementPromise;
      await clearPause();
      const after = await snapshot(id);
      const pass = sleeping.length > 0
        && blocked.length > 0
        && reserved.ok === true
        && reserved.created === true
        && settled.ok === false
        && settled.error === 'manual_collection_active'
        && after.booking.state === 'reserved'
        && after.ledger.length === 0
        && after.quote.status === 'approved';
      record({
        test: testName,
        pass,
        actual: {
          database: idRow.db,
          transactions: 2,
          waited: blocked.length > 0,
          retryVisible: settled.error === 'manual_collection_active',
          lock: blocked,
          reservation: { ok: reserved.ok, created: reserved.created, operationId: reserved.operationId, error: reserved.error },
          settlement: { ok: settled.ok, error: settled.error },
          booking: after.booking,
          quote: after.quote,
          ledger: after.ledger,
        },
      });
    }

    await settlementWins('cash', 'I1 cash settlement wins and reservation rereads the balance');
    await reservationWins('cash', 'I2 manual reservation wins against cash settlement');
    await settlementWins('card_on_site', 'I3 card settlement wins and reservation rereads the balance');
    await reservationWins('card_on_site', 'I4 manual reservation wins against card settlement');

    const concurrentId = nextId('two-res');
    await seed(concurrentId);
    await installPause('booking');
    const firstPromise = reserve(concurrentId);
    const sleeping = await waitFor(`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event = 'PgSleep'
    `);
    const secondPromise = reserve(concurrentId);
    const blocked = await waitFor(`
      SELECT pid, pg_blocking_pids(pid) AS blocked_by, wait_event_type
      FROM pg_stat_activity
      WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0
    `);
    const first = await firstPromise;
    const second = await secondPromise;
    await clearPause();
    const concurrentAfter = await snapshot(concurrentId);
    record({
      test: 'I5 concurrent reservations produce one operation',
      pass: sleeping.length > 0
        && blocked.length > 0
        && first.ok === true
        && second.ok === true
        && second.idempotent === true
        && second.operationId === first.operationId
        && concurrentAfter.booking.state === 'reserved'
        && concurrentAfter.booking.operation_id === first.operationId
        && concurrentAfter.ledger.length === 0,
      actual: {
        database: idRow.db,
        transactions: 2,
        waited: blocked.length > 0,
        firstError: first.error,
        secondError: second.error,
        secondIdempotent: second.idempotent,
        operationId: first.operationId,
        secondOperationId: second.operationId,
        booking: concurrentAfter.booking,
        quote: concurrentAfter.quote,
        ledger: concurrentAfter.ledger,
      },
    });

    const retryId = nextId('retry');
    await seed(retryId);
    const created = await reserve(retryId);
    const retried = await reserve(retryId);
    const retryAfter = await snapshot(retryId);
    record({
      test: 'I6 duplicate reservation retry is idempotent',
      pass: created.created === true
        && retried.idempotent === true
        && retried.operationId === created.operationId
        && retryAfter.booking.operation_id === created.operationId
        && retryAfter.ledger.length === 0,
      actual: {
        database: idRow.db,
        transactions: 2,
        waited: false,
        operationId: created.operationId,
        retryOperationId: retried.operationId,
        booking: retryAfter.booking,
        quote: retryAfter.quote,
        ledger: retryAfter.ledger,
      },
    });

    const ledgerOnlyId = nextId('ledger-only');
    await seed(ledgerOnlyId);
    const holder = new Client({ connectionString: url });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM "Booking" WHERE id = $1 FOR UPDATE', [ledgerOnlyId]);
    const ledgerWaiter = reserve(ledgerOnlyId);
    const ledgerBlocked = await waitFor(`
      SELECT pid, pg_blocking_pids(pid) AS blocked_by, wait_event_type, left(query, 140) AS query
      FROM pg_stat_activity
      WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0
    `);
    await holder.query(`
      INSERT INTO "LedgerEntry" (
        "id", "bookingId", "kind", "amountCents", "currency", "quoteVersion",
        "providerEventId", "occurredAt", "recordedAt", "actor"
      ) VALUES ($1, $2, 'settlement', $3, 'usd', 1, $4, now(), now(), 's2g3-ledger-only')
    `, [`${ledgerOnlyId}-ledger`, ledgerOnlyId, CENTS, `ledger-only-${ledgerOnlyId}`]);
    await holder.query('COMMIT');
    const ledgerReservation = await ledgerWaiter;
    await holder.end();
    const ledgerAfter = await snapshot(ledgerOnlyId);
    record({
      test: 'I7 ledger insert without a quote update does not leave a reservation',
      pass: ledgerBlocked.length > 0
        && ledgerReservation.error === 'zero_remaining_balance'
        && ledgerAfter.booking.state == null
        && ledgerAfter.quote.status === 'approved'
        && ledgerAfter.ledger.length === 1
        && ledgerAfter.ledger[0].amountCents === CENTS,
      actual: {
        database: idRow.db,
        transactions: 2,
        waited: ledgerBlocked.length > 0,
        legitimateApplicationWriter: false,
        reservation: { ok: ledgerReservation.ok, error: ledgerReservation.error, operationId: ledgerReservation.operationId },
        booking: ledgerAfter.booking,
        quote: ledgerAfter.quote,
        ledger: ledgerAfter.ledger,
      },
    });

    const quoteId = nextId('quote');
    await seed(quoteId);
    const quoteReserved = await reserve(quoteId);
    const adjustment = await authority.createAdjustment({
      bookingId: quoteId,
      newApprovedCents: 18000,
      reason: 'synthetic quote change during reservation',
      adjustmentId: 's2g3quotechange01',
      expectedQuoteVersion: 1,
      approvedBy: 's2g3-admin',
    });
    const quoteAfter = await snapshot(quoteId);
    record({
      test: 'I8 quote adjustment during an active reservation',
      pass: quoteReserved.ok === true
        && adjustment.ok === false
        && adjustment.error === 'manual_collection_active'
        && quoteAfter.booking.state === 'reserved'
        && quoteAfter.booking.operation_id === quoteReserved.operationId
        && quoteAfter.quote.quoteVersion === 1
        && quoteAfter.quote.approvedCents === CENTS
        && quoteAfter.ledger.length === 0,
      actual: {
        database: idRow.db,
        adjustmentOk: adjustment.ok,
        adjustmentError: adjustment.error,
        booking: quoteAfter.booking,
        quote: quoteAfter.quote,
        ledger: quoteAfter.ledger,
      },
    });

    const importId = nextId('blob-import');
    await seed(importId);
    await reserve(importId);
    const imported = await ensureBookingFinancial({
      ...blob(importId),
      ledger: { approvedCents: CENTS, settledCents: CENTS, currency: 'usd' },
    });
    const importAfter = await snapshot(importId);
    record({
      test: 'I9 blob financial import during an active reservation',
      pass: imported.seededSettlement === false
        && imported.importBlocked === 'manual_collection_active'
        && importAfter.booking.state === 'reserved'
        && importAfter.ledger.length === 0,
      actual: {
        database: idRow.db,
        seededSettlement: imported.seededSettlement,
        importBlocked: imported.importBlocked,
        booking: importAfter.booking,
        quote: importAfter.quote,
        ledger: importAfter.ledger,
        bypassesBookingLock: false,
      },
    });

    const rollbackId = nextId('rollback');
    await seed(rollbackId);
    await admin.query('BEGIN');
    await admin.query(`
      UPDATE "Booking"
      SET "manualCollectionState" = 'reserved',
          "manualCollectionOperationId" = 'rolled-back',
          "updatedAt" = now()
      WHERE id = $1
    `, [rollbackId]);
    await admin.query(`
      INSERT INTO "LedgerEntry" (
        "id", "bookingId", "kind", "amountCents", "currency", "quoteVersion",
        "providerEventId", "occurredAt", "recordedAt", "actor"
      ) VALUES ($1, $2, 'settlement', $3, 'usd', 1, $4, now(), now(), 's2g3-rollback')
    `, [`${rollbackId}-ghost`, rollbackId, CENTS, `ghost-${rollbackId}`]);
    await admin.query('ROLLBACK');
    const rolled = await snapshot(rollbackId);
    const afterRollback = await reserve(rollbackId);
    const rollbackAfter = await snapshot(rollbackId);
    record({
      test: 'I10 rollback leaves no reservation and no ledger entry',
      pass: rolled.booking.state == null
        && rolled.ledger.length === 0
        && afterRollback.ok === true
        && afterRollback.operationId !== 'rolled-back'
        && rollbackAfter.booking.state === 'reserved'
        && rollbackAfter.ledger.length === 0
        && rollbackAfter.quote.status === 'approved',
      actual: {
        database: idRow.db,
        booking: rollbackAfter.booking,
        quote: rollbackAfter.quote,
        ledger: rollbackAfter.ledger,
      },
    });

    const lostAckId = nextId('lost-ack');
    await seed(lostAckId);
    await admin.query(`
      UPDATE "Booking"
      SET "manualCollectionState" = 'reserved',
          "manualCollectionOperationId" = 'op-durable-ack',
          "manualCollectionQuoteVersion" = 1,
          "updatedAt" = now()
      WHERE id = $1
    `, [lostAckId]);
    const lostAck = await reserve(lostAckId);
    const lostAfter = await snapshot(lostAckId);
    record({
      test: 'I11 retry after a committed reservation returns the durable operation',
      pass: lostAck.ok === true
        && lostAck.idempotent === true
        && lostAck.operationId === 'op-durable-ack'
        && lostAfter.booking.operation_id === 'op-durable-ack'
        && lostAfter.ledger.length === 0,
      actual: {
        database: idRow.db,
        reservation: { ok: lostAck.ok, idempotent: lostAck.idempotent, operationId: lostAck.operationId, error: lostAck.error },
        booking: lostAfter.booking,
        quote: lostAfter.quote,
        ledger: lostAfter.ledger,
      },
    });

    record({
      test: 'I12 serialization retry bound',
      pass: null,
      actual: {
        database: idRow.db,
        isolation: 'ReadCommitted',
        realSerializationErrorObserved: false,
        evidence: 'provider-free retry tests',
        note: 'READ COMMITTED does not raise 40001 when this row wait ends. The bounded retry is not claimed from this database run.',
      },
    });
  } finally {
    await clearPause().catch(() => {});
    fs.writeFileSync('C:\\Projects\\Cardetail1\\tmp\\s2g3-results.json', JSON.stringify({ identity: idRow, results }, null, 2));
    const failed = results.filter((item) => item.pass === false).length;
    console.log(`RESULTS failed=${failed} recorded=${results.length}`);
    await admin.end();
    await prisma.$disconnect();
    if (failed) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
