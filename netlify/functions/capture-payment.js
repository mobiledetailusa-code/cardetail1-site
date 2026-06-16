// netlify/functions/capture-payment.js
// Captures a previously authorized (manual-capture) Stripe PaymentIntent — used
// to charge the held amount AFTER the service is completed. Admin-protected.
// No npm deps — Stripe REST via fetch.
//
// Env: STRIPE_SECRET_KEY, ADMIN_DASH_PASSWORD
//   POST {paymentIntentId, amountCents?, bookingId?}  (header x-admin-key)
//     amountCents optional → capture less than authorized (e.g., final price
//     lower than the hold). Omit to capture the full authorized amount.
//     bookingId optional → when provided, immediately sets paymentStatus to
//     'capture_pending' in Blobs so admin sees progress; the webhook sets it
//     to 'paid' once payment_intent.succeeded fires.

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

async function blobsStore(name) {
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token) ? getStore({ name, siteID, token }) : getStore(name);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return json(503, { ok: false, error: 'Stripe not configured on server' });
  const expected = process.env.ADMIN_DASH_PASSWORD || '';
  if (!expected) return json(503, { ok: false, error: 'ADMIN_DASH_PASSWORD not set on server' });
  const key = (event.headers && (event.headers['x-admin-key'] || event.headers['X-Admin-Key'])) || '';
  if (key !== expected) return json(401, { ok: false, error: 'unauthorized' });

  let p;
  try { p = JSON.parse(event.body || '{}'); } catch { return json(400, { ok: false, error: 'Invalid JSON' }); }
  const pi = String(p.paymentIntentId || '');
  if (!/^pi_/.test(pi)) return json(400, { ok: false, error: 'invalid paymentIntentId' });

  const form = new URLSearchParams();
  if (p.amountCents && Number(p.amountCents) > 0) form.append('amount_to_capture', String(Math.round(Number(p.amountCents))));

  try {
    const res = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(pi)}/capture`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return json(res.status, { ok: false, error: (data.error && data.error.message) || `Stripe ${res.status}` });

    // Immediately mark the booking as capture_pending so admin sees progress while
    // waiting for the payment_intent.succeeded webhook to arrive and set it to 'paid'.
    const bookingId = String(p.bookingId || '').trim().toUpperCase();
    if (bookingId) {
      try {
        const store = await blobsStore('cd1-bookings');
        const booking = await store.get(bookingId, { type: 'json' }).catch(() => null);
        if (booking && booking.paymentStatus === 'authorized') {
          await store.setJSON(bookingId, {
            ...booking,
            paymentStatus: 'capture_pending',
            captureInitiatedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
      } catch (e) {
        // Non-fatal: Stripe capture already succeeded; webhook will handle final status.
        console.warn('[capture-payment] blobs capture_pending update failed:', e.message);
      }
    }

    return json(200, { ok: true, id: data.id, status: data.status, amount_received: data.amount_received });
  } catch (e) {
    return json(500, { ok: false, error: e.message });
  }
};
