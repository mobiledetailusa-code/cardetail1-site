'use strict';

delete process.env.DATABASE_URL;
delete process.env.DIRECT_URL;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.SQUARE_ACCESS_TOKEN;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { publicView } = require('../netlify/lib/db/manual-collection');

test('a stored external conflict stays review evidence and is not payment or Square proof', () => {
  const view = publicView({
    manualCollectionState: 'recorded',
    manualCollectionOperationId: 'op-1',
    manualCollectionQuoteVersion: 1,
    manualCollectionUrl: 'https://square.example/synthetic',
    manualCollectionDetail: {
      externalFinancialConflicts: [{
        providerEventId: 'settlement_pi_synthetic',
        kind: 'settlement',
        amountCents: 15000,
        stripeEventId: 'evt_synthetic',
        squareVerified: true,
      }],
    },
  });
  assert.equal(view.state, 'recorded');
  assert.equal(view.url, 'https://square.example/synthetic');
  assert.equal(view.paid, false);
  assert.equal(view.paymentEvidence, false);
  assert.equal(view.providerVerified, false);
  assert.equal(view.externalFinancialConflicts.length, 1);
  assert.equal(view.externalFinancialConflicts[0].reviewRequired, true);
  assert.equal(view.externalFinancialConflicts[0].squareVerified, false);
});

test('Stripe reconciliation still retrieves the provider event before local recording', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../netlify/lib/db/payment-authority-service.js'),
    'utf8'
  );
  const reconcile = source.slice(
    source.indexOf('async function reconcileFromStripeProvider'),
    source.indexOf('async function projectionInTransaction')
  );
  assert.match(reconcile, /retrievePaymentIntentClientSecret/);
  const webhook = source.slice(
    source.indexOf('async function reconcilePaymentIntentEvent'),
    source.indexOf('function refundBinding')
  );
  const lockAt = webhook.indexOf('preserveExternalEventCollectionConflict');
  const ledgerAt = webhook.indexOf('tx.ledgerEntry.create');
  assert.ok(lockAt >= 0 && ledgerAt > lockAt);
  assert.match(webhook, /settlement_\$\{paymentIntent\.id\}/);
});
