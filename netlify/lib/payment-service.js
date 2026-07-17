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
  if (norm.amountDueApproved != null || norm.balanceDue != null) {
    const storedDueCents = dollarsToCents(
      norm.amountDueApproved != null ? norm.amountDueApproved : norm.balanceDue
    );
    if (ledger.approvedCents === 0 && storedDueCents > 0 && !norm._historicalPaidClosed) {
      // allow bootstrap
    }
  }
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

function supersedeOpenAttempts(attempts, { quoteVersion }) {
  return asArray(attempts).map((a) => {
    if (a.status === 'open' || a.status === 'creating') {
      if (Math.round(Number(a.quoteVersion) || 0) !== Math.round(Number(quoteVersion) || 0)) {
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
 * Pure reconciliation for customer_balance Checkout completion.
 * Requires a matching stored payment attempt with exact booking/version/currency/amount/object binding.
 */
function reconcileCustomerBalanceSession({
  aggregate,
  session,
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

  const already = asArray(norm.ledger.entries).some(
    (e) => e.providerObjectId === sessionId || e.providerEventId === sessionId
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
  const entry = {
    entryId: `le_${crypto.randomBytes(6).toString('hex')}`,
    kind: 'settlement',
    amountCents: creditCents,
    currency: 'usd',
    providerObjectId: sessionId,
    providerEventId: sessionId,
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

  const next = buildNextAggregate(norm, {
    ledger,
    paymentAttempts: nextAttempts,
    paymentWorkflowStatus: remainingCents(ledger) === 0 ? 'payment_succeeded' : 'awaiting_customer_payment',
    paymentStatus: remainingCents(ledger) === 0 ? 'paid' : (norm.paymentStatus || ''),
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
  maxAttempts = 5,
}) {
  let lastConflict = null;
  for (let i = 0; i < maxAttempts; i += 1) {
    const current = await getBookingRecord(bookingId);
    if (!current.exists) return { ok: false, error: 'not_found', statusCode: 404 };

    const reconciled = reconcileCustomerBalanceSession({
      aggregate: current.booking,
      session,
    });
    if (reconciled.duplicate) {
      return { ok: true, duplicate: true, booking: current.booking, attempts: i + 1 };
    }
    if (!reconciled.ok) {
      return { ...reconciled, attempts: i + 1 };
    }

    const expected = Math.round(Number(current.booking.bookingVersion) || 0);
    const committed = await commitBooking({
      bookingId,
      expectedBookingVersion: expected,
      nextAggregate: reconciled.aggregate,
    });
    if (committed.ok) {
      return {
        ok: true,
        duplicate: false,
        booking: committed.booking,
        creditCents: reconciled.creditCents,
        attempts: i + 1,
      };
    }
    if (committed.error === 'version_conflict' || committed.statusCode === 409) {
      lastConflict = committed;
      continue;
    }
    return { ...committed, attempts: i + 1 };
  }
  return {
    ok: false,
    error: 'version_conflict',
    statusCode: 409,
    exhausted: true,
    lastConflict,
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
  prepareBalanceCheckout,
  remainingCents,
  centsToDollars,
  dollarsToCents,
};
