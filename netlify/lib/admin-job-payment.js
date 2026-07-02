// Admin-only job payment actions — idempotent Stripe + cash workflow.
const crypto = require('crypto');
const { appendEventLog } = require('./ops-workflow');

const JOB_PAYMENT_ACTIONS = new Set([
  'send_invoice',
  'charge_card_on_file',
  'mark_cash_paid',
  'retry_payment',
  'cancel_payment_request',
  'confirm_final_amount',
]);

function paymentIdempotencyKey(bookingId, action, amountCents) {
  return crypto
    .createHash('sha256')
    .update(`${bookingId}|${action}|${amountCents}`)
    .digest('hex')
    .slice(0, 32);
}

function resolveFinalAmountCents(booking) {
  if (booking.finalAmountCents != null && Number(booking.finalAmountCents) > 0) {
    return Math.round(Number(booking.finalAmountCents));
  }
  const dollars = booking.finalAmount != null ? Number(booking.finalAmount) : Number(booking.totalPrice || 0);
  return Math.round(dollars * 100);
}

function cardOnFileReady(booking) {
  return booking.cardOnFileStatus === 'saved'
    && !!booking.stripeCustomerId
    && !!booking.stripePaymentMethodId;
}

function completionReadyForPayment(booking) {
  return !!booking.completionSubmitted
    && booking.customerAuthorizationAccepted === true;
}

function findIdempotentSuccess(booking, key) {
  const records = Array.isArray(booking.paymentIdempotencyRecords) ? booking.paymentIdempotencyRecords : [];
  return records.find(r => r.key === key && r.status === 'succeeded');
}

function appendIdempotencyRecord(booking, record) {
  const records = Array.isArray(booking.paymentIdempotencyRecords) ? [...booking.paymentIdempotencyRecords] : [];
  records.push({ ...record, at: record.at || new Date().toISOString() });
  return records.slice(-20);
}

async function stripePost(secret, path, form, idempotencyKey) {
  const headers = {
    Authorization: `Bearer ${secret}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers,
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function sendCustomerPaymentEmail(booking, subject, text) {
  const { RESEND_API_KEY, RESEND_FROM } = process.env;
  const to = booking.email;
  if (!RESEND_API_KEY || !to) return { sent: false, reason: 'email_not_configured' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: RESEND_FROM || 'Cardetail1 <onboarding@resend.dev>',
        to: [to],
        subject,
        text,
      }),
    });
    return { sent: res.ok, status: res.status };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

async function executeAdminPaymentAction(booking, action, body, deps) {
  const { sanitizeText } = deps;
  const bookingId = booking.id;
  const now = new Date().toISOString();
  const adminNote = sanitizeText(body.adminNote || body.note, 1000);

  if (action === 'confirm_final_amount') {
    if (!adminNote) return { ok: false, status: 400, error: 'admin_note_required' };
    const amountCents = body.finalAmountCents != null
      ? Math.round(Number(body.finalAmountCents))
      : (body.finalAmount != null ? Math.round(Number(body.finalAmount) * 100) : resolveFinalAmountCents(booking));
    if (amountCents < 50) return { ok: false, status: 400, error: 'amount_too_low' };
    const patched = {
      ...booking,
      finalAmountCents: amountCents,
      finalAmount: Math.round(amountCents) / 100,
      finalAmountConfirmedAt: now,
      finalAmountConfirmedBy: 'admin',
      finalAmountAdminNote: adminNote,
      updatedAt: now,
      eventLog: appendEventLog(booking, {
        action: 'final_amount_confirmed',
        by: 'admin',
        amountCents,
        note: adminNote,
      }),
    };
    return { ok: true, patched, result: { bookingId, finalAmountCents: amountCents } };
  }

  if (action === 'mark_cash_paid') {
    if (!adminNote) return { ok: false, status: 400, error: 'admin_note_required' };
    const amountCents = body.finalAmountCents != null
      ? Math.round(Number(body.finalAmountCents))
      : resolveFinalAmountCents(booking);
    if (amountCents < 1) return { ok: false, status: 400, error: 'amount_required' };
    const key = paymentIdempotencyKey(bookingId, action, amountCents);
    if (findIdempotentSuccess(booking, key)) {
      return { ok: false, status: 409, error: 'duplicate_payment_action' };
    }
    const patched = {
      ...booking,
      paymentStatus: 'cash_paid',
      paymentWorkflowStatus: 'cash_paid',
      jobStatus: 'completed_paid',
      status: 'Paid',
      cashPaidAmountCents: amountCents,
      cashPaidAt: now,
      cashPaidAdminNote: adminNote,
      updatedAt: now,
      paymentIdempotencyRecords: appendIdempotencyRecord(booking, { key, action, status: 'succeeded', amountCents }),
      eventLog: appendEventLog(booking, {
        action: 'cash_paid_marked',
        by: 'admin',
        amountCents,
        note: adminNote,
      }),
    };
    return { ok: true, patched, result: { bookingId, paymentStatus: 'cash_paid', amountCents } };
  }

  if (action === 'cancel_payment_request') {
    const patched = {
      ...booking,
      paymentWorkflowStatus: 'payment_action_required',
      payLink: null,
      stripeCheckoutSessionId: null,
      stripeInvoiceId: null,
      paymentRequestCanceledAt: now,
      updatedAt: now,
      eventLog: appendEventLog(booking, {
        action: 'payment_request_canceled',
        by: 'admin',
        note: adminNote || '',
      }),
    };
    return { ok: true, patched, result: { bookingId, canceled: true } };
  }

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    return {
      ok: false,
      status: 503,
      error: 'stripe_not_configured',
      userMessage: 'Stripe is not configured. Completion saved — configure Stripe or mark cash paid manually.',
    };
  }

  const amountCents = resolveFinalAmountCents(booking);
  if (amountCents < 50 && action !== 'retry_payment') {
    return { ok: false, status: 400, error: 'final_amount_required', userMessage: 'Confirm final amount before payment.' };
  }

  if (action === 'send_invoice') {
    if (!completionReadyForPayment(booking)) {
      return { ok: false, status: 409, error: 'completion_not_ready' };
    }
    const key = paymentIdempotencyKey(bookingId, action, amountCents);
    const prior = findIdempotentSuccess(booking, key);
    if (prior && booking.payLink && body.forceRetry !== true) {
      return { ok: true, patched: booking, result: { bookingId, url: booking.payLink, duplicate: true } };
    }
    const base = process.env.SITE_URL || 'https://cardetail1.com';
    const form = new URLSearchParams({
      mode: 'payment',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': `Cardetail1 service · ${bookingId}`,
      'line_items[0][price_data][unit_amount]': String(amountCents),
      'line_items[0][quantity]': '1',
      success_url: `${base}/customer.html?paid=1&booking=${encodeURIComponent(bookingId)}`,
      cancel_url: `${base}/customer.html?canceled=1`,
      'metadata[bookingId]': bookingId,
      'metadata[booking_id]': bookingId,
      'metadata[payment_action]': 'job_final',
    });
    if (booking.email) form.append('customer_email', booking.email);
    const stripe = await stripePost(secret, 'checkout/sessions', form, key);
    if (!stripe.ok) {
      return {
        ok: false,
        status: stripe.status,
        error: (stripe.data.error && stripe.data.error.message) || 'stripe_checkout_failed',
        userMessage: 'Could not create payment link. URL not sent — copy manually or retry.',
      };
    }
    const sess = stripe.data;
    const emailResult = await sendCustomerPaymentEmail(
      booking,
      `Cardetail1 — payment link for booking ${bookingId}`,
      `Your service is complete. Pay securely here:\n${sess.url}\n\nBooking: ${bookingId}\nAmount: $${(amountCents / 100).toFixed(2)}`
    );
    const patched = {
      ...booking,
      payLink: sess.url,
      stripeCheckoutSessionId: sess.id,
      paymentStatus: 'payment_link_sent',
      paymentWorkflowStatus: 'awaiting_customer_payment',
      payLinkSentAt: now,
      paymentLinkEmailSent: emailResult.sent,
      paymentLinkEmailError: emailResult.sent ? null : (emailResult.reason || `http_${emailResult.status}`),
      updatedAt: now,
      paymentIdempotencyRecords: appendIdempotencyRecord(booking, {
        key, action, status: 'succeeded', checkoutSessionId: sess.id, amountCents,
      }),
      eventLog: appendEventLog(booking, {
        action: 'payment_link_sent',
        by: 'admin',
        amountCents,
        checkoutSessionId: sess.id,
        emailSent: emailResult.sent,
      }),
    };
    return { ok: true, patched, result: { bookingId, url: sess.url, email: emailResult } };
  }

  if (action === 'charge_card_on_file' || action === 'retry_payment') {
    if (!completionReadyForPayment(booking)) {
      return { ok: false, status: 409, error: 'completion_not_ready' };
    }
    if (!cardOnFileReady(booking)) {
      return {
        ok: false,
        status: 409,
        error: 'no_card_on_file',
        userMessage: 'No saved card on file. Send a payment link instead.',
      };
    }
    const payAction = action === 'retry_payment' ? 'retry_payment' : 'charge_card_on_file';
    const key = paymentIdempotencyKey(bookingId, payAction, amountCents);
    const prior = findIdempotentSuccess(booking, key);
    if (prior && body.forceRetry !== true) {
      return { ok: false, status: 409, error: 'duplicate_payment_action' };
    }
    if (booking.paymentStatus === 'paid' || booking.paymentWorkflowStatus === 'payment_succeeded') {
      return { ok: false, status: 409, error: 'already_paid' };
    }
    const form = new URLSearchParams({
      amount: String(amountCents),
      currency: 'usd',
      customer: booking.stripeCustomerId,
      payment_method: booking.stripePaymentMethodId,
      off_session: 'true',
      confirm: 'true',
      description: `Cardetail1 service · ${bookingId}`,
      'metadata[bookingId]': bookingId,
      'metadata[booking_id]': bookingId,
      'metadata[payment_action]': 'job_final',
    });
    const stripe = await stripePost(secret, 'payment_intents', form, key);
    const pi = stripe.data;
    if (!stripe.ok) {
      const patched = {
        ...booking,
        paymentStatus: 'payment_failed',
        paymentWorkflowStatus: 'payment_failed',
        lastPaymentError: (pi.error && pi.error.message) || 'charge_failed',
        updatedAt: now,
        eventLog: appendEventLog(booking, {
          action: 'card_charge_failed',
          by: 'admin',
          amountCents,
          error: (pi.error && pi.error.message) || 'charge_failed',
        }),
      };
      return {
        ok: false,
        status: stripe.status,
        error: (pi.error && pi.error.message) || 'stripe_charge_failed',
        patched,
        userMessage: 'Charge failed. Send payment link or retry when customer updates card.',
      };
    }
    const succeeded = pi.status === 'succeeded';
    const requiresAction = pi.status === 'requires_action' || pi.status === 'requires_payment_method';
    const patched = {
      ...booking,
      paymentIntentId: pi.id,
      paymentStatus: succeeded ? 'paid' : (requiresAction ? 'payment_requires_customer_action' : pi.status),
      paymentWorkflowStatus: succeeded ? 'payment_succeeded' : (requiresAction ? 'payment_requires_customer_action' : 'payment_failed'),
      jobStatus: succeeded ? 'completed_paid' : booking.jobStatus,
      status: succeeded ? 'Paid' : booking.status,
      amountCapturedCents: succeeded ? (pi.amount_received ?? amountCents) : booking.amountCapturedCents,
      capturedAt: succeeded ? now : booking.capturedAt,
      updatedAt: now,
      paymentIdempotencyRecords: appendIdempotencyRecord(booking, {
        key,
        action: payAction,
        status: succeeded ? 'succeeded' : pi.status,
        paymentIntentId: pi.id,
        amountCents,
      }),
      eventLog: appendEventLog(booking, {
        action: succeeded ? 'card_charged' : 'card_charge_pending',
        by: 'admin',
        amountCents,
        paymentIntentId: pi.id,
        status: pi.status,
      }),
    };
    if (!succeeded && requiresAction) {
      return {
        ok: false,
        status: 402,
        error: 'payment_requires_customer_action',
        patched,
        result: { bookingId, paymentIntentId: pi.id, status: pi.status },
        userMessage: 'Customer action required. Send payment link as fallback.',
      };
    }
    if (!succeeded) {
      return { ok: false, status: 402, error: 'payment_failed', patched, result: { status: pi.status } };
    }
    return { ok: true, patched, result: { bookingId, paymentIntentId: pi.id, status: pi.status, amountCents } };
  }

  return { ok: false, status: 400, error: 'unknown_action' };
}

module.exports = {
  JOB_PAYMENT_ACTIONS,
  paymentIdempotencyKey,
  resolveFinalAmountCents,
  cardOnFileReady,
  completionReadyForPayment,
  executeAdminPaymentAction,
  sendCustomerPaymentEmail,
};
