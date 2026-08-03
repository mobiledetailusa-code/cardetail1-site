// Admin review of customer change requests — Release A: index is rebuildable; booking is authority.

const { jsonCors } = require('../lib/tech-security');
const { verifyAdminRequest } = require('../lib/admin-security');
const { blobsStore, listAllBlobs, fetchBlobRecords } = require('../lib/tech-security');
const { getBooking } = require('../lib/ops-db');
const { decideChangeRequestCommand, materialProjection } = require('../lib/booking-commands');
const { getBookingRecord } = require('../lib/booking-repository');

const REQUEST_STORE = 'cd1-customer-change-requests';
const MAX_LIST = 50;

/** @type {null | object} */
let requestStoreOverride = null;
function setRequestStoreOverride(store) {
  requestStoreOverride = store || null;
}

const TYPE_LABELS = {
  reschedule_request: 'Reschedule',
  address_update: 'Address change',
  cancellation: 'Cancellation',
  package_change_request: 'Package change',
  addon_request: 'Add-on addition',
  addon_remove_request: 'Add-on removal',
  vehicle_add_request: 'Vehicle addition',
  vehicle_replace_request: 'Vehicle replacement',
  vehicle_remove_request: 'Vehicle removal',
  maintenance_request: 'Maintenance request',
};

function shortId(id) {
  const s = String(id || '');
  if (s.length <= 12) return s;
  return s.slice(0, 8) + '…';
}

async function getRequestStore() {
  if (requestStoreOverride) return requestStoreOverride;
  return blobsStore(REQUEST_STORE);
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
    const store = await getRequestStore();
    // Paginate ALL pages before filtering — never cap keys at 200 pre-filter (PDA-12)
    const blobs = await listAllBlobs(store, REQUEST_STORE);
    const items = await fetchBlobRecords(store, blobs);
    const statusFilter = String(
      body.status || event.queryStringParameters?.status || 'pending'
    ).toLowerCase();
    const {
      projectChangeRequestForAdmin,
      isOpenStatus,
    } = require('../lib/admin-change-request-projection');

    const enriched = [];
    for (const r of items) {
      if (!r) continue;
      let booking = null;
      if (r.bookingId) {
        try { booking = await getBooking(r.bookingId); } catch { booking = null; }
      }
      const projected = projectChangeRequestForAdmin({
        ...r,
        id: r.id || r.requestId,
        requestId: r.requestId || r.id,
        bookingId: r.bookingId,
      }, booking || {});
      if (!projected) continue;
      projected.typeLabel = TYPE_LABELS[projected.requestType] || projected.requestType;
      projected.customerName = booking
        ? [booking.firstName, booking.lastName].filter(Boolean).join(' ').trim()
        : '';
      projected.vehicleLabel = projected.requestedState?.vehicleSnapshot?.vehicleLabel
        || projected.previousState?.vehicle?.vehicleLabel
        || projected.vehicleId
        || '';
      enriched.push(projected);
    }

    const filtered = enriched.filter((r) => {
      const st = String(r.status || '').toLowerCase();
      if (statusFilter === 'all') return true;
      if (statusFilter === 'pending') return isOpenStatus(st);
      if (statusFilter === 'needs_payment_adjustment' || statusFilter === 'payment_adjustment') {
        return isOpenStatus(st) && r.paymentImpact === 'payment_adjustment_required';
      }
      if (statusFilter === 'approved' || statusFilter === 'applied') {
        return st === 'applied' || st === 'approved';
      }
      if (statusFilter === 'declined' || statusFilter === 'rejected') {
        return st === 'rejected' || st === 'declined';
      }
      return isOpenStatus(st);
    }).sort((a, b) => {
      const ta = String(b.createdAt || b.submittedAt || '');
      const tb = String(a.createdAt || a.submittedAt || '');
      if (ta !== tb) return ta.localeCompare(tb);
      return String(b.id || '').localeCompare(String(a.id || ''));
    });

    const cursor = String(body.cursor || event.queryStringParameters?.cursor || '');
    let start = 0;
    if (cursor) {
      const idx = filtered.findIndex((r) => r.id === cursor);
      start = idx >= 0 ? idx + 1 : 0;
    }
    const page = filtered.slice(start, start + MAX_LIST);
    const nextCursor = start + MAX_LIST < filtered.length
      ? page[page.length - 1]?.id || null
      : null;
    const pendingCount = enriched.filter((r) => isOpenStatus(r.status)).length;

    return jsonCors(200, {
      ok: true,
      requests: page,
      bounded: true,
      max: MAX_LIST,
      totalPending: pendingCount,
      totalFiltered: filtered.length,
      statusFilter,
      nextCursor,
    });
  }

  if (action === 'decide') {
    const requestId = String(body.requestId || '').trim();
    const decision = String(body.decision || '').toLowerCase();
    const adminNote = String(body.adminNote || '').slice(0, 2000);
    if (!requestId || !['approve', 'reject', 'clarify'].includes(decision)) {
      return jsonCors(400, { ok: false, error: 'validation_error' });
    }

    const store = await getRequestStore();
    const record = await store.get(requestId, { type: 'json' });
    if (!record) return jsonCors(404, { ok: false, error: 'not_found' });
    if (!record.bookingId) return jsonCors(400, { ok: false, error: 'missing_booking' });

    const result = await decideChangeRequestCommand({
      bookingId: record.bookingId,
      requestId,
      decision,
      expectedBookingVersion: body.expectedBookingVersion,
      expectedQuoteVersion: body.expectedQuoteVersion,
      adminNote,
      acceptRequote: body.acceptRequote === true,
    });

    if (!result.ok) {
      return jsonCors(result.statusCode || 400, {
        ok: false,
        error: result.error,
        message: result.message
          || (result.error === 'payment_adjustment_required'
            ? 'Payment adjustment required — do not auto-remove. Create a refund/credit adjustment first.'
            : result.error === 'invoice_paid'
            ? 'Invoice paid — create an adjustment or new quote instead of approving this money change.'
            : undefined),
        paymentAdjustmentRequired: !!result.paymentAdjustmentRequired,
        potentialRefundOrCreditCents: result.potentialRefundOrCreditCents,
        requoteRequired: result.requoteRequired || false,
        quote: result.quote || null,
        actualBookingVersion: result.actualBookingVersion,
      });
    }

    const manualOnly = decision === 'approve' && result.noop !== true
      && !['reschedule_request', 'address_update', 'cancellation', 'cancellation_request',
        'package_change_request', 'addon_request', 'vehicle_add_request', 'vehicle_replace_request',
        'vehicle_remove_request']
        .includes(record.requestType);

    return jsonCors(200, {
      ok: true,
      request: {
        id: requestId,
        status: decision === 'approve' ? (result.noop ? 'applied' : 'applied') : (decision === 'reject' ? 'rejected' : 'needs_clarification'),
        adminDecision: decision,
      },
      booking: result.booking ? {
        id: result.booking.id,
        bookingVersion: result.booking.bookingVersion,
        quoteVersion: result.booking.quoteVersion,
        approvedFinalAmount: result.booking.approvedFinalAmount,
        amountDueApproved: result.booking.amountDueApproved,
      } : null,
      projection: result.projection || materialProjection(result.booking),
      // Additive only — surfaces the same Postgres-authoritative projection the
      // Customer portal already receives (Stage 1 addon/package money paths).
      financialProjection: result.financialProjection || null,
      postgresProjection: result.postgresProjection || null,
      manualReview: !!manualOnly,
      expiredSessions: result.expiredAttemptIds || [],
    });
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
        message: 'No Stripe Checkout link on file yet. Open the job drawer and click Generate Stripe link.',
      });
    }
    return jsonCors(200, { ok: true, payLink: booking.payLink, bookingId });
  }

  return jsonCors(405, { ok: false, error: 'method_not_allowed' });
};

exports.setRequestStoreOverride = setRequestStoreOverride;
