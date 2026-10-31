'use strict';

/**
 * Real PostgreSQL checks for S2G.6. Synthetic verified events only.
 * Refuses every database except the disposable instance on port 54337.
 * Not part of npm test.
 */

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

if (process.env.S2G6_PRISMA_CLIENT) {
  const clientEntry = path.join(process.env.S2G6_PRISMA_CLIENT, 'index.js');
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
let providerCalls = 0;
const originalFetch = global.fetch;
global.fetch = async () => {
  providerCalls += 1;
  throw new Error('provider_call_forbidden');
};

function assertDisposable(url) {
  const parsed = new URL(url);
  if (
    parsed.hostname !== '127.0.0.1'
    || parsed.port !== '54337'
    || parsed.pathname !== '/cardetail1_s2g6_disposable'
    || parsed.username !== 's2g6_owner'
  ) {
    throw new Error('refusing connection: target is not the s2g6 disposable database');
  }
}

function record(result) {
  results.push(result);
  console.log(JSON.stringify({ test: result.test, pass: result.pass, actual: result.actual || undefined }));
}

async function main() {
  const url = String(process.env.DATABASE_URL || '');
  assertDisposable(url);
  delete process.env.SQUARE_ACCESS_TOKEN;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_LEGACY_REFUNDS_ENABLED;
  process.env.CD1_POSTGRES_PAYMENT = '1';
  process.env.MANUAL_SQUARE_COLLECTION_ENABLED = 'true';

  const admin = new Client({ connectionString: url });
  await admin.connect();
  const identity = await admin.query(`
    SELECT current_database() AS db, inet_server_addr()::text AS addr,
           inet_server_port() AS port, current_setting('data_directory') AS data_directory
  `);
  const idRow = identity.rows[0];
  if (idRow.db !== 'cardetail1_s2g6_disposable' || String(idRow.port) !== '54337' || !String(idRow.addr).startsWith('127.0.0.1')) {
    throw new Error('connected database failed the isolation check');
  }
  if (!String(idRow.data_directory).toLowerCase().includes('s2g6-disposable-pg')) {
    throw new Error('data directory is not the disposable cluster');
  }

  const prisma = getPrisma();
  let seq = 0;
  const nextId = (label) => {
    seq += 1;
    return `s2g6-${String(seq).padStart(2, '0')}-${label}`;
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

  async function addAttempt(id, status = 'open') {
    const piId = `pi_${id}`;
    await prisma.paymentAttempt.create({
      data: {
        id: `${id}-pa`,
        bookingId: id,
        quoteId: `${id}-q`,
        quoteVersion: 1,
        purpose: 'customer_balance',
        providerObjectType: 'payment_intent',
        providerObjectId: piId,
        status,
        amountCents: CENTS,
        currency: 'usd',
        idempotencyKey: `${id}-pay`,
      },
    });
    return piId;
  }

  async function addRefundRequest(id, piId) {
    const requestId = `${id}-rr`;
    await prisma.refundRequest.create({
      data: {
        id: requestId,
        bookingId: id,
        paymentAttemptId: `${id}-pa`,
        quoteVersion: 1,
        amountCents: CENTS,
        currency: 'usd',
        reason: 'synthetic confirmed refund',
        requestedBy: 's2g6-admin',
        status: 'pending_webhook',
        requestGroupKey: `${id}-group`,
        partIndex: 0,
        idempotencyKey: `${id}-refund`,
      },
    });
    return requestId;
  }

  function paymentIntent(id, piId) {
    return {
      id: piId,
      status: 'succeeded',
      amount: CENTS,
      amount_received: CENTS,
      currency: 'usd',
      metadata: {
        bookingId: id,
        booking_id: id,
        quoteVersion: '1',
        purpose: 'customer_balance',
      },
    };
  }

  function refundObject(id, requestId, piId) {
    return {
      id: `re_${id}`,
      status: 'succeeded',
      amount: CENTS,
      currency: 'usd',
      payment_intent: piId,
      metadata: {
        bookingId: id,
        booking_id: id,
        quoteVersion: '1',
        purpose: 'customer_refund',
        refundRequestId: requestId,
        refund_request_id: requestId,
      },
    };
  }

  function pay(id, piId, eventId = `evt_${id}`) {
    return authority.reconcilePaymentIntentEvent({
      stripeEventId: eventId,
      type: 'payment_intent.succeeded',
      paymentIntent: paymentIntent(id, piId),
    });
  }

  async function snapshot(id) {
    const booking = await admin.query(`
      SELECT "manualCollectionState" AS state,
             "manualCollectionOperationId" AS operation_id,
             "manualCollectionUrl" AS url,
             "manualCollectionDetail" AS detail
      FROM "Booking" WHERE id = $1
    `, [id]);
    const quote = await admin.query(`
      SELECT "quoteVersion", "approvedCents", status
      FROM "Quote" WHERE "bookingId" = $1 ORDER BY "quoteVersion" DESC LIMIT 1
    `, [id]);
    const ledger = await admin.query(`
      SELECT kind, "amountCents", "providerEventId", "providerObjectId", actor
      FROM "LedgerEntry" WHERE "bookingId" = $1 ORDER BY "recordedAt", id
    `, [id]);
    const detail = booking.rows[0] && booking.rows[0].detail && typeof booking.rows[0].detail === 'object'
      ? booking.rows[0].detail
      : {};
    return {
      booking: booking.rows[0] || null,
      quote: quote.rows[0] || null,
      ledger: ledger.rows,
      conflicts: Array.isArray(detail.externalFinancialConflicts) ? detail.externalFinancialConflicts : [],
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
      actorId: 's2g6-admin',
      env: process.env,
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
    await admin.query('DROP TRIGGER IF EXISTS s2g6_pause_booking ON "Booking"');
    await admin.query('DROP TRIGGER IF EXISTS s2g6_pause_ledger ON "LedgerEntry"');
    await admin.query('DROP TRIGGER IF EXISTS s2g6_reject_detail ON "Booking"');
  }

  async function installPause(kind) {
    await clearPause();
    if (kind === 'booking') {
      await admin.query(`
        CREATE OR REPLACE FUNCTION s2g6_pause_booking() RETURNS trigger AS $fn$
        BEGIN
          IF NEW."manualCollectionState" IS DISTINCT FROM OLD."manualCollectionState" THEN
            PERFORM pg_sleep(2);
          END IF;
          RETURN NEW;
        END $fn$ LANGUAGE plpgsql
      `);
      await admin.query(`
        CREATE TRIGGER s2g6_pause_booking BEFORE UPDATE ON "Booking"
        FOR EACH ROW EXECUTE FUNCTION s2g6_pause_booking()
      `);
    }
    if (kind === 'ledger') {
      await admin.query(`
        CREATE OR REPLACE FUNCTION s2g6_pause_ledger() RETURNS trigger AS $fn$
        BEGIN PERFORM pg_sleep(3); RETURN NEW; END $fn$ LANGUAGE plpgsql
      `);
      await admin.query(`
        CREATE TRIGGER s2g6_pause_ledger BEFORE INSERT ON "LedgerEntry"
        FOR EACH ROW EXECUTE FUNCTION s2g6_pause_ledger()
      `);
    }
    if (kind === 'reject-detail') {
      await admin.query(`
        CREATE OR REPLACE FUNCTION s2g6_reject_detail() RETURNS trigger AS $fn$
        BEGIN
          IF NEW."manualCollectionDetail"::text LIKE '%externalFinancialConflicts%'
             AND OLD."manualCollectionDetail"::text NOT LIKE '%externalFinancialConflicts%' THEN
            RAISE EXCEPTION 'synthetic_conflict_rollback';
          END IF;
          RETURN NEW;
        END $fn$ LANGUAGE plpgsql
      `);
      await admin.query(`
        CREATE TRIGGER s2g6_reject_detail BEFORE UPDATE ON "Booking"
        FOR EACH ROW EXECUTE FUNCTION s2g6_reject_detail()
      `);
    }
  }

  try {
    const plainId = nextId('plain');
    await seed(plainId);
    const plainPi = await addAttempt(plainId);
    const plainPaid = await pay(plainId, plainPi);
    const plainAfter = await snapshot(plainId);
    const plainProjection = await authority.getFinancialProjection(plainId);
    record({
      test: 'L1 Stripe payment without manual collection',
      pass: plainPaid.ok === true
        && plainPaid.ledger.created === true
        && plainAfter.booking.state == null
        && plainAfter.conflicts.length === 0
        && plainAfter.ledger.length === 1
        && plainAfter.ledger[0].kind === 'settlement'
        && plainAfter.ledger[0].amountCents === CENTS
        && plainAfter.quote.status === 'settled',
    });
    record({
      test: 'L14 financial projection matches the committed ledger',
      pass: plainProjection.settledCents === CENTS
        && plainProjection.remainingCents === 0
        && plainProjection.paymentStatus === 'paid'
        && plainProjection.approvedCents === CENTS,
    });

    const reservedId = nextId('reserved');
    await seed(reservedId);
    const reserved = await reserve(reservedId);
    const reservedPi = await addAttempt(reservedId);
    const reservedPaid = await pay(reservedId, reservedPi);
    const reservedAgain = await pay(reservedId, reservedPi);
    const reservedAfter = await snapshot(reservedId);
    const reservedView = await manual.readManualCollectionView(reservedId);
    record({
      test: 'L2 Stripe payment during an active reservation',
      pass: reserved.ok === true
        && reservedPaid.ok === true
        && reservedPaid.ledger.created === true
        && reservedPaid.manualCollectionConflict.recorded === true
        && reservedAfter.booking.state === 'reserved'
        && reservedAfter.booking.operation_id === reserved.operationId
        && reservedAfter.ledger.length === 1
        && reservedAfter.conflicts.length === 1
        && reservedAfter.conflicts[0].providerEventId === `settlement_${reservedPi}`
        && reservedAfter.conflicts[0].squareVerified === false,
    });
    record({
      test: 'L4 duplicate Stripe payment event',
      pass: reservedAgain.duplicate === true
        && reservedAfter.ledger.length === 1
        && reservedAfter.conflicts.length === 1,
    });
    record({
      test: 'L10 a repeated event checks the stored event identity',
      pass: reservedAgain.reason === 'event_already_processed'
        && reservedAfter.ledger.filter((entry) => entry.providerEventId === `settlement_${reservedPi}`).length === 1,
    });
    record({
      test: 'L15 conflict handling leaves the reservation in place',
      pass: reservedAfter.booking.state === 'reserved'
        && reservedView.state === 'reserved'
        && reservedView.paid === false
        && reservedView.providerVerified === false
        && reservedView.externalFinancialConflicts.length === 1
        && reservedView.externalFinancialConflicts[0].reviewRequired === true,
    });

    const recordedId = nextId('recorded');
    await seed(recordedId);
    const recordedReserve = await reserve(recordedId);
    await manual.recordManualCollectionUrl({
      bookingId: recordedId,
      operationId: recordedReserve.operationId,
      url: 'https://square.example/synthetic-s2g6',
      actorId: 's2g6-admin',
      env: process.env,
    });
    const recordedPi = await addAttempt(recordedId);
    const recordedPaid = await pay(recordedId, recordedPi);
    const recordedAfter = await snapshot(recordedId);
    record({
      test: 'L3 Stripe payment during a recorded manual URL',
      pass: recordedPaid.ok === true
        && recordedPaid.ledger.created === true
        && recordedAfter.booking.state === 'recorded'
        && recordedAfter.booking.url === 'https://square.example/synthetic-s2g6'
        && recordedAfter.booking.operation_id === recordedReserve.operationId
        && recordedAfter.conflicts.length === 1
        && recordedAfter.ledger.length === 1,
    });

    const refundId = nextId('refund');
    await seed(refundId);
    const refundReserve = await reserve(refundId);
    const refundPi = await addAttempt(refundId);
    await pay(refundId, refundPi);
    const requestId = await addRefundRequest(refundId, refundPi);
    const refundEventId = `evt_${refundId}_refund`;
    const refunded = await authority.reconcileRefundEvent({
      stripeEventId: refundEventId,
      type: 'refund.updated',
      refund: refundObject(refundId, requestId, refundPi),
    });
    const refundedAgain = await authority.reconcileRefundEvent({
      stripeEventId: refundEventId,
      type: 'refund.updated',
      refund: refundObject(refundId, requestId, refundPi),
    });
    const refundAfter = await snapshot(refundId);
    const refundProjection = await authority.getFinancialProjection(refundId);
    record({
      test: 'L5 Stripe refund during manual collection',
      pass: refunded.ok === true
        && refunded.ledger.created === true
        && refunded.manualCollectionConflict.recorded === true
        && refundAfter.booking.state === 'reserved'
        && refundAfter.booking.operation_id === refundReserve.operationId
        && refundAfter.ledger.filter((entry) => entry.kind === 'refund').length === 1
        && refundAfter.conflicts.filter((item) => item.kind === 'refund').length === 1
        && refundAfter.conflicts.every((item) => item.squareVerified === false),
    });
    record({
      test: 'L6 duplicate refund event',
      pass: refundedAgain.duplicate === true
        && refundAfter.ledger.filter((entry) => entry.kind === 'refund').length === 1
        && refundProjection.settledCents === 0
        && refundProjection.refundedCents === CENTS,
    });

    const overlapId = nextId('overlap');
    await seed(overlapId);
    await reserve(overlapId);
    const overlapPi = await addAttempt(overlapId);
    await installPause('ledger');
    const webhookPromise = pay(overlapId, overlapPi);
    const sleeping = await waitFor(`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event = 'PgSleep'
    `);
    const settlementPromise = authority.recordFullBalanceOnSiteSettlement({
      bookingId: overlapId,
      method: 'cash',
      body: { reason: 'synthetic s2g6 overlap' },
    });
    const blocked = await waitFor(`
      SELECT left(query, 160) AS query FROM pg_stat_activity
      WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0
    `);
    const webhookResult = await webhookPromise;
    const settlementResult = await settlementPromise;
    await clearPause();
    const overlapAfter = await snapshot(overlapId);
    record({
      test: 'L7 external payment and on-site settlement',
      pass: sleeping.length > 0
        && blocked.length > 0
        && webhookResult.ok === true
        && webhookResult.ledger.created === true
        && settlementResult.ok === false
        && settlementResult.error === 'manual_collection_active'
        && overlapAfter.booking.state === 'reserved'
        && overlapAfter.ledger.length === 1
        && overlapAfter.ledger[0].actor === 'stripe_webhook'
        && overlapAfter.conflicts.length === 1,
    });

    const raceId = nextId('race');
    await seed(raceId);
    const racePi = await addAttempt(raceId, 'expired');
    await installPause('booking');
    const reservePromise = reserve(raceId);
    const reserveSleep = await waitFor(`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event = 'PgSleep'
    `);
    const racePay = pay(raceId, racePi);
    const raceBlocked = await waitFor(`
      SELECT left(query, 180) AS query FROM pg_stat_activity
      WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0
    `);
    const raceReserved = await reservePromise;
    const racePaid = await racePay;
    await clearPause();
    const raceAfter = await snapshot(raceId);
    record({
      test: 'L8 external payment and manual reservation',
      pass: reserveSleep.length > 0
        && raceBlocked.length > 0
        && raceReserved.ok === true
        && racePaid.ok === true
        && racePaid.ledger.created === true
        && racePaid.manualCollectionConflict?.recorded === true
        && raceAfter.booking.state === 'reserved'
        && raceAfter.booking.operation_id === raceReserved.operationId
        && raceAfter.ledger.length === 1
        && raceAfter.conflicts.length === 1,
      actual: {
        slept: reserveSleep.length,
        blocked: raceBlocked,
        reserved: { ok: raceReserved.ok, error: raceReserved.error, operationId: raceReserved.operationId },
        paid: {
          ok: racePaid.ok,
          error: racePaid.error,
          duplicate: racePaid.duplicate,
          reason: racePaid.reason,
          ledgerCreated: racePaid.ledger && racePaid.ledger.created,
          conflict: racePaid.manualCollectionConflict || null,
        },
        booking: raceAfter.booking && {
          state: raceAfter.booking.state,
          operation_id: raceAfter.booking.operation_id,
        },
        ledger: raceAfter.ledger,
        conflicts: raceAfter.conflicts,
      },
    });

    const rollbackId = nextId('rollback');
    await seed(rollbackId);
    await reserve(rollbackId);
    const rollbackPi = await addAttempt(rollbackId);
    await installPause('reject-detail');
    let rollbackError = null;
    let rollbackResult = null;
    try {
      rollbackResult = await pay(rollbackId, rollbackPi);
    } catch (error) {
      rollbackError = error;
    }
    await clearPause();
    const rollbackAfter = await snapshot(rollbackId);
    record({
      test: 'L9 transaction rollback leaves no ledger or conflict',
      pass: (rollbackError != null || rollbackResult?.ok === false)
        && rollbackAfter.ledger.length === 0
        && rollbackAfter.conflicts.length === 0
        && rollbackAfter.booking.state === 'reserved'
        && rollbackAfter.quote.status === 'approved',
    });

    const importId = nextId('import');
    await seed(importId);
    await reserve(importId);
    const blockedImport = await ensureBookingFinancial(blob(importId, CENTS));
    const importPi = await addAttempt(importId);
    const importPaid = await pay(importId, importPi);
    const importAfter = await snapshot(importId);
    record({
      test: 'L12 a blocked Blob import does not suppress the verified payment',
      pass: blockedImport.ok === true
        && blockedImport.synchronizationBlocked === true
        && blockedImport.seededSettlement === false
        && importPaid.ok === true
        && importPaid.ledger.created === true
        && importAfter.ledger.length === 1
        && importAfter.ledger[0].actor === 'stripe_webhook'
        && importAfter.booking.state === 'reserved'
        && importAfter.conflicts.length === 1,
    });

    const requestIdBooking = nextId('request');
    await seed(requestIdBooking);
    await reserve(requestIdBooking);
    await addAttempt(requestIdBooking);
    const refundRequest = await authority.createRefund({
      bookingId: requestIdBooking,
      amountCents: CENTS,
      reason: 'synthetic request must not become a refund',
      requestKey: 's2g6request01',
      expectedQuoteVersion: 1,
      requestedBy: 's2g6-admin',
      env: process.env,
      fetchImpl: global.fetch,
    });
    const requestAfter = await snapshot(requestIdBooking);
    record({
      test: 'L13 an administrative refund request is not a completed refund',
      pass: refundRequest.ok === false
        && refundRequest.error === 'legacy_stripe_refunds_disabled'
        && refundRequest.stripeCalled === false
        && refundRequest.refunded === false
        && requestAfter.ledger.length === 0
        && requestAfter.booking.state === 'reserved'
        && requestAfter.conflicts.length === 0,
    });

    record({
      test: 'L16 no provider call was made',
      pass: providerCalls === 0,
    });
  } finally {
    await clearPause();
    global.fetch = originalFetch;
    await admin.end();
    const out = path.join('C:\\Projects\\Cardetail1\\tmp', 's2g6-results.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({
      failed: results.filter((item) => !item.pass).length,
      recorded: results.length,
      providerCalls,
      results,
    }, null, 2));
    if (prisma) await prisma.$disconnect();
  }

  const failed = results.filter((item) => !item.pass);
  if (failed.length || results.length !== 15) {
    console.error(JSON.stringify({ failed: failed.map((item) => item.test), recorded: results.length }));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
