'use strict';

// Tombstone for the former admin/manual-capture PaymentIntent creator. The
// only booking-balance creator is customer-balance-payment-intent.js, which
// derives its amount from the PostgreSQL ledger authority.
const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  return {
    statusCode: 410,
    headers,
    body: JSON.stringify({ ok: false, error: 'legacy_payment_intent_disabled' }),
  };
};
