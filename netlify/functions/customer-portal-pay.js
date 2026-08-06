'use strict';

// Legacy hosted Checkout endpoint. Booking-balance payment is exclusively the
// authenticated Payment Element flow in customer-balance-payment-intent.js.
// Keep this tombstone so old clients fail closed and tests prevent accidental
// reintroduction of a second financial authority.
const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  return {
    statusCode: 410,
    headers,
    body: JSON.stringify({
      ok: false,
      error: 'legacy_checkout_disabled',
      message: 'Hosted Checkout is disabled. Pay securely in My Garage.',
    }),
  };
};
