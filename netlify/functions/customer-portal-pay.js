// Customer-initiated Stripe Checkout for approved balance (card only — no Klarna/BNPL).

const { authorizeBookingAccess, normalizeBookingId } = require('../lib/booking-customer-auth');
const { bookingStore, getBooking } = require('../lib/ops-db');
const { canPayBalance } = require('../lib/appointment-status-policy');
const { enforcePublicRateLimit } = require('../lib/public-rate-limit');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const json = (status, body) => ({ statusCode: status, headers: CORS, body: JSON.stringify(body) });

function computeDue(booking) {
  const paid = Number(booking.amountPaid || booking.paidAmount || 0);
  const approved = Number(
    booking.approvedFinalAmount != null
      ? booking.approvedFinalAmount
      : (booking.totalPrice || booking.finalAmount || 0)
  );
  if (booking.amountDueApproved != null) return Math.max(0, Number(booking.amountDueApproved));
  if (booking.balanceDue != null) return Math.max(0, Number(booking.balanceDue));
  return Math.max(0, Math.round((approved - paid) * 100) / 100);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });

  const rateLimit = await enforcePublicRateLimit(event, { endpoint: 'customer-portal-pay', cors: false });
  if (rateLimit.blocked) return rateLimit.response;

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'validation_error' }); }

  const bookingId = normalizeBookingId(p.bookingId);
  if (!bookingId) return json(400, { ok: false, error: 'validation_error', message: 'Booking ID is required.' });

  const auth = await authorizeBookingAccess(event, { bookingId, phone: p.phone || p.customerPhone });
  if (!auth.ok) {
    return json(auth.statusCode || 401, {
      ok: false,
      error: auth.error || 'authentication_failed',
      message: auth.message,
    });
  }

  const booking = auth.booking;
  if (booking.isDraft) {
    return json(200, { ok: false, error: 'booking_not_ready', message: 'Finalize your booking request first.' });
  }

  const policy = canPayBalance(booking);
  if (!policy.ok) {
    return json(200, { ok: false, error: policy.error || 'payment_not_due', message: 'No balance is due for this appointment.' });
  }

  const due = computeDue(booking);
  if (!(due > 0)) {
    return json(200, { ok: false, error: 'payment_not_due', message: 'No balance is due for this appointment.' });
  }

  // Reuse existing valid link when amount matches.
  if (booking.payLink && Number(booking.amountDueApproved) === due) {
    return json(200, { ok: true, url: booking.payLink, amountDueApproved: due, reused: true });
  }

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return json(503, { ok: false, error: 'stripe_not_configured' });

  const amountCents = Math.round(due * 100);
  if (amountCents < 50) return json(400, { ok: false, error: 'amount_too_low' });

  const base = process.env.SITE_URL || 'https://cardetail1.netlify.app';
  const form = new URLSearchParams({
    mode: 'payment',
    'payment_method_types[0]': 'card',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][product_data][name]': `Cardetail1 balance · ${bookingId}`,
    'line_items[0][price_data][product_data][description]': `${booking.package || booking.service || 'Detailing'} · ${booking.vehicleLabel || booking.vehicle || ''}`.trim(),
    'line_items[0][price_data][unit_amount]': String(amountCents),
    'line_items[0][quantity]': '1',
    success_url: `${base}/my-garage.html?paid=1&bookingId=${encodeURIComponent(bookingId)}`,
    cancel_url: `${base}/my-garage.html?canceled=1&bookingId=${encodeURIComponent(bookingId)}`,
  });
  if (booking.email) form.append('customer_email', booking.email);
  form.append('metadata[booking_id]', bookingId);
  form.append('metadata[purpose]', 'customer_balance');
  form.append('metadata[amount_due]', String(due));

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const sess = await res.json().catch(() => ({}));
  if (!res.ok) {
    return json(res.status, { ok: false, error: (sess.error && sess.error.message) || 'stripe_error' });
  }

  const now = new Date().toISOString();
  const store = await bookingStore();
  const fresh = (await getBooking(bookingId)) || booking;
  await store.setJSON(bookingId, {
    ...fresh,
    amountDueApproved: due,
    balanceDue: due,
    payLink: sess.url,
    stripeCheckoutSessionId: sess.id,
    paymentWorkflowStatus: 'awaiting_customer_payment',
    payLinkSentAt: now,
    updatedAt: now,
    eventLog: [...(Array.isArray(fresh.eventLog) ? fresh.eventLog : []), {
      action: 'customer_pay_link_created',
      by: 'customer',
      amount: due,
      at: now,
    }],
  });

  return json(200, { ok: true, url: sess.url, amountDueApproved: due, sessionId: sess.id });
};
