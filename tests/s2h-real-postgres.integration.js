'use strict';

/**
 * Combined S2H checks on disposable PostgreSQL 16.
 * Synthetic bookings only. Refuses every database except 127.0.0.1:54339.
 * Not part of npm test.
 */

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

if (process.env.S2H_PRISMA_CLIENT) {
  const clientEntry = path.join(process.env.S2H_PRISMA_CLIENT, 'index.js');
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
    || parsed.port !== '54339'
    || parsed.pathname !== '/cardetail1_s2h_disposable'
    || parsed.username !== 's2h_owner'
  ) {
    throw new Error('refusing connection: target is not the s2h disposable database');
  }
}

function record(result) {
  results.push(result);
  console.log(JSON.stringify({ test: result.test, pass: result.pass }));
}

const ENABLED = {
  CD1_POSTGRES_PAYMENT: '1',
  DATABASE_URL: process.env.DATABASE_URL,
  MANUAL_SQUARE_COLLECTION_ENABLED: 'true',
};

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
  if (idRow.db !== 'cardetail1_s2h_disposable' || String(idRow.port) !== '54339' || !String(idRow.addr).startsWith('127.0.0.1')) {
    throw new Error('connected database failed the isolation check');
  }
  if (!String(idRow.data_directory).toLowerCase().includes('s2h-disposable-pg')) {
    throw new Error('data directory is not the disposable cluster');
  }

  const prisma = getPrisma();
  let seq = 0;
  const nextId = (label) => {
    seq += 1;
    return `s2h-${String(seq).padStart(2, '0')}-${label}`;
  };

  async function seed(id) {
    await admin.query(`
      INSERT INTO "Booking" ("id", "status", "isDraft", "createdAt", "updatedAt")
      VALUES ($1, 'confirmed', false, now(), now())
    `, [id]);
    await admin.query(`
      INSERT INTO "Quote" ("id", "bookingId", "quoteVersion", "approvedCents", "currency", "status", "createdAt", "updatedAt")
      VALUES ($1, $2, 1, $3, 'usd', 'approved', now(), now())
    `, [`${id}-q`, id, CENTS]);
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

  function reserve(id, env = process.env) {
    return manual.reserveManualCollection({
      bookingId: id,
      booking: blob(id),
      actorId: 's2h-admin',
      env,
    });
  }

  function recordUrl(id, operationId, url = 'https://square.example/synthetic-s2h') {
    return manual.recordManualCollectionUrl({
      bookingId: id,
      operationId,
      url,
      actorId: 's2h-admin',
      env: process.env,
    });
  }

  async function addAttempt(id) {
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
        status: 'open',
        amountCents: CENTS,
        currency: 'usd',
        idempotencyKey: `${id}-pay`,
        updatedAt: new Date(Date.now() - 10 * 60 * 1000),
      },
    });
    await admin.query(`
      UPDATE "PaymentAttempt" SET "updatedAt" = now() - interval '10 minutes' WHERE id = $1
    `, [`${id}-pa`]);
    return piId;
  }

  function stripeFixture(piId) {
    return async () => ({
      ok: true,
      json: async () => ({
        id: piId,
        status: 'succeeded',
        amount: CENTS,
        amount_received: CENTS,
        currency: 'usd',
      }),
    });
  }

  function reconcile(id, piId) {
    return authority.reconcileStalePaymentAttempts({
      bookingId: id,
      env: {
        STRIPE_SECRET_KEY: 'sk_test_synthetic_not_a_real_key',
        CD1_FORCE_LOCAL_STRIPE_GUARD: '1',
      },
      fetchImpl: stripeFixture(piId),
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
      SELECT "quoteVersion", "approvedCents", status FROM "Quote"
      WHERE "bookingId" = $1 ORDER BY "quoteVersion" DESC LIMIT 1
    `, [id]);
    const ledger = await admin.query(`
      SELECT kind, "amountCents", "providerEventId", "providerObjectId", actor, currency
      FROM "LedgerEntry" WHERE "bookingId" = $1 ORDER BY "recordedAt", id
    `, [id]);
    const detail = booking.rows[0] && booking.rows[0].detail && typeof booking.rows[0].detail === 'object'
      ? booking.rows[0].detail : {};
    return { booking: booking.rows[0] || null, quote: quote.rows[0] || null, ledger: ledger.rows, detail };
  }

  async function prepared(id) {
    await seed(id);
    const reserved = await reserve(id);
    const recorded = await recordUrl(id, reserved.operationId);
    return { reserved, recorded };
  }

  function receipt(id, operationId, extra = {}) {
    return authority.recordAdministratorSquareReceipt({
      bookingId: id,
      actorId: 's2h-admin',
      operationId,
      squareTransactionRef: extra.squareTransactionRef || `sq_${id}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40),
      amountCents: Object.prototype.hasOwnProperty.call(extra, 'amountCents') ? extra.amountCents : CENTS,
      currency: extra.currency || 'usd',
      dashboardObserved: extra.dashboardObserved !== false,
      now: '2026-10-30T22:00:00.000Z',
      prisma: extra.prisma,
    });
  }

  try {
    const columns = await admin.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'Booking'
        AND column_name IN (
          'manualCollectionState', 'manualCollectionOperationId',
          'manualCollectionQuoteVersion', 'manualCollectionUrl', 'manualCollectionDetail'
        )
    `);
    const constraint = await admin.query(`
      SELECT convalidated FROM pg_constraint WHERE conname = 'Booking_manual_collection_state'
    `);
    const migrationId = nextId('migration');
    await seed(migrationId);
    let invalidRejected = false;
    try {
      await admin.query('BEGIN');
      await admin.query(`UPDATE "Booking" SET "manualCollectionState" = 'not_a_known_state' WHERE id = $1`, [migrationId]);
      await admin.query('COMMIT');
    } catch (error) {
      invalidRejected = /check constraint/i.test(String(error.message));
      await admin.query('ROLLBACK');
    }
    const afterInvalid = await snapshot(migrationId);
    record({
      test: '21 migration columns and check reject an unknown state',
      pass: columns.rows.length === 5
        && constraint.rows.length === 1
        && invalidRejected
        && afterInvalid.booking.state == null,
    });

    const cashId = nextId('cash');
    const cashReserved = await prepared(cashId);
    const cash = await authority.recordFullBalanceOnSiteSettlement({
      bookingId: cashId, method: 'cash', body: { reason: 'synthetic s2h cash' },
    });
    const cashAfter = await snapshot(cashId);
    record({
      test: '1 manual collection blocks cash settlement',
      pass: cashReserved.recorded.ok === true
        && cash.ok === false
        && cash.error === 'manual_collection_active'
        && cashAfter.ledger.length === 0
        && cashAfter.booking.state === 'recorded',
    });

    const cardId = nextId('card');
    await prepared(cardId);
    const card = await authority.recordFullBalanceOnSiteSettlement({
      bookingId: cardId, method: 'card_on_site', body: { reason: 'synthetic s2h card', reference: 'terminal-1' },
    });
    const cardAfter = await snapshot(cardId);
    record({
      test: '2 manual collection blocks card-on-site settlement',
      pass: card.ok === false
        && card.error === 'manual_collection_active'
        && cardAfter.ledger.length === 0
        && !cardAfter.ledger.some((entry) => entry.providerObjectId === 'card_on_site'),
    });

    const importId = nextId('import');
    await reserve(importId);
    const blockedImport = await ensureBookingFinancial(blob(importId, CENTS));
    const importAfter = await snapshot(importId);
    record({
      test: '3 manual collection blocks Blob settlement import',
      pass: blockedImport.ok === true
        && blockedImport.synchronizationBlocked === true
        && blockedImport.seededSettlement === false
        && importAfter.ledger.length === 0
        && importAfter.booking.state === 'reserved',
    });

    const quoteId = nextId('quote');
    await reserve(quoteId);
    const blockedAdjustment = await authority.createAdjustment({
      bookingId: quoteId,
      newApprovedCents: 18000,
      reason: 'synthetic blocked adjustment',
      adjustmentId: 's2hquoteblock',
      expectedQuoteVersion: 1,
      approvedBy: 's2h-admin',
    });
    const quoteAfter = await snapshot(quoteId);
    record({
      test: '4 manual collection blocks quote adjustment',
      pass: blockedAdjustment.ok === false
        && blockedAdjustment.error === 'manual_collection_active'
        && quoteAfter.quote.quoteVersion === 1
        && quoteAfter.quote.approvedCents === CENTS
        && quoteAfter.quote.status === 'approved',
    });

    const reconcileId = nextId('reconcile');
    const reconcileReserve = await prepared(reconcileId);
    const piId = await addAttempt(reconcileId);
    const reconciled = await reconcile(reconcileId, piId);
    const reconciledAgain = await reconcile(reconcileId, piId);
    const reconcileAfter = await snapshot(reconcileId);
    const webhook = await authority.reconcilePaymentIntentEvent({
      stripeEventId: `evt_${reconcileId}`,
      type: 'payment_intent.succeeded',
      paymentIntent: {
        id: piId,
        status: 'succeeded',
        amount: CENTS,
        amount_received: CENTS,
        currency: 'usd',
        metadata: {
          bookingId: reconcileId,
          booking_id: reconcileId,
          quoteVersion: '1',
          purpose: 'customer_balance',
        },
      },
    });
    const webhookAfter = await snapshot(reconcileId);
    record({
      test: '5 Stripe reconciliation during manual collection records one conflict',
      pass: reconciled.closed === 1
        && reconcileAfter.ledger.length === 1
        && reconcileAfter.ledger[0].providerEventId === `settlement_${piId}`
        && reconcileAfter.ledger[0].actor === 'stripe_reconcile'
        && reconcileAfter.booking.state === 'recorded'
        && reconcileAfter.booking.url === 'https://square.example/synthetic-s2h'
        && reconcileAfter.booking.operation_id === reconcileReserve.reserved.operationId
        && reconcileAfter.detail.externalFinancialConflicts.length === 1
        && reconcileAfter.detail.externalFinancialConflicts[0].squareVerified === false,
    });
    record({
      test: '6 duplicate Stripe reconciliation does not add a second ledger',
      pass: reconciledAgain.closed === 0
        && webhookAfter.ledger.filter((entry) => entry.providerEventId === `settlement_${piId}`).length === 1,
    });
    record({
      test: '7 webhook after reconciliation keeps one ledger and one conflict',
      pass: webhook.ok === true
        && webhook.duplicate === true
        && webhookAfter.detail.externalFinancialConflicts.length === 1
        && webhookAfter.booking.state === 'recorded',
    });

    const conflictReceipt = await receipt(reconcileId, reconcileReserve.reserved.operationId, {
      squareTransactionRef: 'sq_overlap_1001',
    });
    const conflictAfter = await snapshot(reconcileId);
    record({
      test: '13 a Square receipt is review-required while a Stripe conflict exists',
      pass: conflictReceipt.ok === false
        && conflictReceipt.error === 'square_receipt_review_required'
        && conflictReceipt.squareVerified === false
        && conflictAfter.ledger.every((entry) => entry.actor !== 's2h-admin'),
    });

    const squareId = nextId('square');
    const squarePrepared = await prepared(squareId);
    const squareRef = 'sq_txn_s2h_1001';
    const squarePaid = await receipt(squareId, squarePrepared.reserved.operationId, {
      squareTransactionRef: squareRef,
    });
    const squareAgain = await receipt(squareId, squarePrepared.reserved.operationId, {
      squareTransactionRef: squareRef,
    });
    const squareAfter = await snapshot(squareId);
    const squareView = await manual.readManualCollectionView(squareId);
    record({
      test: '8 administrator Square receipt during active collection',
      pass: squarePaid.ok === true
        && squarePaid.ledgerEntryCreated === true
        && squarePaid.providerVerified === false
        && squarePaid.squareVerified === false
        && squareAfter.booking.state === 'payment_reported'
        && squareAfter.booking.operation_id === squarePrepared.reserved.operationId
        && squareAfter.booking.url === 'https://square.example/synthetic-s2h'
        && squareAfter.ledger.length === 1
        && squareAfter.ledger[0].providerEventId === `square_dashboard_receipt:${squareRef}`
        && squareAfter.ledger[0].kind === 'settlement'
        && squareAfter.ledger[0].actor === 's2h-admin'
        && squareView.squareDashboardReceipt.verificationMethod === 'administrator_square_dashboard'
        && squareView.squareDashboardReceipt.squareVerified === false
        && squareView.paid === false,
    });
    record({
      test: '9 duplicate Square receipt does not credit twice',
      pass: squareAgain.ok === true
        && squareAgain.idempotent === true
        && squareAgain.ledgerEntryCreated === false
        && squareAfter.ledger.length === 1,
    });

    const otherId = nextId('other');
    const otherPrepared = await prepared(otherId);
    const otherReceipt = await receipt(otherId, otherPrepared.reserved.operationId, {
      squareTransactionRef: squareRef,
    });
    const otherAfter = await snapshot(otherId);
    record({
      test: '10 the same Square reference cannot credit a second booking',
      pass: otherReceipt.ok === false
        && otherReceipt.error === 'square_reference_conflict'
        && otherAfter.ledger.length === 0
        && otherAfter.booking.state === 'recorded',
    });

    const amountId = nextId('amount');
    const amountPrepared = await prepared(amountId);
    const badAmount = await receipt(amountId, amountPrepared.reserved.operationId, {
      squareTransactionRef: 'sq_bad_amount',
      amountCents: 14000,
    });
    const amountAfter = await snapshot(amountId);
    record({
      test: '11 an inconsistent receipt amount is refused',
      pass: badAmount.error === 'square_receipt_amount_mismatch'
        && amountAfter.ledger.length === 0
        && amountAfter.booking.state === 'recorded',
    });

    const currencyId = nextId('currency');
    const currencyPrepared = await prepared(currencyId);
    const badCurrency = await receipt(currencyId, currencyPrepared.reserved.operationId, {
      squareTransactionRef: 'sq_bad_currency',
      currency: 'eur',
    });
    const currencyAfter = await snapshot(currencyId);
    record({
      test: '12 an inconsistent receipt currency is refused',
      pass: badCurrency.error === 'square_receipt_currency_mismatch'
        && currencyAfter.ledger.length === 0,
    });

    const closed = await manual.closeManualCollection({
      bookingId: squareId,
      actorId: 's2h-admin',
      operationId: squarePrepared.reserved.operationId,
      outcome: 'receipt_reconciled',
      reason: 'Dashboard receipt matches the ledger and the link was deactivated by hand',
      confirmation: {
        ledgerRecorded: true,
        dashboardReceiptMatches: true,
        linkDeactivated: true,
        responsibilityAccepted: true,
      },
      env: process.env,
    });
    const closedAfter = await snapshot(squareId);
    const closedSettlement = await authority.recordFullBalanceOnSiteSettlement({
      bookingId: squareId, method: 'cash', body: { reason: 'after reconciled closure' },
    });
    record({
      test: '14 closure after a recorded receipt releases only when the ledger is consistent',
      pass: closed.ok === true
        && closedAfter.booking.state === 'closed'
        && closedAfter.booking.url === 'https://square.example/synthetic-s2h'
        && closedAfter.detail.outcome === 'receipt_reconciled'
        && closedAfter.detail.squareVerified !== true
        && closedAfter.ledger.length === 1
        && closedSettlement.ok === false
        && closedSettlement.error !== 'manual_collection_active',
    });

    const attestId = nextId('attest');
    const attestPrepared = await prepared(attestId);
    const attested = await manual.closeManualCollection({
      bookingId: attestId,
      actorId: 's2h-admin',
      operationId: attestPrepared.reserved.operationId,
      outcome: 'payment_reported',
      reason: 'Dashboard looked paid, no receipt recorded',
      env: process.env,
    });
    const attestClose = await manual.closeManualCollection({
      bookingId: attestId,
      actorId: 's2h-admin',
      operationId: attestPrepared.reserved.operationId,
      outcome: 'receipt_reconciled',
      reason: 'trying to reconcile without a ledger receipt',
      confirmation: {
        ledgerRecorded: true,
        dashboardReceiptMatches: true,
        linkDeactivated: true,
        responsibilityAccepted: true,
      },
      env: process.env,
    });
    const attestCash = await authority.recordFullBalanceOnSiteSettlement({
      bookingId: attestId, method: 'cash', body: { reason: 'should stay blocked' },
    });
    const attestAfter = await snapshot(attestId);
    record({
      test: '15 payment_reported without a receipt stays restricted and unpaid',
      pass: attested.ok === true
        && attestClose.error === 'square_receipt_missing'
        && attestCash.error === 'manual_collection_active'
        && attestAfter.booking.state === 'payment_reported'
        && attestAfter.ledger.length === 0
        && !attestAfter.detail.squareDashboardReceipt,
    });

    const flagOff = { CD1_POSTGRES_PAYMENT: '1', DATABASE_URL: url };
    const flagId = nextId('flag');
    await seed(flagId);
    const refused = await reserve(flagId, flagOff);
    const flagAfter = await snapshot(flagId);
    record({
      test: '16 a missing flag refuses a new reservation',
      pass: refused.error === 'manual_square_collection_disabled'
        && flagAfter.booking.state == null,
    });

    const heldId = nextId('held');
    const held = await reserve(heldId);
    process.env.MANUAL_SQUARE_COLLECTION_ENABLED = 'false';
    const replay = await reserve(heldId, flagOff);
    const heldCash = await authority.recordFullBalanceOnSiteSettlement({
      bookingId: heldId, method: 'cash', body: { reason: 'flag off must not release the reservation' },
    });
    process.env.MANUAL_SQUARE_COLLECTION_ENABLED = 'true';
    const heldAfter = await snapshot(heldId);
    record({
      test: '17 disabling the flag keeps the existing reservation visible',
      pass: held.ok === true
        && replay.ok === true
        && replay.idempotent === true
        && replay.operationId === held.operationId,
    });
    record({
      test: '18 on-site settlement stays blocked while the flag is off and the reservation remains',
      pass: heldCash.ok === false
        && heldCash.error === 'manual_collection_active'
        && heldAfter.booking.state === 'reserved'
        && heldAfter.ledger.length === 0,
    });

    const unknownId = nextId('unknown');
    const unknownPrepared = await prepared(unknownId);
    const realPrisma = getPrisma();
    let dropped = false;
    const dropping = {
      $transaction: async (...args) => {
        const value = await realPrisma.$transaction(...args);
        if (!dropped) {
          dropped = true;
          throw new Error('connection terminated');
        }
        return value;
      },
    };
    const unknown = await receipt(unknownId, unknownPrepared.reserved.operationId, {
      squareTransactionRef: 'sq_unknown_1001',
      prisma: dropping,
    });
    const unknownReplay = await receipt(unknownId, unknownPrepared.reserved.operationId, {
      squareTransactionRef: 'sq_unknown_1001',
    });
    const unknownAfter = await snapshot(unknownId);
    record({
      test: '19 a lost receipt response is recovered from the stored Square reference',
      pass: unknown.error === 'square_receipt_outcome_unknown'
        && unknownReplay.idempotent === true
        && unknownAfter.ledger.length === 1
        && unknownAfter.booking.state === 'payment_reported',
    });

    const rollbackId = nextId('rollback');
    const rollbackPrepared = await prepared(rollbackId);
    await admin.query(`
      CREATE OR REPLACE FUNCTION s2h_reject_ledger() RETURNS trigger AS $fn$
      BEGIN
        IF NEW."providerObjectId" = 'rollbackref' THEN
          RAISE EXCEPTION 'synthetic_receipt_rollback';
        END IF;
        RETURN NEW;
      END $fn$ LANGUAGE plpgsql
    `);
    await admin.query(`
      CREATE TRIGGER s2h_reject_ledger BEFORE INSERT ON "LedgerEntry"
      FOR EACH ROW EXECUTE FUNCTION s2h_reject_ledger()
    `);
    const rolled = await receipt(rollbackId, rollbackPrepared.reserved.operationId, {
      squareTransactionRef: 'rollbackref',
    });
    await admin.query('DROP TRIGGER IF EXISTS s2h_reject_ledger ON "LedgerEntry"');
    const rollbackAfter = await snapshot(rollbackId);
    record({
      test: '20 a receipt failure rolls back the ledger and the collection state together',
      pass: rolled.ok === false
        && rollbackAfter.ledger.length === 0
        && rollbackAfter.booking.state === 'recorded'
        && !rollbackAfter.detail.squareDashboardReceipt,
    });

    const mathId = nextId('math');
    await seed(mathId);
    const adjusted = await authority.createAdjustment({
      bookingId: mathId,
      newApprovedCents: 18000,
      reason: 'synthetic open adjustment',
      adjustmentId: 's2hmathadjust',
      expectedQuoteVersion: 1,
      approvedBy: 's2h-admin',
    });
    const mathQuote = await snapshot(mathId);
    const refundBooking = nextId('refund');
    await seed(refundBooking);
    const refundPi = await addAttempt(refundBooking);
    await authority.reconcilePaymentIntentEvent({
      stripeEventId: `evt_${refundBooking}`,
      type: 'payment_intent.succeeded',
      paymentIntent: {
        id: refundPi,
        status: 'succeeded',
        amount: CENTS,
        amount_received: CENTS,
        currency: 'usd',
        metadata: {
          bookingId: refundBooking,
          booking_id: refundBooking,
          quoteVersion: '1',
          purpose: 'customer_balance',
        },
      },
    });
    const requestId = `${refundBooking}-rr`;
    await prisma.refundRequest.create({
      data: {
        id: requestId,
        bookingId: refundBooking,
        paymentAttemptId: `${refundBooking}-pa`,
        quoteVersion: 1,
        amountCents: CENTS,
        currency: 'usd',
        reason: 'synthetic refund',
        requestedBy: 's2h-admin',
        status: 'pending_webhook',
        requestGroupKey: `${refundBooking}-group`,
        partIndex: 0,
        idempotencyKey: `${refundBooking}-refund`,
      },
    });
    await authority.reconcileRefundEvent({
      stripeEventId: `evt_${refundBooking}_refund`,
      type: 'refund.updated',
      refund: {
        id: `re_${refundBooking}`,
        status: 'succeeded',
        amount: CENTS,
        currency: 'usd',
        payment_intent: refundPi,
        metadata: {
          bookingId: refundBooking,
          booking_id: refundBooking,
          quoteVersion: '1',
          purpose: 'customer_refund',
          refundRequestId: requestId,
          refund_request_id: requestId,
        },
      },
    });
    const refundProjection = await authority.getFinancialProjection(refundBooking);
    record({
      test: '22 quote adjustment and refund math stay on the existing ledger',
      pass: adjusted.ok === true
        && mathQuote.quote.quoteVersion === 2
        && mathQuote.quote.approvedCents === 18000
        && mathQuote.ledger.length === 0
        && refundProjection.settledCents === 0
        && refundProjection.refundedCents === CENTS
        && refundProjection.approvedCents === CENTS,
    });

    record({
      test: 'no provider call was made',
      pass: providerCalls === 0,
    });
  } finally {
    await admin.query('DROP TRIGGER IF EXISTS s2h_reject_ledger ON "LedgerEntry"').catch(() => null);
    global.fetch = originalFetch;
    await admin.end();
    if (prisma) await prisma.$disconnect();
  }

  const failed = results.filter((item) => !item.pass);
  if (failed.length || results.length !== 23) {
    console.error(JSON.stringify({ failed: failed.map((item) => item.test), recorded: results.length }));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
