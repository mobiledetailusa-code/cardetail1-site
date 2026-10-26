'use strict';

/**
 * Charge a saved card for the unpaid approved balance after the whole
 * appointment is completed.
 *
 * The card was saved earlier. Funds move only when an admin explicitly confirms
 * this charge. The server first records a PaymentAttempt, creates an
 * unconfirmed PaymentIntent, stores that id, and only then confirms it.
 * Confirmation is the money-moving call. It is not a SetupIntent and not a
 * manual-capture hold.
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
  const { isBlobOnlyFinancialSource, blobOnlyPaymentRefusal } = require('./blob-only-financial-lock');
  if (isBlobOnlyFinancialSource(booking)) {
    return blobOnlyPaymentRefusal();
  }
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

const STRIPE_PAYMENT_INTENTS_URL = 'https://api.stripe.com/v1/payment_intents';

function storedPaymentIntentIds(booking) {
  const charge = booking?.afterServiceCharge;
  return [
    booking?.paymentIntentId,
    booking?.stripePaymentIntentId,
    charge && typeof charge === 'object' ? charge.paymentIntentId : '',
  ].map((value) => String(value || '').trim()).filter(Boolean);
}

function unconfirmedPaymentIntentForm(booking, amountCents) {
  const id = bookingIdOf(booking);
  return new URLSearchParams({
    amount: String(amountCents),
    currency: 'usd',
    customer: String(booking.stripeCustomerId),
    payment_method: String(booking.stripePaymentMethodId),
    description: `Cardetail1 approved balance after service · ${id}`,
    'metadata[purpose]': PURPOSE,
    'metadata[bookingId]': id,
    'metadata[booking_id]': id,
    'metadata[quoteVersion]': String(quoteVersionOf(booking)),
    'metadata[amountCents]': String(amountCents),
  });
}

function confirmPaymentIntentForm(booking) {
  return new URLSearchParams({
    payment_method: String(booking.stripePaymentMethodId),
    off_session: 'true',
  });
}

function chargeState(paymentIntent, httpStatus) {
  const status = String(paymentIntent?.status || '').trim();
  const code = String(paymentIntent?.last_payment_error?.code || '').trim();
  if (status === 'succeeded') return 'succeeded';
  if (status === 'requires_action' || code === 'authentication_required') return 'requires_action';
  if (status === 'processing') return 'processing';
  if (status === 'requires_confirmation') return 'needs_confirm';
  if (status === 'requires_payment_method' && httpStatus < 400 && !code) return 'needs_confirm';
  if (status === 'requires_payment_method' || status === 'canceled' || httpStatus === 402 || code === 'card_declined') {
    return 'declined';
  }
  if (httpStatus >= 400) return 'declined';
  return 'needs_confirm';
}

function providerIntentAccepted(paymentIntent, booking, amountCents) {
  if (!paymentIntent || !String(paymentIntent.id || '').startsWith('pi_')) return false;
  const amount = Math.round(Number(paymentIntent.amount) || 0);
  const currency = String(paymentIntent.currency || '').toLowerCase();
  if (amount !== amountCents || currency !== 'usd') return false;
  const metadata = paymentIntent.metadata && typeof paymentIntent.metadata === 'object'
    ? paymentIntent.metadata
    : {};
  const metadataBooking = String(metadata.bookingId || metadata.booking_id || '').trim();
  const purpose = String(metadata.purpose || '').trim();
  if (metadataBooking && metadataBooking !== bookingIdOf(booking)) return false;
  if (purpose && purpose !== PURPOSE) return false;
  if (!metadataBooking || purpose !== PURPOSE) return false;
  const customer = String(paymentIntent.customer || '').trim();
  if (customer && customer !== String(booking.stripeCustomerId || '').trim()) return false;
  return true;
}

function persistedIntentAccepted(paymentIntent, attempt, amountCents) {
  if (!paymentIntent || paymentIntent.id !== attempt.providerObjectId) return false;
  const amount = Math.round(Number(paymentIntent.amount) || 0);
  const currency = String(paymentIntent.currency || '').toLowerCase();
  return amount === amountCents && currency === 'usd';
}

async function postStripe({ url, secret, idempotencyKey, form, fetchImpl }) {
  const headers = {
    Authorization: `Bearer ${secret}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: form ? form.toString() : '',
  });
  const body = await res.json().catch(() => ({}));
  return { httpStatus: res.status, body };
}

async function retrievePaymentIntent({ paymentIntentId, secret, fetchImpl }) {
  const res = await fetchImpl(`${STRIPE_PAYMENT_INTENTS_URL}/${encodeURIComponent(paymentIntentId)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${secret}` },
  });
  const body = await res.json().catch(() => ({}));
  return { httpStatus: res.status, body, paymentIntent: paymentIntentFromStripeBody(body) };
}

async function reserveUnconfirmedPaymentIntent({
  booking,
  amountCents,
  idempotencyKey,
  secret,
  fetchImpl,
}) {
  const stored = storedPaymentIntentIds(booking);
  const conflicting = stored.filter((value, index) => stored.indexOf(value) === index);
  if (conflicting.length > 1) {
    return { ok: false, error: 'stored_payment_intent_conflict', statusCode: 409, stripeCalled: false };
  }
  const { ensureBookingFinancial } = require('./db/ensure-booking-financial');
  const ensured = await ensureBookingFinancial(booking);
  if (!ensured.ok) {
    return {
      ok: false,
      error: ensured.error || 'booking_not_ensured',
      statusCode: 503,
      stripeCalled: false,
    };
  }
  if (ensured.quoteVersion !== quoteVersionOf(booking)) {
    return { ok: false, error: 'payment_quote_mismatch', statusCode: 409, stripeCalled: false };
  }

  const { getPrisma } = require('./prisma');
  const foundation = require('./db/foundation-services');
  const repo = require('./db/repositories');
  const prisma = getPrisma();
  const bookingId = bookingIdOf(booking);
  const existingAttempt = await prisma.paymentAttempt.findUnique({ where: { idempotencyKey } });
  if (!existingAttempt && conflicting.length > 0) {
    return { ok: false, error: 'stored_payment_intent_conflict', statusCode: 409, stripeCalled: false };
  }
  const lockKey = ['after_service_charge', bookingId, ensured.quoteVersion, amountCents].join(':');
  return prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text AS lock_acquired',
      lockKey,
    );
    const reserved = await foundation.reservePaymentObligation({
      bookingId,
      quoteVersion: ensured.quoteVersion,
      amountCents,
      purpose: PURPOSE,
      providerCustomerId: booking.stripeCustomerId || null,
      providerObjectType: 'payment_intent',
      providerObjectId: null,
      idempotencyKey,
      generation: 1,
      prisma: tx,
      prelocked: true,
    });
    if (!reserved.ok) {
      return { ok: false, error: reserved.error || 'attempt_not_reserved', statusCode: 503, stripeCalled: false };
    }
    let attempt = reserved.attempt;
    if (
      !attempt
      || attempt.bookingId !== bookingId
      || attempt.purpose !== PURPOSE
      || attempt.amountCents !== amountCents
      || String(attempt.currency || 'usd').toLowerCase() !== 'usd'
      || String(attempt.provider || 'stripe').toLowerCase() !== 'stripe'
    ) {
      return { ok: false, error: 'active_obligation_conflict', statusCode: 409, stripeCalled: false };
    }
    if (attempt.providerObjectId) {
      if (conflicting.length === 1 && conflicting[0] !== attempt.providerObjectId) {
        return {
          ok: false,
          error: 'stored_payment_intent_conflict',
          statusCode: 409,
          stripeCalled: false,
          paymentIntentId: attempt.providerObjectId,
        };
      }
      return { ok: true, attempt, paymentIntent: null, stripeCalled: false };
    }
    if (conflicting.length === 1) {
      return { ok: false, error: 'stored_payment_intent_conflict', statusCode: 409, stripeCalled: false };
    }

    let created;
    try {
      created = await postStripe({
        url: STRIPE_PAYMENT_INTENTS_URL,
        secret,
        idempotencyKey,
        form: unconfirmedPaymentIntentForm(booking, amountCents),
        fetchImpl,
      });
    } catch {
      return { ok: false, error: 'stripe_network_error', statusCode: 502, stripeCalled: true };
    }
    const paymentIntent = paymentIntentFromStripeBody(created.body);
    if (!providerIntentAccepted(paymentIntent, booking, amountCents)) {
      return {
        ok: false,
        error: 'stripe_payment_intent_invariant_failed',
        statusCode: 502,
        stripeCalled: true,
      };
    }
    const providerCustomerId = String(paymentIntent.customer || '').trim() || null;
    try {
      attempt = await repo.updatePaymentAttempt(attempt.id, {
        providerObjectId: paymentIntent.id,
        providerCustomerId,
        status: chargeState(paymentIntent, created.httpStatus) === 'declined' ? 'failed' : 'open',
      }, tx);
    } catch {
      return {
        ok: false,
        error: 'payment_attempt_not_persisted',
        statusCode: 503,
        stripeCalled: true,
        paymentIntentId: paymentIntent.id,
      };
    }
    return {
      ok: true,
      attempt,
      paymentIntent,
      httpStatus: created.httpStatus,
      stripeCalled: true,
    };
  }, { maxWait: 5000, timeout: 14000 });
}

async function rememberPersistedIntent(booking, attempt, idempotencyKey, amountCents, persistBooking) {
  const next = cloneBooking(booking);
  next.paymentIntentId = attempt.providerObjectId;
  rememberCharge(next, {
    idempotencyKey,
    status: 'charging',
    amountCents,
    quoteVersion: quoteVersionOf(next),
    paymentIntentId: attempt.providerObjectId,
    startedAt: next.afterServiceCharge?.startedAt || new Date().toISOString(),
  });
  if (typeof persistBooking !== 'function') return next;
  const saved = await persistBooking(next, booking);
  if (!saved || saved.ok !== true) return next;
  return saved.booking || next;
}

async function confirmPersistedPaymentIntent({
  attempt,
  paymentIntent,
  httpStatus = 200,
  booking,
  amountCents,
  secret,
  idempotencyKey,
  fetchImpl,
}) {
  let current = paymentIntent;
  let statusCode = httpStatus;
  if (!current) {
    try {
      const retrieved = await retrievePaymentIntent({
        paymentIntentId: attempt.providerObjectId,
        secret,
        fetchImpl,
      });
      current = retrieved.paymentIntent;
      statusCode = retrieved.httpStatus;
    } catch {
      return { ok: false, error: 'payment_intent_retrieve_failed', statusCode: 502 };
    }
  }
  if (!current) return { ok: false, error: 'payment_intent_retrieve_failed', statusCode: 502 };
  if (chargeState(current, statusCode) === 'needs_confirm') {
    try {
      const confirmed = await postStripe({
        url: `${STRIPE_PAYMENT_INTENTS_URL}/${encodeURIComponent(attempt.providerObjectId)}/confirm`,
        secret,
        idempotencyKey: `${idempotencyKey}:confirm`,
        form: confirmPaymentIntentForm(booking),
        fetchImpl,
      });
      current = paymentIntentFromStripeBody(confirmed.body);
      statusCode = confirmed.httpStatus;
    } catch {
      current = null;
    }
    if (!current) {
      try {
        const retrieved = await retrievePaymentIntent({
          paymentIntentId: attempt.providerObjectId,
          secret,
          fetchImpl,
        });
        current = retrieved.paymentIntent;
        statusCode = retrieved.httpStatus;
      } catch {
        return { ok: false, error: 'confirmation_outcome_unknown', statusCode: 502 };
      }
    }
  }
  if (!persistedIntentAccepted(current, attempt, amountCents)) {
    return { ok: false, error: 'payment_intent_mismatch', statusCode: 409 };
  }
  return { ok: true, paymentIntent: current, httpStatus: statusCode };
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
  const { isBlobOnlyFinancialSource, blobOnlyPaymentRefusal } = require('./blob-only-financial-lock');
  if (isBlobOnlyFinancialSource(booking)) {
    return blobOnlyPaymentRefusal();
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

  const { productionCustomerPaymentsBlocked } = require('./stripe-customer-payments');
  if (productionCustomerPaymentsBlocked(env)) {
    return {
      ok: false,
      error: 'customer_payments_unavailable',
      statusCode: 403,
      charged: false,
      stripeCalled: false,
      message: 'Online payment is temporarily unavailable. Pay at your appointment or contact us for a secure invoice.',
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

  const { postgresPaymentEnabled } = require('./db/operational-payment');
  if (!postgresPaymentEnabled(env)) {
    return {
      ok: false,
      error: 'postgres_payment_disabled',
      statusCode: 503,
      charged: false,
      stripeCalled: false,
      amountCents: gate.amountCents,
      booking,
    };
  }

  const prepared = await reserveUnconfirmedPaymentIntent({
    booking,
    amountCents: gate.amountCents,
    idempotencyKey: key,
    secret: guard.secret,
    fetchImpl,
  });
  if (!prepared.ok || !prepared.attempt?.providerObjectId) {
    return {
      ok: false,
      error: prepared.error || 'payment_not_prepared',
      statusCode: prepared.statusCode || 503,
      charged: false,
      stripeCalled: !!prepared.stripeCalled,
      paymentIntentId: prepared.paymentIntentId || prepared.attempt?.providerObjectId || null,
      amountCents: gate.amountCents,
    };
  }

  booking = await rememberPersistedIntent(
    booking,
    prepared.attempt,
    key,
    gate.amountCents,
    persistBooking,
  );
  const confirmed = await confirmPersistedPaymentIntent({
    attempt: prepared.attempt,
    paymentIntent: prepared.paymentIntent,
    httpStatus: prepared.httpStatus,
    booking,
    amountCents: gate.amountCents,
    secret: guard.secret,
    idempotencyKey: key,
    fetchImpl,
  });
  if (!confirmed.ok) {
    return {
      ok: false,
      error: confirmed.error || 'payment_not_confirmed',
      statusCode: confirmed.statusCode || 502,
      charged: false,
      stripeCalled: true,
      paymentIntentId: prepared.attempt.providerObjectId,
      amountCents: gate.amountCents,
    };
  }

  const paymentIntent = confirmed.paymentIntent;
  const outcome = outcomeFor(paymentIntent, confirmed.httpStatus);
  const eventType = outcome === 'succeeded'
    ? 'payment_intent.succeeded'
    : (outcome === 'requires_action' ? 'payment_intent.requires_action' : 'payment_intent.payment_failed');
  const observedIntent = {
    ...paymentIntent,
    currency: paymentIntent.currency || 'usd',
    metadata: {
      ...(paymentIntent.metadata || {}),
      purpose: PURPOSE,
      bookingId: bookingIdOf(booking),
      booking_id: bookingIdOf(booking),
      quoteVersion: String(quoteVersionOf(booking)),
    },
  };
  if (outcome === 'succeeded' || outcome === 'requires_action' || outcome === 'declined') {
    const { observeProviderPaymentIntent } = require('./db/payment-authority-service');
    const observed = await observeProviderPaymentIntent({
      booking,
      paymentIntent: observedIntent,
      stripeEventId: `charge_${paymentIntent.id}_${eventType}`,
      type: eventType,
    });
    if (outcome === 'succeeded' && !observed.ok) {
      return {
        ok: false,
        charged: false,
        stripeCalled: true,
        persisted: false,
        quarantined: !!observed.quarantined,
        paymentIntentId: paymentIntent.id,
        amountCents: gate.amountCents,
        error: observed.error || 'payment_not_reconciled',
        booking,
      };
    }
  }
  const next = cloneBooking(booking);
  const applied = applyAfterServiceStripeEvent(next, observedIntent, { eventType });
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
      ledgerSettled: result.charged === true,
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
