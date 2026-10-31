/**
 * Provider-free checks for collection transaction classification.
 * Real PostgreSQL coverage lives in tests/s2g3-real-postgres.integration.js.
 */
'use strict';

delete process.env.DATABASE_URL;
delete process.env.DIRECT_URL;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
delete process.env.SQUARE_ACCESS_TOKEN;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  COLLECTION_TRANSACTION_ATTEMPTS,
  classifyCollectionTransactionError,
  executeCollectionTransaction,
} = require('../netlify/lib/db/manual-collection');

test('serialization and deadlock retry the whole transaction', () => {
  for (const error of [
    { code: '40001', message: 'could not serialize access due to concurrent update' },
    { meta: { code: '40P01' }, message: 'deadlock detected' },
    { code: 'P2034', message: 'Transaction failed due to a write conflict' },
  ]) {
    const decision = classifyCollectionTransactionError(error);
    assert.equal(decision.retry, true);
    assert.equal(decision.error, 'manual_collection_retry_exhausted');
  }
});

test('a dropped connection stays distinct from a definite statement failure', () => {
  const dropped = classifyCollectionTransactionError(new Error('server closed the connection unexpectedly'));
  assert.equal(dropped.retry, true);
  assert.equal(dropped.error, 'manual_collection_outcome_unknown');
  const definite = classifyCollectionTransactionError(new Error('database unavailable'));
  assert.equal(definite.retry, false);
  assert.equal(definite.error, 'manual_collection_persist_failed');
});

test('a serialization retry rereads the committed balance before reserving', async () => {
  let attempts = 0;
  let writes = 0;
  const result = await executeCollectionTransaction(async () => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error('could not serialize access');
      error.code = '40001';
      throw error;
    }
    const remainingCents = 0;
    if (remainingCents <= 0) {
      return { ok: false, error: 'zero_remaining_balance', statusCode: 409 };
    }
    writes += 1;
    return { ok: true, created: true };
  });
  assert.equal(attempts, 2);
  assert.equal(writes, 0);
  assert.equal(result.error, 'zero_remaining_balance');
  assert.equal(COLLECTION_TRANSACTION_ATTEMPTS >= 2, true);
});

test('an ambiguous failure retries through a later authoritative read', async () => {
  let attempts = 0;
  const durable = { operationId: null };
  const result = await executeCollectionTransaction(async () => {
    attempts += 1;
    if (durable.operationId) {
      return { ok: true, idempotent: true, operationId: durable.operationId, created: false };
    }
    if (attempts === 1) {
      durable.operationId = 'op-committed-before-ack';
      throw new Error('Connection terminated unexpectedly');
    }
    return { ok: true, created: true, operationId: 'op-second-write' };
  });
  assert.equal(attempts, 2);
  assert.equal(result.idempotent, true);
  assert.equal(result.operationId, 'op-committed-before-ack');
});

test('exhausted serialization retries do not become an unknown commit', async () => {
  let attempts = 0;
  const result = await executeCollectionTransaction(async () => {
    attempts += 1;
    const error = new Error('deadlock detected');
    error.meta = { driverAdapterError: { cause: { originalCode: '40P01' } } };
    throw error;
  }, 3);
  assert.equal(attempts, 3);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'manual_collection_retry_exhausted');
  assert.equal(result.paid, false);
});

test('a definite failure is not retried', async () => {
  let attempts = 0;
  const result = await executeCollectionTransaction(async () => {
    attempts += 1;
    throw new Error('check constraint Booking_manual_collection_state');
  });
  assert.equal(attempts, 1);
  assert.equal(result.error, 'manual_collection_persist_failed');
});
