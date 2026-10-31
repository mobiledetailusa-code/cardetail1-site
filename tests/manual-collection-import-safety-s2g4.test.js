'use strict';

delete process.env.DATABASE_URL;
delete process.env.DIRECT_URL;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.SQUARE_ACCESS_TOKEN;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  IMPORT_TRANSACTION_ATTEMPTS,
  blocksFinancialImport,
  importFailureKind,
} = require('../netlify/lib/db/ensure-booking-financial');

test('active and unknown manual states block financial import', () => {
  for (const state of ['reserved', 'recorded', 'payment_reported', 'weird']) {
    assert.equal(blocksFinancialImport(state), true);
  }
});

test('closed and empty manual states do not block financial import by themselves', () => {
  for (const state of [null, undefined, '', 'closed']) {
    assert.equal(blocksFinancialImport(state), false);
  }
});

test('import retries are bounded and keep distinct failure classes', () => {
  assert.equal(IMPORT_TRANSACTION_ATTEMPTS, 3);
  assert.equal(importFailureKind({ code: 'P2034' }), 'retry');
  assert.equal(importFailureKind({ message: 'deadlock detected' }), 'retry');
  assert.equal(importFailureKind({ code: '40001' }), 'retry');
  assert.equal(importFailureKind({ message: 'server closed the connection' }), 'reread');
  assert.equal(importFailureKind({ message: 'synthetic_import_rollback' }), 'failed');
});

test('card preparation stops when financial import is blocked', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../netlify/lib/db/operational-payment.js'),
    'utf8'
  );
  const prepare = source.slice(
    source.indexOf('async function prepareEmbeddedPaymentInner'),
    source.indexOf('async function adminReconcileWithStripe')
  );
  assert.match(prepare, /synchronizationBlocked/);
  assert.match(prepare, /manual_collection_active/);
  assert.doesNotMatch(prepare.slice(0, prepare.indexOf('synchronizationBlocked')), /reserveAndCreatePaymentIntent/);
});
