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

const {
  blobsStore,
  cleanBookingId,
  json: secureJson,
  rateLimit,
  requireAdmin,
} = require('./_security');

let currentEvent;
const json = (status, body) => secureJson(currentEvent, status, body);

exports.handler = async (event) => {
  currentEvent = event;
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  const rl = await rateLimit(event, 'capture-payment', 30, 60);
  if (!rl.ok) return json(rl.status, rl.body);

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return json(503, { ok: false, error: 'Stripe not configured on server' });
  const admin = requireAdmin(event);
  if (!admin.ok) return json(admin.status, admin.body);

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
    const bookingId = cleanBookingId(p.bookingId);
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
