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
  verifyAndSettle,
} = require('../sandbox/square-settlement/square-sandbox-settlement');
const { ACTIVE_PAYMENT_PROVIDER } = require('../netlify/lib/payment-provider-adapter');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'EAAA_sandbox_mock_token_not_a_real_credential_00';
const PAYMENT_ID = 'sandboxPay7dOnly';
const MERCHANT_ID = 'MERCHANT_TEST_7D';
const LOCATION_ID = 'LOC_TEST_7D';

function settlementTestUrl() {
  const configured = process.env.SQUARE_SETTLEMENT_TEST_PORT;
  const port = configured == null || configured === '' ? '5433' : String(configured);
  if (port !== '5432' && port !== '5433') throw new Error('square_settlement_database_unproven');
  if (process.env.SQUARE_SETTLEMENT_TEST_HOST != null && process.env.SQUARE_SETTLEMENT_TEST_HOST !== '') {
    throw new Error('square_settlement_database_unproven');
  }
  const password = process.env.SQUARE_SETTLEMENT_TEST_PASSWORD;
  let userinfo = 'cardetail1_ci';
  if (password != null && password !== '') {
    if (typeof password !== 'string' || /[\s@:/\\]/.test(password) || /neon|amazonaws|supabase|squareup/i.test(password)) {
      throw new Error('square_settlement_database_unproven');
    }
    userinfo = `cardetail1_ci:${encodeURIComponent(password)}`;
  }
  return `postgresql://${userinfo}@127.0.0.1:${port}/${LOCAL_DATABASE_NAME}`;
}

const URL = settlementTestUrl();

function context(overrides = {}) {
  return {
    testContext: 'noncommercial-test',
    trustedSandbox: {
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
  assert.equal(Object.hasOwn(payment, 'receipt_url'), false);
  return { payment };
}

function mockFetch(body, status = 200) {
  return async () => ({
    status,
    async text() { return JSON.stringify(body); },
  });
}

function provider(operationId, overrides = {}, bodyOverrides = {}) {
  return context({
    operationId,
    env: { SQUARE_SANDBOX_ACCESS_TOKEN: TOKEN },
    fetchImpl: mockFetch(paymentBody(bodyOverrides)),
    ...overrides,
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

function assertUnsettled(outcome) {
  assert.equal(outcome.financiallySettled, false);
  assert.equal(outcome.settlementCommitted, false);
  assert.equal(outcome.paid, false);
  assert.equal(outcome.ledgerWrite, false);
  assert.equal(outcome.bookingWrite, false);
}

describe('isolated Square Sandbox settlement', { concurrency: false }, () => {
  beforeEach(async () => {
    await emptySettlementTables(URL);
    await applySettlementSchema(URL);
  });

  test('the connection gate allows only the dedicated loopback database', () => {
    assert.equal(LOCAL_DATABASE_NAME, 'cardetail1_square_settlement_7d');
    assert.equal(assertLocalSettlementUrl(URL).database, LOCAL_DATABASE_NAME);
    assert.doesNotThrow(() => assertLocalSettlementUrl(
      'postgresql://cardetail1_ci@127.0.0.1:5432/cardetail1_square_settlement_7d'
    ));
    assert.throws(
      () => assertLocalSettlementUrl('postgresql://cardetail1_ci@127.0.0.1:5432/cardetail1_ci'),
      /square_settlement_database_unproven/
    );
    assert.throws(
      () => assertLocalSettlementUrl('postgresql://user@ep-example.neon.tech/cardetail1_square_settlement_7d'),
      /square_settlement_database_unproven/
    );
    assert.throws(
      () => assertLocalSettlementUrl('postgresql://cardetail1_ci@example.com:5433/cardetail1_square_settlement_7d'),
      /square_settlement_database_unproven/
    );
    assert.throws(
      () => assertLocalSettlementUrl('postgresql://user@ep-summer-glade.neon.tech/cardetail1_square_settlement_7d'),
      /square_settlement_database_unproven/
    );
    assert.throws(
      () => assertLocalSettlementUrl('postgresql://user@cardetail1.cluster.us-east-1.rds.amazonaws.com:5432/cardetail1_square_settlement_7d'),
      /square_settlement_database_unproven/
    );
    assert.throws(
      () => assertLocalSettlementUrl('postgresql://cardetail1_ci@127.0.0.1:5434/cardetail1_square_settlement_7d'),
      /square_settlement_database_unproven/
    );
    assert.throws(
      () => assertLocalSettlementUrl('postgresql://cardetail1_ci@127.0.0.1:5432/cardetail1_production'),
      /square_settlement_database_unproven/
    );
    assert.throws(
      () => assertLocalSettlementUrl('postgresql://cardetail1_ci@connect.squareup.com:5432/cardetail1_square_settlement_7d'),
      /square_settlement_database_unproven/
    );
    const databaseSource = fs.readFileSync(path.join(ROOT, 'sandbox/square-settlement/database.js'), 'utf8');
    assert.equal(databaseSource.includes('process.env'), false);
    assert.equal(ADAPTER_COMMIT, 'f68c9b46af83d747e55139eaac5fb724db0e43e4');
    assert.equal(DEPENDS_ON_PULL_REQUEST, 373);
  });

  test('untrusted settlement environment overrides cannot select a database', () => {
    const previous = {
      port: process.env.SQUARE_SETTLEMENT_TEST_PORT,
      host: process.env.SQUARE_SETTLEMENT_TEST_HOST,
      password: process.env.SQUARE_SETTLEMENT_TEST_PASSWORD,
      databaseUrl: process.env.DATABASE_URL,
    };
    try {
      process.env.SQUARE_SETTLEMENT_TEST_PORT = '5434';
      assert.throws(() => settlementTestUrl(), /square_settlement_database_unproven/);
      process.env.SQUARE_SETTLEMENT_TEST_PORT = '5432';
      process.env.SQUARE_SETTLEMENT_TEST_HOST = 'ep-example.neon.tech';
      assert.throws(() => settlementTestUrl(), /square_settlement_database_unproven/);
      delete process.env.SQUARE_SETTLEMENT_TEST_HOST;
      process.env.SQUARE_SETTLEMENT_TEST_PASSWORD = 'cardetail1_ci';
      process.env.DATABASE_URL = 'postgresql://user@ep-example.neon.tech/cardetail1_ci';
      const url = settlementTestUrl();
      const parsed = assertLocalSettlementUrl(url);
      assert.equal(parsed.host, '127.0.0.1');
      assert.equal(parsed.port, '5432');
      assert.equal(parsed.database, LOCAL_DATABASE_NAME);
      assert.equal(url.includes('neon'), false);
      process.env.SQUARE_SETTLEMENT_TEST_PASSWORD = 'https://ep-example.neon.tech';
      assert.throws(() => settlementTestUrl(), /square_settlement_database_unproven/);
    } finally {
      for (const [key, name] of [
        ['SQUARE_SETTLEMENT_TEST_PORT', previous.port],
        ['SQUARE_SETTLEMENT_TEST_HOST', previous.host],
        ['SQUARE_SETTLEMENT_TEST_PASSWORD', previous.password],
        ['DATABASE_URL', previous.databaseUrl],
      ]) {
        if (name == null) delete process.env[key];
        else process.env[key] = name;
      }
    }
  });

  test('the full-test job prepares a separate loopback settlement database', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/integration.yml'), 'utf8');
    assert.match(workflow, /DATABASE_URL: postgresql:\/\/cardetail1_ci:cardetail1_ci@127\.0\.0\.1:5432\/cardetail1_ci/);
    const fullTest = workflow.slice(workflow.indexOf('  full_test:'), workflow.indexOf('  financial_invariants:'));
    assert.match(fullTest, /cardetail1_square_settlement_7d/);
    assert.match(fullTest, /SQUARE_SETTLEMENT_TEST_PORT: '5432'/);
    assert.equal(fullTest.includes('SQUARE_SETTLEMENT_TEST_PASSWORD: cardetail1_ci'), false);
    assert.match(fullTest, /const password = decodeURIComponent\(commercial\.password \|\| ''\)/);
    assert.match(fullTest, /echo "::add-mask::\$SQUARE_SETTLEMENT_TEST_PASSWORD"/);
    assert.match(fullTest, /nsenter -t "\$pid" -n/);
    assert.equal(fullTest.includes('schema.sql'), false);
    assert.equal(fullTest.includes('neon.tech'), false);
    for (const marker of ['  financial_invariants:', '  portal_parity:', '  netlify_build:', '  stripe_test_mode:']) {
      assert.equal(workflow.includes(marker), true, marker);
    }
    const financial = workflow.slice(workflow.indexOf('  financial_invariants:'), workflow.indexOf('  portal_parity:'));
    const portal = workflow.slice(workflow.indexOf('  portal_parity:'), workflow.indexOf('  netlify_build:'));
    const netlify = workflow.slice(workflow.indexOf('  netlify_build:'), workflow.indexOf('  stripe_test_mode:'));
    const stripe = workflow.slice(workflow.indexOf('  stripe_test_mode:'));
    for (const section of [financial, portal, netlify, stripe]) {
      assert.equal(section.includes('cardetail1_square_settlement_7d'), false);
    }
  });

  test('an obligation and operation are stored before any settlement', async () => {
    const { obligation, operation, associated } = await authorizedPair();
    assert.equal(obligation.result, 'stored');
    assert.equal(operation.result, 'stored');
    assert.equal(associated.result, 'pending');
    assertUnsettled(associated);
    const state = await counts();
    assert.equal(state.settlements, 0);
    assert.equal(state.obligations, 1);
    assert.equal(state.operations, 1);
    assert.equal(state.commercial_attempt, null);
  });

  test('an unverified COMPLETED observation does not settle', async () => {
    await authorizedPair();
    const stored = await ingestObservation(URL, observation());
    assert.equal(stored.result, 'stored');
    assert.equal(stored.processingStatus, 'verification_required');
    assert.equal(stored.providerCompleted, false);
    assertUnsettled(stored);
    assert.equal((await counts()).settlements, 0);
    assert.equal((await counts()).events, 1);
  });

  test('a verified COMPLETED retrieval settles from the stored payment', async () => {
    const { obligation, operation } = await authorizedPair();
    let calls = 0;
    const settled = await verifyAndSettle(URL, provider(operation.operationId, {
      amountCents: 1,
      squarePaymentId: PAYMENT_ID,
      fetchImpl: async () => {
        calls += 1;
        return { status: 200, async text() { return JSON.stringify(paymentBody()); } };
      },
    }));
    assert.equal(calls, 1);
    assert.equal(settled.result, 'settled');
    assert.equal(settled.providerCompleted, true);
    assert.equal(settled.financiallySettled, true);
    assert.equal(settled.settlementCommitted, true);
    assert.equal(settled.paid, false);
    assert.equal(settled.operationId, operation.operationId);
    assert.equal(settled.obligationId, obligation.obligationId);
    assert.equal(settled.squarePaymentId, PAYMENT_ID);
    assert.equal(JSON.stringify(settled).includes(TOKEN), false);
    assert.equal(JSON.stringify(settled).includes('receipt'), false);
    assert.equal((await counts()).settlements, 1);
  });

  test('an unknown payment identity and a provider id mismatch do not settle', async () => {
    const { operation } = await authorizedPair();
    const missing = await verifyAndSettle(URL, provider('op-missing'));
    assert.equal(missing.error, 'square_settlement_operation_unknown');
    assertUnsettled(missing);
    const unassociated = await createOperation(URL, context({
      obligationId: (await createObligation(URL, context({
        bookingRef: 'TEST-SQ-7D-C',
        purpose: PURPOSE,
        amountCents: 100,
        currency: 'USD',
      }))).obligationId,
      idempotencyKey: 'sandbox-op-open-only',
    }));
    const open = await verifyAndSettle(URL, provider(unassociated.operationId));
    assert.equal(open.error, 'square_settlement_payment_unassociated');
    assertUnsettled(open);
    let calls = 0;
    const mismatch = await verifyAndSettle(URL, provider(operation.operationId, {
      squarePaymentId: 'sandboxPayOther',
      fetchImpl: async () => {
        calls += 1;
        return { status: 200, async text() { return JSON.stringify(paymentBody()); } };
      },
    }));
    assert.equal(calls, 0);
    assert.equal(mismatch.error, 'square_settlement_payment_id_mismatch');
    assertUnsettled(mismatch);
    const returned = await verifyAndSettle(URL, provider(operation.operationId, {}, { id: 'sandboxPayOther' }));
    assert.equal(returned.result, 'quarantined');
    assert.equal(returned.error, 'square_settlement_payment_id_mismatch');
    assertUnsettled(returned);
    assert.equal((await counts()).settlements, 0);
  });

  test('wrong amount, currency, merchant, and location do not settle', async () => {
    const { operation } = await authorizedPair();
    const cases = [
      [provider(operation.operationId, {}, { amount: 250 }), 'square_settlement_amount_mismatch'],
      [provider(operation.operationId, {}, { currency: 'EUR' }), 'square_settlement_currency_mismatch'],
      [provider(operation.operationId, {}, { locationId: 'LOC_TEST_OTHER' }), 'square_settlement_location_mismatch'],
    ];
    for (const [input, error] of cases) {
      await emptySettlementTables(URL);
      await applySettlementSchema(URL);
      const paired = await authorizedPair();
      const outcome = await verifyAndSettle(URL, { ...input, operationId: paired.operation.operationId });
      assert.equal(outcome.result, 'quarantined', error);
      assert.equal(outcome.error, error);
      assertUnsettled(outcome);
      assert.equal((await counts()).settlements, 0, error);
    }
    await emptySettlementTables(URL);
    await applySettlementSchema(URL);
    const paired = await authorizedPair();
    const merchant = await verifyAndSettle(URL, provider(paired.operation.operationId, {
      trustedSandbox: {
        merchantId: 'MERCHANT_TEST_OTHER',
        locationId: LOCATION_ID,
        locationMerchantId: 'MERCHANT_TEST_OTHER',
      },
    }));
    assert.equal(merchant.result, 'quarantined');
    assertUnsettled(merchant);
    const observed = await ingestObservation(URL, observation({
      eventId: 'evt-7d-merchant',
      merchantId: 'MERCHANT_TEST_OTHER',
    }));
    assert.equal(observed.result, 'quarantined');
    assertUnsettled(observed);
    assert.equal((await counts()).settlements, 0);
    assert.equal((await counts()).events >= 1, true);
  });

  test('caller-forged trust markers and timestamps cannot settle', async () => {
    const { operation } = await authorizedPair();
    const forgedSource = await ingestObservation(URL, observation({ sourceKind: 'authenticated_event' }));
    const forgedMarker = await ingestObservation(URL, observation({
      eventId: 'evt-7d-marker',
      trustedSandbox: {
        configuredBy: 'server',
        merchantId: MERCHANT_ID,
        locationId: LOCATION_ID,
        locationMerchantId: MERCHANT_ID,
      },
    }));
    const forgedFlag = await verifyAndSettle(URL, provider(operation.operationId, { verified: true }));
    const future = await ingestObservation(URL, observation({
      eventId: 'evt-7d-future',
      observedAt: '2099-01-01T00:00:00.000Z',
    }));
    const past = await ingestObservation(URL, observation({
      eventId: 'evt-7d-past',
      observedAt: '2000-01-01T00:00:00.000Z',
    }));
    const missingTime = await ingestObservation(URL, observation({
      eventId: 'evt-7d-notime',
      observedAt: undefined,
    }));
    for (const outcome of [forgedSource, forgedMarker, forgedFlag, future, past, missingTime]) {
      assertUnsettled(outcome);
    }
    assert.equal(forgedSource.error, 'square_settlement_authentication_marker_rejected');
    assert.equal(forgedMarker.error, 'square_settlement_authentication_marker_rejected');
    assert.equal(forgedFlag.error, 'square_settlement_authentication_marker_rejected');
    assert.equal(future.processingStatus, 'verification_required');
    assert.equal(past.processingStatus, 'verification_required');
    assert.equal(missingTime.processingStatus, 'verification_required');
    assert.equal((await counts()).settlements, 0);
  });

  test('conflicting webhook observations stay stored and do not settle', async () => {
    const { operation } = await authorizedPair();
    const first = await ingestObservation(URL, observation({ eventId: 'evt-7d-amount-a', amountCents: 100 }));
    const second = await ingestObservation(URL, observation({
      eventId: 'evt-7d-amount-b',
      amountCents: 250,
      observedAt: '2099-01-01T00:00:00.000Z',
    }));
    assert.equal(first.processingStatus, 'verification_required');
    assert.equal(second.result, 'quarantined');
    assertUnsettled(first);
    assertUnsettled(second);
    assert.equal((await counts()).events, 2);
    assert.equal((await counts()).settlements, 0);
    const disagreed = await verifyAndSettle(URL, provider(operation.operationId, {}, { amount: 250 }));
    assert.equal(disagreed.result, 'quarantined');
    assertUnsettled(disagreed);
    const verified = await verifyAndSettle(URL, provider(operation.operationId));
    assert.equal(verified.result, 'settled');
    assert.equal(verified.settlementCommitted, true);
    const client = await connectProven(URL);
    try {
      const conflict = await client.query(
        "SELECT count(*)::int AS conflicts FROM sandbox_payment_event WHERE processing_status = 'inconsistent'"
      );
      assert.equal(conflict.rows[0].conflicts >= 1, true);
    } finally {
      await client.end();
    }
    assert.equal((await counts()).settlements, 1);
  });

  test('payment.created and payment.updated settle only after verification', async () => {
    const createdPair = await authorizedPair(PAYMENT_ID, 'sandbox-op-created');
    const created = await ingestObservation(URL, observation({
      eventId: 'evt-7d-created',
      eventType: 'payment.created',
    }));
    assert.equal(created.processingStatus, 'verification_required');
    assertUnsettled(created);
    const createdSettled = await ingestObservation(URL, provider(createdPair.operation.operationId, observation({
      eventId: 'evt-7d-created-ok',
      eventType: 'payment.created',
    })));
    assert.equal(createdSettled.result, 'settled');
    assert.equal(createdSettled.settlementCommitted, true);

    await emptySettlementTables(URL);
    await applySettlementSchema(URL);
    const updatedPair = await authorizedPair(PAYMENT_ID, 'sandbox-op-updated');
    const updated = await ingestObservation(URL, observation({
      eventId: 'evt-7d-updated',
      eventType: 'payment.updated',
    }));
    assertUnsettled(updated);
    const updatedSettled = await ingestObservation(URL, provider(updatedPair.operation.operationId, observation({
      eventId: 'evt-7d-updated-ok',
      eventType: 'payment.updated',
    })));
    assert.equal(updatedSettled.result, 'settled');
    assert.equal((await counts()).settlements, 1);
  });

  test('APPROVED, PENDING, FAILED, and CANCELED do not settle', async () => {
    for (const status of ['APPROVED', 'PENDING', 'FAILED', 'CANCELED']) {
      await emptySettlementTables(URL);
      await applySettlementSchema(URL);
      const { operation } = await authorizedPair();
      const observed = await ingestObservation(URL, observation({
        eventId: `evt-7d-${status}`,
        paymentStatus: status,
      }));
      const verified = await verifyAndSettle(URL, provider(operation.operationId, {}, { status }));
      assertUnsettled(observed);
      assertUnsettled(verified);
      if (status === 'APPROVED' || status === 'PENDING') {
        assert.equal(observed.result, 'pending', status);
        assert.equal(verified.result, 'pending', status);
      } else {
        assert.equal(observed.result, 'rejected', status);
        assert.equal(verified.result, 'rejected', status);
      }
      assert.equal((await counts()).settlements, 0, status);
    }
  });

  test('duplicate and distinct events leave one settlement', async () => {
    const { operation } = await authorizedPair();
    const first = await ingestObservation(URL, observation({ eventId: 'evt-7d-a' }));
    const duplicate = await ingestObservation(URL, observation({
      eventId: 'evt-7d-a',
      paymentStatus: 'APPROVED',
    }));
    assertUnsettled(first);
    assertUnsettled(duplicate);
    assert.equal((await counts()).events, 1);
    const settled = await verifyAndSettle(URL, provider(operation.operationId));
    const otherEvent = await ingestObservation(URL, observation({
      eventId: 'evt-7d-b',
      eventType: 'payment.created',
      observedAt: '2026-10-26T02:00:00.000Z',
    }));
    assert.equal(settled.settlementCommitted, true);
    assert.equal(otherEvent.result, 'already_settled');
    assert.equal(otherEvent.financiallySettled, true);
    assert.equal(otherEvent.settlementCommitted, false);
    assert.equal((await counts()).settlements, 1);
    assert.equal((await counts()).events >= 2, true);
  });

  test('concurrent verification leaves one settlement row', async () => {
    const { operation } = await authorizedPair();
    const [left, right] = await Promise.all([
      verifyAndSettle(URL, provider(operation.operationId)),
      verifyAndSettle(URL, provider(operation.operationId)),
    ]);
    const results = [left.result, right.result].sort();
    assert.deepEqual(results, ['already_settled', 'settled']);
    assert.equal(left.financiallySettled, true);
    assert.equal(right.financiallySettled, true);
    assert.equal(left.settlementCommitted !== right.settlementCommitted, true);
    assert.equal((await counts()).settlements, 1);
  });

  test('a second payment cannot settle an obligation, and one payment cannot bind two obligations', async () => {
    const { obligation, operation } = await authorizedPair();
    await verifyAndSettle(URL, provider(operation.operationId));
    const secondOperation = await createOperation(URL, context({
      obligationId: obligation.obligationId,
      idempotencyKey: 'sandbox-op-7d-second',
    }));
    assert.equal(secondOperation.result, 'rejected');
    assert.equal(secondOperation.financiallySettled, true);
    assert.equal(secondOperation.settlementCommitted, false);
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
    assertUnsettled(stolen);
    const settled = await verifyAndSettle(URL, provider(first.operation.operationId));
    assert.equal(settled.obligationId, first.obligation.obligationId);
    assert.equal((await counts()).settlements, 1);
  });

  test('settlement rollback can be retried, and a conflicting row is read back', async () => {
    const { operation } = await authorizedPair();
    await ingestObservation(URL, observation({ eventId: 'evt-7d-kept' }));
    const failed = await verifyAndSettle(URL, provider(operation.operationId, { fault: 'before_commit' }));
    assert.equal(failed.result, 'failed');
    assert.equal(failed.error, 'square_settlement_rolled_back');
    assertUnsettled(failed);
    assert.equal(failed.retrySafe, true);
    assert.equal((await counts()).settlements, 0);
    assert.equal((await counts()).events, 1);
    const retried = await verifyAndSettle(URL, provider(operation.operationId));
    assert.equal(retried.result, 'settled');
    assert.equal(retried.settlementCommitted, true);
    const again = await verifyAndSettle(URL, provider(operation.operationId));
    assert.equal(again.result, 'already_settled');
    assert.equal(again.financiallySettled, true);
    assert.equal(again.settlementCommitted, false);
    assert.equal(again.obligationId, retried.obligationId);
    assert.equal(again.operationId, retried.operationId);
    assert.equal(again.squarePaymentId, PAYMENT_ID);
    assert.equal((await counts()).settlements, 1);

    await emptySettlementTables(URL);
    await applySettlementSchema(URL);
    const conflicted = await authorizedPair(PAYMENT_ID, 'sandbox-op-conflict');
    const client = await connectProven(URL);
    try {
      await client.query(
        `INSERT INTO sandbox_settlement
          (settlement_id, obligation_id, operation_id, square_payment_id, settled_amount_cents, currency)
         VALUES ('stl-manual', $1, $2, $3, 50, 'USD')`,
        [conflicted.obligation.obligationId, conflicted.operation.operationId, PAYMENT_ID]
      );
    } finally {
      await client.end();
    }
    const conflict = await verifyAndSettle(URL, provider(conflicted.operation.operationId));
    assert.equal(conflict.result, 'rejected');
    assert.equal(conflict.error, 'square_settlement_conflict');
    assertUnsettled(conflict);
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

  test('an early event waits for association and verified completion', async () => {
    const early = await ingestObservation(URL, observation({ eventId: 'evt-7d-early' }));
    assert.equal(early.result, 'stored');
    assert.equal(early.processingStatus, 'awaiting_association');
    assertUnsettled(early);
    assert.equal((await counts()).operations, 0);
    assert.equal((await counts()).settlements, 0);
    const obligation = await createObligation(URL, context({
      bookingRef: 'TEST-SQ-7D',
      purpose: PURPOSE,
      amountCents: 100,
      currency: 'USD',
    }));
    const operation = await createOperation(URL, context({
      obligationId: obligation.obligationId,
      idempotencyKey: 'sandbox-op-7d-001',
    }));
    const waiting = await associatePayment(URL, context({
      operationId: operation.operationId,
      squarePaymentId: PAYMENT_ID,
    }));
    assert.equal(waiting.processingStatus, 'verification_required');
    assertUnsettled(waiting);
    const associated = await associatePayment(URL, provider(operation.operationId, {
      squarePaymentId: PAYMENT_ID,
    }));
    assert.equal(associated.result, 'settled');
    assert.equal(associated.settlementCommitted, true);
    const repeated = await verifyAndSettle(URL, provider(operation.operationId));
    assert.equal(repeated.result, 'already_settled');
    assert.equal(repeated.financiallySettled, true);
    assert.equal(repeated.settlementCommitted, false);
    assert.equal((await counts()).settlements, 1);
    assert.equal((await counts()).events >= 2, true);
  });

  test('event order and forged timestamps do not regress a committed settlement', async () => {
    const { operation } = await authorizedPair();
    const pending = await ingestObservation(URL, observation({
      eventId: 'evt-7d-pending',
      paymentStatus: 'PENDING',
      observedAt: '2026-10-26T03:00:00.000Z',
    }));
    const completed = await ingestObservation(URL, observation({
      eventId: 'evt-7d-completed-later',
      observedAt: '2026-10-26T01:00:00.000Z',
    }));
    assert.equal(pending.result, 'pending');
    assert.equal(completed.processingStatus, 'verification_required');
    assertUnsettled(pending);
    assertUnsettled(completed);
    const settled = await verifyAndSettle(URL, provider(operation.operationId));
    const olderPending = await ingestObservation(URL, observation({
      eventId: 'evt-7d-old-pending',
      paymentStatus: 'PENDING',
      observedAt: '2000-01-01T00:00:00.000Z',
    }));
    const approvedLater = await ingestObservation(URL, observation({
      eventId: 'evt-7d-approved-later',
      eventType: 'payment.created',
      paymentStatus: 'APPROVED',
      observedAt: '2099-01-01T00:00:00.000Z',
    }));
    const sameTime = await ingestObservation(URL, observation({
      eventId: 'evt-7d-same-time',
      observedAt: '2026-10-26T01:00:00.000Z',
    }));
    assert.equal(settled.result, 'settled');
    assert.equal(olderPending.result, 'already_settled');
    assert.equal(approvedLater.result, 'already_settled');
    assert.equal(sameTime.result, 'already_settled');
    assert.equal(approvedLater.financiallySettled, true);
    assert.equal(approvedLater.settlementCommitted, false);
    assert.equal((await counts()).settlements, 1);
  });

  test('a provider retrieval that disagrees with the webhook does not settle', async () => {
    const { operation } = await authorizedPair();
    await ingestObservation(URL, observation({ eventId: 'evt-7d-webhook' }));
    const mismatch = await verifyAndSettle(URL, provider(operation.operationId, {
      timeoutMs: 50,
    }, { amount: 250 }));
    assert.equal(mismatch.result, 'quarantined');
    assertUnsettled(mismatch);
    assert.equal((await counts()).settlements, 0);
    assert.equal((await counts()).events >= 1, true);
  });

  test('a provider timeout does not settle', async () => {
    const { operation } = await authorizedPair();
    const timeout = await verifyAndSettle(URL, provider(operation.operationId, {
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
    assertUnsettled(timeout);
    assert.equal((await counts()).settlements, 0);
  });

  test('settled obligation status without a settlement row is not financially settled', async () => {
    const { obligation } = await authorizedPair();
    const client = await connectProven(URL);
    try {
      await client.query(
        "UPDATE sandbox_payment_obligation SET status = 'settled' WHERE obligation_id = $1",
        [obligation.obligationId]
      );
    } finally {
      await client.end();
    }
    const outcome = await createOperation(URL, context({
      obligationId: obligation.obligationId,
      idempotencyKey: 'sandbox-op-status-only',
    }));
    assert.equal(outcome.result, 'failed');
    assert.equal(outcome.error, 'square_settlement_state_inconsistent');
    assertUnsettled(outcome);
    assert.equal((await counts()).settlements, 0);
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
    const receipt = await ingestObservation(URL, observation({
      payment: { receipt_url: 'https://example.invalid/receipt' },
    }));
    assert.equal(receipt.error, 'square_settlement_receipt_not_proof');
    assertUnsettled(receipt);
    assert.equal((await counts()).settlements, 0);
  });

  test('commercial financial code is not imported and the provider stays disabled', () => {
    assert.equal(ACTIVE_PAYMENT_PROVIDER, 'none');
    const src = fs.readFileSync(path.join(ROOT, 'sandbox/square-settlement/square-sandbox-settlement.js'), 'utf8');
    assert.equal(src.includes(ADAPTER_COMMIT), true);
    assert.equal(src.includes("configuredBy: 'server'"), true);
    assert.doesNotMatch(src, /sourceKind === 'authenticated_event'/);
    assert.doesNotMatch(src, /trusted\.configuredBy/);
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
