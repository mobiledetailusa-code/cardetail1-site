/**
 * Canonical command boundary for Release A booking mutations.
 */

const crypto = require('crypto');
const { getBookingRecord, commitBooking } = require('./booking-repository');
const {
  normalizeAggregate,
  buildNextAggregate,
  materialProjection,
  remainingCents,
  ensureVehicleIds,
  newVehicleId,
} = require('./booking-aggregate');
const { quoteService, applyServiceDelta } = require('./canonical-quote');
const { dollarsToCents, asArray } = require('./historical-adapter');
const { blobsStore } = require('./tech-security');
const { REQUEST_STORE } = require('./customer-change-requests');
const { supersedeOpenAttempts, expireSupersededAttempts } = require('./payment-service');

function requestId() {
  return `cr_${crypto.randomBytes(10).toString('base64url')}`;
}

async function rebuildRequestIndex(changeRequest) {
  try {
    const store = await blobsStore(REQUEST_STORE);
    await store.setJSON(changeRequest.id || changeRequest.requestId, {
      ...changeRequest,
      id: changeRequest.id || changeRequest.requestId,
      rebuildable: true,
      updatedAt: new Date().toISOString(),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || 'index_write_failed' };
  }
}

/**
 * Submit a customer change request — embeds on aggregate, rebuilds index after commit.
 */
async function submitChangeRequestCommand({
  bookingId,
  expectedBookingVersion,
  requestType,
  target,
  delta,
  authorizedRef,
  extraPatches = {},
}) {
  const current = await getBookingRecord(bookingId);
  if (!current.exists) return { ok: false, error: 'not_found', statusCode: 404 };

  const { ok, aggregate } = normalizeAggregate(current.booking);
  if (!ok) return { ok: false, error: 'invalid_aggregate' };

  const actualVersion = Math.round(Number(aggregate.bookingVersion) || 0);
  const expected = expectedBookingVersion != null
    ? Math.round(Number(expectedBookingVersion))
    : actualVersion;
  if (actualVersion !== expected) {
    return { ok: false, error: 'version_conflict', statusCode: 409, actualBookingVersion: actualVersion };
  }

  let service = aggregate.service;
  let quote = aggregate.quote;
  let schedulePatch = {};
  let proposedApprovedCents = null;
  let proposedQuoteVersion = null;

  const moneyTypes = new Set(['package_change_request', 'addon_request']);
  if (moneyTypes.has(requestType)) {
    // Proposal only — compute quote from a tentative service delta, but do NOT mutate
    // live service/quote until Admin approve. Premature apply caused approve noop → version_conflict.
    const applied = applyServiceDelta(service, target, delta);
    if (!applied.ok) return { ok: false, error: applied.error, statusCode: 400 };
    if (applied.noop) {
      return {
        ok: true,
        noop: true,
        reason: applied.reason || 'duplicate_addon',
        booking: aggregate,
        projection: materialProjection(aggregate),
      };
    }
    const travelCents = dollarsToCents(aggregate.travelFeeAmount || aggregate.zoneSurcharge || 0);
    const quoted = quoteService(applied.service, {
      basedOnBookingVersion: actualVersion,
      previousQuoteVersion: aggregate.quoteVersion || aggregate.quote?.quoteVersion || 0,
      travelCents,
      bookingBase: aggregate,
    });
    if (!quoted.ok) return { ok: false, error: quoted.error || 'invalid_pricing', statusCode: 400 };
    proposedApprovedCents = quoted.quote.approvedCents;
    proposedQuoteVersion = quoted.quote.quoteVersion;
    // Keep live service + quote unchanged until decide(approve)
    service = aggregate.service;
    quote = aggregate.quote;
  } else if (requestType === 'reschedule_request') {
    schedulePatch = {
      rescheduledByClient: true,
      rescheduleRequestedDate: delta?.requestedDate || '',
      rescheduleRequestedTime: delta?.requestedTime || '',
      customerChangePending: true,
    };
  } else if (requestType === 'address_update') {
    // Jobber-style: request only until admin approve — do not mutate live address on submit.
    schedulePatch = {
      addressChangedByClient: true,
      requestedAddress: delta?.serviceAddress || delta?.address || '',
      customerChangePending: true,
    };
  } else {
    schedulePatch = { customerChangePending: true };
  }

  const reqVersion = asArray(aggregate.changeRequests).length + 1;
  const changeRequest = {
    requestId: requestId(),
    id: null, // set below
    requestVersion: reqVersion,
    // Service/quote basis (before this write)
    baseBookingVersion: actualVersion,
    // Version after embedding this request — decide uses this to detect true drift
    embeddedBookingVersion: actualVersion + 1,
    quoteVersion: quote?.quoteVersion || aggregate.quoteVersion || 0,
    type: requestType,
    requestType,
    target: target || {},
    delta: delta || {},
    status: 'pending',
    submittedBy: authorizedRef || 'customer',
    submittedAt: new Date().toISOString(),
    proposedApprovedCents: proposedApprovedCents != null
      ? proposedApprovedCents
      : (quote?.approvedCents ?? null),
    proposedQuoteVersion: proposedQuoteVersion,
  };
  changeRequest.id = changeRequest.requestId;

  const nextRequests = [...asArray(aggregate.changeRequests), changeRequest];
  const patches = {
    service,
    quote,
    quoteVersion: quote?.quoteVersion || aggregate.quoteVersion,
    changeRequests: nextRequests,
    customerChangePending: true,
    ...schedulePatch,
    ...(extraPatches && typeof extraPatches === 'object' ? extraPatches : {}),
  };

  if (moneyTypes.has(requestType) && proposedApprovedCents != null) {
    // Proposal only — do not change ledger until Admin applies
    patches.proposedTotal = (proposedApprovedCents || 0) / 100;
  }

  const next = buildNextAggregate(aggregate, patches);
  const committed = await commitBooking({
    bookingId,
    expectedBookingVersion: expected,
    nextAggregate: next,
  });
  if (!committed.ok) return committed;

  const indexResult = await rebuildRequestIndex({
    ...changeRequest,
    bookingId,
    previousState: { bookingVersion: actualVersion },
    requestedState: {
      ...delta,
      target,
      proposedTotal: changeRequest.proposedApprovedCents != null
        ? changeRequest.proposedApprovedCents / 100
        : undefined,
      quoteVersion: changeRequest.quoteVersion,
      baseBookingVersion: changeRequest.baseBookingVersion,
    },
    status: 'pending',
    authorizedRef,
  });

  return {
    ok: true,
    booking: committed.booking,
    changeRequest,
    indexOk: indexResult.ok,
    projection: materialProjection(committed.booking),
  };
}

/**
 * Admin decide — apply or reject; stale versions → 409 or requote.
 * Applied status and next booking version commit atomically.
 */
async function decideChangeRequestCommand({
  bookingId,
  requestId: reqId,
  decision,
  expectedBookingVersion,
  expectedQuoteVersion,
  adminNote,
  acceptRequote = false,
}) {
  const current = await getBookingRecord(bookingId);
  if (!current.exists) return { ok: false, error: 'not_found', statusCode: 404 };

  const { ok, aggregate } = normalizeAggregate(current.booking);
  if (!ok) return { ok: false, error: 'invalid_aggregate' };

  const actualVersion = Math.round(Number(aggregate.bookingVersion) || 0);
  const expected = expectedBookingVersion != null
    ? Math.round(Number(expectedBookingVersion))
    : actualVersion;

  const requests = asArray(aggregate.changeRequests);
  let cr = requests.find((r) => (r.requestId || r.id) === reqId);
  // Fallback: load from index for legacy requests not yet embedded
  if (!cr) {
    try {
      const store = await blobsStore(REQUEST_STORE);
      const indexed = await store.get(reqId, { type: 'json' });
      if (indexed && indexed.bookingId === bookingId) {
        cr = {
          requestId: indexed.id,
          id: indexed.id,
          requestVersion: indexed.requestVersion || 1,
          baseBookingVersion: indexed.requestedState?.baseBookingVersion
            ?? indexed.baseBookingVersion
            ?? actualVersion,
          quoteVersion: indexed.requestedState?.quoteVersion ?? indexed.quoteVersion ?? 0,
          type: indexed.requestType,
          requestType: indexed.requestType,
          target: indexed.requestedState?.target || {},
          delta: indexed.requestedState || {},
          status: indexed.status,
          proposedApprovedCents: indexed.requestedState?.proposedTotal != null
            ? dollarsToCents(indexed.requestedState.proposedTotal)
            : null,
        };
      }
    } catch { /* ignore */ }
  }
  if (!cr) return { ok: false, error: 'request_not_found', statusCode: 404 };

  if (cr.status === 'applied' && decision === 'approve') {
    return { ok: true, idempotent: true, booking: aggregate, projection: materialProjection(aggregate) };
  }

  if (decision === 'reject' || decision === 'clarify') {
    const status = decision === 'reject' ? 'rejected' : 'needs_clarification';
    const nextRequests = requests.length
      ? requests.map((r) => ((r.requestId || r.id) === reqId
        ? { ...r, status, decision, adminNote, decidedAt: new Date().toISOString() }
        : r))
      : [{ ...cr, status, decision, adminNote, decidedAt: new Date().toISOString() }];
    const next = buildNextAggregate(aggregate, {
      changeRequests: nextRequests,
      customerChangePending: nextRequests.some((r) => r.status === 'pending'),
    });
    // Allow reject even if version drifted slightly when expected omitted — still CAS
    const committed = await commitBooking({
      bookingId,
      expectedBookingVersion: expected,
      nextAggregate: next,
    });
    if (!committed.ok) return committed;
    await rebuildRequestIndex({
      ...cr,
      id: cr.requestId || cr.id,
      bookingId,
      status,
      adminDecision: decision,
      adminNote,
      decidedAt: new Date().toISOString(),
    });
    return { ok: true, booking: committed.booking, projection: materialProjection(committed.booking) };
  }

  if (decision !== 'approve') return { ok: false, error: 'invalid_decision', statusCode: 400 };

  if (actualVersion !== expected) {
    return { ok: false, error: 'version_conflict', statusCode: 409, actualBookingVersion: actualVersion };
  }

  // Jobber/HCP: paid invoice cannot auto-apply pack/addon/vehicle money mutations.
  {
    const { isInvoicePaid } = require('./appointment-status-policy');
    const moneyOrVehicle = new Set([
      'package_change_request', 'addon_request',
      'vehicle_replace_request', 'vehicle_add_request',
    ]);
    const rtEarly = cr.type || cr.requestType;
    if (moneyOrVehicle.has(rtEarly) && isInvoicePaid(aggregate)) {
      return {
        ok: false,
        error: 'invoice_paid',
        statusCode: 409,
        message: 'Invoice paid — create an adjustment or new quote instead of approving this money change.',
      };
    }
  }
  // True drift: booking moved past the version that embedded this pending request.
  // Legacy index rows without embeddedBookingVersion skip this check; CAS still applies.
  const moneyDelta = {
    packageId: cr.delta?.packageId || cr.delta?.newPackId,
    addOnIdsToAdd: cr.delta?.addOnIdsToAdd || cr.delta?.addonIds || asArray(cr.delta?.addons).map((a) => a.id),
    packageName: cr.delta?.packageName,
    vehicleCategory: cr.delta?.vehicleCategory || cr.delta?.category,
    tierKey: cr.delta?.tierKey || cr.delta?.tier,
    tierLabel: cr.delta?.tierLabel,
    lengthFt: cr.delta?.lengthFt,
  };
  const embeddedAt = cr.embeddedBookingVersion != null
    ? Math.round(Number(cr.embeddedBookingVersion) || 0)
    : actualVersion;
  let alreadyOnBooking = false;
  if (actualVersion !== embeddedAt) {
    const probe = applyServiceDelta(aggregate.service, cr.target || {}, moneyDelta);
    if (!probe.ok) {
      return { ok: false, error: 'version_conflict', statusCode: 409, reason: 'stale_base' };
    }
    if (probe.noop) {
      // Requested delta already present (common after older submit-applied-live bug).
      alreadyOnBooking = true;
    } else if (!acceptRequote) {
      const travelCents = dollarsToCents(aggregate.travelFeeAmount || aggregate.zoneSurcharge || 0);
      const requoted = quoteService(probe.service, {
        basedOnBookingVersion: actualVersion,
        previousQuoteVersion: aggregate.quoteVersion || 0,
        travelCents,
        bookingBase: aggregate,
      });
      return {
        ok: false,
        error: 'version_conflict',
        statusCode: 409,
        requoteRequired: true,
        quote: requoted.ok ? requoted.quote : null,
        message: 'Booking changed since this request. Confirm to approve with the updated quote.',
      };
    } else {
      const travelCents = dollarsToCents(aggregate.travelFeeAmount || aggregate.zoneSurcharge || 0);
      const requoted = quoteService(probe.service, {
        basedOnBookingVersion: actualVersion,
        previousQuoteVersion: aggregate.quoteVersion || 0,
        travelCents,
        bookingBase: aggregate,
      });
      if (!requoted.ok) return { ok: false, error: requoted.error || 'invalid_pricing', statusCode: 400 };
      cr = {
        ...cr,
        baseBookingVersion: actualVersion,
        embeddedBookingVersion: actualVersion,
        quoteVersion: requoted.quote.quoteVersion,
        delta: cr.delta,
        proposedApprovedCents: requoted.quote.approvedCents,
      };
    }
  }

  const moneyTypes = new Set(['package_change_request', 'addon_request']);
  const vehicleTypes = new Set(['vehicle_replace_request', 'vehicle_add_request']);
  let service = aggregate.service;
  let quote = aggregate.quote;
  let ledger = aggregate.ledger;
  const rtDecide = cr.type || cr.requestType;

  if (moneyTypes.has(rtDecide) && !alreadyOnBooking) {
    const applied = applyServiceDelta(service, cr.target || {}, moneyDelta);
    if (!applied.ok) return { ok: false, error: applied.error, statusCode: 400 };
    if (applied.noop) {
      // Idempotent approve — mark applied below without requoting.
      alreadyOnBooking = true;
    } else {
      service = applied.service;
      const travelCents = dollarsToCents(aggregate.travelFeeAmount || aggregate.zoneSurcharge || 0);
      const quoted = quoteService(service, {
        basedOnBookingVersion: actualVersion,
        previousQuoteVersion: aggregate.quoteVersion || aggregate.quote?.quoteVersion || 0,
        travelCents,
        bookingBase: aggregate,
      });
      if (!quoted.ok) return { ok: false, error: quoted.error, statusCode: 400 };
      quote = quoted.quote;
      service = quoted.service;

      if (expectedQuoteVersion != null
        && Math.round(Number(expectedQuoteVersion)) !== Math.round(Number(cr.quoteVersion) || 0)
        && Math.round(Number(expectedQuoteVersion)) !== quote.quoteVersion) {
        return { ok: false, error: 'quote_version_conflict', statusCode: 409 };
      }

      // Never trust proposedTotal from client/index — use canonical quote
      ledger = {
        ...ledger,
        approvedCents: quote.approvedCents,
      };
    }
  } else if (vehicleTypes.has(rtDecide)) {
    const { normalizeLengthCategory } = require('./length-pricing');
    const { coerceVehicleForCategory } = require('./booking-price-catalog');
    const d = cr.delta || {};
    const category = normalizeLengthCategory(d.category || d.vehicleCategory || 'cars');
    const label = d.vehicleLabel || d.label
      || [d.year, d.make, d.model].filter(Boolean).join(' ').trim();
    const packageName = d.packageName || d.pkgName || '';
    if (rtDecide === 'vehicle_replace_request') {
      const vehicles = ensureVehicleIds(service.vehicles || []);
      let vehicleId = cr.target?.vehicleId;
      if (!vehicleId && vehicles.length === 1) vehicleId = vehicles[0].vehicleId;
      const idx = vehicles.findIndex((v) => v.vehicleId === vehicleId);
      if (idx < 0) return { ok: false, error: 'vehicle_not_found', statusCode: 400 };
      const coerced = coerceVehicleForCategory(vehicles[idx], category, {
        packageId: d.packageId || d.newPackId || d.pkgId,
        packageName,
        tierKey: d.tierKey || d.tier,
        tierLabel: d.tierLabel,
        lengthFt: d.lengthFt,
        vehicleLabel: label,
      });
      const nextVehicles = vehicles.slice();
      nextVehicles[idx] = {
        ...coerced,
        year: d.year != null ? String(d.year) : coerced.year,
        make: d.make != null ? String(d.make) : coerced.make,
        model: d.model != null ? String(d.model) : coerced.model,
        vehicleLabel: label || coerced.vehicleLabel,
        label: label || coerced.label,
      };
      service = { ...service, vehicles: nextVehicles };
    } else {
      // vehicle_add_request — append a new priced vehicle
      const vehicles = ensureVehicleIds(service.vehicles || []);
      const primary = vehicles[0] || {};
      const coerced = coerceVehicleForCategory({
        category,
        year: d.year || '',
        make: d.make || '',
        model: d.model || '',
        vehicleLabel: label,
        packageId: d.packageId || d.newPackId || primary.packageId || primary.pkgId || '',
        packageName: packageName || primary.pkgName || primary.packageName || '',
        tierKey: d.tierKey || d.tier || primary.tierKey || '',
        lengthFt: d.lengthFt,
        addOnIds: [],
        addons: [],
      }, category, {
        packageId: d.packageId || d.newPackId || primary.packageId || primary.pkgId,
        packageName: packageName || primary.pkgName || primary.packageName,
        tierKey: d.tierKey || d.tier || primary.tierKey,
        lengthFt: d.lengthFt,
        vehicleLabel: label,
      });
      vehicles.push({
        ...coerced,
        vehicleId: newVehicleId(),
      });
      service = { ...service, vehicles };
    }
    const travelCents = dollarsToCents(aggregate.travelFeeAmount || aggregate.zoneSurcharge || 0);
    const quoted = quoteService(service, {
      basedOnBookingVersion: actualVersion,
      previousQuoteVersion: aggregate.quoteVersion || aggregate.quote?.quoteVersion || 0,
      travelCents,
      bookingBase: {
        ...aggregate,
        vehicleCategory: category,
        // Avoid stale RV length/tier on bookingBase during car requote
        lengthFt: category === 'cars' ? 0 : (d.lengthFt || aggregate.lengthFt || 0),
      },
    });
    if (!quoted.ok) {
      return {
        ok: false,
        error: quoted.error || 'invalid_pricing',
        statusCode: 400,
        message: 'Could not price this vehicle change. Pick a car package and size (SUV/truck), then try again.',
      };
    }
    quote = quoted.quote;
    service = quoted.service;
    ledger = {
      ...ledger,
      approvedCents: quote.approvedCents,
    };
  }

  const appliedBookingVersion = actualVersion + 1;
  const nextRequests = (requests.length ? requests : [cr]).map((r) => {
    if ((r.requestId || r.id) !== (cr.requestId || cr.id)) return r;
    return {
      ...r,
      ...cr,
      status: 'applied',
      decision: 'approve',
      adminNote,
      decidedAt: new Date().toISOString(),
      appliedBookingVersion,
    };
  });

  let paymentAttempts = supersedeOpenAttempts(aggregate.paymentAttempts, {
    quoteVersion: quote?.quoteVersion || aggregate.quoteVersion,
  });

  const fieldPatches = {};
  const rt = rtDecide;
  if (rt === 'reschedule_request') {
    fieldPatches.preferredDate = cr.delta?.requestedDate || cr.delta?.preferredDate || aggregate.preferredDate;
    fieldPatches.preferredTime = cr.delta?.requestedTime || cr.delta?.preferredTime || aggregate.preferredTime;
    fieldPatches.rescheduledByClient = false;
  }
  if (rt === 'address_update') {
    const newAddr = String(cr.delta?.serviceAddress || cr.delta?.address || aggregate.address || '').trim();
    fieldPatches.address = newAddr;
    fieldPatches.requestedAddress = '';
    fieldPatches.addressChangedByClient = false;
    // Keep nested service in sync — normalizeAggregate must not revive the old address.
    service = {
      ...(service && typeof service === 'object' ? service : {}),
      serviceAddress: newAddr,
      vehicles: ensureVehicleIds(
        (service && Array.isArray(service.vehicles) ? service.vehicles : aggregate.service?.vehicles) || []
      ),
    };
  }
  if (rt === 'cancellation' || rt === 'cancellation_request') {
    fieldPatches.status = 'Cancelled';
    fieldPatches.jobStatus = 'cancelled';
    fieldPatches.appointmentStatus = 'canceled';
    fieldPatches.cancellationRequestStatus = 'approved';
  }
  if (vehicleTypes.has(rt)) {
    fieldPatches.vehicleChangeRequested = false;
    fieldPatches.requestedVehicleLabel = '';
    fieldPatches.requestedVehicleCategory = '';
    fieldPatches.requestedVehicleYear = '';
    fieldPatches.requestedVehicleMake = '';
    fieldPatches.requestedVehicleModel = '';
    fieldPatches.requestedVehicleLengthFt = 0;
    fieldPatches.requestedVehicleAction = '';
  }

  const next = buildNextAggregate(aggregate, {
    service,
    quote,
    quoteVersion: quote?.quoteVersion,
    ledger,
    changeRequests: nextRequests,
    paymentAttempts,
    customerChangePending: false,
    packageChangeRequested: false,
    addonsRequested: false,
    // Clear local pay link projections; provider expire is caller's job
    payLink: '',
    stripeCheckoutSessionId: '',
    payLinkAmount: null,
    ...fieldPatches,
  });

  const committed = await commitBooking({
    bookingId,
    expectedBookingVersion: expected,
    nextAggregate: next,
  });
  if (!committed.ok) return committed;

  await rebuildRequestIndex({
    ...cr,
    id: cr.requestId || cr.id,
    bookingId,
    status: 'applied',
    adminDecision: 'approve',
    adminNote,
    decidedAt: new Date().toISOString(),
    appliedBookingVersion,
    appliedAutomatically: true,
    customerVisibleResult: 'Approved — your appointment details and totals were updated.',
  });

  const expiredAttemptIds = asArray(paymentAttempts)
    .filter((a) => a.status === 'superseded')
    .map((a) => a.providerObjectId)
    .filter(Boolean);
  // Provider-side expire — local supersede alone is insufficient
  const expireResult = await expireSupersededAttempts(paymentAttempts, process.env);

  return {
    ok: true,
    booking: committed.booking,
    projection: materialProjection(committed.booking),
    expiredAttemptIds,
    providerExpire: expireResult,
  };
}

/**
 * Apply approved money via canonical quote (Admin adjustment path).
 */
async function setApprovedQuoteCommand({
  bookingId,
  expectedBookingVersion,
  service,
  travelCents = 0,
  adjustmentCents = 0,
  offerCents = 0,
}) {
  const current = await getBookingRecord(bookingId);
  if (!current.exists) return { ok: false, error: 'not_found' };
  const { ok, aggregate } = normalizeAggregate(current.booking);
  if (!ok) return { ok: false, error: 'invalid_aggregate' };

  const expected = Math.round(Number(expectedBookingVersion ?? aggregate.bookingVersion) || 0);
  const svc = service || aggregate.service;
  const quoted = quoteService(svc, {
    basedOnBookingVersion: expected,
    previousQuoteVersion: aggregate.quoteVersion || 0,
    travelCents,
    adjustmentCents,
    offerCents,
    bookingBase: aggregate,
  });
  if (!quoted.ok) return quoted;

  const ledger = {
    ...aggregate.ledger,
    approvedCents: quoted.quote.approvedCents,
  };
  const paymentAttempts = supersedeOpenAttempts(aggregate.paymentAttempts, {
    quoteVersion: quoted.quote.quoteVersion,
  });

  const next = buildNextAggregate(aggregate, {
    service: quoted.service,
    quote: quoted.quote,
    quoteVersion: quoted.quote.quoteVersion,
    ledger,
    paymentAttempts,
    payLink: '',
    stripeCheckoutSessionId: '',
    payLinkAmount: null,
  });

  const committed = await commitBooking({
    bookingId,
    expectedBookingVersion: expected,
    nextAggregate: next,
  });
  if (!committed.ok) return committed;

  const expireResult = await expireSupersededAttempts(paymentAttempts, process.env);
  return {
    ...committed,
    expiredAttemptIds: asArray(paymentAttempts)
      .filter((a) => a.status === 'superseded')
      .map((a) => a.providerObjectId)
      .filter(Boolean),
    providerExpire: expireResult,
  };
}

module.exports = {
  submitChangeRequestCommand,
  decideChangeRequestCommand,
  setApprovedQuoteCommand,
  rebuildRequestIndex,
  materialProjection,
  remainingCents,
};
