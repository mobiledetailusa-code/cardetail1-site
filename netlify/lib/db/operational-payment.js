/**
 * Operational payment facade — Admin / My Garage / webhook recovery share
 * one Postgres FinancialProjection + PaymentAuthorityService path.
 *
 * Blobs keep operational booking fields; money projection authority is
 * Postgres after ensureBookingFinancial. Read compatibility may still project
 * legacy fields, but financial mutations fail closed when Postgres is absent.
 */

const { prismaConfigured } = require('../prisma');
const { ensureBookingFinancial } = require('./ensure-booking-financial');
const authority = require('./payment-authority-service');
const { getBookingRecord, commitBooking } = require('../booking-repository');
const { buildNextAggregate, normalizeAggregate } = require('../booking-aggregate');
const { isDraftRecord, portalReleasePatch } = require('../booking-visibility');

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
    grossSettledCents: projection.grossSettledCents,
    settledCents: projection.settledCents,
    refundedCents: projection.refundedCents,
    pendingRefundCents: projection.pendingRefundCents,
    refundRequestStatus: projection.refundRequestStatus,
    remainingCents: projection.remainingCents,
    outstandingCreditCents: projection.outstandingCreditCents,
    paymentStatus: projection.paymentStatus,
    paymentAttemptStatus: projection.paymentAttemptStatus,
    paymentAttemptUpdatedAt: projection.paymentAttemptUpdatedAt,
    stripeReference: projection.stripeReference,
    paidAt: projection.paidAt,
    refundableCents: projection.refundableCents,
    authority: 'postgres',
  };
}

/**
 * Build the compatibility-only financial patch applied to the Blob aggregate.
 * Operational lifecycle fields are intentionally absent: reopening a balance
 * does not reopen an appointment, service, or completed job.
 */
function buildPaymentCompatibilityPatch(base, projection) {
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
      ? (['paid_cash', 'paid_card_on_site'].includes(String(base.paymentStatus || '').toLowerCase())
        ? base.paymentStatus
        : 'paid')
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

  // Prevent historical paid markers from clamping a newly reopened financial
  // balance. This is a financial compatibility marker, not a lifecycle state.
  if (projection.paymentStatus === 'due' || projection.remainingCents > 0) {
    patch._historicalPaidClosed = false;
  }
  if (projection.paymentStatus === 'paid' && projection.paidAt) {
    patch.capturedAt = typeof projection.paidAt === 'string'
      ? projection.paidAt
      : new Date(projection.paidAt).toISOString();
  }
  return patch;
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
  const patch = buildPaymentCompatibilityPatch(base, projection);
  // Card settlement is proof the appointment is real — clear sticky draft flags
  // so My Garage / receipt visibility catch up with the Postgres ledger.
  const needsPortalRelease = projection.paymentStatus === 'paid' && isDraftRecord(base);
  if (needsPortalRelease) {
    Object.assign(patch, portalReleasePatch());
  }
  const ledger = patch.ledger;

  const sameJsonValue = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  const alreadySynchronized = Object.entries(patch).every(([key, value]) => {
    if (key !== 'ledger') return sameJsonValue(base[key], value);
    return (
      Math.round(Number(base.ledger?.approvedCents) || 0) === projection.approvedCents
      && Math.round(Number(base.ledger?.settledCents) || 0) === projection.settledCents
      && Math.round(Number(base.ledger?.refundedCents) || 0) === (projection.refundedCents || 0)
      && String(base.ledger?.currency || 'usd').toLowerCase() === String(ledger.currency || 'usd').toLowerCase()
    );
  });
  if (alreadySynchronized && !needsPortalRelease) {
    return {
      ok: true,
      noop: true,
      booking: base,
      bookingVersion: Math.round(Number(base.bookingVersion) || 0),
    };
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

async function getSharedFinancialProjection(booking, { env = process.env } = {}) {
  if (!postgresPaymentEnabled(env)) {
    return { ok: false, error: 'postgres_payment_disabled', authority: 'blob' };
  }
  try {
    const ensured = await ensureBookingFinancial(booking);
    if (!ensured.ok) return { ok: false, error: ensured.error, authority: 'blob' };

    let projection = await authority.getFinancialProjection(ensured.bookingId);
    if (!projection) return { ok: false, error: 'projection_unavailable', authority: 'blob' };

    return {
      ok: true,
      authority: 'postgres',
      projection: mapProjectionForPortals(projection),
      bookingId: ensured.bookingId,
    };
  } catch (e) {
    // DATABASE_URL may be set while the DB/adapter is unreachable (common on
    // deploy-preview). Never throw into customer/admin portal reads — callers
    // fall back to Blob projection.
    console.warn('[operational-payment] shared_projection_failed', {
      bookingIdPrefix: String(booking?.id || booking?.bookingId || '').slice(0, 12),
      error: String(e && e.message || e).slice(0, 160),
    });
    return { ok: false, error: 'projection_unavailable', authority: 'blob' };
  }
}

async function prepareEmbeddedPayment({
  booking,
  expectedQuoteVersion = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
}) {
  try {
    return await prepareEmbeddedPaymentInner({
      booking,
      expectedQuoteVersion,
      env,
      fetchImpl,
    });
  } catch (e) {
    console.warn('[operational-payment] prepare_embedded_failed', {
      bookingIdPrefix: String(booking?.id || booking?.bookingId || '').slice(0, 12),
      error: String(e && e.message || e).slice(0, 200),
    });
    return { ok: false, error: 'payment_prepare_failed', statusCode: 503 };
  }
}

async function prepareEmbeddedPaymentInner({
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
      paymentIntentId: piId,
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
async function applyOnSitePaymentCompatibility({
  bookingId,
  amountCents,
  method = 'cash',
  reference = null,
}) {
  const rec = await getBookingRecord(bookingId);
  if (!rec.exists || !rec.booking) return { ok: false, error: 'blob_not_found' };

  const now = new Date().toISOString();
  const amountDollars = Math.max(0, Math.round(Number(amountCents) || 0)) / 100;
  const isCash = method === 'cash';
  const base = rec.booking;
  const paymentPatch = isCash
    ? {
        paymentStatus: 'paid_cash',
        paymentWorkflowStatus: 'cash_paid',
        cashReceivedAt: base.cashReceivedAt || now,
        cashReceivedAmount: amountDollars,
        cashReceivedReference: reference || base.cashReceivedReference || null,
      }
    : {
        paymentStatus: 'paid_card_on_site',
        paymentWorkflowStatus: 'payment_succeeded',
        cardOnSiteAt: base.cardOnSiteAt || now,
        cardOnSiteAmount: amountDollars,
        cardOnSiteReference: reference || base.cardOnSiteReference || null,
      };
  const next = buildNextAggregate(base, {
    ...paymentPatch,
    ...(isDraftRecord(base) ? portalReleasePatch(now) : {}),
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
    const retryPatch = isCash
      ? {
          paymentStatus: 'paid_cash',
          paymentWorkflowStatus: 'cash_paid',
          cashReceivedAt: again.booking.cashReceivedAt || now,
          cashReceivedAmount: amountDollars,
          cashReceivedReference: reference || again.booking.cashReceivedReference || null,
        }
      : {
          paymentStatus: 'paid_card_on_site',
          paymentWorkflowStatus: 'payment_succeeded',
          cardOnSiteAt: again.booking.cardOnSiteAt || now,
          cardOnSiteAmount: amountDollars,
          cardOnSiteReference: reference || again.booking.cardOnSiteReference || null,
        };
    const next2 = buildNextAggregate(again.booking, {
      ...retryPatch,
      ...(isDraftRecord(again.booking) ? portalReleasePatch(now) : {}),
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

async function applyCashOperationalClose({ bookingId, cashAmountCents, reference = null }) {
  return applyOnSitePaymentCompatibility({
    bookingId,
    amountCents: cashAmountCents,
    method: 'cash',
    reference,
  });
}

function blobNeedsOnSitePaymentSync(booking, method = 'cash') {
  if (!booking) return true;
  const { financialProjection } = require('../payment-service');
  const fp = financialProjection(booking);
  if (fp.remainingCents > 0) return true;
  const pay = String(booking.paymentStatus || '').toLowerCase();
  const pwf = String(booking.paymentWorkflowStatus || '').toLowerCase();
  if (method === 'cash') {
    if (pay !== 'paid_cash' && pay !== 'paid') return true;
    if (pwf !== 'cash_paid' && pwf !== 'payment_succeeded') return true;
    if (!(Number(booking.cashReceivedAmount) > 0)) return true;
  } else {
    if (pay !== 'paid_card_on_site' && pay !== 'paid') return true;
    if (pwf !== 'payment_succeeded') return true;
    if (!(Number(booking.cardOnSiteAmount) > 0)) return true;
  }
  return false;
}

function blobNeedsCashClose(booking) {
  return blobNeedsOnSitePaymentSync(booking, 'cash');
}

/**
 * Admin full-balance cash when PostgreSQL payment authority is enabled.
 * Money settles only in Postgres; Blob is compatibility + operational status.
 */
async function settleAdminOnSiteFullBalance({
  booking,
  body = {},
  method = 'cash',
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
  const needsSyncBefore = blobNeedsOnSitePaymentSync(beforeBlobRec.booking, method);

  const settled = await authority.recordFullBalanceOnSiteSettlement({
    bookingId,
    method,
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
  const settledCents = Math.max(
    0,
    Math.round(Number(settled.settledAmountCents != null
      ? settled.settledAmountCents
      : settled.entry?.amountCents) || 0)
  );

  // A fully synchronized replay is a no-op. Return before either compatibility
  // writer so an already-paid retry cannot bump bookingVersion or append noise.
  if ((settled.noop || settled.duplicate || !settled.created) && !needsSyncBefore) {
    return {
      ok: false,
      error: 'already_paid',
      statusCode: 409,
      authority: 'postgres',
      noop: true,
      postgresProjection: pgMapped,
      projection: pgMapped,
      settledAmountCents: settledCents,
      paymentStatus: beforeBlobRec.booking?.paymentStatus,
      jobStatus: beforeBlobRec.booking?.jobStatus,
      serviceStatus: beforeBlobRec.booking?.serviceStatus,
      bookingVersion: Math.round(Number(beforeBlobRec.booking?.bookingVersion) || 0),
      quoteVersion: settled.projection.quoteVersion,
      booking: beforeBlobRec.booking,
    };
  }

  const syncResult = await syncBlob(bookingId, settled.projection);
  if (!syncResult || syncResult.ok === false) {
    return {
      ok: false,
      error: 'blob_sync_failed',
      statusCode: 503,
      authority: 'postgres',
      postgresProjection: pgMapped,
      projection: pgMapped,
      settledAmountCents: settledCents,
      settlementRecorded: true,
      created: !!settled.created,
      noop: !!(settled.noop || settled.duplicate),
      syncError: syncResult?.error || 'blob_sync_failed',
      quoteVersion: settled.projection.quoteVersion,
    };
  }

  const closed = await applyOnSitePaymentCompatibility({
    bookingId,
    amountCents: settledCents,
    method,
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
      settledAmountCents: settledCents,
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
  if (noop && !needsSyncBefore && !blobNeedsOnSitePaymentSync(closed.booking, method)) {
    return {
      ok: false,
      error: 'already_paid',
      statusCode: 409,
      authority: 'postgres',
      noop: true,
      postgresProjection: pgMapped,
      projection: pgMapped,
      financialProjection: compat,
      settledAmountCents: settledCents,
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
    settledAmountCents: settledCents,
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

async function settleAdminCashFullBalance(args) {
  return settleAdminOnSiteFullBalance({ ...args, method: 'cash' });
}

module.exports = {
  postgresPaymentEnabled,
  mapProjectionForPortals,
  buildPaymentCompatibilityPatch,
  syncBlobCompatibilityFromProjection,
  getSharedFinancialProjection,
  prepareEmbeddedPayment,
  adminReconcileWithStripe,
  applyOnSitePaymentCompatibility,
  applyCashOperationalClose,
  settleAdminOnSiteFullBalance,
  settleAdminCashFullBalance,
  blobNeedsOnSitePaymentSync,
  blobNeedsCashClose,
};
