/**
 * Manual Square Dashboard collection coordinated on the PostgreSQL Booking row.
 *
 * The Booking row is the same row on-site settlement locks with FOR UPDATE.
 * This path uses READ COMMITTED. The row lock is acquired first, and the quote,
 * ledger, and payment-attempt reads happen afterward in that same transaction.
 * A serializable snapshot would stay at the waiting statement and could miss a
 * ledger insert that did not update the Booking row. Settlement transactions
 * keep their own isolation level.
 * A reservation is not a payment, not a ledger entry, and not a PaymentAttempt.
 * Recording a URL does not mark the booking paid.
 * Closing a reservation is an administrative attestation, not a Square check.
 *
 * An attestation does not prove Square has no completed or in-flight payment.
 * A link created outside this reservation is invisible to Cardetail1.
 * These operations do not guarantee that a duplicate payment cannot occur.
 */

const crypto = require('node:crypto');
const { tryGetPrisma } = require('../prisma');
const { computeFinancialProjection } = require('./financial-projection');
const { ensureBookingFinancial } = require('./ensure-booking-financial');

const KNOWN_STATES = new Set(['reserved', 'recorded', 'closed', 'payment_reported']);
const BLOCKING_STATES = new Set(['reserved', 'recorded', 'payment_reported']);
const UNPAID_CONFIRMATIONS = [
  'inspected',
  'noCompletedPayment',
  'deactivated',
  'responsibilityAccepted',
];

const COLLECTION_TRANSACTION_ATTEMPTS = 3;

const LIMITATIONS = [
  'Administrative attestation does not prove Square has no completed or in-flight payment.',
  'A payment URL created outside this Cardetail1 reservation is not visible here.',
  'Cardetail1 does not guarantee that a duplicate payment cannot occur.',
];

function fail(error, statusCode, extra = {}) {
  return {
    ok: false,
    error,
    statusCode,
    paid: false,
    created: false,
    paymentEvidence: false,
    ledgerEntryCreated: false,
    ...extra,
  };
}

function authorityEnabled(env, deps) {
  if (typeof deps.authorityEnabled === 'function') return !!deps.authorityEnabled(env);
  const source = env || process.env;
  if (source.CD1_POSTGRES_PAYMENT === '0' || source.CD1_POSTGRES_PAYMENT === 'false') return false;
  return !!(source.DATABASE_URL && String(source.DATABASE_URL).trim());
}

function isCancelledBookingSnapshot(booking) {
  if (!booking) return false;
  const appointment = String(booking.appointmentStatus || '').toLowerCase();
  const job = String(booking.jobStatus || '').toLowerCase();
  const status = String(booking.status || '').toLowerCase();
  return appointment === 'canceled' || appointment === 'cancelled'
    || job === 'cancelled' || job === 'canceled'
    || status === 'cancelled' || status === 'canceled';
}

function detailOf(row) {
  const detail = row && row.manualCollectionDetail;
  return detail && typeof detail === 'object' && !Array.isArray(detail) ? detail : {};
}

function explanationFor(state) {
  if (state === 'reserved') {
    return 'Online collection is reserved. Create the link in the Square Dashboard, then record the URL here. The reservation does not create a payment and does not mark the booking paid. Cash and card-on-site settlement stay unavailable.';
  }
  if (state === 'recorded') {
    return 'A manual URL is recorded for this booking. The URL is not payment evidence and the booking is not paid. Cash and card-on-site settlement stay unavailable until an administrator attests that the Square link was inspected, no completed payment was found, and the link was deactivated. That attestation is not a Square verification.';
  }
  if (state === 'payment_reported') {
    return 'An administrator reported that Square received a payment. Cardetail1 has not marked this booking paid and has not released the balance for cash or card. A separate authorized reconciliation is required.';
  }
  if (state === 'closed') {
    return 'An administrator attested that the manual link was inspected and deactivated. This is not proof that Square has no completed or in-flight payment. Cardetail1 will allow on-site settlement again.';
  }
  if (state) {
    return 'The manual collection state is unknown. On-site settlement stays blocked.';
  }
  return 'No manual online collection is reserved. Reserving does not create a Square link, does not take a payment, and does not mark the booking paid.';
}

function publicView(row) {
  const state = row && row.manualCollectionState ? String(row.manualCollectionState) : null;
  const detail = detailOf(row);
  const known = !state || KNOWN_STATES.has(state);
  const view = {
    state,
    operationId: row && row.manualCollectionOperationId ? String(row.manualCollectionOperationId) : null,
    quoteVersion: row && row.manualCollectionQuoteVersion != null
      ? row.manualCollectionQuoteVersion
      : null,
    url: row && row.manualCollectionUrl ? String(row.manualCollectionUrl) : null,
    blocksOnSiteSettlement: !known || BLOCKING_STATES.has(state),
    paid: false,
    paymentEvidence: false,
    providerVerified: false,
    explanation: explanationFor(known ? state : 'unknown'),
    limitations: LIMITATIONS,
    reservedAt: detail.reservedAt || null,
    reservedBy: detail.reservedBy || null,
  };
  if (state === 'closed' || state === 'payment_reported') {
    view.attestation = {
      closedAt: detail.closedAt || null,
      closedBy: detail.closedBy || null,
      reason: detail.closureReason || null,
      confirmation: detail.confirmation || null,
      outcome: detail.outcome || null,
      evidence: detail.evidence || null,
      providerVerified: false,
    };
  }
  return view;
}

function onSiteSettlementManualCollectionConflict(booking) {
  if (!booking) return null;
  const state = booking.manualCollectionState == null || booking.manualCollectionState === ''
    ? null
    : String(booking.manualCollectionState);
  if (!state || state === 'closed') return null;
  if (!BLOCKING_STATES.has(state)) {
    return fail('manual_collection_unknown', 409, {
      manualCollectionState: state,
      operationId: booking.manualCollectionOperationId || null,
    });
  }
  return fail('manual_collection_active', 409, {
    manualCollectionState: state,
    operationId: booking.manualCollectionOperationId || null,
    settlementRecorded: false,
  });
}

function mergedRow(row, patch) {
  return { ...(row || {}), ...(patch || {}) };
}

function positiveRemaining(projection) {
  if (!projection || projection.ok === false) return { ok: false, error: 'financial_projection_missing' };
  const remaining = Math.round(Number(projection.remainingCents));
  const quoteVersion = Math.round(Number(projection.quoteVersion));
  if (!Number.isFinite(remaining) || !Number.isFinite(quoteVersion)) {
    return { ok: false, error: 'financial_projection_missing' };
  }
  if (projection.paymentStatus === 'processing') {
    return { ok: false, error: 'payment_attempt_in_progress' };
  }
  if (remaining <= 0 || projection.paymentStatus === 'paid') {
    return { ok: false, error: 'zero_remaining_balance' };
  }
  return { ok: true, remainingCents: remaining, quoteVersion };
}

function decideReserve({ row, projection, actorId, now, createOperationId }) {
  if (!row) return fail('not_found', 404);
  const state = row.manualCollectionState ? String(row.manualCollectionState) : null;
  if (state === 'reserved') {
    const view = publicView(row);
    return {
      ok: true,
      created: false,
      idempotent: true,
      write: false,
      view,
      operationId: view.operationId,
    };
  }
  if (state === 'recorded' || state === 'payment_reported') {
    return fail('manual_collection_conflict', 409, { manualCollectionState: state });
  }
  if (state && state !== 'closed') return fail('manual_collection_unknown', 409, { manualCollectionState: state });
  if (String(row.status || '') === 'cancelled') return fail('booking_canceled', 409);
  const money = positiveRemaining(projection);
  if (!money.ok) return fail(money.error, money.error === 'financial_projection_missing' ? 503 : 409);
  const detail = detailOf(row);
  const history = Array.isArray(detail.history) ? detail.history.slice() : [];
  if (state === 'closed') {
    history.push({
      operationId: row.manualCollectionOperationId || null,
      url: row.manualCollectionUrl || null,
      state: 'closed',
      quoteVersion: row.manualCollectionQuoteVersion ?? null,
      reservedAt: detail.reservedAt || null,
      recordedAt: detail.recordedAt || null,
      closedAt: detail.closedAt || null,
      closedBy: detail.closedBy || null,
      closureReason: detail.closureReason || null,
      confirmation: detail.confirmation || null,
      outcome: detail.outcome || null,
      evidence: detail.evidence || null,
    });
  }
  const operationId = createOperationId();
  const patch = {
    manualCollectionState: 'reserved',
    manualCollectionOperationId: operationId,
    manualCollectionQuoteVersion: money.quoteVersion,
    manualCollectionUrl: null,
    manualCollectionDetail: {
      reservedAt: now,
      reservedBy: actorId,
      history,
    },
  };
  const view = publicView(mergedRow(row, patch));
  return { ok: true, created: true, idempotent: false, write: true, patch, view, operationId };
}

function normalizeUrl(value) {
  const url = String(value || '').trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) return null;
  if (url.length > 500) return null;
  return url;
}

function decideRecordUrl({ row, projection, operationId, url, now }) {
  if (!row) return fail('not_found', 404);
  const state = row.manualCollectionState ? String(row.manualCollectionState) : null;
  if (!state) return fail('manual_collection_reservation_required', 409);
  if (state === 'closed' || state === 'payment_reported') {
    return fail('manual_collection_not_recordable', 409, { manualCollectionState: state });
  }
  if (state !== 'reserved' && state !== 'recorded') {
    return fail('manual_collection_unknown', 409, { manualCollectionState: state });
  }
  if (!operationId || String(row.manualCollectionOperationId || '') !== operationId) {
    return fail('manual_collection_operation_mismatch', 409);
  }
  const money = positiveRemaining(projection);
  if (!money.ok) return fail(money.error, money.error === 'financial_projection_missing' ? 503 : 409);
  const normalized = normalizeUrl(url);
  if (!normalized) return fail('invalid_pay_link', 400);
  if (state === 'recorded') {
    if (String(row.manualCollectionUrl || '') === normalized) {
      const view = publicView(row);
      return { ok: true, created: false, idempotent: true, write: false, view, operationId };
    }
    return fail('manual_collection_url_conflict', 409);
  }
  const patch = {
    manualCollectionState: 'recorded',
    manualCollectionUrl: normalized,
    manualCollectionDetail: {
      ...detailOf(row),
      recordedAt: now,
    },
  };
  const view = publicView(mergedRow(row, patch));
  return { ok: true, created: true, idempotent: false, write: true, patch, view, operationId };
}

function unpaidConfirmation(confirmation) {
  if (!confirmation || typeof confirmation !== 'object' || Array.isArray(confirmation)) {
    return UNPAID_CONFIRMATIONS[0];
  }
  return UNPAID_CONFIRMATIONS.find((key) => confirmation[key] !== true) || null;
}

function decideClose({ row, operationId, actorId, now, outcome, reason, confirmation, evidence }) {
  if (!row) return fail('not_found', 404);
  const state = row.manualCollectionState ? String(row.manualCollectionState) : null;
  if (!state) return fail('manual_collection_reservation_required', 409);
  if (!KNOWN_STATES.has(state)) return fail('manual_collection_unknown', 409, { manualCollectionState: state });
  if (!operationId || String(row.manualCollectionOperationId || '') !== operationId) {
    return fail('manual_collection_operation_mismatch', 409);
  }
  const normalizedOutcome = String(outcome || '').trim();
  if (normalizedOutcome !== 'unpaid_withdrawn' && normalizedOutcome !== 'payment_reported') {
    return fail('manual_collection_outcome_invalid', 400);
  }
  const note = String(reason || '').trim().slice(0, 500);
  if (!note) return fail('reason_required', 400);
  if (state === 'payment_reported') {
    if (normalizedOutcome === 'payment_reported') {
      const view = publicView(row);
      return { ok: true, created: false, idempotent: true, write: false, view, operationId };
    }
    return fail('manual_collection_payment_unreconciled', 409, { manualCollectionState: state });
  }
  if (state === 'closed' && normalizedOutcome === 'unpaid_withdrawn') {
    const view = publicView(row);
    return { ok: true, created: false, idempotent: true, write: false, view, operationId };
  }
  if (normalizedOutcome === 'unpaid_withdrawn') {
    const missing = unpaidConfirmation(confirmation);
    if (missing) return fail('manual_collection_confirmation_required', 409, { field: missing });
  }
  const nextState = normalizedOutcome === 'payment_reported' ? 'payment_reported' : 'closed';
  const patch = {
    manualCollectionState: nextState,
    manualCollectionDetail: {
      ...detailOf(row),
      closedAt: now,
      closedBy: actorId,
      closureReason: note,
      confirmation: confirmation && typeof confirmation === 'object' ? confirmation : null,
      outcome: normalizedOutcome,
      evidence: evidence ? String(evidence).trim().slice(0, 500) : null,
    },
  };
  const view = publicView(mergedRow(row, patch));
  return { ok: true, created: true, idempotent: false, write: true, patch, view, operationId };
}

async function finishSideEffects(decision, deps) {
  const view = decision.view || publicView({});
  const result = {
    ok: true,
    created: !!decision.created,
    idempotent: !!decision.idempotent,
    paid: false,
    paymentEvidence: false,
    providerVerified: false,
    authoritative: false,
    collectionAuthoritative: true,
    ledgerEntryCreated: false,
    restrictionHeld: !!view.blocksOnSiteSettlement,
    operationId: decision.operationId || view.operationId || null,
    manualCollection: view,
  };
  if (typeof deps.syncBlob === 'function') {
    try {
      await deps.syncBlob(view);
    } catch {
      result.blobSyncFailed = true;
    }
  }
  if (typeof deps.audit === 'function') {
    try {
      await deps.audit(view);
    } catch {
      result.auditFailed = true;
    }
  }
  return result;
}

function txContext(tx, bookingId) {
  return {
    async readBooking() {
      return tx.booking.findUnique({ where: { id: bookingId } });
    },
    async readProjection() {
      const booking = await tx.booking.findUnique({ where: { id: bookingId } });
      const quote = await tx.quote.findFirst({
        where: { bookingId },
        orderBy: { quoteVersion: 'desc' },
      });
      if (!booking || !quote) return null;
      const ledgerEntries = await tx.ledgerEntry.findMany({ where: { bookingId } });
      const paymentAttempts = await tx.paymentAttempt.findMany({ where: { bookingId } });
      return computeFinancialProjection({ booking, quote, paymentAttempts, ledgerEntries });
    },
    async writeCollection(patch) {
      await tx.booking.update({ where: { id: bookingId }, data: patch });
    },
  };
}

function collectionErrorText(error) {
  const adapter = error?.meta?.driverAdapterError?.cause;
  return [
    error?.code,
    error?.message,
    error?.cause?.code,
    error?.cause?.originalCode,
    error?.cause?.message,
    error?.meta?.code,
    adapter?.originalCode,
    adapter?.code,
    adapter?.message,
  ].filter(Boolean).join(' ');
}

/**
 * Business conflicts return from inside the transaction and are not errors.
 * 40001 and 40P01 retry the whole transaction. A dropped connection may mean
 * the commit landed, so that retry is also a new transaction that reads the
 * durable row before it writes. A definite statement failure is not retried
 * and is not reported as an unknown commit.
 */
function classifyCollectionTransactionError(error) {
  const text = collectionErrorText(error);
  if (/\b(?:P2034|40001|40P01)\b|serialization failure|deadlock detected/i.test(text)) {
    return { retry: true, error: 'manual_collection_retry_exhausted', statusCode: 503 };
  }
  if (/ECONNRESET|EPIPE|connection terminated|server closed the connection|closed the connection|Can't reach database server/i.test(text)) {
    return { retry: true, error: 'manual_collection_outcome_unknown', statusCode: 503 };
  }
  return { retry: false, error: 'manual_collection_persist_failed', statusCode: 503 };
}

async function executeCollectionTransaction(runTransaction, maxAttempts = COLLECTION_TRANSACTION_ATTEMPTS) {
  const attempts = Math.max(1, Math.round(Number(maxAttempts) || COLLECTION_TRANSACTION_ATTEMPTS));
  let decision = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await runTransaction();
    } catch (error) {
      decision = classifyCollectionTransactionError(error);
      if (decision.retry && attempt < attempts) continue;
      return fail(decision.error, decision.statusCode);
    }
  }
  return fail(decision?.error || 'manual_collection_outcome_unknown', 503);
}

async function defaultWithBookingLock(bookingId, operation) {
  const prisma = tryGetPrisma();
  if (!prisma) return fail('database_not_configured', 503);
  let Prisma;
  try {
    ({ Prisma } = require('@prisma/client'));
  } catch {
    return fail('database_not_configured', 503);
  }
  return executeCollectionTransaction(() => prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw`
      SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} FOR UPDATE
    `;
    if (!Array.isArray(locked) || locked.length === 0) return fail('not_found', 404);
    return operation(txContext(tx, bookingId));
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  }));
}

async function runLocked(bookingId, deps, mutator) {
  const withLock = deps.withBookingLock || defaultWithBookingLock;
  try {
    const decision = await withLock(bookingId, async (ctx) => {
      const row = await ctx.readBooking();
      const projection = await ctx.readProjection();
      const next = mutator({ row, projection });
      if (next && next.write) await ctx.writeCollection(next.patch);
      return next;
    });
    if (!decision || typeof decision.ok !== 'boolean') return fail('manual_collection_outcome_unknown', 503);
    if (!decision.ok) return { ...decision, paid: false, paymentEvidence: false, ledgerEntryCreated: false };
    return finishSideEffects(decision, deps);
  } catch (error) {
    const decision = classifyCollectionTransactionError(error);
    return fail(decision.error, decision.statusCode);
  }
}

async function reserveManualCollection(input = {}, deps = {}) {
  const env = input.env || process.env;
  const actorId = String(input.actorId || '').trim();
  if (!actorId) return fail('admin_required', 401);
  if (!authorityEnabled(env, deps)) return fail('postgres_payment_disabled', 503);
  const booking = input.booking || null;
  const bookingId = String(input.bookingId || booking?.id || booking?.bookingId || '').trim();
  if (!bookingId) return fail('bookingId_required', 400);
  if (isCancelledBookingSnapshot(booking)) return fail('booking_canceled', 409);
  const ensure = deps.ensureBookingFinancial || ensureBookingFinancial;
  let ensured;
  try {
    ensured = await ensure(booking || { id: bookingId });
  } catch {
    return fail('database_not_configured', 503);
  }
  if (!ensured || ensured.ok === false) return fail(ensured?.error || 'database_not_configured', 503);
  const now = input.now || new Date().toISOString();
  const createOperationId = deps.createOperationId || (() => crypto.randomUUID());
  return runLocked(bookingId, deps, ({ row, projection }) => decideReserve({
    row,
    projection,
    actorId,
    now,
    createOperationId,
  }));
}

async function recordManualCollectionUrl(input = {}, deps = {}) {
  const env = input.env || process.env;
  const actorId = String(input.actorId || '').trim();
  if (!actorId) return fail('admin_required', 401);
  if (!authorityEnabled(env, deps)) return fail('postgres_payment_disabled', 503);
  const bookingId = String(input.bookingId || '').trim();
  if (!bookingId) return fail('bookingId_required', 400);
  const now = input.now || new Date().toISOString();
  return runLocked(bookingId, deps, ({ row, projection }) => decideRecordUrl({
    row,
    projection,
    operationId: String(input.operationId || '').trim(),
    url: input.url,
    now,
  }));
}

async function closeManualCollection(input = {}, deps = {}) {
  const env = input.env || process.env;
  const actorId = String(input.actorId || '').trim();
  if (!actorId) return fail('admin_required', 401);
  if (!authorityEnabled(env, deps)) return fail('postgres_payment_disabled', 503);
  const bookingId = String(input.bookingId || '').trim();
  if (!bookingId) return fail('bookingId_required', 400);
  const now = input.now || new Date().toISOString();
  return runLocked(bookingId, deps, ({ row }) => decideClose({
    row,
    operationId: String(input.operationId || '').trim(),
    actorId,
    now,
    outcome: input.outcome,
    reason: input.reason,
    confirmation: input.confirmation,
    evidence: input.evidence,
  }));
}

async function readManualCollectionView(bookingId) {
  const id = String(bookingId || '').trim();
  if (!id || !authorityEnabled(process.env, {})) return null;
  const prisma = tryGetPrisma();
  if (!prisma) return null;
  const row = await prisma.booking.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      manualCollectionState: true,
      manualCollectionOperationId: true,
      manualCollectionQuoteVersion: true,
      manualCollectionUrl: true,
      manualCollectionDetail: true,
    },
  });
  return row ? publicView(row) : null;
}

function manualCollectionHttpResult(result) {
  if (!result || typeof result.ok !== 'boolean') {
    return {
      statusCode: 503,
      body: fail('manual_collection_outcome_unknown', 503),
    };
  }
  if (result.blobSyncFailed) {
    return {
      statusCode: 503,
      body: {
        ...result,
        ok: false,
        error: 'blob_sync_failed',
        collectionRecorded: result.ok === true,
        restrictionHeld: !!result.restrictionHeld,
        paid: false,
        paymentEvidence: false,
        ledgerEntryCreated: false,
      },
    };
  }
  return {
    statusCode: result.statusCode || (result.ok ? 200 : 400),
    body: {
      ...result,
      paid: false,
      paymentEvidence: false,
      ledgerEntryCreated: false,
    },
  };
}

module.exports = {
  COLLECTION_TRANSACTION_ATTEMPTS,
  LIMITATIONS,
  classifyCollectionTransactionError,
  executeCollectionTransaction,
  onSiteSettlementManualCollectionConflict,
  reserveManualCollection,
  recordManualCollectionUrl,
  closeManualCollection,
  readManualCollectionView,
  manualCollectionHttpResult,
  publicView,
};
