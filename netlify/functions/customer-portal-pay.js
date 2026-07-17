// Customer-initiated Stripe Checkout for approved balance (card only — no Klarna/BNPL).

const { authorizeBookingAccess, normalizeBookingId } = require('../lib/booking-customer-auth');
const { getBooking } = require('../lib/ops-db');
const { canPayBalance } = require('../lib/appointment-status-policy');
const { enforcePublicRateLimit } = require('../lib/public-rate-limit');
const { prepareBalanceCheckout, buildPaymentAttempt } = require('../lib/payment-service');
const { getBookingRecord, commitBooking } = require('../lib/booking-repository');
const { buildNextAggregate, normalizeAggregate, remainingCents } = require('../lib/booking-aggregate');
const { applyPayLinkMoney } = require('../lib/portal-money-sync');
const { centsToDollars } = require('../lib/historical-adapter');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const json = (status, body) => ({ statusCode: status, headers: CORS, body: JSON.stringify(body) });

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

  // Reject client amount overrides by never reading them into prepareBalanceCheckout authority
  const prepared = prepareBalanceCheckout(booking, {
    expectedBookingVersion: p.expectedBookingVersion,
    expectedQuoteVersion: p.expectedQuoteVersion,
    // intentionally ignore p.amount / p.amountCents
  }, process.env);
  if (!prepared.ok) {
    return json(prepared.statusCode || 200, {
      ok: false,
      error: prepared.error,
      message: prepared.error === 'stripe_test_mode_required'
        ? 'Stripe test mode is required in this environment.'
        : 'No balance is due for this appointment.',
    });
  }

  const due = centsToDollars(prepared.amountCents);
  if (prepared.amountCents < 50) return json(400, { ok: false, error: 'amount_too_low' });

  // Reuse open attempt for same quote/amount
  const { ok: normOk, aggregate } = normalizeAggregate(booking);
  const agg = normOk ? aggregate : booking;
  const open = (Array.isArray(agg.paymentAttempts) ? agg.paymentAttempts : [])
    .find((a) => a.status === 'open'
      && a.amountCents === prepared.amountCents
      && a.quoteVersion === prepared.quoteVersion
      && a.providerObjectId
      && agg.payLink);
  if (open && agg.payLink) {
    return json(200, {
      ok: true,
      url: agg.payLink,
      amountDueApproved: due,
      remainingCents: prepared.amountCents,
      bookingVersion: prepared.bookingVersion,
      quoteVersion: prepared.quoteVersion,
      reused: true,
    });
  }

  const base = process.env.SITE_URL || 'https://cardetail1.netlify.app';
  const form = new URLSearchParams({
    mode: 'payment',
    'payment_method_types[0]': 'card',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][product_data][name]': `Cardetail1 balance · ${bookingId}`,
    'line_items[0][price_data][product_data][description]': `${booking.package || booking.service || 'Detailing'} · ${booking.vehicleLabel || booking.vehicle || ''}`.trim(),
    'line_items[0][price_data][unit_amount]': String(prepared.amountCents),
    'line_items[0][quantity]': '1',
    success_url: `${base}/my-garage.html?paid=1&bookingId=${encodeURIComponent(bookingId)}`,
    cancel_url: `${base}/my-garage.html?canceled=1&bookingId=${encodeURIComponent(bookingId)}`,
  });
  if (booking.email) form.append('customer_email', booking.email);
  form.append('metadata[booking_id]', bookingId);
  form.append('metadata[purpose]', 'customer_balance');
  form.append('metadata[amount_due]', String(due));
  form.append('metadata[bookingVersion]', String(prepared.bookingVersion));
  form.append('metadata[quoteVersion]', String(prepared.quoteVersion));

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${prepared.secret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': prepared.idempotencyKey,
    },
    body: form,
  });
  const sess = await res.json().catch(() => ({}));
  if (!res.ok) {
    return json(res.status, { ok: false, error: (sess.error && sess.error.message) || 'stripe_error' });
  }

  const now = new Date().toISOString();
  const freshRec = await getBookingRecord(bookingId);
  const fresh = freshRec.booking || (await getBooking(bookingId)) || booking;
  const { ok: fOk, aggregate: fAgg } = normalizeAggregate(fresh);
  const baseAgg = fOk ? fAgg : fresh;
  const attempt = buildPaymentAttempt({
    bookingId,
    bookingVersion: prepared.bookingVersion,
    quoteVersion: prepared.quoteVersion,
    amountCents: prepared.amountCents,
    providerObjectId: sess.id,
    type: 'customer_balance',
    idempotencyKey: prepared.idempotencyKey,
  });
  attempt.status = 'open';

  const next = buildNextAggregate(baseAgg, {
    ...applyPayLinkMoney(baseAgg, due, sess.url, sess.id),
    paymentAttempts: [...(Array.isArray(baseAgg.paymentAttempts) ? baseAgg.paymentAttempts : []), attempt],
    payLinkSentAt: now,
    eventLog: [...(Array.isArray(baseAgg.eventLog) ? baseAgg.eventLog : []), {
      action: 'customer_pay_link_created',
      by: 'customer',
      amount: due,
      at: now,
    }],
  });

  const committed = await commitBooking({
    bookingId,
    expectedBookingVersion: baseAgg.bookingVersion || 0,
    nextAggregate: next,
  });
  if (!committed.ok) {
    // Version raced — expire the just-created session best-effort
    try {
      await fetch(`https://api.stripe.com/v1/checkout/sessions/${sess.id}/expire`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${prepared.secret}` },
      });
    } catch { /* ignore */ }
    return json(409, { ok: false, error: 'version_conflict' });
  }

  return json(200, {
    ok: true,
    url: sess.url,
    amountDueApproved: due,
    remainingCents: prepared.amountCents,
    bookingVersion: committed.bookingVersion,
    quoteVersion: prepared.quoteVersion,
    sessionId: sess.id,
  });
};
