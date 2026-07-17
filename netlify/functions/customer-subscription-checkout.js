// Customer subscription checkout — Stripe Checkout (mode: subscription).
// Prices computed server-side from customer-catalog.js — never trust client amounts.
//
// Actions (POST JSON):
//   list_catalog       — packages with 10% monthly discount + fleet plans
//   create_checkout    — { packId, fleetId?, bookingId, email, phone, ... }
//   session_status     — { sessionId, email, phone } → subscriptionId when paid
//
// Env (Netlify):
//   STRIPE_SECRET_KEY    sk_test_... / sk_live_...
//   SITE_URL             https://cardetail1.com
//   Optional recurring Price IDs (see netlify/lib/subscription-checkout.js and STRIPE-SUBSCRIPTION-PRICE-IDS.md):
//     STRIPE_PRICE_SUB_MAINT, STRIPE_PRICE_SUB_INTERIOR, STRIPE_PRICE_SUB_FULL,
//     STRIPE_PRICE_SUB_REFRESH, STRIPE_PRICE_SUB_PREMIUM,
//     STRIPE_PRICE_SUB_FLEET_2_MAINT … STRIPE_PRICE_SUB_FLEET_3_PREMIUM (5 packs × 3 tiers = 15 total)

const { blobsStore, jsonCors, sanitizeText } = require('../lib/tech-security');
const { listRawBookings, phonesMatch } = require('../lib/ops-db');
const { catalogForClient } = require('../lib/customer-catalog');
const {
  rejectClientPriceFields, verifyCustomer, findOwnedBooking, hasVerifiedBooking,
  resolveMonthlyCents, resolveStripePriceId, validateStripePriceAmount,
  buildCheckoutLineItemParams,
} = require('../lib/subscription-checkout');
const { guardStripeOrReject } = require('../lib/stripe-mode');

async function customerHasActiveSubscription(email, phone) {
  const subsStore = await blobsStore('cd1-subscriptions');
  const listing = await subsStore.list().catch(() => ({ blobs: [] }));
  const existingSubs = await Promise.all(
    ((listing && listing.blobs) || []).map(b => subsStore.get(b.key, { type: 'json' }).catch(() => null))
  );
  return existingSubs.some(s =>
    s && s.status === 'active' &&
    String(s.email || '').toLowerCase() === email &&
    phonesMatch(phone, String(s.phone || '').replace(/\D/g, ''))
  );
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') return jsonCors(405, { ok: false, error: 'method_not_allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'invalid_json' }); }

  const action = String(body.action || '');

  if (action === 'list_catalog') {
    return jsonCors(200, { ok: true, catalog: catalogForClient() });
  }

  if (action === 'session_status') {
    const auth = verifyCustomer(body);
    if (!auth.ok) return jsonCors(400, { ok: false, error: auth.error });

    const sessionId = sanitizeText(body.sessionId, 120);
    if (!sessionId.startsWith('cs_')) {
      return jsonCors(400, { ok: false, error: 'invalid_session_id' });
    }

    const stripeGuard = guardStripeOrReject(process.env, { purpose: 'subscription_session_status' });
    if (stripeGuard.blocked) {
      return jsonCors(stripeGuard.statusCode || 503, stripeGuard.body);
    }
    const secret = stripeGuard.secret;

    const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const sess = await res.json().catch(() => ({}));
    if (!res.ok) {
      return jsonCors(res.status, { ok: false, error: (sess.error && sess.error.message) || 'stripe_error' });
    }

    const meta = sess.metadata || {};
    const sessEmail = String(meta.email || sess.customer_email || '').toLowerCase();
    const sessPhone = String(meta.phone || '').replace(/\D/g, '');
    if (sessEmail !== auth.email || sessPhone !== auth.phone) {
      return jsonCors(403, { ok: false, error: 'session_ownership_mismatch' });
    }
    if (meta.type !== 'customer_subscription') {
      return jsonCors(400, { ok: false, error: 'not_subscription_session' });
    }

    return jsonCors(200, {
      ok: true,
      paymentStatus: sess.payment_status,
      status: sess.status,
      subscriptionId: sess.subscription || null,
      sessionId: sess.id,
      monthlyPrice: meta.monthlyPrice ? Number(meta.monthlyPrice) : null,
      packId: meta.packId || null,
    });
  }

  if (action === 'create_checkout') {
    const priceReject = rejectClientPriceFields(body);
    if (!priceReject.ok) {
      return jsonCors(400, { ok: false, error: priceReject.error, field: priceReject.field });
    }

    const auth = verifyCustomer(body);
    if (!auth.ok) return jsonCors(400, { ok: false, error: auth.error });

    const bookingId = sanitizeText(body.bookingId, 48);
    if (!bookingId) {
      return jsonCors(400, { ok: false, error: 'booking_id_required', message: 'bookingId is required for subscription checkout.' });
    }

    const bookings = await listRawBookings().catch(() => []);
    const bound = findOwnedBooking(bookingId, auth.email, auth.phone, bookings);
    if (!bound) {
      return jsonCors(403, {
        ok: false,
        error: 'booking_mismatch',
        message: 'Booking does not match your email and phone.',
      });
    }

    const verified = hasVerifiedBooking(auth.email, auth.phone, bookings);
    if (!verified) {
      return jsonCors(403, {
        ok: false,
        error: 'no_verified_booking',
        message: 'Complete a booking with this email and phone before subscribing.',
      });
    }

    if (await customerHasActiveSubscription(auth.email, auth.phone)) {
      return jsonCors(409, {
        ok: false,
        error: 'subscription_already_active',
        message: 'You already have an active subscription.',
      });
    }

    const packId = sanitizeText(body.packId, 32);
    const fleetId = sanitizeText(body.fleetId || '', 32) || null;
    const pricing = resolveMonthlyCents(packId, fleetId);
    if (!pricing) return jsonCors(400, { ok: false, error: 'invalid_plan' });

    const stripeGuard = guardStripeOrReject(process.env, { purpose: 'subscription_checkout' });
    if (stripeGuard.blocked) {
      return jsonCors(stripeGuard.statusCode || 503, stripeGuard.body);
    }
    const secret = stripeGuard.secret;

    const stripePriceId = resolveStripePriceId(packId, fleetId);
    if (stripePriceId) {
      const priceCheck = await validateStripePriceAmount(stripePriceId, pricing.cents, secret, packId, fleetId);
      if (!priceCheck.ok) {
        console.error('[subscription-checkout] price validation failed:', priceCheck);
        return jsonCors(503, { ok: false, error: priceCheck.error, message: priceCheck.message });
      }
    }

    const vehicle = sanitizeText(body.vehicle, 120);
    const customerName = sanitizeText(body.customerName, 120);
    const base = process.env.SITE_URL || (event.headers && `https://${event.headers.host}`) || 'https://cardetail1.com';

    const planLabel = pricing.fleet
      ? `${pricing.pack.name} · ${pricing.fleet.name}`
      : `${pricing.pack.name} · Monthly`;

    const form = new URLSearchParams({
      mode: 'subscription',
      customer_email: auth.email,
      success_url: `${base}/customer.html?subscribed=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/customer.html?sub_cancel=1`,
      ...buildCheckoutLineItemParams(pricing, packId, fleetId, planLabel, stripePriceId),
    });

    form.append('metadata[type]', 'customer_subscription');
    form.append('metadata[packId]', packId);
    if (fleetId) form.append('metadata[fleetId]', fleetId);
    form.append('metadata[bookingId]', bookingId);
    form.append('metadata[email]', auth.email);
    form.append('metadata[phone]', auth.phone);
    if (vehicle) form.append('metadata[vehicle]', vehicle);
    if (customerName) form.append('metadata[customerName]', customerName);
    form.append('metadata[monthlyPrice]', String(pricing.dollars));

    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const sess = await res.json().catch(() => ({}));
    if (!res.ok) {
      return jsonCors(res.status, { ok: false, error: (sess.error && sess.error.message) || 'stripe_error' });
    }

    return jsonCors(200, {
      ok: true,
      url: sess.url,
      sessionId: sess.id,
      monthlyPrice: pricing.dollars,
      planName: planLabel,
      stripePriceMode: stripePriceId ? 'env_price_id' : 'dynamic_price_data',
    });
  }

  return jsonCors(400, { ok: false, error: 'unknown_action' });
};
