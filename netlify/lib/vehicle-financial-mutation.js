'use strict';

/**
 * Canonical appointment-vehicle mutation.
 *
 * Vehicle identity/service state is committed with booking-version CAS. Money
 * is repriced server-side and becomes one immutable PostgreSQL quote
 * adjustment. Existing quote, ledger, receipt, and removed-vehicle snapshots
 * are never deleted.
 */

const { getBookingRecord, commitBooking } = require('./booking-repository');
const {
  normalizeAggregate,
  buildNextAggregate,
  materialProjection,
  ensureVehicleIds,
  newVehicleId,
  remainingCents,
} = require('./booking-aggregate');
const { quoteService } = require('./canonical-quote');
const { coerceVehicleForCategory, PRICING } = require('./booking-price-catalog');
const { normalizeLengthCategory, usesLengthPricing } = require('./length-pricing');
const { dollarsToCents, asArray } = require('./historical-adapter');
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

const VEHICLE_OPS = new Set(['add', 'replace', 'remove']);

function normalizedVehicleInput(raw = {}) {
  const category = normalizeLengthCategory(raw.category || raw.cat || raw.vehicleCategory || 'cars');
  const year = String(raw.year || raw.vehicleYear || '').trim().slice(0, 8);
  const make = String(raw.make || raw.vehicleMake || '').trim().slice(0, 60);
  const model = String(raw.model || raw.vehicleModel || '').trim().slice(0, 60);
  const packageId = String(raw.packageId || raw.newPackId || raw.pkgId || '').trim().slice(0, 32);
  const packageName = String(raw.packageName || raw.newPackName || raw.pkgName || '').trim().slice(0, 120);
  const tierKey = String(raw.tierKey || raw.tier || '').trim().slice(0, 32);
  const tierLabel = String(raw.tierLabel || '').trim().slice(0, 80);
  const lengthFt = Number(raw.lengthFt || raw.vehicleLengthFt || 0);
  const vehicleLabel = String(
    raw.vehicleLabel || raw.label || [year, make, model].filter(Boolean).join(' ')
  ).trim().slice(0, 160);
  return {
    category,
    year,
    make,
    model,
    packageId,
    packageName,
    tierKey,
    tier: tierKey,
    tierLabel,
    lengthFt: Number.isFinite(lengthFt) ? lengthFt : 0,
    vehicleLabel,
    label: vehicleLabel,
  };
}

function validateVehicleInput(vehicle) {
  if (!vehicle.category || !vehicle.year || !vehicle.make || !vehicle.model) {
    return { ok: false, error: 'vehicle_fields_required', statusCode: 400 };
  }
  if (!vehicle.packageId) return { ok: false, error: 'package_id_required', statusCode: 400 };
  if (!usesLengthPricing(vehicle.category)
    && Object.keys(PRICING[vehicle.category]?.tiers || {}).length
    && !vehicle.tierKey) {
    return { ok: false, error: 'vehicle_tier_required', statusCode: 400 };
  }
  if (usesLengthPricing(vehicle.category) && !(vehicle.lengthFt > 0)) {
    return { ok: false, error: 'vehicle_length_required', statusCode: 400 };
  }
  return { ok: true };
}

function resolveTargetVehicle(vehicles, target = {}) {
  let vehicleId = String(target.vehicleId || target.targetVehicleId || '').trim();
  if (!vehicleId && vehicles.length === 1) vehicleId = vehicles[0].vehicleId;
  if (!vehicleId) return { ok: false, error: 'vehicle_target_required', statusCode: 400 };
  const index = vehicles.findIndex((vehicle) => String(vehicle.vehicleId) === vehicleId);
  if (index < 0) return { ok: false, error: 'vehicle_not_found', statusCode: 404 };
  return { ok: true, vehicleId, index, vehicle: vehicles[index] };
}

function applyVehicleOperation(service, { op, target = {}, vehicle: rawVehicle = {} } = {}) {
  if (!VEHICLE_OPS.has(op)) return { ok: false, error: 'invalid_vehicle_op', statusCode: 400 };
  const vehicles = ensureVehicleIds(service?.vehicles || []);
  if (op === 'remove') {
    const resolved = resolveTargetVehicle(vehicles, target);
    if (!resolved.ok) return resolved;
    if (vehicles.length <= 1) {
      return { ok: false, error: 'last_vehicle_denied', statusCode: 409 };
    }
    return {
      ok: true,
      service: { ...service, vehicles: vehicles.filter((_, index) => index !== resolved.index) },
      vehicleId: resolved.vehicleId,
      priorVehicle: resolved.vehicle,
    };
  }

  const input = normalizedVehicleInput(rawVehicle);
  const valid = validateVehicleInput(input);
  if (!valid.ok) return valid;

  if (op === 'add') {
    const coerced = coerceVehicleForCategory(input, input.category, input);
    const nextVehicle = { ...coerced, ...input, vehicleId: newVehicleId(), addons: [], addOnIds: [] };
    return {
      ok: true,
      service: { ...service, vehicles: [...vehicles, nextVehicle] },
      vehicleId: nextVehicle.vehicleId,
      nextVehicle,
    };
  }

  const resolved = resolveTargetVehicle(vehicles, target);
  if (!resolved.ok) return resolved;
  const sameCategory = normalizeLengthCategory(resolved.vehicle.category || resolved.vehicle.cat || 'cars')
    === input.category;
  const coerced = coerceVehicleForCategory(resolved.vehicle, input.category, input);
  const nextVehicle = {
    ...coerced,
    ...input,
    vehicleId: resolved.vehicleId,
    addons: sameCategory ? asArray(resolved.vehicle.addons) : [],
    addOnIds: sameCategory ? asArray(resolved.vehicle.addOnIds) : [],
  };
  const nextVehicles = vehicles.slice();
  nextVehicles[resolved.index] = nextVehicle;
  return {
    ok: true,
    service: { ...service, vehicles: nextVehicles },
    vehicleId: resolved.vehicleId,
    priorVehicle: resolved.vehicle,
    nextVehicle,
  };
}

function compatStatuses(aggregate, projection) {
  const paymentStatus = projection.paymentStatus === 'paid'
    ? 'paid'
    : projection.paymentStatus === 'processing'
      ? 'processing'
      : projection.paymentStatus === 'refunded'
        ? 'refunded'
        : projection.paymentStatus === 'due'
          ? 'due'
          : (aggregate.paymentStatus || 'no_payment_required_yet');
  const workflow = projection.paymentStatus === 'paid'
    ? (String(aggregate.paymentWorkflowStatus || '').toLowerCase() === 'cash_paid'
      ? 'cash_paid' : 'payment_succeeded')
    : ['processing', 'due'].includes(projection.paymentStatus)
      ? 'awaiting_customer_payment'
      : (aggregate.paymentWorkflowStatus || null);
  return { paymentStatus, workflow };
}

async function applyVehicleFinancialMutation({
  bookingId,
  expectedBookingVersion,
  op,
  target = {},
  vehicle = {},
  changeRequest = null,
  adminNote = '',
  idempotencyKey = '',
  actor = '',
  env = process.env,
}) {
  if (!VEHICLE_OPS.has(op)) return { ok: false, error: 'invalid_vehicle_op', statusCode: 400 };
  const current = await getBookingRecord(bookingId);
  if (!current.exists) return { ok: false, error: 'not_found', statusCode: 404 };
  const normalized = normalizeAggregate(current.booking);
  if (!normalized.ok) return { ok: false, error: 'invalid_aggregate', statusCode: 400 };
  const aggregate = normalized.aggregate;

  const operationKey = normalizeIdempotencyKey(idempotencyKey);
  if (idempotencyKey && !operationKey) {
    return { ok: false, error: 'invalid_idempotency_key', statusCode: 400 };
  }
  const normalizedInput = op === 'remove' ? {} : normalizedVehicleInput(vehicle);
  const fingerprint = mutationFingerprint({
    bookingId,
    action: `vehicle_${op}`,
    target: target || {},
    vehicle: normalizedInput,
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

  const actualVersion = Math.max(0, Math.round(Number(aggregate.bookingVersion) || 0));
  const expected = Math.round(Number(expectedBookingVersion));
  if (!Number.isFinite(expected) || expected !== actualVersion) {
    return {
      ok: false,
      error: 'version_conflict',
      statusCode: 409,
      actualBookingVersion: actualVersion,
    };
  }

  const applied = applyVehicleOperation(aggregate.service, {
    op,
    target,
    vehicle: normalizedInput,
  });
  if (!applied.ok) return applied;
  const travelCents = dollarsToCents(aggregate.travelFeeAmount || aggregate.zoneSurcharge || 0);
  const quoted = quoteService(applied.service, {
    basedOnBookingVersion: actualVersion,
    previousQuoteVersion: aggregate.quoteVersion || aggregate.quote?.quoteVersion || 0,
    travelCents,
    bookingBase: aggregate,
  });
  if (!quoted.ok) {
    return { ok: false, error: quoted.error || 'invalid_pricing', statusCode: 400 };
  }
  if (!postgresPaymentEnabled(env)) {
    return { ok: false, error: 'postgres_payment_disabled', statusCode: 503 };
  }

  const ensured = await ensureBookingFinancial(aggregate);
  if (!ensured.ok) return { ok: false, error: ensured.error || 'ensure_failed', statusCode: 503 };
  const beforeProjection = await authority.getFinancialProjection(bookingId);
  const priorQuoteVersion = beforeProjection?.quoteVersion || ensured.quoteVersion || 1;
  const adjustment = await authority.createAdjustment({
    bookingId,
    newApprovedCents: quoted.quote.approvedCents,
    reason: `vehicle_${op}`,
    adjustmentId: adjustmentIdFromKey(`veh${op}`, bookingId, operationKey)
      || `vehicle_${op}_${bookingId}_${actualVersion}_${quoted.quote.approvedCents}`.slice(0, 96),
    expectedQuoteVersion: priorQuoteVersion,
    approvedBy: actor || (changeRequest ? 'customer_request_approved' : 'admin'),
  });
  if (!adjustment.ok) {
    return {
      ok: false,
      error: adjustment.error || 'adjustment_failed',
      statusCode: adjustment.statusCode || 409,
      actualQuoteVersion: adjustment.actualQuoteVersion,
    };
  }
  const pgProjection = adjustment.after || await authority.getFinancialProjection(bookingId);
  if (!pgProjection) return { ok: false, error: 'projection_unavailable', statusCode: 500 };

  const nextQuoteVersion = pgProjection.quoteVersion;
  const nextLedger = {
    ...aggregate.ledger,
    currency: 'usd',
    approvedCents: pgProjection.approvedCents,
    settledCents: pgProjection.settledCents,
    creditedCents: Math.max(0, Math.round(Number(aggregate.ledger?.creditedCents) || 0)),
    refundedCents: Math.max(0, Math.round(Number(pgProjection.refundedCents) || 0)),
    entries: asArray(aggregate.ledger?.entries),
  };
  const nextQuote = {
    ...quoted.quote,
    quoteVersion: nextQuoteVersion,
    approvedCents: pgProjection.approvedCents,
  };
  const paymentAttempts = supersedeOpenAttempts(aggregate.paymentAttempts, { quoteVersion: nextQuoteVersion });
  const appliedBookingVersion = actualVersion + 1;
  let changeRequests = asArray(aggregate.changeRequests);
  if (changeRequest && (changeRequest.requestId || changeRequest.id)) {
    const requestId = changeRequest.requestId || changeRequest.id;
    changeRequests = changeRequests.map((row) => (
      (row.requestId || row.id) === requestId
        ? {
          ...row,
          ...changeRequest,
          status: 'applied',
          decision: 'approve',
          adminNote: adminNote || '',
          decidedAt: new Date().toISOString(),
          appliedBookingVersion,
        }
        : row
    ));
  }
  const compat = compatStatuses(aggregate, pgProjection);
  const history = asArray(aggregate.vehicleHistory);
  if (applied.priorVehicle) {
    history.push({
      ...applied.priorVehicle,
      historyStatus: op === 'remove' ? 'removed' : 'replaced',
      historyAt: new Date().toISOString(),
      historyActor: actor || (changeRequest ? 'customer_request_approved' : 'admin'),
    });
  }
  const openDeltaPatches = {};
  if (pgProjection.remainingCents > 0) {
    openDeltaPatches._historicalPaidClosed = false;
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
  const at = new Date().toISOString();
  const next = buildNextAggregate(aggregate, {
    service: quoted.service,
    quote: nextQuote,
    quoteVersion: nextQuoteVersion,
    ledger: nextLedger,
    paymentAttempts,
    changeRequests,
    customerChangePending: changeRequests.some((row) => ['pending', 'pending_approval'].includes(row.status)),
    vehicleHistory: history.slice(-200),
    vehicleChangeRequested: false,
    requestedVehicleLabel: '',
    requestedVehicleCategory: '',
    requestedVehicleYear: '',
    requestedVehicleMake: '',
    requestedVehicleModel: '',
    requestedVehicleLengthFt: 0,
    requestedVehicleAction: '',
    payLink: '',
    stripeCheckoutSessionId: '',
    payLinkAmount: null,
    paymentStatus: compat.paymentStatus,
    paymentWorkflowStatus: compat.workflow,
    operationReceipts: appendOperationReceipt(aggregate, {
      idempotencyKey: operationKey,
      fingerprint,
      action: `vehicle_${op}`,
      actor: actor || (changeRequest ? 'customer' : 'admin'),
      bookingVersion: appliedBookingVersion,
      quoteVersion: nextQuoteVersion,
      at,
    }),
    eventLog: [
      ...asArray(aggregate.eventLog),
      {
        action: `vehicle_${op}`,
        vehicleId: applied.vehicleId,
        by: actor || (changeRequest ? 'customer_request_approved' : 'admin'),
        at,
        priorBookingVersion: actualVersion,
        quoteVersion: nextQuoteVersion,
      },
    ],
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
        const retryAggregate = normalizeAggregate(concurrent.booking);
        const replay = retryAggregate.ok
          ? replayResult(retryAggregate.aggregate, operationKey, fingerprint)
          : null;
        if (replay?.ok) {
          return {
            ok: true,
            noop: true,
            idempotent: true,
            reason: 'idempotent_replay',
            booking: retryAggregate.aggregate,
            projection: materialProjection(retryAggregate.aggregate),
            financialProjection: financialProjection(retryAggregate.aggregate),
            quoteVersion: retryAggregate.aggregate.quoteVersion || retryAggregate.aggregate.quote?.quoteVersion || 0,
          };
        }
      }
    }
    return committed;
  }

  await syncBlobCompatibilityFromProjection(bookingId, pgProjection).catch(() => {});
  await expireSupersededAttempts(paymentAttempts, env).catch(() => {});
  const refreshed = await getBookingRecord(bookingId);
  const booking = refreshed.exists ? refreshed.booking : committed.booking;
  return {
    ok: true,
    booking,
    op,
    vehicleId: applied.vehicleId,
    quoteVersion: nextQuoteVersion,
    priorQuoteVersion,
    projection: materialProjection(booking),
    financialProjection: financialProjection(booking),
    postgresProjection: mapProjectionForPortals(pgProjection),
    remainingCents: remainingCents(booking.ledger || nextLedger),
    outstandingCreditCents: Math.max(0, Math.round(Number(pgProjection.outstandingCreditCents) || 0)),
    adjustment,
  };
}

module.exports = {
  VEHICLE_OPS,
  normalizedVehicleInput,
  validateVehicleInput,
  applyVehicleOperation,
  applyVehicleFinancialMutation,
};
