// Admin review of customer change requests — Release A: index is rebuildable; booking is authority.

const { jsonCors } = require('../lib/tech-security');
const { verifyAdminRequest } = require('../lib/admin-security');
const { blobsStore, listAllBlobs, fetchBlobRecords } = require('../lib/tech-security');
const { getBooking, getBookingsByIds, normalizeBookingKey } = require('../lib/ops-db');
const { decideChangeRequestCommand, materialProjection } = require('../lib/booking-commands');
const { getBookingRecord } = require('../lib/booking-repository');
const { buildSyncEnvelope, syncHeaders } = require('../lib/sync-response');
const { normalizeIdempotencyKey } = require('../lib/operation-idempotency');

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

    // Booking enrichment is the expensive step, so it runs LAST and only for the
    // rows actually returned. Everything above it is request-native.
    const records = [];
    for (const r of items) {
      if (!r) continue;
      const id = r.id || r.requestId;
      if (!id) continue;
      records.push({ ...r, id, requestId: r.requestId || r.id, bookingId: r.bookingId });
    }

    // Request-native — never needs a booking read.
    const pendingCount = records.filter((r) => isOpenStatus(r.status)).length;

    const wantsPaymentAdjustment = statusFilter === 'needs_payment_adjustment'
      || statusFilter === 'payment_adjustment';

    const statusMatched = records.filter((r) => {
      const st = String(r.status || '').toLowerCase();
      if (statusFilter === 'all') return true;
      if (statusFilter === 'approved' || statusFilter === 'applied') {
        return st === 'applied' || st === 'approved';
      }
      if (statusFilter === 'declined' || statusFilter === 'rejected') {
        return st === 'rejected' || st === 'declined';
      }
      // 'pending' and the payment-adjustment prefilter share the open-status gate.
      return isOpenStatus(st);
    });

    // Unchanged comparator — createdAt desc, id desc as tiebreak.
    const byRecency = (a, b) => {
      const ta = String(b.createdAt || b.submittedAt || '');
      const tb = String(a.createdAt || a.submittedAt || '');
      if (ta !== tb) return ta.localeCompare(tb);
      return String(b.id || '').localeCompare(String(a.id || ''));
    };
    const sorted = statusMatched.slice().sort(byRecency);

    // One batched, de-duplicated booking read for the supplied rows.
    const enrich = async (rows) => {
      // A booking-store outage must degrade the rows, never fail the page.
      let bookings = new Map();
      try {
        bookings = await getBookingsByIds(rows.map((r) => r.bookingId));
      } catch (e) {
        console.warn('[admin-customer-requests] booking lookup unavailable:', e.message);
        bookings = new Map();
      }
      const out = [];
      for (const r of rows) {
        const key = r.bookingId ? normalizeBookingKey(r.bookingId) : '';
        const booking = key ? bookings.get(key) || null : null;
        if (r.bookingId && !booking) {
          // Opaque server-side diagnostic — no storage internals, no stack.
          console.warn('[admin-customer-requests] booking unavailable for request', {
            requestId: String(r.id).slice(0, 24),
          });
        }
        const projected = projectChangeRequestForAdmin(r, booking || {});
        if (!projected) continue;
        projected.typeLabel = TYPE_LABELS[projected.requestType] || projected.requestType;
        projected.customerName = booking
          ? [booking.firstName, booking.lastName].filter(Boolean).join(' ').trim()
          : '';
        projected.vehicleLabel = projected.requestedState?.vehicleSnapshot?.vehicleLabel
          || projected.previousState?.vehicle?.vehicleLabel
          || projected.vehicleId
          || '';
        projected.bookingUnavailable = !!(r.bookingId && !booking);
        out.push(projected);
      }
      return out;
    };

    const cursor = String(body.cursor || event.queryStringParameters?.cursor || '');
    const sliceFrom = (list) => {
      let start = 0;
      if (cursor) {
        const idx = list.findIndex((r) => r.id === cursor);
        start = idx >= 0 ? idx + 1 : 0;
      }
      return { start, page: list.slice(start, start + MAX_LIST) };
    };

    let page;
    let totalFiltered;
    let start;

    if (wantsPaymentAdjustment) {
      // paymentImpact is derived from booking.ledger, so this one filter cannot be
      // answered without enrichment. Cost stays bounded by the number of UNIQUE
      // bookings among open requests — not by total request history.
      const enrichedOpen = await enrich(sorted);
      const matching = enrichedOpen.filter((r) => r.paymentImpact === 'payment_adjustment_required');
      ({ start, page } = sliceFrom(matching));
      totalFiltered = matching.length;
    } else {
      ({ start, page } = sliceFrom(sorted));
      page = await enrich(page);
      totalFiltered = sorted.length;
    }

    const nextCursor = start + MAX_LIST < totalFiltered
      ? page[page.length - 1]?.id || null
      : null;

    const payload = {
      ok: true,
      requests: page,
      bounded: true,
      max: MAX_LIST,
      totalPending: pendingCount,
      totalFiltered,
      statusFilter,
      nextCursor,
    };
    const ifSyncVersion = String(
      body.ifSyncVersion || event.queryStringParameters?.ifSyncVersion || ''
    );
    const envelope = buildSyncEnvelope(payload, { ifSyncVersion });
    return jsonCors(200, envelope.body, syncHeaders(envelope.syncVersion));
  }

  if (action === 'decide') {
    const requestId = String(body.requestId || '').trim();
    const decision = String(body.decision || '').toLowerCase();
    const adminNote = String(body.adminNote || '').slice(0, 2000);
    if (!requestId || !['approve', 'reject', 'clarify'].includes(decision)) {
      return jsonCors(400, { ok: false, error: 'validation_error' });
    }
    if (body.expectedBookingVersion == null || body.expectedBookingVersion === '') {
      return jsonCors(400, { ok: false, error: 'expected_booking_version_required' });
    }
    const idempotencyKey = normalizeIdempotencyKey(body.idempotencyKey || body.requestKey);
    if (!idempotencyKey) {
      return jsonCors(400, { ok: false, error: 'idempotency_key_required' });
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
      idempotencyKey,
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
