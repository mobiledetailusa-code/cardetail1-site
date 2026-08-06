'use strict';

// Tombstone for caller-selected PaymentIntent capture. Accepting a provider ID
// or capture amount from the browser bypassed the booking/quote/ledger binding.
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
    body: JSON.stringify({ ok: false, error: 'legacy_manual_capture_disabled' }),
  };
};
