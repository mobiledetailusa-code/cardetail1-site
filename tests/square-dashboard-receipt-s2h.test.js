'use strict';

delete process.env.DATABASE_URL;
delete process.env.DIRECT_URL;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.SQUARE_ACCESS_TOKEN;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateSquareDashboardReceipt,
  isOnSiteSettlementEntry,
  squareDashboardProviderEventId,
} = require('../netlify/lib/db/payment-authority-service');
const { publicView, closeManualCollection } = require('../netlify/lib/db/manual-collection');
const { computeFinancialProjection } = require('../netlify/lib/db/financial-projection');

const booking = {
  id: 'CD1-S2H',
  manualCollectionState: 'recorded',
  manualCollectionOperationId: 'op-1',
  manualCollectionQuoteVersion: 1,
  manualCollectionUrl: 'https://square.example/synthetic',
  manualCollectionDetail: { recordedAt: '2026-10-30T00:00:00.000Z' },
};

function projection(ledgerEntries = [], attempts = []) {
  return computeFinancialProjection({
    booking,
    quote: { quoteVersion: 1, approvedCents: 15000, currency: 'usd' },
    paymentAttempts: attempts,
    ledgerEntries,
    refundRequests: [],
  });
}

function claim(extra = {}) {
  return {
    booking,
    quote: { id: 'q1', quoteVersion: 1, approvedCents: 15000, currency: 'usd' },
    projection: projection(),
    ledgerEntries: [],
    paymentAttempts: [],
    amountCents: 15000,
    currency: 'usd',
    squareTransactionRef: 'sq_txn_1001',
    operationId: 'op-1',
    actorId: 'ada',
    dashboardObserved: true,
    now: '2026-10-30T21:00:00.000Z',
    ...extra,
  };
}

test('a matching dashboard receipt is a settlement and is not cash, card, or Square API proof', () => {
  const decision = evaluateSquareDashboardReceipt(claim());
  assert.equal(decision.ok, true);
  assert.equal(decision.write, true);
  assert.equal(decision.ledger.kind, 'settlement');
  assert.equal(decision.ledger.providerEventId, squareDashboardProviderEventId('sq_txn_1001'));
  assert.equal(decision.ledger.actor, 'ada');
  assert.equal(decision.ledger.amountCents, 15000);
  assert.equal(isOnSiteSettlementEntry(decision.ledger), false);
  assert.equal(decision.squareVerified, false);
  assert.equal(decision.apiVerified, false);
  assert.equal(decision.providerVerified, false);
  assert.equal(decision.patch.manualCollectionState, 'payment_reported');
  assert.equal(decision.patch.manualCollectionDetail.squareDashboardReceipt.verificationMethod, 'administrator_square_dashboard');
});

test('an inconsistent amount or currency is refused before a ledger write', () => {
  assert.equal(evaluateSquareDashboardReceipt(claim({ amountCents: 14000 })).error, 'square_receipt_amount_mismatch');
  assert.equal(evaluateSquareDashboardReceipt(claim({ amountCents: 15000.5 })).error, 'square_receipt_amount_mismatch');
  assert.equal(evaluateSquareDashboardReceipt(claim({ currency: 'eur' })).error, 'square_receipt_currency_mismatch');
  assert.equal(evaluateSquareDashboardReceipt(claim({ amountCents: 14000 })).write, undefined);
});

test('the same Square reference on another booking is a conflict', () => {
  const decision = evaluateSquareDashboardReceipt(claim({
    existingReceipt: {
      bookingId: 'CD1-OTHER',
      kind: 'settlement',
      amountCents: 15000,
      currency: 'usd',
      providerEventId: squareDashboardProviderEventId('sq_txn_1001'),
    },
  }));
  assert.equal(decision.ok, false);
  assert.equal(decision.error, 'square_reference_conflict');
});

test('the same receipt for the same booking is idempotent', () => {
  const decision = evaluateSquareDashboardReceipt(claim({
    existingReceipt: {
      bookingId: 'CD1-S2H',
      kind: 'settlement',
      amountCents: 15000,
      currency: 'usd',
    },
  }));
  assert.equal(decision.ok, true);
  assert.equal(decision.idempotent, true);
  assert.equal(decision.ledgerEntryCreated, false);
});

test('an existing settlement or external conflict requires review and does not credit again', () => {
  const settled = evaluateSquareDashboardReceipt(claim({
    ledgerEntries: [{ kind: 'settlement', amountCents: 5000, providerEventId: 'settlement_pi_existing' }],
    projection: projection([{ kind: 'settlement', amountCents: 5000 }]),
  }));
  assert.equal(settled.error, 'square_receipt_review_required');
  const conflicted = evaluateSquareDashboardReceipt(claim({
    booking: {
      ...booking,
      manualCollectionDetail: {
        externalFinancialConflicts: [{ providerEventId: 'settlement_pi_existing' }],
      },
    },
  }));
  assert.equal(conflicted.error, 'square_receipt_review_required');
});

test('payment_reported without a ledger receipt cannot close as reconciled', async () => {
  const result = await closeManualCollection({
    bookingId: 'CD1-S2H',
    actorId: 'ada',
    operationId: 'op-1',
    outcome: 'receipt_reconciled',
    reason: 'dashboard checked',
    confirmation: {
      ledgerRecorded: true,
      dashboardReceiptMatches: true,
      linkDeactivated: true,
      responsibilityAccepted: true,
    },
    env: { CD1_POSTGRES_PAYMENT: '1', DATABASE_URL: 'postgres://fixture-not-contacted' },
  }, {
    authorityEnabled: () => true,
    withBookingLock: async (_id, operation) => operation({
      readBooking: async () => ({
        ...booking,
        manualCollectionState: 'payment_reported',
      }),
      readProjection: async () => projection(),
      writeCollection: async () => { throw new Error('must not write'); },
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'square_receipt_missing');
});

test('a recorded receipt can close only when the balance is clear and the link deactivation is attested', async () => {
  let written = null;
  const paid = projection([{ kind: 'settlement', amountCents: 15000, providerEventId: 'square_dashboard_receipt:sq_txn_1001' }]);
  const row = {
    ...booking,
    manualCollectionState: 'payment_reported',
    manualCollectionDetail: {
      squareDashboardReceipt: {
        providerEventId: 'square_dashboard_receipt:sq_txn_1001',
        squareTransactionRef: 'sq_txn_1001',
        amountCents: 15000,
        currency: 'usd',
        squareVerified: true,
      },
    },
  };
  const result = await closeManualCollection({
    bookingId: 'CD1-S2H',
    actorId: 'ada',
    operationId: 'op-1',
    outcome: 'receipt_reconciled',
    reason: 'Dashboard receipt matches the ledger and the link was deactivated',
    confirmation: {
      ledgerRecorded: true,
      dashboardReceiptMatches: true,
      linkDeactivated: true,
      responsibilityAccepted: true,
    },
    env: { CD1_POSTGRES_PAYMENT: '1', DATABASE_URL: 'postgres://fixture-not-contacted' },
  }, {
    authorityEnabled: () => true,
    withBookingLock: async (_id, operation) => {
      const decision = await operation({
        readBooking: async () => row,
        readProjection: async () => paid,
        writeCollection: async (patch) => { written = patch; },
      });
      return decision;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(written.manualCollectionState, 'closed');
  assert.equal(written.manualCollectionUrl, undefined);
  assert.equal(result.manualCollection.squareDashboardReceipt.squareVerified, false);
  assert.equal(result.manualCollection.squareDashboardReceipt.providerVerified, false);
  assert.equal(result.manualCollection.url, 'https://square.example/synthetic');
  const view = publicView({ ...row, ...written, manualCollectionUrl: row.manualCollectionUrl });
  assert.equal(view.paid, false);
  assert.equal(view.providerVerified, false);
});
