'use strict';

/**
 * Portal account load must survive a broken Postgres path.
 * Deploy-preview often has DATABASE_URL set while the DB/adapter is unreachable;
 * that used to throw out of customer-portal-data and surface as
 * "Your account is temporarily unavailable."
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const OP_PATH = path.join(ROOT, 'netlify/lib/db/operational-payment.js');
const ENSURE_PATH = path.join(ROOT, 'netlify/lib/db/ensure-booking-financial.js');
const PORTAL_DATA = path.join(ROOT, 'netlify/functions/customer-portal-data.js');

function bust(rel) {
  const abs = path.join(ROOT, rel);
  delete require.cache[require.resolve(abs)];
}

test('getSharedFinancialProjection degrades instead of throwing when ensure fails', async () => {
  const prevUrl = process.env.DATABASE_URL;
  const prevPay = process.env.CD1_POSTGRES_PAYMENT;
  process.env.DATABASE_URL = 'postgresql://portal-fallback-test.invalid/db';
  process.env.CD1_POSTGRES_PAYMENT = '1';

  const ensureResolved = require.resolve(ENSURE_PATH);
  const previousEnsure = require.cache[ensureResolved];
  require.cache[ensureResolved] = {
    id: ensureResolved,
    filename: ensureResolved,
    loaded: true,
    exports: {
      ensureBookingFinancial: async () => {
        throw new Error('simulated_db_unreachable');
      },
    },
  };

  try {
    bust('netlify/lib/db/operational-payment.js');
    const { getSharedFinancialProjection } = require(OP_PATH);
    const result = await getSharedFinancialProjection({
      id: 'CD1-FALLBACK01',
      ledger: { approvedCents: 5000, settledCents: 0 },
      amountDueApproved: 50,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'projection_unavailable');
    assert.equal(result.authority, 'blob');
  } finally {
    if (previousEnsure) require.cache[ensureResolved] = previousEnsure;
    else delete require.cache[ensureResolved];
    bust('netlify/lib/db/operational-payment.js');
    if (prevUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevUrl;
    if (prevPay === undefined) delete process.env.CD1_POSTGRES_PAYMENT;
    else process.env.CD1_POSTGRES_PAYMENT = prevPay;
  }
});

test('customer-portal-data wraps the handler and payment path for soft failure', () => {
  const src = fs.readFileSync(PORTAL_DATA, 'utf8');
  assert.match(src, /payment_projection_fallback/);
  assert.match(src, /error: 'service_unavailable'/);
  assert.match(src, /handlePortalData/);
  assert.match(src, /shared_projection_failed|getSharedFinancialProjection/);
});
