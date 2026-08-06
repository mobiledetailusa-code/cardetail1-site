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

const { guardStripeOrReject } = require('../stripe-mode');
const { getPrisma } = require('../prisma');
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
  const [booking, quote, paymentAttempts, ledgerEntries] = await Promise.all([
    repo.getBooking(bookingId, prismaOverride),
    repo.getLatestQuote(bookingId, prismaOverride),
    repo.listPaymentAttempts(bookingId, prismaOverride),
    repo.listLedgerEntries(bookingId, prismaOverride),
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
  const prisma = getPrisma();
  const lockKey = ['payment_intent_create', bookingId, quoteVersion].join(':');

  // The unique indexes prevent duplicate PaymentAttempt rows, but they do not
  // by themselves prevent two workers from observing the same freshly-created
  // `creating` row before its providerObjectId is attached. Serialize that
  // short critical section across processes with a transaction-scoped advisory
  // lock. This also preserves timeout recovery: a later caller retries Stripe
  // with the exact same Idempotency-Key after the first transaction commits.
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
  }, { maxWait: 10_000, timeout: 30_000 });
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
  const [booking, quote, paymentAttempts, ledgerEntries] = await Promise.all([
    tx.booking.findUnique({ where: { id: bookingId } }),
    tx.quote.findFirst({ where: { bookingId }, orderBy: { quoteVersion: 'desc' } }),
    tx.paymentAttempt.findMany({ where: { bookingId }, orderBy: { createdAt: 'asc' } }),
    tx.ledgerEntry.findMany({ where: { bookingId }, orderBy: { recordedAt: 'asc' } }),
  ]);
  return booking && quote
    ? computeFinancialProjection({ booking, quote, paymentAttempts, ledgerEntries })
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

async function runSerializableWithRetry(operation, maxAttempts = 3) {
  const prisma = getPrisma();
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (error?.code === 'P2034' && attempt < maxAttempts) continue;
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

      const lockedAttempts = await tx.$queryRaw`
        SELECT "id"
        FROM "PaymentAttempt"
        WHERE "providerObjectId" = ${String(paymentIntent.id)}
        FOR UPDATE
      `;
      if (!lockedAttempts.length) {
        throw new PaymentEventInvariantError('no_matching_payment_attempt');
      }
      const attempt = await tx.paymentAttempt.findUnique({
        where: { id: lockedAttempts[0].id },
      });
      if (!attempt) throw new PaymentEventInvariantError('no_matching_payment_attempt');

      assertPaymentIntentBinding(attempt, paymentIntent, eventType);

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
          throw new PaymentEventInvariantError('payment_amount_mismatch');
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

/**
 * PR1 refund boundary: fail closed until PR2 adds a request state machine and
 * signed refund-webhook authority. No Stripe request is issued here.
 */
async function createRefund({
  bookingId,
  amountCents,
  reason = 'requested_by_customer',
  env = process.env,
  fetchImpl = globalThis.fetch,
}) {
  void bookingId;
  void amountCents;
  void reason;
  void env;
  void fetchImpl;
  // PR1 fail-closed boundary. PR2 will create a refund request and let the
  // signed Stripe refund webhook append the authoritative ledger entry.
  return { ok: false, error: 'refund_execution_pending_pr2', statusCode: 501 };
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
  const attempts = await repo.listPaymentAttempts(bookingId);
  const activeAttempt = attempts.find((attempt) => (
    ['creating', 'open', 'requires_action'].includes(attempt.status)
  ));
  if (activeAttempt) {
    return {
      ok: false,
      error: 'payment_attempt_in_progress',
      statusCode: 409,
      projection: before,
    };
  }

  const { previousQuote, quote } = await repo.createAdjustmentQuote({
    bookingId,
    approvedCents: newApprovedCents,
    status: 'approved',
  });

  const after = await getFinancialProjection(bookingId);
  return { ok: true, previousQuote, quote, before, after, reason };
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
  buildIdempotencyKey,
  getFinancialProjection,
  reserveAndCreatePaymentIntent,
  retrievePaymentIntentClientSecret,
  createCustomerSession,
  reconcileFromStripeProvider,
  reconcilePaymentIntentEvent,
  createRefund,
  createAdjustment,
  recordFullBalanceOnSiteSettlement,
  recordFullBalanceCashSettlement,
  buildOnSiteFullBalanceProviderEventId,
  buildCashFullBalanceProviderEventId,
  isOnSiteSettlementEntry,
  isCashSettlementEntry,
};
