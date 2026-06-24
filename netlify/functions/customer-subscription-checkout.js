// Customer subscription checkout — Stripe Checkout (mode: subscription).
// Prices computed server-side from customer-catalog.js — never trust client amounts.

const { blobsStore, jsonCors, sanitizeText } = require('../lib/tech-security');
const { listRawBookings, normalizePhone, phonesMatch } = require('../lib/ops-db');
const {
  CAR_PACKAGES, FLEET_PLANS, subscriberPrice, fleetMonthlyPrice, catalogForClient,
} = require('../lib/customer-catalog');

function verifyCustomer(body) {
  const email = sanitizeText(body.email, 200).toLowerCase();
  const phone = String(body.phone || '').replace(/\D/g, '').slice(0, 15);
  if (!email.includes('@')) return { ok: false, error: 'valid_email_required' };
  if (!phone || phone.length < 7) return { ok: false, error: 'phone_required' };
  return { ok: true, email, phone };
}

async function hasVerifiedBooking(email, phone) {
  const bookings = await listRawBookings().catch(() => []);
  return bookings.some(bk =>
    !bk.isDraft && !bk.archived && bk.jobStatus !== 'archived_test' &&
    String(bk.email || '').toLowerCase() === email &&
    phonesMatch(phone, normalizePhone(bk.phone || bk.customerPhone || ''))
  );
}

function resolveMonthlyCents(packId, fleetId) {
  const pack = CAR_PACKAGES.find(p => p.id === packId);
  if (!pack) return null;
  let dollars = subscriberPrice(pack.basePrice);
  if (fleetId) {
    const fleet = FLEET_PLANS.find(f => f.id === fleetId);
    if (!fleet) return null;
    dollars = fleetMonthlyPrice(pack.basePrice, fleet);
  }
  const cents = Math.round(dollars * 100);
  if (cents < 500) return null;
  return { cents, dollars, pack, fleet: fleetId ? FLEET_PLANS.find(f => f.id === fleetId) : null };
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

  if (action === 'create_checkout') {
    const auth = verifyCustomer(body);
    if (!auth.ok) return jsonCors(400, { ok: false, error: auth.error });

    const verified = await hasVerifiedBooking(auth.email, auth.phone);
    if (!verified) {
      return jsonCors(403, {
        ok: false,
        error: 'no_verified_booking',
        message: 'Complete a booking with this email and phone before subscribing.',
      });
    }

    const subsStore = await blobsStore('cd1-subscriptions');
    const listing = await subsStore.list().catch(() => ({ blobs: [] }));
    const existingSubs = await Promise.all(
      ((listing && listing.blobs) || []).map(b => subsStore.get(b.key, { type: 'json' }).catch(() => null))
    );
    const hasActive = existingSubs.some(s =>
      s && s.status === 'active' &&
      String(s.email || '').toLowerCase() === auth.email &&
      phonesMatch(auth.phone, String(s.phone || '').replace(/\D/g, ''))
    );
    if (hasActive) {
      return jsonCors(409, { ok: false, error: 'subscription_already_active', message: 'You already have an active subscription.' });
    }

    const packId = sanitizeText(body.packId, 32);
    const fleetId = sanitizeText(body.fleetId || '', 32) || null;
    const pricing = resolveMonthlyCents(packId, fleetId);
    if (!pricing) return jsonCors(400, { ok: false, error: 'invalid_plan' });

    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) return jsonCors(503, { ok: false, error: 'stripe_not_configured' });

    const bookingId = sanitizeText(body.bookingId, 48);
    if (bookingId) {
      const bookings = await listRawBookings().catch(() => []);
      const bound = bookings.find(b =>
        b.id === bookingId &&
        String(b.email || '').toLowerCase() === auth.email &&
        phonesMatch(auth.phone, normalizePhone(b.phone || b.customerPhone || ''))
      );
      if (!bound) {
        return jsonCors(403, { ok: false, error: 'booking_mismatch', message: 'Booking does not match your email and phone.' });
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
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': `Cardetail1 ${planLabel}`,
      'line_items[0][price_data][product_data][description]': 'Monthly maintenance subscription — max 1 detail per month per vehicle. 10% subscriber discount applied.',
      'line_items[0][price_data][unit_amount]': String(pricing.cents),
      'line_items[0][price_data][recurring][interval]': 'month',
      'line_items[0][quantity]': '1',
      success_url: `${base}/customer.html?subscribed=1`,
      cancel_url: `${base}/customer.html?sub_cancel=1`,
    });

    form.append('metadata[type]', 'customer_subscription');
    form.append('metadata[packId]', packId);
    if (fleetId) form.append('metadata[fleetId]', fleetId);
    if (bookingId) form.append('metadata[bookingId]', bookingId);
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
    });
  }

  return jsonCors(400, { ok: false, error: 'unknown_action' });
};
