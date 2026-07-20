/**
 * Operational payment facade — Admin / My Garage / webhook recovery share
 * one Postgres FinancialProjection + PaymentAuthorityService path.
 *
 * Blobs keep operational booking fields; money projection authority is
 * Postgres after ensureBookingFinancial. When DATABASE_URL is unset,
 * callers should fall back to Blob payment-service (compatibility).
 */

const { prismaConfigured } = require('../prisma');
const { ensureBookingFinancial } = require('./ensure-booking-financial');
const authority = require('./payment-authority-service');
const { getBookingRecord, commitBooking } = require('../booking-repository');
const { buildNextAggregate, normalizeAggregate } = require('../booking-aggregate');

function postgresPaymentEnabled(env = process.env) {
  if (env.CD1_POSTGRES_PAYMENT === '0' || env.CD1_POSTGRES_PAYMENT === 'false') return false;
  return prismaConfigured();
}

function mapProjectionForPortals(projection) {
  if (!projection) return null;
  return {
    bookingId: projection.bookingId,
    quoteVersion: projection.quoteVersion,
    approvedCents: projection.approvedCents,
    settledCents: projection.settledCents,
    refundedCents: projection.refundedCents,
    remainingCents: projection.remainingCents,
    paymentStatus: projection.paymentStatus,
    paymentAttemptStatus: projection.paymentAttemptStatus,
    stripeReference: projection.stripeReference,
    paidAt: projection.paidAt,
    refundableCents: projection.refundableCents,
    authority: 'postgres',
  };
}

/**
 * Sync Blob compatibility money fields from Postgres projection so legacy
 * readers do not contradict portals. Does not invent ledger credits.
 */
async function syncBlobCompatibilityFromProjection(bookingId, projection) {
  if (!projection || !bookingId) return { ok: false, error: 'missing' };
  const rec = await getBookingRecord(bookingId);
  if (!rec.exists || !rec.booking) return { ok: false, error: 'blob_not_found' };
  const { ok: normOk, aggregate } = normalizeAggregate(rec.booking);
  const base = normOk ? aggregate : rec.booking;
  const ledger = { ...(base.ledger || {}) };
  ledger.approvedCents = projection.approvedCents;
  ledger.settledCents = projection.settledCents;
  ledger.refundedCents = projection.refundedCents || 0;
  ledger.currency = ledger.currency || 'usd';

  const dollarsApproved = projection.approvedCents / 100;
  const dollarsSettled = projection.settledCents / 100;
  const dollarsRemaining = projection.remainingCents / 100;

  const patch = {
    ledger,
    quoteVersion: projection.quoteVersion,
    amountDueApproved: dollarsRemaining,
    balanceDue: dollarsRemaining,
    totalPrice: dollarsApproved,
    amountPaid: dollarsSettled,
    paidAmount: dollarsSettled,
    approvedFinalAmount: dollarsApproved,
    paymentStatus: projection.paymentStatus === 'paid'
      ? 'paid'
      : projection.paymentStatus === 'processing'
        ? 'processing'
        : projection.paymentStatus === 'refunded'
          ? 'refunded'
          : projection.paymentStatus === 'due'
            ? 'due'
            : (base.paymentStatus || 'no_payment_required_yet'),
    paymentWorkflowStatus: projection.paymentStatus === 'paid'
      ? (String(base.paymentWorkflowStatus || '').toLowerCase() === 'cash_paid'
        ? 'cash_paid'
        : 'payment_succeeded')
      : projection.paymentStatus === 'processing'
        ? 'awaiting_customer_payment'
        : projection.paymentStatus === 'due'
          ? 'awaiting_customer_payment'
          : (base.paymentWorkflowStatus || null),
    paymentIntentId: projection.stripeReference || base.paymentIntentId || null,
  };

  // Open remaining after quote adjustment must not keep historical Paid markers
  // (adaptHistoricalBooking would clamp settledCents up to approvedCents).
  if (projection.paymentStatus === 'due' || projection.remainingCents > 0) {
    patch._historicalPaidClosed = false;
    if (String(base.status || '') === 'Paid' || String(base.status || '') === 'Closed') {
      patch.status = 'Confirmed';
    }
    if (String(base.jobStatus || '').toLowerCase() === 'completed_paid') {
      patch.jobStatus = 'confirmed';
    }
  }
  if (projection.paymentStatus === 'paid' && projection.paidAt) {
    patch.capturedAt = typeof projection.paidAt === 'string'
      ? projection.paidAt
      : new Date(projection.paidAt).toISOString();
  }

  const next = buildNextAggregate(base, patch);
  const committed = await commitBooking({
    bookingId,
    expectedBookingVersion: base.bookingVersion || 0,
    nextAggregate: next,
  });
  if (!committed.ok && committed.error === 'version_conflict') {
    // One retry on race
    const again = await getBookingRecord(bookingId);
    if (!again.exists) return committed;
    const { ok: ok2, aggregate: agg2 } = normalizeAggregate(again.booking);
    const base2 = ok2 ? agg2 : again.booking;
    const next2 = buildNextAggregate(base2, patch);
    return commitBooking({
      bookingId,
      expectedBookingVersion: base2.bookingVersion || 0,
      nextAggregate: next2,
    });
  }
  return committed;
}

async function getSharedFinancialProjection(booking, { reconcileUncertain = false, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (!postgresPaymentEnabled(env)) {
    return { ok: false, error: 'postgres_payment_disabled', authority: 'blob' };
  }
  const ensured = await ensureBookingFinancial(booking);
  if (!ensured.ok) return { ok: false, error: ensured.error, authority: 'blob' };

  let projection = await authority.getFinancialProjection(ensured.bookingId);
  if (!projection) return { ok: false, error: 'projection_unavailable', authority: 'blob' };

  const uncertain = projection.paymentStatus === 'processing'
    || (projection.remainingCents > 0 && !!projection.stripeReference);

  if (reconcileUncertain && uncertain) {
    const reconciled = await authority.reconcileFromStripeProvider({
      bookingId: ensured.bookingId,
      env,
      fetchImpl,
    });
    if (reconciled.ok && reconciled.projection) {
      projection = reconciled.projection;
      await syncBlobCompatibilityFromProjection(ensured.bookingId, projection).catch(() => {});
    }
  }

  return {
    ok: true,
    authority: 'postgres',
    projection: mapProjectionForPortals(projection),
    bookingId: ensured.bookingId,
  };
}

async function prepareEmbeddedPayment({
  booking,
  expectedQuoteVersion = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
}) {
  if (!postgresPaymentEnabled(env)) {
    return { ok: false, error: 'postgres_payment_disabled', statusCode: 503 };
  }
  const ensured = await ensureBookingFinancial(booking);
  if (!ensured.ok) return { ok: false, error: ensured.error, statusCode: 503 };

  // Reconcile before create (mandate D)
  await authority.reconcileFromStripeProvider({
    bookingId: ensured.bookingId,
    env,
    fetchImpl,
  }).catch(() => {});

  let projection = await authority.getFinancialProjection(ensured.bookingId);
  if (!projection) return { ok: false, error: 'not_found', statusCode: 404 };
  if (projection.paymentStatus === 'paid') {
    return { ok: false, error: 'already_paid', statusCode: 409, projection: mapProjectionForPortals(projection) };
  }
  if (!(projection.remainingCents > 0)) {
    return { ok: false, error: 'zero_balance', statusCode: 409, projection: mapProjectionForPortals(projection) };
  }

  const quoteVersion = expectedQuoteVersion != null
    ? Math.round(Number(expectedQuoteVersion) || 0)
    : projection.quoteVersion;
  if (quoteVersion !== projection.quoteVersion) {
    return {
      ok: false,
      error: 'stale_quote_version',
      statusCode: 409,
      projection: mapProjectionForPortals(projection),
    };
  }

  const stripeCustomerId = booking.stripeCustomerId || null;
  const created = await authority.reserveAndCreatePaymentIntent({
    bookingId: ensured.bookingId,
    quoteVersion,
    stripeCustomerId,
    env,
    fetchImpl,
  });
  if (!created.ok) {
    return {
      ok: false,
      error: created.error,
      statusCode: created.statusCode || 500,
      projection: mapProjectionForPortals(created.projection || projection),
    };
  }

  let clientSecret = created.clientSecret || null;
  const piId = created.stripePaymentIntentId || created.paymentAttempt?.providerObjectId;
  if (!clientSecret && piId) {
    const retrieved = await authority.retrievePaymentIntentClientSecret({
      paymentIntentId: piId,
      env,
      fetchImpl,
    });
    if (retrieved.ok) clientSecret = retrieved.clientSecret;
  }
  if (!clientSecret) {
    return { ok: false, error: 'missing_client_secret', statusCode: 502 };
  }

  let customerSessionClientSecret = null;
  if (stripeCustomerId) {
    const cs = await authority.createCustomerSession({
      stripeCustomerId,
      env,
      fetchImpl,
    });
    if (cs.ok) customerSessionClientSecret = cs.customerSessionClientSecret;
  }

  projection = created.projection || await authority.getFinancialProjection(ensured.bookingId);

  return {
    ok: true,
    mode: 'payment_element',
    clientSecret,
    customerSessionClientSecret,
    paymentIntentId: piId,
    amountCents: projection.remainingCents,
    quoteVersion: projection.quoteVersion,
    bookingVersion: booking.bookingVersion || 0,
    projection: mapProjectionForPortals(projection),
    created: !!created.created,
    recoveredFromTimeout: !!created.recoveredFromTimeout,
  };
}

async function adminReconcileWithStripe({
  booking,
  env = process.env,
  fetchImpl = globalThis.fetch,
}) {
  if (!postgresPaymentEnabled(env)) {
    return { ok: false, error: 'postgres_payment_disabled', statusCode: 503 };
  }
  const ensured = await ensureBookingFinancial(booking);
  if (!ensured.ok) return { ok: false, error: ensured.error, statusCode: 503 };

  const result = await authority.reconcileFromStripeProvider({
    bookingId: ensured.bookingId,
    env,
    fetchImpl,
  });
  if (result.ok && result.projection) {
    await syncBlobCompatibilityFromProjection(ensured.bookingId, result.projection).catch(() => {});
  }
  return {
    ...result,
    projection: mapProjectionForPortals(result.projection),
  };
}

/**
 * Status-only cash close after Postgres money authority has already settled.
 * Does not invent Blob ledger settlement entries.
 */
async function applyCashOperationalClose({
  bookingId,
  cashAmountCents,
  reference = null,
}) {
  const rec = await getBookingRecord(bookingId);
  if (!rec.exists || !rec.booking) return { ok: false, error: 'blob_not_found' };

  const now = new Date().toISOString();
  const amountDollars = Math.max(0, Math.round(Number(cashAmountCents) || 0)) / 100;
  const base = rec.booking;
  const next = buildNextAggregate(base, {
    paymentStatus: 'paid_cash',
    paymentWorkflowStatus: 'cash_paid',
    jobStatus: 'completed_paid',
    serviceStatus: 'closed',
    cashReceivedAt: base.cashReceivedAt || now,
    cashReceivedAmount: amountDollars,
    cashReceivedReference: reference || base.cashReceivedReference || null,
    updatedAt: now,
  });

  const committed = await commitBooking({
    bookingId,
    expectedBookingVersion: Math.round(Number(base.bookingVersion) || 0),
    nextAggregate: next,
  });
  if (!committed.ok && committed.error === 'version_conflict') {
    const again = await getBookingRecord(bookingId);
    if (!again.exists || !again.booking) return committed;
    const next2 = buildNextAggregate(again.booking, {
      paymentStatus: 'paid_cash',
      paymentWorkflowStatus: 'cash_paid',
      jobStatus: 'completed_paid',
      serviceStatus: 'closed',
      cashReceivedAt: again.booking.cashReceivedAt || now,
      cashReceivedAmount: amountDollars,
      cashReceivedReference: reference || again.booking.cashReceivedReference || null,
      updatedAt: now,
    });
    return commitBooking({
      bookingId,
      expectedBookingVersion: Math.round(Number(again.booking.bookingVersion) || 0),
      nextAggregate: next2,
    });
  }
  return committed;
}

function blobNeedsCashClose(booking) {
  if (!booking) return true;
  const { financialProjection } = require('../payment-service');
  const fp = financialProjection(booking);
  if (fp.remainingCents > 0) return true;
  const pay = String(booking.paymentStatus || '').toLowerCase();
  const pwf = String(booking.paymentWorkflowStatus || '').toLowerCase();
  const job = String(booking.jobStatus || '').toLowerCase();
  const svc = String(booking.serviceStatus || '').toLowerCase();
  if (pay !== 'paid_cash' && pay !== 'paid') return true;
  if (pwf !== 'cash_paid' && pwf !== 'payment_succeeded') return true;
  if (job !== 'completed_paid') return true;
  if (svc !== 'closed') return true;
  return false;
}

/**
 * Admin full-balance cash when PostgreSQL payment authority is enabled.
 * Money settles only in Postgres; Blob is compatibility + operational status.
 */
async function settleAdminCashFullBalance({
  booking,
  body = {},
  env = process.env,
  syncBlob = syncBlobCompatibilityFromProjection,
} = {}) {
  if (!postgresPaymentEnabled(env)) {
    return { ok: false, error: 'postgres_payment_disabled', statusCode: 503 };
  }

  const ensured = await ensureBookingFinancial(booking);
  if (!ensured.ok) {
    return { ok: false, error: ensured.error || 'ensure_failed', statusCode: 503 };
  }

  const bookingId = ensured.bookingId;
  const beforeBlobRec = await getBookingRecord(bookingId);
  const needsCloseBefore = blobNeedsCashClose(beforeBlobRec.booking);

  const settled = await authority.recordFullBalanceCashSettlement({
    bookingId,
    body,
  });

  if (!settled.ok) {
    return {
      ok: false,
      error: settled.error || 'cash_settlement_failed',
      statusCode: settled.statusCode || 400,
      authority: 'postgres',
      expectedAmountCents: settled.expectedAmountCents,
      receivedAmountCents: settled.receivedAmountCents,
      reason: settled.reason,
      field: settled.field,
      postgresProjection: mapProjectionForPortals(settled.projection),
      projection: mapProjectionForPortals(settled.projection),
      quoteVersion: settled.projection?.quoteVersion,
    };
  }

  const pgMapped = mapProjectionForPortals(settled.projection);
  const cashCents = Math.max(
    0,
    Math.round(Number(settled.settledAmountCents != null
      ? settled.settledAmountCents
      : settled.entry?.amountCents) || 0)
  );

  const syncResult = await syncBlob(bookingId, settled.projection);
  if (!syncResult || syncResult.ok === false) {
    return {
      ok: false,
      error: 'blob_sync_failed',
      statusCode: 503,
      authority: 'postgres',
      postgresProjection: pgMapped,
      projection: pgMapped,
      settledAmountCents: cashCents,
      settlementRecorded: true,
      created: !!settled.created,
      noop: !!(settled.noop || settled.duplicate),
      syncError: syncResult?.error || 'blob_sync_failed',
      quoteVersion: settled.projection.quoteVersion,
    };
  }

  const closed = await applyCashOperationalClose({
    bookingId,
    cashAmountCents: cashCents,
    reference: body.reference,
  });
  if (!closed.ok) {
    return {
      ok: false,
      error: 'blob_status_close_failed',
      statusCode: 503,
      authority: 'postgres',
      postgresProjection: pgMapped,
      projection: pgMapped,
      settledAmountCents: cashCents,
      settlementRecorded: true,
      syncOk: true,
      created: !!settled.created,
      noop: !!(settled.noop || settled.duplicate),
      statusError: closed.error || 'blob_status_close_failed',
      quoteVersion: settled.projection.quoteVersion,
    };
  }

  const { financialProjection } = require('../payment-service');
  const compat = financialProjection(closed.booking);
  const noop = !!(settled.noop || settled.duplicate || !settled.created);

  // Fully synchronized replay → already_paid (Blob fallback contract).
  if (noop && !needsCloseBefore && !blobNeedsCashClose(closed.booking)) {
    return {
      ok: false,
      error: 'already_paid',
      statusCode: 409,
      authority: 'postgres',
      noop: true,
      postgresProjection: pgMapped,
      projection: pgMapped,
      financialProjection: compat,
      settledAmountCents: cashCents,
      paymentStatus: closed.booking.paymentStatus,
      jobStatus: closed.booking.jobStatus,
      serviceStatus: closed.booking.serviceStatus,
      bookingVersion: closed.bookingVersion,
      quoteVersion: settled.projection.quoteVersion,
      booking: closed.booking,
    };
  }

  return {
    ok: true,
    authority: 'postgres',
    bookingId,
    postgresProjection: pgMapped,
    projection: pgMapped,
    financialProjection: compat,
    settledAmountCents: cashCents,
    created: !!settled.created,
    noop,
    paymentStatus: closed.booking.paymentStatus,
    jobStatus: closed.booking.jobStatus,
    serviceStatus: closed.booking.serviceStatus,
    bookingVersion: closed.bookingVersion,
    quoteVersion: settled.projection.quoteVersion,
    booking: closed.booking,
  };
}

module.exports = {
  postgresPaymentEnabled,
  mapProjectionForPortals,
  syncBlobCompatibilityFromProjection,
  getSharedFinancialProjection,
  prepareEmbeddedPayment,
  adminReconcileWithStripe,
  applyCashOperationalClose,
  settleAdminCashFullBalance,
  blobNeedsCashClose,
};
