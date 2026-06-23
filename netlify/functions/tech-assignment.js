const {
  TECH_STORE, BOOKING_STORE, blobStore, requireAdmin, normalizeId, securityEvent,
} = require('../lib/tech-security');

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });

exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });
  const admin = requireAdmin(event);
  if (!admin.ok) return json(admin.status, { ok: false, error: admin.error });
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'invalid_json' }); }

  const bookingId = normalizeId(body.bookingId);
  const action = String(body.action || 'assign');
  if (!bookingId) return json(400, { ok: false, error: 'bookingId_required' });

  try {
    const bookings = await blobStore(BOOKING_STORE);
    const booking = await bookings.get(bookingId, { type: 'json' }).catch(() => null);
    if (!booking) return json(404, { ok: false, error: 'booking_not_found' });
    const now = new Date().toISOString();
    const priorTechId = booking.assignedTechId || booking.assignedTech || '';

    if (action === 'unassign') {
      booking.assignedTechId = '';
      booking.assignedTechName = '';
      booking.assignedTech = '';
      booking.assignedAt = '';
      booking.assignedBy = admin.adminId;
      booking.jobStatus = 'not_started';
      booking.updatedAt = now;
      booking.eventLog = [...(Array.isArray(booking.eventLog) ? booking.eventLog : []), {
        type: 'technician_unassigned', at: now, actorRole: 'admin', actorId: admin.adminId, priorTechId,
      }].slice(-200);
    } else {
      const techId = normalizeId(body.techId);
      const tech = await (await blobStore(TECH_STORE)).get(techId, { type: 'json' }).catch(() => null);
      if (!tech) return json(404, { ok: false, error: 'technician_not_found' });
      if (tech.active === false) return json(400, { ok: false, error: 'technician_inactive' });
      booking.assignedTechId = tech.techId;
      booking.assignedTechName = tech.fullName;
      booking.assignedTech = tech.techId;
      booking.assignedAt = now;
      booking.assignedBy = admin.adminId;
      booking.jobStatus = 'assigned';
      booking.updatedAt = now;
      booking.eventLog = [...(Array.isArray(booking.eventLog) ? booking.eventLog : []), {
        type: priorTechId && priorTechId !== tech.techId ? 'technician_reassigned' : 'technician_assigned',
        at: now, actorRole: 'admin', actorId: admin.adminId, techId: tech.techId, priorTechId,
      }].slice(-200);
    }
    await bookings.setJSON(bookingId, booking);
    return json(200, { ok: true, booking: {
      id: booking.id, assignedTechId: booking.assignedTechId,
      assignedTechName: booking.assignedTechName, assignedAt: booking.assignedAt,
      assignedBy: booking.assignedBy, jobStatus: booking.jobStatus,
    } });
  } catch (error) {
    await securityEvent('admin_assignment_error', { bookingId, message: error.message });
    return json(500, { ok: false, error: 'server_error' });
  }
};
