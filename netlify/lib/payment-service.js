/**
 * Authoritative payment service — remaining cents, version-bound attempts, reconciliation.
 */

const crypto = require('crypto');
const { remainingCents, buildNextAggregate, normalizeAggregate } = require('./booking-aggregate');
const { dollarsToCents, centsToDollars, asArray } = require('./historical-adapter');
const { guardStripeOrReject } = require('./stripe-mode');

function moneyConflict(aggregate) {
  const { ok, aggregate: norm } = normalizeAggregate(aggregate, { allowDraft: true });
  if (!ok) return { conflict: true, reason: 'invalid_aggregate' };
  const ledger = norm.ledger;
  const derived = remainingCents(ledger);
  if (norm._historicalPaidClosed) {
    return { conflict: false, payable: false, reason: 'historical_paid_closed', remainingCents: 0 };
  }
  const js = String(norm.jobStatus || '').toLowerCase();
  const status = String(norm.status || '').toLowerCase();
  const pwf = String(norm.paymentWorkflowStatus || '').toLowerCase();
  if (js === 'completed_paid' || status === 'paid' || status === 'closed') {
    return { conflict: false, payable: false, reason: 'paid_or_closed', remainingCents: 0 };
  }
  if (pwf === 'payment_succeeded' && derived === 0) {
    return { conflict: false, payable: false, reason: 'already_settled', remainingCents: 0 };
  }
  if (js === 'cancelled' || status === 'cancelled' || status === 'canceled') {
    return { conflict: false, payable: false, reason: 'cancelled', remainingCents: 0 };
  }
  // Raw (pre-normalize) stored due that disagrees with raw ledger is a hard conflict.
  const raw = aggregate && typeof aggregate === 'object' ? aggregate : {};
  if (raw.ledger && typeof raw.ledger === 'object'
    && (raw.amountDueApproved != null || raw.balanceDue != null)
    && (raw.ledger.approvedCents != null || raw.ledger.settledCents != null)) {
    const rawDerived = remainingCents(raw.ledger);
    const storedDueCents = dollarsToCents(
      raw.amountDueApproved != null ? raw.amountDueApproved : raw.balanceDue
    );
    if (Math.round(Number(raw.ledger.approvedCents) || 0) > 0 && Math.abs(storedDueCents - rawDerived) > 1) {
      return {
        conflict: true,
        payable: false,
        reason: 'stale_due_mismatch',
        remainingCents: rawDerived,
        storedDueCents,
      };
    }
  }
  return { conflict: false, payable: derived > 0, remainingCents: derived, reason: null };
}

function canCreatePayment(aggregate, { expectedBookingVersion, expectedQuoteVersion } = {}) {
  const { ok, aggregate: norm } = normalizeAggregate(aggregate, { allowDraft: false });
  if (!ok) return { ok: false, error: 'invalid_aggregate' };

  if (expectedBookingVersion != null
    && Math.round(Number(expectedBookingVersion)) !== Math.round(Number(norm.bookingVersion) || 0)) {
    return { ok: false, error: 'version_conflict', statusCode: 409 };
  }
  const qv = norm.quoteVersion || norm.quote?.quoteVersion || 0;
  if (expectedQuoteVersion != null && Math.round(Number(expectedQuoteVersion)) !== Math.round(Number(qv))) {
    return { ok: false, error: 'quote_version_conflict', statusCode: 409 };
  }

  const check = moneyConflict(norm);
  if (check.conflict) return { ok: false, error: 'money_conflict' };
  if (!check.payable) return { ok: false, error: 'not_payable', reason: check.reason };
  if (!(check.remainingCents > 0)) return { ok: false, error: 'zero_balance' };

  return {
    ok: true,
    remainingCents: check.remainingCents,
    bookingVersion: norm.bookingVersion,
    quoteVersion: qv,
    currency: 'usd',
    aggregate: norm,
  };
}

function buildPaymentAttempt({
  bookingId,
  bookingVersion,
  quoteVersion,
  amountCents,
  providerObjectId,
  type = 'customer_balance',
  idempotencyKey,
}) {
  return {
    attemptId: `pa_${crypto.randomBytes(8).toString('hex')}`,
    provider: 'stripe',
    providerObjectId: providerObjectId || '',
    type,
    bookingId,
    bookingVersion,
    quoteVersion,
    currency: 'usd',
    amountCents,
    status: providerObjectId ? 'open' : 'creating',
    idempotencyKey: idempotencyKey || '',
    createdAt: new Date().toISOString(),
  };
}

function supersedeOpenAttempts(attempts, { quoteVersion, forceAll = false } = {}) {
  return asArray(attempts).map((a) => {
    if (a.status === 'open' || a.status === 'creating') {
      if (forceAll
        || Math.round(Number(a.quoteVersion) || 0) !== Math.round(Number(quoteVersion) || 0)) {
        return { ...a, status: 'superseded', supersededAt: new Date().toISOString() };
      }
    }
    return a;
  });
}

/**
 * Provider-side Checkout Session expiration (not local-only clear).
 * @returns {{ ok: boolean, expired: string[], failed: Array<{id:string,error:string}>, networkCalls: number }}
 */
async function expireStripeCheckoutSessions({
  sessionIds,
  secret,
  fetchImpl = globalThis.fetch,
} = {}) {
  const ids = [...new Set(asArray(sessionIds).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return { ok: true, expired: [], failed: [], networkCalls: 0 };
  if (!secret) return { ok: false, expired: [], failed: ids.map((id) => ({ id, error: 'missing_secret' })), networkCalls: 0 };

  const expired = [];
  const failed = [];
  let networkCalls = 0;
  for (const id of ids) {
    try {
      networkCalls += 1;
      const res = await fetchImpl(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(id)}/expire`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}` },
      });
      const body = await res.json().catch(() => ({}));
      // Already expired / completed sessions are treated as success (idempotent)
      if (res.ok || body?.status === 'expired' || /already|expired/i.test(String(body?.error?.message || ''))) {
        expired.push(id);
      } else {
        failed.push({ id, error: (body.error && body.error.message) || `stripe_${res.status}` });
      }
    } catch (e) {
      failed.push({ id, error: e.message || 'network_error' });
    }
  }
  return { ok: failed.length === 0, expired, failed, networkCalls };
}

/**
 * Expire superseded open attempts provider-side using shared Stripe-mode guard.
 */
async function expireSupersededAttempts(attempts, env = process.env, fetchImpl = globalThis.fetch) {
  const ids = asArray(attempts)
    .filter((a) => a && a.status === 'superseded' && a.providerObjectId)
    .map((a) => a.providerObjectId);
  if (!ids.length) return { ok: true, expired: [], failed: [], networkCalls: 0, skipped: 'none' };

  const guard = guardStripeOrReject(env, { purpose: 'expire_checkout_session' });
  if (guard.blocked) {
    return {
      ok: false,
      expired: [],
      failed: ids.map((id) => ({ id, error: guard.body?.error || 'stripe_blocked' })),
      networkCalls: 0,
      blocked: true,
      error: guard.body?.error,
    };
  }
  return expireStripeCheckoutSessions({ sessionIds: ids, secret: guard.secret, fetchImpl });
}

/**
 * Authoritative financial projection shared by Admin + Customer portals.
 * paymentStatus: paid | due | processing | failed | not_due
 */
function financialProjection(booking) {
  const { materialProjection } = require('./booking-aggregate');
  const { isInvoicePaid } = require('./appointment-status-policy');
  const material = materialProjection(booking) || {};
  const ledger = (booking && booking.ledger) || {};
  const approvedCents = Math.max(
    0,
    Math.round(Number(material.approvedCents != null ? material.approvedCents : ledger.approvedCents) || 0)
  );
  const settledCents = Math.max(
    0,
    Math.round(Number(material.settledCents != null ? material.settledCents : ledger.settledCents) || 0)
  );
  const rem = material.remainingCents != null
    ? Math.max(0, Math.round(Number(material.remainingCents) || 0))
    : remainingCents(ledger);

  const rawPay = String(booking?.paymentStatus || '').toLowerCase();
  const pwf = String(booking?.paymentWorkflowStatus || '').toLowerCase();
  const invoicePaid = !!(isInvoicePaid(booking) || (settledCents > 0 && rem === 0));

  let paymentStatus = 'not_due';
  if (rawPay === 'failed' || pwf === 'payment_failed') {
    paymentStatus = 'failed';
  } else if (
    invoicePaid
    || rawPay === 'paid'
    || pwf === 'payment_succeeded'
    || pwf === 'cash_paid'
    || (settledCents > 0 && rem === 0)
  ) {
    paymentStatus = 'paid';
  } else if (rawPay === 'processing' || pwf === 'awaiting_customer_payment' || pwf === 'payment_action_required') {
    paymentStatus = rem > 0 ? 'processing' : 'paid';
  } else if (rem > 0) {
    paymentStatus = 'due';
  }

  let paymentWorkflowStatus = pwf || 'no_payment_required_yet';
  if (paymentStatus === 'paid') {
    paymentWorkflowStatus = pwf === 'cash_paid' ? 'cash_paid' : 'payment_succeeded';
  } else if (paymentStatus === 'failed') {
    paymentWorkflowStatus = 'payment_failed';
  } else if (paymentStatus === 'processing') {
    paymentWorkflowStatus = pwf === 'payment_action_required'
      ? 'payment_action_required'
      : 'awaiting_customer_payment';
  } else if (paymentStatus === 'due') {
    paymentWorkflowStatus = pwf && pwf !== 'payment_succeeded' ? pwf : 'awaiting_customer_payment';
  }

  const settlementEntry = asArray(booking?.ledger?.entries)
    .filter((e) => e && e.kind === 'settlement' && e.providerObjectId)
    .slice(-1)[0];
  const sessionId = String(
    booking?.stripeCheckoutSessionId
    || booking?.lastStripeCheckoutSessionId
    || settlementEntry?.providerObjectId
    || ''
  ).trim();
  const piId = String(booking?.paymentIntentId || '').trim();

  return {
    approvedCents,
    settledCents,
    remainingCents: paymentStatus === 'paid' ? 0 : rem,
    paymentStatus,
    paymentWorkflowStatus,
    invoicePaid: paymentStatus === 'paid',
    canGeneratePayLink: paymentStatus !== 'paid' && rem > 0,
    stripeCheckoutSessionId: sessionId,
    stripeCheckoutSessionIdPrefix: sessionId ? sessionId.slice(0, 12) : '',
    paymentIntentIdPrefix: piId ? piId.slice(0, 12) : '',
  };
}

function logPaymentReconciliation(payload) {
  const p = payload || {};
  const sessionId = p.checkoutSessionId || p.sessionId || '';
  const piId = p.paymentIntentId || '';
  console.log('[payment-reconcile]', JSON.stringify({
    bookingId: p.bookingId || null,
    stripeEventId: p.stripeEventId || null,
    checkoutSessionIdPrefix: sessionId ? String(sessionId).slice(0, 12) : null,
    paymentIntentIdPrefix: piId ? String(piId).slice(0, 12) : null,
    localStateBefore: p.localBefore || null,
    providerState: p.providerState || null,
    localStateAfter: p.localAfter || null,
    adminProjection: p.adminProjection || null,
  }));
}

/**
 * Pure reconciliation for customer_balance Checkout completion.
 * Requires a matching stored payment attempt with exact booking/version/currency/amount/object binding.
 */
function reconcileCustomerBalanceSession({
  aggregate,
  session,
  stripeEventId,
}) {
  const { ok, aggregate: norm } = normalizeAggregate(aggregate, { allowDraft: false });
  if (!ok) return { ok: false, error: 'invalid_aggregate', quarantined: true };

  const meta = session?.metadata || {};
  const purpose = meta.purpose || meta.type || '';
  if (purpose !== 'customer_balance') {
    return { ok: false, error: 'wrong_purpose', quarantined: false, ignored: true };
  }

  const sessionId = String(session.id || '').trim();
  if (!sessionId) return { ok: false, error: 'missing_session_id', quarantined: true };

  const amountCents = Math.round(
    Number(session.amount_total != null ? session.amount_total : session.amount_subtotal) || 0
  );
  const currency = String(session.currency || 'usd').toLowerCase();
  const sessionBookingId = String(meta.booking_id || meta.bookingId || '').trim();
  const sessionBookingVersion = Math.round(Number(meta.bookingVersion || meta.booking_version) || 0);
  const sessionQuoteVersion = Math.round(Number(meta.quoteVersion || meta.quote_version) || 0);
  const eventId = String(stripeEventId || '').trim();

  const already = asArray(norm.ledger.entries).some(
    (e) => e.providerObjectId === sessionId
      || e.providerEventId === sessionId
      || (eventId && (e.stripeEventId === eventId || e.providerEventId === eventId))
  );
  if (already) {
    return { ok: true, duplicate: true, aggregate: norm };
  }

  const bookingId = String(norm.id || norm.bookingId || '').trim();
  const attempts = asArray(norm.paymentAttempts);
  const matchingAttempt = attempts.find((a) => a && a.providerObjectId === sessionId);

  if (!matchingAttempt) {
    return { ok: false, error: 'missing_payment_attempt', quarantined: true };
  }

  if (currency !== 'usd' || String(matchingAttempt.currency || 'usd').toLowerCase() !== 'usd') {
    return { ok: false, error: 'currency_mismatch', quarantined: true };
  }

  const qv = Math.round(Number(norm.quoteVersion || norm.quote?.quoteVersion) || 0);
  const bv = Math.round(Number(norm.bookingVersion) || 0);
  const attemptBookingId = String(matchingAttempt.bookingId || '').trim();
  const attemptBv = Math.round(Number(matchingAttempt.bookingVersion) || 0);
  const attemptQv = Math.round(Number(matchingAttempt.quoteVersion) || 0);
  const attemptCents = Math.round(Number(matchingAttempt.amountCents) || 0);

  if (!sessionBookingId || sessionBookingId !== bookingId || attemptBookingId !== bookingId) {
    return { ok: false, error: 'booking_id_mismatch', quarantined: true };
  }
  // Session and stored attempt must bind to the same bookingVersion.
  if (!sessionBookingVersion || sessionBookingVersion !== attemptBv) {
    return { ok: false, error: 'booking_version_mismatch', quarantined: true };
  }
  // Aggregate may have advanced via unrelated CAS writers; allow forward-only drift
  // while the attempt remains open and the quote binding is unchanged.
  const attemptOpen = matchingAttempt.status === 'open' || matchingAttempt.status === 'creating';
  if (bv !== attemptBv && !(attemptOpen && bv > attemptBv)) {
    return { ok: false, error: 'booking_version_mismatch', quarantined: true };
  }
  if (!sessionQuoteVersion || sessionQuoteVersion !== qv || attemptQv !== qv) {
    return { ok: false, error: 'quote_version_mismatch', quarantined: true };
  }
  if (amountCents <= 0 || attemptCents !== amountCents) {
    return { ok: false, error: 'amount_mismatch', quarantined: true };
  }
  if (session.payment_status && session.payment_status !== 'paid') {
    return { ok: false, error: 'not_paid', quarantined: false };
  }

  const creditCents = attemptCents;
  const currentRemaining = remainingCents(norm.ledger);
  if (creditCents > currentRemaining) {
    return {
      ok: false,
      error: 'overpayment',
      quarantined: true,
      remainingCents: currentRemaining,
      creditCents,
    };
  }
  const entry = {
    entryId: `le_${crypto.randomBytes(6).toString('hex')}`,
    kind: 'settlement',
    amountCents: creditCents,
    currency: 'usd',
    providerObjectId: sessionId,
    // Session id remains the credit uniqueness key; Stripe event id is recorded for audit/idempotency.
    providerEventId: sessionId,
    stripeEventId: eventId || null,
    quoteVersion: qv,
    bookingVersion: bv,
    occurredAt: new Date().toISOString(),
    recordedAt: new Date().toISOString(),
    actor: 'stripe_checkout',
  };

  const ledger = {
    ...norm.ledger,
    settledCents: Math.max(0, Math.round(Number(norm.ledger.settledCents) || 0) + creditCents),
    lastReconciledAt: entry.recordedAt,
    entries: [...asArray(norm.ledger.entries), entry],
  };

  const nextAttempts = attempts.map((a) => (
    a.providerObjectId === sessionId ? { ...a, status: 'settled', settledAt: entry.recordedAt } : a
  ));

  const remAfter = remainingCents(ledger);
  const settled = remAfter === 0;
  const next = buildNextAggregate(norm, {
    ledger,
    paymentAttempts: nextAttempts,
    paymentWorkflowStatus: settled ? 'payment_succeeded' : 'awaiting_customer_payment',
    paymentStatus: settled ? 'paid' : (norm.paymentStatus || ''),
    // Clear payable link projections so admin/customer cannot re-open a settled Checkout.
    // Keep lastStripeCheckoutSessionId for Admin display of Stripe reference after close.
    ...(settled ? {
      payLink: '',
      stripeCheckoutSessionId: '',
      payLinkAmount: null,
      lastStripeCheckoutSessionId: sessionId,
    } : {}),
  });

  return { ok: true, duplicate: false, aggregate: next, entry, creditCents };
}

/**
 * Apply customer_balance reconciliation with CAS retries.
 * Version conflicts re-read; already-settled sessions become idempotent duplicates.
 */
async function applyCustomerBalanceReconciliation({
  bookingId,
  session,
  getBookingRecord,
  commitBooking,
  stripeEventId,
  maxAttempts = 5,
}) {
  let lastConflict = null;
  for (let i = 0; i < maxAttempts; i += 1) {
    const current = await getBookingRecord(bookingId);
    if (!current.exists) return { ok: false, error: 'not_found', statusCode: 404, retryable: true };

    const localBefore = financialProjection(current.booking);
    const reconciled = reconcileCustomerBalanceSession({
      aggregate: current.booking,
      session,
      stripeEventId,
    });
    if (reconciled.duplicate) {
      const localAfter = financialProjection(current.booking);
      logPaymentReconciliation({
        bookingId,
        stripeEventId,
        checkoutSessionId: session?.id,
        paymentIntentId: session?.payment_intent,
        localBefore,
        providerState: { payment_status: session?.payment_status || null },
        localAfter,
        adminProjection: localAfter,
      });
      return { ok: true, duplicate: true, booking: current.booking, attempts: i + 1, projection: localAfter };
    }
    if (!reconciled.ok) {
      return {
        ...reconciled,
        attempts: i + 1,
        retryable: !reconciled.quarantined && (
          reconciled.error === 'version_conflict' || reconciled.error === 'not_found'
        ),
      };
    }

    const expected = Math.round(Number(current.booking.bookingVersion) || 0);
    const committed = await commitBooking({
      bookingId,
      expectedBookingVersion: expected,
      nextAggregate: reconciled.aggregate,
    });
    if (committed.ok) {
      const localAfter = financialProjection(committed.booking);
      logPaymentReconciliation({
        bookingId,
        stripeEventId,
        checkoutSessionId: session?.id,
        paymentIntentId: session?.payment_intent,
        localBefore,
        providerState: { payment_status: session?.payment_status || null },
        localAfter,
        adminProjection: localAfter,
      });
      return {
        ok: true,
        duplicate: false,
        booking: committed.booking,
        creditCents: reconciled.creditCents,
        attempts: i + 1,
        projection: localAfter,
      };
    }
    if (committed.error === 'version_conflict' || committed.statusCode === 409) {
      lastConflict = committed;
      continue;
    }
    return { ...committed, attempts: i + 1, retryable: false };
  }
  return {
    ok: false,
    error: 'version_conflict',
    statusCode: 409,
    exhausted: true,
    retryable: true,
    lastConflict,
  };
}

/**
 * Admin/Customer recovery: if local state is unpaid but a Checkout session exists,
 * fetch Stripe and run the same idempotent reconcile as the webhook.
 */
async function reconcileOpenCheckoutFromProvider({
  booking,
  bookingId,
  getBookingRecord,
  commitBooking,
  env = process.env,
  fetchImpl = fetch,
  stripeEventId = null,
}) {
  const id = String(bookingId || booking?.id || booking?.bookingId || '').trim();
  const localBefore = financialProjection(booking);
  if (localBefore.paymentStatus === 'paid') {
    return {
      ok: true,
      skipped: true,
      reason: 'already_paid',
      booking,
      projection: localBefore,
    };
  }

  const attempts = asArray(booking?.paymentAttempts);
  const openOrAny = attempts.find((a) => a && (a.status === 'open' || a.status === 'creating'))
    || attempts.find((a) => a && a.providerObjectId);
  const sessionId = String(booking?.stripeCheckoutSessionId || openOrAny?.providerObjectId || '').trim();
  if (!sessionId || !sessionId.startsWith('cs_')) {
    return {
      ok: true,
      skipped: true,
      reason: 'no_session',
      booking,
      projection: localBefore,
    };
  }

  const guard = guardStripeOrReject(env, { purpose: 'admin_pay_reconcile' });
  if (guard.blocked) {
    return {
      ok: false,
      error: guard.body?.error || 'stripe_unavailable',
      statusCode: guard.statusCode,
      booking,
      projection: localBefore,
    };
  }

  let session;
  try {
    const res = await fetchImpl(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${guard.secret}` },
    });
    session = await res.json().catch(() => ({}));
    if (!res.ok) {
      logPaymentReconciliation({
        bookingId: id,
        stripeEventId,
        checkoutSessionId: sessionId,
        localBefore,
        providerState: { error: session?.error?.message || 'retrieve_failed', httpStatus: res.status },
        localAfter: localBefore,
        adminProjection: localBefore,
      });
      return {
        ok: false,
        error: 'stripe_retrieve_failed',
        statusCode: 502,
        retryable: true,
        booking,
        projection: localBefore,
      };
    }
  } catch (e) {
    return {
      ok: false,
      error: 'stripe_retrieve_failed',
      statusCode: 502,
      retryable: true,
      booking,
      projection: localBefore,
    };
  }

  const providerState = {
    payment_status: session.payment_status || null,
    status: session.status || null,
  };
  if (session.payment_status !== 'paid') {
    logPaymentReconciliation({
      bookingId: id,
      stripeEventId,
      checkoutSessionId: sessionId,
      paymentIntentId: session.payment_intent,
      localBefore,
      providerState,
      localAfter: localBefore,
      adminProjection: localBefore,
    });
    return {
      ok: true,
      skipped: true,
      reason: 'provider_not_paid',
      booking,
      projection: localBefore,
      providerState,
    };
  }

  const applied = await applyCustomerBalanceReconciliation({
    bookingId: id,
    session,
    getBookingRecord,
    commitBooking,
    stripeEventId,
  });
  const nextBooking = applied.booking || booking;
  const localAfter = financialProjection(nextBooking);
  logPaymentReconciliation({
    bookingId: id,
    stripeEventId,
    checkoutSessionId: sessionId,
    paymentIntentId: session.payment_intent,
    localBefore,
    providerState,
    localAfter,
    adminProjection: localAfter,
  });
  return {
    ...applied,
    skipped: false,
    booking: nextBooking,
    projection: localAfter,
    providerState,
  };
}

/**
 * Prepare Checkout amount — rejects client amount overrides.
 */
function prepareBalanceCheckout(aggregate, body = {}, env = process.env) {
  const stripeGuard = guardStripeOrReject(env, { purpose: 'customer_balance_checkout' });
  if (stripeGuard.blocked) {
    return { ok: false, error: stripeGuard.body.error, statusCode: stripeGuard.statusCode, networkCalls: 0 };
  }

  if (body.amount != null || body.amountCents != null || body.due != null) {
    // Explicit reject of operator/client override — ignore and derive server-side
  }

  const gate = canCreatePayment(aggregate, {
    expectedBookingVersion: body.expectedBookingVersion,
    expectedQuoteVersion: body.expectedQuoteVersion,
  });
  if (!gate.ok) return { ...gate, networkCalls: 0 };

  const idempotencyKey = [
    'cb',
    gate.aggregate.id || gate.aggregate.bookingId,
    gate.bookingVersion,
    gate.quoteVersion,
    gate.remainingCents,
  ].join('_');

  return {
    ok: true,
    amountCents: gate.remainingCents,
    currency: 'usd',
    bookingVersion: gate.bookingVersion,
    quoteVersion: gate.quoteVersion,
    idempotencyKey,
    stripeMode: stripeGuard.mode,
    secret: stripeGuard.secret,
    networkCalls: 0,
  };
}

module.exports = {
  moneyConflict,
  canCreatePayment,
  buildPaymentAttempt,
  supersedeOpenAttempts,
  expireStripeCheckoutSessions,
  expireSupersededAttempts,
  reconcileCustomerBalanceSession,
  applyCustomerBalanceReconciliation,
  reconcileOpenCheckoutFromProvider,
  financialProjection,
  logPaymentReconciliation,
  prepareBalanceCheckout,
  remainingCents,
  centsToDollars,
  dollarsToCents,
};
