// Customer-initiated booking actions with rate limiting, status policy, and change-request records.

const { blobsStore } = require('../lib/tech-security');
const { getBooking, bookingStore } = require('../lib/ops-db');
const { authorizeBookingAccess, normalizeBookingId } = require('../lib/booking-customer-auth');
const { canRequestChange } = require('../lib/appointment-status-policy');
const { createChangeRequest, sanitizeSnapshot } = require('../lib/customer-change-requests');
const { enforcePublicRateLimit } = require('../lib/public-rate-limit');
const { projectBookingForCustomer } = require('../lib/ops-schema');
const { normalizeIdempotencyKey } = require('../lib/operation-idempotency');

function safeBooking(booking) {
  return booking ? projectBookingForCustomer(booking) : null;
}

async function notifyAdmin(subject, text) {
  const { ADMIN_EMAIL, RESEND_API_KEY, RESEND_FROM } = process.env;
  if (!ADMIN_EMAIL || !RESEND_API_KEY) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: RESEND_FROM || 'Cardetail1 <onboarding@resend.dev>',
        to: [ADMIN_EMAIL],
        subject,
        text,
      }),
    });
  } catch (e) {
    console.warn('[submit-customer-action] email error:', e.message);
  }
}

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const json = (status, body) => ({ statusCode: status, headers: CORS, body: JSON.stringify(body) });

const ACTION_MAP = {
  reschedule_request: 'reschedule',
  address_update: 'address',
  addon_request: 'addon',
  package_change_request: 'package_change',
  vehicle_add_request: 'vehicle_add',
  vehicle_replace_request: 'vehicle_replace',
  vehicle_remove_request: 'vehicle_remove',
  addon_remove_request: 'addon',
  maintenance_request: 'maintenance',
  cancellation_request: 'cancel',
};

/** Auto-apply pending CR so totals update without Admin approve click. */
async function autoApplySubmittedRequest(bookingId, cmd) {
  if (!cmd || !cmd.ok || !cmd.changeRequest) return cmd;
  const { decideChangeRequestCommand } = require('../lib/booking-commands');
  const decided = await decideChangeRequestCommand({
    bookingId,
    requestId: cmd.changeRequest.requestId || cmd.changeRequest.id,
    decision: 'approve',
    expectedBookingVersion: cmd.booking?.bookingVersion,
    acceptRequote: true,
  });
  if (!decided.ok) {
    return {
      ok: false,
      error: decided.error || 'apply_failed',
      statusCode: decided.statusCode || 400,
      message: decided.message
        || (decided.error === 'invalid_pricing'
          ? 'Could not price this change. For trailer → SUV, select a car package and size, then try again.'
          : 'Change saved as a request but could not auto-apply. Call/text 551-373-5668.'),
      changeRequest: cmd.changeRequest,
      booking: cmd.booking,
    };
  }
  return {
    ok: true,
    applied: true,
    idempotent: !!cmd.idempotent || !!decided.idempotent,
    noop: !!decided.noop,
    reason: decided.reason || undefined,
    pendingApproval: false,
    booking: decided.booking,
    projection: decided.projection,
    financialProjection: decided.financialProjection || null,
    postgresProjection: decided.postgresProjection || null,
    quoteVersion: decided.quoteVersion,
    changeRequest: {
      ...cmd.changeRequest,
      status: 'applied',
    },
  };
}

function addonMutationResponse(appliedCmd, {
  policy,
  changeRequestId = null,
  custName = '',
  adminSubjectLocal = '',
  adminTextLocal = '',
}) {
  const proj = appliedCmd.postgresProjection
    || appliedCmd.financialProjection
    || null;
  const proposed = appliedCmd.changeRequest?.proposedApprovedCents != null
    ? appliedCmd.changeRequest.proposedApprovedCents / 100
    : (appliedCmd.booking?.approvedFinalAmount != null
      ? Number(appliedCmd.booking.approvedFinalAmount)
      : null);
  const appliedTotal = appliedCmd.booking?.approvedFinalAmount != null
    ? Number(appliedCmd.booking.approvedFinalAmount)
    : proposed;
  if (adminSubjectLocal && !appliedCmd.idempotent) {
    notifyAdmin(
      adminSubjectLocal.replace('Request', appliedCmd.applied ? 'Updated' : 'Request'),
      `${adminTextLocal}${appliedTotal != null ? `\nTotal: $${Number(appliedTotal).toFixed(2)}` : ''}\n\nCustomer: ${custName}`
    ).catch(() => {});
  }
  return json(200, {
    ok: true,
    changeRequestId: changeRequestId || appliedCmd.changeRequest?.requestId || null,
    pendingApproval: !!policy.pendingApproval && !appliedCmd.applied,
    applied: !!appliedCmd.applied,
    idempotent: !!appliedCmd.idempotent,
    noop: !!appliedCmd.noop,
    reason: appliedCmd.reason || undefined,
    bookingVersion: appliedCmd.booking?.bookingVersion,
    quoteVersion: appliedCmd.quoteVersion || appliedCmd.booking?.quoteVersion
      || appliedCmd.changeRequest?.quoteVersion,
    proposedTotal: appliedTotal,
    approvedFinalAmount: appliedCmd.booking?.approvedFinalAmount,
    projection: appliedCmd.projection,
    financialProjection: appliedCmd.financialProjection || null,
    postgresProjection: appliedCmd.postgresProjection || null,
    approvedCents: proj?.approvedCents ?? null,
    settledCents: proj?.settledCents ?? null,
    remainingCents: proj?.remainingCents ?? null,
    outstandingCreditCents: appliedCmd.outstandingCreditCents
      ?? proj?.outstandingCreditCents
      ?? 0,
    booking: safeBooking(appliedCmd.booking),
  });
}

const ALLOWED_ACTIONS = new Set(Object.keys(ACTION_MAP));

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });

  const rateLimit = await enforcePublicRateLimit(event, { endpoint: 'submit-customer-action', cors: false });
  if (rateLimit.blocked) return rateLimit.response;

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'validation_error' }); }

  const bookingId = normalizeBookingId(p.bookingId);
  const action = String(p.action || '');

  if (!bookingId) return json(400, { ok: false, error: 'validation_error', message: 'Booking ID is required.' });
  if (!ALLOWED_ACTIONS.has(action)) return json(400, { ok: false, error: 'validation_error', message: 'Invalid action.' });

  const auth = await authorizeBookingAccess(event, { bookingId, phone: p.phone || p.customerPhone });
  if (!auth.ok) {
    const code = auth.error || 'authentication_failed';
    const statusCode = auth.statusCode || (code === 'validation_error' ? 400 : 200);
    return json(statusCode, { ok: false, error: code, message: auth.message });
  }

  const booking = auth.booking;
  if (p.expectedBookingVersion == null || p.expectedBookingVersion === '') {
    return json(400, {
      ok: false,
      error: 'expected_booking_version_required',
      message: 'expectedBookingVersion is required.',
    });
  }
  const expectedBookingVersion = Math.round(Number(p.expectedBookingVersion));
  if (!Number.isFinite(expectedBookingVersion) || expectedBookingVersion < 0) {
    return json(400, {
      ok: false,
      error: 'validation_error',
      message: 'expectedBookingVersion is invalid.',
    });
  }
  const idempotencyKey = normalizeIdempotencyKey(p.idempotencyKey || p.requestKey);
  if (!idempotencyKey) {
    return json(400, {
      ok: false,
      error: 'idempotency_key_required',
      message: 'A valid idempotency key is required.',
    });
  }
  const policyAction = ACTION_MAP[action];
  const policy = canRequestChange(booking, policyAction);
  if (!policy.ok) {
    return json(200, {
      ok: false,
      error: policy.error || 'action_not_allowed',
      message: policy.message
        || (policy.requiresCall
          ? 'This appointment is in progress. Please call or text Cardetail1 for changes.'
          : 'This change is not available for your appointment status.'),
    });
  }

  const now = new Date().toISOString();
  let updates = {};
  let requestedState = {};
  let logEntry = { action, at: now, by: 'customer' };
  let adminSubject = '';
  let adminText = '';
  const custName = `${booking.firstName || ''} ${booking.lastName || ''}`.trim();

  if (action === 'reschedule_request') {
    const newDate = String(p.newDate || '').slice(0, 20).trim();
    const newTime = String(p.newTime || '').slice(0, 80).trim();
    if (!newDate) return json(400, { ok: false, error: 'validation_error', message: 'Please provide a new preferred date.' });
    requestedState = { preferredDate: newDate, preferredTime: newTime || '' };
    if (policy.pendingApproval) {
      updates = {
        rescheduledByClient: true,
        rescheduleRequestedAt: now,
        rescheduleRequestedDate: newDate,
        rescheduleRequestedTime: newTime || '',
        customerChangePending: true,
      };
    } else {
      updates = {
        rescheduledByClient: true,
        rescheduleRequestedAt: now,
        rescheduleRequestedDate: newDate,
        rescheduleRequestedTime: newTime || '',
        preferredDate: newDate,
        preferredTime: newTime || booking.preferredTime || '',
      };
    }
    logEntry.requestedDate = newDate;
    if (newTime) logEntry.requestedTime = newTime;
    adminSubject = `Cardetail1 — Reschedule Request · ${bookingId}`;
    adminText = `Customer requested reschedule for booking ${bookingId}.\nRequested date: ${newDate}${newTime ? `\nRequested time: ${newTime}` : ''}`;
  } else if (action === 'address_update') {
    const newAddress = String(p.newAddress || '').slice(0, 400).trim();
    if (!newAddress) return json(400, { ok: false, error: 'validation_error', message: 'Please provide a new address.' });
    requestedState = { address: newAddress };
    updates = {
      addressChangedByClient: true,
      addressUpdateRequestedAt: now,
      requestedAddress: newAddress,
      customerChangePending: policy.pendingApproval || false,
    };
    if (!policy.pendingApproval) updates.address = newAddress;
    logEntry.requestedAddress = newAddress;
    adminSubject = `Cardetail1 — Address Update Request · ${bookingId}`;
    adminText = `Customer requested address change for booking ${bookingId}.\nRequested: ${newAddress}`;
  } else if (action === 'addon_remove_request') {
    // Remove only IDs actually present on the selected vehicle; empty/absent is a safe noop.
    const {
      parseAddonIdList,
      currentAddonIdsOnBooking,
    } = require('../lib/canonical-addon-catalog');
    const { submitChangeRequestCommand } = require('../lib/booking-commands');

    const requestedIds = parseAddonIdList(p.addonIds || p.addOnIdsToRemove || p.removeAddonIds);
    if (!requestedIds.length) {
      return json(200, {
        ok: true,
        noop: true,
        reason: 'empty_remove',
        message: 'No add-on to remove.',
        changeRequestId: null,
        quoteVersion: booking.quoteVersion || booking.quote?.quoteVersion || 0,
        bookingVersion: booking.bookingVersion,
        booking: safeBooking(booking),
      });
    }

    const onBooking = new Set(currentAddonIdsOnBooking(booking, p.vehicleId));
    const addonIds = requestedIds.filter((id) => onBooking.has(id));
    if (!addonIds.length) {
      return json(200, {
        ok: true,
        noop: true,
        reason: 'addon_not_present',
        message: 'Selected add-on is not on this booking.',
        changeRequestId: null,
        quoteVersion: booking.quoteVersion || booking.quote?.quoteVersion || 0,
        bookingVersion: booking.bookingVersion,
        booking: safeBooking(booking),
      });
    }

    // Ignore browser price / label / total — IDs only.
    const cmd = await submitChangeRequestCommand({
      bookingId,
      expectedBookingVersion,
      requestType: 'addon_remove_request',
      target: { vehicleId: p.vehicleId || undefined },
      delta: { addOnIdsToRemove: addonIds, addonIds },
      authorizedRef: auth.scope,
      idempotencyKey,
    });
    if (cmd.noop) {
      return json(200, {
        ok: true,
        noop: true,
        reason: cmd.reason || 'addon_not_present',
        message: 'Selected add-on is not on this booking.',
        changeRequestId: null,
        quoteVersion: booking.quoteVersion || booking.quote?.quoteVersion || 0,
        bookingVersion: booking.bookingVersion,
        booking: safeBooking(booking),
      });
    }
    if (!cmd.ok) {
      const status = cmd.statusCode || 400;
      return json(status, {
        ok: false,
        error: cmd.error || 'request_failed',
        message: cmd.error === 'version_conflict'
          ? 'This booking changed. Refresh and try again.'
          : undefined,
      });
    }

    let appliedCmd = cmd;
    if (!policy.pendingApproval) {
      appliedCmd = await autoApplySubmittedRequest(bookingId, cmd);
      if (!appliedCmd.ok) {
        return json(appliedCmd.statusCode || 400, {
          ok: false,
          error: appliedCmd.error || 'apply_failed',
          message: appliedCmd.message,
          changeRequestId: cmd.changeRequest?.requestId || null,
        });
      }
    }
    return addonMutationResponse(appliedCmd, {
      policy,
      changeRequestId: appliedCmd.changeRequest?.requestId,
      custName,
      adminSubjectLocal: `Cardetail1 — Add-On Removal · ${bookingId}`,
      adminTextLocal: `Customer removed add-ons for booking ${bookingId}.\n${addonIds.join(', ')}`,
    });
  } else if (action === 'addon_request') {
    // Release A: money requests go through versioned command + canonical quote (PDA-01/02/05/07)
    const { submitChangeRequestCommand } = require('../lib/booking-commands');
    const { parseAddonIdList } = require('../lib/canonical-addon-catalog');

    const target = { vehicleId: p.vehicleId || undefined };
    const addonIds = parseAddonIdList(p.addonIds || p.addOnIdsToAdd);
    if (!addonIds.length && !String(p.requestedAddons || '').trim()) {
      return json(400, { ok: false, error: 'validation_error', message: 'Please select at least one add-on.' });
    }
    // Browser price/label/total ignored — IDs only; Stage 1 mutation prices from catalog.
    const delta = { addOnIdsToAdd: addonIds, addonIds, requestedAddons: addonIds.join(', ') };
    const adminSubjectLocal = `Cardetail1 — Add-On Request · ${bookingId}`;
    const adminTextLocal = `Customer requested add-ons for booking ${bookingId}.\n${addonIds.join(', ')}`;

    const cmd = await submitChangeRequestCommand({
      bookingId,
      expectedBookingVersion,
      requestType: action,
      target,
      delta,
      authorizedRef: auth.scope,
      idempotencyKey,
    });
    if (cmd.noop) {
      const included = cmd.reason === 'addon_included_in_package';
      return json(200, {
        ok: true,
        noop: true,
        reason: cmd.reason || 'duplicate_addon',
        message: included
          ? 'That treatment is already included in the selected package.'
          : 'Selected add-on is already on this booking.',
        changeRequestId: null,
        booking: safeBooking(booking),
      });
    }
    if (!cmd.ok) {
      const status = cmd.statusCode || 400;
      return json(status, {
        ok: false,
        error: cmd.error || 'request_failed',
        message: cmd.error === 'version_conflict'
          ? 'This booking changed. Refresh and try again.'
          : (cmd.error === 'invalid_pricing' ? 'Selected add-on could not be priced.' : undefined),
      });
    }

    let appliedCmd = cmd;
    if (!policy.pendingApproval) {
      appliedCmd = await autoApplySubmittedRequest(bookingId, cmd);
      if (!appliedCmd.ok) {
        return json(appliedCmd.statusCode || 400, {
          ok: false,
          error: appliedCmd.error || 'apply_failed',
          message: appliedCmd.message,
          changeRequestId: cmd.changeRequest?.requestId || null,
        });
      }
    }
    return addonMutationResponse(appliedCmd, {
      policy,
      changeRequestId: appliedCmd.changeRequest?.requestId,
      custName,
      adminSubjectLocal,
      adminTextLocal,
    });
  } else if (action === 'package_change_request') {
    // Package Stage 2: honor browser expectedBookingVersion; money via Stage 1 mutator only.
    const { submitChangeRequestCommand } = require('../lib/booking-commands');
    const {
      usesLengthPricing,
      normalizeLengthCategory,
    } = require('../lib/length-pricing');
    const {
      packageDisplayName,
      packageOptionsForVehicle,
      validatePackageIdForVehicle,
    } = require('../lib/package-financial-mutation');
    const { normalizeAggregate, ensureVehicleIds } = require('../lib/booking-aggregate');

    // Post-payment requests remain Admin-reviewed; the financial mutator creates
    // an immutable delta or explicit outstanding credit after approval.
    const newPackId = String(p.newPackId || p.packageId || '').slice(0, 32).trim();
    if (!newPackId) {
      return json(400, { ok: false, error: 'validation_error', message: 'Please select a package.' });
    }

    const { ok: aggOk, aggregate } = normalizeAggregate(booking);
    if (!aggOk) {
      return json(400, { ok: false, error: 'invalid_aggregate' });
    }
    const vehicles = ensureVehicleIds(aggregate.service?.vehicles || []);
    let vehicleId = String(p.vehicleId || '').trim() || undefined;
    if (!vehicleId && vehicles.length === 1) vehicleId = vehicles[0].vehicleId;
    if (!vehicleId) {
      return json(400, {
        ok: false,
        error: 'vehicle_target_required',
        message: 'Select which vehicle this package change applies to.',
      });
    }

    const validated = validatePackageIdForVehicle(
      aggregate.service,
      { vehicleId },
      newPackId,
      aggregate
    );
    if (!validated.ok) {
      const err = validated.error || 'unknown_package_id';
      return json(validated.statusCode || 400, {
        ok: false,
        error: err,
        message: err === 'unknown_package_id'
          ? 'That package is not available for this vehicle.'
          : (err === 'vehicle_not_found'
            ? 'Selected vehicle was not found on this booking.'
            : 'Unable to change package for this vehicle.'),
        validPackageIds: validated.validPackageIds,
      });
    }

    const targetVehicle = vehicles.find((v) => v.vehicleId === vehicleId) || {};
    const vehicleCategory = normalizeLengthCategory(
      validated.category
        || targetVehicle.category
        || targetVehicle.cat
        || p.vehicleCategory
        || booking.vehicleCategory
        || booking.cat
        || 'cars'
    );
    const lengthFt = Number(
      p.lengthFt || p.vehicleLengthFt || targetVehicle.lengthFt || booking.vehicleLengthFt || booking.lengthFt || 0
    );
    if (usesLengthPricing(vehicleCategory) && !(lengthFt > 0)) {
      return json(400, {
        ok: false,
        error: 'validation_error',
        message: 'Enter vessel / RV length in feet for accurate pricing.',
      });
    }

    const newPackName = validated.option?.name
      || packageDisplayName(vehicleCategory, newPackId);
    const { PRICING } = require('../lib/booking-price-catalog');
    const carTiers = (PRICING.cars && PRICING.cars.tiers) || {};
    const tierCandidates = [
      p.tier, p.vehicleTier, p.tierKey,
      targetVehicle.tierKey, targetVehicle.tier,
      booking.vehicleTier, booking.tierKey,
    ].map((t) => String(t || '').trim()).filter(Boolean);
    let tierKey = '';
    for (const candidate of tierCandidates) {
      if (carTiers[candidate]) { tierKey = candidate; break; }
    }
    if (!tierKey) {
      const tierLabel = String(p.tierLabel || targetVehicle.tierLabel || booking.tierLabel || '').trim();
      if (tierLabel) {
        for (const [key, tier] of Object.entries(carTiers)) {
          if (tier && tier.label === tierLabel) { tierKey = key; break; }
        }
      }
    }
    if (!tierKey && vehicleCategory === 'cars') {
      // Preserve vehicle tier from catalog probe rather than inventing a default tier rewrite.
      const probed = packageOptionsForVehicle(targetVehicle, aggregate);
      tierKey = String(targetVehicle.tierKey || targetVehicle.tier || '').trim();
      if (!tierKey && probed.category === 'cars') tierKey = 'suv3';
    }

    const delta = {
      packageId: newPackId,
      newPackId,
      packageName: newPackName,
      vehicleCategory,
      lengthFt: usesLengthPricing(vehicleCategory) ? lengthFt : 0,
      tierKey: tierKey || undefined,
      tier: tierKey || undefined,
    };
    // Ignore any browser money fields — Stage 1 prices from booking-price-catalog only.
    const adminSubjectLocal = `Cardetail1 — Package Change Request · ${bookingId}`;
    const adminTextLocal = `Customer requested package change for booking ${bookingId}.\nRequested: ${newPackName}`;

    const cmd = await submitChangeRequestCommand({
      bookingId,
      expectedBookingVersion,
      requestType: 'package_change_request',
      target: { vehicleId },
      delta,
      authorizedRef: auth.scope,
      idempotencyKey,
    });
    if (cmd.noop) {
      return json(200, {
        ok: true,
        noop: true,
        reason: cmd.reason || 'package_unchanged',
        message: cmd.reason === 'package_unchanged'
          ? 'That package is already on your booking — no change needed.'
          : 'No package change needed.',
        changeRequestId: null,
        bookingVersion: booking.bookingVersion,
        quoteVersion: booking.quoteVersion || booking.quote?.quoteVersion || 0,
        booking: safeBooking(booking),
      });
    }
    if (!cmd.ok) {
      const status = cmd.statusCode || 400;
      const err = cmd.error || 'request_failed';
      let message;
      if (err === 'version_conflict') {
        message = 'This booking changed. Refresh and try again.';
      } else if (err === 'invalid_pricing') {
        message = 'Selected package could not be priced with your current add-ons. Your package and add-ons were not changed.';
      } else if (err === 'unknown_package_id') {
        message = 'That package is not available for this vehicle.';
      } else if (err === 'vehicle_target_required') {
        message = 'Select which vehicle this package change applies to.';
      }
      return json(status, {
        ok: false,
        error: err,
        message,
        actualBookingVersion: cmd.actualBookingVersion,
      });
    }

    let appliedCmd = cmd;
    if (!policy.pendingApproval) {
      appliedCmd = await autoApplySubmittedRequest(bookingId, cmd);
      if (!appliedCmd.ok) {
        const err = appliedCmd.error || 'apply_failed';
        let message = appliedCmd.message;
        if (err === 'invalid_pricing') {
          message = 'Selected package could not be priced with your current add-ons. Your package and add-ons were not changed.';
        } else if (err === 'version_conflict') {
          message = 'This booking changed. Refresh and try again.';
        } else if (err === 'unknown_package_id') {
          message = 'That package is not available for this vehicle.';
        } else if (err === 'package_unchanged') {
          message = 'That package is already on your booking — no change needed.';
        }
        return json(appliedCmd.statusCode || 400, {
          ok: false,
          error: err,
          message,
          changeRequestId: cmd.changeRequest?.requestId || null,
          actualBookingVersion: appliedCmd.actualBookingVersion,
        });
      }
    }

    if (appliedCmd.noop && appliedCmd.reason === 'package_unchanged') {
      return json(200, {
        ok: true,
        noop: true,
        reason: 'package_unchanged',
        message: 'That package is already on your booking — no change needed.',
        changeRequestId: appliedCmd.changeRequest?.requestId || null,
        bookingVersion: appliedCmd.booking?.bookingVersion,
        quoteVersion: appliedCmd.quoteVersion || appliedCmd.booking?.quoteVersion || 0,
        booking: safeBooking(appliedCmd.booking),
      });
    }

    return addonMutationResponse(appliedCmd, {
      policy,
      changeRequestId: appliedCmd.changeRequest?.requestId,
      custName,
      adminSubjectLocal,
      adminTextLocal,
    });
  } else if (action === 'vehicle_remove_request') {
    const { submitChangeRequestCommand } = require('../lib/booking-commands');
    const { ensureVehicleIds } = require('../lib/booking-aggregate');

    const vehicleId = String(p.vehicleId || '').trim();
    if (!vehicleId) {
      return json(400, {
        ok: false,
        error: 'validation_error',
        message: 'vehicleId is required.',
      });
    }
    const vehicles = ensureVehicleIds(
      booking.service?.vehicles || booking.vehicles || []
    );
    const targetVehicle = vehicles.find((v) => String(v.vehicleId) === vehicleId);
    if (!targetVehicle) {
      return json(400, { ok: false, error: 'vehicle_not_found', message: 'That vehicle is not on this booking.' });
    }
    if (vehicles.length <= 1) {
      return json(409, {
        ok: false,
        error: 'last_vehicle_denied',
        message: 'To remove the final vehicle, cancel the appointment or contact us.',
      });
    }

    const cmd = await submitChangeRequestCommand({
      bookingId,
      expectedBookingVersion,
      requestType: 'vehicle_remove_request',
      target: { vehicleId },
      delta: {},
      authorizedRef: auth.scope,
      idempotencyKey,
    });
    if (!cmd.ok) {
      return json(cmd.statusCode || 400, {
        ok: false,
        error: cmd.error || 'submit_failed',
        message: cmd.message
          || (cmd.error === 'duplicate_pending_request'
            ? 'A removal request for this vehicle is already pending review.'
            : cmd.error === 'last_vehicle_denied'
              ? 'To remove the final vehicle, cancel the appointment or contact us.'
              : cmd.error === 'version_conflict'
                ? 'This booking changed. Refresh My Garage and try again.'
                : 'Could not submit vehicle removal request.'),
        actualBookingVersion: cmd.actualBookingVersion,
      });
    }

    // Never auto-apply — admin must approve (policy.pendingApproval should be true).
    const proposedCents = cmd.changeRequest?.proposedApprovedCents;
    const vehicleLabel = targetVehicle.vehicleLabel || targetVehicle.label
      || [targetVehicle.year, targetVehicle.make, targetVehicle.model].filter(Boolean).join(' ')
      || 'Vehicle';
    if (!cmd.idempotent) {
      await notifyAdmin(
        `Cardetail1 — Vehicle removal request · ${bookingId}`,
        `Customer requested removal of ${vehicleLabel} (${vehicleId}) from booking ${bookingId}.`
      );
    }

    return json(200, {
      ok: true,
      pendingApproval: true,
      applied: false,
      idempotent: !!cmd.idempotent,
      changeRequestId: cmd.changeRequest?.requestId || cmd.changeRequest?.id,
      bookingVersion: cmd.booking?.bookingVersion,
      proposedTotal: proposedCents != null ? proposedCents / 100 : null,
      proposedApprovedCents: proposedCents,
      vehicleId,
      vehicleLabel,
      vehicleSubtotal: targetVehicle.subtotal,
      projection: cmd.projection,
      message: 'Removal requested — Pending review',
      booking: safeBooking(cmd.booking),
    });
  } else if (action === 'vehicle_add_request' || action === 'vehicle_replace_request') {
    const { usesLengthPricing } = require('../lib/length-pricing');
    const { normalizeLengthCategory } = require('../lib/length-pricing');
    const { ensureVehicleIds } = require('../lib/booking-aggregate');
    const category = normalizeLengthCategory(String(p.category || p.vehicleCategory || 'cars').slice(0, 32).trim());
    const year = String(p.year || p.vehicleYear || '').slice(0, 8).trim();
    const make = String(p.make || p.vehicleMake || '').slice(0, 60).trim();
    const model = String(p.model || p.vehicleModel || '').slice(0, 60).trim();
    const lengthFt = Number(p.lengthFt || p.vehicleLengthFt || 0);
    const vehicleLabel = String(p.vehicleLabel || p.label || [year, make, model].filter(Boolean).join(' ')).slice(0, 160).trim();
    if (!vehicleLabel && !(make && model)) {
      return json(400, { ok: false, error: 'validation_error', message: 'Select category, year, make, and model.' });
    }
    if (usesLengthPricing(category) && !(lengthFt > 0)) {
      return json(400, { ok: false, error: 'validation_error', message: 'Enter length in feet for boats and RVs.' });
    }
    const label = vehicleLabel || `${year} ${make} ${model}`.trim();
    const packageId = String(p.packageId || p.newPackId || '').slice(0, 32).trim();
    const packageName = String(p.packageName || p.newPackName || '').slice(0, 120).trim();
    const tierKey = String(p.tierKey || p.tier || '').slice(0, 32).trim();
    if (!packageId) {
      return json(400, {
        ok: false,
        error: 'validation_error',
        message: usesLengthPricing(category)
          ? 'Select a package for this boat / RV / trailer.'
          : 'Select a package for the new vehicle.',
      });
    }
    if (category === 'cars' && !tierKey) {
      return json(400, {
        ok: false,
        error: 'validation_error',
        message: 'Select vehicle size (Small Car, SUV 2-Row, SUV 3-Row, or Truck).',
      });
    }
    let targetVehicleId = String(p.vehicleId || p.targetVehicleId || '').slice(0, 64).trim();
    if (action === 'vehicle_replace_request') {
      const vehicles = ensureVehicleIds(booking.service?.vehicles || booking.vehicles || []);
      if (!targetVehicleId && vehicles.length === 1) targetVehicleId = vehicles[0].vehicleId;
      if (!targetVehicleId) {
        return json(400, {
          ok: false,
          error: 'vehicle_target_required',
          message: 'Select which vehicle to replace.',
        });
      }
      if (!vehicles.some((vehicle) => String(vehicle.vehicleId) === targetVehicleId)) {
        return json(404, {
          ok: false,
          error: 'vehicle_not_found',
          message: 'That vehicle is not on this booking.',
        });
      }
    }
    requestedState = {
      vehicleLabel: label,
      category,
      vehicleCategory: category,
      year,
      make,
      model,
      lengthFt: lengthFt || 0,
      packageId,
      packageName,
      tierKey,
      tier: tierKey,
      targetVehicleId: targetVehicleId || undefined,
    };
    updates = {
      vehicleChangeRequested: true,
      vehicleChangeRequestedAt: now,
      requestedVehicleLabel: label,
      requestedVehicleCategory: category,
      requestedVehicleYear: year,
      requestedVehicleMake: make,
      requestedVehicleModel: model,
      requestedVehicleLengthFt: lengthFt || 0,
      requestedVehiclePackageId: packageId,
      requestedVehicleAction: action === 'vehicle_replace_request' ? 'replace' : 'add',
      customerChangePending: true,
    };
    logEntry.vehicleLabel = label;
    adminSubject = `Cardetail1 — Vehicle Change Request · ${bookingId}`;
    adminText = `Customer requested vehicle ${action === 'vehicle_replace_request' ? 'replacement' : 'addition'} for booking ${bookingId}.\n${label} (${category}${lengthFt ? `, ${lengthFt} ft` : ''}${packageName || packageId ? `, pack ${packageName || packageId}` : ''})`;
  } else if (action === 'maintenance_request') {
    const { CAR_PACKAGES, MAINTENANCE_PERIODS } = require('../lib/customer-catalog');
    const periodId = String(p.period || p.maintenancePeriod || '').slice(0, 32).trim();
    const packId = String(p.packageId || p.maintenancePackageId || '').slice(0, 32).trim();
    const period = MAINTENANCE_PERIODS.find((x) => x.id === periodId);
    const pack = CAR_PACKAGES.find((x) => x.id === packId);
    const note = String(p.note || p.message || '').slice(0, 1000).trim();
    if (!period || !pack) {
      return json(400, { ok: false, error: 'validation_error', message: 'Select a maintenance period and package.' });
    }
    requestedState = {
      maintenancePeriod: period.id,
      maintenancePeriodLabel: period.label,
      packageId: pack.id,
      packageName: pack.name,
      packagePrice: pack.basePrice,
      maintenanceNote: note,
    };
    updates = {
      maintenanceRequested: true,
      maintenanceRequestedAt: now,
      maintenanceRequestNote: note,
      maintenancePeriod: period.id,
      maintenancePeriodLabel: period.label,
      maintenancePackageId: pack.id,
      maintenancePackageName: pack.name,
      customerChangePending: true,
    };
    adminSubject = `Cardetail1 — Maintenance Plan Request · ${bookingId}`;
    adminText = `Customer maintenance plan request for booking ${bookingId}.\nPeriod: ${period.label}\nPackage: ${pack.name} ($${Number(pack.basePrice).toFixed(2)})\n${note || '(no note)'}`;
  } else if (action === 'cancellation_request') {
    const reason = String(p.reason || p.message || '').slice(0, 500).trim();
    if (!reason) return json(400, { ok: false, error: 'validation_error', message: 'Please provide a cancellation reason.' });
    requestedState = { cancellationReason: reason };
    updates = {
      cancellationRequestStatus: 'requested',
      cancellationRequestedAt: now,
      cancellationReason: reason,
      customerChangePending: true,
    };
    logEntry.cancellationReason = reason;
    adminSubject = `Cardetail1 — Cancellation Request · ${bookingId}`;
    adminText = `Customer requested cancellation for booking ${bookingId}.\nReason: ${reason}`;
  }

  // Non-money paths: embed request via versioned command when possible; index remains rebuildable.
  const { submitChangeRequestCommand } = require('../lib/booking-commands');
  const moneyish = new Set(['reschedule_request', 'address_update', 'cancellation_request']);
  if (moneyish.has(action) || action === 'vehicle_add_request' || action === 'vehicle_replace_request'
    || action === 'maintenance_request') {
    const cmdDelta = {
      ...requestedState,
      requestedDate: requestedState.preferredDate || requestedState.requestedDate,
      requestedTime: requestedState.preferredTime || requestedState.requestedTime,
      serviceAddress: requestedState.address || requestedState.serviceAddress,
    };
    const cmd = await submitChangeRequestCommand({
      bookingId,
      expectedBookingVersion,
      requestType: action === 'cancellation_request' ? 'cancellation' : action,
      target: action === 'vehicle_replace_request'
        ? { vehicleId: requestedState.targetVehicleId }
        : {},
      delta: cmdDelta,
      authorizedRef: auth.scope,
      extraPatches: updates,
      idempotencyKey,
    });
    if (!cmd.ok) {
      return json(cmd.statusCode || 400, {
        ok: false,
        error: cmd.error || 'request_failed',
        message: cmd.error === 'version_conflict'
          ? 'This booking changed. Refresh and try again.'
          : 'Failed to save request. Please try again.',
      });
    }
    let appliedCmd = cmd;
    if (!policy.pendingApproval) {
      appliedCmd = await autoApplySubmittedRequest(bookingId, cmd);
      if (!appliedCmd.ok) {
        return json(appliedCmd.statusCode || 400, {
          ok: false,
          error: appliedCmd.error || 'apply_failed',
          message: appliedCmd.message,
          changeRequestId: cmd.changeRequest?.requestId || null,
        });
      }
    }
    if (!appliedCmd.idempotent) {
      notifyAdmin(
        (adminSubject || '').replace('Request', appliedCmd.applied ? 'Updated' : 'Request'),
        `${adminText}${appliedCmd.booking?.approvedFinalAmount != null ? `\nTotal: $${Number(appliedCmd.booking.approvedFinalAmount).toFixed(2)}` : ''}\n\nCustomer: ${custName}`
      ).catch(() => {});
    }
    return json(200, {
      ok: true,
      changeRequestId: appliedCmd.changeRequest.requestId,
      pendingApproval: !!policy.pendingApproval && !appliedCmd.applied,
      applied: !!appliedCmd.applied,
      idempotent: !!appliedCmd.idempotent,
      bookingVersion: appliedCmd.booking?.bookingVersion,
      approvedFinalAmount: appliedCmd.booking?.approvedFinalAmount,
      projection: appliedCmd.projection,
      booking: safeBooking(appliedCmd.booking),
    });
  }

  const changeRecord = await createChangeRequest({
    bookingId,
    requestType: action,
    previousState: sanitizeSnapshot(booking),
    requestedState,
    authorizedRef: auth.scope,
    status: policy.pendingApproval ? 'pending_approval' : 'pending',
  });

  const eventLog = Array.isArray(booking.eventLog) ? [...booking.eventLog] : [];
  eventLog.push({ ...logEntry, changeRequestId: changeRecord.id });

  let committedBooking = null;
  try {
    const { getBookingRecord, commitBooking } = require('../lib/booking-repository');
    const { buildNextAggregate, normalizeAggregate } = require('../lib/booking-aggregate');
    const rec = await getBookingRecord(bookingId);
    if (!rec.exists) {
      return json(404, { ok: false, error: 'not_found' });
    }
    const { ok: nOk, aggregate } = normalizeAggregate(rec.booking, { allowDraft: true });
    const base = nOk ? aggregate : rec.booking;
    const next = buildNextAggregate(base, { ...updates, eventLog, updatedAt: now });
    const committed = await commitBooking({
      bookingId,
      expectedBookingVersion: base.bookingVersion || 0,
      nextAggregate: next,
    });
    if (!committed.ok) {
      return json(committed.statusCode || 409, {
        ok: false,
        error: committed.error || 'version_conflict',
        message: 'This booking changed. Refresh and try again.',
      });
    }
    committedBooking = committed.booking;
  } catch {
    return json(503, { ok: false, error: 'service_unavailable', message: 'Failed to save request. Please try again.' });
  }

  notifyAdmin(adminSubject, `${adminText}\n\nCustomer: ${custName}`).catch(() => {});

  return json(200, {
    ok: true,
    changeRequestId: changeRecord.id,
    pendingApproval: !!policy.pendingApproval,
    booking: safeBooking(committedBooking),
  });
};
