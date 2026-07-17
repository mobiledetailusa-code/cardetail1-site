// netlify/functions/create-payment-intent.js
// Dormant Pay-in-Full path — Release A routes through authoritative remaining balance.
// Never charges catalog totalPrice when an approved ledger/quote exists.

async function blobsStore(name) {
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token) ? getStore({ name, siteID, token }) : getStore(name);
}

const json = (status, body) => ({
  statusCode: status,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  },
  body: JSON.stringify(body),
});

const { verifyAdminKey } = require('../lib/tech-security');
const { guardStripeOrReject } = require('../lib/stripe-mode');
const { prepareBalanceCheckout } = require('../lib/payment-service');
const { adaptHistoricalBooking } = require('../lib/historical-adapter');
const { normalizeAggregate } = require('../lib/booking-aggregate');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  const auth = await verifyAdminKey(event.headers || {});
  if (!auth.ok) {
    const status = auth.error === 'missing_admin_config' ? 503 : 401;
    return json(status, { ok: false, error: auth.error || 'unauthorized' });
  }

  const stripeGuard = guardStripeOrReject(process.env, { purpose: 'payment_intent' });
  if (stripeGuard.blocked) {
    return json(stripeGuard.statusCode, stripeGuard.body);
  }

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'Invalid JSON' }); }

  const bookingId = String(p.bookingId || '').replace(/[^A-Za-z0-9\-]/g, '').slice(0, 48);
  if (!bookingId) return json(400, { ok: false, error: 'bookingId is required' });

  let booking;
  try {
    const store = await blobsStore('cd1-bookings');
    booking = await store.get(bookingId, { type: 'json' });
  } catch (e) {
    return json(503, { ok: false, error: 'Booking store unavailable' });
  }
  if (!booking) return json(404, { ok: false, error: 'Booking not found — pre-register first' });

  const adapted = adaptHistoricalBooking(booking);
  const raw = adapted.ok ? adapted.booking : booking;
  const { ok: nOk, aggregate } = normalizeAggregate(raw, { allowDraft: true });
  const agg = nOk ? aggregate : raw;

  // Authoritative remaining — ignore client amountCents and catalog totalPrice when ledger/approved exists
  const prepared = prepareBalanceCheckout(agg, {
    expectedBookingVersion: p.expectedBookingVersion,
    expectedQuoteVersion: p.expectedQuoteVersion,
  }, process.env);
  if (!prepared.ok) {
    return json(prepared.statusCode || 400, { ok: false, error: prepared.error });
  }

  const amount = prepared.amountCents;
  if (amount < 50) return json(400, { ok: false, error: 'Booking total too low to charge (min $0.50)' });

  const captureMethod = p.capture === 'auto' ? 'automatic' : 'manual';
  const email = String(agg.email || '').includes('@') ? agg.email.slice(0, 120) : '';

  const form = new URLSearchParams({
    amount: String(amount),
    currency: 'usd',
    capture_method: captureMethod,
    'payment_method_types[0]': 'card',
    description: `Cardetail1 booking ${bookingId}`,
  });
  form.append('metadata[booking_id]', bookingId);
  form.append('metadata[bookingVersion]', String(prepared.bookingVersion));
  form.append('metadata[quoteVersion]', String(prepared.quoteVersion));
  form.append('metadata[purpose]', 'authoritative_balance');
  if (email) form.append('receipt_email', email);

  const res = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${prepared.secret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': prepared.idempotencyKey,
    },
    body: form,
  });

  const pi = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Stripe error:', (pi.error && pi.error.message) || `HTTP ${res.status}`);
    return json(res.status, { ok: false, error: 'payment_error' });
  }

  return json(200, {
    ok: true,
    clientSecret: pi.client_secret,
    id: pi.id,
    captureMethod,
    mode: prepared.stripeMode,
    amountCents: amount,
    bookingVersion: prepared.bookingVersion,
    quoteVersion: prepared.quoteVersion,
  });
};
