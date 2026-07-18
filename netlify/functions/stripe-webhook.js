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

// ── Customer subscription blob helpers ──
async function activateCustomerSubscription(sess, meta) {
  try {
    const store = await blobsStore('cd1-subscriptions');
    const stripeSubId = sess.subscription || '';
    const listing = await store.list().catch(() => ({ blobs: [] }));
    const existing = stripeSubId
      ? (await Promise.all(
          ((listing && listing.blobs) || []).map(b => store.get(b.key, { type: 'json' }).catch(() => null))
        )).find(s => s && s.stripeSubscriptionId === stripeSubId)
      : null;

    const now = new Date().toISOString();
    const { CAR_PACKAGES } = require('../lib/customer-catalog');
    const pack = CAR_PACKAGES.find(p => p.id === meta.packId);
    const id = existing ? existing.id : ('SUB-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase());
    const sub = {
      ...(existing || {}),
      id,
      customerName: meta.customerName || existing?.customerName || '',
      email: (meta.email || existing?.email || '').toLowerCase(),
      phone: String(meta.phone || existing?.phone || '').replace(/\D/g, '').slice(0, 15),
      planId: meta.packId || existing?.planId || 'maint',
      planName: pack ? pack.name : (existing?.planName || 'Maintenance Detail'),
      fleetId: meta.fleetId || existing?.fleetId || null,
      intervalMonths: 1,
      price: Number(meta.monthlyPrice) || existing?.price || 0,
      billingCycle: 'monthly',
      status: 'active',
      maxDetailsPerMonth: 1,
      vehicle: meta.vehicle || existing?.vehicle || '',
      bookingId: meta.bookingId || existing?.bookingId || '',
      stripeSubscriptionId: stripeSubId,
      stripeCustomerId: sess.customer || existing?.stripeCustomerId || null,
      stripeCheckoutSessionId: sess.id,
      activatedAt: now,
      notes: existing?.notes || 'Stripe subscription checkout — auto-activated',
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    await store.setJSON(id, sub);
    return { activated: true, id };
  } catch (e) {
    return { activated: false, reason: e.message };
  }
}

async function cancelSubscriptionByStripeId(stripeSubId) {
  if (!stripeSubId) return { cancelled: false, reason: 'no_stripe_sub_id' };
  try {
    const store = await blobsStore('cd1-subscriptions');
    const listing = await store.list().catch(() => ({ blobs: [] }));
    const subs = await Promise.all(
      ((listing && listing.blobs) || []).map(b => store.get(b.key, { type: 'json' }).catch(() => null))
    );
    const sub = subs.find(s => s && s.stripeSubscriptionId === stripeSubId);
    if (!sub) return { cancelled: false, reason: 'subscription_not_found' };
    sub.status = 'cancelled';
    sub.cancelledAt = new Date().toISOString();
    sub.updatedAt = sub.cancelledAt;
    await store.setJSON(sub.id, sub);
    return { cancelled: true, id: sub.id };
  } catch (e) {
    return { cancelled: false, reason: e.message };
  }
}

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
  const sigValid = verifyStripeSignature(raw, sig, webhookSecret);
  console.log('[stripe-webhook] received | body-length:', raw.length, '| sig-header:', sig ? sig.slice(0, 20) + '…' : 'MISSING', '| sig-valid:', sigValid);
  if (!sigValid) {
    console.error('[stripe-webhook] signature verification FAILED — check STRIPE_WEBHOOK_SECRET matches the endpoint signing secret in Stripe Dashboard');
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

    case 'setup_intent.succeeded': {
      // Customer saved card on file. Update booking with cardOnFileStatus.
      // This does NOT set paymentStatus — card-on-file is tracked separately.
      // Admin may charge the saved card only according to the cancellation/no-show policy.
      const si = evt.data.object;
      const siBookingId = (si.metadata && (si.metadata.bookingId || si.metadata.booking_id)) || '—';
      console.log('[stripe-webhook] setup_intent.succeeded | siId prefix:', si.id ? si.id.slice(0, 15) : 'none', '| bookingId:', siBookingId);
      results.update = await updateBookingPayment(siBookingId, {
        cardOnFileStatus: 'saved',
        setupIntentId: si.id,
        stripeCustomerId: si.customer || null,
        stripePaymentMethodId: si.payment_method || null,
        cardOnFileSavedAt: new Date().toISOString(),
      });
      console.log('[stripe-webhook] updateBookingPayment result:', JSON.stringify(results.update));
      await notifyAdmin(
        `Cardetail1 — card on file saved · ${siBookingId}`,
        `Customer saved card on file for booking ${siBookingId}.\n` +
        `Stripe Customer: ${si.customer || '—'}\n` +
        `Payment method reference stored. No charge applied.\n` +
        `Admin may only charge per the posted cancellation/no-show policy.`
      );
      break;
    }

    case 'setup_intent.setup_failed': {
      const si = evt.data.object;
      const siBookingId = (si.metadata && (si.metadata.bookingId || si.metadata.booking_id)) || '—';
      results.update = await updateBookingPayment(siBookingId, {
        cardOnFileStatus: 'failed',
      });
      console.log('[stripe-webhook] setup_intent.setup_failed', siBookingId);
      break;
    }

    case 'checkout.session.completed': {
      const sess = evt.data.object;
      const meta = sess.metadata || {};
      if (meta.type === 'customer_subscription' &&
          sess.mode === 'subscription' &&
          sess.payment_status === 'paid' &&
          sess.subscription) {
        results.subscription = await activateCustomerSubscription(sess, meta);
        await notifyAdmin(
          `Cardetail1 — subscription activated · ${meta.email || '—'}`,
          `Customer subscription checkout completed.\nPlan: ${meta.packId || '—'}\nEmail: ${meta.email || '—'}\nVehicle: ${meta.vehicle || '—'}\nStripe sub: ${sess.subscription || '—'}`
        );
      } else if (meta.purpose === 'customer_balance' && sess.payment_status === 'paid') {
        const bookingId = String(meta.booking_id || meta.bookingId || '').trim();
        if (bookingId) {
          const {
            applyCustomerBalanceReconciliation,
            financialProjection,
            logPaymentReconciliation,
          } = require('../lib/payment-service');
          const { getBookingRecord, commitBooking } = require('../lib/booking-repository');
          const beforeRec = await getBookingRecord(bookingId);
          const localBefore = beforeRec.exists ? financialProjection(beforeRec.booking) : null;
          const applied = await applyCustomerBalanceReconciliation({
            bookingId,
            session: sess,
            getBookingRecord,
            commitBooking,
            stripeEventId: evt.id,
          });
          const localAfter = applied.booking
            ? financialProjection(applied.booking)
            : (applied.projection || localBefore);
          logPaymentReconciliation({
            bookingId,
            stripeEventId: evt.id,
            checkoutSessionId: sess.id,
            paymentIntentId: sess.payment_intent,
            localBefore,
            providerState: { payment_status: sess.payment_status, type: evt.type },
            localAfter,
            adminProjection: localAfter,
          });
          if (applied.ok) {
            results.customerBalance = {
              ok: true,
              duplicate: !!applied.duplicate,
              creditCents: applied.creditCents,
              attempts: applied.attempts,
              projection: localAfter,
            };
          } else if (applied.quarantined) {
            // Permanent validation failure — ack so Stripe does not poison-retry forever.
            results.customerBalance = { ok: false, quarantined: true, error: applied.error };
            console.warn('[stripe-webhook] customer_balance quarantined', bookingId, applied.error);
          } else if (applied.retryable || applied.error === 'version_conflict' || applied.error === 'not_found') {
            results.customerBalance = {
              ok: false,
              retryable: true,
              error: applied.error,
              statusCode: applied.statusCode || 500,
            };
            console.warn('[stripe-webhook] customer_balance retryable failure', bookingId, applied.error);
            return {
              statusCode: 500,
              body: JSON.stringify({ received: false, retryable: true, ...results }),
            };
          } else {
            results.customerBalance = { ok: false, error: applied.error, statusCode: applied.statusCode };
          }
        }
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const stripeSub = evt.data.object;
      results.subscription = await cancelSubscriptionByStripeId(stripeSub.id);
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
