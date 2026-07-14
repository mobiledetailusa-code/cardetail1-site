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
    const requestedAddons = String(p.requestedAddons || '').slice(0, 1000).trim();
    if (!requestedAddons) return json(400, { ok: false, error: 'validation_error', message: 'Please select at least one add-on.' });
    requestedState = { requestedAddons };
    updates = {
      addonsRequested: true,
      addonRequestedAt: now,
      requestedAddons,
      customerChangePending: policy.pendingApproval || false,
    };
    logEntry.requestedAddons = requestedAddons;
    adminSubject = `Cardetail1 — Add-On Request · ${bookingId}`;
    adminText = `Customer requested add-ons for booking ${bookingId}.\n${requestedAddons}`;
  } else if (action === 'package_change_request') {
    const newPackId = String(p.newPackId || '').slice(0, 32).trim();
    const { CAR_PACKAGES } = require('../lib/customer-catalog');
    const catalogPack = CAR_PACKAGES.find((cp) => cp.id === newPackId);
    const newPackName = catalogPack ? catalogPack.name : String(p.newPackName || '').slice(0, 120).trim();
    if (!newPackName) return json(400, { ok: false, error: 'validation_error', message: 'Please select a package.' });
    requestedState = { packageId: newPackId, packageName: newPackName };
    updates = {
      packageChangeRequested: true,
      packageChangeRequestedAt: now,
      requestedPackageId: newPackId,
      requestedPackageName: newPackName,
      customerChangePending: policy.pendingApproval || false,
    };
    logEntry.requestedPackage = newPackName;
    adminSubject = `Cardetail1 — Package Change Request · ${bookingId}`;
    adminText = `Customer requested package change for booking ${bookingId}.\nRequested: ${newPackName}`;
  } else if (action === 'vehicle_add_request' || action === 'vehicle_replace_request') {
    const vehicleLabel = String(p.vehicleLabel || p.label || '').slice(0, 120).trim();
    if (!vehicleLabel) return json(400, { ok: false, error: 'validation_error', message: 'Vehicle description is required.' });
    requestedState = { vehicleLabel, category: String(p.category || 'car').slice(0, 32) };
    updates = {
      vehicleChangeRequested: true,
      vehicleChangeRequestedAt: now,
      requestedVehicleLabel: vehicleLabel,
      requestedVehicleAction: action === 'vehicle_replace_request' ? 'replace' : 'add',
      customerChangePending: true,
    };
    logEntry.vehicleLabel = vehicleLabel;
    adminSubject = `Cardetail1 — Vehicle Change Request · ${bookingId}`;
    adminText = `Customer requested vehicle ${action === 'vehicle_replace_request' ? 'replacement' : 'addition'} for booking ${bookingId}.\n${vehicleLabel}`;
  } else if (action === 'maintenance_request') {
    const note = String(p.note || p.message || '').slice(0, 1000).trim();
    requestedState = { maintenanceNote: note };
    updates = {
      maintenanceRequested: true,
      maintenanceRequestedAt: now,
      maintenanceRequestNote: note,
      customerChangePending: true,
    };
    adminSubject = `Cardetail1 — Maintenance Request · ${bookingId}`;
    adminText = `Customer maintenance request for booking ${bookingId}.\n${note || '(no note)'}`;
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
