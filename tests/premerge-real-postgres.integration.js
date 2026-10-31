'use strict';

/**
 * Final pre-merge flow on disposable PostgreSQL 16.
 * Synthetic bookings only. Refuses every database except 127.0.0.1:54341.
 * Not part of npm test.
 */

const Module = require('node:module');
const path = require('node:path');

if (process.env.PREMERGE_PRISMA_CLIENT) {
  const clientEntry = path.join(process.env.PREMERGE_PRISMA_CLIENT, 'index.js');
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function resolveIsolatedClient(request, parent, isMain, options) {
    if (request === '@prisma/client') return clientEntry;
    return resolveFilename.call(this, request, parent, isMain, options);
  };
}

const { Client } = require('pg');
const manual = require('../netlify/lib/db/manual-collection');
const authority = require('../netlify/lib/db/payment-authority-service');
const ui = require('../netlify/lib/admin-square-receipt-ui');
const { ACTIVE_PAYMENT_PROVIDER } = require('../netlify/lib/payment-provider-adapter');
const deployEnv = require('../netlify/lib/deploy-runtime-env.generated');
const { getPrisma } = require('../netlify/lib/prisma');

const CENTS = 15000;
const results = [];
let providerCalls = 0;
const originalFetch = global.fetch;
global.fetch = async () => {
  providerCalls += 1;
  throw new Error('provider_call_forbidden');
};

function record(entry) {
  results.push(entry);
  console.log(JSON.stringify({ test: entry.test, pass: entry.pass }));
}

function assertUrl(value) {
  const parsed = new URL(value);
  if (parsed.hostname !== '127.0.0.1' || parsed.port !== '54341' || parsed.username !== 'premerge_owner' || parsed.pathname !== '/cardetail1_premerge_disposable') {
    throw new Error('refusing a database that is not the disposable premerge instance');
  }
}

async function main() {
  delete process.env.SQUARE_ACCESS_TOKEN;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_LEGACY_REFUNDS_ENABLED;
  process.env.CD1_POSTGRES_PAYMENT = '1';
  process.env.MANUAL_SQUARE_COLLECTION_ENABLED = 'true';
  const url = String(process.env.DATABASE_URL || '');
  assertUrl(url);
  if (String(process.env.DIRECT_URL || '') !== url) throw new Error('DIRECT_URL must match the disposable database');
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const idRow = (await admin.query(`
    SELECT current_database() AS db, inet_server_port() AS port,
           inet_server_addr()::text AS addr, current_setting('data_directory') AS data_directory
  `)).rows[0];
  if (idRow.db !== 'cardetail1_premerge_disposable' || String(idRow.port) !== '54341' || !String(idRow.addr).startsWith('127.0.0.1')) {
    throw new Error('connected database is not the disposable premerge instance');
  }
  if (!String(idRow.data_directory).toLowerCase().includes('premerge-disposable-pg')) {
    throw new Error('data directory is not the disposable cluster');
  }

  const prisma = getPrisma();
  let seq = 0;
  const nextId = (label) => {
    seq += 1;
    return `pre-${String(seq).padStart(2, '0')}-${label}`;
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

  async function snapshot(id) {
    const booking = await admin.query(`
      SELECT "manualCollectionState" AS state,
             "manualCollectionOperationId" AS operation_id,
             "manualCollectionUrl" AS url,
             "manualCollectionDetail" AS detail
      FROM "Booking" WHERE id = $1
    `, [id]);
    const ledger = await admin.query(`
      SELECT kind, "amountCents", "providerEventId", "providerObjectId", actor, currency
      FROM "LedgerEntry" WHERE "bookingId" = $1 ORDER BY "recordedAt", id
    `, [id]);
    const detail = booking.rows[0] && booking.rows[0].detail && typeof booking.rows[0].detail === 'object'
      ? booking.rows[0].detail : {};
    return { booking: booking.rows[0] || null, ledger: ledger.rows, detail };
  }

  async function prepared(id) {
    await seed(id);
    const reserved = await manual.reserveManualCollection({
      bookingId: id, booking: blob(id), actorId: 'premerge-admin', env: process.env,
    });
    const recorded = await manual.recordManualCollectionUrl({
      bookingId: id,
      operationId: reserved.operationId,
      url: 'https://square.example/synthetic-premerge',
      actorId: 'premerge-admin',
      env: process.env,
    });
    return { reserved, recorded };
  }

  try {
    const flowId = nextId('flow');
    await seed(flowId);
    const reservedAgain = await manual.reserveManualCollection({
      bookingId: flowId, booking: blob(flowId), actorId: 'premerge-admin', env: process.env,
    });
    const recorded = await manual.recordManualCollectionUrl({
      bookingId: flowId,
      operationId: reservedAgain.operationId,
      url: 'https://square.example/synthetic-premerge',
      actorId: 'premerge-admin',
      env: process.env,
    });
    const observedBody = ui.buildPaymentReportedRequest({
      bookingId: flowId,
      operationId: reservedAgain.operationId,
      reason: 'administrator saw a completed total',
      evidence: 'note only',
    });
    const observed = await manual.closeManualCollection({
      bookingId: flowId,
      actorId: 'premerge-admin',
      operationId: observedBody.body.operationId,
      outcome: observedBody.body.outcome,
      reason: observedBody.body.reason,
      evidence: observedBody.body.evidence,
      confirmation: observedBody.body.confirmation,
      env: process.env,
    });
    const observedAfter = await snapshot(flowId);
    record({
      test: '1-4 reserve, record URL, and observation do not create ledger money',
      pass: reservedAgain.ok === true
        && recorded.ok === true
        && observed.ok === true
        && observed.ledgerEntryCreated === false
        && observedAfter.booking.state === 'payment_reported'
        && observedAfter.ledger.length === 0
        && observedAfter.booking.url === 'https://square.example/synthetic-premerge',
    });

    const receipt = await authority.recordAdministratorSquareReceipt({
      bookingId: flowId,
      actorId: 'premerge-admin',
      operationId: reservedAgain.operationId,
      squareTransactionRef: 'sq_premerge_1001',
      amountCents: CENTS,
      currency: 'usd',
      dashboardObserved: true,
    });
    const projection = await authority.getFinancialProjection(flowId);
    const receiptAfter = await snapshot(flowId);
    const view = manual.publicView({
      manualCollectionState: receiptAfter.booking.state,
      manualCollectionOperationId: receiptAfter.booking.operation_id,
      manualCollectionUrl: receiptAfter.booking.url,
      manualCollectionDetail: receiptAfter.detail,
    });
    record({
      test: '5-8 one dashboard receipt updates the authoritative balance',
      pass: receipt.ok === true
        && receipt.ledgerEntryCreated === true
        && receipt.providerVerified === false
        && receipt.squareVerified === false
        && projection.remainingCents === 0
        && projection.settledCents === CENTS
        && receiptAfter.ledger.length === 1
        && receiptAfter.ledger[0].providerEventId === 'square_dashboard_receipt:sq_premerge_1001'
        && receiptAfter.ledger[0].kind === 'settlement'
        && receiptAfter.ledger[0].actor === 'premerge-admin'
        && view.squareDashboardReceipt
        && view.squareDashboardReceipt.squareTransactionRef === 'sq_premerge_1001'
        && view.squareDashboardReceipt.squareVerified === false,
    });

    const eligibility = ui.receiptReconciliationEligibility({
      collection: view,
      remainingCents: projection.remainingCents,
    });
    const closureBody = ui.buildReceiptReconciledRequest({
      bookingId: flowId,
      operationId: reservedAgain.operationId,
      reason: 'administrator deactivated the Square link by hand',
      confirmation: {
        ledgerRecorded: true,
        dashboardReceiptMatches: true,
        linkDeactivated: true,
        responsibilityAccepted: true,
      },
    });
    const closed = await manual.closeManualCollection({
      bookingId: flowId,
      actorId: 'premerge-admin',
      operationId: closureBody.body.operationId,
      outcome: closureBody.body.outcome,
      reason: closureBody.body.reason,
      confirmation: closureBody.body.confirmation,
      env: process.env,
    });
    const closedAfter = await snapshot(flowId);
    record({
      test: '9-10 drawer reconciliation closes only through the existing contract',
      pass: eligibility.eligible === true
        && closureBody.body.outcome === 'receipt_reconciled'
        && closureBody.body.confirmation.linkDeactivated === true
        && Object.hasOwn(closureBody.body, 'squareVerified') === false
        && closed.ok === true
        && closedAfter.booking.state === 'closed'
        && closedAfter.detail.outcome === 'receipt_reconciled'
        && closedAfter.detail.squareVerified !== true
        && closedAfter.detail.apiVerified !== true
        && closedAfter.booking.url === 'https://square.example/synthetic-premerge'
        && closedAfter.ledger.length === 1,
    });

    const closedAgain = await manual.closeManualCollection({
      bookingId: flowId,
      actorId: 'premerge-admin',
      operationId: reservedAgain.operationId,
      outcome: 'receipt_reconciled',
      reason: 'second closure',
      confirmation: closureBody.body.confirmation,
      env: process.env,
    });
    const closedAgainAfter = await snapshot(flowId);
    record({
      test: '11 duplicate closure does not write again',
      pass: closedAgain.ok === false
        && closedAgainAfter.booking.state === 'closed'
        && closedAgainAfter.ledger.length === 1,
    });

    const receiptAgain = await authority.recordAdministratorSquareReceipt({
      bookingId: flowId,
      actorId: 'premerge-admin',
      operationId: reservedAgain.operationId,
      squareTransactionRef: 'sq_premerge_1001',
      amountCents: CENTS,
      currency: 'usd',
      dashboardObserved: true,
    });
    const duplicateAfter = await snapshot(flowId);
    record({
      test: '12 duplicate receipt does not duplicate money',
      pass: receiptAgain.ledgerEntryCreated !== true
        && duplicateAfter.ledger.filter((row) => row.providerEventId === 'square_dashboard_receipt:sq_premerge_1001').length === 1,
    });

    const otherId = nextId('other');
    const other = await prepared(otherId);
    const cross = await authority.recordAdministratorSquareReceipt({
      bookingId: otherId,
      actorId: 'premerge-admin',
      operationId: other.reserved.operationId,
      squareTransactionRef: 'sq_premerge_1001',
      amountCents: CENTS,
      currency: 'usd',
      dashboardObserved: true,
    });
    const otherAfter = await snapshot(otherId);
    record({
      test: '13 the same Square reference cannot credit another booking',
      pass: cross.error === 'square_reference_conflict' && otherAfter.ledger.length === 0,
    });

    const amountId = nextId('amount');
    const amount = await prepared(amountId);
    const badAmount = await authority.recordAdministratorSquareReceipt({
      bookingId: amountId,
      actorId: 'premerge-admin',
      operationId: amount.reserved.operationId,
      squareTransactionRef: 'sq_bad_amount',
      amountCents: 14000,
      currency: 'usd',
      dashboardObserved: true,
    });
    record({
      test: '14 an inconsistent amount is refused',
      pass: badAmount.error === 'square_receipt_amount_mismatch' && (await snapshot(amountId)).ledger.length === 0,
    });

    const currencyId = nextId('currency');
    const currency = await prepared(currencyId);
    const badCurrency = await authority.recordAdministratorSquareReceipt({
      bookingId: currencyId,
      actorId: 'premerge-admin',
      operationId: currency.reserved.operationId,
      squareTransactionRef: 'sq_bad_currency',
      amountCents: CENTS,
      currency: 'eur',
      dashboardObserved: true,
    });
    record({
      test: '15 an inconsistent currency is refused',
      pass: badCurrency.error === 'square_receipt_currency_mismatch' && (await snapshot(currencyId)).ledger.length === 0,
    });

    const bareId = nextId('bare');
    const bare = await prepared(bareId);
    const bareClose = await manual.closeManualCollection({
      bookingId: bareId,
      actorId: 'premerge-admin',
      operationId: bare.reserved.operationId,
      outcome: 'receipt_reconciled',
      reason: 'no receipt',
      confirmation: closureBody.body.confirmation,
      env: process.env,
    });
    record({
      test: '16 reconciliation without a durable receipt is refused',
      pass: bareClose.error === 'square_receipt_missing' && (await snapshot(bareId)).ledger.length === 0 && (await snapshot(bareId)).booking.state === 'recorded',
    });

    const conflictId = nextId('conflict');
    const conflictPrepared = await prepared(conflictId);
    await authority.recordAdministratorSquareReceipt({
      bookingId: conflictId,
      actorId: 'premerge-admin',
      operationId: conflictPrepared.reserved.operationId,
      squareTransactionRef: 'sq_conflict_1001',
      amountCents: CENTS,
      currency: 'usd',
      dashboardObserved: true,
    });
    await prisma.paymentAttempt.create({
      data: {
        id: `${conflictId}-pa`,
        bookingId: conflictId,
        quoteId: `${conflictId}-q`,
        quoteVersion: 1,
        purpose: 'customer_balance',
        providerObjectType: 'payment_intent',
        providerObjectId: `pi_${conflictId}`,
        status: 'open',
        amountCents: CENTS,
        currency: 'usd',
        idempotencyKey: `${conflictId}-pay`,
      },
    });
    await admin.query(`UPDATE "PaymentAttempt" SET "updatedAt" = now() - interval '10 minutes' WHERE id = $1`, [`${conflictId}-pa`]);
    await authority.reconcileStalePaymentAttempts({
      bookingId: conflictId,
      env: { STRIPE_SECRET_KEY: 'sk_test_synthetic_not_a_real_key', CD1_FORCE_LOCAL_STRIPE_GUARD: '1' },
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          id: `pi_${conflictId}`,
          status: 'succeeded',
          amount: CENTS,
          amount_received: CENTS,
          currency: 'usd',
        }),
      }),
    });
    const conflictClose = await manual.closeManualCollection({
      bookingId: conflictId,
      actorId: 'premerge-admin',
      operationId: conflictPrepared.reserved.operationId,
      outcome: 'receipt_reconciled',
      reason: 'should stay in review',
      confirmation: closureBody.body.confirmation,
      env: process.env,
    });
    const conflictAfter = await snapshot(conflictId);
    record({
      test: '17 unresolved conflict blocks reconciliation',
      pass: conflictClose.error === 'square_receipt_review_required'
        && conflictAfter.booking.state === 'payment_reported'
        && Array.isArray(conflictAfter.detail.externalFinancialConflicts)
        && conflictAfter.detail.externalFinancialConflicts.length === 1,
    });

    const ambiguousId = nextId('ambiguous');
    const ambiguous = await prepared(ambiguousId);
    await authority.recordAdministratorSquareReceipt({
      bookingId: ambiguousId,
      actorId: 'premerge-admin',
      operationId: ambiguous.reserved.operationId,
      squareTransactionRef: 'sq_ambiguous_1001',
      amountCents: CENTS,
      currency: 'usd',
      dashboardObserved: true,
    });
    const unknown = await manual.closeManualCollection({
      bookingId: ambiguousId,
      actorId: 'premerge-admin',
      operationId: ambiguous.reserved.operationId,
      outcome: 'receipt_reconciled',
      reason: 'lost response',
      confirmation: closureBody.body.confirmation,
      env: process.env,
    }, {
      withBookingLock: async () => {
        throw new Error('connection terminated');
      },
    });
    const ambiguousAfter = await snapshot(ambiguousId);
    const ambiguousCash = await authority.recordFullBalanceOnSiteSettlement({
      bookingId: ambiguousId,
      method: 'cash',
      body: { reason: 'must stay blocked' },
    });
    record({
      test: '18 an ambiguous closure preserves the collection restriction',
      pass: unknown.ok === false
        && unknown.error === 'manual_collection_outcome_unknown'
        && ambiguousAfter.booking.state === 'payment_reported'
        && ambiguousAfter.ledger.length === 1
        && ambiguousCash.error === 'manual_collection_active',
    });

    const flagId = nextId('flag');
    await seed(flagId);
    const flagOff = {
      DATABASE_URL: process.env.DATABASE_URL,
      DIRECT_URL: process.env.DIRECT_URL,
      CD1_POSTGRES_PAYMENT: '1',
    };
    const refused = await manual.reserveManualCollection({
      bookingId: flagId, booking: blob(flagId), actorId: 'premerge-admin', env: flagOff,
    });
    process.env.MANUAL_SQUARE_COLLECTION_ENABLED = 'false';
    const heldCash = await authority.recordFullBalanceOnSiteSettlement({
      bookingId: ambiguousId,
      method: 'cash',
      body: { reason: 'flag off still blocked' },
    });
    process.env.MANUAL_SQUARE_COLLECTION_ENABLED = 'true';
    record({
      test: '19 a disabled flag blocks a new reservation and keeps an existing restriction',
      pass: refused.error === 'manual_square_collection_disabled'
        && (await snapshot(flagId)).booking.state == null
        && heldCash.error === 'manual_collection_active',
    });

    record({
      test: '20 no provider call and commercial gates stay disabled',
      pass: providerCalls === 0
        && ACTIVE_PAYMENT_PROVIDER === 'none'
        && deployEnv.STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED === false,
    });
  } finally {
    global.fetch = originalFetch;
    await admin.end();
    await prisma.$disconnect();
  }

  const failed = results.filter((entry) => !entry.pass);
  if (failed.length || results.length !== 13) {
    console.error(JSON.stringify({ failed: failed.length, count: results.length }));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exitCode = 1;
});
