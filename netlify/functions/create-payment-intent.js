// netlify/functions/create-payment-intent.js
// Creates a Stripe PaymentIntent for a Cardetail1 booking.
// No npm SDK — calls the Stripe REST API directly via fetch.
//
// Security (C-2): amount is derived server-side from the stored booking's
// totalPrice. Client-submitted amountCents is ignored. The booking must
// exist in Netlify Blobs before this endpoint can be called (pre-registered
// via submit-booking?isDraft=true in the payByCard() flow).
//
// Env (Netlify → Environment variables):
//   STRIPE_SECRET_KEY   secret key (sk_test_... or sk_live_...)
//
// Body expected (JSON):
//   { bookingId: "CD1-...", capture: "manual" }
//   capture: "manual" = authorize/hold (default); "auto" = charge immediately
//
// Returns: { ok, clientSecret, id, captureMethod, mode, amountCents }
//   mode: "test" | "live" — front-end uses this to show a test-mode banner.

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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  const auth = await verifyAdminKey(event.headers || {});
  if (!auth.ok) {
    const status = auth.error === 'missing_admin_config' ? 503 : 401;
    return json(status, { ok: false, error: auth.error || 'unauthorized' });
  }

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return json(503, { ok: false, error: 'Stripe not configured on server' });
  const mode = secret.startsWith('sk_test_') ? 'test' : 'live';

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'Invalid JSON' }); }

  // C-2: bookingId is required; amount is fetched from Blobs, not from the client.
  const bookingId = String(p.bookingId || '').replace(/[^A-Za-z0-9\-]/g, '').slice(0, 48);
  if (!bookingId) return json(400, { ok: false, error: 'bookingId is required' });

  // Fetch the pre-registered booking to get the authoritative total.
  let booking;
  try {
    const store = await blobsStore('cd1-bookings');
    booking = await store.get(bookingId, { type: 'json' });
  } catch (e) {
    return json(503, { ok: false, error: 'Booking store unavailable' });
  }
  if (!booking) return json(404, { ok: false, error: 'Booking not found — pre-register first' });

  const amount = Math.round((Number(booking.totalPrice) || 0) * 100);
  if (amount < 50) return json(400, { ok: false, error: 'Booking total too low to charge (min $0.50)' });

  // capture_method: manual = authorize and hold (ideal for variable final pricing —
  // capture exact amount after service). auto = charge immediately.
  const captureMethod = p.capture === 'auto' ? 'automatic' : 'manual';

  const email = String(booking.email || '').includes('@') ? booking.email.slice(0, 120) : '';

  const form = new URLSearchParams({
    amount: String(amount),
    currency: 'usd',
    capture_method: captureMethod,
    'automatic_payment_methods[enabled]': 'true',
    description: `Cardetail1 booking ${bookingId}`,
  });
  form.append('metadata[booking_id]', bookingId);
  if (email) form.append('receipt_email', email);

  const res = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
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
    mode,
    amountCents: amount,
  });
};
