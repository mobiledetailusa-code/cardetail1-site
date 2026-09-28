'use strict';

/**
 * Ceramic checkout money.
 *
 * approvedFinalAmount, amountPaid, and balanceDue are derived from the
 * booking ledger. depositAmount is the greater of 25% of the approved total
 * and the package minimum, calculated on the server. It is not a second copy
 * of amount paid. Saving a card does not charge this balance. An explicit
 * admin completion may charge the unpaid approved balance later.
 *
 * Invariant: approvedFinalAmount = amountPaid + balanceDue
 * (dollar amounts rounded to cents).
 *
 * A captured Stripe amount is stored as an immutable ledger entry keyed by
 * providerEventId. Replays do not add a second entry, a second deposit, or
 * a second balance collection.
 *
 * This module never charges a saved card off-session. Balance collection is
 * an explicit, customer-authorized or admin-recorded settlement for the
 * exact remaining balance, once.
 */

const { depositCentsForApproved, depositsEnabled, packageDef } = require('./ceramic-coating');

function dollarsToCents(value) {
  return Math.round((Number(value) || 0) * 100);
}

function centsToDollars(cents) {
  return Math.round(Number(cents) || 0) / 100;
}

function ledgerOf(booking) {
  const ledger = booking.ledger && typeof booking.ledger === 'object' ? booking.ledger : {};
  const entries = Array.isArray(ledger.entries) ? ledger.entries.slice() : [];
  const approvedCents = Math.max(
    0,
    Math.round(Number(ledger.approvedCents) || dollarsToCents(
      booking.approvedFinalAmount != null ? booking.approvedFinalAmount : booking.totalPrice
    ))
  );
  const settledFromEntries = entries
    .filter((e) => e && e.kind === 'settlement')
    .reduce((sum, e) => sum + Math.max(0, Math.round(Number(e.amountCents) || 0)), 0);
  const settledCents = entries.length
    ? settledFromEntries
    : Math.max(0, Math.round(Number(ledger.settledCents) || dollarsToCents(booking.amountPaid || 0)));
  return {
    currency: 'usd',
    approvedCents,
    settledCents,
    entries,
  };
}

function projectPayment(booking) {
  const ledger = ledgerOf(booking);
  const approvedCents = ledger.approvedCents;
  const amountPaidCents = ledger.settledCents;
  const balanceDueCents = approvedCents - amountPaidCents;
  if (balanceDueCents < 0) {
    return { ok: false, error: 'ceramic_overpayment', approvedCents, amountPaidCents };
  }
  if (approvedCents !== amountPaidCents + balanceDueCents) {
    return { ok: false, error: 'ceramic_invariant_broken' };
  }
  const plan = String(booking.ceramicPaymentPlan || booking.ceramic?.paymentPlan || '').trim();
  const depositAmount = plan === 'deposit'
    ? Number(booking.depositAmount || booking.ceramic?.depositAmount || 0)
    : 0;
  let paymentStatus = 'unpaid';
  if (amountPaidCents > 0 && balanceDueCents === 0) paymentStatus = 'paid';
  else if (amountPaidCents > 0 && balanceDueCents > 0) paymentStatus = 'partially_paid';
  return {
    ok: true,
    approvedFinalAmount: centsToDollars(approvedCents),
    amountPaid: centsToDollars(amountPaidCents),
    depositAmount: Math.round(depositAmount * 100) / 100,
    balanceDue: centsToDollars(balanceDueCents),
    paymentStatus,
    approvedCents,
    amountPaidCents,
    balanceDueCents,
    ledger,
  };
}

function applyProjection(booking, projection) {
  booking.ledger = {
    currency: 'usd',
    approvedCents: projection.approvedCents,
    settledCents: projection.amountPaidCents,
    creditedCents: Math.max(0, Math.round(Number(booking.ledger?.creditedCents) || 0)),
    pendingCents: 0,
    entries: projection.ledger.entries,
    lastReconciledAt: new Date().toISOString(),
  };
  booking.approvedFinalAmount = projection.approvedFinalAmount;
  booking.totalPrice = projection.approvedFinalAmount;
  booking.amountPaid = projection.amountPaid;
  booking.paidAmount = projection.amountPaid;
  booking.balanceDue = projection.balanceDue;
  booking.amountDueApproved = projection.balanceDue;
  booking.paymentStatus = projection.paymentStatus;
  booking.paymentWorkflowStatus = projection.paymentStatus === 'paid'
    ? 'payment_succeeded'
    : (projection.paymentStatus === 'partially_paid' ? 'partially_paid' : 'awaiting_customer_payment');
  return booking;
}

function ensureApproved(booking) {
  const ledger = ledgerOf(booking);
  if (!(ledger.approvedCents > 0)) {
    ledger.approvedCents = dollarsToCents(booking.approvedFinalAmount || booking.totalPrice);
  }
  booking.ledger = {
    ...(booking.ledger || {}),
    currency: 'usd',
    approvedCents: ledger.approvedCents,
    settledCents: ledger.settledCents,
    entries: ledger.entries,
  };
  return ledger;
}

/**
 * Amount the server will ask Stripe to collect for this ceramic booking.
 * Client-supplied amounts are ignored.
 */
function chargeDueNow(booking, env = process.env) {
  if (booking?.serviceFamily !== 'ceramic_coating') {
    return { ok: false, error: 'not_ceramic_booking' };
  }
  const projection = projectPayment(booking);
  if (!projection.ok) return projection;
  const plan = String(booking.ceramicPaymentPlan || '').trim();
  const pkgId = booking.ceramic?.packages?.[0]?.packageId
    || booking.vehicles?.[0]?.pkgId
    || booking.packageId;
  if (plan === 'prepay_full') {
    if (!(projection.balanceDueCents > 0)) return { ok: false, error: 'zero_balance', projection };
    return {
      ok: true,
      purpose: 'ceramic_checkout',
      chargeCents: projection.balanceDueCents,
      projection,
    };
  }
  if (plan === 'deposit') {
    if (!depositsEnabled(env)) return { ok: false, error: 'ceramic_deposit_disabled' };
    const expected = depositCentsForApproved(pkgId, projection.approvedFinalAmount);
    if (!(expected > 0) || expected !== dollarsToCents(booking.depositAmount)) {
      return { ok: false, error: 'ceramic_deposit_invalid' };
    }
    if (projection.amountPaidCents > 0) {
      return { ok: false, error: 'ceramic_deposit_already_collected', projection };
    }
    if (expected >= projection.approvedCents) return { ok: false, error: 'ceramic_deposit_invalid' };
    return {
      ok: true,
      purpose: 'ceramic_checkout',
      chargeCents: expected,
      projection,
    };
  }
  return { ok: false, error: 'ceramic_payment_plan_required' };
}

function hasPurposeSettlement(entries, purpose) {
  return entries.some((e) => e && e.kind === 'settlement' && e.purpose === purpose);
}

/**
 * Append one immutable settlement. Duplicate providerEventId is a no-op.
 * A second deposit or a second balance collection is rejected.
 */
function appendSettlement(booking, {
  providerEventId,
  amountCents,
  purpose,
  method = 'card',
  providerObjectId = null,
} = {}) {
  const eventId = String(providerEventId || '').trim();
  const cents = Math.round(Number(amountCents) || 0);
  const why = String(purpose || '').trim();
  if (!eventId) return { ok: false, error: 'missing_provider_event' };
  if (!(cents > 0)) return { ok: false, error: 'invalid_amount' };
  if (why !== 'ceramic_checkout' && why !== 'ceramic_balance') {
    return { ok: false, error: 'invalid_settlement_purpose' };
  }
  ensureApproved(booking);
  const before = projectPayment(booking);
  if (!before.ok) return before;
  if (before.ledger.entries.some((e) => e && e.providerEventId === eventId)) {
    const replay = projectPayment(booking);
    applyProjection(booking, replay);
    return { ok: true, duplicate: true, booking, projection: replay };
  }
  if (why === 'ceramic_checkout' && hasPurposeSettlement(before.ledger.entries, 'ceramic_checkout')) {
    return { ok: false, error: 'ceramic_deposit_already_collected', projection: before };
  }
  if (why === 'ceramic_balance' && hasPurposeSettlement(before.ledger.entries, 'ceramic_balance')) {
    return { ok: false, error: 'ceramic_balance_already_collected', projection: before };
  }
  if (cents > before.balanceDueCents) {
    return { ok: false, error: 'ceramic_amount_exceeds_balance', projection: before };
  }
  if (why === 'ceramic_balance' && cents !== before.balanceDueCents) {
    return { ok: false, error: 'ceramic_balance_mismatch', expectedCents: before.balanceDueCents, projection: before };
  }
  if (why === 'ceramic_checkout') {
    const due = chargeDueNow(booking);
    if (!due.ok) return due;
    if (cents !== due.chargeCents) {
      return { ok: false, error: 'ceramic_charge_mismatch', expectedCents: due.chargeCents };
    }
  }
  before.ledger.entries.push({
    kind: 'settlement',
    amountCents: cents,
    purpose: why,
    method,
    providerEventId: eventId,
    providerObjectId: providerObjectId || null,
    occurredAt: new Date().toISOString(),
    immutable: true,
  });
  booking.ledger.entries = before.ledger.entries;
  booking.ledger.settledCents = before.amountPaidCents + cents;
  const projection = projectPayment(booking);
  if (!projection.ok) return projection;
  applyProjection(booking, projection);
  return { ok: true, duplicate: false, booking, projection };
}

/**
 * Admin / Quick Ops records the remaining ceramic balance exactly once.
 * Amount must equal balanceDue. A repeat with the same or a new event id
 * does not collect twice.
 */
function collectBalanceOnce(booking, {
  providerEventId,
  amountCents = null,
  method = 'card',
} = {}) {
  if (booking?.serviceFamily !== 'ceramic_coating') {
    return { ok: false, error: 'not_ceramic_booking' };
  }
  const projection = projectPayment(booking);
  if (!projection.ok) return projection;
  const eventId = String(providerEventId || '').trim();
  if (eventId && projection.ledger.entries.some((entry) => entry && entry.providerEventId === eventId)) {
    return { ok: true, duplicate: true, booking, projection };
  }
  if (hasPurposeSettlement(projection.ledger.entries, 'ceramic_balance')) {
    return { ok: false, error: 'ceramic_balance_already_collected', projection };
  }
  if (projection.paymentStatus !== 'partially_paid' || !(projection.balanceDueCents > 0)) {
    return { ok: false, error: 'ceramic_balance_not_due', projection };
  }
  const cents = amountCents == null ? projection.balanceDueCents : Math.round(Number(amountCents) || 0);
  return appendSettlement(booking, {
    providerEventId: eventId || `ceramic_balance:${booking.id}:${projection.approvedCents}:${projection.balanceDueCents}`,
    amountCents: cents,
    purpose: 'ceramic_balance',
    method,
  });
}

const CERAMIC_PURPOSES = new Set(['ceramic_checkout', 'ceramic_balance']);

/**
 * Apply a confirmed Stripe PaymentIntent. Redirect query params are not a
 * success signal — callers pass the PaymentIntent object from Stripe.
 * Failed or processing intents do not settle the ledger.
 */
function applyStripePaymentIntent(booking, paymentIntent, { stripeEventId = null } = {}) {
  if (!paymentIntent || typeof paymentIntent !== 'object') {
    return { ok: false, error: 'missing_payment_intent' };
  }
  const purpose = String(paymentIntent.metadata?.purpose || '').trim();
  if (!CERAMIC_PURPOSES.has(purpose)) {
    return { ok: false, error: 'non_ceramic_purpose', purpose };
  }
  const bookingId = String(paymentIntent.metadata?.bookingId || paymentIntent.metadata?.booking_id || '').trim();
  const localId = String(booking?.id || booking?.bookingId || '').trim();
  if (!bookingId || bookingId !== localId) {
    return { ok: false, error: 'payment_booking_mismatch' };
  }
  if (paymentIntent.status !== 'succeeded') {
    return {
      ok: true,
      settled: false,
      paymentStatus: booking.paymentStatus || 'unpaid',
      reason: 'payment_not_succeeded',
    };
  }
  const amountCents = Math.round(Number(
    paymentIntent.amount_received != null ? paymentIntent.amount_received : paymentIntent.amount
  ) || 0);
  const providerEventId = stripeEventId
    ? `settlement_${paymentIntent.id}_${stripeEventId}`
    : `settlement_${paymentIntent.id}`;
  // Stripe retries the same PaymentIntent. The ledger key is the PI id, not
  // the webhook event id, so a second event cannot settle the same capture.
  const result = appendSettlement(booking, {
    providerEventId: `settlement_${paymentIntent.id}`,
    amountCents,
    purpose,
    method: 'card',
    providerObjectId: paymentIntent.id,
  });
  if (!result.ok) return result;
  booking.paymentMethod = 'card';
  booking.stripePaymentIntentId = paymentIntent.id;
  return { ...result, settled: true, providerEventId };
}

function conversionEvidence(booking) {
  const projection = projectPayment(booking);
  if (!projection.ok) return { ok: false, error: projection.error };
  const succeeded = projection.paymentStatus === 'paid' || projection.paymentStatus === 'partially_paid';
  return {
    ok: succeeded,
    bookingCreated: !booking.isDraft,
    isDraft: booking.isDraft === true,
    serviceFamily: 'ceramic_coating',
    paymentSucceeded: succeeded,
    id: booking.id || booking.bookingId || null,
    transaction_id: booking.id || booking.bookingId || null,
    approvedFinalAmount: projection.approvedFinalAmount,
    amountPaid: projection.amountPaid,
    currency: 'USD',
  };
}

function packageDepositCents(packageId) {
  const pkg = packageDef(packageId);
  return pkg ? pkg.depositDollars * 100 : 0;
}

/**
 * Exact remaining balance, once, after a deposit has already settled.
 * This is an on-session charge. It does not confirm or reuse a saved card.
 */
function chargeBalanceDue(booking) {
  if (booking?.serviceFamily !== 'ceramic_coating') {
    return { ok: false, error: 'not_ceramic_booking' };
  }
  const projection = projectPayment(booking);
  if (!projection.ok) return projection;
  if (projection.paymentStatus !== 'partially_paid' || !(projection.balanceDueCents > 0)) {
    return { ok: false, error: 'ceramic_balance_not_due', projection };
  }
  return {
    ok: true,
    purpose: 'ceramic_balance',
    chargeCents: projection.balanceDueCents,
    projection,
  };
}

/**
 * Server-owned PaymentIntent description. Client amounts are ignored.
 * offSession and confirm stay false — the customer authorizes this charge
 * in the existing on-session Payment Element. The remainder is never charged
 * off-session.
 */
function ceramicIntentSpec(booking, { quoteVersion, generation = 1, phase = 'checkout' } = {}) {
  const bookingId = String(booking?.id || booking?.bookingId || '').trim();
  if (!bookingId) return { ok: false, error: 'missing_booking_id' };
  const qv = Math.round(Number(quoteVersion) || 0);
  if (!(qv > 0)) return { ok: false, error: 'stale_quote_version' };
  const due = phase === 'balance' ? chargeBalanceDue(booking) : chargeDueNow(booking);
  if (!due.ok) return due;
  const gen = Math.max(1, Math.round(Number(generation) || 1));
  const idempotencyKey = ['pi', due.purpose, bookingId, qv, due.chargeCents, gen].join('_');
  return {
    ok: true,
    bookingId,
    quoteVersion: qv,
    generation: gen,
    phase: phase === 'balance' ? 'balance' : 'checkout',
    purpose: due.purpose,
    amountCents: due.chargeCents,
    approvedCents: due.projection.approvedCents,
    balanceDueCents: due.projection.balanceDueCents,
    amountPaidCents: due.projection.amountPaidCents,
    idempotencyKey,
    offSession: false,
    confirm: false,
    metadata: {
      bookingId,
      booking_id: bookingId,
      quoteVersion: String(qv),
      purpose: due.purpose,
    },
  };
}

function stripePaymentIntentForm(spec, stripeCustomerId = null) {
  const body = new URLSearchParams({
    amount: String(spec.amountCents),
    currency: 'usd',
    'automatic_payment_methods[enabled]': 'true',
    'metadata[bookingId]': spec.metadata.bookingId,
    'metadata[booking_id]': spec.metadata.bookingId,
    'metadata[quoteVersion]': spec.metadata.quoteVersion,
    'metadata[purpose]': spec.metadata.purpose,
  });
  if (stripeCustomerId) body.set('customer', stripeCustomerId);
  return body;
}

module.exports = {
  CERAMIC_PURPOSES,
  dollarsToCents,
  centsToDollars,
  projectPayment,
  chargeDueNow,
  chargeBalanceDue,
  ceramicIntentSpec,
  stripePaymentIntentForm,
  appendSettlement,
  collectBalanceOnce,
  applyStripePaymentIntent,
  conversionEvidence,
  packageDepositCents,
};
