'use strict';

/**
 * Isolated Square Sandbox settlement prototype.
 *
 * Depends on the Square adapter contract at commit
 * f68c9b46af83d747e55139eaac5fb724db0e43e4, published as Draft PR #373.
 * This branch is not PR #373 and does not change that pull request.
 * It also does not contain Stripe Draft PR #372.
 *
 * Three boundaries stay separate. An observation is stored evidence.
 * Provider verification is an internal retrieval through the adapter
 * contract and an injected mock client. Financial settlement is a
 * committed sandbox_settlement row. The mock does not authenticate a
 * real Square account, and a caller cannot supply that decision.
 *
 * The service builds the adapter's configuredBy literal itself because
 * that contract requires it. The literal is not accepted from the caller
 * and is not Square authentication. Receipt URLs are never proof.
 * paid stays false. No commercial table is written.
 */

const crypto = require('crypto');
const { connectProven } = require('./database');
const {
  TEST_CONTEXT,
  retrieveSimulatedPayment,
} = require('../../netlify/lib/square-sandbox-adapter-contract');
const { LOCAL_CONFIRMATION } = require('../../netlify/lib/square-sandbox-provider');

const PURPOSE = 'sandbox_settlement_test';
const ADAPTER_COMMIT = 'f68c9b46af83d747e55139eaac5fb724db0e43e4';
const DEPENDS_ON_PULL_REQUEST = 373;
const SETTLEMENT_TRANSACTION_LOCK = 'cardetail1.square-settlement.transaction.v1';
const MERCHANT_PATTERN = /^MERCHANT_TEST_[A-Z0-9_]{1,48}$/;
const LOCATION_PATTERN = /^LOC_TEST_[A-Z0-9_]{1,40}$/;
const BOOKING_PATTERN = /^TEST-[A-Z0-9-]{1,32}$/;
const PAYMENT_PATTERN = /^[A-Za-z0-9]{8,80}$/;
const OPERATION_KEY_PATTERN = /^sandbox-op-[A-Za-z0-9._:-]{1,40}$/;
const EVENT_PATTERN = /^evt-[A-Za-z0-9._:-]{1,64}$/;
const OPEN_EVENT_STATUSES = ['stored', 'awaiting_association', 'pending', 'verification_required'];
const AUTHENTICATION_MARKERS = [
  'sourceKind',
  'configuredBy',
  'authenticated',
  'verified',
  'verificationBypass',
  'bypassVerification',
  'financiallySettled',
  'settlementCommitted',
  'settlementAuthorized',
  'providerCompleted',
  'eligibleForReconciliation',
  'trusted',
];

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
    ...(fields.investigationRequired === true ? { investigationRequired: true } : {}),
  };
}

function authenticationMarker(input) {
  const source = input && typeof input === 'object' ? input : {};
  for (const key of AUTHENTICATION_MARKERS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      return 'square_settlement_authentication_marker_rejected';
    }
  }
  const trusted = source.trustedSandbox;
  if (trusted && typeof trusted === 'object' && Object.prototype.hasOwnProperty.call(trusted, 'configuredBy')) {
    return 'square_settlement_authentication_marker_rejected';
  }
  return '';
}

function expectedContext(input, options = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const marker = authenticationMarker(source);
  if (marker) return { ok: false, error: marker };
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
  if (!trusted || typeof trusted !== 'object') {
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

function settlementAgrees(row, expected) {
  if (!row || row.currency !== 'USD' || !(row.settled_amount_cents > 0)) return false;
  if (!row.obligation_id || !row.operation_id || !row.square_payment_id) return false;
  if (expected.obligationId && row.obligation_id !== expected.obligationId) return false;
  if (expected.operationId && row.operation_id !== expected.operationId) return false;
  if (expected.squarePaymentId && row.square_payment_id !== expected.squarePaymentId) return false;
  if (expected.amountCents != null && row.settled_amount_cents !== expected.amountCents) return false;
  if (expected.currency && row.currency !== expected.currency) return false;
  return expected.obligationId && expected.operationId && expected.squarePaymentId
    && expected.amountCents != null && expected.currency === 'USD';
}

function confirmedSettlement(row) {
  return result({
    result: 'already_settled',
    operationId: row.operation_id,
    obligationId: row.obligation_id,
    squarePaymentId: row.square_payment_id,
    processingStatus: 'already_settled',
    settlementStatus: 'settled',
    financiallySettled: true,
    settlementCommitted: false,
    retrySafe: true,
  });
}

function sameIdentity(operation, event) {
  return event.square_payment_id === operation.square_payment_id
    && event.amount_cents === operation.expected_amount_cents
    && event.currency === operation.currency
    && event.location_id === operation.expected_location_id
    && event.merchant_id === operation.expected_merchant_id;
}

function isUnavailableRetrieval(event) {
  // Only server-generated retrieval attempts can have this meaning. Missing
  // payment data is not a contradictory identity assertion. This also covers
  // legacy attempts whose processing status was already marked inconsistent.
  return event.source_kind === 'verified_provider_retrieval'
    && event.event_type === 'provider.retrieve'
    && event.processing_status !== 'quarantined'
    && (event.payment_status == null || event.payment_status === '')
    && event.amount_cents == null
    && (event.currency == null || event.currency === '');
}

function verificationPending(event) {
  return event.source_kind === 'verified_provider_retrieval'
    && event.event_type === 'provider.retrieve'
    && event.processing_status === 'verification_pending';
}

function conflictingEvidence(events, operation) {
  return events.filter((event) => !verificationPending(event) && !isUnavailableRetrieval(event))
    .some((event) => !sameIdentity(operation, event)
      || (event.source_kind === 'verified_provider_retrieval' && event.processing_status === 'quarantined'));
}

function conflictOutcome(operation, settlement) {
  if (settlement) {
    return { ...confirmedSettlement(settlement), investigationRequired: true,
      processingStatus: 'inconsistent', error: 'square_settlement_observations_conflict' };
  }
  return result({ result: 'quarantined', operationId: operation.operation_id,
    obligationId: operation.obligation_id, squarePaymentId: operation.square_payment_id,
    processingStatus: 'inconsistent', error: 'square_settlement_observations_conflict' });
}

function packaged(response, extra = {}) {
  return { response, ...extra };
}

async function transaction(connectionString, work) {
  const client = await connectProven(connectionString);
  let outcome;
  let commitStarted = false;
  let committed = false;
  try {
    await client.query('BEGIN');
    // All financial SQL enters this database-scoped gate before taking any
    // payment, row, foreign-key, or unique-index lock. This serializes the short
    // database phases, including operation retries that lock obligation first.
    // Provider retrieval is outside transaction(), never inside this gate.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [SETTLEMENT_TRANSACTION_LOCK]);
    outcome = await work(client);
    if (outcome && outcome.fault) {
      const error = new Error('sandbox_settlement_injected_fault');
      error.code = 'INJECTED';
      throw error;
    }
    commitStarted = true;
    await client.query('COMMIT');
    committed = true;
  } catch (error) {
    let rolledBack = false;
    try {
      await client.query('ROLLBACK');
      rolledBack = true;
    } catch {
      // The connection is discarded below.
    }
    if (error.code === '23505' && error.table === 'sandbox_settlement') {
      outcome = await confirmCommittedSettlement(connectionString, error.settlementAttempt);
    } else if (error.code === '23505') {
      outcome = result({
        result: 'rejected',
        error: 'square_settlement_conflict',
        financiallySettled: false,
        settlementCommitted: false,
        retrySafe: false,
      });
    } else if (error.code === 'INJECTED' || error.message === 'sandbox_settlement_injected_fault') {
      outcome = result({
        result: 'failed',
        error: 'square_settlement_rolled_back',
        settlementCommitted: false,
        financiallySettled: false,
        retrySafe: true,
      });
    } else {
      outcome = result({ result: 'failed', error: 'square_settlement_failed', retrySafe: true });
    }
    // A ROLLBACK acknowledgement after a failed COMMIT cannot prove whether
    // COMMIT took effect. Later requests must inspect durable rows.
    outcome.databaseCommitState = commitStarted ? 'unknown' : (rolledBack ? 'rolled_back' : 'unknown');
  } finally {
    try { await client.end(); } catch {
      // Cleanup must not turn an acknowledged financial COMMIT into a claim
      // that no settlement exists. Preserve its result and report cleanup.
      const response = outcome && (outcome.response || outcome);
      if (response) {
        response.databaseCleanupFailed = true;
        response.databaseCommitState = committed ? 'committed' : (response.databaseCommitState || 'unknown');
      }
    }
  }
  return outcome;
}

async function confirmCommittedSettlement(connectionString, attempt) {
  if (!attempt) {
    return result({
      result: 'rejected',
      error: 'square_settlement_conflict',
      financiallySettled: false,
      settlementCommitted: false,
      retrySafe: false,
    });
  }
  let client;
  try {
    client = await connectProven(connectionString);
    const found = await client.query(
      `SELECT * FROM sandbox_settlement
       WHERE obligation_id = $1 OR operation_id = $2 OR square_payment_id = $3`,
      [attempt.obligationId, attempt.operationId, attempt.squarePaymentId]
    );
    const row = found.rows.find((candidate) => settlementAgrees(candidate, attempt));
    if (row) return confirmedSettlement(row);
    return result({
      result: 'rejected',
      error: 'square_settlement_conflict',
      financiallySettled: false,
      settlementCommitted: false,
      retrySafe: false,
    });
  } catch {
    return result({
      result: 'failed',
      error: 'square_settlement_failed',
      financiallySettled: false,
      settlementCommitted: false,
      retrySafe: true,
    });
  } finally {
    if (client) await client.end();
  }
}

async function markOpenEvents(client, paymentId, status) {
  await client.query(
    `UPDATE sandbox_payment_event
     SET processing_status = $2
     WHERE square_payment_id = $1
       AND processing_status = ANY($3::text[])
       AND NOT (source_kind = 'verified_provider_retrieval'
                AND event_type = 'provider.retrieve'
                AND COALESCE(payment_status, '') = ''
                AND amount_cents IS NULL AND COALESCE(currency, '') = '')`,
    [paymentId, status, OPEN_EVENT_STATUSES]
  );
}

async function loadSettlement(client, operation) {
  const found = await client.query(
    `SELECT * FROM sandbox_settlement
     WHERE square_payment_id = $1 OR obligation_id = $2 OR operation_id = $3
     FOR UPDATE`,
    [operation.square_payment_id, operation.obligation_id, operation.operation_id]
  );
  return found.rows[0] || null;
}

function attemptFrom(operation, obligation) {
  return {
    obligationId: obligation.obligation_id,
    operationId: operation.operation_id,
    squarePaymentId: operation.square_payment_id,
    amountCents: obligation.amount_cents,
    currency: obligation.currency,
  };
}

async function reviewInbox(client, paymentId) {
  const operations = await client.query(
    'SELECT * FROM sandbox_payment_operation WHERE square_payment_id = $1 FOR UPDATE',
    [paymentId]
  );
  const operation = operations.rows[0];
  const events = (await client.query(
    `SELECT * FROM sandbox_payment_event
     WHERE square_payment_id = $1
     ORDER BY event_id ASC
     FOR UPDATE`,
    [paymentId]
  )).rows;
  if (!operation) {
    await markOpenEvents(client, paymentId, 'awaiting_association');
    return packaged(result({
      result: 'stored',
      squarePaymentId: paymentId,
      processingStatus: 'awaiting_association',
      financiallySettled: false,
      settlementCommitted: false,
      retrySafe: true,
    }), { verificationRequested: false });
  }
  const obligations = await client.query(
    'SELECT * FROM sandbox_payment_obligation WHERE obligation_id = $1 FOR UPDATE',
    [operation.obligation_id]
  );
  const obligation = obligations.rows[0];
  const settlement = await loadSettlement(client, operation);
  const shared = {
    operationId: operation.operation_id,
    obligationId: operation.obligation_id,
    squarePaymentId: paymentId,
  };
  const conflict = conflictingEvidence(events, operation);
  if (settlement || (obligation && obligation.status === 'settled')) {
    if (obligation && settlementAgrees(settlement, attemptFrom(operation, obligation))) {
      await markOpenEvents(client, paymentId, conflict ? 'inconsistent' : 'already_settled');
      return packaged(conflict ? conflictOutcome(operation, settlement) : confirmedSettlement(settlement), {
        verificationRequested: false,
        operationId: operation.operation_id,
      });
    }
    return packaged(result({
      ...shared,
      result: 'failed',
      error: 'square_settlement_state_inconsistent',
      financiallySettled: false,
      settlementCommitted: false,
      retrySafe: false,
    }), { verificationRequested: false });
  }
  const paymentEvidence = events.filter((event) => !verificationPending(event) && !isUnavailableRetrieval(event));
  if (conflict) {
    await markOpenEvents(client, paymentId, 'inconsistent');
    return packaged(result({
      ...shared,
      result: 'quarantined',
      processingStatus: 'inconsistent',
      error: 'square_settlement_observations_conflict',
      financiallySettled: false,
      settlementCommitted: false,
      retrySafe: false,
    }), { verificationRequested: false, operationId: operation.operation_id });
  }
  const known = new Set(['APPROVED', 'PENDING', 'COMPLETED', 'FAILED', 'CANCELED']);
  const completed = paymentEvidence.some((event) => String(event.payment_status || '').trim().toUpperCase() === 'COMPLETED');
  const terminal = paymentEvidence.some((event) => {
    const status = String(event.payment_status || '').trim().toUpperCase();
    return status === 'FAILED' || status === 'CANCELED';
  });
  const unrecognized = paymentEvidence.some((event) => !known.has(String(event.payment_status || '').trim().toUpperCase()));
  if (unrecognized && !completed) {
    await markOpenEvents(client, paymentId, 'rejected');
    return packaged(result({
      ...shared,
      result: 'rejected',
      processingStatus: 'rejected',
      error: 'square_settlement_status_rejected',
      financiallySettled: false,
      settlementCommitted: false,
      retrySafe: false,
    }), { verificationRequested: false, operationId: operation.operation_id });
  }
  if (completed) {
    await markOpenEvents(client, paymentId, 'verification_required');
    return packaged(result({
      ...shared,
      result: 'stored',
      processingStatus: 'verification_required',
      financiallySettled: false,
      settlementCommitted: false,
      retrySafe: true,
    }), { verificationRequested: true, operationId: operation.operation_id });
  }
  const processing = terminal ? 'rejected' : 'pending';
  await markOpenEvents(client, paymentId, processing);
  return packaged(result({
    ...shared,
    result: processing === 'rejected' ? 'rejected' : 'pending',
    processingStatus: processing,
    financiallySettled: false,
    settlementCommitted: false,
    retrySafe: processing === 'pending',
  }), { verificationRequested: false, operationId: operation.operation_id });
}

async function insertSettlement(client, attempt, settlementId) {
  try {
    await client.query(
      `INSERT INTO sandbox_settlement
        (settlement_id, obligation_id, operation_id, square_payment_id, settled_amount_cents, currency)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        settlementId,
        attempt.obligationId,
        attempt.operationId,
        attempt.squarePaymentId,
        attempt.amountCents,
        attempt.currency,
      ]
    );
  } catch (error) {
    error.settlementAttempt = attempt;
    throw error;
  }
}

function eventFromInput(input) {
  if (typeof input.eventId !== 'string' || !EVENT_PATTERN.test(input.eventId)) {
    return { ok: false, error: 'square_settlement_event_invalid' };
  }
  if (input.eventType !== 'payment.created' && input.eventType !== 'payment.updated' && input.eventType !== 'provider.retrieve') {
    return { ok: false, error: 'square_settlement_event_invalid' };
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
  let observedAt = null;
  if (input.observedAt != null && input.observedAt !== '') {
    const parsed = new Date(input.observedAt);
    if (Number.isNaN(parsed.getTime())) return { ok: false, error: 'square_settlement_event_invalid' };
    observedAt = parsed.toISOString();
  }
  if (input.payment && Object.prototype.hasOwnProperty.call(input.payment, 'merchant_id')) {
    return { ok: false, error: 'square_settlement_undocumented_merchant_field' };
  }
  if (input.payment && Object.prototype.hasOwnProperty.call(input.payment, 'receipt_url')) {
    return { ok: false, error: 'square_settlement_receipt_not_proof' };
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
      observedAt,
    },
  };
}

async function insertObservation(client, event) {
  await client.query(
    `INSERT INTO sandbox_payment_event
      (event_id, square_payment_id, event_type, merchant_id, location_id, payment_status,
       amount_cents, currency, processing_status, source_kind, observed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'stored', 'unverified_observation', COALESCE($9::timestamptz, now()))
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
      event.observedAt,
    ]
  );
}

function callerPaymentMismatch(input, storedPaymentId) {
  return typeof input.squarePaymentId === 'string'
    && input.squarePaymentId !== ''
    && input.squarePaymentId !== storedPaymentId;
}

async function readOperation(connectionString, input) {
  return transaction(connectionString, async (client) => {
    if (typeof input.operationId !== 'string' || input.operationId === '') {
      return packaged(result({
        result: 'rejected',
        error: 'square_settlement_operation_unknown',
        retrySafe: false,
      }));
    }
    // The component transaction gate is already held. Payment-oriented paths
    // also take the payment advisory lock before the operation row. Revalidate
    // this preliminary association after locking rather than trusting the read.
    const identities = await client.query(
      'SELECT square_payment_id FROM sandbox_payment_operation WHERE operation_id = $1',
      [input.operationId]
    );
    const identity = identities.rows[0];
    if (!identity) {
      return packaged(result({
        result: 'rejected',
        error: 'square_settlement_operation_unknown',
        retrySafe: false,
      }));
    }
    if (!identity.square_payment_id) {
      return packaged(result({
        result: 'rejected',
        operationId: input.operationId,
        error: 'square_settlement_payment_unassociated',
        financiallySettled: false,
        settlementCommitted: false,
        retrySafe: false,
      }));
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [identity.square_payment_id]);
    const operations = await client.query(
      'SELECT * FROM sandbox_payment_operation WHERE operation_id = $1 FOR UPDATE',
      [input.operationId]
    );
    const operation = operations.rows[0];
    if (!operation) {
      return packaged(result({
        result: 'rejected',
        error: 'square_settlement_operation_unknown',
        retrySafe: false,
      }));
    }
    if (operation.square_payment_id !== identity.square_payment_id) {
      return packaged(result({
        result: 'quarantined',
        operationId: operation.operation_id,
        obligationId: operation.obligation_id,
        squarePaymentId: operation.square_payment_id || '',
        error: 'square_settlement_payment_id_mismatch',
        financiallySettled: false,
        settlementCommitted: false,
        retrySafe: false,
      }));
    }
    const obligations = await client.query(
      'SELECT * FROM sandbox_payment_obligation WHERE obligation_id = $1 FOR UPDATE',
      [operation.obligation_id]
    );
    const obligation = obligations.rows[0];
    if (!obligation) {
      return packaged(result({
        result: 'rejected',
        error: 'square_settlement_obligation_unknown',
        retrySafe: false,
      }));
    }
    if (!operation.square_payment_id) {
      return packaged(result({
        result: 'rejected',
        operationId: operation.operation_id,
        obligationId: obligation.obligation_id,
        error: 'square_settlement_payment_unassociated',
        financiallySettled: false,
        settlementCommitted: false,
        retrySafe: false,
      }));
    }
    if (callerPaymentMismatch(input, operation.square_payment_id)) {
      return packaged(result({
        result: 'rejected',
        operationId: operation.operation_id,
        obligationId: obligation.obligation_id,
        squarePaymentId: operation.square_payment_id,
        error: 'square_settlement_payment_id_mismatch',
        financiallySettled: false,
        settlementCommitted: false,
        retrySafe: false,
      }));
    }
    const settlement = await loadSettlement(client, operation);
    if (settlement && settlementAgrees(settlement, attemptFrom(operation, obligation))) {
      return packaged(confirmedSettlement(settlement), { ready: false });
    }
    if (!settlement && obligation.status === 'settled') {
      return packaged(result({
        result: 'failed',
        operationId: operation.operation_id,
        obligationId: obligation.obligation_id,
        squarePaymentId: operation.square_payment_id,
        error: 'square_settlement_state_inconsistent',
        financiallySettled: false,
        settlementCommitted: false,
        retrySafe: false,
      }));
    }
    if (operation.expected_merchant_id !== obligation.merchant_id
      || operation.expected_location_id !== obligation.location_id
      || operation.expected_amount_cents !== obligation.amount_cents
      || operation.currency !== obligation.currency) {
      return packaged(result({
        result: 'quarantined',
        operationId: operation.operation_id,
        obligationId: obligation.obligation_id,
        squarePaymentId: operation.square_payment_id,
        error: 'square_settlement_context_mismatch',
        financiallySettled: false,
        settlementCommitted: false,
        retrySafe: false,
      }));
    }
    return {
      ready: true,
      operationId: operation.operation_id,
      obligationId: obligation.obligation_id,
      squarePaymentId: operation.square_payment_id,
      amountCents: obligation.amount_cents,
      currency: obligation.currency,
      merchantId: obligation.merchant_id,
      locationId: obligation.location_id,
      bookingRef: obligation.booking_ref,
    };
  });
}

function classifyRetrieval(retrieved, stored) {
  const error = retrieved && retrieved.error;
  if (error === 'square_sandbox_identity_mismatch' || error === 'square_sandbox_payment_id_missing') {
    return { result: 'quarantined', error: 'square_settlement_payment_id_mismatch', processing: 'quarantined' };
  }
  if (error === 'square_sandbox_amount_mismatch') {
    return { result: 'quarantined', error: 'square_settlement_amount_mismatch', processing: 'quarantined' };
  }
  if (error === 'square_sandbox_currency_mismatch') {
    return { result: 'quarantined', error: 'square_settlement_currency_mismatch', processing: 'quarantined' };
  }
  if (error === 'square_sandbox_location_mismatch') {
    return { result: 'quarantined', error: 'square_settlement_location_mismatch', processing: 'quarantined' };
  }
  if (!retrieved || retrieved.providerCalled !== true || retrieved.outcomeUnknown === true) {
    return {
      result: 'failed',
      error: error || 'square_settlement_provider_unknown',
      processing: 'stored',
      retrySafe: true,
    };
  }
  const status = retrieved.normalized && retrieved.normalized.status
    ? retrieved.normalized.status
    : String(retrieved.status || '').toUpperCase();
  if (!retrieved.normalized || retrieved.normalized.recognized !== true || status === 'FAILED' || status === 'CANCELED') {
    return { result: 'rejected', error: error || 'square_settlement_status_rejected', processing: 'rejected' };
  }
  if (status !== 'COMPLETED') {
    return { result: 'pending', processing: 'pending', retrySafe: true };
  }
  const verified = retrieved.ok === true
    && retrieved.error === ''
    && Number.isInteger(retrieved.statusCode) && retrieved.statusCode >= 200 && retrieved.statusCode < 300
    && retrieved.providerCompleted === true
    && retrieved.eligibleForReconciliation === true
    && retrieved.outcomeUnknown === false
    && retrieved.paid === false
    && retrieved.financiallySettled === false
    && retrieved.settled === false
    && retrieved.paymentId === stored.squarePaymentId
    && retrieved.amountCents === stored.amountCents
    && retrieved.currency === 'USD'
    && retrieved.locationAccepted === true
    && retrieved.merchantAccepted === true
    && retrieved.liveMerchantVerification === false;
  if (!verified) {
    return { result: 'quarantined', error: 'square_settlement_verification_unproven', processing: 'quarantined' };
  }
  return { result: 'verified', processing: 'settled' };
}

async function sandboxFetch(fetchImpl, url, init) {
  if (!String(url).startsWith('https://connect.squareupsandbox.com/')) {
    throw new Error('square_settlement_host_rejected');
  }
  return fetchImpl(url, init);
}

async function beginVerification(connectionString, stored) {
  return transaction(connectionString, async (client) => {
    // Settlement may have committed after readOperation released G. Recheck
    // under G before registering: either a matching settlement already exists,
    // or this fence becomes visible before any first settlement can commit.
    const settlement = await loadSettlement(client, {
      operation_id: stored.operationId, obligation_id: stored.obligationId,
      square_payment_id: stored.squarePaymentId,
    });
    if (settlement && settlementAgrees(settlement, stored)) return confirmedSettlement(settlement);
    // Commit a durable fence BEFORE any provider I/O. If the outcome cannot
    // subsequently be written, no later successful retrieval may erase it.
    await client.query(
      `INSERT INTO sandbox_payment_event
        (event_id, square_payment_id, event_type, merchant_id, location_id, payment_status,
         amount_cents, currency, processing_status, source_kind, observed_at)
       VALUES ($1, $2, 'provider.retrieve', $3, $4, '', NULL, NULL,
               'verification_pending', 'verified_provider_retrieval', now())`,
      [stored.verificationEventId, stored.squarePaymentId, stored.merchantId, stored.locationId]
    );
    return result({ result: 'stored' });
  });
}

function historyFailure(stored, persistence) {
  return { ...result({ result: 'failed', operationId: stored.operationId,
    obligationId: stored.obligationId, squarePaymentId: stored.squarePaymentId,
    error: 'square_settlement_verification_history_unconfirmed', retrySafe: true }),
  databaseCommitState: persistence.databaseCommitState || 'unknown',
  ...(persistence.databaseCleanupFailed ? { databaseCleanupFailed: true } : {}) };
}

async function recordVerification(connectionString, stored, retrieved, decision) {
  const amount = retrieved && Number.isInteger(retrieved.amountCents) ? retrieved.amountCents : null;
  const currency = retrieved && typeof retrieved.currency === 'string' && retrieved.currency !== '' ? retrieved.currency : null;
  const status = retrieved && retrieved.normalized && retrieved.normalized.status
    ? retrieved.normalized.status
    : '';
  return transaction(connectionString, async (client) => {
    const written = await client.query(
      `UPDATE sandbox_payment_event
       SET payment_status = $3, amount_cents = $4, currency = $5, processing_status = $6
       WHERE event_id = $1 AND square_payment_id = $2
         AND source_kind = 'verified_provider_retrieval' AND processing_status = 'verification_pending'
       RETURNING event_id`,
      [
        stored.verificationEventId,
        stored.squarePaymentId,
        status,
        amount,
        currency,
        decision.result === 'verified' ? 'verification_required' : decision.processing,
      ]
    );
    if (written.rowCount !== 1) throw new Error('square_settlement_verification_history_missing');
    return result({ result: 'stored' });
  });
}

async function commitSettlement(connectionString, input, stored) {
  return transaction(connectionString, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [stored.squarePaymentId]);
    const operations = await client.query(
      'SELECT * FROM sandbox_payment_operation WHERE operation_id = $1 FOR UPDATE',
      [stored.operationId]
    );
    const operation = operations.rows[0];
    const obligations = await client.query(
      'SELECT * FROM sandbox_payment_obligation WHERE obligation_id = $1 FOR UPDATE',
      [stored.obligationId]
    );
    const obligation = obligations.rows[0];
    if (!operation || !obligation || operation.square_payment_id !== stored.squarePaymentId) {
      return result({
        result: 'quarantined',
        error: 'square_settlement_payment_id_mismatch',
        financiallySettled: false,
        settlementCommitted: false,
        retrySafe: false,
      });
    }
    if (operation.obligation_id !== stored.obligationId
      || operation.expected_amount_cents !== stored.amountCents || obligation.amount_cents !== stored.amountCents
      || operation.currency !== stored.currency || obligation.currency !== stored.currency
      || operation.expected_merchant_id !== stored.merchantId || obligation.merchant_id !== stored.merchantId
      || operation.expected_location_id !== stored.locationId || obligation.location_id !== stored.locationId) {
      return result({ result: 'quarantined', error: 'square_settlement_context_mismatch' });
    }
    // This authoritative recheck shares G, the payment lock and transaction
    // with INSERT/COMMIT. No snapshot taken before retrieval authorizes money.
    const events = (await client.query(
      'SELECT * FROM sandbox_payment_event WHERE square_payment_id = $1 ORDER BY event_id FOR UPDATE',
      [stored.squarePaymentId]
    )).rows;
    const conflict = conflictingEvidence(events, operation);
    const settlement = await loadSettlement(client, operation);
    if (settlement && settlementAgrees(settlement, attemptFrom(operation, obligation))) {
      await markOpenEvents(client, stored.squarePaymentId, conflict ? 'inconsistent' : 'already_settled');
      return conflict ? conflictOutcome(operation, settlement) : confirmedSettlement(settlement);
    }
    if (conflict) {
      await markOpenEvents(client, stored.squarePaymentId, 'inconsistent');
      return conflictOutcome(operation);
    }
    if (events.some(verificationPending)) {
      return result({ result: 'failed', operationId: stored.operationId,
        obligationId: stored.obligationId, squarePaymentId: stored.squarePaymentId,
        error: 'square_settlement_verification_pending', retrySafe: true });
    }
    if (!settlement && obligation.status === 'settled') {
      return result({
        result: 'failed',
        error: 'square_settlement_state_inconsistent',
        financiallySettled: false,
        settlementCommitted: false,
        retrySafe: false,
      });
    }
    const attempt = attemptFrom(operation, obligation);
    const settlementId = `stl_${crypto.randomUUID()}`;
    await insertSettlement(client, attempt, settlementId);
    await client.query(
      "UPDATE sandbox_payment_obligation SET status = 'settled' WHERE obligation_id = $1",
      [operation.obligation_id]
    );
    await client.query(
      "UPDATE sandbox_payment_operation SET status = 'settled', updated_at = now() WHERE operation_id = $1",
      [operation.operation_id]
    );
    await markOpenEvents(client, operation.square_payment_id, 'already_settled');
    await client.query("UPDATE sandbox_payment_event SET processing_status = 'settled' WHERE event_id = $1",
      [stored.verificationEventId]);
    if (input.fault === 'before_commit') return { fault: true };
    return result({
      operationId: operation.operation_id,
      obligationId: obligation.obligation_id,
      squarePaymentId: operation.square_payment_id,
      result: 'settled',
      processingStatus: 'settled',
      settlementStatus: 'settled',
      providerCompleted: true,
      financiallySettled: true,
      settlementCommitted: true,
      retrySafe: true,
    });
  });
}

async function createObligation(connectionString, input = {}) {
  const trusted = expectedContext(input);
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
  const trusted = expectedContext(input);
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
      const existing = await client.query(
        'SELECT * FROM sandbox_settlement WHERE obligation_id = $1',
        [obligation.obligation_id]
      );
      const row = existing.rows[0];
      if (row && row.obligation_id === obligation.obligation_id
        && row.settled_amount_cents === obligation.amount_cents
        && row.currency === obligation.currency
        && row.operation_id && row.square_payment_id) {
        return result({
          result: 'rejected',
          error: 'square_settlement_obligation_already_settled',
          operationId: row.operation_id,
          obligationId: row.obligation_id,
          squarePaymentId: row.square_payment_id,
          processingStatus: 'already_settled',
          settlementStatus: 'settled',
          financiallySettled: true,
          settlementCommitted: false,
          retrySafe: false,
        });
      }
      return result({
        result: 'failed',
        obligationId: obligation.obligation_id,
        error: 'square_settlement_state_inconsistent',
        financiallySettled: false,
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
          financiallySettled: false,
          settlementCommitted: false,
          retrySafe: false,
        });
      }
      return result({
        result: 'stored',
        operationId: row.operation_id,
        obligationId: row.obligation_id,
        squarePaymentId: row.square_payment_id || '',
        processingStatus: row.status,
        financiallySettled: false,
        settlementCommitted: false,
        retrySafe: true,
      });
    }
    if (input.amountCents != null && input.amountCents !== obligation.amount_cents) {
      return result({
        result: 'rejected',
        obligationId: obligation.obligation_id,
        error: 'square_settlement_amount_not_server_controlled',
        financiallySettled: false,
        settlementCommitted: false,
        retrySafe: false,
      });
    }
    if (input.currency != null && input.currency !== obligation.currency) {
      return result({
        result: 'rejected',
        obligationId: obligation.obligation_id,
        error: 'square_settlement_currency_invalid',
        financiallySettled: false,
        settlementCommitted: false,
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
      financiallySettled: false,
      settlementCommitted: false,
      retrySafe: true,
    });
  });
}

async function associatePayment(connectionString, input = {}) {
  const trusted = expectedContext(input);
  if (!trusted.ok) return result({ result: 'rejected', error: trusted.error, retrySafe: false });
  if (typeof input.operationId !== 'string' || typeof input.squarePaymentId !== 'string' || !PAYMENT_PATTERN.test(input.squarePaymentId)) {
    return result({ result: 'rejected', error: 'square_settlement_payment_id_invalid', retrySafe: false });
  }
  const associated = await transaction(connectionString, async (client) => {
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
        financiallySettled: false,
        settlementCommitted: false,
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
        financiallySettled: false,
        settlementCommitted: false,
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
    if (input.fault === 'before_commit') return { fault: true };
    const reviewed = await reviewInbox(client, input.squarePaymentId);
    return reviewed;
  });
  if (!associated || !associated.response) return associated;
  if (associated.verificationRequested === true && typeof input.fetchImpl === 'function') {
    return verifyAndSettle(connectionString, {
      testContext: input.testContext,
      trustedSandbox: input.trustedSandbox,
      operationId: associated.operationId,
      env: input.env,
      fetchImpl: input.fetchImpl,
      timeoutMs: input.timeoutMs,
    });
  }
  return associated.response;
}

async function ingestObservation(connectionString, input = {}) {
  const trusted = expectedContext(input, { allowEventIdentity: true });
  if (!trusted.ok) return result({ result: 'rejected', error: trusted.error, retrySafe: false });
  const parsed = eventFromInput(input);
  if (!parsed.ok) return result({ result: 'rejected', error: parsed.error, retrySafe: false });
  const recorded = await transaction(connectionString, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [parsed.event.paymentId]);
    await insertObservation(client, parsed.event);
    return reviewInbox(client, parsed.event.paymentId);
  });
  if (!recorded || !recorded.response) return recorded;
  if (recorded.verificationRequested === true && typeof input.fetchImpl === 'function') {
    return verifyAndSettle(connectionString, {
      testContext: input.testContext,
      trustedSandbox: input.trustedSandbox,
      operationId: recorded.operationId,
      env: input.env,
      fetchImpl: input.fetchImpl,
      timeoutMs: input.timeoutMs,
      fault: input.fault,
    });
  }
  return recorded.response;
}

async function verifyAndSettle(connectionString, input = {}) {
  const trusted = expectedContext(input);
  if (!trusted.ok) return result({ result: 'rejected', error: trusted.error, retrySafe: false });
  if (typeof input.fetchImpl !== 'function') {
    return result({
      result: 'failed',
      error: 'square_settlement_provider_unavailable',
      financiallySettled: false,
      settlementCommitted: false,
      retrySafe: true,
    });
  }
  const loaded = await readOperation(connectionString, input);
  if (!loaded || loaded.ready !== true) return loaded && loaded.response ? loaded.response : loaded;
  if (loaded.merchantId !== trusted.merchantId || loaded.locationId !== trusted.locationId) {
    return result({
      result: 'quarantined',
      operationId: loaded.operationId,
      obligationId: loaded.obligationId,
      squarePaymentId: loaded.squarePaymentId,
      error: 'square_settlement_context_mismatch',
      financiallySettled: false,
      settlementCommitted: false,
      retrySafe: false,
    });
  }
  loaded.verificationEventId = `evt-v-${crypto.randomUUID()}`;
  const started = await beginVerification(connectionString, loaded)
    .catch(() => ({ result: 'failed', databaseCommitState: 'unknown' }));
  if (started.result === 'already_settled') return started;
  if (started.result !== 'stored' || started.databaseCleanupFailed) return historyFailure(loaded, started);
  let retrieved;
  try {
    retrieved = await retrieveSimulatedPayment({
      testContext: TEST_CONTEXT,
      confirmation: LOCAL_CONFIRMATION,
      purpose: 'sandbox_adapter_test',
      serverBookingRef: loaded.bookingRef,
      trustedSandbox: {
        configuredBy: 'server',
        merchantId: loaded.merchantId,
        locationId: loaded.locationId,
        locationMerchantId: loaded.merchantId,
      },
      amountCents: loaded.amountCents,
      currency: 'USD',
      paymentId: loaded.squarePaymentId,
      env: input.env,
      timeoutMs: input.timeoutMs || 50,
      fetchImpl: (url, init) => sandboxFetch(input.fetchImpl, url, init),
    });
  } catch {
    // An unexpected adapter exception is not proof of an unavailable response.
    // Keep the pending fence; only classified, durably recorded outcomes resolve it.
    return result({ result: 'failed', operationId: loaded.operationId,
      obligationId: loaded.obligationId, squarePaymentId: loaded.squarePaymentId,
      error: 'square_settlement_provider_unknown', retrySafe: true });
  }
  const decision = classifyRetrieval(retrieved, loaded);
  const recorded = await recordVerification(connectionString, loaded, retrieved, decision)
    .catch(() => ({ result: 'failed', databaseCommitState: 'unknown' }));
  if (recorded.result !== 'stored' || recorded.databaseCleanupFailed) return historyFailure(loaded, recorded);
  if (decision.result !== 'verified') {
    return result({
      result: decision.result,
      operationId: loaded.operationId,
      obligationId: loaded.obligationId,
      squarePaymentId: loaded.squarePaymentId,
      processingStatus: decision.processing,
      error: decision.error || '',
      providerCompleted: false,
      financiallySettled: false,
      settlementCommitted: false,
      retrySafe: decision.retrySafe === true,
    });
  }
  // Concurrent valid retrievals may finish in either order. Wait outside G
  // for peers to finalize; an abandoned fence is never cleared by a timeout.
  const deadline = Date.now() + 2000;
  let outcome;
  do {
    outcome = await commitSettlement(connectionString, input, loaded);
    if (outcome.error !== 'square_settlement_verification_pending' || Date.now() >= deadline) return outcome;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (true);
}

module.exports = {
  ADAPTER_COMMIT,
  DEPENDS_ON_PULL_REQUEST,
  PURPOSE,
  createObligation,
  createOperation,
  associatePayment,
  ingestObservation,
  verifyAndSettle,
  retrieveAndReconcile: verifyAndSettle,
};
