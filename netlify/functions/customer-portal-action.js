// Customer completion / action link verification and actions (booking-scoped token).
const { jsonCors, blobsStore } = require('../lib/tech-security');
const { syncLegacyFields, portalLabel } = require('../lib/operations-lifecycle');
const { auditEntry, appendAudit } = require('../lib/operations-audit');
const { projectBookingForCustomer } = require('../lib/ops-schema');
const { checkPublicRateLimit } = require('../lib/public-rate-limit');

async function getBooking(bookingId) {
  const store = await blobsStore('cd1-bookings');
  return store.get(bookingId, { type: 'json' }).catch(() => null);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') return jsonCors(405, { ok: false, error: 'method_not_allowed' });

  const rate = await checkPublicRateLimit(event, { endpoint: 'customer-action-link' });
  if (!rate.ok) return jsonCors(429, { ok: false, error: 'too_many_requests' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'invalid_json' }); }

  const action = String(body.action || 'view').toLowerCase();
  const token = String(body.token || '').trim();
  if (!token) return jsonCors(400, { ok: false, error: 'token_required' });

  const record = await verifyActionToken(token);
  if (!record) return jsonCors(401, { ok: false, error: 'invalid_or_expired_token' });

  const booking = await getBooking(record.bookingId);
  if (!booking) return jsonCors(404, { ok: false, error: 'booking_not_found' });

  const synced = syncLegacyFields(booking);
  const labels = portalLabel(synced.serviceStatus, synced.paymentStatus, synced.customerApprovalStatus);

  if (action === 'view') {
    const safe = projectBookingForCustomer(synced);
    return jsonCors(200, {
      ok: true,
      booking: safe,
      labels,
      adjustmentPending: synced.adjustmentStatus === 'pending_admin',
      approvedAmount: synced.approvedFinalAmount != null ? synced.approvedFinalAmount : synced.totalPrice,
      customerVisibleNotes: synced.customerVisibleNotes || '',
      completedAt: synced.completedAt || '',
    });
  }

  if (action === 'approve_completion') {
    if (synced.adjustmentStatus === 'pending_admin') {
      return jsonCors(409, { ok: false, error: 'adjustment_under_review' });
    }
    const prev = { ...synced };
    const patched = syncLegacyFields({
      ...synced,
      customerApprovalStatus: 'approved',
      serviceStatus: synced.paymentStatus === 'paid_cash' || synced.paymentStatus === 'paid_card_on_site'
        ? 'closed' : 'awaiting_customer_action',
      updatedAt: new Date().toISOString(),
    });
    const store = await blobsStore('cd1-bookings');
    await store.setJSON(record.bookingId, patched);
    await appendAudit(auditEntry({
      bookingId: record.bookingId,
      actorType: 'customer',
      actorId: 'action_link',
      action: 'approve_completion',
      requestId: body.requestId,
      previousState: prev,
      resultingState: patched,
      sourcePortal: 'customer',
    }));
    return jsonCors(200, { ok: true, labels: portalLabel(patched.serviceStatus, patched.paymentStatus, patched.customerApprovalStatus) });
  }

  if (action === 'report_issue') {
    const note = String(body.note || '').trim().slice(0, 1000);
    if (!note) return jsonCors(400, { ok: false, error: 'note_required' });
    const prev = { ...synced };
    const patched = syncLegacyFields({
      ...synced,
      customerApprovalStatus: 'disputed',
      serviceStatus: 'disputed',
      customerIssueNote: note,
      updatedAt: new Date().toISOString(),
    });
    const store = await blobsStore('cd1-bookings');
    await store.setJSON(record.bookingId, patched);
    await appendAudit(auditEntry({
      bookingId: record.bookingId,
      actorType: 'customer',
      actorId: 'action_link',
      action: 'report_issue',
      requestId: body.requestId,
      previousState: prev,
      resultingState: patched,
      reason: note,
      sourcePortal: 'customer',
    }));
    return jsonCors(200, { ok: true });
  }

  return jsonCors(400, { ok: false, error: 'unknown_action' });
};
