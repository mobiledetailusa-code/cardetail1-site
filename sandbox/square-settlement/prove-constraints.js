'use strict';

const db = require('./database');

const url = 'postgresql://cardetail1_ci@127.0.0.1:5433/cardetail1_square_settlement_7d';

async function expectCode(client, sql, params) {
  try {
    await client.query(sql, params);
    return 'inserted';
  } catch (error) {
    return error.code;
  }
}

async function main() {
  db.assertLocalSettlementUrl('postgresql://cardetail1_ci@127.0.0.1:5432/cardetail1_square_settlement_7d');
  let refused = '';
  try {
    db.assertLocalSettlementUrl('postgresql://cardetail1_ci@127.0.0.1:5432/cardetail1_ci');
  } catch (error) {
    refused = error.message;
  }
  if (refused !== 'square_settlement_database_unproven') {
    throw new Error('ci database was not refused');
  }
  refused = '';
  try {
    db.assertLocalSettlementUrl('postgresql://user@ep-example.neon.tech/cardetail1_square_settlement_7d');
  } catch (error) {
    refused = error.message;
  }
  if (refused !== 'square_settlement_database_unproven') {
    throw new Error('remote host was not refused');
  }

  await db.emptySettlementTables(url);
  await db.applySettlementSchema(url);
  const client = await db.connectProven(url);
  try {
    await client.query(
      `INSERT INTO sandbox_payment_obligation
        (obligation_id, booking_ref, purpose, amount_cents, currency, merchant_id, location_id, status)
       VALUES ('obl-1', 'TEST-SQ-7D', 'sandbox_settlement_test', 100, 'USD', 'MERCHANT_TEST_7D', 'LOC_TEST_7D', 'authorized')`
    );
    const operation = await expectCode(
      client,
      `INSERT INTO sandbox_payment_operation
        (operation_id, obligation_id, provider, idempotency_key, expected_amount_cents, currency,
         expected_merchant_id, expected_location_id, status)
       VALUES ('op-1', 'obl-1', 'square_sandbox', 'sandbox-op-1', 100, 'USD', 'MERCHANT_TEST_7D', 'LOC_TEST_7D', 'open')`
    );
    const duplicateKey = await expectCode(
      client,
      `INSERT INTO sandbox_payment_operation
        (operation_id, obligation_id, provider, idempotency_key, expected_amount_cents, currency,
         expected_merchant_id, expected_location_id, status)
       VALUES ('op-2', 'obl-1', 'square_sandbox', 'sandbox-op-1', 100, 'USD', 'MERCHANT_TEST_7D', 'LOC_TEST_7D', 'open')`
    );
    await client.query(
      `INSERT INTO sandbox_payment_obligation
        (obligation_id, booking_ref, purpose, amount_cents, currency, merchant_id, location_id, status)
       VALUES ('obl-2', 'TEST-SQ-7D2', 'sandbox_settlement_test', 100, 'USD', 'MERCHANT_TEST_7D', 'LOC_TEST_7D', 'authorized')`
    );
    await client.query(
      "UPDATE sandbox_payment_operation SET square_payment_id = 'sandboxPay7dA', status = 'associated' WHERE operation_id = 'op-1'"
    );
    const duplicatePayment = await expectCode(
      client,
      `INSERT INTO sandbox_payment_operation
        (operation_id, obligation_id, provider, idempotency_key, square_payment_id, expected_amount_cents,
         currency, expected_merchant_id, expected_location_id, status)
       VALUES ('op-3', 'obl-2', 'square_sandbox', 'sandbox-op-3', 'sandboxPay7dA', 100, 'USD',
               'MERCHANT_TEST_7D', 'LOC_TEST_7D', 'associated')`
    );
    const firstEvent = await expectCode(
      client,
      `INSERT INTO sandbox_payment_event
        (event_id, square_payment_id, event_type, merchant_id, location_id, payment_status,
         amount_cents, currency, processing_status, source_kind, observed_at)
       VALUES ('evt-1', 'sandboxPay7dA', 'payment.created', 'MERCHANT_TEST_7D', 'LOC_TEST_7D',
               'COMPLETED', 100, 'USD', 'stored', 'unverified_observation', now())`
    );
    const secondEvent = await expectCode(
      client,
      `INSERT INTO sandbox_payment_event
        (event_id, square_payment_id, event_type, merchant_id, location_id, payment_status,
         amount_cents, currency, processing_status, source_kind, observed_at)
       VALUES ('evt-2', 'sandboxPay7dA', 'payment.updated', 'MERCHANT_TEST_7D', 'LOC_TEST_7D',
               'COMPLETED', 100, 'USD', 'stored', 'unverified_observation', now())`
    );
    const duplicateEvent = await expectCode(
      client,
      `INSERT INTO sandbox_payment_event
        (event_id, square_payment_id, event_type, merchant_id, location_id, payment_status,
         amount_cents, currency, processing_status, source_kind, observed_at)
       VALUES ('evt-1', 'sandboxPay7dA', 'payment.created', 'MERCHANT_TEST_7D', 'LOC_TEST_7D',
               'APPROVED', 100, 'USD', 'stored', 'unverified_observation', now())`
    );
    const settlement = await expectCode(
      client,
      `INSERT INTO sandbox_settlement
        (settlement_id, obligation_id, operation_id, square_payment_id, settled_amount_cents, currency)
       VALUES ('stl-1', 'obl-1', 'op-1', 'sandboxPay7dA', 100, 'USD')`
    );
    const duplicateSettlement = await expectCode(
      client,
      `INSERT INTO sandbox_settlement
        (settlement_id, obligation_id, operation_id, square_payment_id, settled_amount_cents, currency)
       VALUES ('stl-2', 'obl-1', 'op-1', 'sandboxPay7dB', 100, 'USD')`
    );
    const badCurrency = await expectCode(
      client,
      `INSERT INTO sandbox_payment_obligation
        (obligation_id, booking_ref, purpose, amount_cents, currency, merchant_id, location_id, status)
       VALUES ('obl-bad', 'TEST-SQ-BAD', 'sandbox_settlement_test', 100, 'EUR', 'MERCHANT_TEST_7D', 'LOC_TEST_7D', 'authorized')`
    );
    const counts = await client.query(
      'SELECT (SELECT count(*)::int FROM sandbox_payment_event) AS events, (SELECT count(*)::int FROM sandbox_settlement) AS settlements'
    );
    const report = {
      operation,
      duplicateKey,
      duplicatePayment,
      firstEvent,
      secondEvent,
      duplicateEvent,
      settlement,
      duplicateSettlement,
      badCurrency,
      counts: counts.rows[0],
    };
    const expected = {
      operation: 'inserted',
      duplicateKey: '23505',
      duplicatePayment: '23505',
      firstEvent: 'inserted',
      secondEvent: 'inserted',
      duplicateEvent: '23505',
      settlement: 'inserted',
      duplicateSettlement: '23505',
      badCurrency: '23514',
      events: 2,
      settlements: 1,
    };
    const actual = {
      ...report,
      events: report.counts.events,
      settlements: report.counts.settlements,
    };
    delete actual.counts;
    const failures = Object.keys(expected).filter((key) => actual[key] !== expected[key]);
    console.log(JSON.stringify({ actual, failures }, null, 2));
    if (failures.length) process.exitCode = 1;
  } finally {
    await client.end();
    await db.emptySettlementTables(url);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
