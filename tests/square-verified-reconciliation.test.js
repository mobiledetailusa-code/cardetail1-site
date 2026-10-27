'use strict';

const { describe, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ACTIVE_PAYMENT_PROVIDER } = require('../netlify/lib/payment-provider-adapter');
const {
  LOCAL_DATABASE_NAME,
  connectProven,
  applySettlementSchema,
  emptySettlementTables,
} = require('../sandbox/square-settlement/database');
const {
  PURPOSE,
  createObligation,
  createOperation,
  verifyAndSettle,
} = require('../sandbox/square-settlement/square-sandbox-settlement');
const {
  SYNTHETIC_RETRIEVAL_TOKEN,
  associateTrustedPayment,
  receiveVerifiedWebhook,
} = require('../sandbox/square-reconciliation/square-verified-bridge');

const ROOT = path.join(__dirname, '..');
const NOTIFICATION_URL = 'https://square-bridge-7e.example.test/hooks/square';
const KEY = 'synthetic-square-webhook-7e-not-a-real-key';
const PAYMENT_ID = 'sandboxPay7eOnly';
const MERCHANT_ID = 'MERCHANT_TEST_7E';
const LOCATION_ID = 'LOC_TEST_7E';
const FINGERPRINT = 'fp-must-not-leak';

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

const SETTLEMENT_URL = settlementTestUrl();

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

function sign(url, body, key = KEY) {
  return crypto.createHmac('sha256', key).update(Buffer.concat([
    Buffer.from(url, 'utf8'),
    Buffer.from(body, 'utf8'),
  ])).digest('base64');
}

function fixture(overrides = {}) {
  const paymentId = overrides.paymentId || PAYMENT_ID;
  const payment = {
    id: paymentId,
    status: overrides.status || 'COMPLETED',
    reference_id: Object.prototype.hasOwnProperty.call(overrides, 'referenceId')
      ? overrides.referenceId
      : 'TEST-NOT-A-BOOKING',
    amount_money: {
      amount: Object.prototype.hasOwnProperty.call(overrides, 'amount') ? overrides.amount : 100,
      currency: overrides.currency || 'USD',
    },
    card_details: { card: { fingerprint: FINGERPRINT } },
  };
  if (overrides.locationId !== null) payment.location_id = overrides.locationId || LOCATION_ID;
  if (overrides.paymentMerchantId) payment.merchant_id = overrides.paymentMerchantId;
  return JSON.stringify({
    merchant_id: overrides.merchantId || MERCHANT_ID,
    type: overrides.type || 'payment.updated',
    event_id: overrides.eventId || 'evt-7e-completed',
    created_at: overrides.createdAt || '2026-10-26T12:00:00.000Z',
    data: {
      type: 'payment',
      id: paymentId,
      object: { payment },
    },
  });
}

function webhookInput(body, extra = {}) {
  const notificationUrl = Object.prototype.hasOwnProperty.call(extra, 'notificationUrl')
    ? extra.notificationUrl
    : NOTIFICATION_URL;
  const signatureKey = Object.prototype.hasOwnProperty.call(extra, 'signatureKey')
    ? extra.signatureKey
    : KEY;
  const rawBody = Object.prototype.hasOwnProperty.call(extra, 'rawBody') ? extra.rawBody : body;
  const signedBody = typeof rawBody === 'string' && !Object.prototype.hasOwnProperty.call(extra, 'signature')
    && !Object.prototype.hasOwnProperty.call(extra, 'rawBody')
    ? rawBody
    : body;
  const signedUrl = extra.signedUrl || NOTIFICATION_URL;
  const signature = Object.prototype.hasOwnProperty.call(extra, 'signature')
    ? extra.signature
    : sign(signedUrl, signedBody, signatureKey || KEY);
  return context({
    rawBody,
    notificationUrl,
    signatureKey,
    headers: extra.headers || { 'x-square-hmacsha256-signature': signature },
    ...(extra.input || {}),
  });
}

function paymentBody(overrides = {}) {
  const payment = {
    id: overrides.id || PAYMENT_ID,
    status: overrides.status || 'COMPLETED',
    location_id: overrides.locationId || LOCATION_ID,
    amount_money: {
      amount: Object.prototype.hasOwnProperty.call(overrides, 'amount') ? overrides.amount : 100,
      currency: overrides.currency || 'USD',
    },
  };
  if (overrides.includeMerchantId === true) payment.merchant_id = 'MERCHANT_IGNORED';
  return { payment };
}

function mockFetch(overrides = {}, capture = null) {
  return async (url, init) => {
    if (capture) {
      capture.calls.push({
        url: String(url),
        method: init && init.method,
        hasBody: init && init.body != null,
      });
    }
    const text = Object.prototype.hasOwnProperty.call(overrides, 'rawText')
      ? overrides.rawText
      : JSON.stringify(paymentBody(overrides));
    return {
      status: overrides.httpStatus || 200,
      async text() { return text; },
    };
  };
}

function assertUnsettled(outcome) {
  assert.equal(outcome.financiallySettled, false);
  assert.equal(outcome.settlementCommitted, false);
  assert.equal(outcome.paid, false);
  assert.equal(outcome.ledgerWrite, false);
  assert.equal(outcome.bookingWrite, false);
  assert.equal(outcome.commercialDatabaseWrite, false);
  assert.equal(JSON.stringify(outcome).includes(FINGERPRINT), false);
  assert.equal(JSON.stringify(outcome).includes(SYNTHETIC_RETRIEVAL_TOKEN), false);
  assert.equal(JSON.stringify(outcome).includes(KEY), false);
}

async function state() {
  const client = await connectProven(SETTLEMENT_URL);
  try {
    const result = await client.query(
      `SELECT
         (SELECT count(*)::int FROM sandbox_settlement) AS settlements,
         (SELECT count(*)::int FROM sandbox_payment_event) AS events,
         (SELECT count(*)::int FROM sandbox_payment_operation) AS operations,
         (SELECT count(*)::int FROM sandbox_payment_obligation) AS obligations,
         (SELECT count(*)::int FROM sandbox_payment_obligation WHERE booking_ref = 'TEST-NOT-A-BOOKING') AS forged_bookings,
         to_regclass('public."PaymentAttempt"') AS commercial_attempt,
         to_regclass('public."LedgerEntry"') AS commercial_ledger`
    );
    const identity = await client.query(
      'SELECT current_database() AS database, inet_server_addr()::text AS address, inet_server_port()::text AS port'
    );
    return { ...result.rows[0], ...identity.rows[0] };
  } finally {
    await client.end();
  }
}

async function waitForLockState(client, sql, description) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const observed = await client.query(sql);
    if (observed.rows[0]) return observed.rows[0];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function openOperation(key = 'sandbox-op-7e-001', bookingRef = 'TEST-SQ-7E') {
  const obligation = await createObligation(SETTLEMENT_URL, context({
    bookingRef,
    purpose: PURPOSE,
    amountCents: 100,
    currency: 'USD',
  }));
  assert.equal(obligation.result, 'stored');
  const operation = await createOperation(SETTLEMENT_URL, context({
    obligationId: obligation.obligationId,
    idempotencyKey: key,
  }));
  assert.equal(operation.result, 'stored');
  return { obligation, operation };
}

async function storedOperation(paymentId = PAYMENT_ID, key = 'sandbox-op-7e-001') {
  const opened = await openOperation(key);
  const associated = await associateTrustedPayment(SETTLEMENT_URL, context({
    operationId: opened.operation.operationId,
    squarePaymentId: paymentId,
  }));
  assert.equal(associated.financiallySettled, false);
  return { ...opened, associated };
}

describe('verified Square reconciliation bridge', { concurrency: false }, () => {
  beforeEach(async () => {
    await emptySettlementTables(SETTLEMENT_URL);
    await applySettlementSchema(SETTLEMENT_URL);
  });

  test('a valid synthetic HMAC is accepted and does not settle by itself', async () => {
    const { operation, obligation } = await storedOperation();
    const outcome = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture()));
    assert.equal(outcome.signatureAccepted, true);
    assert.equal(outcome.error, '');
    assert.equal(outcome.processingStatus, 'verification_required');
    assert.equal(outcome.operationId, operation.operationId);
    assert.equal(outcome.obligationId, obligation.obligationId);
    assertUnsettled(outcome);
    assert.equal((await state()).settlements, 0);
    assert.equal((await state()).events, 1);
  });

  test('an invalid HMAC is rejected and cannot become eligible later', async () => {
    const body = fixture();
    let calls = 0;
    const invalid = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(body, {
      signature: sign(NOTIFICATION_URL, body, 'synthetic-square-webhook-wrong-key-value'),
      input: { fetchImpl: async () => { calls += 1; return { status: 200, async text() { return '{}'; } }; } },
    }));
    assert.equal(invalid.signatureAccepted, false);
    assert.equal(invalid.error, 'square_webhook_signature_invalid');
    assert.equal(calls, 0);
    assertUnsettled(invalid);
    const { operation } = await storedOperation();
    const later = await associateTrustedPayment(SETTLEMENT_URL, context({
      operationId: operation.operationId,
      squarePaymentId: PAYMENT_ID,
      fetchImpl: mockFetch(),
    }));
    assert.equal(later.result, 'pending');
    assertUnsettled(later);
    assert.equal((await state()).events, 0);
    assert.equal((await state()).settlements, 0);
  });

  test('a missing signature header is rejected even when a signature argument is present', async () => {
    const body = fixture();
    const input = webhookInput(body, { headers: {} });
    input.signature = sign(NOTIFICATION_URL, body);
    const outcome = await receiveVerifiedWebhook(SETTLEMENT_URL, input);
    assert.equal(outcome.signatureAccepted, false);
    assert.equal(outcome.error, 'square_webhook_signature_missing');
    assertUnsettled(outcome);
    assert.equal((await state()).events, 0);
  });

  test('an altered raw body fails signature validation', async () => {
    const body = fixture();
    const outcome = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(body, {
      rawBody: body.replace('COMPLETED', 'APPROVED'),
      signature: sign(NOTIFICATION_URL, body),
    }));
    assert.equal(outcome.signatureAccepted, false);
    assert.equal(outcome.error, 'square_webhook_signature_invalid');
    assertUnsettled(outcome);
    assert.equal((await state()).events, 0);
  });

  test('the wrong notification URL fails signature validation', async () => {
    const body = fixture();
    const outcome = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(body, {
      signedUrl: NOTIFICATION_URL,
      notificationUrl: 'https://other.example.test/hooks/square',
    }));
    assert.equal(outcome.signatureAccepted, false);
    assert.equal(outcome.error, 'square_webhook_signature_invalid');
    assertUnsettled(outcome);
    const insecure = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(body, {
      notificationUrl: 'http://square-bridge-7e.example.test/hooks/square',
    }));
    assert.equal(insecure.error, 'square_webhook_notification_url_rejected');
    assertUnsettled(insecure);
    assert.equal((await state()).events, 0);
  });

  test('the wrong merchant is rejected and cannot select the stored operation', async () => {
    const unknown = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture({ merchantId: 'MERCHANT_TEST_OTHER' })));
    assert.equal(unknown.signatureAccepted, true);
    assert.equal(unknown.error, 'square_webhook_merchant_unexpected');
    assertUnsettled(unknown);
    assert.equal((await state()).events, 0);

    await storedOperation();
    const mismatched = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture({
      eventId: 'evt-7e-merchant',
      merchantId: 'MERCHANT_TEST_OTHER',
    }), {
      input: {
        trustedSandbox: {
          merchantId: 'MERCHANT_TEST_OTHER',
          locationId: LOCATION_ID,
          locationMerchantId: 'MERCHANT_TEST_OTHER',
        },
        fetchImpl: mockFetch(),
      },
    }));
    assert.equal(mismatched.result, 'quarantined');
    assert.equal(mismatched.error, 'square_settlement_observations_conflict');
    assertUnsettled(mismatched);
    const unrelated = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture(), {
      input: {
        trustedSandbox: {
          merchantId: MERCHANT_ID,
          locationId: LOCATION_ID,
          locationMerchantId: 'MERCHANT_TEST_OTHER',
        },
      },
    }));
    assert.equal(unrelated.error, 'square_bridge_merchant_untrusted');
    assert.equal((await state()).settlements, 0);
  });

  test('a webhook before association is stored and does not settle', async () => {
    const capture = { calls: [] };
    const early = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture(), {
      input: { fetchImpl: mockFetch({}, capture) },
    }));
    assert.equal(early.signatureAccepted, true);
    assert.equal(early.result, 'stored');
    assert.equal(early.processingStatus, 'awaiting_association');
    assert.equal(capture.calls.length, 0);
    assertUnsettled(early);
    const rows = await state();
    assert.equal(rows.events, 1);
    assert.equal(rows.operations, 0);
    assert.equal(rows.obligations, 0);
    assert.equal(rows.settlements, 0);
    assert.equal(rows.forged_bookings, 0);
  });

  test('a verified COMPLETED retrieval settles the stored payment once', async () => {
    const { operation, obligation } = await storedOperation();
    const capture = { calls: [] };
    const settled = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture({
      referenceId: 'TEST-NOT-A-BOOKING',
    }), {
      input: { fetchImpl: mockFetch({ includeMerchantId: true }, capture) },
    }));
    assert.equal(settled.signatureAccepted, true);
    assert.equal(settled.result, 'settled');
    assert.equal(settled.providerCompleted, true);
    assert.equal(settled.financiallySettled, true);
    assert.equal(settled.settlementCommitted, true);
    assert.equal(settled.paid, false);
    assert.equal(settled.operationId, operation.operationId);
    assert.equal(settled.obligationId, obligation.obligationId);
    assert.equal(settled.squarePaymentId, PAYMENT_ID);
    assert.equal(capture.calls.length, 1);
    assert.equal(capture.calls[0].method, 'GET');
    assert.equal(capture.calls[0].hasBody, false);
    assert.equal(new URL(capture.calls[0].url).pathname, `/v2/payments/${PAYMENT_ID}`);
    assert.equal(new URL(capture.calls[0].url).origin, 'https://connect.squareupsandbox.com');
    const rows = await state();
    assert.equal(rows.settlements, 1);
    assert.equal(rows.forged_bookings, 0);
    assert.equal(JSON.stringify(settled).includes('receipt'), false);
  });

  test('an APPROVED provider payment does not settle', async () => {
    await storedOperation();
    const capture = { calls: [] };
    const fromWebhook = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture({
      eventId: 'evt-7e-approved-webhook',
      status: 'APPROVED',
    }), { input: { fetchImpl: mockFetch({ status: 'COMPLETED' }, capture) } }));
    assert.equal(capture.calls.length, 0);
    assert.equal(fromWebhook.result, 'pending');
    assertUnsettled(fromWebhook);
    await emptySettlementTables(SETTLEMENT_URL);
    await applySettlementSchema(SETTLEMENT_URL);
    await storedOperation();
    const fromProvider = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture({
      eventId: 'evt-7e-approved-provider',
    }), { input: { fetchImpl: mockFetch({ status: 'APPROVED' }) } }));
    assert.equal(fromProvider.result, 'pending');
    assert.equal(fromProvider.providerCompleted, false);
    assertUnsettled(fromProvider);
    assert.equal((await state()).settlements, 0);
  });

  test('a PENDING provider payment does not settle', async () => {
    await storedOperation();
    const capture = { calls: [] };
    const fromWebhook = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture({
      eventId: 'evt-7e-pending-webhook',
      status: 'PENDING',
    }), { input: { fetchImpl: mockFetch({}, capture) } }));
    assert.equal(capture.calls.length, 0);
    assert.equal(fromWebhook.result, 'pending');
    assertUnsettled(fromWebhook);
    await emptySettlementTables(SETTLEMENT_URL);
    await applySettlementSchema(SETTLEMENT_URL);
    await storedOperation();
    const fromProvider = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture({
      eventId: 'evt-7e-pending-provider',
    }), { input: { fetchImpl: mockFetch({ status: 'PENDING' }) } }));
    assert.equal(fromProvider.result, 'pending');
    assertUnsettled(fromProvider);
    assert.equal((await state()).settlements, 0);
  });

  test('a FAILED provider payment does not settle', async () => {
    await storedOperation();
    const fromWebhook = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture({
      eventId: 'evt-7e-failed-webhook',
      status: 'FAILED',
    }), { input: { fetchImpl: mockFetch() } }));
    assert.equal(fromWebhook.result, 'rejected');
    assertUnsettled(fromWebhook);
    await emptySettlementTables(SETTLEMENT_URL);
    await applySettlementSchema(SETTLEMENT_URL);
    await storedOperation();
    const fromProvider = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture({
      eventId: 'evt-7e-failed-provider',
    }), { input: { fetchImpl: mockFetch({ status: 'FAILED' }) } }));
    assert.equal(fromProvider.result, 'rejected');
    assertUnsettled(fromProvider);
    assert.equal((await state()).settlements, 0);
  });

  test('a CANCELED provider payment does not settle', async () => {
    await storedOperation();
    const fromWebhook = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture({
      eventId: 'evt-7e-canceled-webhook',
      status: 'CANCELED',
    }), { input: { fetchImpl: mockFetch() } }));
    assert.equal(fromWebhook.result, 'rejected');
    assertUnsettled(fromWebhook);
    await emptySettlementTables(SETTLEMENT_URL);
    await applySettlementSchema(SETTLEMENT_URL);
    await storedOperation();
    const fromProvider = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture({
      eventId: 'evt-7e-canceled-provider',
    }), { input: { fetchImpl: mockFetch({ status: 'CANCELED' }) } }));
    assert.equal(fromProvider.result, 'rejected');
    assertUnsettled(fromProvider);
    assert.equal((await state()).settlements, 0);
  });

  test('an unexpected provider payment id does not settle', async () => {
    await storedOperation();
    const outcome = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture(), {
      input: { fetchImpl: mockFetch({ id: 'sandboxPayOther' }) },
    }));
    assert.equal(outcome.result, 'quarantined');
    assert.equal(outcome.error, 'square_settlement_payment_id_mismatch');
    assertUnsettled(outcome);
    assert.equal((await state()).settlements, 0);
  });

  test('an amount mismatch does not settle', async () => {
    await storedOperation();
    const outcome = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture(), {
      input: { fetchImpl: mockFetch({ amount: 250 }) },
    }));
    assert.equal(outcome.result, 'quarantined');
    assert.equal(outcome.error, 'square_settlement_amount_mismatch');
    assertUnsettled(outcome);
    assert.equal((await state()).settlements, 0);
  });

  test('a currency mismatch does not settle', async () => {
    await storedOperation();
    const outcome = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture(), {
      input: { fetchImpl: mockFetch({ currency: 'EUR' }) },
    }));
    assert.equal(outcome.result, 'quarantined');
    assert.equal(outcome.error, 'square_settlement_currency_mismatch');
    assertUnsettled(outcome);
    assert.equal((await state()).settlements, 0);
  });

  test('a location mismatch does not settle', async () => {
    await storedOperation();
    const provider = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture(), {
      input: { fetchImpl: mockFetch({ locationId: 'LOC_TEST_OTHER' }) },
    }));
    assert.equal(provider.result, 'quarantined');
    assert.equal(provider.error, 'square_settlement_location_mismatch');
    assertUnsettled(provider);
    const webhook = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture({
      eventId: 'evt-7e-location',
      locationId: 'LOC_TEST_OTHER',
    }), { input: { fetchImpl: mockFetch() } }));
    assert.equal(webhook.error, 'square_bridge_location_untrusted');
    assertUnsettled(webhook);
    assert.equal((await state()).settlements, 0);
  });

  test('a duplicate webhook event does not create a second settlement', async () => {
    await storedOperation();
    const body = fixture({ eventId: 'evt-7e-duplicate', type: 'payment.created' });
    const first = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(body, {
      input: { fetchImpl: mockFetch() },
    }));
    const duplicate = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(body, {
      input: { fetchImpl: mockFetch({ status: 'PENDING' }) },
    }));
    assert.equal(first.result, 'settled');
    assert.equal(first.settlementCommitted, true);
    assert.equal(duplicate.result, 'already_settled');
    assert.equal(duplicate.financiallySettled, true);
    assert.equal(duplicate.settlementCommitted, false);
    const client = await connectProven(SETTLEMENT_URL);
    try {
      const events = await client.query(
        "SELECT count(*)::int AS count FROM sandbox_payment_event WHERE event_id = 'evt-7e-duplicate'"
      );
      assert.equal(events.rows[0].count, 1);
    } finally {
      await client.end();
    }
    assert.equal((await state()).settlements, 1);
  });

  test('two different events for one payment settle once', async () => {
    await storedOperation();
    const created = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture({
      eventId: 'evt-7e-created',
      type: 'payment.created',
    }), { input: { fetchImpl: mockFetch() } }));
    const updated = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture({
      eventId: 'evt-7e-updated',
      type: 'payment.updated',
      createdAt: '2026-10-26T13:00:00.000Z',
    }), { input: { fetchImpl: mockFetch() } }));
    assert.equal(created.result, 'settled');
    assert.equal(updated.result, 'already_settled');
    assert.equal(updated.financiallySettled, true);
    assert.equal(updated.settlementCommitted, false);
    assert.equal((await state()).settlements, 1);
  });

  test('concurrent verification commits one settlement', async () => {
    await storedOperation();
    const [left, right] = await Promise.all([
      receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture({ eventId: 'evt-7e-concurrent-a' }), {
        input: { fetchImpl: mockFetch() },
      })),
      receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture({ eventId: 'evt-7e-concurrent-b' }), {
        input: { fetchImpl: mockFetch() },
      })),
    ]);
    const results = [left.result, right.result].sort();
    assert.deepEqual(results, ['already_settled', 'settled']);
    assert.equal(left.financiallySettled, true);
    assert.equal(right.financiallySettled, true);
    assert.equal(left.settlementCommitted !== right.settlementCommitted, true);
    assert.equal((await state()).settlements, 1);
  });

  test('verification and webhook ingestion cannot recreate the operation-row advisory-lock deadlock', async () => {
    const { operation, obligation } = await storedOperation();
    const blocker = await connectProven(SETTLEMENT_URL);
    const observer = await connectProven(SETTLEMENT_URL);
    let blockerReleased = false;
    let verificationPromise;
    let webhookPromise;
    try {
      const before = await observer.query(
        'SELECT deadlocks::int AS deadlocks FROM pg_stat_database WHERE datname = current_database()'
      );
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT operation_id FROM sandbox_payment_operation WHERE operation_id = $1 FOR UPDATE',
        [operation.operationId]
      );

      verificationPromise = verifyAndSettle(SETTLEMENT_URL, context({
        operationId: operation.operationId,
        env: { SQUARE_SANDBOX_ACCESS_TOKEN: SYNTHETIC_RETRIEVAL_TOKEN },
        fetchImpl: mockFetch(),
      }));

      const verificationWait = await waitForLockState(
        observer,
        `SELECT a.pid,
                EXISTS (
                  SELECT 1 FROM pg_locks held
                  WHERE held.pid = a.pid
                    AND held.locktype = 'advisory'
                    AND held.granted
                ) AS holds_advisory
         FROM pg_stat_activity a
         WHERE a.datname = current_database()
           AND a.wait_event_type = 'Lock'
           AND position('sandbox_payment_operation WHERE operation_id = $1 FOR UPDATE' in a.query) > 0
           AND EXISTS (
             SELECT 1 FROM pg_locks held
             WHERE held.pid = a.pid
               AND held.locktype = 'advisory'
               AND held.granted
           )
         LIMIT 1`,
        'verification to hold the advisory lock while waiting for the operation row'
      );
      assert.equal(verificationWait.holds_advisory, true);

      webhookPromise = receiveVerifiedWebhook(
        SETTLEMENT_URL,
        webhookInput(fixture({ eventId: 'evt-7e-lock-order' }), {
          input: { fetchImpl: mockFetch() },
        })
      );

      const webhookWait = await waitForLockState(
        observer,
        `SELECT a.pid,
                EXISTS (
                  SELECT 1 FROM pg_locks waiting
                  WHERE waiting.pid = a.pid
                    AND waiting.locktype = 'advisory'
                    AND NOT waiting.granted
                ) AS waits_for_advisory
         FROM pg_stat_activity a
         WHERE a.datname = current_database()
           AND a.wait_event_type = 'Lock'
           AND position('pg_advisory_xact_lock' in a.query) > 0
           AND EXISTS (
             SELECT 1 FROM pg_locks waiting
             WHERE waiting.pid = a.pid
               AND waiting.locktype = 'advisory'
               AND NOT waiting.granted
           )
         LIMIT 1`,
        'webhook ingestion to wait behind the verification advisory lock'
      );
      assert.notEqual(webhookWait.pid, verificationWait.pid);
      assert.equal(webhookWait.waits_for_advisory, true);

      await blocker.query('COMMIT');
      blockerReleased = true;
      const outcomes = await Promise.all([verificationPromise, webhookPromise]);
      assert.deepEqual(outcomes.map((outcome) => outcome.result).sort(), ['already_settled', 'settled']);
      assert.equal(outcomes.filter((outcome) => outcome.settlementCommitted).length, 1);
      assert.equal(outcomes.every((outcome) => outcome.financiallySettled), true);
      assert.equal(outcomes.some((outcome) => outcome.result === 'failed'), false);

      const committed = await observer.query(
        `SELECT s.obligation_id, s.operation_id, s.square_payment_id,
                s.settled_amount_cents, s.currency,
                o.status AS obligation_status,
                p.status AS operation_status
         FROM sandbox_settlement s
         JOIN sandbox_payment_obligation o ON o.obligation_id = s.obligation_id
         JOIN sandbox_payment_operation p ON p.operation_id = s.operation_id`
      );
      assert.deepEqual(committed.rows, [{
        obligation_id: obligation.obligationId,
        operation_id: operation.operationId,
        square_payment_id: PAYMENT_ID,
        settled_amount_cents: 100,
        currency: 'USD',
        obligation_status: 'settled',
        operation_status: 'settled',
      }]);

      const after = await observer.query(
        'SELECT deadlocks::int AS deadlocks FROM pg_stat_database WHERE datname = current_database()'
      );
      assert.equal(after.rows[0].deadlocks, before.rows[0].deadlocks);
    } finally {
      if (!blockerReleased) {
        await blocker.query('ROLLBACK').catch(() => {});
      }
      await Promise.allSettled([verificationPromise, webhookPromise].filter(Boolean));
      await blocker.end();
      await observer.end();
    }
  });

  test('a transaction rollback reports no settlement and can be retried once', async () => {
    await storedOperation();
    const failed = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture({ eventId: 'evt-7e-rollback' }), {
      input: { fetchImpl: mockFetch(), fault: 'before_commit' },
    }));
    assert.equal(failed.result, 'failed');
    assert.equal(failed.error, 'square_settlement_rolled_back');
    assert.equal(failed.retrySafe, true);
    assertUnsettled(failed);
    assert.equal((await state()).settlements, 0);
    const retried = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture({
      eventId: 'evt-7e-rollback-retry',
    }), { input: { fetchImpl: mockFetch() } }));
    assert.equal(retried.result, 'settled');
    assert.equal(retried.settlementCommitted, true);
    assert.equal((await state()).settlements, 1);
  });

  test('a provider timeout does not settle or create another charge', async () => {
    await storedOperation();
    const capture = { calls: [] };
    const timeout = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture(), {
      input: {
        timeoutMs: 30,
        fetchImpl: (url, init) => {
          capture.calls.push({ url: String(url), method: init.method });
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            });
          });
        },
      },
    }));
    assert.equal(timeout.result, 'failed');
    assert.equal(timeout.retrySafe, true);
    assertUnsettled(timeout);
    assert.equal(capture.calls.length, 1);
    assert.equal(capture.calls[0].method, 'GET');
    assert.equal((await state()).settlements, 0);
  });

  test('provider retrieval failures are not payment completion', async () => {
    const cases = [
      [{ httpStatus: 400, rawText: JSON.stringify({ errors: [{ code: 'BAD_REQUEST' }] }) }, 'rejected'],
      [{ httpStatus: 401, rawText: JSON.stringify({ errors: [{ code: 'UNAUTHORIZED' }] }) }, 'rejected'],
      [{ httpStatus: 403, rawText: JSON.stringify({ errors: [{ code: 'FORBIDDEN' }] }) }, 'rejected'],
      [{ httpStatus: 404, rawText: JSON.stringify({ errors: [{ code: 'NOT_FOUND' }] }) }, 'quarantined'],
      [{ httpStatus: 429, rawText: JSON.stringify({ errors: [{ code: 'RATE_LIMITED' }] }) }, 'failed'],
      [{ httpStatus: 500, rawText: JSON.stringify({ errors: [{ code: 'SERVER_ERROR' }] }) }, 'failed'],
      [{ httpStatus: 200, rawText: '{not-json' }, 'failed'],
      [{ status: 'CAPTURED' }, 'rejected'],
    ];
    for (const [response, expected] of cases) {
      await emptySettlementTables(SETTLEMENT_URL);
      await applySettlementSchema(SETTLEMENT_URL);
      await storedOperation();
      const capture = { calls: [] };
      const outcome = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture({
        eventId: `evt-7e-http-${response.httpStatus || response.status}`,
      }), { input: { fetchImpl: mockFetch(response, capture) } }));
      assert.equal(outcome.result, expected, JSON.stringify(response));
      assert.equal(outcome.providerCompleted, false, JSON.stringify(response));
      assertUnsettled(outcome);
      assert.equal(capture.calls.every((call) => call.method === 'GET'), true);
      assert.equal((await state()).settlements, 0, JSON.stringify(response));
    }
  });

  test('an early event settles only after trusted association and provider verification', async () => {
    const capture = { calls: [] };
    const early = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture({ eventId: 'evt-7e-early' }), {
      input: { fetchImpl: mockFetch({}, capture) },
    }));
    assert.equal(early.processingStatus, 'awaiting_association');
    assert.equal(capture.calls.length, 0);
    const other = await openOperation('sandbox-op-7e-other', 'TEST-SQ-7E-B');
    const wrong = await associateTrustedPayment(SETTLEMENT_URL, context({
      operationId: other.operation.operationId,
      squarePaymentId: 'sandboxPayOther',
      fetchImpl: mockFetch({}, capture),
    }));
    assert.equal(wrong.financiallySettled, false);
    assert.equal(capture.calls.length, 0);
    assert.equal((await state()).settlements, 0);
    const { operation } = await openOperation();
    const recovered = await associateTrustedPayment(SETTLEMENT_URL, context({
      operationId: operation.operationId,
      squarePaymentId: PAYMENT_ID,
      fetchImpl: mockFetch({}, capture),
    }));
    assert.equal(recovered.result, 'settled');
    assert.equal(recovered.settlementCommitted, true);
    assert.equal(recovered.squarePaymentId, PAYMENT_ID);
    assert.equal(capture.calls.length, 1);
    assert.equal(new URL(capture.calls[0].url).pathname, `/v2/payments/${PAYMENT_ID}`);
    const rows = await state();
    assert.equal(rows.settlements, 1);
    assert.equal(rows.obligations, 2);
    assert.equal(rows.forged_bookings, 0);
    const client = await connectProven(SETTLEMENT_URL);
    try {
      const booking = await client.query(
        `SELECT o.booking_ref
         FROM sandbox_settlement s
         JOIN sandbox_payment_obligation o ON o.obligation_id = s.obligation_id`
      );
      assert.deepEqual(booking.rows.map((row) => row.booking_ref), ['TEST-SQ-7E']);
    } finally {
      await client.end();
    }
  });

  test('conflicting observations do not settle', async () => {
    const first = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture({ eventId: 'evt-7e-conflict-a' })));
    const second = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture({
      eventId: 'evt-7e-conflict-b',
      amount: 250,
      createdAt: '2099-01-01T00:00:00.000Z',
    })));
    assert.equal(first.processingStatus, 'awaiting_association');
    assert.equal(second.processingStatus, 'awaiting_association');
    const { operation } = await openOperation();
    const capture = { calls: [] };
    const associated = await associateTrustedPayment(SETTLEMENT_URL, context({
      operationId: operation.operationId,
      squarePaymentId: PAYMENT_ID,
      fetchImpl: mockFetch({}, capture),
    }));
    assert.equal(associated.result, 'quarantined');
    assert.equal(associated.error, 'square_settlement_observations_conflict');
    assert.equal(capture.calls.length, 0);
    assertUnsettled(associated);
    assert.equal((await state()).settlements, 0);
    assert.equal((await state()).events, 2);
  });

  test('event order, duplicate deliveries, and timestamps cannot regress a settlement', async () => {
    await storedOperation();
    const pending = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture({
      eventId: 'evt-7e-order-pending',
      type: 'payment.created',
      status: 'PENDING',
      createdAt: '2026-10-26T15:00:00.000Z',
    })));
    const completed = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture({
      eventId: 'evt-7e-order-completed',
      type: 'payment.updated',
      createdAt: '2026-10-26T11:00:00.000Z',
    }), { input: { fetchImpl: mockFetch() } }));
    assert.equal(pending.result, 'pending');
    assertUnsettled(pending);
    assert.equal(completed.result, 'settled');
    const regressPending = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture({
      eventId: 'evt-7e-order-pending-later',
      status: 'PENDING',
      createdAt: '2099-01-01T00:00:00.000Z',
    })));
    const regressApproved = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture({
      eventId: 'evt-7e-order-approved-later',
      type: 'payment.created',
      status: 'APPROVED',
      createdAt: '2099-02-01T00:00:00.000Z',
    })));
    const duplicateCreated = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture({
      eventId: 'evt-7e-order-completed',
      type: 'payment.created',
      status: 'PENDING',
    })));
    assert.equal(regressPending.result, 'already_settled');
    assert.equal(regressApproved.result, 'already_settled');
    assert.equal(duplicateCreated.result, 'already_settled');
    assert.equal(regressPending.financiallySettled, true);
    assert.equal(regressPending.settlementCommitted, false);
    assert.equal((await state()).settlements, 1);

    await emptySettlementTables(SETTLEMENT_URL);
    await applySettlementSchema(SETTLEMENT_URL);
    await storedOperation();
    const disagreed = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture({
      eventId: 'evt-7e-disagree',
      createdAt: '2099-01-01T00:00:00.000Z',
    }), { input: { fetchImpl: mockFetch({ amount: 250 }) } }));
    assert.equal(disagreed.result, 'quarantined');
    assertUnsettled(disagreed);
    assert.equal((await state()).settlements, 0);
  });

  test('invalid payloads, unknown events, and caller authority flags do not settle', async () => {
    const invalid = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput('{', {
      rawBody: '{',
      signature: sign(NOTIFICATION_URL, '{'),
    }));
    assert.equal(invalid.signatureAccepted, true);
    assert.equal(invalid.error, 'square_webhook_payload_invalid');
    assertUnsettled(invalid);
    const unknown = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture({
      eventId: 'evt-7e-unknown',
      type: 'refund.created',
    })));
    assert.equal(unknown.error, 'square_webhook_event_unsupported');
    assertUnsettled(unknown);
    const flagged = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture(), {
      input: { verified: true, financiallySettled: true, providerCompleted: true },
    }));
    assert.equal(flagged.error, 'square_bridge_authentication_marker_rejected');
    assertUnsettled(flagged);
    const { operation } = await openOperation();
    const selected = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture({ eventId: 'evt-7e-select' }), {
      input: { operationId: operation.operationId, fetchImpl: mockFetch() },
    }));
    assert.equal(selected.error, 'square_bridge_webhook_cannot_select_operation');
    assertUnsettled(selected);
    const nonSynthetic = await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture(), {
      signatureKey: 'real-looking-square-signature-key',
    }));
    assert.equal(nonSynthetic.error, 'square_bridge_signature_key_not_synthetic');
    assert.equal((await state()).events, 0);
    assert.equal((await state()).settlements, 0);
  });

  test('financial writes stay inside the disposable settlement database', async () => {
    const bridge = fs.readFileSync(path.join(ROOT, 'sandbox/square-reconciliation/square-verified-bridge.js'), 'utf8');
    const receiver = fs.readFileSync(path.join(ROOT, 'sandbox/square-webhook/netlify/functions/square-sandbox-webhook.js'), 'utf8');
    const verifier = fs.readFileSync(path.join(ROOT, 'netlify/lib/square-webhook-verifier.js'), 'utf8');
    assert.equal(ACTIVE_PAYMENT_PROVIDER, 'none');
    assert.match(
      fs.readFileSync(path.join(ROOT, 'netlify/lib/deploy-runtime-env.generated.js'), 'utf8'),
      /STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED:\s*false/
    );
    assert.equal(bridge.includes('process.env'), false);
    assert.equal(bridge.includes('createHmac'), false);
    assert.match(bridge, /verifySquareWebhookSignature/);
    assert.match(bridge, /ingestObservation/);
    assert.match(bridge, /associatePayment/);
    assert.doesNotMatch(bridge, /createSimulatedPayment|createPayment|refundPayment|createPaymentLink|chargeSavedCard|saveCard/);
    assert.doesNotMatch(bridge, /prisma|PaymentAttempt|LedgerEntry|@prisma/);
    assert.doesNotMatch(bridge, /square-sandbox-webhook/);
    assert.equal(receiver.includes('square-verified-bridge'), false);
    assert.equal(verifier.includes('square-verified-bridge'), false);
    assert.equal(fs.readdirSync(path.join(ROOT, 'netlify/functions')).some((name) => /square/i.test(name)), false);
    for (const file of [
      'netlify/functions/submit-booking.js',
      'netlify/functions/stripe-webhook.js',
      'netlify/lib/payment-provider-adapter.js',
      'netlify/lib/payment-service.js',
    ]) {
      assert.equal(fs.readFileSync(path.join(ROOT, file), 'utf8').includes('square-verified-bridge'), false, file);
    }
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/integration.yml'), 'utf8');
    const fullTest = workflow.slice(workflow.indexOf('  full_test:'), workflow.indexOf('  financial_invariants:'));
    assert.match(fullTest, /square-verified-reconciliation\.test\.js/);
    assert.doesNotMatch(workflow, /SQUARE_SANDBOX_ACCESS_TOKEN|connect\.squareupsandbox\.com/);
    const migrations = fs.readdirSync(path.join(ROOT, 'prisma/migrations')).join('\n');
    assert.equal(migrations.includes('sandbox_settlement'), false);

    await storedOperation();
    await receiveVerifiedWebhook(SETTLEMENT_URL, webhookInput(fixture(), {
      input: { fetchImpl: mockFetch({ includeMerchantId: true }) },
    }));
    const rows = await state();
    assert.equal(rows.database, 'cardetail1_square_settlement_7d');
    assert.equal(rows.address === '127.0.0.1' || rows.address === '::1' || rows.address === '127.0.0.1/32', true);
    assert.equal(rows.settlements, 1);
    assert.equal(rows.commercial_attempt, null);
    assert.equal(rows.commercial_ledger, null);
    assert.equal(rows.forged_bookings, 0);
    assert.equal(SETTLEMENT_URL.includes('neon'), false);
    assert.equal(SETTLEMENT_URL.includes('summer-glade'), false);
    assert.equal(SETTLEMENT_URL.includes('misty-sea'), false);
  });
});
