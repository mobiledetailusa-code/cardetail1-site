// Admin-only job assignment (assign / unassign / reassign).
const { blobsStore, jsonCors, verifyAdminKey, sanitizeText } = require('../lib/tech-security');
const { appendEventLog } = require('../lib/ops-workflow');

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

  const bookingStore = await blobsStore('cd1-bookings');
  const techStore = await blobsStore('cd1-tech-accounts');
  const booking = await bookingStore.get(bookingId, { type: 'json' }).catch(() => null);
  if (!booking || booking.isDraft) return jsonCors(404, { ok: false, error: 'booking_not_found' });

  const now = new Date().toISOString();

  if (action === 'unassign') {
    const patched = {
      ...booking,
      assignedTechId: null,
      assignedTech: null,
      assignedTechName: null,
      assignedAt: null,
      assignedBy: null,
      jobStatus: booking.appointmentStatus === 'confirmed' ? 'confirmed' : 'pending_review',
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'tech_unassigned', by: 'admin', assignedBy: 'admin' }),
    };
    await bookingStore.setJSON(bookingId, patched);
    return jsonCors(200, { ok: true, bookingId, jobStatus: patched.jobStatus });
  }

  const techId = sanitizeText(body.techId, 48);
  if (!techId) return jsonCors(400, { ok: false, error: 'techId_required' });
  const tech = await techStore.get('tech-' + techId, { type: 'json' }).catch(() => null);
  if (!tech || !tech.active) return jsonCors(404, { ok: false, error: 'technician_not_found_or_inactive' });

  const isReassign = !!(booking.assignedTechId || booking.assignedTech);
  const patched = {
    ...booking,
    assignedTechId: tech.techId || tech.id,
    assignedTech: tech.techId || tech.id,
    assignedTechName: tech.fullName || tech.name,
    assignedAt: now,
    assignedBy: 'admin',
    jobStatus: 'assigned',
    appointmentStatus: booking.appointmentStatus === 'pending_review' ? 'confirmed' : (booking.appointmentStatus || 'confirmed'),
    status: 'Confirmed',
    updatedAt: now,
    eventLog: appendEventLog(booking, {
      action: isReassign ? 'tech_reassigned' : 'tech_assigned',
      by: 'admin',
      techId: tech.techId || tech.id,
      techName: tech.fullName || tech.name,
    }),
  };
  await bookingStore.setJSON(bookingId, patched);
  return jsonCors(200, {
    ok: true,
    bookingId,
    assignedTechId: patched.assignedTechId,
    assignedTechName: patched.assignedTechName,
    jobStatus: patched.jobStatus,
  });
};
