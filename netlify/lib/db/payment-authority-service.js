/**
 * Authoritative PaymentService on the Phase 2 relational tables.
 * This is the ONLY module meant to reserve payment obligations,
 * create/retrieve PaymentIntents, reconcile provider state, write ledger
 * entries, or gate refund execution against the new schema.
 *
 * Operational wiring (webhook / Admin / My Garage) calls this module when
 * DATABASE_URL is configured. Blobs remain for operational booking fields;
 * financial projection authority is Postgres once a booking is ensured.
 *
 * Stripe network calls always go through an injectable `fetchImpl`
 * (defaults to globalThis.fetch) and the existing stripe-mode.js guard.
 * Tests never hit real Stripe; they pass a fake fetchImpl.
 */

const crypto = require('node:crypto');
const { guardStripeOrReject } = require('../stripe-mode');
const { getPrisma, tryGetPrisma } = require('../prisma');
const { Prisma } = require('@prisma/client');
const { computeFinancialProjection } = require('./financial-projection');
const repo = require('./repositories');
const foundation = require('./foundation-services');
const {
  sanitizeStripeEventPayload,
  sanitizeStripeErrorCode,
  stripeEventCreatedAt,
} = require('./stripe-event-data');

function buildIdempotencyKey({ bookingId, quoteVersion, amountCents, generation = 1 }) {
  return ['pi', bookingId, quoteVersion, amountCents, generation].join('_');
}

/**
 * Load every row needed to compute the current authoritative projection
 * for a booking, then compute it. Read-only.
 */
async function getFinancialProjection(bookingId, prismaOverride = null) {
  const prisma = prismaOverride || getPrisma();
  const [booking, quote, paymentAttempts, ledgerEntries, refundRequests] = await Promise.all([
    repo.getBooking(bookingId, prismaOverride),
    repo.getLatestQuote(bookingId, prismaOverride),
    repo.listPaymentAttempts(bookingId, prismaOverride),
    repo.listLedgerEntries(bookingId, prismaOverride),
    prisma.refundRequest.findMany({ where: { bookingId }, orderBy: { createdAt: 'asc' } }),
  ]);
  if (!booking || !quote) return null;
  return computeFinancialProjection({ booking, quote, paymentAttempts, ledgerEntries, refundRequests });
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
  const prisma = getPrisma();
  const lockKey = ['payment_intent_create', bookingId, quoteVersion].join(':');

  // The unique indexes prevent duplicate PaymentAttempt rows, but they do not
  // by themselves prevent two workers from observing the same freshly-created
  // `creating` row before its providerObjectId is attached. Serialize that
  // short critical section across processes with a transaction-scoped advisory
  // lock. This also preserves timeout recovery: a later caller retries Stripe
  // with the exact same Idempotency-Key after the first transaction commits.
  // Prisma Accelerate / Prisma Postgres free+starter reject interactive
  // transaction timeouts above 15s (invalid parameter → payment never starts).
  // Keep this under that ceiling; Stripe work inside the lock must stay short.
  const ACCELERATE_SAFE_TX_TIMEOUT_MS = 14_000;
  const ACCELERATE_SAFE_TX_MAX_WAIT_MS = 5_000;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text AS lock_acquired',
      lockKey,
    );
    return reserveAndCreatePaymentIntentLocked({
      bookingId,
      quoteVersion,
      generation,
      stripeCustomerId,
      env,
      fetchImpl,
      prisma: tx,
    });
  }, { maxWait: ACCELERATE_SAFE_TX_MAX_WAIT_MS, timeout: ACCELERATE_SAFE_TX_TIMEOUT_MS });
}

async function reserveAndCreatePaymentIntentLocked({
  bookingId,
  quoteVersion,
  generation,
  stripeCustomerId,
  env,
  fetchImpl,
  prisma,
}) {
  if (stripeCustomerId && !/^cus_[A-Za-z0-9]+$/.test(String(stripeCustomerId))) {
    return { ok: false, error: 'invalid_stripe_customer', statusCode: 400 };
  }
  const projection = await getFinancialProjection(bookingId, prisma);
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
    purpose: 'customer_balance',
    providerCustomerId: stripeCustomerId,
    providerObjectType: 'payment_intent',
    providerObjectId: null,
    idempotencyKey,
    generation,
    prisma,
    prelocked: true,
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

  const providerAmount = Math.round(Number(stripePaymentIntent?.amount) || 0);
  const providerCurrency = String(stripePaymentIntent?.currency || '').toLowerCase();
  const providerBinding = paymentIntentBinding(stripePaymentIntent);
  if (
    !stripePaymentIntent?.id
    || !String(stripePaymentIntent.id).startsWith('pi_')
    || providerAmount !== amountCents
    || providerCurrency !== 'usd'
    || providerBinding.bookingId !== bookingId
    || providerBinding.quoteVersion !== quoteVersion
    || providerBinding.purpose !== 'customer_balance'
    || (stripeCustomerId && providerBinding.customerId !== stripeCustomerId)
  ) {
    return { ok: false, error: 'stripe_payment_intent_invariant_failed', statusCode: 502 };
  }

  const paymentAttempt = await repo.updatePaymentAttempt(reserved.attempt.id, {
    providerObjectId: stripePaymentIntent.id,
    status: 'open',
  }, prisma);

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

/** A payment attempt only blocks money mutations while it is in one of these. */
const ACTIVE_ATTEMPT_STATUSES = ['creating', 'open', 'requires_action'];

/** Long enough that a payment genuinely in flight is never disturbed. */
const ATTEMPT_STALE_AFTER_MS = 2 * 60 * 1000;

/** Stripe's terminal states, and what the local attempt becomes. */
const STRIPE_TERMINAL_STATUS = {
  succeeded: 'succeeded',
  canceled: 'canceled',
};

function attemptAgeMs(attempt, nowMs) {
  const at = Date.parse(attempt?.updatedAt || attempt?.createdAt || '');
  return Number.isFinite(at) ? nowMs - at : Infinity;
}

/**
 * Close payment attempts Stripe has already finished with.
 *
 * An attempt leaves 'creating' / 'open' / 'requires_action' only when a Stripe
 * webhook terminalises it. Nothing expires one, so a webhook that never arrived
 * — or timed out — leaves the attempt open forever, and every later add-on
 * approval or package change on that booking is refused with
 * payment_attempt_in_progress. The guard is right; its input goes stale.
 *
 * So before refusing, ask Stripe what actually happened. Anything Stripe
 * reports as terminal is closed locally and stops blocking. Anything Stripe
 * still considers live keeps blocking, which is the point of the guard.
 *
 * Runs OUTSIDE the mutation transaction — it makes network calls, and holding
 * a serializable transaction open across them would be far worse than the
 * staleness it fixes. Never throws: an unreachable Stripe leaves the guard
 * exactly as strict as it is today.
 *
 * @returns {Promise<{ closed: number, active: number, checked: number, blocked: object|null }>}
 */
async function reconcileStalePaymentAttempts({
  bookingId,
  nowMs = Date.now(),
  staleAfterMs = ATTEMPT_STALE_AFTER_MS,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const summary = { closed: 0, active: 0, checked: 0, blocked: null };
  try {
    const id = String(bookingId || '').trim();
    if (!id) return summary;
    const prisma = tryGetPrisma();
    if (!prisma) return summary;

    const attempts = await prisma.paymentAttempt.findMany({
      where: { bookingId: id, status: { in: ACTIVE_ATTEMPT_STATUSES } },
    });

    for (const attempt of attempts) {
      const ageMs = attemptAgeMs(attempt, nowMs);
      const providerObjectId = String(attempt.providerObjectId || '');

      // A young attempt is presumed live; only an aged one is worth a round trip.
      if (ageMs < staleAfterMs) {
        summary.active += 1;
        summary.blocked = summary.blocked || { attempt, ageMs, stripeStatus: null };
        continue;
      }

      // No payment intent and old enough that no request could still be running:
      // this attempt never reached Stripe, so no money exists behind it and
      // there is nothing that could ever close it. Leaving it open blocks every
      // future amount change on the booking forever — the exact trap the first
      // cut of this function walked into by skipping these.
      if (!providerObjectId.startsWith('pi_')) {
        await prisma.paymentAttempt.update({
          where: { id: attempt.id },
          data: { status: 'canceled', failureCode: 'never_reached_stripe' },
        });
        summary.closed += 1;
        console.log('[payment-authority] attempt closed — never reached Stripe', {
          attemptId: attempt.id,
          previousStatus: attempt.status,
          ageMinutes: Math.round(ageMs / 60000),
        });
        continue;
      }

      summary.checked += 1;
      const retrieved = await retrievePaymentIntentClientSecret({
        paymentIntentId: providerObjectId,
        env,
        fetchImpl,
      });
      if (!retrieved.ok) {
        // Stripe could not answer — leave the guard strict rather than guess.
        summary.active += 1;
        summary.blocked = summary.blocked || { attempt, ageMs, stripeStatus: null };
        continue;
      }

      const terminal = STRIPE_TERMINAL_STATUS[String(retrieved.status || '')];
      if (!terminal) {
        summary.active += 1;
        summary.blocked = summary.blocked || { attempt, ageMs, stripeStatus: retrieved.status };
        continue;
      }

      await prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: { status: terminal, failureCode: terminal === 'canceled' ? 'stripe_reported_canceled' : null },
      });
      summary.closed += 1;
      console.log('[payment-authority] stale attempt reconciled', {
        attemptId: attempt.id,
        stripeStatus: retrieved.status,
        closedAs: terminal,
        ageMinutes: Math.round(ageMs / 60000),
      });
    }
    return summary;
  } catch (err) {
    console.warn('[payment-authority] attempt reconcile failed', err && err.message ? err.message : err);
    return summary;
  }
}

/** Cancel a payment intent at Stripe so a stale amount can never be paid. */
async function cancelPaymentIntentAtStripe({ paymentIntentId, env, fetchImpl }) {
  const guard = guardStripeOrReject(env, { purpose: 'payment_intent_cancel' });
  if (guard.blocked) return { ok: false, error: 'stripe_unavailable' };
  try {
    const res = await fetchImpl(
      `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(paymentIntentId)}/cancel`,
      { method: 'POST', headers: { Authorization: `Bearer ${guard.secret}` } }
    );
    const body = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, status: body.status || 'canceled' };
    return { ok: false, error: body?.error?.message || `stripe_${res.status}` };
  } catch {
    return { ok: false, error: 'stripe_network_error' };
  }
}

/**
 * Retire attempts that belong to a superseded quote version.
 *
 * PaymentAttempt carries a quoteVersion and the status enum has 'superseded',
 * because an attempt is an obligation to pay ONE amount: once the amount
 * changes, the old attempt is meaningless. payment-service.supersedeOpenAttempts
 * already expresses this — but it maps the Blob aggregate's array and never
 * touches Postgres, while the guard in createAdjustment reads Postgres and does
 * not filter by quoteVersion. So an attempt for a stale amount stayed 'open'
 * and blocked every later amount change on that booking, permanently.
 *
 * Retiring it is not only a local status change: the payment intent is canceled
 * at Stripe first, so the customer can never pay an amount that no longer
 * applies. An intent Stripe reports as already succeeded is NOT canceled —
 * money moved, and that is a settlement to record, not an obligation to void.
 *
 * Runs outside the mutation transaction. Never throws.
 *
 * @returns {Promise<{ superseded: number, settled: number, failed: number }>}
 */
async function supersedeOutdatedAttempts({
  bookingId,
  currentQuoteVersion,
  includeCurrentVersion = false,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const summary = { superseded: 0, settled: 0, failed: 0 };
  try {
    const id = String(bookingId || '').trim();
    // Number(null) and Number('') are both 0, so an absent version would read
    // as version 0 and supersede EVERY attempt on the booking. Reject it before
    // the coercion can turn "unknown" into a real-looking version.
    if (currentQuoteVersion == null || currentQuoteVersion === '') return summary;
    const version = Math.round(Number(currentQuoteVersion));
    if (!id || !Number.isFinite(version)) return summary;
    const prisma = tryGetPrisma();
    if (!prisma) return summary;

    const outdated = await prisma.paymentAttempt.findMany({
      where: {
        bookingId: id,
        status: { in: ACTIVE_ATTEMPT_STATUSES },
        // The amount being changed is itself an obligation nobody has met yet,
        // so an unpaid attempt against the CURRENT version is retired too when
        // the caller is about to change that amount. Without this, a customer
        // who once opened the pay screen locks their own booking against every
        // later add-on: the attempt sits open, Stripe rightly reports it live,
        // and no version ever advances to make it outdated.
        ...(includeCurrentVersion ? {} : { quoteVersion: { not: version } }),
      },
    });

    for (const attempt of outdated) {
      const providerObjectId = String(attempt.providerObjectId || '');
      if (!providerObjectId.startsWith('pi_')) {
        // Never reached Stripe: nothing to cancel, nothing at risk.
        await prisma.paymentAttempt.update({
          where: { id: attempt.id },
          data: { status: 'superseded', failureCode: 'quote_version_superseded' },
        });
        summary.superseded += 1;
        continue;
      }

      const retrieved = await retrievePaymentIntentClientSecret({
        paymentIntentId: providerObjectId, env, fetchImpl,
      });
      if (retrieved.ok && retrieved.status === 'succeeded') {
        // The customer already paid this amount. Superseding it would erase a
        // real settlement — record it and leave the money alone.
        await prisma.paymentAttempt.update({
          where: { id: attempt.id },
          data: { status: 'succeeded' },
        });
        summary.settled += 1;
        continue;
      }
      if (retrieved.ok && retrieved.status === 'canceled') {
        await prisma.paymentAttempt.update({
          where: { id: attempt.id },
          data: { status: 'canceled' },
        });
        summary.superseded += 1;
        continue;
      }
      // Money already in flight or captured cannot be voided to make room for a
      // new amount. These are the only states that genuinely must block.
      if (retrieved.ok && (retrieved.status === 'processing' || retrieved.status === 'requires_capture')) {
        summary.failed += 1;
        console.warn('[payment-authority] attempt not retirable — payment in flight', {
          attemptId: attempt.id, stripeStatus: retrieved.status,
        });
        continue;
      }

      const canceled = await cancelPaymentIntentAtStripe({
        paymentIntentId: providerObjectId, env, fetchImpl,
      });
      if (!canceled.ok) {
        // Stripe still owns a live intent for the old amount. Leave the attempt
        // open — blocking the change is safer than letting two amounts stand.
        summary.failed += 1;
        console.warn('[payment-authority] outdated attempt cancel failed', {
          attemptId: attempt.id, reason: canceled.error,
        });
        continue;
      }

      await prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: { status: 'superseded', failureCode: 'quote_version_superseded' },
      });
      summary.superseded += 1;
      console.log('[payment-authority] outdated attempt superseded', {
        attemptId: attempt.id,
        attemptQuoteVersion: attempt.quoteVersion,
        currentQuoteVersion: version,
      });
    }
    return summary;
  } catch (err) {
    console.warn('[payment-authority] supersede failed', err && err.message ? err.message : err);
    return summary;
  }
}

/**
 * The 409 body for a booking whose money mutations are genuinely blocked.
 * Says which attempt, how old, and what Stripe thinks — a bare error code left
 * an operator with nothing to act on.
 */
function paymentAttemptInProgressResponse(blocked) {
  const body = {
    ok: false,
    error: 'payment_attempt_in_progress',
    statusCode: 409,
    message: 'A payment attempt on this booking is still open, so the amount cannot change yet.',
  };
  if (!blocked || !blocked.attempt) return body;
  const ageMinutes = Number.isFinite(blocked.ageMs) ? Math.round(blocked.ageMs / 60000) : null;
  return {
    ...body,
    attemptId: blocked.attempt.id,
    attemptStatus: blocked.attempt.status,
    attemptAgeMinutes: ageMinutes,
    stripeStatus: blocked.stripeStatus || null,
    message: blocked.stripeStatus
      ? `Stripe still reports this payment as "${blocked.stripeStatus}"`
        + (ageMinutes != null ? `, ${ageMinutes} minutes old` : '')
        + '. The amount cannot change until it settles or is canceled.'
      : 'A payment attempt on this booking is still open, so the amount cannot change yet.'
        + (ageMinutes != null && ageMinutes > 10
          ? ` It has been open for ${ageMinutes} minutes — if the customer abandoned it, cancel it in Stripe and retry.`
          : ''),
  };
}

/**
 * Create a Stripe Customer Session so Payment Element can redisplay eligible
 * saved payment methods (respecting Stripe allow_redisplay / consent rules).
 */
async function createCustomerSession({
  stripeCustomerId,
  paymentIntentId = null,
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
        'Idempotency-Key': ['cs', stripeCustomerId, paymentIntentId || 'payment_element'].join('_'),
      },
      body: body.toString(),
    });
    const session = await res.json();
    if (!res.ok) {
      return { ok: false, error: session?.error?.message || 'customer_session_failed', statusCode: 502 };
    }
    return { ok: true, customerSessionClientSecret: session.client_secret || null };
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

async function getReceiptAuthorityData(bookingId) {
  const prisma = getPrisma();
  const [booking, quote, paymentAttempts, ledgerEntries, refundRequests] = await Promise.all([
    prisma.booking.findUnique({ where: { id: bookingId }, include: { vehicles: true } }),
    prisma.quote.findFirst({
      where: { bookingId },
      orderBy: { quoteVersion: 'desc' },
      include: { items: { orderBy: { createdAt: 'asc' } } },
    }),
    prisma.paymentAttempt.findMany({ where: { bookingId }, orderBy: { createdAt: 'asc' } }),
    prisma.ledgerEntry.findMany({ where: { bookingId }, orderBy: { recordedAt: 'asc' } }),
    prisma.refundRequest.findMany({ where: { bookingId }, orderBy: { createdAt: 'asc' } }),
  ]);
  if (!booking || !quote) return null;
  return {
    booking,
    quote,
    paymentAttempts,
    ledgerEntries,
    refundRequests,
    projection: computeFinancialProjection({ booking, quote, paymentAttempts, ledgerEntries, refundRequests }),
  };
}

class PaymentEventInvariantError extends Error {
  constructor(code) {
    super(code);
    this.name = 'PaymentEventInvariantError';
    this.code = sanitizeStripeErrorCode(code);
  }
}

function normalizedEventDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  return stripeEventCreatedAt(value);
}

function paymentIntentBinding(paymentIntent = {}) {
  const metadata = paymentIntent.metadata && typeof paymentIntent.metadata === 'object'
    ? paymentIntent.metadata
    : {};
  return {
    bookingId: String(metadata.bookingId || metadata.booking_id || '').trim(),
    quoteVersion: Math.round(Number(metadata.quoteVersion || metadata.quote_version) || 0),
    purpose: String(metadata.purpose || '').trim(),
    currency: String(paymentIntent.currency || '').trim().toLowerCase(),
    customerId: typeof paymentIntent.customer === 'string'
      ? paymentIntent.customer
      : String(paymentIntent.customer?.id || '').trim(),
  };
}

function assertPaymentIntentBinding(attempt, paymentIntent, type) {
  const binding = paymentIntentBinding(paymentIntent);
  if (!paymentIntent?.id || paymentIntent.id !== attempt.providerObjectId) {
    throw new PaymentEventInvariantError('provider_object_mismatch');
  }
  if (attempt.providerObjectType !== 'payment_intent') {
    throw new PaymentEventInvariantError('provider_object_type_mismatch');
  }
  if (attempt.purpose !== 'customer_balance' || binding.purpose !== attempt.purpose) {
    throw new PaymentEventInvariantError('payment_purpose_mismatch');
  }
  if (!binding.bookingId || binding.bookingId !== attempt.bookingId) {
    throw new PaymentEventInvariantError('payment_booking_mismatch');
  }
  if (!binding.quoteVersion || binding.quoteVersion !== attempt.quoteVersion) {
    throw new PaymentEventInvariantError('payment_quote_mismatch');
  }
  if (!binding.currency || binding.currency !== String(attempt.currency || '').toLowerCase()) {
    throw new PaymentEventInvariantError('payment_currency_mismatch');
  }
  if (attempt.providerCustomerId && binding.customerId !== attempt.providerCustomerId) {
    throw new PaymentEventInvariantError('payment_customer_mismatch');
  }

  const requiredStatus = {
    'payment_intent.succeeded': 'succeeded',
    'payment_intent.canceled': 'canceled',
    'payment_intent.requires_action': 'requires_action',
    'payment_intent.payment_failed': 'requires_payment_method',
  }[type];
  if (requiredStatus && paymentIntent.status !== requiredStatus) {
    throw new PaymentEventInvariantError('payment_event_status_mismatch');
  }
}

async function projectionInTransaction(tx, bookingId) {
  // Interactive transactions use one PostgreSQL connection. Keep statements
  // sequential; concurrent client.query() calls can cross-wire results under
  // load (and pg explicitly deprecates that usage).
  const booking = await tx.booking.findUnique({ where: { id: bookingId } });
  const quote = await tx.quote.findFirst({ where: { bookingId }, orderBy: { quoteVersion: 'desc' } });
  const paymentAttempts = await tx.paymentAttempt.findMany({ where: { bookingId }, orderBy: { createdAt: 'asc' } });
  const ledgerEntries = await tx.ledgerEntry.findMany({ where: { bookingId }, orderBy: { recordedAt: 'asc' } });
  const refundRequests = await tx.refundRequest.findMany({ where: { bookingId }, orderBy: { createdAt: 'asc' } });
  return booking && quote
    ? computeFinancialProjection({ booking, quote, paymentAttempts, ledgerEntries, refundRequests })
    : null;
}

async function persistFailedStripeEvent({
  stripeEventId,
  type,
  paymentIntent,
  eventCreatedAt,
  errorCode,
}) {
  const prisma = getPrisma();
  const payload = sanitizeStripeEventPayload(paymentIntent);
  const bookingId = payload.bookingId || null;
  const now = new Date();
  try {
    await prisma.stripeEvent.upsert({
      where: { stripeEventId },
      create: {
        stripeEventId,
        type,
        bookingId,
        payload,
        status: 'failed',
        attemptCount: 1,
        errorCode: sanitizeStripeErrorCode(errorCode),
        providerCreatedAt: normalizedEventDate(eventCreatedAt),
        lastAttemptAt: now,
      },
      update: {
        type,
        bookingId,
        payload,
        status: 'failed',
        attemptCount: { increment: 1 },
        errorCode: sanitizeStripeErrorCode(errorCode),
        providerCreatedAt: normalizedEventDate(eventCreatedAt),
        lastAttemptAt: now,
      },
    });
    return true;
  } catch {
    return false;
  }
}

function isRetryableTransactionConflict(error) {
  const codes = [
    error?.code,
    error?.cause?.code,
    error?.cause?.originalCode,
    error?.meta?.code,
    error?.meta?.driverAdapterError?.cause?.originalCode,
  ].filter(Boolean).map(String);
  if (codes.some((code) => code === 'P2034' || code === '40001' || code === '40P01')) return true;
  const message = String(error?.message || error?.cause?.message || '');
  return /serialization|write[\s_-]*conflict|TransactionWriteConflict|deadlock detected|SQLSTATE\s*40001/i.test(message);
}

async function runSerializableWithRetry(operation, maxAttempts = 7) {
  const prisma = getPrisma();
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (isRetryableTransactionConflict(error) && attempt < maxAttempts) {
        // A short bounded backoff prevents immediately colliding with the same
        // concurrent tab/webhook transaction on every retry.
        await new Promise((resolve) => setTimeout(resolve, attempt * 10));
        continue;
      }
      throw error;
    }
  }
  throw new PaymentEventInvariantError('transaction_retry_exhausted');
}

/**
 * Process one PaymentIntent event as a single PostgreSQL transaction.
 * The inbox row, attempt transition, append-only ledger credit and quote
 * settlement commit together. Failed deliveries remain reprocessable.
 */
async function reconcilePaymentIntentEvent({
  stripeEventId,
  type,
  paymentIntent,
  eventCreatedAt = null,
}) {
  const eventId = String(stripeEventId || '').trim();
  const eventType = String(type || '').trim();
  if (!eventId || !eventType || !paymentIntent?.id) {
    return { ok: false, error: 'malformed_event', statusCode: 400, quarantined: true };
  }
  if (!eventType.startsWith('payment_intent.')) {
    return { ok: false, error: 'unsupported_event_type', statusCode: 400, quarantined: false };
  }

  const payload = sanitizeStripeEventPayload(paymentIntent);
  const providerCreatedAt = normalizedEventDate(eventCreatedAt);

  try {
    return await runSerializableWithRetry(async (tx) => {
      await tx.stripeEvent.upsert({
        where: { stripeEventId: eventId },
        create: {
          stripeEventId: eventId,
          type: eventType,
          bookingId: payload.bookingId || null,
          payload,
          status: 'received',
          providerCreatedAt,
        },
        update: {
          type: eventType,
          bookingId: payload.bookingId || null,
          payload,
          providerCreatedAt,
        },
      });

      const inboxRows = await tx.$queryRaw`
        SELECT "status"::text AS "status"
        FROM "StripeEvent"
        WHERE "stripeEventId" = ${eventId}
        FOR UPDATE
      `;
      if (inboxRows[0]?.status === 'processed') {
        return { ok: true, duplicate: true, reason: 'event_already_processed' };
      }

      await tx.stripeEvent.update({
        where: { stripeEventId: eventId },
        data: {
          status: 'processing',
          attemptCount: { increment: 1 },
          errorCode: null,
          lastAttemptAt: new Date(),
        },
      });
      const failInvariant = async (errorCode) => {
        await tx.stripeEvent.update({
          where: { stripeEventId: eventId },
          data: {
            status: 'failed',
            errorCode: sanitizeStripeErrorCode(errorCode),
            lastAttemptAt: new Date(),
          },
        });
        return {
          ok: false,
          error: errorCode,
          statusCode: 500,
          quarantined: true,
          failureRecorded: true,
        };
      };

      const lockedAttempts = await tx.$queryRaw`
        SELECT "id"
        FROM "PaymentAttempt"
        WHERE "providerObjectId" = ${String(paymentIntent.id)}
        FOR UPDATE
      `;
      if (!lockedAttempts.length) {
        return failInvariant('no_matching_payment_attempt');
      }
      const attempt = await tx.paymentAttempt.findUnique({
        where: { id: lockedAttempts[0].id },
      });
      if (!attempt) return failInvariant('no_matching_payment_attempt');

      try {
        assertPaymentIntentBinding(attempt, paymentIntent, eventType);
      } catch (error) {
        if (error instanceof PaymentEventInvariantError) return failInvariant(error.code);
        throw error;
      }

      const finishEvent = async () => tx.stripeEvent.update({
        where: { stripeEventId: eventId },
        data: { status: 'processed', processedAt: new Date(), errorCode: null },
      });

      const incomingIsOlder = paymentIntent.status !== 'succeeded'
        && providerCreatedAt
        && attempt.lastProviderEventCreatedAt
        && providerCreatedAt.getTime() < attempt.lastProviderEventCreatedAt.getTime();
      const terminalWouldRegress = (
        (attempt.status === 'succeeded' && paymentIntent.status !== 'succeeded')
        || (attempt.status === 'canceled' && paymentIntent.status !== 'canceled')
      );
      if (incomingIsOlder || terminalWouldRegress) {
        await finishEvent();
        const projection = await projectionInTransaction(tx, attempt.bookingId);
        return {
          ok: true,
          duplicate: false,
          ignored: true,
          reason: incomingIsOlder ? 'out_of_order_event' : 'terminal_state_preserved',
          projection,
        };
      }

      const attemptEventPatch = {
        lastProviderEventId: eventId,
        ...(providerCreatedAt ? { lastProviderEventCreatedAt: providerCreatedAt } : {}),
      };

      if (paymentIntent.status === 'succeeded') {
        const amountCents = Math.round(Number(
          paymentIntent.amount_received != null ? paymentIntent.amount_received : paymentIntent.amount
        ) || 0);
        if (!(amountCents > 0) || amountCents !== attempt.amountCents) {
          return failInvariant('payment_amount_mismatch');
        }

        const providerEventId = `settlement_${paymentIntent.id}`;
        let ledger = await tx.ledgerEntry.findUnique({ where: { providerEventId } });
        let ledgerCreated = false;
        if (!ledger) {
          ledger = await tx.ledgerEntry.create({
            data: {
              bookingId: attempt.bookingId,
              quoteId: attempt.quoteId,
              paymentAttemptId: attempt.id,
              kind: 'settlement',
              amountCents,
              currency: attempt.currency,
              quoteVersion: attempt.quoteVersion,
              providerObjectId: paymentIntent.id,
              providerEventId,
              stripeEventId: eventId,
              occurredAt: providerCreatedAt || new Date(),
              actor: 'stripe_webhook',
            },
          });
          ledgerCreated = true;
        }

        await tx.paymentAttempt.update({
          where: { id: attempt.id },
          data: { ...attemptEventPatch, status: 'succeeded' },
        });
        const projection = await projectionInTransaction(tx, attempt.bookingId);
        if (projection?.remainingCents === 0 && projection.quoteVersion === attempt.quoteVersion) {
          await tx.quote.update({
            where: {
              bookingId_quoteVersion: {
                bookingId: attempt.bookingId,
                quoteVersion: attempt.quoteVersion,
              },
            },
            data: { status: 'settled' },
          });
        }
        await finishEvent();
        return {
          ok: true,
          duplicate: !ledgerCreated,
          ledger: { created: ledgerCreated, entry: ledger },
          projection,
        };
      }

      let nextStatus = null;
      let terminal = null;
      if (paymentIntent.status === 'canceled') {
        nextStatus = 'canceled';
        terminal = 'canceled';
      } else if (paymentIntent.status === 'requires_action') {
        nextStatus = 'requires_action';
        terminal = 'requires_action';
      } else if (paymentIntent.status === 'requires_payment_method') {
        const isFailure = eventType === 'payment_intent.payment_failed'
          || !!paymentIntent.last_payment_error;
        nextStatus = isFailure ? 'failed' : (attempt.status === 'creating' ? 'open' : attempt.status);
        terminal = isFailure ? 'failed' : null;
      }

      if (nextStatus) {
        await tx.paymentAttempt.update({
          where: { id: attempt.id },
          data: { ...attemptEventPatch, status: nextStatus },
        });
      }
      await finishEvent();
      const projection = await projectionInTransaction(tx, attempt.bookingId);
      return {
        ok: true,
        duplicate: false,
        ...(terminal ? { terminal } : {}),
        ...(!nextStatus ? { ignored: true, status: paymentIntent.status } : {}),
        projection,
      };
    });
  } catch (error) {
    const errorCode = error instanceof PaymentEventInvariantError
      ? error.code
      : 'processing_failed';
    const failureRecorded = await persistFailedStripeEvent({
      stripeEventId: eventId,
      type: eventType,
      paymentIntent,
      eventCreatedAt,
      errorCode,
    });
    return {
      ok: false,
      error: errorCode,
      statusCode: 500,
      quarantined: true,
      failureRecorded,
    };
  }
}

function buildRefundIdempotencyKey({ bookingId, requestKey }) {
  const raw = `${String(bookingId || '').trim()}|${String(requestKey || '').trim()}`;
  const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
  return `refund_${digest}_${String(requestKey || '').trim()}`.slice(0, 240);
}

function refundBinding(refund = {}) {
  const metadata = refund && typeof refund.metadata === 'object' && refund.metadata
    ? refund.metadata
    : {};
  return {
    bookingId: String(metadata.bookingId || metadata.booking_id || '').trim(),
    quoteVersion: Math.round(Number(metadata.quoteVersion || metadata.quote_version) || 0),
    purpose: String(metadata.purpose || '').trim(),
    refundRequestId: String(metadata.refundRequestId || metadata.refund_request_id || '').trim(),
    paymentIntentId: typeof refund.payment_intent === 'string'
      ? refund.payment_intent
      : String(refund.payment_intent?.id || '').trim(),
    currency: String(refund.currency || '').trim().toLowerCase(),
  };
}

function normalizedRefundStatus(refund = {}, eventType = '') {
  if (eventType === 'refund.failed') return 'failed';
  const status = String(refund.status || '').trim().toLowerCase();
  if (status === 'succeeded') return 'succeeded';
  if (status === 'failed') return 'failed';
  if (status === 'canceled') return 'canceled';
  if (status === 'requires_action') return 'requires_action';
  return 'pending_webhook';
}

function assertRefundBinding(request, attempt, refund) {
  const binding = refundBinding(refund);
  if (!refund?.id || !String(refund.id).startsWith('re_')) {
    throw new PaymentEventInvariantError('invalid_refund_object');
  }
  if (request.providerRefundId && request.providerRefundId !== refund.id) {
    throw new PaymentEventInvariantError('refund_provider_object_mismatch');
  }
  if (!binding.refundRequestId || binding.refundRequestId !== request.id) {
    throw new PaymentEventInvariantError('refund_request_mismatch');
  }
  if (!binding.bookingId || binding.bookingId !== request.bookingId) {
    throw new PaymentEventInvariantError('refund_booking_mismatch');
  }
  if (!binding.quoteVersion || binding.quoteVersion !== request.quoteVersion) {
    throw new PaymentEventInvariantError('refund_quote_mismatch');
  }
  if (binding.purpose !== 'customer_refund') {
    throw new PaymentEventInvariantError('refund_purpose_mismatch');
  }
  if (!binding.paymentIntentId || binding.paymentIntentId !== attempt.providerObjectId) {
    throw new PaymentEventInvariantError('refund_payment_intent_mismatch');
  }
  if (binding.currency !== String(request.currency || '').toLowerCase()) {
    throw new PaymentEventInvariantError('refund_currency_mismatch');
  }
  if (Math.round(Number(refund.amount) || 0) !== request.amountCents) {
    throw new PaymentEventInvariantError('refund_amount_mismatch');
  }
}

/**
 * Reserve and issue one idempotent Stripe refund. The provider response never
 * writes the ledger; only a signed refund webhook is financial authority.
 */
async function createRefund({
  bookingId,
  amountCents,
  reason,
  requestKey,
  expectedQuoteVersion,
  requestedBy = 'admin',
  env = process.env,
  fetchImpl = globalThis.fetch,
}) {
  const id = String(bookingId || '').trim();
  const cents = Math.round(Number(amountCents) || 0);
  const note = String(reason || '').trim().slice(0, 500);
  const clientRequestKey = String(requestKey || '').trim().slice(0, 96);
  const expectedVersion = Math.round(Number(expectedQuoteVersion) || 0);
  if (!id) return { ok: false, error: 'bookingId_required', statusCode: 400 };
  if (!(cents > 0)) return { ok: false, error: 'invalid_refund_amount', statusCode: 400 };
  if (!note) return { ok: false, error: 'reason_required', statusCode: 400 };
  if (!/^[A-Za-z0-9_-]{8,96}$/.test(clientRequestKey)) {
    return { ok: false, error: 'refund_request_key_required', statusCode: 400 };
  }
  if (!(expectedVersion > 0)) {
    return { ok: false, error: 'expected_quote_version_required', statusCode: 400 };
  }

  const requestGroupKey = buildRefundIdempotencyKey({ bookingId: id, requestKey: clientRequestKey });
  const actor = String(requestedBy || 'admin').trim().slice(0, 96) || 'admin';
  const matchesRequestGroup = (requests) => (
    requests.length > 0
    && requests.every((request) => (
      request.bookingId === id
      && request.quoteVersion === expectedVersion
      && request.reason === note
    ))
    && requests.reduce((sum, request) => sum + request.amountCents, 0) === cents
  );
  let reserved;
  try {
    reserved = await runSerializableWithRetry(async (tx) => {
      const existing = await tx.refundRequest.findMany({
        where: { requestGroupKey },
        orderBy: { partIndex: 'asc' },
      });
      if (existing.length) {
        return matchesRequestGroup(existing)
          ? { requests: existing, created: false }
          : { error: 'refund_request_conflict', statusCode: 409 };
      }

      const locked = await tx.$queryRaw`
        SELECT "id" FROM "Booking" WHERE "id" = ${id} FOR UPDATE
      `;
      if (!locked.length) return { error: 'not_found', statusCode: 404 };
      const replayAfterLock = await tx.refundRequest.findMany({
        where: { requestGroupKey },
        orderBy: { partIndex: 'asc' },
      });
      if (replayAfterLock.length) {
        return matchesRequestGroup(replayAfterLock)
          ? { requests: replayAfterLock, created: false }
          : { error: 'refund_request_conflict', statusCode: 409 };
      }
      const quote = await tx.quote.findFirst({ where: { bookingId: id }, orderBy: { quoteVersion: 'desc' } });
      if (!quote) return { error: 'not_found', statusCode: 404 };
      if (quote.quoteVersion !== expectedVersion) {
        return { error: 'stale_quote_version', statusCode: 409, actualQuoteVersion: quote.quoteVersion };
      }

      const attempts = await tx.paymentAttempt.findMany({
        where: { bookingId: id, status: 'succeeded', providerObjectType: 'payment_intent' },
        orderBy: { createdAt: 'desc' },
      });
      const ledgerEntries = await tx.ledgerEntry.findMany({ where: { bookingId: id } });
      const pendingRefunds = await tx.refundRequest.findMany({
        where: { bookingId: id, status: { in: ['creating', 'pending_webhook', 'requires_action'] } },
      });
      let remainingToReserve = cents;
      const allocations = [];
      for (const attempt of attempts) {
        if (!attempt.providerObjectId || !String(attempt.providerObjectId).startsWith('pi_')) continue;
        const settledForAttempt = ledgerEntries
          .filter((entry) => entry.kind === 'settlement' && entry.paymentAttemptId === attempt.id)
          .reduce((sum, entry) => sum + Math.max(0, Math.round(Number(entry.amountCents) || 0)), 0);
        const refundedForAttempt = ledgerEntries
          .filter((entry) => entry.kind === 'refund' && entry.paymentAttemptId === attempt.id)
          .reduce((sum, entry) => sum + Math.max(0, Math.round(Number(entry.amountCents) || 0)), 0);
        const reservedForAttempt = pendingRefunds
          .filter((entry) => entry.paymentAttemptId === attempt.id)
          .reduce((sum, entry) => sum + Math.max(0, Math.round(Number(entry.amountCents) || 0)), 0);
        const availableCents = Math.max(0, settledForAttempt - refundedForAttempt - reservedForAttempt);
        const allocatedCents = Math.min(availableCents, remainingToReserve);
        if (allocatedCents > 0) allocations.push({ attempt, amountCents: allocatedCents });
        remainingToReserve -= allocatedCents;
        if (remainingToReserve === 0) break;
      }
      if (remainingToReserve > 0) {
        return { error: 'refund_exceeds_available_payment', statusCode: 409 };
      }

      const requests = [];
      for (let partIndex = 0; partIndex < allocations.length; partIndex += 1) {
        const allocation = allocations[partIndex];
        const request = await tx.refundRequest.create({
          data: {
            bookingId: id,
            paymentAttemptId: allocation.attempt.id,
            quoteVersion: quote.quoteVersion,
            amountCents: allocation.amountCents,
            currency: String(allocation.attempt.currency || 'usd').toLowerCase(),
            reason: note,
            requestedBy: actor,
            requestGroupKey,
            partIndex,
            idempotencyKey: `${requestGroupKey}_p${partIndex}`,
          },
        });
        requests.push(request);
        await tx.auditEvent.create({
          data: {
            bookingId: id,
            actor,
            action: 'refund_requested',
            detail: {
              refundRequestId: request.id,
              requestGroupKey,
              partIndex,
              partCount: allocations.length,
              amountCents: allocation.amountCents,
              totalRequestedCents: cents,
              quoteVersion: quote.quoteVersion,
            },
          },
        });
      }
      return { requests, created: true };
    });
  } catch (error) {
    return {
      ok: false,
      error: error?.code === 'P2034' ? 'version_conflict' : 'refund_reservation_failed',
      statusCode: 409,
    };
  }
  if (reserved.error) return { ok: false, ...reserved };

  const guard = guardStripeOrReject(env, { purpose: 'refund_create' });
  if (guard.blocked) {
    return { ok: false, error: guard.body?.error || 'stripe_unavailable', statusCode: guard.statusCode };
  }
  const prisma = getPrisma();
  const attempts = await prisma.paymentAttempt.findMany({
    where: { id: { in: reserved.requests.map((request) => request.paymentAttemptId) } },
  });
  const attemptById = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  const accepted = [];

  for (const request of reserved.requests) {
    if (request.status === 'failed' || request.status === 'canceled') {
      return {
        ok: false,
        error: `refund_${request.status}`,
        statusCode: 409,
        refundRequest: request,
        refundRequests: reserved.requests,
      };
    }
    if (request.providerRefundId && request.status !== 'creating') {
      accepted.push(request);
      continue;
    }
    const attempt = attemptById.get(request.paymentAttemptId);
    if (!attempt?.providerObjectId) {
      return { ok: false, error: 'refund_payment_attempt_missing', statusCode: 409 };
    }
    const form = new URLSearchParams({
      payment_intent: attempt.providerObjectId,
      amount: String(request.amountCents),
      reason: 'requested_by_customer',
      'metadata[bookingId]': id,
      'metadata[booking_id]': id,
      'metadata[quoteVersion]': String(request.quoteVersion),
      'metadata[purpose]': 'customer_refund',
      'metadata[refundRequestId]': request.id,
      'metadata[refund_request_id]': request.id,
    });
    let stripeRefund;
    try {
      const response = await fetchImpl('https://api.stripe.com/v1/refunds', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${guard.secret}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Idempotency-Key': request.idempotencyKey,
        },
        body: form.toString(),
      });
      stripeRefund = await response.json();
      if (!response.ok) {
        await prisma.refundRequest.update({
          where: { id: request.id },
          data: {
            status: 'failed',
            failureCode: sanitizeStripeErrorCode(stripeRefund?.error?.code || 'stripe_refund_failed'),
          },
        }).catch(() => {});
        await prisma.refundRequest.updateMany({
          where: {
            requestGroupKey,
            status: 'creating',
            providerRefundId: null,
            id: { not: request.id },
          },
          data: { status: 'canceled', failureCode: 'refund_group_part_failed' },
        }).catch(() => {});
        return {
          ok: false,
          error: stripeRefund?.error?.code || 'stripe_refund_failed',
          statusCode: 502,
          retryable: false,
        };
      }
    } catch {
      return {
        ok: false,
        error: 'stripe_network_error',
        statusCode: 502,
        retryable: true,
        refundRequest: request,
        refundRequests: [...accepted, request],
      };
    }

    try {
      assertRefundBinding(request, attempt, stripeRefund);
    } catch (error) {
      return {
        ok: false,
        error: error.code || 'stripe_refund_invariant_failed',
        statusCode: 502,
        retryable: false,
      };
    }
    const providerStatus = normalizedRefundStatus(stripeRefund);
    const requestStatus = providerStatus === 'succeeded' ? 'pending_webhook' : providerStatus;
    const updated = await prisma.refundRequest.update({
      where: { id: request.id },
      data: {
        providerRefundId: stripeRefund.id,
        status: requestStatus,
        failureCode: requestStatus === 'failed'
          ? sanitizeStripeErrorCode(stripeRefund.failure_reason || 'provider_failed')
          : null,
      },
    });
    if (requestStatus === 'failed' || requestStatus === 'canceled') {
      return {
        ok: false,
        error: `refund_${requestStatus}`,
        statusCode: 409,
        retryable: false,
        refundRequest: updated,
        refundRequests: [...accepted, updated],
      };
    }
    accepted.push(updated);
  }

  const refundRequest = accepted[0];
  return {
    ok: true,
    created: reserved.created,
    refundRequest,
    refundRequests: accepted,
    splitAcrossPayments: accepted.length > 1,
    awaitingWebhook: accepted.some((request) => request.status !== 'succeeded'),
  };
}

/** Signed-webhook authority for refund request state and ledger debits. */
async function reconcileRefundEvent({ stripeEventId, type, refund, eventCreatedAt = null }) {
  const eventId = String(stripeEventId || '').trim();
  const eventType = String(type || '').trim();
  if (!eventId || !eventType || !refund?.id) {
    return { ok: false, error: 'malformed_event', statusCode: 400, quarantined: true };
  }
  if (!['refund.created', 'refund.updated', 'refund.failed'].includes(eventType)) {
    return { ok: false, error: 'unsupported_event_type', statusCode: 400, quarantined: false };
  }
  const payload = sanitizeStripeEventPayload(refund);
  const providerCreatedAt = normalizedEventDate(eventCreatedAt);
  try {
    return await runSerializableWithRetry(async (tx) => {
      await tx.stripeEvent.upsert({
        where: { stripeEventId: eventId },
        create: {
          stripeEventId: eventId,
          type: eventType,
          bookingId: payload.bookingId || null,
          payload,
          status: 'received',
          providerCreatedAt,
        },
        update: { type: eventType, bookingId: payload.bookingId || null, payload, providerCreatedAt },
      });
      const inboxRows = await tx.$queryRaw`
        SELECT "status"::text AS "status" FROM "StripeEvent"
        WHERE "stripeEventId" = ${eventId} FOR UPDATE
      `;
      if (inboxRows[0]?.status === 'processed') {
        return { ok: true, duplicate: true, reason: 'event_already_processed' };
      }
      await tx.stripeEvent.update({
        where: { stripeEventId: eventId },
        data: { status: 'processing', attemptCount: { increment: 1 }, errorCode: null, lastAttemptAt: new Date() },
      });

      const binding = refundBinding(refund);
      let request = await tx.refundRequest.findUnique({ where: { providerRefundId: refund.id } });
      if (!request && binding.refundRequestId) {
        request = await tx.refundRequest.findUnique({ where: { id: binding.refundRequestId } });
      }
      if (!request) throw new PaymentEventInvariantError('no_matching_refund_request');
      const lockedRequests = await tx.$queryRaw`
        SELECT "id" FROM "RefundRequest" WHERE "id" = ${request.id} FOR UPDATE
      `;
      if (!lockedRequests.length) throw new PaymentEventInvariantError('no_matching_refund_request');
      request = await tx.refundRequest.findUnique({ where: { id: request.id } });
      const attempt = await tx.paymentAttempt.findUnique({ where: { id: request.paymentAttemptId } });
      if (!attempt) throw new PaymentEventInvariantError('refund_payment_attempt_missing');
      assertRefundBinding(request, attempt, refund);

      const finishEvent = () => tx.stripeEvent.update({
        where: { stripeEventId: eventId },
        data: { status: 'processed', processedAt: new Date(), errorCode: null },
      });
      const nextStatus = normalizedRefundStatus(refund, eventType);
      const incomingIsOlder = providerCreatedAt
        && request.lastProviderEventCreatedAt
        && providerCreatedAt.getTime() < request.lastProviderEventCreatedAt.getTime();
      const terminalWouldRegress = request.status === 'succeeded' && nextStatus !== 'succeeded';
      if (incomingIsOlder || terminalWouldRegress) {
        await finishEvent();
        return {
          ok: true,
          ignored: true,
          reason: incomingIsOlder ? 'out_of_order_event' : 'terminal_state_preserved',
          projection: await projectionInTransaction(tx, request.bookingId),
        };
      }

      let ledger = null;
      let ledgerCreated = false;
      if (nextStatus === 'succeeded') {
        const providerEventId = `refund_${refund.id}`;
        ledger = await tx.ledgerEntry.findUnique({ where: { providerEventId } });
        if (!ledger) {
          const quote = await tx.quote.findUnique({
            where: { bookingId_quoteVersion: { bookingId: request.bookingId, quoteVersion: request.quoteVersion } },
          });
          ledger = await tx.ledgerEntry.create({
            data: {
              bookingId: request.bookingId,
              quoteId: quote?.id || null,
              paymentAttemptId: attempt.id,
              kind: 'refund',
              amountCents: request.amountCents,
              currency: request.currency,
              quoteVersion: request.quoteVersion,
              providerObjectId: refund.id,
              providerEventId,
              stripeEventId: eventId,
              occurredAt: providerCreatedAt || new Date(),
              actor: 'stripe_webhook',
            },
          });
          ledgerCreated = true;
        }
      }
      await tx.refundRequest.update({
        where: { id: request.id },
        data: {
          providerRefundId: refund.id,
          status: nextStatus,
          lastProviderEventId: eventId,
          ...(providerCreatedAt ? { lastProviderEventCreatedAt: providerCreatedAt } : {}),
          failureCode: nextStatus === 'failed'
            ? sanitizeStripeErrorCode(refund.failure_reason || 'provider_failed')
            : null,
          ...(nextStatus === 'succeeded' ? { succeededAt: providerCreatedAt || new Date() } : {}),
        },
      });
      await finishEvent();
      const projection = await projectionInTransaction(tx, request.bookingId);
      return {
        ok: true,
        duplicate: nextStatus === 'succeeded' ? !ledgerCreated : false,
        status: nextStatus,
        ledger: nextStatus === 'succeeded' ? { created: ledgerCreated, entry: ledger } : null,
        projection,
      };
    });
  } catch (error) {
    const errorCode = error instanceof PaymentEventInvariantError ? error.code : 'processing_failed';
    const failureRecorded = await persistFailedStripeEvent({
      stripeEventId: eventId,
      type: eventType,
      paymentIntent: refund,
      eventCreatedAt,
      errorCode,
    });
    return { ok: false, error: errorCode, statusCode: 500, quarantined: true, failureRecorded };
  }
}

/**
 * Approve one immutable quote adjustment under serializable quote-version CAS.
 * Settled money is never rewritten: increases become a remaining delta and
 * decreases expose outstandingCreditCents for a separate refund request.
 */
async function createAdjustment({
  bookingId,
  newApprovedCents,
  reason,
  adjustmentId,
  expectedQuoteVersion = null,
  approvedBy = 'admin',
}) {
  const id = String(bookingId || '').trim();
  const cents = Math.round(Number(newApprovedCents));
  const note = String(reason || '').trim().slice(0, 500);
  const adjustmentKey = String(adjustmentId || '').trim().slice(0, 96);
  const expectedVersion = expectedQuoteVersion == null
    ? null
    : Math.round(Number(expectedQuoteVersion));
  if (!id) return { ok: false, error: 'bookingId_required', statusCode: 400 };
  if (!Number.isFinite(cents) || cents < 0) {
    return { ok: false, error: 'invalid_approved_amount', statusCode: 400 };
  }
  if (!note) return { ok: false, error: 'reason_required', statusCode: 400 };
  if (!/^[A-Za-z0-9_-]{6,96}$/.test(adjustmentKey)) {
    return { ok: false, error: 'adjustment_id_required', statusCode: 400 };
  }

  // Before the transaction, and before the guard inside it can refuse:
  //  1. close attempts Stripe has already finished with — a webhook that never
  //     landed must not block every future add-on approval on this booking;
  //  2. retire attempts owed against a previous amount, canceling their intent
  //     at Stripe so a stale amount can never be paid.
  const reconciled = await reconcileStalePaymentAttempts({ bookingId: id });
  if (expectedVersion != null) {
    await supersedeOutdatedAttempts({
      bookingId: id,
      currentQuoteVersion: expectedVersion,
      // Changing the amount voids any unpaid obligation to the old amount,
      // including one raised against the version being replaced.
      includeCurrentVersion: true,
    });
  }

  try {
    return await runSerializableWithRetry(async (tx) => {
      const existing = await tx.quote.findUnique({ where: { adjustmentId: adjustmentKey } });
      if (existing) {
        if (existing.bookingId !== id
          || existing.approvedCents !== cents
          || existing.adjustmentReason !== note) {
          return { ok: false, error: 'adjustment_id_conflict', statusCode: 409 };
        }
        return {
          ok: true,
          created: false,
          idempotent: true,
          quote: existing,
          after: await projectionInTransaction(tx, id),
        };
      }

      const locked = await tx.$queryRaw`
        SELECT "id" FROM "Booking" WHERE "id" = ${id} FOR UPDATE
      `;
      if (!locked.length) return { ok: false, error: 'not_found', statusCode: 404 };
      const replayAfterLock = await tx.quote.findUnique({ where: { adjustmentId: adjustmentKey } });
      if (replayAfterLock) {
        if (replayAfterLock.bookingId !== id
          || replayAfterLock.approvedCents !== cents
          || replayAfterLock.adjustmentReason !== note) {
          return { ok: false, error: 'adjustment_id_conflict', statusCode: 409 };
        }
        return {
          ok: true,
          created: false,
          idempotent: true,
          quote: replayAfterLock,
          after: await projectionInTransaction(tx, id),
        };
      }
      const previousQuote = await tx.quote.findFirst({
        where: { bookingId: id },
        orderBy: { quoteVersion: 'desc' },
        include: { items: true },
      });
      if (!previousQuote) return { ok: false, error: 'not_found', statusCode: 404 };
      if (expectedVersion != null && previousQuote.quoteVersion !== expectedVersion) {
        return {
          ok: false,
          error: 'stale_quote_version',
          statusCode: 409,
          expectedQuoteVersion: expectedVersion,
          actualQuoteVersion: previousQuote.quoteVersion,
        };
      }
      // Scoped to the CURRENT quote version. An attempt is an obligation to pay
      // one amount, so only an attempt against the amount being changed can
      // legitimately block the change — that protection is intact. An attempt
      // left over from a previous amount used to block here forever; those are
      // retired above instead.
      const activeAttempt = await tx.paymentAttempt.findFirst({
        where: {
          bookingId: id,
          status: { in: ACTIVE_ATTEMPT_STATUSES },
          quoteVersion: previousQuote.quoteVersion,
        },
      });
      if (activeAttempt) {
        // Reconciliation above already closed whatever Stripe had finished, so
        // anything still here is genuinely live — say which one and how old.
        return paymentAttemptInProgressResponse(
          reconciled.blocked && reconciled.blocked.attempt?.id === activeAttempt.id
            ? reconciled.blocked
            : { attempt: activeAttempt, ageMs: attemptAgeMs(activeAttempt, Date.now()), stripeStatus: null }
        );
      }

      const before = await projectionInTransaction(tx, id);
      const deltaCents = cents - previousQuote.approvedCents;
      const copiedItems = previousQuote.items.map((item) => ({
        vehicleId: item.vehicleId,
        kind: item.kind,
        label: item.label,
        amountCents: item.amountCents,
      }));
      if (deltaCents !== 0) {
        copiedItems.push({
          kind: deltaCents > 0 ? 'adjustment_increase' : 'adjustment_decrease',
          label: `Price adjustment — ${note}`.slice(0, 220),
          amountCents: deltaCents,
        });
      }
      const quote = await tx.quote.create({
        data: {
          bookingId: id,
          quoteVersion: previousQuote.quoteVersion + 1,
          approvedCents: cents,
          currency: previousQuote.currency,
          status: 'approved',
          adjustmentId: adjustmentKey,
          adjustmentReason: note,
          approvedBy: String(approvedBy || 'admin').trim().slice(0, 96) || 'admin',
          approvedAt: new Date(),
          ...(copiedItems.length ? { items: { create: copiedItems } } : {}),
        },
        include: { items: true },
      });
      if (previousQuote.status !== 'settled') {
        await tx.quote.update({ where: { id: previousQuote.id }, data: { status: 'superseded' } });
      }
      await tx.auditEvent.create({
        data: {
          bookingId: id,
          actor: quote.approvedBy || 'admin',
          action: 'quote_adjustment_approved',
          detail: {
            adjustmentId: adjustmentKey,
            reason: note,
            previousQuoteVersion: previousQuote.quoteVersion,
            quoteVersion: quote.quoteVersion,
            previousApprovedCents: previousQuote.approvedCents,
            approvedCents: cents,
            deltaCents,
          },
        },
      });
      const after = await projectionInTransaction(tx, id);
      return {
        ok: true,
        created: true,
        previousQuote,
        quote,
        before,
        after,
        deltaCents,
        outstandingCreditCents: Math.max(0, (after?.settledCents || 0) - (after?.approvedCents || 0)),
        reason: note,
      };
    });
  } catch (error) {
    if (error?.code === 'P2002') return { ok: false, error: 'version_conflict', statusCode: 409 };
    throw error;
  }
}

function isOnSiteSettlementEntry(entry, method = null) {
  if (!entry || entry.kind !== 'settlement') return false;
  const provider = String(entry.providerObjectId || '');
  const eventId = String(entry.providerEventId || '');
  if (method) {
    return provider === method || eventId.startsWith(`${method}_full_balance:`);
  }
  return ['cash', 'card_on_site'].includes(provider)
    || /^(cash|card_on_site)_full_balance:/.test(eventId);
}

function isCashSettlementEntry(entry) {
  return isOnSiteSettlementEntry(entry, 'cash');
}

function buildOnSiteFullBalanceProviderEventId({
  method,
  bookingId,
  quoteVersion,
  settledCents,
  remainingCents,
}) {
  return [
    `${method}_full_balance`,
    bookingId,
    quoteVersion,
    settledCents,
    remainingCents,
  ].join(':');
}

function buildCashFullBalanceProviderEventId(fields) {
  return buildOnSiteFullBalanceProviderEventId({ method: 'cash', ...fields });
}

/**
 * Full-balance Admin cash settlement against PostgreSQL ledger authority.
 * Idempotent on providerEventId:
 *   cash_full_balance:{bookingId}:{quoteVersion}:{settledCents}:{remainingCents}
 * Does not mutate approvedCents or create a new quoteVersion.
 */
async function recordFullBalanceOnSiteSettlement({ bookingId, method = 'cash', body = {} }) {
  const { resolveAdminCashSettlement } = require('../admin-booking-mutations');

  const id = String(bookingId || '').trim();
  if (!id) return { ok: false, error: 'bookingId_required', statusCode: 400 };
  if (!['cash', 'card_on_site'].includes(method)) {
    return { ok: false, error: 'invalid_on_site_payment_method', statusCode: 400 };
  }
  const reason = String(body.reason || '').trim().slice(0, 500);
  if (!reason) return { ok: false, error: 'reason_required', statusCode: 400 };
  const reference = String(body.reference || '').trim().slice(0, 120);
  if (method === 'card_on_site' && !reference) {
    return { ok: false, error: 'reference_required', statusCode: 400 };
  }
  if (method === 'card_on_site' && reference.replace(/\D/g, '').length >= 12) {
    return { ok: false, error: 'unsafe_card_reference', statusCode: 400 };
  }

  const prisma = getPrisma();
  if (!prisma) return { ok: false, error: 'database_not_configured', statusCode: 503 };

  let providerEventIdForConflict = null;

  try {
    return await runSerializableWithRetry(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "Booking" WHERE "id" = ${id} FOR UPDATE
      `;
      const booking = await tx.booking.findUnique({ where: { id } });
      const quote = await tx.quote.findFirst({
        where: { bookingId: id },
        orderBy: { quoteVersion: 'desc' },
      });
      if (!booking || !quote) {
        return { ok: false, error: 'not_found', statusCode: 404 };
      }

      const ledgerEntries = await tx.ledgerEntry.findMany({
        where: { bookingId: id },
        orderBy: { recordedAt: 'asc' },
      });
      const paymentAttempts = await tx.paymentAttempt.findMany({
        where: { bookingId: id },
      });

      const activeAttempt = paymentAttempts.find((attempt) => (
        ['creating', 'open', 'requires_action'].includes(attempt.status)
      ));
      if (activeAttempt) {
        return {
          ok: false,
          error: 'payment_attempt_in_progress',
          statusCode: 409,
        };
      }

      const before = computeFinancialProjection({
        booking,
        quote,
        paymentAttempts,
        ledgerEntries,
      });

      const resolved = resolveAdminCashSettlement(
        { id, paymentStatus: before.paymentStatus },
        body,
        { authoritativeProjection: before }
      );

      if (before.remainingCents <= 0) {
        const existingOnSite = [...ledgerEntries].reverse()
          .find((entry) => isOnSiteSettlementEntry(entry, method));
        if (existingOnSite) {
          return {
            ok: true,
            created: false,
            noop: true,
            duplicate: true,
            projection: before,
            entry: existingOnSite,
            settledAmountCents: existingOnSite.amountCents,
            quoteVersion: before.quoteVersion,
          };
        }
        return {
          ok: false,
          error: resolved.error || (before.paymentStatus === 'paid' ? 'already_paid' : 'not_due'),
          statusCode: 409,
          projection: before,
          expectedAmountCents: 0,
          receivedAmountCents: resolved.receivedAmountCents,
        };
      }

      if (!resolved.ok) {
        return {
          ok: false,
          error: resolved.error,
          statusCode: resolved.statusCode || 400,
          projection: before,
          expectedAmountCents: resolved.expectedAmountCents,
          receivedAmountCents: resolved.receivedAmountCents,
          reason: resolved.reason,
          field: resolved.field,
        };
      }

      // Re-check remaining inside the same transaction immediately before insert.
      const remainingCents = Math.max(0, Math.round(Number(before.remainingCents) || 0));
      const settledBefore = Math.max(0, Math.round(Number(before.settledCents) || 0));
      if (remainingCents <= 0 || resolved.amountCents !== remainingCents) {
        return {
          ok: false,
          error: 'cash_amount_mismatch',
          statusCode: 400,
          projection: before,
          expectedAmountCents: remainingCents,
          receivedAmountCents: resolved.amountCents,
        };
      }

      const providerEventId = buildOnSiteFullBalanceProviderEventId({
        method,
        bookingId: id,
        quoteVersion: before.quoteVersion,
        settledCents: settledBefore,
        remainingCents,
      });
      providerEventIdForConflict = providerEventId;

      let entry;
      try {
        entry = await tx.ledgerEntry.create({
          data: {
            bookingId: id,
            quoteId: quote.id,
            kind: 'settlement',
            amountCents: remainingCents,
            quoteVersion: before.quoteVersion,
            providerObjectId: method,
            providerEventId,
            actor: method === 'cash'
              ? 'admin_mark_cash_received'
              : 'admin_mark_card_on_site',
          },
        });
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
          throw err;
        }
        // Failed statement aborts the interactive transaction — resolve outside.
        const conflict = new Error('CASH_SETTLEMENT_IDEMPOTENT');
        conflict.code = 'CASH_SETTLEMENT_IDEMPOTENT';
        conflict.providerEventId = providerEventId;
        throw conflict;
      }

      const afterEntries = [...ledgerEntries, entry];
      const after = computeFinancialProjection({
        booking,
        quote,
        paymentAttempts,
        ledgerEntries: afterEntries,
      });

      if (after.remainingCents === 0 && quote.status !== 'settled') {
        await tx.quote.update({
          where: { bookingId_quoteVersion: { bookingId: id, quoteVersion: quote.quoteVersion } },
          data: { status: 'settled' },
        });
      }

      await tx.auditEvent.create({
        data: {
          bookingId: id,
          actor: 'admin',
          action: method === 'cash' ? 'mark_cash_received' : 'mark_card_on_site',
          detail: {
             method,
             reason,
             ...(reference ? { reference } : {}),
            amountCents: remainingCents,
            quoteVersion: before.quoteVersion,
            previousRemainingCents: before.remainingCents,
            resultingRemainingCents: after.remainingCents,
          },
        },
      });

      return {
        ok: true,
        created: true,
        noop: false,
        duplicate: false,
        projection: after,
        entry,
        settledAmountCents: entry.amountCents,
        quoteVersion: after.quoteVersion,
        providerEventId,
      };
    });
  } catch (err) {
    if (err && err.code === 'CASH_SETTLEMENT_IDEMPOTENT') {
      const providerEventId = err.providerEventId || providerEventIdForConflict;
      const entry = providerEventId
        ? await prisma.ledgerEntry.findUnique({ where: { providerEventId } })
        : null;
      const after = await getFinancialProjection(id);
      if (entry) {
        return {
          ok: true,
          created: false,
          noop: true,
          duplicate: true,
          projection: after,
          entry,
          settledAmountCents: entry.amountCents,
          quoteVersion: after?.quoteVersion,
          providerEventId,
        };
      }
      const existingOnSite = (await repo.listLedgerEntries(id))
        .filter((entry) => isOnSiteSettlementEntry(entry, method))
        .pop();
      if (existingOnSite) {
        return {
          ok: true,
          created: false,
          noop: true,
          duplicate: true,
          projection: after,
          entry: existingOnSite,
          settledAmountCents: existingOnSite.amountCents,
          quoteVersion: after?.quoteVersion,
        };
      }
      return {
        ok: false,
        error: 'duplicate_constraint',
        statusCode: 500,
        projection: after,
      };
    }
    throw err;
  }
}

async function recordFullBalanceCashSettlement(args) {
  return recordFullBalanceOnSiteSettlement({ ...args, method: 'cash' });
}

module.exports = {
  ACTIVE_ATTEMPT_STATUSES,
  ATTEMPT_STALE_AFTER_MS,
  reconcileStalePaymentAttempts,
  supersedeOutdatedAttempts,
  paymentAttemptInProgressResponse,
  buildIdempotencyKey,
  getFinancialProjection,
  getReceiptAuthorityData,
  reserveAndCreatePaymentIntent,
  retrievePaymentIntentClientSecret,
  createCustomerSession,
  reconcileFromStripeProvider,
  reconcilePaymentIntentEvent,
  createRefund,
  reconcileRefundEvent,
  createAdjustment,
  buildRefundIdempotencyKey,
  refundBinding,
  recordFullBalanceOnSiteSettlement,
  recordFullBalanceCashSettlement,
  buildOnSiteFullBalanceProviderEventId,
  buildCashFullBalanceProviderEventId,
  isOnSiteSettlementEntry,
  isCashSettlementEntry,
};
