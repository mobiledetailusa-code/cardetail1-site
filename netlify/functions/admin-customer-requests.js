// Admin review of customer change requests.

const { jsonCors } = require('../lib/tech-security');
const { verifyAdminRequest } = require('../lib/admin-security');
const { blobsStore } = require('../lib/tech-security');
const { getBooking, bookingStore } = require('../lib/ops-db');
const { updateRequest } = require('../lib/customer-change-requests');

const REQUEST_STORE = 'cd1-customer-change-requests';
const MAX_LIST = 50;

const AUTO_APPLY_TYPES = new Set([
  'reschedule_request',
  'address_update',
  'cancellation',
  'cancellation_request',
  'package_change_request',
  'addon_request',
  'vehicle_add_request',
  'vehicle_replace_request',
]);

const TYPE_LABELS = {
  reschedule_request: 'Reschedule',
  address_update: 'Address change',
  cancellation: 'Cancellation',
  package_change_request: 'Package change',
  addon_request: 'Add-on addition',
  addon_remove_request: 'Add-on removal',
  vehicle_add_request: 'Vehicle addition',
  vehicle_replace_request: 'Vehicle replacement',
  maintenance_request: 'Maintenance request',
};

function safeJson(obj) {
  try { return JSON.stringify(obj || {}, null, 0); } catch { return '{}'; }
}

function shortId(id) {
  const s = String(id || '');
  if (s.length <= 12) return s;
  return s.slice(0, 8) + '…';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  const admin = await verifyAdminRequest(event.headers || {});
  if (!admin.ok) return jsonCors(401, { ok: false, error: 'unauthorized' });

  let body = {};
  if (event.httpMethod === 'POST') {
    try { body = JSON.parse(event.body || '{}'); }
    catch { return jsonCors(400, { ok: false, error: 'invalid_json' }); }
  }

  const action = String(
    body.action || event.queryStringParameters?.action || (event.httpMethod === 'GET' ? 'list' : '')
  );

  if (action === 'list') {
    const store = await blobsStore(REQUEST_STORE);
    const { blobs } = await store.list({ prefix: 'cr_' });
    const items = await Promise.all(
      (blobs || []).slice(0, 200).map((b) => store.get(b.key, { type: 'json' }).catch(() => null))
    );
    const pending = items
      .filter((r) => r && (r.status === 'pending' || r.status === 'pending_approval'))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      .slice(0, MAX_LIST)
      .map((r) => ({
        ...r,
        typeLabel: TYPE_LABELS[r.requestType] || r.requestType,
        shortId: shortId(r.id),
      }));
    return jsonCors(200, { ok: true, requests: pending, bounded: true, max: MAX_LIST });
  }

  if (action === 'decide') {
    const requestId = String(body.requestId || '').trim();
    const decision = String(body.decision || '').toLowerCase();
    const adminNote = String(body.adminNote || '').slice(0, 2000);
    if (!requestId || !['approve', 'reject', 'clarify'].includes(decision)) {
      return jsonCors(400, { ok: false, error: 'validation_error' });
    }

    const store = await blobsStore(REQUEST_STORE);
    const record = await store.get(requestId, { type: 'json' });
    if (!record) return jsonCors(404, { ok: false, error: 'not_found' });

    const now = new Date().toISOString();
    const status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'needs_clarification';
    const canAutoApply = decision === 'approve' && AUTO_APPLY_TYPES.has(record.requestType);
    const manualOnly = decision === 'approve' && !canAutoApply;

    const updated = await updateRequest(requestId, {
      status,
      adminDecision: decision,
      adminNote,
      decidedAt: now,
  // Improve customer-facing approval copy when money auto-applied.
      customerVisibleResult: decision === 'approve'
        ? (manualOnly
          ? 'Approved for manual review — our team will confirm details shortly.'
          : (canAutoApply
            ? 'Approved — your appointment details and totals were updated.'
            : 'Approved — our team will confirm details shortly.'))
        : decision === 'reject'
          ? 'We could not approve this request. Please contact us.'
          : 'We need more information. Please check your email or call us.',
      notificationStatus: 'pending',
      appliedAutomatically: canAutoApply,
    });

    if (canAutoApply && record.bookingId) {
      const booking = await getBooking(record.bookingId);
      if (booking) {
        const bStore = await bookingStore();
        const patch = { customerChangePending: false, updatedAt: now };
        const rs = record.requestedState || {};
        if (record.requestType === 'reschedule_request' && rs.preferredDate) {
          patch.preferredDate = rs.preferredDate;
          patch.preferredTime = rs.preferredTime || booking.preferredTime;
          patch.rescheduledByClient = false;
        }
        if (record.requestType === 'address_update' && rs.address) {
          patch.address = rs.address;
          patch.addressChangedByClient = false;
        }
        if (record.requestType === 'cancellation' || record.requestType === 'cancellation_request') {
          patch.cancellationRequestStatus = 'approved';
          patch.status = 'Cancelled';
          patch.jobStatus = 'cancelled';
          patch.appointmentStatus = 'canceled';
        }
        if (record.requestType === 'package_change_request' && (rs.packageName || rs.packageId)) {
          const { applyApprovedMoney } = require('../lib/portal-money-sync');
          patch.package = rs.packageName || booking.package;
          patch.service = rs.packageName || booking.service;
          patch.packageId = rs.packageId || booking.packageId || '';
          patch.packageDescription = rs.packageDescription || booking.packageDescription || '';
          if (rs.packageDuration) patch.packageDuration = rs.packageDuration;
          if (rs.lengthFt != null) patch.vehicleLengthFt = Number(rs.lengthFt) || booking.vehicleLengthFt;
          if (rs.vehicleCategory) patch.vehicleCategory = rs.vehicleCategory;
          if (rs.proposedTotal > 0) {
            Object.assign(patch, applyApprovedMoney(booking, rs.proposedTotal));
          } else {
            // Still invalidate stale checkout if package changed without a proposed total.
            patch.payLink = '';
            patch.payLinkAmount = null;
            patch.stripeCheckoutSessionId = '';
          }
          patch.packageChangeRequested = false;
          patch.requestedPackageName = '';
          patch.requestedPackageId = '';
          patch.customerVisiblePackage = patch.package;
        }
        if (record.requestType === 'addon_request') {
          const { applyApprovedMoney } = require('../lib/portal-money-sync');
          const incoming = Array.isArray(rs.addons) ? rs.addons : [];
          const merged = [...(Array.isArray(booking.addons) ? booking.addons : [])];
          for (const a of incoming) {
            if (!merged.some((m) => m.id === a.id || m.name === a.name)) merged.push(a);
          }
          patch.addons = merged;
          if (rs.proposedTotal > 0) {
            Object.assign(patch, applyApprovedMoney(booking, rs.proposedTotal));
          } else {
            patch.payLink = '';
            patch.payLinkAmount = null;
            patch.stripeCheckoutSessionId = '';
          }
          patch.addonsRequested = false;
          patch.requestedAddons = '';
          patch.requestedAddonIds = [];
        }
        if (record.requestType === 'vehicle_add_request' || record.requestType === 'vehicle_replace_request') {
          const label = rs.vehicleLabel || booking.vehicleLabel || '';
          if (record.requestType === 'vehicle_replace_request') {
            patch.vehicleLabel = label;
            patch.vehicle = label;
            patch.vehicleYear = rs.year || '';
            patch.vehicleMake = rs.make || '';
            patch.vehicleModel = rs.model || '';
            patch.vehicleCategory = rs.category || '';
            if (rs.lengthFt != null) patch.vehicleLengthFt = Number(rs.lengthFt) || 0;
          } else {
            const vehicles = Array.isArray(booking.vehicles) ? [...booking.vehicles] : [];
            vehicles.push({
              vehicleLabel: label,
              pkgName: booking.package || booking.service || '',
              category: rs.category || 'cars',
              year: rs.year || '',
              make: rs.make || '',
              model: rs.model || '',
              lengthFt: rs.lengthFt || 0,
              subtotal: 0,
              addons: [],
            });
            patch.vehicles = vehicles;
            if (!booking.vehicleLabel) {
              patch.vehicleLabel = label;
              patch.vehicle = label;
            }
            if (rs.lengthFt != null && !booking.vehicleLengthFt) {
              patch.vehicleLengthFt = Number(rs.lengthFt) || 0;
            }
            if (rs.category && !booking.vehicleCategory) patch.vehicleCategory = rs.category;
          }
          patch.vehicleChangeRequested = false;
          patch.requestedVehicleLabel = '';
        }
        await bStore.setJSON(record.bookingId, { ...booking, ...patch });
      }
    }

    return jsonCors(200, { ok: true, request: updated, manualReview: manualOnly });
  }

  if (action === 'generate_pay_link') {
    const bookingId = String(body.bookingId || '').trim();
    if (!bookingId) return jsonCors(400, { ok: false, error: 'validation_error' });
    const booking = await getBooking(bookingId);
    if (!booking) return jsonCors(404, { ok: false, error: 'booking_not_found' });
    if (!booking.payLink) {
      return jsonCors(200, {
        ok: false,
        error: 'payment_link_unavailable',
        message: 'No approved payment link on file. Generate one from the job drawer.',
      });
    }
    return jsonCors(200, { ok: true, payLink: booking.payLink, bookingId });
  }

  return jsonCors(405, { ok: false, error: 'method_not_allowed' });
};
