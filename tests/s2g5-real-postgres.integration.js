'use strict';

/**
 * Real PostgreSQL checks for S2G.5. Refuses every database except the
 * disposable instance named on the command line via DATABASE_URL.
 * Not part of npm test.
 */

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

if (process.env.S2G5_PRISMA_CLIENT) {
  const clientEntry = path.join(process.env.S2G5_PRISMA_CLIENT, 'index.js');
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function resolveIsolatedClient(request, parent, isMain, options) {
    if (request === '@prisma/client') return clientEntry;
    return resolveFilename.call(this, request, parent, isMain, options);
  };
}

const { Client } = require('pg');
const manual = require('../netlify/lib/db/manual-collection');
const authority = require('../netlify/lib/db/payment-authority-service');

const CENTS = 15000;
const NEXT = 18000;
const results = [];

function assertDisposable(url) {
  const parsed = new URL(url);
  if (
    parsed.hostname !== '127.0.0.1'
    || parsed.port !== '54335'
    || parsed.pathname !== '/cardetail1_s2g5_disposable'
    || parsed.username !== 's2g5_owner'
  ) {
    throw new Error('refusing connection: target is not the s2g5 disposable database');
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
  process.env.MANUAL_SQUARE_COLLECTION_ENABLED = 'true';

  const admin = new Client({ connectionString: url });
  await admin.connect();
  const identity = await admin.query(`
    SELECT current_database() AS db, inet_server_addr()::text AS addr,
           inet_server_port() AS port, current_user AS usr,
           current_setting('data_directory') AS data_directory
  `);
  const idRow = identity.rows[0];
  if (idRow.db !== 'cardetail1_s2g5_disposable' || String(idRow.port) !== '54335' || !String(idRow.addr).startsWith('127.0.0.1')) {
    throw new Error('connected database failed the isolation check');
  }
  if (!String(idRow.data_directory).toLowerCase().includes('s2g5-disposable-pg')) {
    throw new Error('data directory is not the disposable cluster');
  }

  let seq = 0;
  const nextId = (label) => {
    seq += 1;
    return `s2g5-${String(seq).padStart(2, '0')}-${label}`;
  };
  let adjustmentSeq = 0;
  const adjustmentKey = () => {
    adjustmentSeq += 1;
    return `s2g5adj${String(adjustmentSeq).padStart(4, '0')}`;
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
             "manualCollectionQuoteVersion" AS collection_quote_version
      FROM "Booking" WHERE id = $1
    `, [id]);
    const quotes = await admin.query(`
      SELECT "quoteVersion", "approvedCents", status
      FROM "Quote" WHERE "bookingId" = $1
      ORDER BY "quoteVersion"
    `, [id]);
    const ledger = await admin.query(`
      SELECT kind, "amountCents" FROM "LedgerEntry" WHERE "bookingId" = $1
    `, [id]);
    const audits = await admin.query(`
      SELECT action FROM "AuditEvent" WHERE "bookingId" = $1 AND action = 'quote_adjustment_approved'
    `, [id]);
    return {
      booking: booking.rows[0] || null,
      quotes,
      ledger: ledger.rows,
      adjustmentAudits: audits.rows.length,
    };
  }

  function blob(id) {
    return {
      id,
      isDraft: false,
      status: 'confirmed',
      schemaVersion: 1,
      bookingVersion: 1,
      quoteVersion: 1,
      ledger: { approvedCents: CENTS, settledCents: 0, currency: 'usd' },
    };
  }

  function reserve(id) {
    return manual.reserveManualCollection({
      bookingId: id,
      booking: blob(id),
      actorId: 's2g5-admin',
      env: process.env,
    });
  }

  function settle(id, method) {
    return authority.recordFullBalanceOnSiteSettlement({
      bookingId: id,
      method,
      body: {
        reason: 'synthetic s2g5 validation',
        ...(method === 'card_on_site' ? { reference: 'SYN-5' } : {}),
      },
    });
  }

  function adjust(id, cents = NEXT, expectedQuoteVersion = 1, key = adjustmentKey()) {
    return authority.createAdjustment({
      bookingId: id,
      newApprovedCents: cents,
      reason: 'synthetic s2g5 adjustment',
      adjustmentId: key,
      expectedQuoteVersion,
      approvedBy: 's2g5-admin',
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

  async function clearPause() {
    await admin.query('DROP TRIGGER IF EXISTS s2g5_pause_booking ON "Booking"');
    await admin.query('DROP TRIGGER IF EXISTS s2g5_pause_quote ON "Quote"');
    await admin.query('DROP TRIGGER IF EXISTS s2g5_pause_ledger ON "LedgerEntry"');
    await admin.query('DROP TRIGGER IF EXISTS s2g5_reject_quote ON "Quote"');
  }

  async function installPause(kind) {
    await clearPause();
    if (kind === 'booking') {
      await admin.query(`
        CREATE OR REPLACE FUNCTION s2g5_pause_booking() RETURNS trigger AS $fn$
        BEGIN
          IF NEW."manualCollectionState" IS DISTINCT FROM OLD."manualCollectionState" THEN
            PERFORM pg_sleep(3);
          END IF;
          RETURN NEW;
        END;
        $fn$ LANGUAGE plpgsql
      `);
      await admin.query(`
        CREATE TRIGGER s2g5_pause_booking
        BEFORE UPDATE ON "Booking"
        FOR EACH ROW EXECUTE FUNCTION s2g5_pause_booking()
      `);
    }
    if (kind === 'quote') {
      await admin.query(`
        CREATE OR REPLACE FUNCTION s2g5_pause_quote() RETURNS trigger AS $fn$
        BEGIN
          IF NEW."quoteVersion" > 1 THEN
            PERFORM pg_sleep(3);
          END IF;
          RETURN NEW;
        END;
        $fn$ LANGUAGE plpgsql
      `);
      await admin.query(`
        CREATE TRIGGER s2g5_pause_quote
        BEFORE INSERT ON "Quote"
        FOR EACH ROW EXECUTE FUNCTION s2g5_pause_quote()
      `);
    }
    if (kind === 'ledger') {
      await admin.query(`
        CREATE OR REPLACE FUNCTION s2g5_pause_ledger() RETURNS trigger AS $fn$
        BEGIN
          PERFORM pg_sleep(3);
          RETURN NEW;
        END;
        $fn$ LANGUAGE plpgsql
      `);
      await admin.query(`
        CREATE TRIGGER s2g5_pause_ledger
        BEFORE INSERT ON "LedgerEntry"
        FOR EACH ROW EXECUTE FUNCTION s2g5_pause_ledger()
      `);
    }
    if (kind === 'reject-quote') {
      await admin.query(`
        CREATE OR REPLACE FUNCTION s2g5_reject_quote() RETURNS trigger AS $fn$
        BEGIN
          IF NEW."quoteVersion" > 1 THEN
            RAISE EXCEPTION 'synthetic_adjustment_rollback';
          END IF;
          RETURN NEW;
        END;
        $fn$ LANGUAGE plpgsql
      `);
      await admin.query(`
        CREATE TRIGGER s2g5_reject_quote
        BEFORE INSERT ON "Quote"
        FOR EACH ROW EXECUTE FUNCTION s2g5_reject_quote()
      `);
    }
  }

  try {
    const reserveWinsId = nextId('reserve-wins');
    await seed(reserveWinsId);
    await installPause('booking');
    const reservePromise = reserve(reserveWinsId);
    const reserveSleep = await waitFor(`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event = 'PgSleep'
    `);
    const adjustmentPromise = adjust(reserveWinsId);
    const adjustmentWait = await waitFor(`
      SELECT pid, pg_blocking_pids(pid) AS blocked_by, wait_event, left(query, 180) AS query
      FROM pg_stat_activity
      WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0
    `);
    const reserved = await reservePromise;
    const adjusted = await adjustmentPromise;
    await clearPause();
    const reserveWinsAfter = await snapshot(reserveWinsId);
    const latestReserved = reserveWinsAfter.quotes.rows.at(-1);
    const reservationWon = reserveSleep.length > 0
      && adjustmentWait.length > 0
      && reserved.ok === true
      && adjusted.ok === false
      && adjusted.error === 'manual_collection_active'
      && reserveWinsAfter.booking.state === 'reserved'
      && reserveWinsAfter.booking.operation_id === reserved.operationId
      && latestReserved.quoteVersion === 1
      && latestReserved.approvedCents === CENTS
      && reserveWinsAfter.quotes.rows.length === 1
      && reserveWinsAfter.ledger.length === 0
      && reserveWinsAfter.adjustmentAudits === 0;
    record({
      test: '1 reservation wins against adjustment',
      pass: reservationWon,
      actual: {
        waited: adjustmentWait,
        reservation: { ok: reserved.ok, operationId: reserved.operationId },
        adjustment: { ok: adjusted.ok, error: adjusted.error },
        booking: reserveWinsAfter.booking,
        quote: latestReserved,
      },
    });
    record({
      test: '8 approved amount unchanged after rejection',
      pass: reservationWon && latestReserved.approvedCents === CENTS,
    });
    record({
      test: '9 quote version unchanged after rejection',
      pass: reservationWon && latestReserved.quoteVersion === 1,
    });
    record({
      test: '10 manual collection identity survives rejection',
      pass: reservationWon && reserveWinsAfter.booking.operation_id === reserved.operationId,
    });

    const adjustWinsId = nextId('adjust-wins');
    await seed(adjustWinsId);
    await installPause('quote');
    const winningAdjustment = adjust(adjustWinsId);
    const adjustSleep = await waitFor(`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event = 'PgSleep'
    `);
    const waitingReserve = reserve(adjustWinsId);
    const reserveWait = await waitFor(`
      SELECT pid, pg_blocking_pids(pid) AS blocked_by, wait_event, left(query, 180) AS query
      FROM pg_stat_activity
      WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0
    `);
    const winner = await winningAdjustment;
    const reservedAfter = await waitingReserve;
    await clearPause();
    const adjustWinsAfter = await snapshot(adjustWinsId);
    const latestAdjusted = adjustWinsAfter.quotes.rows.at(-1);
    record({
      test: '2 adjustment wins against reservation',
      pass: adjustSleep.length > 0
        && reserveWait.length > 0
        && winner.ok === true
        && winner.created === true
        && reservedAfter.ok === true
        && adjustWinsAfter.booking.state === 'reserved'
        && adjustWinsAfter.booking.collection_quote_version === 2
        && latestAdjusted.quoteVersion === 2
        && latestAdjusted.approvedCents === NEXT
        && adjustWinsAfter.ledger.length === 0,
      actual: {
        waited: reserveWait,
        adjustment: { ok: winner.ok, created: winner.created, error: winner.error },
        reservation: {
          ok: reservedAfter.ok,
          error: reservedAfter.error,
          quoteVersion: reservedAfter.manualCollection && reservedAfter.manualCollection.quoteVersion,
        },
        booking: adjustWinsAfter.booking,
        quote: latestAdjusted,
      },
    });

    async function blockedState(state, error, testName) {
      const id = nextId(state);
      await seed(id);
      await admin.query(`UPDATE "Booking" SET "manualCollectionState" = $2, "manualCollectionOperationId" = $3 WHERE id = $1`, [
        id,
        state,
        `op-${state}`,
      ]);
      const result = await adjust(id);
      const after = await snapshot(id);
      const quote = after.quotes.rows.at(-1);
      record({
        test: testName,
        pass: result.ok === false
          && result.error === error
          && after.booking.state === state
          && after.booking.operation_id === `op-${state}`
          && quote.quoteVersion === 1
          && quote.approvedCents === CENTS
          && after.quotes.rows.length === 1
          && after.adjustmentAudits === 0,
      });
    }

    await blockedState('recorded', 'manual_collection_active', '3 recorded URL blocks adjustment');
    await blockedState('payment_reported', 'manual_collection_active', '4 payment_reported blocks adjustment');

    await admin.query('ALTER TABLE "Booking" DROP CONSTRAINT IF EXISTS "Booking_manual_collection_state"');
    await blockedState('not_a_known_state', 'manual_collection_unknown', '5 unknown manual state fails closed');

    const closedId = nextId('closed');
    await seed(closedId);
    await admin.query(`UPDATE "Booking" SET "manualCollectionState" = 'closed' WHERE id = $1`, [closedId]);
    const closedAdjustment = await adjust(closedId);
    const closedAfter = await snapshot(closedId);
    const closedQuote = closedAfter.quotes.rows.at(-1);
    record({
      test: '6 closed collection permits a valid adjustment',
      pass: closedAdjustment.ok === true
        && closedAdjustment.created === true
        && closedAfter.booking.state === 'closed'
        && closedQuote.quoteVersion === 2
        && closedQuote.approvedCents === NEXT
        && closedAfter.ledger.length === 0,
    });

    const openId = nextId('open');
    await seed(openId);
    const openAdjustment = await adjust(openId);
    const openAfter = await snapshot(openId);
    const openQuote = openAfter.quotes.rows.at(-1);
    const openProjection = await authority.getFinancialProjection(openId);
    const rejectedProjection = await authority.getFinancialProjection(reserveWinsId);
    record({
      test: '7 no collection permits the existing adjustment',
      pass: openAdjustment.ok === true
        && openAdjustment.created === true
        && openAfter.booking.state == null
        && openQuote.quoteVersion === 2
        && openQuote.approvedCents === NEXT,
    });
    record({
      test: '13 financial projection agrees with the committed quote',
      pass: openProjection.quoteVersion === 2
        && openProjection.approvedCents === NEXT
        && openProjection.settledCents === 0
        && rejectedProjection.quoteVersion === 1
        && rejectedProjection.approvedCents === CENTS
        && rejectedProjection.paymentStatus !== 'paid',
    });

    const raceId = nextId('race');
    await seed(raceId);
    const sharedKey = adjustmentKey();
    await installPause('quote');
    const left = adjust(raceId, NEXT, 1, sharedKey);
    const right = adjust(raceId, NEXT, 1, sharedKey);
    const raceSleep = await waitFor(`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event = 'PgSleep'
    `);
    const raceBlocked = await waitFor(`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0
    `);
    const raced = await Promise.allSettled([left, right]);
    await clearPause();
    const raceAfter = await snapshot(raceId);
    const raceQuote = raceAfter.quotes.rows.at(-1);
    const fulfilled = raced.filter((item) => item.status === 'fulfilled').map((item) => item.value);
    record({
      test: '11 concurrent adjustment retries do not duplicate the quote',
      pass: raceSleep.length > 0
        && raceBlocked.length > 0
        && raced.every((item) => item.status === 'fulfilled')
        && raceAfter.quotes.rows.length === 2
        && raceQuote.quoteVersion === 2
        && raceQuote.approvedCents === NEXT
        && raceAfter.adjustmentAudits === 1
        && fulfilled.filter((item) => item.created === true).length === 1
        && fulfilled.every((item) => item.ok === true || item.error === 'version_conflict' || item.idempotent === true),
    });

    const rollbackId = nextId('rollback');
    await seed(rollbackId);
    await installPause('reject-quote');
    let rolledError = null;
    try {
      await adjust(rollbackId);
    } catch (error) {
      rolledError = error;
    }
    await clearPause();
    const rollbackAfter = await snapshot(rollbackId);
    const rollbackQuote = rollbackAfter.quotes.rows.at(-1);
    record({
      test: '12 transaction rollback preserves the original quote',
      pass: rolledError != null
        && rollbackAfter.quotes.rows.length === 1
        && rollbackQuote.quoteVersion === 1
        && rollbackQuote.approvedCents === CENTS
        && rollbackQuote.status === 'approved'
        && rollbackAfter.adjustmentAudits === 0
        && rollbackAfter.booking.state == null,
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
          && after.quotes.rows.at(-1).status === 'settled',
      });
    }

    async function reservationWinsSettlement(method, testName) {
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
          && after.quotes.rows.at(-1).status === 'approved'
          && after.quotes.rows.at(-1).approvedCents === CENTS,
      });
    }

    await settlementWins('cash', '14 cash settlement still excludes an in-flight reservation');
    await reservationWinsSettlement('cash', '14 an active reservation still excludes cash settlement');
    await settlementWins('card_on_site', '14 card settlement still excludes an in-flight reservation');
    await reservationWinsSettlement('card_on_site', '14 an active reservation still excludes card settlement');
  } finally {
    await clearPause();
    await admin.end();
    const out = path.join('C:\\Projects\\Cardetail1\\tmp', 's2g5-results.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({
      failed: results.filter((item) => !item.pass).length,
      recorded: results.length,
      results,
    }, null, 2));
    const prisma = authority && require('../netlify/lib/prisma').getPrisma();
    if (prisma) await prisma.$disconnect();
  }

  const failed = results.filter((item) => !item.pass);
  if (failed.length || results.length !== 17) {
    console.error(JSON.stringify({ failed: failed.map((item) => item.test), recorded: results.length }));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
