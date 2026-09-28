'use strict';

/**
 * Charge a saved card for the unpaid approved balance after the whole
 * appointment is completed.
 *
 * This is an off-session PaymentIntent (confirm + capture now). It is not a
 * SetupIntent and not a manual-capture hold. The card was saved earlier; funds
 * are requested only when an admin explicitly confirms this charge.
 *
 * Cash at service and card at service never reach Stripe here. A single
 * service line never reaches this module. Paid is set only after Stripe
 * reports succeeded, and the ledger entry is keyed by the PaymentIntent id.
 */

const { remainingCents, deriveMoneyCompatibility } = require('./booking-aggregate');
const { financialProjection } = require('./payment-service');
const { guardStripeOrReject } = require('./stripe-mode');
const { AFTER_SERVICE_CHARGE_CONSENT_VERSION } = require('./customer-policy');

const PURPOSE = 'approved_balance_after_service';
const ONSITE = new Set(['cash_onsite', 'cash_on_site', 'card_onsite', 'card_on_site']);
const OPEN_REQUEST = new Set([
  'pending',
  'pending_approval',
  'needs_clarification',
  'awaiting_admin',
  'pending_admin',
]);
const MONEY_REQUESTS = new Set([
  'package_change_request',
  'addon_request',
  'addon_remove_request',
  'vehicle_add_request',
  'vehicle_replace_request',
  'vehicle_remove_request',
]);

function preferenceOf(booking) {
  return String(booking?.paymentMethodPreference || booking?.paymentMethod || '').trim();
}

function quoteVersionOf(booking) {
  return Math.max(0, Math.round(Number(booking?.quoteVersion || booking?.quote?.quoteVersion) || 0));
}

function bookingIdOf(booking) {
  return String(booking?.id || booking?.bookingId || '').trim();
}

function idempotencyKeyFor(bookingId, quoteVersion, amountCents) {
  return `after_service_${bookingId}_${quoteVersion}_${amountCents}`;
}

function recoveryUrlFor(booking, env = process.env) {
  const base = String(env.SITE_URL || env.PUBLIC_SITE_URL || 'https://cardetail1.com').replace(/\/$/, '');
  const id = encodeURIComponent(bookingIdOf(booking));
  return `${base}/my-garage.html?bookingId=${id}&pay=balance`;
}

function pendingMoneyChange(booking) {
  if (String(booking?.adjustmentStatus || '').toLowerCase() === 'pending_admin') {
    return 'adjustment_pending';
  }
  const requests = Array.isArray(booking?.changeRequests) ? booking.changeRequests : [];
  const open = requests.find((row) => {
    if (!row) return false;
    const status = String(row.status || '').toLowerCase();
    const type = row.type || row.requestType;
    return OPEN_REQUEST.has(status) && MONEY_REQUESTS.has(type);
  });
  return open ? 'addon_or_change_pending' : '';
}

function chargeEligibility(booking, projection) {
  const pref = preferenceOf(booking);
  if (!pref || ONSITE.has(pref)) {
    return {
      ok: false,
      error: 'onsite_payment_not_charged_online',
      statusCode: 409,
      message: 'Cash at service and card at service are not charged online.',
    };
  }
  if (pref !== 'online_after_service') {
    return {
      ok: false,
      error: 'online_charge_not_applicable',
      statusCode: 409,
      message: 'This appointment is not set to card online charged after service.',
    };
  }
  const pending = pendingMoneyChange(booking);
  if (pending) {
    return {
      ok: false,
      error: 'addon_approval_required',
      statusCode: 409,
      reason: pending,
      message: 'Approve add-ons and price changes before charging the saved card.',
    };
  }
  const remaining = Math.max(0, Math.round(Number(projection?.remainingCents) || 0));
  const paid = String(projection?.paymentStatus || '').toLowerCase() === 'paid' || remaining === 0;
  if (paid) {
    return { ok: false, error: 'nothing_to_charge', statusCode: 200, remainingCents: 0 };
  }
  if (booking.cardOnFileStatus !== 'saved'
    || !booking.stripeCustomerId
    || !booking.stripePaymentMethodId) {
    return {
      ok: false,
      error: 'card_not_saved',
      statusCode: 409,
      message: 'No saved card is on file for this appointment.',
    };
  }
  if (!hasAfterServiceChargeConsent(booking)) {
    return {
      ok: false,
      error: 'after_service_consent_required',
      statusCode: 409,
      completeWithoutCharge: true,
      recoveryUrl: recoveryUrlFor(booking),
      message: 'This card was not authorized for a charge after service. Collect a new authorization or send a payment link.',
    };
  }
  return { ok: true, amountCents: remaining, preference: pref };
}

function hasAfterServiceChargeConsent(booking) {
  if (booking?.acceptedCardOnFilePolicy !== true) return false;
  if (String(booking.afterServiceChargeConsentVersion || '') !== AFTER_SERVICE_CHARGE_CONSENT_VERSION) {
    return false;
  }
  return Number.isFinite(Date.parse(String(booking.afterServiceChargeConsentAt || '')));
}

function openCustomerBalanceAttempt(booking) {
  const attempts = Array.isArray(booking?.paymentAttempts) ? booking.paymentAttempts : [];
  return attempts.find((row) => {
    if (!row) return false;
    const status = String(row.status || '');
    if (status !== 'open' && status !== 'creating') return false;
    const type = String(row.type || row.purpose || '');
    if (type !== 'customer_balance') return false;
    if (row.providerObjectId && hasSettlement(booking, row.providerObjectId)) return false;
    return true;
  }) || null;
}

/**
 * The My Garage recovery link must not open a second PaymentIntent while an
 * off-session after-service charge is in flight, waiting for authentication,
 * or succeeded but not yet in the ledger. A decline is the recovery path.
 */
function customerRecoveryBlocked(booking) {
  const prior = booking && booking.afterServiceCharge;
  if (!prior || typeof prior !== 'object') return null;
  const status = String(prior.status || '');
  if (status === 'charging' || status === 'requires_action') {
    return {
      ok: false,
      error: 'after_service_charge_in_progress',
      statusCode: 409,
      paymentIntentId: prior.paymentIntentId || null,
    };
  }
  if (status === 'succeeded' && prior.paymentIntentId && !hasSettlement(booking, prior.paymentIntentId)) {
    return {
      ok: false,
      error: 'after_service_charge_in_progress',
      statusCode: 409,
      paymentIntentId: prior.paymentIntentId,
    };
  }
  return null;
}

function reviewCompletionCharge(booking, projection, body, env = process.env) {
  if (!body || body.confirmSavedCardCharge !== true) return { ok: true };
  const gate = chargeEligibility(booking, projection);
  if (gate.error === 'after_service_consent_required') {
    return { ok: true, consentRequired: gate };
  }
  if (!gate.ok && gate.error !== 'nothing_to_charge') {
    return {
      ok: false,
      statusCode: gate.statusCode || 409,
      error: gate.error,
      message: gate.message || null,
      reason: gate.reason || null,
    };
  }
  if (!gate.ok) return { ok: true };
  const amountGate = confirmedAmountGate(body.expectedChargeCents, gate.amountCents);
  if (!amountGate.ok) return { ok: false, ...amountGate };
  if (openCustomerBalanceAttempt(booking)) {
    return {
      ok: false,
      statusCode: 409,
      error: 'balance_charge_already_open',
      message: 'A payment link for this balance is already open.',
      recoveryUrl: recoveryUrlFor(booking, env),
    };
  }
  return { ok: true };
}

function confirmedAmountGate(expectedChargeCents, amountCents) {
  if (expectedChargeCents == null || expectedChargeCents === '') {
    return {
      ok: false,
      error: 'charge_amount_unconfirmed',
      statusCode: 409,
      amountCents,
      message: 'Confirm the amount to charge before completing the appointment.',
    };
  }
  const expected = Math.round(Number(expectedChargeCents));
  if (!Number.isFinite(expected) || expected !== amountCents) {
    return {
      ok: false,
      error: 'charge_amount_changed',
      statusCode: 409,
      expectedChargeCents: Number.isFinite(expected) ? expected : null,
      amountCents,
      message: 'The unpaid balance changed. Confirm the new amount before charging.',
    };
  }
  return { ok: true, amountCents };
}

function ledgerEntries(booking) {
  const ledger = booking.ledger && typeof booking.ledger === 'object' ? booking.ledger : {};
  return Array.isArray(ledger.entries) ? ledger.entries : [];
}

function hasSettlement(booking, providerEventId) {
  const id = String(providerEventId || '').trim();
  if (!id) return false;
  return ledgerEntries(booking).some((entry) => entry && entry.kind === 'settlement' && entry.providerEventId === id);
}

function cloneBooking(booking) {
  return JSON.parse(JSON.stringify(booking));
}

function paymentIntentFromStripeBody(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.object === 'payment_intent' && body.id) return body;
  if (body.error && body.error.payment_intent && body.error.payment_intent.id) {
    return body.error.payment_intent;
  }
  return null;
}

function outcomeFor(paymentIntent, httpStatus) {
  const status = String(paymentIntent?.status || '').trim();
  const code = String(paymentIntent?.last_payment_error?.code || paymentIntent?.error?.code || '').trim();
  if (status === 'succeeded') return 'succeeded';
  if (status === 'requires_action' || code === 'authentication_required') return 'requires_action';
  if (status === 'requires_payment_method' || status === 'canceled' || httpStatus === 402 || code === 'card_declined') {
    return 'declined';
  }
  if (httpStatus >= 400) return 'declined';
  return status || 'unknown';
}

function applyMoney(booking, ledger) {
  booking.ledger = ledger;
  Object.assign(booking, deriveMoneyCompatibility(ledger));
}

function rememberCharge(booking, fields) {
  booking.afterServiceCharge = {
    ...(booking.afterServiceCharge || {}),
    ...fields,
    purpose: PURPOSE,
  };
}

/**
 * Apply one Stripe result to a booking copy. Succeeded appends one settlement.
 * Decline and requires_action leave the appointment completed and the balance due.
 * Repeating the same PaymentIntent does not add a second settlement.
 */
function applyAfterServiceStripeEvent(booking, paymentIntent, { stripeEventId = null, eventType = '' } = {}) {
  if (!booking || typeof booking !== 'object') return { ok: false, error: 'booking_required' };
  const purpose = String(paymentIntent?.metadata?.purpose || '').trim();
  if (purpose !== PURPOSE) return { ok: false, error: 'wrong_purpose' };
  const metaBooking = String(
    paymentIntent?.metadata?.bookingId || paymentIntent?.metadata?.booking_id || ''
  ).trim();
  if (!metaBooking || metaBooking !== bookingIdOf(booking)) {
    return { ok: false, error: 'booking_mismatch' };
  }
  const piId = String(paymentIntent.id || '').trim();
  if (!piId) return { ok: false, error: 'missing_payment_intent' };

  const type = String(eventType || '').trim();
  const status = String(paymentIntent.status || '').trim();
  const succeeded = type === 'payment_intent.succeeded' || status === 'succeeded';
  const needsAction = type === 'payment_intent.requires_action' || status === 'requires_action';
  const failed = type === 'payment_intent.payment_failed'
    || type === 'payment_intent.canceled'
    || status === 'requires_payment_method'
    || status === 'canceled';

  if (succeeded) {
    if (hasSettlement(booking, piId)) {
      return { ok: true, duplicate: true, settled: false, booking, paymentIntentId: piId };
    }
    const amountCents = Math.round(Number(
      paymentIntent.amount_received != null ? paymentIntent.amount_received : paymentIntent.amount
    ) || 0);
    const ledger = booking.ledger && typeof booking.ledger === 'object'
      ? { ...booking.ledger, entries: ledgerEntries(booking).slice() }
      : { currency: 'usd', approvedCents: 0, settledCents: 0, creditedCents: 0, entries: [] };
    const due = remainingCents(ledger);
    if (!(amountCents > 0) || amountCents > due) {
      rememberCharge(booking, {
        paymentIntentId: piId,
        status: 'amount_rejected',
        amountCents,
        stripeEventId: stripeEventId || null,
      });
      return { ok: false, error: 'amount_exceeds_remaining', amountCents, remainingCents: due, booking };
    }
    const now = new Date().toISOString();
    ledger.entries.push({
      entryId: `le_after_${piId}`,
      kind: 'settlement',
      method: 'card',
      purpose: PURPOSE,
      amountCents,
      currency: 'usd',
      providerObjectId: piId,
      providerEventId: piId,
      stripeEventId: stripeEventId || null,
      quoteVersion: quoteVersionOf(booking),
      occurredAt: now,
      recordedAt: now,
      actor: 'stripe_after_service',
    });
    ledger.settledCents = Math.max(0, Math.round(Number(ledger.settledCents) || 0) + amountCents);
    ledger.currency = 'usd';
    ledger.lastReconciledAt = now;
    applyMoney(booking, ledger);
    const rem = remainingCents(ledger);
    const paid = rem === 0;
    booking.paymentIntentId = piId;
    booking.paymentStatus = paid ? 'paid' : (booking.paymentStatus || 'due');
    booking.paymentWorkflowStatus = paid ? 'payment_succeeded' : 'payment_action_required';
    const job = String(booking.jobStatus || '');
    if (paid && (job === 'completed_pending_payment' || job === 'completed_pending_admin_review')) {
      booking.jobStatus = 'completed_paid';
    }
    rememberCharge(booking, {
      idempotencyKey: idempotencyKeyFor(bookingIdOf(booking), quoteVersionOf(booking), amountCents),
      paymentIntentId: piId,
      status: 'succeeded',
      amountCents,
      quoteVersion: quoteVersionOf(booking),
      stripeEventId: stripeEventId || null,
      settledAt: now,
    });
    booking.updatedAt = now;
    return { ok: true, duplicate: false, settled: true, paid, booking, paymentIntentId: piId, amountCents };
  }

  if (needsAction || failed) {
    if (hasSettlement(booking, piId)) {
      return { ok: true, duplicate: true, settled: false, booking, paymentIntentId: piId };
    }
    const now = new Date().toISOString();
    const chargeStatus = needsAction ? 'requires_action' : 'declined';
    const amountCents = Math.max(0, Math.round(Number(paymentIntent.amount) || 0));
    const recoveryUrl = recoveryUrlFor(booking);
    rememberCharge(booking, {
      idempotencyKey: idempotencyKeyFor(
        bookingIdOf(booking),
        quoteVersionOf(booking),
        amountCents || Math.max(0, remainingCents(booking.ledger))
      ),
      paymentIntentId: piId,
      status: chargeStatus,
      amountCents,
      quoteVersion: quoteVersionOf(booking),
      stripeEventId: stripeEventId || null,
      recoveryUrl,
      updatedAt: now,
    });
    if (String(booking.paymentStatus || '').toLowerCase() !== 'paid') {
      booking.paymentWorkflowStatus = 'payment_action_required';
    }
    booking.paymentIntentId = piId;
    booking.updatedAt = now;
    return {
      ok: true,
      duplicate: false,
      settled: false,
      paid: false,
      paymentPending: true,
      stripeStatus: chargeStatus,
      recoveryUrl,
      booking,
      paymentIntentId: piId,
    };
  }

  return { ok: true, ignored: true, booking };
}

async function createOffSessionPayment({
  booking,
  amountCents,
  secret,
  idempotencyKey,
  fetchImpl,
}) {
  const id = bookingIdOf(booking);
  const form = new URLSearchParams({
    amount: String(amountCents),
    currency: 'usd',
    customer: String(booking.stripeCustomerId),
    payment_method: String(booking.stripePaymentMethodId),
    off_session: 'true',
    confirm: 'true',
    description: `Cardetail1 approved balance after service · ${id}`,
    'metadata[purpose]': PURPOSE,
    'metadata[bookingId]': id,
    'metadata[booking_id]': id,
    'metadata[quoteVersion]': String(quoteVersionOf(booking)),
    'metadata[amountCents]': String(amountCents),
  });
  const res = await fetchImpl('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': idempotencyKey,
    },
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  return { httpStatus: res.status, body };
}

/**
 * Explicit admin charge. confirmCharge must be true. Does not call Stripe for
 * on-site methods, unpaid add-on approvals, a zero balance, or a repeat of the
 * same saved result.
 */
async function chargeSavedCardAfterService({
  booking,
  projection,
  env = process.env,
  fetchImpl = globalThis.fetch,
  confirmCharge = false,
  expectedChargeCents = null,
  persistBooking = null,
} = {}) {
  if (confirmCharge !== true) {
    return {
      ok: false,
      error: 'charge_confirmation_required',
      statusCode: 400,
      charged: false,
      stripeCalled: false,
      message: 'Confirm that this action charges the saved card.',
    };
  }
  const liveProjection = projection || financialProjection(booking);
  const gate = chargeEligibility(booking, liveProjection);
  if (!gate.ok) {
    return { ...gate, charged: false, stripeCalled: false };
  }
  const amountGate = confirmedAmountGate(expectedChargeCents, gate.amountCents);
  if (!amountGate.ok) {
    return { ...amountGate, charged: false, stripeCalled: false };
  }
  if (openCustomerBalanceAttempt(booking)) {
    return {
      ok: false,
      error: 'balance_charge_already_open',
      statusCode: 409,
      charged: false,
      stripeCalled: false,
      recoveryUrl: recoveryUrlFor(booking, env),
      amountCents: gate.amountCents,
      message: 'A payment link for this balance is already open.',
    };
  }

  const key = idempotencyKeyFor(bookingIdOf(booking), quoteVersionOf(booking), gate.amountCents);
  const prior = booking.afterServiceCharge || null;
  if (prior && prior.paymentIntentId && (prior.status === 'requires_action' || (prior.idempotencyKey === key && prior.status === 'declined'))) {
    return {
      ok: true,
      duplicate: true,
      charged: false,
      stripeCalled: false,
      paymentPending: true,
      stripeStatus: prior.status,
      paymentIntentId: prior.paymentIntentId,
      recoveryUrl: prior.recoveryUrl || recoveryUrlFor(booking, env),
      amountCents: gate.amountCents,
    };
  }
  if (prior && prior.idempotencyKey === key && prior.status === 'succeeded' && hasSettlement(booking, prior.paymentIntentId)) {
    return {
      ok: true,
      duplicate: true,
      charged: false,
      stripeCalled: false,
      alreadySettled: true,
      paymentIntentId: prior.paymentIntentId,
      amountCents: gate.amountCents,
    };
  }
  if (prior && prior.status === 'charging' && (prior.idempotencyKey !== key || prior.amountCents !== gate.amountCents)) {
    return {
      ok: false,
      error: 'charge_amount_changed',
      statusCode: 409,
      charged: false,
      stripeCalled: false,
      amountCents: gate.amountCents,
      message: 'The unpaid balance changed while a charge was already in progress.',
    };
  }

  const recovering = !!(prior && prior.status === 'charging' && prior.idempotencyKey === key);
  if (!recovering && typeof persistBooking === 'function') {
    const claimed = cloneBooking(booking);
    rememberCharge(claimed, {
      idempotencyKey: key,
      status: 'charging',
      amountCents: gate.amountCents,
      quoteVersion: quoteVersionOf(booking),
      startedAt: new Date().toISOString(),
    });
    const saved = await persistBooking(claimed, booking);
    if (!saved || saved.ok !== true) {
      return {
        ok: false,
        error: (saved && saved.error) || 'version_conflict',
        statusCode: 409,
        charged: false,
        stripeCalled: false,
        persisted: false,
      };
    }
    booking = saved.booking || claimed;
  }

  const guard = guardStripeOrReject(env, { purpose: 'after_service_charge' });
  if (guard.blocked) {
    return {
      ok: false,
      error: guard.body?.error || 'stripe_blocked',
      statusCode: guard.statusCode || 503,
      charged: false,
      stripeCalled: false,
    };
  }

  const stripe = await createOffSessionPayment({
    booking,
    amountCents: gate.amountCents,
    secret: guard.secret,
    idempotencyKey: key,
    fetchImpl,
  });
  const paymentIntent = paymentIntentFromStripeBody(stripe.body);
  if (!paymentIntent) {
    const next = cloneBooking(booking);
    const recoveryUrl = recoveryUrlFor(booking, env);
    rememberCharge(next, {
      idempotencyKey: key,
      status: 'declined',
      amountCents: gate.amountCents,
      quoteVersion: quoteVersionOf(booking),
      recoveryUrl,
      updatedAt: new Date().toISOString(),
    });
    if (String(next.paymentStatus || '').toLowerCase() !== 'paid') {
      next.paymentWorkflowStatus = 'payment_action_required';
    }
    return commitChargeResult(next, booking, persistBooking, {
      ok: true,
      charged: false,
      stripeCalled: true,
      paymentPending: true,
      stripeStatus: 'declined',
      recoveryUrl,
      amountCents: gate.amountCents,
      error: stripe.body?.error?.code || stripe.body?.error?.message || 'stripe_charge_failed',
    });
  }

  const outcome = outcomeFor(paymentIntent, stripe.httpStatus);
  const eventType = outcome === 'succeeded'
    ? 'payment_intent.succeeded'
    : (outcome === 'requires_action' ? 'payment_intent.requires_action' : 'payment_intent.payment_failed');
  const next = cloneBooking(booking);
  const applied = applyAfterServiceStripeEvent(next, {
    ...paymentIntent,
    metadata: {
      ...(paymentIntent.metadata || {}),
      purpose: PURPOSE,
      bookingId: bookingIdOf(booking),
      booking_id: bookingIdOf(booking),
    },
  }, { eventType });
  if (applied.recoveryUrl == null && outcome !== 'succeeded') {
    applied.recoveryUrl = recoveryUrlFor(booking, env);
    if (next.afterServiceCharge) next.afterServiceCharge.recoveryUrl = applied.recoveryUrl;
  }
  return commitChargeResult(next, booking, persistBooking, {
    ok: applied.ok !== false,
    charged: applied.settled === true && applied.paid === true,
    duplicate: !!applied.duplicate,
    stripeCalled: true,
    paymentPending: outcome !== 'succeeded',
    stripeStatus: outcome,
    paymentIntentId: paymentIntent.id,
    amountCents: gate.amountCents,
    recoveryUrl: outcome === 'succeeded' ? null : (applied.recoveryUrl || recoveryUrlFor(booking, env)),
    error: applied.ok === false ? applied.error : null,
  });
}

async function commitChargeResult(next, claimed, persistBooking, result) {
  if (typeof persistBooking !== 'function') {
    return { ...result, booking: next, persisted: false };
  }
  const saved = await persistBooking(next, claimed);
  if (!saved || saved.ok !== true) {
    return {
      ...result,
      ok: false,
      charged: false,
      persisted: false,
      booking: claimed,
      statusCode: 409,
      error: (saved && saved.error) || 'charge_result_not_persisted',
    };
  }
  return { ...result, booking: saved.booking || next, persisted: true };
}

module.exports = {
  PURPOSE,
  AFTER_SERVICE_CHARGE_CONSENT_VERSION,
  preferenceOf,
  idempotencyKeyFor,
  recoveryUrlFor,
  chargeEligibility,
  reviewCompletionCharge,
  customerRecoveryBlocked,
  chargeSavedCardAfterService,
  applyAfterServiceStripeEvent,
};
