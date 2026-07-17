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
  } else if (action === 'addon_request') {
    const { resolveAddonsByIds, addonTotal } = require('../lib/customer-catalog');
    const rawIds = Array.isArray(p.addonIds) ? p.addonIds : String(p.addonIds || '').split(',');
    const selected = resolveAddonsByIds(rawIds);
    const requestedAddons = selected.length
      ? selected.map((a) => `${a.name} ($${Number(a.price).toFixed(2)})`).join(', ')
      : String(p.requestedAddons || '').slice(0, 1000).trim();
    if (!requestedAddons) return json(400, { ok: false, error: 'validation_error', message: 'Please select at least one add-on.' });
    const addOnSum = selected.length ? addonTotal(selected) : 0;
    const base = Number(booking.approvedFinalAmount != null ? booking.approvedFinalAmount : (booking.totalPrice || 0));
    const proposedTotal = Math.round((base + addOnSum) * 100) / 100;
    requestedState = {
      requestedAddons,
      addonIds: selected.map((a) => a.id),
      addons: selected,
      addonTotal: addOnSum,
      proposedTotal,
    };
    updates = {
      addonsRequested: true,
      addonRequestedAt: now,
      requestedAddons,
      requestedAddonIds: selected.map((a) => a.id),
      requestedAddonItems: selected,
      requestedAddonTotal: addOnSum,
      proposedTotal,
      customerChangePending: true,
    };
    logEntry.requestedAddons = requestedAddons;
    logEntry.proposedTotal = proposedTotal;
    adminSubject = `Cardetail1 — Add-On Request · ${bookingId}`;
    adminText = `Customer requested add-ons for booking ${bookingId}.\n${requestedAddons}\nProposed total: $${proposedTotal.toFixed(2)}`;
  } else if (action === 'package_change_request') {
    const newPackId = String(p.newPackId || '').slice(0, 32).trim();
    const { CAR_PACKAGES } = require('../lib/customer-catalog');
    const catalogPack = CAR_PACKAGES.find((cp) => cp.id === newPackId);
    const newPackName = catalogPack ? catalogPack.name : String(p.newPackName || '').slice(0, 120).trim();
    if (!newPackName) return json(400, { ok: false, error: 'validation_error', message: 'Please select a package.' });
    const packPrice = catalogPack ? Number(catalogPack.basePrice) : 0;
    const travel = Number(booking.travelFeeAmount || booking.zoneSurcharge || 0);
    const existingAddons = Array.isArray(booking.addons)
      ? booking.addons.reduce((s, a) => s + Number(a.price || 0) * Number(a.qty || 1), 0)
      : 0;
    const proposedTotal = catalogPack
      ? Math.round((packPrice + travel + existingAddons) * 100) / 100
      : Number(booking.totalPrice || 0);
    requestedState = {
      packageId: newPackId || (catalogPack && catalogPack.id) || '',
      packageName: newPackName,
      packagePrice: packPrice,
      packageDescription: catalogPack ? catalogPack.description : '',
      proposedTotal,
    };
    updates = {
      packageChangeRequested: true,
      packageChangeRequestedAt: now,
      requestedPackageId: newPackId || (catalogPack && catalogPack.id) || '',
      requestedPackageName: newPackName,
      requestedPackagePrice: packPrice,
      requestedPackageDescription: catalogPack ? catalogPack.description : '',
      proposedTotal,
      customerChangePending: true,
    };
    logEntry.requestedPackage = newPackName;
    logEntry.proposedTotal = proposedTotal;
    adminSubject = `Cardetail1 — Package Change Request · ${bookingId}`;
    adminText = `Customer requested package change for booking ${bookingId}.\nRequested: ${newPackName}${packPrice ? ` ($${packPrice.toFixed(2)})` : ''}\nProposed total: $${proposedTotal.toFixed(2)}`;
  } else if (action === 'vehicle_add_request' || action === 'vehicle_replace_request') {
    const category = String(p.category || p.vehicleCategory || 'cars').slice(0, 32).trim();
    const year = String(p.year || p.vehicleYear || '').slice(0, 8).trim();
    const make = String(p.make || p.vehicleMake || '').slice(0, 60).trim();
    const model = String(p.model || p.vehicleModel || '').slice(0, 60).trim();
    const vehicleLabel = String(p.vehicleLabel || p.label || [year, make, model].filter(Boolean).join(' ')).slice(0, 160).trim();
    if (!vehicleLabel && !(make && model)) {
      return json(400, { ok: false, error: 'validation_error', message: 'Select category, year, make, and model.' });
    }
    const label = vehicleLabel || `${year} ${make} ${model}`.trim();
    requestedState = { vehicleLabel: label, category, year, make, model };
    updates = {
      vehicleChangeRequested: true,
      vehicleChangeRequestedAt: now,
      requestedVehicleLabel: label,
      requestedVehicleCategory: category,
      requestedVehicleYear: year,
      requestedVehicleMake: make,
      requestedVehicleModel: model,
      requestedVehicleAction: action === 'vehicle_replace_request' ? 'replace' : 'add',
      customerChangePending: true,
    };
    logEntry.vehicleLabel = label;
    adminSubject = `Cardetail1 — Vehicle Change Request · ${bookingId}`;
    adminText = `Customer requested vehicle ${action === 'vehicle_replace_request' ? 'replacement' : 'addition'} for booking ${bookingId}.\n${label} (${category})`;
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
    const store = await bookingStore();
    const patched = { ...booking, ...updates, eventLog, updatedAt: now };
    await store.setJSON(bookingId, patched);
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
