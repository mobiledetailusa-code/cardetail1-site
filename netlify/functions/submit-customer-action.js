// Customer-initiated booking actions with rate limiting, status policy, and change-request records.

const { blobsStore } = require('../lib/tech-security');
const { getBooking, bookingStore } = require('../lib/ops-db');
const { authorizeBookingAccess, normalizeBookingId } = require('../lib/booking-customer-auth');
const { canRequestChange } = require('../lib/appointment-status-policy');
const { createChangeRequest, sanitizeSnapshot } = require('../lib/customer-change-requests');
const { enforcePublicRateLimit } = require('../lib/public-rate-limit');

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
  addon_remove_request: 'addon',
  maintenance_request: 'maintenance',
  cancellation_request: 'cancellation',
};

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
  const policyAction = ACTION_MAP[action];
  const policy = canRequestChange(booking, policyAction);
  if (!policy.ok) {
    return json(200, {
      ok: false,
      error: 'action_not_allowed',
      message: policy.requiresCall
        ? 'This appointment is in progress. Please call or text Cardetail1 for changes.'
        : 'This change is not available for your appointment status.',
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
  } else if (action === 'addon_request' || action === 'package_change_request') {
    // Release A: money requests go through versioned command + canonical quote (PDA-01/02/05/07)
    const { submitChangeRequestCommand } = require('../lib/booking-commands');
    const { CAR_PACKAGES } = require('../lib/customer-catalog');
    const {
      usesLengthPricing,
      packagesForCategory,
      normalizeLengthCategory,
    } = require('../lib/length-pricing');

    let target = { vehicleId: p.vehicleId || undefined };
    let delta = {};
    let adminSubjectLocal = '';
    let adminTextLocal = '';

    if (action === 'addon_request') {
      const rawIds = Array.isArray(p.addonIds) ? p.addonIds : String(p.addonIds || '').split(',');
      const addonIds = rawIds.map((id) => String(id || '').trim()).filter(Boolean);
      if (!addonIds.length && !String(p.requestedAddons || '').trim()) {
        return json(400, { ok: false, error: 'validation_error', message: 'Please select at least one add-on.' });
      }
      delta = { addOnIdsToAdd: addonIds, addonIds, requestedAddons: addonIds.join(', ') };
      adminSubjectLocal = `Cardetail1 — Add-On Request · ${bookingId}`;
      adminTextLocal = `Customer requested add-ons for booking ${bookingId}.\n${addonIds.join(', ')}`;
    } else {
      const newPackId = String(p.newPackId || '').slice(0, 32).trim();
      const vehicleCategory = normalizeLengthCategory(
        p.vehicleCategory || booking.vehicleCategory || booking.cat || 'cars'
      );
      const lengthFt = Number(p.lengthFt || p.vehicleLengthFt || booking.vehicleLengthFt || booking.lengthFt || 0);
      const lengthPacks = packagesForCategory(vehicleCategory);
      const catalogPack = CAR_PACKAGES.find((cp) => cp.id === newPackId)
        || (lengthPacks || []).find((cp) => cp.id === newPackId);
      const newPackName = catalogPack ? catalogPack.name : String(p.newPackName || '').slice(0, 120).trim();
      if (!newPackName) return json(400, { ok: false, error: 'validation_error', message: 'Please select a package.' });
      if (usesLengthPricing(vehicleCategory) && !(lengthFt > 0)) {
        return json(400, { ok: false, error: 'validation_error', message: 'Enter vessel / RV length in feet for accurate pricing.' });
      }
      const tierKey = p.tier || p.vehicleTier || booking.vehicleTier || booking.tierKey || 'suv3';
      delta = {
        packageId: newPackId,
        newPackId,
        packageName: newPackName,
        vehicleCategory,
        lengthFt: usesLengthPricing(vehicleCategory) ? lengthFt : 0,
        tierKey,
        tier: tierKey,
      };
      adminSubjectLocal = `Cardetail1 — Package Change Request · ${bookingId}`;
      adminTextLocal = `Customer requested package change for booking ${bookingId}.\nRequested: ${newPackName}`;
    }

    const cmd = await submitChangeRequestCommand({
      bookingId,
      expectedBookingVersion: booking.bookingVersion,
      requestType: action,
      target,
      delta,
      authorizedRef: auth.scope,
    });
    if (cmd.noop) {
      return json(200, {
        ok: true,
        noop: true,
        reason: cmd.reason || 'duplicate_addon',
        message: 'Selected add-on is already on this booking.',
        changeRequestId: null,
      });
    }
    if (!cmd.ok) {
      const status = cmd.statusCode || 400;
      return json(status, {
        ok: false,
        error: cmd.error || 'request_failed',
        message: cmd.error === 'version_conflict'
          ? 'This booking changed. Refresh and try again.'
          : (cmd.error === 'invalid_pricing' ? 'Selected package could not be priced.' : undefined),
      });
    }

    const proposed = cmd.changeRequest?.proposedApprovedCents != null
      ? cmd.changeRequest.proposedApprovedCents / 100
      : null;
    notifyAdmin(
      adminSubjectLocal,
      `${adminTextLocal}${proposed != null ? `\nProposed total: $${Number(proposed).toFixed(2)}` : ''}\n\nCustomer: ${custName}`
    ).catch(() => {});

    return json(200, {
      ok: true,
      changeRequestId: cmd.changeRequest.requestId,
      pendingApproval: true,
      bookingVersion: cmd.booking?.bookingVersion,
      quoteVersion: cmd.changeRequest?.quoteVersion,
      proposedTotal: proposed,
      projection: cmd.projection,
    });
  } else if (action === 'vehicle_add_request' || action === 'vehicle_replace_request') {
    const { usesLengthPricing } = require('../lib/length-pricing');
    const category = String(p.category || p.vehicleCategory || 'cars').slice(0, 32).trim();
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
    requestedState = { vehicleLabel: label, category, year, make, model, lengthFt: lengthFt || 0 };
    updates = {
      vehicleChangeRequested: true,
      vehicleChangeRequestedAt: now,
      requestedVehicleLabel: label,
      requestedVehicleCategory: category,
      requestedVehicleYear: year,
      requestedVehicleMake: make,
      requestedVehicleModel: model,
      requestedVehicleLengthFt: lengthFt || 0,
      requestedVehicleAction: action === 'vehicle_replace_request' ? 'replace' : 'add',
      customerChangePending: true,
    };
    logEntry.vehicleLabel = label;
    adminSubject = `Cardetail1 — Vehicle Change Request · ${bookingId}`;
    adminText = `Customer requested vehicle ${action === 'vehicle_replace_request' ? 'replacement' : 'addition'} for booking ${bookingId}.\n${label} (${category}${lengthFt ? `, ${lengthFt} ft` : ''})`;
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
    || action === 'maintenance_request' || action === 'addon_remove_request') {
    const cmdDelta = {
      ...requestedState,
      requestedDate: requestedState.preferredDate || requestedState.requestedDate,
      requestedTime: requestedState.preferredTime || requestedState.requestedTime,
      serviceAddress: requestedState.address || requestedState.serviceAddress,
    };
    const cmd = await submitChangeRequestCommand({
      bookingId,
      expectedBookingVersion: booking.bookingVersion,
      requestType: action === 'cancellation_request' ? 'cancellation' : action,
      target: {},
      delta: cmdDelta,
      authorizedRef: auth.scope,
      extraPatches: updates,
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
    notifyAdmin(adminSubject, `${adminText}\n\nCustomer: ${custName}`).catch(() => {});
    return json(200, {
      ok: true,
      changeRequestId: cmd.changeRequest.requestId,
      pendingApproval: !!policy.pendingApproval,
      bookingVersion: cmd.booking?.bookingVersion,
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
  } catch {
    return json(503, { ok: false, error: 'service_unavailable', message: 'Failed to save request. Please try again.' });
  }

  notifyAdmin(adminSubject, `${adminText}\n\nCustomer: ${custName}`).catch(() => {});

  return json(200, {
    ok: true,
    changeRequestId: changeRecord.id,
    pendingApproval: !!policy.pendingApproval,
  });
};
