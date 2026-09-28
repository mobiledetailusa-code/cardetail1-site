// Admin-only job assignment (assign / unassign / reassign).
// Saved technicians and one-off phones share the Quick Ops assignment path
// so the Jobs Board sends the job text and can remove the assignment.
const { jsonCors, verifyAdminKey, sanitizeText } = require('../lib/tech-security');
const { getBookingRecord } = require('../lib/booking-repository');
const { assignQuickOpsTech, unassignQuickOpsTech } = require('../lib/quick-ops-assign');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') return jsonCors(405, { ok: false, error: 'method_not_allowed' });

  const auth = await verifyAdminKey(event.headers || {});
  if (!auth.ok) return jsonCors(auth.error === 'missing_admin_password_config' ? 503 : 401, { ok: false, error: auth.error });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'invalid_json' }); }

  const action = String(body.action || 'assign');
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
    message: result.message,
  });
};
