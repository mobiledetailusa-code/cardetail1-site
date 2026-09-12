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
const { REQUEST_STORE, syncOpenCatalog } = require('./customer-change-requests');
const { supersedeOpenAttempts, expireSupersededAttempts } = require('./payment-service');
const {
  normalizeIdempotencyKey,
  mutationFingerprint,
  requestIdFromKey,
} = require('./operation-idempotency');
const { buildRescheduleEventId } = require('./appointment-lifecycle-state');

function requestId() {
  return `cr_${crypto.randomBytes(10).toString('base64url')}`;
}

async function rebuildRequestIndex(changeRequest) {
  try {
    const store = await blobsStore(REQUEST_STORE);
    const row = {
      ...changeRequest,
      id: changeRequest.id || changeRequest.requestId,
      rebuildable: true,
      updatedAt: new Date().toISOString(),
    };
    await store.setJSON(row.id, row);
    await syncOpenCatalog(store, row);
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
  idempotencyKey = '',
}) {
  const current = await getBookingRecord(bookingId);
  if (!current.exists) return { ok: false, error: 'not_found', statusCode: 404 };

  const { ok, aggregate } = normalizeAggregate(current.booking);
  if (!ok) return { ok: false, error: 'invalid_aggregate' };

  const operationKey = normalizeIdempotencyKey(idempotencyKey);
  const fingerprint = mutationFingerprint({ bookingId, requestType, target: target || {}, delta: delta || {} });
  if (idempotencyKey && !operationKey) {
    return { ok: false, error: 'invalid_idempotency_key', statusCode: 400 };
  }
  if (operationKey) {
    const replay = asArray(aggregate.changeRequests).find((row) => row?.idempotencyKey === operationKey);
    if (replay) {
      if (replay.requestFingerprint !== fingerprint) {
        return { ok: false, error: 'idempotency_conflict', statusCode: 409 };
      }
      return {
        ok: true,
        idempotent: true,
        booking: aggregate,
        changeRequest: replay,
        projection: materialProjection(aggregate),
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

  let service = aggregate.service;
  let quote = aggregate.quote;
  let schedulePatch = {};
  let proposedApprovedCents = null;
  let proposedQuoteVersion = null;

  const moneyTypes = new Set(['package_change_request', 'addon_request', 'addon_remove_request']);
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
  } else if (requestType === 'vehicle_remove_request') {
    const vehicles = ensureVehicleIds(service.vehicles || []);
    let vehicleId = String(target?.vehicleId || '').trim();
    if (!vehicleId && vehicles.length === 1) vehicleId = vehicles[0].vehicleId;
    if (!vehicleId) {
      return { ok: false, error: 'vehicle_target_required', statusCode: 400 };
    }
    const idx = vehicles.findIndex((v) => String(v.vehicleId) === vehicleId);
    if (idx < 0) {
      return { ok: false, error: 'vehicle_not_found', statusCode: 400 };
    }
    if (vehicles.length <= 1) {
      return {
        ok: false,
        error: 'last_vehicle_denied',
        statusCode: 409,
        message: 'To remove the final vehicle, cancel the appointment or contact us.',
      };
    }
    const openDup = asArray(aggregate.changeRequests).some((r) => {
      const st = String(r.status || '').toLowerCase();
      if (!['pending', 'pending_approval', 'needs_clarification', 'awaiting_admin'].includes(st)) {
        return false;
      }
      const rt = r.type || r.requestType;
      if (rt !== 'vehicle_remove_request') return false;
      return String(r.target?.vehicleId || '') === vehicleId;
    });
    if (openDup) {
      return {
        ok: false,
        error: 'duplicate_pending_request',
        statusCode: 409,
        message: 'A removal request for this vehicle is already pending review.',
      };
    }
    const removed = vehicles[idx];
    const remaining = vehicles.filter((_, i) => i !== idx);
    const travelCents = dollarsToCents(aggregate.travelFeeAmount || aggregate.zoneSurcharge || 0);
    const quoted = quoteService({ ...service, vehicles: remaining }, {
      basedOnBookingVersion: actualVersion,
      previousQuoteVersion: aggregate.quoteVersion || aggregate.quote?.quoteVersion || 0,
      travelCents,
      bookingBase: aggregate,
    });
    if (!quoted.ok) return { ok: false, error: quoted.error || 'invalid_pricing', statusCode: 400 };
    proposedApprovedCents = quoted.quote.approvedCents;
    proposedQuoteVersion = quoted.quote.quoteVersion;
    // Attach proposal snapshot onto delta for admin / customer UI (live booking unchanged)
    delta = {
      ...(delta && typeof delta === 'object' ? delta : {}),
      operation: 'vehicle_remove',
      vehicleSnapshot: {
        vehicleId,
        year: removed.year || '',
        make: removed.make || '',
        model: removed.model || '',
        vehicleLabel: removed.vehicleLabel || removed.label
          || [removed.year, removed.make, removed.model].filter(Boolean).join(' '),
        packageId: removed.packageId || removed.pkgId || '',
        packageName: removed.pkgName || removed.packageName || '',
        addons: Array.isArray(removed.addons) ? removed.addons : [],
        basePrice: removed.basePrice != null ? removed.basePrice : removed.packagePrice,
        subtotal: removed.subtotal,
      },
      currentApprovedCents: Math.round(Number(aggregate.ledger?.approvedCents)
        || dollarsToCents(aggregate.approvedFinalAmount || aggregate.totalPrice || 0) || 0),
      proposedApprovedCents,
    };
    target = { vehicleId };
    service = aggregate.service;
    quote = aggregate.quote;
    schedulePatch = { customerChangePending: true };
  } else if (requestType === 'vehicle_add_request' || requestType === 'vehicle_replace_request') {
    const { applyVehicleOperation } = require('./vehicle-financial-mutation');
    const op = requestType === 'vehicle_add_request' ? 'add' : 'replace';
    const applied = applyVehicleOperation(service, {
      op,
      target: target || {},
      vehicle: delta || {},
    });
    if (!applied.ok) return applied;
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
    delta = {
      ...(delta && typeof delta === 'object' ? delta : {}),
      operation: op === 'add' ? 'vehicle_add' : 'vehicle_replace',
      currentApprovedCents: Math.round(Number(aggregate.ledger?.approvedCents)
        || dollarsToCents(aggregate.approvedFinalAmount || aggregate.totalPrice || 0) || 0),
      proposedApprovedCents,
    };
    service = aggregate.service;
    quote = aggregate.quote;
    schedulePatch = { customerChangePending: true };
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
    requestId: requestIdFromKey(bookingId, operationKey) || requestId(),
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
    idempotencyKey: operationKey || undefined,
    requestFingerprint: operationKey ? fingerprint : undefined,
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
    eventLog: [
      ...asArray(aggregate.eventLog),
      {
        action: 'customer_change_requested',
        requestType,
        requestId: changeRequest.requestId,
        at: changeRequest.submittedAt,
        by: 'customer',
        bookingVersion: actualVersion,
      },
    ],
  };

  if ((moneyTypes.has(requestType)
      || ['vehicle_add_request', 'vehicle_replace_request', 'vehicle_remove_request'].includes(requestType))
    && proposedApprovedCents != null) {
    // Proposal only — do not change ledger until Admin applies
    patches.proposedTotal = (proposedApprovedCents || 0) / 100;
  }

  const next = buildNextAggregate(aggregate, patches);
  const committed = await commitBooking({
    bookingId,
    expectedBookingVersion: expected,
    nextAggregate: next,
  });
  if (!committed.ok) {
    if (operationKey && committed.error === 'version_conflict') {
      const refreshed = await getBookingRecord(bookingId);
      if (refreshed.exists) {
        const normalized = normalizeAggregate(refreshed.booking);
        const replay = normalized.ok
          ? asArray(normalized.aggregate.changeRequests).find((row) => row?.idempotencyKey === operationKey)
          : null;
        if (replay && replay.requestFingerprint === fingerprint) {
          return {
            ok: true,
            idempotent: true,
            booking: normalized.aggregate,
            changeRequest: replay,
            projection: materialProjection(normalized.aggregate),
          };
        }
      }
    }
    return committed;
  }

  const indexResult = await rebuildRequestIndex({
    ...changeRequest,
    bookingId,
    previousState: requestType === 'vehicle_remove_request'
      ? {
        bookingVersion: actualVersion,
        vehicle: (delta && delta.vehicleSnapshot) || {},
        vehicleSubtotal: delta?.vehicleSnapshot?.subtotal,
        packageName: delta?.vehicleSnapshot?.packageName,
        addons: delta?.vehicleSnapshot?.addons || [],
        approvedFinalAmount: (delta?.currentApprovedCents != null
          ? delta.currentApprovedCents / 100
          : undefined),
        paidAmount: Math.max(0, Math.round(Number(aggregate.ledger?.settledCents) || 0)) / 100,
        remainingBalance: Math.max(
          0,
          Math.round(Number(aggregate.ledger?.approvedCents) || 0)
            - Math.round(Number(aggregate.ledger?.settledCents) || 0)
            - Math.round(Number(aggregate.ledger?.creditedCents) || 0)
        ) / 100,
        vehicleCount: ensureVehicleIds(aggregate.service?.vehicles || []).length,
      }
      : { bookingVersion: actualVersion },
    requestedState: {
      ...delta,
      target,
      proposedTotal: changeRequest.proposedApprovedCents != null
        ? changeRequest.proposedApprovedCents / 100
        : undefined,
      quoteVersion: changeRequest.quoteVersion,
      baseBookingVersion: changeRequest.baseBookingVersion,
      priceDifference: changeRequest.proposedApprovedCents != null
        && delta?.currentApprovedCents != null
        ? (changeRequest.proposedApprovedCents - delta.currentApprovedCents) / 100
        : undefined,
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
  idempotencyKey = '',
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

  const decisionKey = normalizeIdempotencyKey(idempotencyKey);
  if (idempotencyKey && !decisionKey) {
    return { ok: false, error: 'invalid_idempotency_key', statusCode: 400 };
  }
  const decisionFingerprint = mutationFingerprint({
    bookingId,
    requestId: reqId,
    decision,
    adminNote: String(adminNote || ''),
    acceptRequote: !!acceptRequote,
  });
  if (decisionKey && cr.decisionIdempotencyKey === decisionKey) {
    if (cr.decisionFingerprint !== decisionFingerprint) {
      return { ok: false, error: 'idempotency_conflict', statusCode: 409 };
    }
    return {
      ok: true,
      idempotent: true,
      booking: aggregate,
      projection: materialProjection(aggregate),
    };
  }

  const terminalStatus = String(cr.status || '').toLowerCase();
  if (['applied', 'approved', 'rejected', 'declined'].includes(terminalStatus)) {
    const sameDecision = (decision === 'approve' && ['applied', 'approved'].includes(terminalStatus))
      || (decision === 'reject' && ['rejected', 'declined'].includes(terminalStatus));
    if (sameDecision) {
      return { ok: true, idempotent: true, booking: aggregate, projection: materialProjection(aggregate) };
    }
    return { ok: false, error: 'request_already_decided', statusCode: 409 };
  }

  cr = {
    ...cr,
    decisionIdempotencyKey: decisionKey || undefined,
    decisionFingerprint: decisionKey ? decisionFingerprint : undefined,
  };

  if (decision === 'reject' || decision === 'clarify') {
    const status = decision === 'reject' ? 'rejected' : 'needs_clarification';
    const nextRequests = requests.length
      ? requests.map((r) => ((r.requestId || r.id) === reqId
        ? { ...r, ...cr, status, decision, adminNote, decidedAt: new Date().toISOString() }
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

  // Stage 1: addon add/remove money goes through authoritative Postgres adjustment.
  {
    const rtAddon = cr.type || cr.requestType;
    if (rtAddon === 'addon_request' || rtAddon === 'addon_remove_request') {
      const { applyAddonFinancialMutation } = require('./addon-financial-mutation');
      const addOnIdsToAdd = rtAddon === 'addon_request'
        ? (cr.delta?.addOnIdsToAdd || cr.delta?.addonIds || asArray(cr.delta?.addons).map((a) => a.id))
        : [];
      const addOnIdsToRemove = rtAddon === 'addon_remove_request'
        ? (cr.delta?.addOnIdsToRemove || cr.delta?.addonIds || asArray(cr.delta?.addons).map((a) => a.id))
        : asArray(cr.delta?.addOnIdsToRemove);
      const addonResult = await applyAddonFinancialMutation({
        bookingId,
        expectedBookingVersion: expected,
        target: cr.target || {},
        addOnIdsToAdd,
        addOnIdsToRemove,
        changeRequest: cr,
        adminNote,
        idempotencyKey: cr.idempotencyKey || '',
        actor: 'customer_request_approved',
      });
      if (!addonResult.ok) return addonResult;
      await rebuildRequestIndex({
        ...cr,
        id: cr.requestId || cr.id,
        bookingId,
        status: 'applied',
        adminDecision: 'approve',
        adminNote,
        decidedAt: new Date().toISOString(),
        appliedAutomatically: true,
        noop: !!addonResult.noop,
        reason: addonResult.reason || null,
        customerVisibleResult: addonResult.noop
          ? 'Already on booking — no price change.'
          : 'Approved — your appointment details and totals were updated.',
      });
      return {
        ok: true,
        noop: !!addonResult.noop,
        idempotent: !!addonResult.idempotent,
        reason: addonResult.reason || undefined,
        booking: addonResult.booking,
        projection: addonResult.projection,
        financialProjection: addonResult.financialProjection,
        postgresProjection: addonResult.postgresProjection,
        quoteVersion: addonResult.quoteVersion,
        outstandingCreditCents: addonResult.outstandingCreditCents || 0,
      };
    }
  }

  // Stage 1: package change money goes through authoritative Postgres adjustment
  // — parallel to the addon branch above; the addon branch is untouched.
  {
    const rtPkg = cr.type || cr.requestType;
    if (rtPkg === 'package_change_request') {
      const { applyPackageFinancialMutation } = require('./package-financial-mutation');
      const packageId = cr.delta?.packageId || cr.delta?.newPackId || cr.delta?.pkgId;
      const pkgResult = await applyPackageFinancialMutation({
        bookingId,
        expectedBookingVersion: expected,
        target: cr.target || {},
        packageId,
        changeRequest: cr,
        adminNote,
        idempotencyKey: cr.idempotencyKey || '',
        actor: 'customer_request_approved',
      });
      if (!pkgResult.ok) return pkgResult;
      await rebuildRequestIndex({
        ...cr,
        id: cr.requestId || cr.id,
        bookingId,
        status: 'applied',
        adminDecision: 'approve',
        adminNote,
        decidedAt: new Date().toISOString(),
        appliedAutomatically: true,
        noop: !!pkgResult.noop,
        reason: pkgResult.reason || null,
        customerVisibleResult: pkgResult.noop
          ? 'Already on booking — no price change.'
          : 'Approved — your appointment details and totals were updated.',
      });
      return {
        ok: true,
        noop: !!pkgResult.noop,
        idempotent: !!pkgResult.idempotent,
        reason: pkgResult.reason || undefined,
        booking: pkgResult.booking,
        projection: pkgResult.projection,
        financialProjection: pkgResult.financialProjection,
        postgresProjection: pkgResult.postgresProjection,
        quoteVersion: pkgResult.quoteVersion,
        outstandingCreditCents: pkgResult.outstandingCreditCents || 0,
      };
    }
  }

  // Vehicle add/edit/remove uses the same immutable quote/delta/credit authority.
  {
    const rtVehicle = cr.type || cr.requestType;
    const opByType = {
      vehicle_add_request: 'add',
      vehicle_replace_request: 'replace',
      vehicle_remove_request: 'remove',
    };
    const vehicleOp = opByType[rtVehicle];
    if (vehicleOp) {
      const { applyVehicleFinancialMutation } = require('./vehicle-financial-mutation');
      const vehicleResult = await applyVehicleFinancialMutation({
        bookingId,
        expectedBookingVersion: expected,
        op: vehicleOp,
        target: cr.target || {},
        vehicle: cr.delta || {},
        changeRequest: cr,
        adminNote,
        idempotencyKey: cr.idempotencyKey || '',
        actor: 'customer_request_approved',
      });
      if (!vehicleResult.ok) return vehicleResult;
      await rebuildRequestIndex({
        ...cr,
        id: cr.requestId || cr.id,
        bookingId,
        status: 'applied',
        adminDecision: 'approve',
        adminNote,
        decidedAt: new Date().toISOString(),
        appliedAutomatically: true,
        noop: !!vehicleResult.noop,
        reason: vehicleResult.reason || null,
        customerVisibleResult: vehicleResult.noop
          ? 'Already applied — no duplicate change.'
          : 'Approved — your vehicle, appointment details, and totals were updated.',
      });
      return {
        ok: true,
        noop: !!vehicleResult.noop,
        idempotent: !!vehicleResult.idempotent,
        reason: vehicleResult.reason || undefined,
        booking: vehicleResult.booking,
        projection: vehicleResult.projection,
        financialProjection: vehicleResult.financialProjection,
        postgresProjection: vehicleResult.postgresProjection,
        quoteVersion: vehicleResult.quoteVersion,
        outstandingCreditCents: vehicleResult.outstandingCreditCents || 0,
      };
    }
  }

  // True drift: booking moved past the version that embedded this pending request.
  // Legacy index rows without embeddedBookingVersion skip this check; CAS still applies.
  const moneyDelta = {
    packageId: cr.delta?.packageId || cr.delta?.newPackId,
    addOnIdsToAdd: cr.delta?.addOnIdsToAdd || cr.delta?.addonIds || asArray(cr.delta?.addons).map((a) => a.id),
    addOnIdsToRemove: cr.delta?.addOnIdsToRemove,
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
  const vehicleTypes = new Set(['vehicle_replace_request', 'vehicle_add_request', 'vehicle_remove_request']);
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
  } else if (rtDecide === 'vehicle_remove_request') {
    const vehicles = ensureVehicleIds(service.vehicles || []);
    let vehicleId = String(cr.target?.vehicleId || '').trim();
    if (!vehicleId && vehicles.length === 1) vehicleId = vehicles[0].vehicleId;
    if (!vehicleId) return { ok: false, error: 'vehicle_target_required', statusCode: 400 };
    const idx = vehicles.findIndex((v) => String(v.vehicleId) === vehicleId);
    if (idx < 0) return { ok: false, error: 'vehicle_not_found', statusCode: 400 };
    if (vehicles.length <= 1) {
      return {
        ok: false,
        error: 'last_vehicle_denied',
        statusCode: 409,
        message: 'To remove the final vehicle, cancel the appointment or contact us.',
      };
    }
    const remaining = vehicles.filter((_, i) => i !== idx);
    service = { ...service, vehicles: remaining };
    const travelCents = dollarsToCents(aggregate.travelFeeAmount || aggregate.zoneSurcharge || 0);
    const quoted = quoteService(service, {
      basedOnBookingVersion: actualVersion,
      previousQuoteVersion: aggregate.quoteVersion || aggregate.quote?.quoteVersion || 0,
      travelCents,
      bookingBase: aggregate,
    });
    if (!quoted.ok) {
      return {
        ok: false,
        error: quoted.error || 'invalid_pricing',
        statusCode: 400,
        message: 'Could not reprice booking after vehicle removal.',
      };
    }
    quote = quoted.quote;
    service = quoted.service;
    ledger = {
      ...ledger,
      approvedCents: quote.approvedCents,
    };
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
    fieldPatches.confirmedDate = fieldPatches.preferredDate;
    fieldPatches.confirmedTime = fieldPatches.preferredTime;
    fieldPatches.status = 'Rescheduled';
    fieldPatches.appointmentStatus = 'confirmed';
    if (!['cancelled', 'archived_test', 'completed_paid'].includes(String(aggregate.jobStatus || ''))) {
      fieldPatches.jobStatus = 'confirmed';
    }
    fieldPatches.rescheduledByClient = false;
    fieldPatches.previousConfirmedDate = aggregate.confirmedDate || aggregate.preferredDate || '';
    fieldPatches.rescheduleEventId = buildRescheduleEventId(
      aggregate.id || aggregate.bookingId,
      fieldPatches.confirmedDate,
      fieldPatches.confirmedTime
    );
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
    const canceledAt = aggregate.canceledAt || new Date().toISOString();
    fieldPatches.status = 'Cancelled';
    fieldPatches.jobStatus = 'cancelled';
    fieldPatches.appointmentStatus = 'canceled';
    fieldPatches.cancellationRequestStatus = 'approved';
    fieldPatches.canceledAt = canceledAt;
    fieldPatches.cancellationActor = aggregate.cancellationActor || 'customer';
    fieldPatches.cancellationEventId = aggregate.cancellationEventId
      || `cancelled:${aggregate.id || aggregate.bookingId}:${canceledAt}`;
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

// Re-export Stage 1 addon financial API for callers/tests.
module.exports.applyAddonFinancialMutation = (...args) => {
  const { applyAddonFinancialMutation } = require('./addon-financial-mutation');
  return applyAddonFinancialMutation(...args);
};
module.exports.canApplyAdditiveAddonAdjustment = (...args) => {
  const { canApplyAdditiveAddonAdjustment } = require('./addon-financial-mutation');
  return canApplyAdditiveAddonAdjustment(...args);
};
