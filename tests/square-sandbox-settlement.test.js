'use strict';

const { describe, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  LOCAL_DATABASE_NAME,
  assertLocalSettlementUrl,
  applySettlementSchema,
  connectProven,
  emptySettlementTables,
} = require('../sandbox/square-settlement/database');
const {
  ADAPTER_COMMIT,
  DEPENDS_ON_PULL_REQUEST,
  PURPOSE,
  associatePayment,
  createObligation,
  createOperation,
  ingestObservation,
  retrieveAndReconcile,
} = require('../sandbox/square-settlement/square-sandbox-settlement');
const { ACTIVE_PAYMENT_PROVIDER } = require('../netlify/lib/payment-provider-adapter');

const ROOT = path.join(__dirname, '..');
const URL = 'postgresql://cardetail1_ci@127.0.0.1:5433/cardetail1_square_settlement_7d';
const TOKEN = 'EAAA_sandbox_mock_token_not_a_real_credential_00';
const PAYMENT_ID = 'sandboxPay7dOnly';
const MERCHANT_ID = 'MERCHANT_TEST_7D';
const LOCATION_ID = 'LOC_TEST_7D';

function context(overrides = {}) {
  return {
    testContext: 'noncommercial-test',
    trustedSandbox: {
      configuredBy: 'server',
      merchantId: MERCHANT_ID,
      locationId: LOCATION_ID,
      locationMerchantId: MERCHANT_ID,
    },
    ...overrides,
  };
}

function observation(overrides = {}) {
  return context({
    eventId: 'evt-7d-completed',
    eventType: 'payment.updated',
    sourceKind: 'authenticated_event',
    squarePaymentId: PAYMENT_ID,
    merchantId: MERCHANT_ID,
    locationId: LOCATION_ID,
    paymentStatus: 'COMPLETED',
    amountCents: 100,
    currency: 'USD',
    observedAt: '2026-10-26T02:00:00.000Z',
    ...overrides,
  });
}

function paymentBody(overrides = {}) {
  const payment = {
    id: overrides.id || PAYMENT_ID,
    status: overrides.status || 'COMPLETED',
    location_id: overrides.locationId || LOCATION_ID,
    amount_money: {
      amount: overrides.amount == null ? 100 : overrides.amount,
      currency: overrides.currency || 'USD',
    },
  };
  assert.equal(Object.hasOwn(payment, 'merchant_id'), false);
  return { payment };
}

function mockFetch(body, status = 200) {
  return async () => ({
    status,
    async text() { return JSON.stringify(body); },
  });
}

async function counts() {
  const client = await connectProven(URL);
  try {
    const result = await client.query(
      `SELECT
         (SELECT count(*)::int FROM sandbox_settlement) AS settlements,
         (SELECT count(*)::int FROM sandbox_payment_event) AS events,
         (SELECT count(*)::int FROM sandbox_payment_operation) AS operations,
         (SELECT count(*)::int FROM sandbox_payment_obligation) AS obligations,
         to_regclass('public."PaymentAttempt"') AS commercial_attempt`
    );
    return result.rows[0];
  } finally {
    await client.end();
  }
}

async function authorizedPair(paymentId = PAYMENT_ID, key = 'sandbox-op-7d-001') {
  const obligation = await createObligation(URL, context({
    bookingRef: 'TEST-SQ-7D',
    purpose: PURPOSE,
    amountCents: 100,
    currency: 'USD',
  }));
  const operation = await createOperation(URL, context({
    obligationId: obligation.obligationId,
    idempotencyKey: key,
  }));
  const associated = await associatePayment(URL, context({
    operationId: operation.operationId,
    squarePaymentId: paymentId,
  }));
  return { obligation, operation, associated };
}

describe('isolated Square Sandbox settlement', { concurrency: false }, () => {
  beforeEach(async () => {
    await emptySettlementTables(URL);
    await applySettlementSchema(URL);
  });

  test('the connection gate rejects remote and non-local databases', () => {
    assert.equal(LOCAL_DATABASE_NAME, 'cardetail1_square_settlement_7d');
    assert.throws(
      () => assertLocalSettlementUrl('postgresql://cardetail1_ci@127.0.0.1:5432/cardetail1_square_settlement_7d'),
      /square_settlement_database_unproven/
    );
    assert.throws(
      () => assertLocalSettlementUrl('postgresql://user@ep-example.neon.tech/cardetail1_square_settlement_7d'),
      /square_settlement_database_unproven/
    );
    assert.equal(ADAPTER_COMMIT, 'f68c9b46af83d747e55139eaac5fb724db0e43e4');
    assert.equal(DEPENDS_ON_PULL_REQUEST, 373);
  });

  test('an obligation and operation are stored before any settlement', async () => {
    const { obligation, operation, associated } = await authorizedPair();
    assert.equal(obligation.result, 'stored');
    assert.equal(operation.result, 'stored');
    assert.equal(operation.obligationId, obligation.obligationId);
    assert.equal(associated.result, 'pending');
    assert.equal(associated.financiallySettled, false);
    assert.equal(associated.settlementCommitted, false);
    assert.equal(associated.paid, false);
    const state = await counts();
    assert.equal(state.settlements, 0);
    assert.equal(state.obligations, 1);
    assert.equal(state.operations, 1);
    assert.equal(state.commercial_attempt, null);
  });

  test('COMPLETED settles once and non-completed statuses do not', async () => {
    const { obligation, operation } = await authorizedPair();
    const settled = await ingestObservation(URL, observation());
    assert.equal(settled.result, 'settled');
    assert.equal(settled.providerCompleted, true);
    assert.equal(settled.financiallySettled, true);
    assert.equal(settled.settlementCommitted, true);
    assert.equal(settled.paid, false);
    assert.equal(settled.ledgerWrite, false);
    assert.equal(settled.bookingWrite, false);
    assert.equal(settled.operationId, operation.operationId);
    assert.equal(settled.obligationId, obligation.obligationId);
    assert.equal(settled.squarePaymentId, PAYMENT_ID);
    for (const status of ['APPROVED', 'PENDING', 'FAILED', 'CANCELED']) {
      await emptySettlementTables(URL);
      await applySettlementSchema(URL);
      await authorizedPair();
      const outcome = await ingestObservation(URL, observation({
        eventId: `evt-7d-${status}`,
        paymentStatus: status,
      }));
      assert.equal(outcome.settlementCommitted, false, status);
      assert.equal(outcome.financiallySettled, false, status);
      assert.equal(outcome.paid, false, status);
      if (status === 'APPROVED' || status === 'PENDING') assert.equal(outcome.result, 'pending', status);
      else assert.equal(outcome.result, 'rejected', status);
      assert.equal((await counts()).settlements, 0, status);
    }
  });

  test('unknown status, bad identity, amount, and currency do not settle', async () => {
    await authorizedPair();
    const cases = [
      [observation({ eventId: 'evt-7d-unknown', paymentStatus: 'CAPTURED' }), 'rejected'],
      [observation({ eventId: 'evt-7d-merchant', merchantId: 'MERCHANT_TEST_OTHER' }), 'quarantined'],
      [observation({ eventId: 'evt-7d-location', locationId: 'LOC_TEST_OTHER' }), 'quarantined'],
      [observation({ eventId: 'evt-7d-amount', amountCents: 250 }), 'quarantined'],
      [observation({ eventId: 'evt-7d-currency', currency: 'EUR' }), 'quarantined'],
    ];
    for (const [event, expected] of cases) {
      await emptySettlementTables(URL);
      await applySettlementSchema(URL);
      await authorizedPair();
      const outcome = await ingestObservation(URL, event);
      assert.equal(outcome.result, expected, event.eventId);
      assert.equal(outcome.settlementCommitted, false, event.eventId);
      assert.equal(outcome.financiallySettled, false, event.eventId);
      assert.equal((await counts()).events, 1, event.eventId);
      assert.equal((await counts()).settlements, 0, event.eventId);
    }
  });

  test('commercial booking input and an unknown obligation are rejected', async () => {
    const commercial = await createObligation(URL, context({
      bookingRef: 'CD1-REAL',
      purpose: PURPOSE,
      amountCents: 100,
      currency: 'USD',
    }));
    assert.equal(commercial.result, 'rejected');
    const browser = await createObligation(URL, context({
      bookingRef: 'TEST-SQ-7D',
      purpose: PURPOSE,
      amountCents: 100,
      currency: 'USD',
      browserAmountCents: 1,
    }));
    assert.equal(browser.result, 'rejected');
    const missing = await createOperation(URL, context({
      obligationId: 'obl-missing',
      idempotencyKey: 'sandbox-op-missing',
    }));
    assert.equal(missing.error, 'square_settlement_obligation_unknown');
    assert.equal((await counts()).settlements, 0);
  });

  test('duplicate events and a repeated payment do not create a second settlement', async () => {
    await authorizedPair();
    const first = await ingestObservation(URL, observation({ eventId: 'evt-7d-a' }));
    const duplicate = await ingestObservation(URL, observation({ eventId: 'evt-7d-a', paymentStatus: 'APPROVED' }));
    const otherEvent = await ingestObservation(URL, observation({
      eventId: 'evt-7d-b',
      eventType: 'payment.created',
      observedAt: '2026-10-26T03:00:00.000Z',
    }));
    assert.equal(first.settlementCommitted, true);
    assert.equal(duplicate.result, 'already_settled');
    assert.equal(duplicate.settlementCommitted, false);
    assert.equal(duplicate.financiallySettled, true);
    assert.equal(otherEvent.result, 'already_settled');
    assert.equal((await counts()).settlements, 1);
    assert.equal((await counts()).events, 2);
  });

  test('concurrent settlement attempts leave one row', async () => {
    await authorizedPair();
    const [left, right] = await Promise.all([
      ingestObservation(URL, observation({ eventId: 'evt-7d-left' })),
      ingestObservation(URL, observation({ eventId: 'evt-7d-right', eventType: 'payment.created' })),
    ]);
    const results = [left.result, right.result].sort();
    assert.deepEqual(results, ['already_settled', 'settled']);
    assert.equal(left.settlementCommitted !== right.settlementCommitted, true);
    assert.equal((await counts()).settlements, 1);
    assert.equal((await counts()).events, 2);
  });

  test('a second payment cannot settle an obligation, and one payment cannot bind two obligations', async () => {
    const { obligation } = await authorizedPair();
    await ingestObservation(URL, observation());
    const secondOperation = await createOperation(URL, context({
      obligationId: obligation.obligationId,
      idempotencyKey: 'sandbox-op-7d-second',
    }));
    assert.equal(secondOperation.result, 'rejected');
    assert.equal((await counts()).settlements, 1);

    await emptySettlementTables(URL);
    await applySettlementSchema(URL);
    const first = await authorizedPair(PAYMENT_ID, 'sandbox-op-7d-one');
    const otherObligation = await createObligation(URL, context({
      bookingRef: 'TEST-SQ-7D-B',
      purpose: PURPOSE,
      amountCents: 100,
      currency: 'USD',
    }));
    const otherOperation = await createOperation(URL, context({
      obligationId: otherObligation.obligationId,
      idempotencyKey: 'sandbox-op-7d-two',
    }));
    const stolen = await associatePayment(URL, context({
      operationId: otherOperation.operationId,
      squarePaymentId: PAYMENT_ID,
    }));
    assert.equal(stolen.result, 'rejected');
    assert.equal(stolen.settlementCommitted, false);
    const settled = await ingestObservation(URL, observation());
    assert.equal(settled.obligationId, first.obligation.obligationId);
    assert.equal((await counts()).settlements, 1);
  });

  test('a rolled-back settlement is not success and can be retried without a new payment', async () => {
    await authorizedPair();
    const failed = await ingestObservation(URL, observation({ fault: 'before_commit' }));
    assert.equal(failed.result, 'failed');
    assert.equal(failed.settlementCommitted, false);
    assert.equal(failed.financiallySettled, false);
    assert.equal(failed.retrySafe, true);
    assert.equal((await counts()).settlements, 0);
    const retried = await ingestObservation(URL, observation());
    assert.equal(retried.result, 'settled');
    assert.equal(retried.settlementCommitted, true);
    assert.equal((await counts()).settlements, 1);
  });

  test('operation persistence failure does not settle, and the same key can be retried', async () => {
    const obligation = await createObligation(URL, context({
      bookingRef: 'TEST-SQ-7D',
      purpose: PURPOSE,
      amountCents: 100,
      currency: 'USD',
    }));
    const failed = await createOperation(URL, context({
      obligationId: obligation.obligationId,
      idempotencyKey: 'sandbox-op-7d-001',
      fault: 'operation_insert',
    }));
    assert.equal(failed.result, 'failed');
    assert.equal(failed.retrySafe, true);
    assert.equal((await counts()).operations, 0);
    const stored = await createOperation(URL, context({
      obligationId: obligation.obligationId,
      idempotencyKey: 'sandbox-op-7d-001',
    }));
    const replay = await createOperation(URL, context({
      obligationId: obligation.obligationId,
      idempotencyKey: 'sandbox-op-7d-001',
    }));
    const conflict = await createOperation(URL, context({
      obligationId: obligation.obligationId,
      idempotencyKey: 'sandbox-op-7d-001',
      amountCents: 250,
    }));
    assert.equal(stored.operationId, replay.operationId);
    assert.equal(conflict.error, 'square_settlement_idempotency_conflict');
    assert.equal((await counts()).operations, 1);
    assert.equal((await counts()).settlements, 0);
  });

  test('a webhook before association is kept and settles once the operation exists', async () => {
    const early = await ingestObservation(URL, observation({ eventId: 'evt-7d-early' }));
    assert.equal(early.result, 'stored');
    assert.equal(early.processingStatus, 'awaiting_association');
    assert.equal(early.settlementCommitted, false);
    assert.equal((await counts()).events, 1);
    const paired = await authorizedPair();
    assert.equal(paired.associated.result, 'settled');
    assert.equal(paired.associated.settlementCommitted, true);
    const late = await ingestObservation(URL, observation({
      eventId: 'evt-7d-late',
      observedAt: '2026-10-26T02:05:00.000Z',
    }));
    assert.equal(late.result, 'already_settled');
    assert.equal(late.settlementCommitted, false);
    assert.equal(late.financiallySettled, true);
    assert.equal((await counts()).settlements, 1);
    assert.equal((await counts()).events, 2);
  });

  test('an older pending event does not regress a completed settlement', async () => {
    await authorizedPair();
    const completed = await ingestObservation(URL, observation({
      eventId: 'evt-7d-done',
      observedAt: '2026-10-26T02:00:00.000Z',
    }));
    const older = await ingestObservation(URL, observation({
      eventId: 'evt-7d-old-pending',
      paymentStatus: 'PENDING',
      observedAt: '2026-10-26T01:00:00.000Z',
    }));
    const approvedLater = await ingestObservation(URL, observation({
      eventId: 'evt-7d-approved-later',
      eventType: 'payment.created',
      paymentStatus: 'APPROVED',
      observedAt: '2026-10-26T04:00:00.000Z',
    }));
    assert.equal(completed.result, 'settled');
    assert.equal(older.result, 'already_settled');
    assert.equal(approvedLater.result, 'already_settled');
    assert.equal(approvedLater.financiallySettled, true);
    assert.equal(approvedLater.settlementCommitted, false);
    assert.equal((await counts()).settlements, 1);
  });

  test('pending then completed settles once', async () => {
    await authorizedPair();
    const pending = await ingestObservation(URL, observation({
      eventId: 'evt-7d-pending',
      paymentStatus: 'PENDING',
      observedAt: '2026-10-26T01:00:00.000Z',
    }));
    const completed = await ingestObservation(URL, observation({
      eventId: 'evt-7d-later',
      observedAt: '2026-10-26T02:00:00.000Z',
    }));
    assert.equal(pending.result, 'pending');
    assert.equal(pending.financiallySettled, false);
    assert.equal(completed.result, 'settled');
    assert.equal((await counts()).settlements, 1);
  });

  test('a provider retrieval that disagrees with the webhook does not settle', async () => {
    await authorizedPair();
    const mismatch = await retrieveAndReconcile(URL, context({
      serverBookingRef: 'TEST-SQ-7D',
      amountCents: 100,
      squarePaymentId: PAYMENT_ID,
      retrievalEventId: 'evt-7d-retrieve',
      observedAt: '2026-10-26T02:00:00.000Z',
      env: { SQUARE_SANDBOX_ACCESS_TOKEN: TOKEN },
      fetchImpl: mockFetch(paymentBody({ amount: 250 })),
    }));
    const webhook = await ingestObservation(URL, observation({
      eventId: 'evt-7d-webhook',
      observedAt: '2026-10-26T02:10:00.000Z',
    }));
    assert.equal(mismatch.settlementCommitted, false);
    assert.equal(webhook.result, 'quarantined');
    assert.equal(webhook.processingStatus, 'inconsistent');
    assert.equal(webhook.settlementCommitted, false);
    assert.equal(webhook.financiallySettled, false);
    assert.equal(webhook.paid, false);
    assert.equal((await counts()).settlements, 0);
  });

  test('a matching mock retrieval settles and a timeout does not', async () => {
    await authorizedPair();
    const matched = await retrieveAndReconcile(URL, context({
      serverBookingRef: 'TEST-SQ-7D',
      amountCents: 100,
      squarePaymentId: PAYMENT_ID,
      retrievalEventId: 'evt-7d-retrieve-ok',
      observedAt: '2026-10-26T02:00:00.000Z',
      env: { SQUARE_SANDBOX_ACCESS_TOKEN: TOKEN },
      fetchImpl: mockFetch(paymentBody()),
    }));
    assert.equal(matched.result, 'settled');
    assert.equal(matched.providerCompleted, true);
    assert.equal(matched.financiallySettled, true);
    assert.equal(matched.paid, false);
    assert.equal(JSON.stringify(matched).includes(TOKEN), false);
    assert.equal(JSON.stringify(matched).includes('receipt'), false);

    await emptySettlementTables(URL);
    await applySettlementSchema(URL);
    await authorizedPair();
    const timeout = await retrieveAndReconcile(URL, context({
      serverBookingRef: 'TEST-SQ-7D',
      amountCents: 100,
      squarePaymentId: PAYMENT_ID,
      retrievalEventId: 'evt-7d-timeout',
      observedAt: '2026-10-26T02:00:00.000Z',
      env: { SQUARE_SANDBOX_ACCESS_TOKEN: TOKEN },
      timeoutMs: 30,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
    }));
    assert.equal(timeout.result, 'failed');
    assert.equal(timeout.retrySafe, true);
    assert.equal(timeout.settlementCommitted, false);
    assert.equal(timeout.financiallySettled, false);
    assert.equal((await counts()).settlements, 0);
  });

  test('commercial financial code is not imported and the provider stays disabled', () => {
    assert.equal(ACTIVE_PAYMENT_PROVIDER, 'none');
    const src = fs.readFileSync(path.join(ROOT, 'sandbox/square-settlement/square-sandbox-settlement.js'), 'utf8');
    assert.equal(src.includes(ADAPTER_COMMIT), true);
    assert.doesNotMatch(src, /require\([^)]*(payment-service|payment-authority-service|@prisma|prisma|stripe|square-sandbox-webhook)/);
    assert.doesNotMatch(src, /PaymentAttempt|LedgerEntry|booking\.paymentStatus/);
    const schema = fs.readFileSync(path.join(ROOT, 'sandbox/square-settlement/schema.sql'), 'utf8');
    assert.doesNotMatch(schema, /drop\s+table|PaymentAttempt|LedgerEntry/i);
    const migrations = fs.readdirSync(path.join(ROOT, 'prisma/migrations')).join('\n');
    assert.equal(migrations.includes('sandbox_settlement'), false);
    for (const file of [
      'netlify/functions/submit-booking.js',
      'netlify/functions/stripe-webhook.js',
      'netlify/lib/payment-provider-adapter.js',
      'netlify/lib/payment-service.js',
      'sandbox/square-webhook/netlify/functions/square-sandbox-webhook.js',
    ]) {
      assert.equal(fs.readFileSync(path.join(ROOT, file), 'utf8').includes('square-sandbox-settlement'), false, file);
    }
    assert.match(
      fs.readFileSync(path.join(ROOT, 'netlify/lib/deploy-runtime-env.generated.js'), 'utf8'),
      /STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED:\s*false/
    );
  });
});
