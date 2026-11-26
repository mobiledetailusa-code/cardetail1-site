// Admin-only job assignment (assign / unassign / reassign).
// Saved technicians and one-off phones share the Quick Ops assignment path
// so the Jobs Board sends the job text and can remove the assignment.
const { jsonCors, verifyAdminKey, sanitizeText } = require('../lib/tech-security');
const { getBookingRecord } = require('../lib/booking-repository');
const { assignQuickOpsTech, unassignQuickOpsTech, retryQuickOpsTechNotification } = require('../lib/quick-ops-assign');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') return jsonCors(405, { ok: false, error: 'method_not_allowed' });

  const auth = await verifyAdminKey(event.headers || {});
  if (!auth.ok) return jsonCors(auth.error === 'missing_admin_password_config' ? 503 : 401, { ok: false, error: auth.error });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'invalid_json' }); }

  const action = String(body.action || 'assign');

  // Technician withdrawal requests (QuickOps Daily Dispatch). Approval
  // unassigns the requesting technician through unassignQuickOpsTech and
  // never cancels the customer booking.
  if (action === 'list_withdrawals') {
    const { listWithdrawalRequests, projectWithdrawalForAdmin } = require('../lib/tech-withdrawal');
    const status = sanitizeText(body.status, 24) || 'pending';
    try {
      const rows = await listWithdrawalRequests({ status });
      return jsonCors(200, { ok: true, requests: rows.map(projectWithdrawalForAdmin) });
    } catch {
      return jsonCors(503, { ok: false, error: 'withdrawals_unavailable' });
    }
  }
  if (action === 'decide_withdrawal') {
    const { decideWithdrawalRequest, projectWithdrawalForAdmin } = require('../lib/tech-withdrawal');
    const result = await decideWithdrawalRequest({
      id: sanitizeText(body.requestId, 64),
      decision: sanitizeText(body.decision, 16),
      adminNote: body.adminNote,
      actor: (auth && auth.actor) || 'admin',
    });
    const payload = {
      ok: !!result.ok,
      ...(result.error ? { error: result.error } : {}),
      ...(result.message ? { message: result.message } : {}),
      ...(result.request ? { request: projectWithdrawalForAdmin(result.request) } : {}),
      ...(result.bookingId ? { bookingId: result.bookingId } : {}),
      ...(result.assignment ? { assignment: result.assignment } : {}),
      ...(result.jobStatus ? { jobStatus: result.jobStatus } : {}),
    };
    return jsonCors(result.ok ? 200 : (result.statusCode || 409), payload);
  }

  const bookingId = sanitizeText(body.bookingId, 48);
  if (!bookingId) return jsonCors(400, { ok: false, error: 'bookingId_required' });

  const rec = await getBookingRecord(bookingId);
  const booking = rec && rec.booking;
  if (!rec || !rec.exists || !booking || booking.isDraft) {
    return jsonCors(404, { ok: false, error: 'booking_not_found' });
  }

  if (action === 'unassign') {
    const result = await unassignQuickOpsTech(booking, { by: 'admin' });
    if (!result.ok) {
      return jsonCors(result.statusCode || 409, {
        ok: false,
        error: result.error || 'unassign_failed',
        message: result.message || 'This job cannot be reassigned',
      });
    }
    return jsonCors(200, {
      ok: true,
      bookingId,
      jobStatus: result.booking && result.booking.jobStatus,
      assignment: result.assignment || null,
      message: result.message,
    });
  }

  if (action === 'retry_notification') {
    const result = await retryQuickOpsTechNotification(booking, { by: 'admin' });
    if (!result.ok) {
      return jsonCors(result.statusCode || 409, {
        ok: false,
        error: result.error || 'retry_failed',
        notification: 'failed',
        message: result.message || 'Assigned — notification failed',
      });
    }
    return jsonCors(200, {
      ok: true,
      bookingId,
      jobStatus: result.booking && result.booking.jobStatus,
      assignment: result.assignment || null,
      notification: result.notification || 'failed',
      message: result.message,
    });
  }

  const techId = sanitizeText(body.techId, 48);
  const phone = sanitizeText(body.phone, 32);
  if (techId === '__freelance__') return jsonCors(400, { ok: false, error: 'techId_required' });
  const result = await assignQuickOpsTech(booking, { techId, phone, by: 'admin' });
  if (!result.ok) {
    return jsonCors(result.statusCode || 400, {
      ok: false,
      error: result.error || 'assign_failed',
      message: result.message || 'Assignment failed',
    });
  }
  return jsonCors(200, {
    ok: true,
    bookingId,
    assignedTechId: result.assignedTechId || null,
    assignedTechName: result.assignedTechName || (result.assignment && result.assignment.label) || null,
    assignmentKind: result.kind || null,
    freelancePhone: result.freelancePhone || null,
    jobStatus: result.booking && result.booking.jobStatus,
    assignment: result.assignment || null,
    techUrl: result.techUrl || null,
    notification: result.notification || 'failed',
    message: result.message,
  });
};
