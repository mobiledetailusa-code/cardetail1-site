/**
 * Stage 1 — authoritative add-on financial mutations.
 *
 * Money authority: Postgres PaymentAuthorityService.createAdjustment.
 * Blob is updated as a compatibility projection from that result.
 *
 * Does not redefine isInvoicePaid(). Post-settlement additions create an
 * unpaid delta; reductions create explicit outstanding credit for the PR2
 * refund workflow and never issue a refund from this mutation.
 */

const { getBookingRecord, commitBooking } = require('./booking-repository');
const {
  normalizeAggregate,
  buildNextAggregate,
  materialProjection,
  remainingCents,
  ensureVehicleIds,
} = require('./booking-aggregate');
const { quoteService, applyServiceDelta } = require('./canonical-quote');
const { dollarsToCents, asArray } = require('./historical-adapter');
const { PRICING } = require('./booking-price-catalog');
const { supersedeOpenAttempts, expireSupersededAttempts, financialProjection } = require('./payment-service');
const {
  postgresPaymentEnabled,
  syncBlobCompatibilityFromProjection,
  mapProjectionForPortals,
} = require('./db/operational-payment');
const { ensureBookingFinancial } = require('./db/ensure-booking-financial');
const authority = require('./db/payment-authority-service');
const {
  normalizeIdempotencyKey,
  mutationFingerprint,
  adjustmentIdFromKey,
  replayResult,
  appendOperationReceipt,
} = require('./operation-idempotency');

function settledCentsOf(aggregate) {
  return Math.max(0, Math.round(Number(aggregate?.ledger?.settledCents) || 0));
}

function catalogAddonIdsForVehicle(vehicle) {
  const cat = String(vehicle?.category || vehicle?.cat || 'cars').trim() || 'cars';
  return {
    cat,
    ids: new Set((PRICING[cat]?.addons || []).map((a) => a.id)),
  };
}

function normalizeAddonIds(raw) {
  return asArray(raw)
    .map((id) => String(id || '').trim())
    .filter(Boolean);
}

/**
 * Narrow capability: additive post-settlement add-on adjustment is allowed
 * even when the booking is historically paid for a prior quote.
 * Does not change isInvoicePaid().
 */
function canApplyAdditiveAddonAdjustment({ addOnIdsToAdd, addOnIdsToRemove }) {
  const toAdd = normalizeAddonIds(addOnIdsToAdd);
  const toRemove = normalizeAddonIds(addOnIdsToRemove);
  return toAdd.length > 0 && toRemove.length === 0;
}

function validateAddonIdsAgainstCatalog(service, target, addOnIds) {
  const vehicles = ensureVehicleIds(service?.vehicles || []);
  let vehicleId = target?.vehicleId;
  if (!vehicleId && vehicles.length === 1) vehicleId = vehicles[0].vehicleId;
  if (!vehicleId) return { ok: false, error: 'vehicle_target_required' };
  const vehicle = vehicles.find((v) => v.vehicleId === vehicleId);
  if (!vehicle) return { ok: false, error: 'vehicle_not_found' };
  const { cat, ids } = catalogAddonIdsForVehicle(vehicle);
  const unknown = normalizeAddonIds(addOnIds).filter((id) => !ids.has(id));
  if (unknown.length) {
    return { ok: false, error: 'unknown_addon_id', unknownAddonIds: unknown, category: cat };
  }
  return { ok: true, vehicleId, category: cat };
}

/**
 * Apply add/remove add-on IDs, reprice via booking-price-catalog, write
 * Postgres adjustment, then sync Blob compatibility from that authority.
 *
 * Browser-supplied names/prices/totals are ignored — IDs only.
 */
async function applyAddonFinancialMutation({
  bookingId,
  expectedBookingVersion,
  target = {},
  addOnIdsToAdd = [],
  addOnIdsToRemove = [],
  /** Optional: mark this change-request applied in the same Blob commit */
  changeRequest = null,
  adminNote = '',
  idempotencyKey = '',
  actor = '',
  env = process.env,
}) {
  const toAdd = normalizeAddonIds(addOnIdsToAdd);
  const toRemove = normalizeAddonIds(addOnIdsToRemove);
  if (!toAdd.length && !toRemove.length) {
    return { ok: false, error: 'addon_ids_required', statusCode: 400 };
  }

  const current = await getBookingRecord(bookingId);
  if (!current.exists) return { ok: false, error: 'not_found', statusCode: 404 };

  const { ok, aggregate } = normalizeAggregate(current.booking);
  if (!ok) return { ok: false, error: 'invalid_aggregate', statusCode: 400 };

  const operationKey = normalizeIdempotencyKey(idempotencyKey);
  if (idempotencyKey && !operationKey) {
    return { ok: false, error: 'invalid_idempotency_key', statusCode: 400 };
  }
  const fingerprint = mutationFingerprint({
    bookingId,
    action: 'addon_mutation',
    target: target || {},
    addOnIdsToAdd: toAdd,
    addOnIdsToRemove: toRemove,
  });
  if (operationKey) {
    const replay = replayResult(aggregate, operationKey, fingerprint);
    if (replay) {
      if (!replay.ok) return replay;
      return {
        ok: true,
        noop: true,
        idempotent: true,
        reason: 'idempotent_replay',
        booking: aggregate,
        projection: materialProjection(aggregate),
        financialProjection: financialProjection(aggregate),
        quoteVersion: aggregate.quoteVersion || aggregate.quote?.quoteVersion || 0,
      };
    }
  }

  const actualVersion = Math.round(Number(aggregate.bookingVersion) || 0);
  const expected = expectedBookingVersion != null
    ? Math.round(Number(expectedBookingVersion))
    : actualVersion;
  if (actualVersion !== expected) {
    return { ok: false, error: 'version_conflict', statusCode: 409, actualBookingVersion: actualVersion };
  }

  const idsForValidation = [...toAdd, ...toRemove];
  const validated = validateAddonIdsAgainstCatalog(aggregate.service, target, idsForValidation);
  if (!validated.ok) {
    return { ...validated, statusCode: 400 };
  }

  const delta = {
    addOnIdsToAdd: toAdd,
    addOnIdsToRemove: toRemove,
  };
  const applied = applyServiceDelta(aggregate.service, { vehicleId: validated.vehicleId }, delta);
  if (!applied.ok) return { ok: false, error: applied.error, statusCode: 400 };

  if (applied.noop) {
    // Exact duplicate — no new quote version, no PG adjustment, no ledger mutation.
    if (changeRequest && (changeRequest.requestId || changeRequest.id)) {
      const reqId = changeRequest.requestId || changeRequest.id;
      const nextRequests = asArray(aggregate.changeRequests).map((r) => (
        (r.requestId || r.id) === reqId
          ? {
            ...r,
            status: 'applied',
            decision: 'approve',
            adminNote: adminNote || '',
            decidedAt: new Date().toISOString(),
            appliedBookingVersion: actualVersion + 1,
            noop: true,
            reason: applied.reason || 'duplicate_addon',
          }
          : r
      ));
      const next = buildNextAggregate(aggregate, {
        changeRequests: nextRequests,
        customerChangePending: nextRequests.some((r) => r.status === 'pending' || r.status === 'pending_approval'),
      });
      const committed = await commitBooking({
        bookingId,
        expectedBookingVersion: expected,
        nextAggregate: next,
      });
      if (!committed.ok) return committed;
      return {
        ok: true,
        noop: true,
        reason: applied.reason || 'duplicate_addon',
        booking: committed.booking,
        projection: materialProjection(committed.booking),
        financialProjection: financialProjection(committed.booking),
        quoteVersion: aggregate.quoteVersion || aggregate.quote?.quoteVersion || 0,
      };
    }
    return {
      ok: true,
      noop: true,
      reason: applied.reason || 'duplicate_addon',
      booking: aggregate,
      projection: materialProjection(aggregate),
      financialProjection: financialProjection(aggregate),
      quoteVersion: aggregate.quoteVersion || aggregate.quote?.quoteVersion || 0,
    };
  }

  if (!postgresPaymentEnabled(env)) {
    return { ok: false, error: 'postgres_payment_disabled', statusCode: 503 };
  }

  const travelCents = dollarsToCents(aggregate.travelFeeAmount || aggregate.zoneSurcharge || 0);
  const quoted = quoteService(applied.service, {
    basedOnBookingVersion: actualVersion,
    previousQuoteVersion: aggregate.quoteVersion || aggregate.quote?.quoteVersion || 0,
    travelCents,
    bookingBase: aggregate,
  });
  if (!quoted.ok) return { ok: false, error: quoted.error || 'invalid_pricing', statusCode: 400 };

  // Seed Postgres from current Blob (preserves existing settlements).
  const ensured = await ensureBookingFinancial(aggregate);
  if (!ensured.ok) return { ok: false, error: ensured.error || 'ensure_failed', statusCode: 503 };

  const priorProjection = await authority.getFinancialProjection(bookingId);
  const priorQuoteVersion = priorProjection?.quoteVersion || ensured.quoteVersion || 1;
  const repo = require('./db/repositories');
  const priorAttempts = await repo.listPaymentAttempts(bookingId);
  const priorAttemptCount = priorAttempts.length;

  const adjustment = await authority.createAdjustment({
    bookingId,
    newApprovedCents: quoted.quote.approvedCents,
    reason: toRemove.length ? 'addon_remove' : 'addon_add',
    adjustmentId: adjustmentIdFromKey('addonop', bookingId, operationKey)
      || `addon_${bookingId}_${actualVersion}_${quoted.quote.approvedCents}`.slice(0, 96),
    expectedQuoteVersion: priorQuoteVersion,
    approvedBy: changeRequest ? 'customer_request_approved' : 'admin',
  });
  if (!adjustment.ok) {
    return { ok: false, error: adjustment.error || 'adjustment_failed', statusCode: 500 };
  }

  const pgProjection = adjustment.after || await authority.getFinancialProjection(bookingId);
  if (!pgProjection) {
    return { ok: false, error: 'projection_unavailable', statusCode: 500 };
  }

  const ledgerEntries = asArray(aggregate.ledger?.entries);
  const nextLedger = {
    ...aggregate.ledger,
    currency: 'usd',
    approvedCents: pgProjection.approvedCents,
    settledCents: pgProjection.settledCents,
    creditedCents: Math.max(0, Math.round(Number(aggregate.ledger?.creditedCents) || 0)),
    refundedCents: Math.max(0, Math.round(Number(pgProjection.refundedCents) || 0)),
    entries: ledgerEntries,
  };

  const nextQuoteVersion = pgProjection.quoteVersion;
  const nextQuote = {
    ...quoted.quote,
    quoteVersion: nextQuoteVersion,
    approvedCents: pgProjection.approvedCents,
  };

  const paymentAttempts = supersedeOpenAttempts(aggregate.paymentAttempts, {
    quoteVersion: nextQuoteVersion,
  });

  // Compatibility status from authoritative projection (add-on path only).
  const compatPaymentStatus = pgProjection.paymentStatus === 'paid'
    ? 'paid'
    : pgProjection.paymentStatus === 'processing'
      ? 'processing'
      : pgProjection.paymentStatus === 'refunded'
        ? 'refunded'
        : pgProjection.paymentStatus === 'due'
          ? 'due'
          : (aggregate.paymentStatus || 'no_payment_required_yet');
  const compatWorkflow = pgProjection.paymentStatus === 'paid'
    ? (String(aggregate.paymentWorkflowStatus || '').toLowerCase() === 'cash_paid'
      ? 'cash_paid'
      : 'payment_succeeded')
    : pgProjection.paymentStatus === 'processing'
      ? 'awaiting_customer_payment'
      : pgProjection.paymentStatus === 'due'
        ? 'awaiting_customer_payment'
        : (aggregate.paymentWorkflowStatus || null);

  const appliedBookingVersion = actualVersion + 1;
  let nextChangeRequests = asArray(aggregate.changeRequests);
  if (changeRequest && (changeRequest.requestId || changeRequest.id)) {
    const reqId = changeRequest.requestId || changeRequest.id;
    const found = nextChangeRequests.some((r) => (r.requestId || r.id) === reqId);
    const appliedRow = {
      ...changeRequest,
      status: 'applied',
      decision: 'approve',
      adminNote: adminNote || changeRequest.adminNote || '',
      decidedAt: new Date().toISOString(),
      appliedBookingVersion,
    };
    nextChangeRequests = found
      ? nextChangeRequests.map((r) => ((r.requestId || r.id) === reqId ? { ...r, ...appliedRow } : r))
      : [...nextChangeRequests, appliedRow];
  }

  // When an unpaid delta remains, clear legacy Paid/completed_paid markers so
  // adaptHistoricalBooking/_historicalPaidClosed cannot force settled=approved
  // and zero out remaining. Limited to this add-on adjustment path.
  const openDeltaPatches = {};
  if (pgProjection.remainingCents > 0) {
    openDeltaPatches._historicalPaidClosed = false;
    openDeltaPatches.paymentStatus = compatPaymentStatus;
    openDeltaPatches.paymentWorkflowStatus = compatWorkflow;
    if (String(aggregate.status || '') === 'Paid' || String(aggregate.status || '') === 'Closed') {
      openDeltaPatches.status = 'Confirmed';
    }
    if (String(aggregate.jobStatus || '').toLowerCase() === 'completed_paid') {
      openDeltaPatches.jobStatus = 'confirmed';
    }
  }
  const paidAtPatches = pgProjection.paymentStatus === 'paid' && pgProjection.paidAt
    ? {
      capturedAt: typeof pgProjection.paidAt === 'string'
        ? pgProjection.paidAt
        : new Date(pgProjection.paidAt).toISOString(),
    }
    : {};

  const next = buildNextAggregate(aggregate, {
    service: quoted.service,
    quote: nextQuote,
    quoteVersion: nextQuoteVersion,
    ledger: nextLedger,
    paymentAttempts,
    changeRequests: nextChangeRequests,
    customerChangePending: nextChangeRequests.some((r) => r.status === 'pending' || r.status === 'pending_approval'),
    payLink: '',
    stripeCheckoutSessionId: '',
    payLinkAmount: null,
    paymentStatus: compatPaymentStatus,
    paymentWorkflowStatus: compatWorkflow,
    addonsRequested: false,
    operationReceipts: appendOperationReceipt(aggregate, {
      idempotencyKey: operationKey,
      fingerprint,
      action: 'addon_mutation',
      actor: actor || (changeRequest ? 'customer' : 'admin'),
      bookingVersion: appliedBookingVersion,
      quoteVersion: nextQuoteVersion,
    }),
    ...paidAtPatches,
    ...openDeltaPatches,
  });

  const committed = await commitBooking({
    bookingId,
    expectedBookingVersion: expected,
    nextAggregate: next,
  });
  if (!committed.ok) {
    if (operationKey && committed.error === 'version_conflict') {
      const concurrent = await getBookingRecord(bookingId);
      if (concurrent.exists) {
        const normalized = normalizeAggregate(concurrent.booking);
        const replay = normalized.ok ? replayResult(normalized.aggregate, operationKey, fingerprint) : null;
        if (replay?.ok) {
          return {
            ok: true,
            noop: true,
            idempotent: true,
            reason: 'idempotent_replay',
            booking: normalized.aggregate,
            projection: materialProjection(normalized.aggregate),
            financialProjection: financialProjection(normalized.aggregate),
            quoteVersion: normalized.aggregate.quoteVersion || normalized.aggregate.quote?.quoteVersion || 0,
          };
        }
      }
    }
    return committed;
  }

  await syncBlobCompatibilityFromProjection(bookingId, pgProjection).catch(() => {});

  const refreshed = await getBookingRecord(bookingId);
  const booking = refreshed.exists ? refreshed.booking : committed.booking;
  const blobFp = financialProjection(booking);
  const material = materialProjection(booking);

  await expireSupersededAttempts(paymentAttempts, env).catch(() => {});

  return {
    ok: true,
    noop: false,
    booking,
    quoteVersion: nextQuoteVersion,
    priorQuoteVersion,
    postgresProjection: mapProjectionForPortals(pgProjection),
    projection: material,
    financialProjection: blobFp,
    remainingCents: remainingCents(booking.ledger || nextLedger),
    adjustment,
    outstandingCreditCents: Math.max(0, Math.round(Number(pgProjection.outstandingCreditCents) || 0)),
    priorAttemptCount,
  };
}

module.exports = {
  applyAddonFinancialMutation,
  canApplyAdditiveAddonAdjustment,
  validateAddonIdsAgainstCatalog,
  settledCentsOf,
};
