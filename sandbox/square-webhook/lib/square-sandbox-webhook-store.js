'use strict';

/**
 * Insert one authenticated Square Sandbox event.
 * event_id is the only identity. A repeated id does not change the stored row.
 * Payment id is not unique. This store does not open DATABASE_URL.
 */

const INSERT_EVENT_SQL = `
INSERT INTO square_sandbox_webhook_event (
  event_id,
  merchant_id,
  event_type,
  payment_id,
  payment_status,
  event_created_at,
  verification_result,
  processing_state,
  amount_cents,
  currency
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
)
ON CONFLICT (event_id) DO NOTHING
RETURNING event_id
`.trim();

const PROCESSING_STATES = new Set(['stored', 'unsupported', 'rejected_merchant']);

function insertSquareSandboxWebhookEvent(client, row) {
  if (!client || typeof client.query !== 'function') {
    return Promise.reject(new Error('square_sandbox_webhook_client_missing'));
  }
  if (!row || typeof row.eventId !== 'string' || row.eventId.length === 0) {
    return Promise.reject(new Error('square_sandbox_webhook_event_id_missing'));
  }
  if (!PROCESSING_STATES.has(row.processingState)) {
    return Promise.reject(new Error('square_sandbox_webhook_state_rejected'));
  }
  return client.query(INSERT_EVENT_SQL, [
    row.eventId,
    row.merchantId || null,
    row.eventType || null,
    row.paymentId || null,
    row.paymentStatus || null,
    row.eventCreatedAt || null,
    'verified',
    row.processingState,
    Number.isInteger(row.amountCents) ? row.amountCents : null,
    row.currency || null,
  ]).then((result) => ({
    inserted: result.rowCount === 1,
    eventId: result.rows && result.rows[0] ? result.rows[0].event_id : null,
  }));
}

async function connectSandboxPostgres(databaseUrl) {
  const { Client } = require('pg');
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  });
  await client.connect();
  return client;
}

module.exports = {
  INSERT_EVENT_SQL,
  connectSandboxPostgres,
  insertSquareSandboxWebhookEvent,
};
