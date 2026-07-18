/**
 * Authoritative PaymentService on the Phase 2 relational tables.
 * This is the ONLY module meant to reserve payment obligations,
 * create/retrieve PaymentIntents, reconcile provider state, write ledger
 * entries, or create refunds against the new schema.
 *
 * Operational wiring (webhook / Admin / My Garage) calls this module when
 * DATABASE_URL is configured. Blobs remain for operational booking fields;
 * financial projection authority is Postgres once a booking is ensured.
 *
 * Stripe network calls always go through an injectable `fetchImpl`
 * (defaults to globalThis.fetch) and the existing stripe-mode.js guard.
 * Tests never hit real Stripe; they pass a fake fetchImpl.
 */

const { guardStripeOrReject } = require('../stripe-mode');
const { computeFinancialProjection } = require('./financial-projection');
const repo = require('./repositories');
const foundation = require('./foundation-services');

function buildIdempotencyKey({ bookingId, quoteVersion, amountCents, generation = 1 }) {
  return ['pi', bookingId, quoteVersion, amountCents, generation].join('_');
}

/**
 * Load every row needed to compute the current authoritative projection
 * for a booking, then compute it. Read-only.
 */
async function getFinancialProjection(bookingId) {
  const [booking, quote, paymentAttempts, ledgerEntries] = await Promise.all([
    repo.getBooking(bookingId),
    repo.getLatestQuote(bookingId),
    repo.listPaymentAttempts(bookingId),
    repo.listLedgerEntries(bookingId),
  ]);
  if (!booking || !quote) return null;
  return computeFinancialProjection({ booking, quote, paymentAttempts, ledgerEntries });
}

/**
 * Create or idempotently retrieve the single PaymentIntent for
 * bookingId+quoteVersion. Never creates a second active obligation — the
 * partial unique index (see migration.sql) makes a concurrent second
 * attempt fail, and reservePaymentObligation converts that into "return
 * the existing one" instead of throwing.
 *
 * If the current projection shows the booking already paid or the
 * requested amount doesn't match the authoritative remaining balance,
 * this refuses rather than trusting the caller's amount — the amount is
 * always derived server-side from the projection, not from the argument,
 * except that the argument is validated to match (prevents a stale client
 * silently overpaying/underpaying due to a race with an admin adjustment).
 */
async function reserveAndCreatePaymentIntent({
  bookingId,
  quoteVersion,
  generation = 1,
  stripeCustomerId = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
}) {
  const projection = await getFinancialProjection(bookingId);
  if (!projection) return { ok: false, error: 'not_found', statusCode: 404 };
  if (projection.quoteVersion !== quoteVersion) {
    return { ok: false, error: 'stale_quote_version', statusCode: 409, projection };
  }
  if (projection.paymentStatus === 'paid') {
    return { ok: false, error: 'already_paid', statusCode: 409, projection };
  }
  if (!(projection.remainingCents > 0)) {
    return { ok: false, error: 'zero_balance', statusCode: 409, projection };
  }

  const amountCents = projection.remainingCents;
  const idempotencyKey = buildIdempotencyKey({ bookingId, quoteVersion, amountCents, generation });

  const reserved = await foundation.reservePaymentObligation({
    bookingId,
    quoteVersion,
    amountCents,
    providerObjectType: 'payment_intent',
    providerObjectId: null,
    idempotencyKey,
    generation,
  });
  if (!reserved.ok) return { ok: false, error: reserved.error, statusCode: 500 };

  // Stuck `creating` row with no providerObjectId after a Stripe-side timeout:
  // the first call reserved the obligation and Stripe may already have the PI
  // (Idempotency-Key), but we never persisted the id. Replaying the same key
  // must fall through and finish attaching — not return the orphan forever.
  const stuckCreatingWithoutProvider =
    !reserved.created &&
    reserved.reason === 'idempotent_replay' &&
    reserved.attempt &&
    !reserved.attempt.providerObjectId &&
    reserved.attempt.status === 'creating';

  if (!reserved.created && !stuckCreatingWithoutProvider) {
    // Concurrent reservation or a completed attempt — return as-is, never
    // create a second Stripe object for the same bookingId+quoteVersion.
    return { ok: true, created: false, paymentAttempt: reserved.attempt, projection };
  }

  const guard = guardStripeOrReject(env, { purpose: 'payment_intent_create' });
  if (guard.blocked) {
    return { ok: false, error: guard.body?.error || 'stripe_unavailable', statusCode: guard.statusCode };
  }

  const body = new URLSearchParams({
    amount: String(amountCents),
    currency: 'usd',
    'automatic_payment_methods[enabled]': 'true',
    'metadata[bookingId]': bookingId,
    'metadata[booking_id]': bookingId,
    'metadata[quoteVersion]': String(quoteVersion),
    'metadata[purpose]': 'customer_balance',
  });
  if (stripeCustomerId) body.set('customer', stripeCustomerId);

  let stripePaymentIntent;
  try {
    const res = await fetchImpl('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${guard.secret}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': idempotencyKey,
      },
      body: body.toString(),
    });
    stripePaymentIntent = await res.json();
    if (!res.ok) {
      return { ok: false, error: stripePaymentIntent?.error?.message || 'stripe_create_failed', statusCode: 502 };
    }
  } catch (e) {
    return { ok: false, error: 'stripe_network_error', statusCode: 502 };
  }

  const paymentAttempt = await repo.updatePaymentAttempt(reserved.attempt.id, {
    providerObjectId: stripePaymentIntent.id,
    status: 'open',
  });

  return {
    ok: true,
    created: !stuckCreatingWithoutProvider,
    recoveredFromTimeout: stuckCreatingWithoutProvider || undefined,
    paymentAttempt,
    stripePaymentIntentId: stripePaymentIntent.id,
    clientSecret: stripePaymentIntent.client_secret || null,
    projection,
  };
}

/**
 * Retrieve client_secret for an existing PaymentIntent (idempotent reopen).
 */
async function retrievePaymentIntentClientSecret({
  paymentIntentId,
  env = process.env,
  fetchImpl = globalThis.fetch,
}) {
  if (!paymentIntentId) return { ok: false, error: 'missing_payment_intent', statusCode: 400 };
  const guard = guardStripeOrReject(env, { purpose: 'payment_intent_retrieve' });
  if (guard.blocked) {
    return { ok: false, error: guard.body?.error || 'stripe_unavailable', statusCode: guard.statusCode };
  }
  try {
    const res = await fetchImpl(`https://api.stripe.com/v1/payment_intents/${paymentIntentId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${guard.secret}` },
    });
    const pi = await res.json();
    if (!res.ok) {
      return { ok: false, error: pi?.error?.message || 'stripe_retrieve_failed', statusCode: 502 };
    }
    return {
      ok: true,
      paymentIntent: pi,
      clientSecret: pi.client_secret || null,
      status: pi.status,
    };
  } catch {
    return { ok: false, error: 'stripe_network_error', statusCode: 502 };
  }
}

/**
 * Create a Stripe Customer Session so Payment Element can redisplay eligible
 * saved payment methods (respecting Stripe allow_redisplay / consent rules).
 */
async function createCustomerSession({
  stripeCustomerId,
  env = process.env,
  fetchImpl = globalThis.fetch,
}) {
  if (!stripeCustomerId) return { ok: false, error: 'missing_customer', statusCode: 400 };
  const guard = guardStripeOrReject(env, { purpose: 'customer_session_create' });
  if (guard.blocked) {
    return { ok: false, error: guard.body?.error || 'stripe_unavailable', statusCode: guard.statusCode };
  }
  const body = new URLSearchParams({
    customer: stripeCustomerId,
    'components[payment_element][enabled]': 'true',
    'components[payment_element][features][payment_method_redisplay]': 'enabled',
    'components[payment_element][features][payment_method_save]': 'enabled',
    'components[payment_element][features][payment_method_save_usage]': 'off_session',
    'components[payment_element][features][payment_method_remove]': 'disabled',
  });
  try {
    const res = await fetchImpl('https://api.stripe.com/v1/customer_sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${guard.secret}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    const session = await res.json();
    if (!res.ok) {
      return { ok: false, error: session?.error?.message || 'customer_session_failed', statusCode: 502 };
    }
    return { ok: true, customerSessionClientSecret: session.client_secret || null, session };
  } catch {
    return { ok: false, error: 'stripe_network_error', statusCode: 502 };
  }
}

/**
 * Admin/Customer recovery: GET PaymentIntent from Stripe and run the same
 * idempotent reconciler the webhook uses. No separate money path.
 */
async function reconcileFromStripeProvider({
  bookingId,
  env = process.env,
  fetchImpl = globalThis.fetch,
}) {
  const projection = await getFinancialProjection(bookingId);
  if (!projection) return { ok: false, error: 'not_found', statusCode: 404 };
  if (projection.paymentStatus === 'paid') {
    return { ok: true, skipped: true, reason: 'already_paid', projection };
  }

  const attempts = await repo.listPaymentAttempts(bookingId);
  const active = attempts.find((a) => ['creating', 'open', 'requires_action'].includes(a.status))
    || [...attempts].reverse().find((a) => a.providerObjectId);
  const piId = active?.providerObjectId || projection.stripeReference;
  if (!piId || !String(piId).startsWith('pi_')) {
    return { ok: true, skipped: true, reason: 'no_payment_intent', projection };
  }

  const retrieved = await retrievePaymentIntentClientSecret({
    paymentIntentId: piId,
    env,
    fetchImpl,
  });
  if (!retrieved.ok) return retrieved;

  const pi = retrieved.paymentIntent;
  const terminal = pi.status === 'succeeded'
    || pi.status === 'canceled'
    || pi.status === 'requires_action'
    || (pi.status === 'requires_payment_method' && !!pi.last_payment_error);
  if (!terminal) {
    return {
      ok: true,
      skipped: true,
      reason: 'provider_not_terminal',
      projection,
      providerState: { id: pi.id, status: pi.status },
    };
  }

  const eventType = pi.status === 'succeeded'
    ? 'payment_intent.succeeded'
    : pi.status === 'canceled'
      ? 'payment_intent.canceled'
      : pi.status === 'requires_action'
        ? 'payment_intent.requires_action'
        : 'payment_intent.payment_failed';
  const stripeEventId = `reconcile_${pi.id}_${pi.status}_${pi.amount_received || pi.amount || 0}`;
  const result = await reconcilePaymentIntentEvent({
    stripeEventId,
    type: eventType,
    paymentIntent: pi,
  });
  const after = await getFinancialProjection(bookingId);
  return { ok: true, skipped: false, result, projection: after, providerState: { id: pi.id, status: pi.status } };
}

/**
 * Idempotent reconciliation of one Stripe PaymentIntent event. Used by the
 * webhook, and by an Admin/Customer "reconcile with Stripe" recovery
 * action — same path either way, per the target architecture.
 *
 * Insert-first-then-process: the StripeEvent row is inserted before any
 * ledger mutation, so a duplicate delivery of the same event is detected
 * and short-circuited before it can double-credit.
 */
async function reconcilePaymentIntentEvent({ stripeEventId, type, paymentIntent }) {
  const eventResult = await foundation.recordStripeEvent({
    stripeEventId,
    type,
    payload: paymentIntent,
  });
  if (eventResult.duplicate) {
    return { ok: true, duplicate: true };
  }

  const attempt = await repo.findPaymentAttemptByProviderObjectId(paymentIntent.id);
  if (!attempt) {
    return { ok: false, error: 'no_matching_payment_attempt', quarantined: true };
  }

  if (paymentIntent.status === 'succeeded') {
    // One ledger credit per PaymentIntent — not per Stripe event id — so a
    // checkout.session.completed and a later payment_intent.succeeded for the
    // same PI cannot double-settle.
    if (attempt.status === 'succeeded') {
      const projection = await getFinancialProjection(attempt.bookingId);
      return { ok: true, duplicate: true, reason: 'attempt_already_succeeded', projection };
    }
    const amountCents = Math.round(Number(paymentIntent.amount_received ?? paymentIntent.amount) || 0);
    const ledgerResult = await foundation.appendLedgerEntry({
      bookingId: attempt.bookingId,
      paymentAttemptId: attempt.id,
      kind: 'settlement',
      amountCents,
      quoteVersion: attempt.quoteVersion,
      providerObjectId: paymentIntent.id,
      providerEventId: `settlement_${paymentIntent.id}`,
      stripeEventId,
      actor: 'stripe_webhook',
    });
    await repo.updatePaymentAttempt(attempt.id, { status: 'succeeded' });

    const projection = await getFinancialProjection(attempt.bookingId);
    if (projection && projection.remainingCents === 0 && projection.quoteVersion === attempt.quoteVersion) {
      await repo.markQuoteStatus({ bookingId: attempt.bookingId, quoteVersion: attempt.quoteVersion, status: 'settled' }).catch(() => {});
    }

    return { ok: true, duplicate: false, ledger: ledgerResult, projection };
  }

  if (paymentIntent.status === 'canceled') {
    await repo.updatePaymentAttempt(attempt.id, { status: 'canceled' });
    return { ok: true, duplicate: false, terminal: 'canceled' };
  }

  if (paymentIntent.status === 'requires_action') {
    await repo.updatePaymentAttempt(attempt.id, { status: 'requires_action' });
    return { ok: true, duplicate: false, terminal: 'requires_action' };
  }

  if (paymentIntent.status === 'requires_payment_method') {
    // Fresh PaymentIntents are often `requires_payment_method` before the
    // customer confirms. Only mark failed on an explicit failure event (or
    // when Stripe reports a last_payment_error during recovery reconcile).
    const isFailure = type === 'payment_intent.payment_failed'
      || !!(paymentIntent.last_payment_error);
    if (isFailure) {
      await repo.updatePaymentAttempt(attempt.id, { status: 'failed' });
      return { ok: true, duplicate: false, terminal: 'failed' };
    }
    if (attempt.status === 'creating') {
      await repo.updatePaymentAttempt(attempt.id, { status: 'open' });
    }
    return { ok: true, duplicate: false, status: 'requires_payment_method' };
  }

  return { ok: true, duplicate: false, ignored: true, status: paymentIntent.status };
}

/**
 * Refund all or part of the settled amount. Always derives the
 * refundable ceiling from the authoritative projection — never trusts a
 * caller-supplied amount beyond that ceiling.
 */
async function createRefund({
  bookingId,
  amountCents,
  reason = 'requested_by_customer',
  env = process.env,
  fetchImpl = globalThis.fetch,
}) {
  const projection = await getFinancialProjection(bookingId);
  if (!projection) return { ok: false, error: 'not_found', statusCode: 404 };
  if (!(projection.refundableCents > 0)) {
    return { ok: false, error: 'nothing_to_refund', statusCode: 409, projection };
  }
  const cents = Math.min(Math.round(Number(amountCents) || 0), projection.refundableCents);
  if (!(cents > 0)) return { ok: false, error: 'invalid_amount', statusCode: 400 };

  const attempts = await repo.listPaymentAttempts(bookingId);
  const succeeded = [...attempts].reverse().find((a) => a.status === 'succeeded');
  if (!succeeded) return { ok: false, error: 'no_succeeded_payment_intent', statusCode: 409 };

  const guard = guardStripeOrReject(env, { purpose: 'refund_create' });
  if (guard.blocked) {
    return { ok: false, error: guard.body?.error || 'stripe_unavailable', statusCode: guard.statusCode };
  }

  const idempotencyKey = `refund_${succeeded.id}_${cents}`;
  const body = new URLSearchParams({
    payment_intent: succeeded.providerObjectId,
    amount: String(cents),
    reason,
  });

  let refund;
  try {
    const res = await fetchImpl('https://api.stripe.com/v1/refunds', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${guard.secret}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': idempotencyKey,
      },
      body: body.toString(),
    });
    refund = await res.json();
    if (!res.ok) {
      return { ok: false, error: refund?.error?.message || 'stripe_refund_failed', statusCode: 502 };
    }
  } catch (e) {
    return { ok: false, error: 'stripe_network_error', statusCode: 502 };
  }

  const ledgerResult = await foundation.appendLedgerEntry({
    bookingId,
    paymentAttemptId: succeeded.id,
    kind: 'refund',
    amountCents: cents,
    quoteVersion: succeeded.quoteVersion,
    providerObjectId: refund.id,
    providerEventId: refund.id,
    actor: 'admin_refund',
  });

  return { ok: true, refund, ledger: ledgerResult };
}

/**
 * Post-payment (or pre-payment) financial adjustment: creates a new quote
 * version with the new total. Never mutates the prior quote — settled
 * quote versions are immutable. The new remaining balance is
 * automatically just the delta, because getFinancialProjection sums
 * settled/refunded cents across the whole booking, not per quote version.
 */
async function createAdjustment({ bookingId, newApprovedCents, reason = null }) {
  const before = await getFinancialProjection(bookingId);
  if (!before) return { ok: false, error: 'not_found', statusCode: 404 };

  const { previousQuote, quote } = await repo.createAdjustmentQuote({
    bookingId,
    approvedCents: newApprovedCents,
    status: 'approved',
  });

  const after = await getFinancialProjection(bookingId);
  return { ok: true, previousQuote, quote, before, after, reason };
}

module.exports = {
  buildIdempotencyKey,
  getFinancialProjection,
  reserveAndCreatePaymentIntent,
  retrievePaymentIntentClientSecret,
  createCustomerSession,
  reconcileFromStripeProvider,
  reconcilePaymentIntentEvent,
  createRefund,
  createAdjustment,
};
