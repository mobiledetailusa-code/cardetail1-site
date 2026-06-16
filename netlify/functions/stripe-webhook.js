// netlify/functions/stripe-webhook.js
// Validates Stripe webhook signatures, persists payment status to Blobs,
// and triggers technician dispatch when a card hold is confirmed.
//
// Canonical paymentStatus enum:
//   no_payment_required_yet | authorization_pending | authorized |
//   authorization_failed | capture_pending | paid | canceled |
//   refunded | expired
//
// Dispatch rule: auction is only posted when paymentStatus transitions to
// 'authorized' (amount_capturable_updated) — never on cash/pending bookings.
//
// Env (Netlify):
//   STRIPE_WEBHOOK_SECRET  whsec_... (Stripe → Developers → Webhooks)
//   ADMIN_EMAIL + RESEND_API_KEY  (optional) → email notifications
//   BID_SECRET  (required for auction/dispatch)
//   SITE_URL    (required for bid magic links)

const crypto = require('crypto');

async function blobsStore(name) {
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token) ? getStore({ name, siteID, token }) : getStore(name);
}

// ── Stripe signature verification (no SDK, HMAC-SHA256, 5-min replay window) ──
function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const parts = {};
  sigHeader.split(',').forEach(kv => { const [k, v] = kv.split('='); parts[k] = v; });
  if (!parts.t || !parts.v1) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(parts.t));
  if (age > 300) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parts.t}.${rawBody}`, 'utf8')
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Read booking, apply updates, write back to Blobs ──
async function updateBookingPayment(bookingId, updates) {
  if (!bookingId || bookingId === '—') {
    return { updated: false, reason: 'no booking_id in Stripe metadata' };
  }
  try {
    const store = await blobsStore('cd1-bookings');
    const booking = await store.get(bookingId, { type: 'json' });
    if (!booking) return { updated: false, reason: 'booking not found: ' + bookingId };
    const updated = { ...booking, ...updates, updatedAt: new Date().toISOString() };
    await store.setJSON(bookingId, updated);
    return { updated: true, booking: updated };
  } catch (e) {
    return { updated: false, reason: e.message };
  }
}

// ── HMAC signature for tech bid magic links ──
function signBid(jobId, techId, secret) {
  return crypto.createHmac('sha256', secret)
    .update(String(jobId) + '|' + String(techId))
    .digest('hex');
}

// ── Create auction + optionally SMS techs (idempotent — skips if already exists) ──
// Dispatch is intentionally SMS-gated: Twilio vars must be set in production.
// In test/dev environments without Twilio, the auction record is created in
// Blobs but no messages are sent (notified: 0). This is the correct test mode
// behavior — admin can still see the auction in the dashboard.
async function triggerAuction(b) {
  const secret = process.env.BID_SECRET;
  if (!secret) return { posted: false, reason: 'BID_SECRET not set' };
  try {
    // Idempotency guard: do not create a second auction for the same booking.
    const existing = await (await blobsStore('cd1-auctions')).get(b.id, { type: 'json' });
    if (existing) return { posted: false, reason: 'auction already exists for ' + b.id };

    const roster = (await (await blobsStore('cd1-techs')).get('roster', { type: 'json' })) || [];
    // Job object stored in auction. 'total' is admin-visible; techView() in
    // auction.js strips it before returning data to technicians.
    const job = {
      package: b.package || '',
      vehicle: b.vehicle || b.vehicleCategory || '',
      date: b.preferredDate || '',
      time: b.preferredTime || '',
      area: b.zone || b.zipCode || '',
      total: b.totalPrice || 0,
    };
    await (await blobsStore('cd1-auctions')).setJSON(b.id, {
      jobId: b.id,
      status: 'open',
      job,
      bids: [],
      winner: null,
      createdAt: new Date().toISOString(),
      paymentStatus: b.paymentStatus || 'authorized',
      amountAuthorizedCents: b.amountAuthorizedCents || 0,
    });

    const base = process.env.SITE_URL || '';
    const { TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM } = process.env;
    let notified = 0;
    if (TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM && base && roster.length) {
      const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
      await Promise.all(roster.map(t => {
        const sig = signBid(b.id, t.id, secret);
        const link = `${base}/bid.html?job=${encodeURIComponent(b.id)}&tech=${encodeURIComponent(t.id)}&sig=${sig}`;
        const body = new URLSearchParams({
          To: t.phone, From: TWILIO_FROM,
          Body: `New Cardetail1 job: ${job.package} · ${job.date} · ${job.area}. Place your bid (lowest wins): ${link}`,
        });
        return fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
          method: 'POST',
          headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        }).then(r => { if (r.ok) notified++; }).catch(() => {});
      }));
    }
    return { posted: true, techs: roster.length, notified };
  } catch (e) {
    return { posted: false, reason: e.message };
  }
}

async function notifyAdmin(subject, text) {
  const { ADMIN_EMAIL, RESEND_API_KEY, RESEND_FROM } = process.env;
  if (!ADMIN_EMAIL || !RESEND_API_KEY) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: RESEND_FROM || 'Cardetail1 <onboarding@resend.dev>',
        to: [ADMIN_EMAIL],
        subject,
        text,
      }),
    });
  } catch (e) { console.warn('[webhook] email error:', e.message); }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET not set — rejecting all events');
    return { statusCode: 503, body: 'Webhook secret not configured' };
  }
  if (!verifyStripeSignature(raw, sig, webhookSecret)) {
    return { statusCode: 400, body: 'Invalid signature' };
  }

  let evt;
  try { evt = JSON.parse(raw); }
  catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  const pi = (evt.data && evt.data.object) ? evt.data.object : {};
  const bookingId = (pi.metadata && pi.metadata.booking_id) || '—';
  const dollars = pi.amount != null ? (pi.amount / 100).toFixed(2) : '?';
  const results = {};

  switch (evt.type) {

    case 'payment_intent.amount_capturable_updated': {
      // capture_method=manual: card is authorized (hold placed). This is the
      // signal that dispatch is now allowed.
      results.update = await updateBookingPayment(bookingId, {
        paymentStatus: 'authorized',
        paymentIntentId: pi.id,
        amountAuthorizedCents: pi.amount,
      });
      // Trigger auction only if the Blobs write succeeded.
      if (results.update.updated) {
        results.auction = await triggerAuction(results.update.booking);
      }
      await notifyAdmin(
        `Cardetail1 — card authorized $${dollars} · ${bookingId}`,
        `Card hold authorized for booking ${bookingId}.\n` +
        `Amount: $${dollars}\nPaymentIntent: ${pi.id}\n` +
        `Dispatch triggered: ${results.auction ? JSON.stringify(results.auction) : 'n/a'}\n\n` +
        `Capture the final amount after service via the admin panel.`
      );
      break;
    }

    case 'payment_intent.succeeded': {
      // Payment captured (either via manual capture or automatic).
      results.update = await updateBookingPayment(bookingId, {
        paymentStatus: 'paid',
        paymentIntentId: pi.id,
        amountCapturedCents: pi.amount_received != null ? pi.amount_received : pi.amount,
        capturedAt: new Date().toISOString(),
      });
      await notifyAdmin(
        `Cardetail1 — payment captured $${dollars} · ${bookingId}`,
        `Payment of $${dollars} captured for booking ${bookingId}.\nPaymentIntent: ${pi.id}`
      );
      break;
    }

    case 'payment_intent.payment_failed': {
      const reason = (pi.last_payment_error && pi.last_payment_error.message) || 'unknown';
      results.update = await updateBookingPayment(bookingId, {
        paymentStatus: 'authorization_failed',
        paymentIntentId: pi.id,
        paymentFailureReason: reason,
      });
      await notifyAdmin(
        `Cardetail1 — payment FAILED · ${bookingId}`,
        `Payment failed for booking ${bookingId}.\nReason: ${reason}\nPaymentIntent: ${pi.id}`
      );
      break;
    }

    case 'payment_intent.canceled': {
      // Stripe canceled the PaymentIntent (card expired, customer canceled, etc.)
      // Mark booking so admin is not left waiting on an authorization that will never come.
      const cancelReason = pi.cancellation_reason || 'unknown';
      results.update = await updateBookingPayment(bookingId, {
        paymentStatus: 'canceled',
        paymentIntentId: pi.id,
        paymentCancelReason: cancelReason,
      });
      await notifyAdmin(
        `Cardetail1 — payment CANCELED · ${bookingId}`,
        `PaymentIntent canceled for booking ${bookingId}.\nReason: ${cancelReason}\nPaymentIntent: ${pi.id}`
      );
      break;
    }

    default:
      // Log unexpected event types to help with future debugging.
      if (evt.type) console.log('[stripe-webhook] unhandled event type:', evt.type);
      break;
  }

  console.log('[stripe-webhook]', evt.type, bookingId, JSON.stringify(results));
  return { statusCode: 200, body: JSON.stringify({ received: true, ...results }) };
};
