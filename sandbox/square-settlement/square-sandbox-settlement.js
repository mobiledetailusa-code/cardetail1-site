'use strict';

/**
 * Isolated Square Sandbox settlement prototype.
 *
 * Depends on the Square adapter contract at commit
 * f68c9b46af83d747e55139eaac5fb724db0e43e4, published as Draft PR #373.
 * This branch is not PR #373 and does not change that pull request.
 * It also does not contain Stripe Draft PR #372.
 *
 * The prototype stores a test obligation before it accepts a payment,
 * then settles that obligation at most once. It does not write commercial
 * financial tables, commercial bookings, or the Square webhook event table.
 * It does not call Square or Stripe. Provider reads go through the adapter
 * contract and an injected mock client.
 *
 * financiallySettled is true only after a settlement row has committed,
 * or when a later call sees that committed row. paid stays false.
 * A receipt URL is never accepted as proof.
 */

const crypto = require('crypto');
const { connectProven } = require('./database');
const {
  TEST_CONTEXT,
  normalizeSquarePaymentStatus,
  retrieveSimulatedPayment,
} = require('../../netlify/lib/square-sandbox-adapter-contract');
const { LOCAL_CONFIRMATION } = require('../../netlify/lib/square-sandbox-provider');

const PURPOSE = 'sandbox_settlement_test';
const ADAPTER_COMMIT = 'f68c9b46af83d747e55139eaac5fb724db0e43e4';
const DEPENDS_ON_PULL_REQUEST = 373;
const MERCHANT_PATTERN = /^MERCHANT_TEST_[A-Z0-9_]{1,48}$/;
const LOCATION_PATTERN = /^LOC_TEST_[A-Z0-9_]{1,40}$/;
const BOOKING_PATTERN = /^TEST-[A-Z0-9-]{1,32}$/;
const PAYMENT_PATTERN = /^[A-Za-z0-9]{8,80}$/;
const OPERATION_KEY_PATTERN = /^sandbox-op-[A-Za-z0-9._:-]{1,40}$/;
const EVENT_PATTERN = /^evt-[A-Za-z0-9._:-]{1,64}$/;

function result(fields = {}) {
  return {
    result: fields.result || 'rejected',
    operationId: fields.operationId || '',
    obligationId: fields.obligationId || '',
    squarePaymentId: fields.squarePaymentId || '',
    processingStatus: fields.processingStatus || '',
    settlementStatus: fields.settlementStatus || 'none',
    providerCompleted: fields.providerCompleted === true,
    financiallySettled: fields.financiallySettled === true,
    settlementCommitted: fields.settlementCommitted === true,
    paid: false,
    ledgerWrite: false,
    bookingWrite: false,
    commercialDatabaseWrite: false,
    retrySafe: fields.retrySafe === true,
    error: fields.error || '',
    adapterCommit: ADAPTER_COMMIT,
    dependsOnPullRequest: DEPENDS_ON_PULL_REQUEST,
  };
}

function trustedIdentity(input, options = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const callerIdentity = source.expectedMerchantId || source.expectedLocationId || source.callerMerchantId || source.callerLocationId;
  const eventIdentity = !options.allowEventIdentity && (source.merchantId || source.locationId);
  if (callerIdentity || eventIdentity) {
    return { ok: false, error: 'square_settlement_identity_not_caller_controlled' };
  }
  if (source.browserAmountCents != null || source.clientPrice != null || source.bookingId || source.booking) {
    return { ok: false, error: 'square_settlement_commercial_input_rejected' };
  }
  if (source.testContext !== TEST_CONTEXT) {
    return { ok: false, error: 'square_settlement_test_context_required' };
  }
  const trusted = source.trustedSandbox;
  if (!trusted || trusted.configuredBy !== 'server') {
    return { ok: false, error: 'square_settlement_merchant_untrusted' };
  }
  if (typeof trusted.merchantId !== 'string' || !MERCHANT_PATTERN.test(trusted.merchantId)) {
    return { ok: false, error: 'square_settlement_merchant_untrusted' };
  }
  if (typeof trusted.locationId !== 'string' || !LOCATION_PATTERN.test(trusted.locationId)) {
    return { ok: false, error: 'square_settlement_trusted_location_missing' };
  }
  if (trusted.locationMerchantId !== trusted.merchantId) {
    return { ok: false, error: 'square_settlement_merchant_untrusted' };
  }
  return { ok: true, merchantId: trusted.merchantId, locationId: trusted.locationId };
}

function lastOf(rows) {
  return rows.length ? rows[rows.length - 1] : null;
}

function sameFacts(left, right) {
  return left.square_payment_id === right.square_payment_id
    && left.payment_status === right.payment_status
    && left.amount_cents === right.amount_cents
    && left.currency === right.currency
    && left.location_id === right.location_id
    && left.merchant_id === right.merchant_id;
}

function matchesOperation(operation, event) {
  return event.square_payment_id === operation.square_payment_id
    && event.amount_cents === operation.expected_amount_cents
    && event.currency === operation.currency
    && event.location_id === operation.expected_location_id
    && event.merchant_id === operation.expected_merchant_id
    && (event.source_kind === 'trusted_mock' || event.source_kind === 'authenticated_event');
}

function decide(operation, events) {
  const webhooks = events.filter((event) => event.event_type !== 'provider.retrieve');
  const retrievals = events.filter((event) => event.event_type === 'provider.retrieve');
  const latestWebhook = lastOf(webhooks);
  const latestRetrieval = lastOf(retrievals);
  if (latestWebhook && latestRetrieval && !sameFacts(latestWebhook, latestRetrieval)) {
    return { result: 'quarantined', processing: 'inconsistent', providerCompleted: false };
  }
  const latest = lastOf(events);
  if (!latest) return { result: 'pending', processing: 'pending', providerCompleted: false };
  if (!matchesOperation(operation, latest)) {
    return { result: 'quarantined', processing: 'quarantined', providerCompleted: false };
  }
  const normalized = normalizeSquarePaymentStatus(latest.payment_status);
  if (!normalized.recognized || normalized.status === 'FAILED' || normalized.status === 'CANCELED') {
    return { result: 'rejected', processing: 'rejected', providerCompleted: false };
  }
  if (normalized.status !== 'COMPLETED') {
    return { result: 'pending', processing: 'pending', providerCompleted: false };
  }
  return {
    result: 'settled',
    processing: 'settled',
    providerCompleted: true,
    eventId: latest.event_id,
  };
}

async function markOpenEvents(client, paymentId, status) {
  await client.query(
    `UPDATE sandbox_payment_event
     SET processing_status = $2
     WHERE square_payment_id = $1
       AND processing_status IN ('stored', 'awaiting_association', 'pending')`,
    [paymentId, status]
  );
}

async function transaction(connectionString, work) {
  const client = await connectProven(connectionString);
  try {
    await client.query('BEGIN');
    const outcome = await work(client);
    if (outcome && outcome.fault) {
      const error = new Error('sandbox_settlement_injected_fault');
      error.code = 'INJECTED';
      throw error;
    }
    await client.query('COMMIT');
    return outcome;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is discarded below.
    }
    if (error.code === '23505') {
      const table = String(error.table || '');
      if (table === 'sandbox_settlement') {
        return result({
          result: 'already_settled',
          financiallySettled: true,
          settlementCommitted: false,
          retrySafe: true,
          settlementStatus: 'settled',
        });
      }
      return result({
        result: 'rejected',
        error: 'square_settlement_conflict',
        retrySafe: false,
      });
    }
    if (error.code === 'INJECTED' || error.message === 'sandbox_settlement_injected_fault') {
      return result({
        result: 'failed',
        error: 'square_settlement_rolled_back',
        settlementCommitted: false,
        financiallySettled: false,
        retrySafe: true,
      });
    }
    return result({
      result: 'failed',
      error: 'square_settlement_failed',
      settlementCommitted: false,
      financiallySettled: false,
      retrySafe: true,
    });
  } finally {
    await client.end();
  }
}

async function reconcile(client, paymentId) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [paymentId]);
  const operations = await client.query(
    'SELECT * FROM sandbox_payment_operation WHERE square_payment_id = $1 FOR UPDATE',
    [paymentId]
  );
  const operation = operations.rows[0];
  if (!operation) {
    await markOpenEvents(client, paymentId, 'awaiting_association');
    return result({
      result: 'stored',
      squarePaymentId: paymentId,
      processingStatus: 'awaiting_association',
      retrySafe: true,
    });
  }
  const obligations = await client.query(
    'SELECT * FROM sandbox_payment_obligation WHERE obligation_id = $1 FOR UPDATE',
    [operation.obligation_id]
  );
  const obligation = obligations.rows[0];
  const settlements = await client.query(
    `SELECT * FROM sandbox_settlement
     WHERE square_payment_id = $1 OR obligation_id = $2 OR operation_id = $3
     FOR UPDATE`,
    [paymentId, operation.obligation_id, operation.operation_id]
  );
  const events = (await client.query(
    `SELECT * FROM sandbox_payment_event
     WHERE square_payment_id = $1
     ORDER BY observed_at ASC, created_at ASC
     FOR UPDATE`,
    [paymentId]
  )).rows;
  const shared = {
    operationId: operation.operation_id,
    obligationId: operation.obligation_id,
    squarePaymentId: paymentId,
  };
  if (settlements.rows[0] || (obligation && obligation.status === 'settled')) {
    await markOpenEvents(client, paymentId, 'already_settled');
    return result({
      ...shared,
      result: 'already_settled',
      processingStatus: 'already_settled',
      settlementStatus: 'settled',
      financiallySettled: true,
      settlementCommitted: false,
      retrySafe: true,
    });
  }
  const decision = decide(operation, events);
  if (decision.result !== 'settled') {
    await markOpenEvents(client, paymentId, decision.processing);
    return result({
      ...shared,
      result: decision.result,
      processingStatus: decision.processing,
      providerCompleted: false,
      retrySafe: decision.result === 'pending' || decision.result === 'stored',
    });
  }
  const settlementId = `stl_${crypto.randomUUID()}`;
  await client.query(
    `INSERT INTO sandbox_settlement
      (settlement_id, obligation_id, operation_id, square_payment_id, settled_amount_cents, currency)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      settlementId,
      operation.obligation_id,
      operation.operation_id,
      paymentId,
      operation.expected_amount_cents,
      operation.currency,
    ]
  );
  await client.query(
    "UPDATE sandbox_payment_obligation SET status = 'settled' WHERE obligation_id = $1",
    [operation.obligation_id]
  );
  await client.query(
    "UPDATE sandbox_payment_operation SET status = 'settled', updated_at = now() WHERE operation_id = $1",
    [operation.operation_id]
  );
  await client.query(
    "UPDATE sandbox_payment_event SET processing_status = 'settled' WHERE event_id = $1",
    [decision.eventId]
  );
  await markOpenEvents(client, paymentId, 'ignored_stale');
  return result({
    ...shared,
    result: 'settled',
    processingStatus: 'settled',
    settlementStatus: 'settled',
    providerCompleted: true,
    financiallySettled: true,
    settlementCommitted: true,
    retrySafe: true,
  });
}

async function createObligation(connectionString, input = {}) {
  const trusted = trustedIdentity(input);
  if (!trusted.ok) return result({ result: 'rejected', error: trusted.error, retrySafe: false });
  if (typeof input.bookingRef !== 'string' || !BOOKING_PATTERN.test(input.bookingRef)) {
    return result({ result: 'rejected', error: 'square_settlement_booking_ref_invalid', retrySafe: false });
  }
  if (input.purpose !== PURPOSE) {
    return result({ result: 'rejected', error: 'square_settlement_purpose_rejected', retrySafe: false });
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return result({ result: 'rejected', error: 'square_settlement_amount_invalid', retrySafe: false });
  }
  if (input.currency !== 'USD') {
    return result({ result: 'rejected', error: 'square_settlement_currency_invalid', retrySafe: false });
  }
  const obligationId = `obl_${crypto.randomUUID()}`;
  return transaction(connectionString, async (client) => {
    await client.query(
      `INSERT INTO sandbox_payment_obligation
        (obligation_id, booking_ref, purpose, amount_cents, currency, merchant_id, location_id, status)
       VALUES ($1, $2, $3, $4, 'USD', $5, $6, 'authorized')`,
      [obligationId, input.bookingRef, PURPOSE, input.amountCents, trusted.merchantId, trusted.locationId]
    );
    return result({
      result: 'stored',
      obligationId,
      processingStatus: 'authorized',
      retrySafe: true,
    });
  });
}

async function createOperation(connectionString, input = {}) {
  const trusted = trustedIdentity(input);
  if (!trusted.ok) return result({ result: 'rejected', error: trusted.error, retrySafe: false });
  if (typeof input.obligationId !== 'string' || input.obligationId === '') {
    return result({ result: 'rejected', error: 'square_settlement_obligation_unknown', retrySafe: false });
  }
  if (typeof input.idempotencyKey !== 'string' || !OPERATION_KEY_PATTERN.test(input.idempotencyKey)) {
    return result({ result: 'rejected', error: 'square_settlement_idempotency_invalid', retrySafe: false });
  }
  return transaction(connectionString, async (client) => {
    if (input.fault === 'operation_insert') return { fault: true };
    const obligations = await client.query(
      'SELECT * FROM sandbox_payment_obligation WHERE obligation_id = $1 FOR UPDATE',
      [input.obligationId]
    );
    const obligation = obligations.rows[0];
    if (!obligation) {
      return result({
        result: 'rejected',
        error: 'square_settlement_obligation_unknown',
        retrySafe: false,
      });
    }
    if (obligation.status === 'settled') {
      return result({
        result: 'rejected',
        obligationId: obligation.obligation_id,
        error: 'square_settlement_obligation_already_settled',
        financiallySettled: true,
        settlementCommitted: false,
        retrySafe: false,
      });
    }
    if (obligation.merchant_id !== trusted.merchantId || obligation.location_id !== trusted.locationId) {
      return result({
        result: 'quarantined',
        obligationId: obligation.obligation_id,
        error: 'square_settlement_context_mismatch',
        retrySafe: false,
      });
    }
    const existing = await client.query(
      'SELECT * FROM sandbox_payment_operation WHERE idempotency_key = $1 FOR UPDATE',
      [input.idempotencyKey]
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      const same = row.obligation_id === obligation.obligation_id
        && row.expected_amount_cents === obligation.amount_cents
        && row.currency === obligation.currency
        && row.expected_merchant_id === trusted.merchantId
        && row.expected_location_id === trusted.locationId
        && (input.amountCents == null || input.amountCents === row.expected_amount_cents)
        && (input.currency == null || input.currency === row.currency);
      if (!same) {
        return result({
          result: 'rejected',
          operationId: row.operation_id,
          obligationId: obligation.obligation_id,
          error: 'square_settlement_idempotency_conflict',
          retrySafe: false,
        });
      }
      return result({
        result: 'stored',
        operationId: row.operation_id,
        obligationId: row.obligation_id,
        squarePaymentId: row.square_payment_id || '',
        processingStatus: row.status,
        retrySafe: true,
      });
    }
    if (input.amountCents != null && input.amountCents !== obligation.amount_cents) {
      return result({
        result: 'rejected',
        obligationId: obligation.obligation_id,
        error: 'square_settlement_amount_not_server_controlled',
        retrySafe: false,
      });
    }
    if (input.currency != null && input.currency !== obligation.currency) {
      return result({
        result: 'rejected',
        obligationId: obligation.obligation_id,
        error: 'square_settlement_currency_invalid',
        retrySafe: false,
      });
    }
    const operationId = `op_${crypto.randomUUID()}`;
    await client.query(
      `INSERT INTO sandbox_payment_operation
        (operation_id, obligation_id, provider, idempotency_key, expected_amount_cents, currency,
         expected_merchant_id, expected_location_id, status)
       VALUES ($1, $2, 'square_sandbox', $3, $4, $5, $6, $7, 'open')`,
      [
        operationId,
        obligation.obligation_id,
        input.idempotencyKey,
        obligation.amount_cents,
        obligation.currency,
        trusted.merchantId,
        trusted.locationId,
      ]
    );
    return result({
      result: 'stored',
      operationId,
      obligationId: obligation.obligation_id,
      processingStatus: 'open',
      retrySafe: true,
    });
  });
}

async function associatePayment(connectionString, input = {}) {
  const trusted = trustedIdentity(input);
  if (!trusted.ok) return result({ result: 'rejected', error: trusted.error, retrySafe: false });
  if (typeof input.operationId !== 'string' || typeof input.squarePaymentId !== 'string' || !PAYMENT_PATTERN.test(input.squarePaymentId)) {
    return result({ result: 'rejected', error: 'square_settlement_payment_id_invalid', retrySafe: false });
  }
  return transaction(connectionString, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [input.squarePaymentId]);
    const operations = await client.query(
      'SELECT * FROM sandbox_payment_operation WHERE operation_id = $1 FOR UPDATE',
      [input.operationId]
    );
    const operation = operations.rows[0];
    if (!operation) {
      return result({ result: 'rejected', error: 'square_settlement_operation_unknown', retrySafe: false });
    }
    if (operation.expected_merchant_id !== trusted.merchantId || operation.expected_location_id !== trusted.locationId) {
      return result({
        result: 'quarantined',
        operationId: operation.operation_id,
        obligationId: operation.obligation_id,
        error: 'square_settlement_context_mismatch',
        retrySafe: false,
      });
    }
    if (operation.square_payment_id && operation.square_payment_id !== input.squarePaymentId) {
      return result({
        result: 'rejected',
        operationId: operation.operation_id,
        obligationId: operation.obligation_id,
        squarePaymentId: operation.square_payment_id,
        error: 'square_settlement_payment_already_associated',
        retrySafe: false,
      });
    }
    if (!operation.square_payment_id) {
      await client.query(
        `UPDATE sandbox_payment_operation
         SET square_payment_id = $2, status = 'associated', updated_at = now()
         WHERE operation_id = $1 AND square_payment_id IS NULL`,
        [operation.operation_id, input.squarePaymentId]
      );
    }
    const outcome = await reconcile(client, input.squarePaymentId);
    return input.fault === 'before_commit' ? { fault: true } : outcome;
  });
}

function eventFromInput(input, trusted) {
  if (typeof input.eventId !== 'string' || !EVENT_PATTERN.test(input.eventId)) {
    return { ok: false, error: 'square_settlement_event_invalid' };
  }
  if (input.eventType !== 'payment.created' && input.eventType !== 'payment.updated' && input.eventType !== 'provider.retrieve') {
    return { ok: false, error: 'square_settlement_event_invalid' };
  }
  if (input.sourceKind !== 'trusted_mock' && input.sourceKind !== 'authenticated_event') {
    return { ok: false, error: 'square_settlement_source_untrusted' };
  }
  if (typeof input.squarePaymentId !== 'string' || !PAYMENT_PATTERN.test(input.squarePaymentId)) {
    return { ok: false, error: 'square_settlement_payment_id_invalid' };
  }
  if (typeof input.merchantId !== 'string' || typeof input.locationId !== 'string') {
    return { ok: false, error: 'square_settlement_event_invalid' };
  }
  if (!Number.isInteger(input.amountCents) || typeof input.currency !== 'string') {
    return { ok: false, error: 'square_settlement_amount_invalid' };
  }
  const observedAt = new Date(input.observedAt);
  if (Number.isNaN(observedAt.getTime())) {
    return { ok: false, error: 'square_settlement_event_invalid' };
  }
  if (input.payment && Object.prototype.hasOwnProperty.call(input.payment, 'merchant_id')) {
    return { ok: false, error: 'square_settlement_undocumented_merchant_field' };
  }
  return {
    ok: true,
    event: {
      eventId: input.eventId,
      eventType: input.eventType,
      paymentId: input.squarePaymentId,
      merchantId: input.merchantId,
      locationId: input.locationId,
      status: String(input.paymentStatus || ''),
      amountCents: input.amountCents,
      currency: input.currency,
      sourceKind: input.sourceKind,
      observedAt,
      trustedMerchantId: trusted.merchantId,
      trustedLocationId: trusted.locationId,
    },
  };
}

async function ingestObservation(connectionString, input = {}) {
  const trusted = trustedIdentity(input, { allowEventIdentity: true });
  if (!trusted.ok) return result({ result: 'rejected', error: trusted.error, retrySafe: false });
  const parsed = eventFromInput(input, trusted);
  if (!parsed.ok) return result({ result: 'rejected', error: parsed.error, retrySafe: false });
  const event = parsed.event;
  return transaction(connectionString, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [event.paymentId]);
    await client.query(
      `INSERT INTO sandbox_payment_event
        (event_id, square_payment_id, event_type, merchant_id, location_id, payment_status,
         amount_cents, currency, processing_status, source_kind, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'stored', $9, $10)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        event.eventId,
        event.paymentId,
        event.eventType,
        event.merchantId,
        event.locationId,
        event.status,
        event.amountCents,
        event.currency,
        event.sourceKind,
        event.observedAt,
      ]
    );
    const outcome = await reconcile(client, event.paymentId);
    return input.fault === 'before_commit' ? { fault: true } : outcome;
  });
}

async function retrieveAndReconcile(connectionString, input = {}) {
  const trusted = trustedIdentity(input);
  if (!trusted.ok) return result({ result: 'rejected', error: trusted.error, retrySafe: false });
  if (typeof input.squarePaymentId !== 'string' || !PAYMENT_PATTERN.test(input.squarePaymentId)) {
    return result({ result: 'rejected', error: 'square_settlement_payment_id_invalid', retrySafe: false });
  }
  const captured = {};
  const fetchImpl = async (url, init) => {
    const target = String(url);
    if (!target.startsWith('https://connect.squareupsandbox.com/')) {
      throw new Error('square_settlement_host_rejected');
    }
    const response = await input.fetchImpl(url, init);
    const text = typeof response.text === 'function' ? await response.text() : '';
    captured.text = text;
    return {
      status: response.status,
      async text() { return text; },
    };
  };
  let retrieved;
  try {
    retrieved = await retrieveSimulatedPayment({
      testContext: TEST_CONTEXT,
      confirmation: LOCAL_CONFIRMATION,
      purpose: 'sandbox_adapter_test',
      serverBookingRef: input.serverBookingRef,
      trustedSandbox: input.trustedSandbox,
      amountCents: input.amountCents,
      currency: 'USD',
      paymentId: input.squarePaymentId,
      env: input.env,
      timeoutMs: input.timeoutMs || 50,
      fetchImpl,
    });
  } catch {
    return result({
      result: 'failed',
      squarePaymentId: input.squarePaymentId,
      error: 'square_settlement_provider_unknown',
      retrySafe: true,
    });
  }
  let payment = null;
  try {
    const body = JSON.parse(captured.text || '');
    payment = body && body.payment && typeof body.payment === 'object' ? body.payment : null;
  } catch {
    payment = null;
  }
  if (!payment) {
    return result({
      result: 'failed',
      squarePaymentId: input.squarePaymentId,
      error: retrieved && retrieved.error ? retrieved.error : 'square_settlement_provider_unknown',
      providerCompleted: false,
      financiallySettled: false,
      settlementCommitted: false,
      retrySafe: true,
    });
  }
  if (Object.prototype.hasOwnProperty.call(payment, 'merchant_id')) {
    return result({
      result: 'rejected',
      squarePaymentId: input.squarePaymentId,
      error: payment ? 'square_settlement_undocumented_merchant_field' : 'square_settlement_provider_invalid',
      retrySafe: false,
    });
  }
  return ingestObservation(connectionString, {
    ...input,
    eventId: input.retrievalEventId,
    eventType: 'provider.retrieve',
    sourceKind: 'trusted_mock',
    merchantId: trusted.merchantId,
    locationId: typeof payment.location_id === 'string' ? payment.location_id : '',
    squarePaymentId: typeof payment.id === 'string' ? payment.id : input.squarePaymentId,
    paymentStatus: typeof payment.status === 'string' ? payment.status : '',
    amountCents: payment.amount_money && payment.amount_money.amount,
    currency: payment.amount_money && payment.amount_money.currency,
    observedAt: input.observedAt,
    payment: undefined,
  });
}

module.exports = {
  ADAPTER_COMMIT,
  DEPENDS_ON_PULL_REQUEST,
  PURPOSE,
  createObligation,
  createOperation,
  associatePayment,
  ingestObservation,
  retrieveAndReconcile,
};
