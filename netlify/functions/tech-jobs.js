const {
  BOOKING_STORE, blobStore, normalizeId, listStore, validateTechSession, securityEvent,
} = require('../lib/tech-security');

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-tech-token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const json = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });
const STATUSES = new Set(['accepted', 'en_route', 'arrived', 'in_progress', 'completed', 'issue_reported']);

function safeJob(booking) {
  const lastInitial = String(booking.lastName || '').trim().charAt(0);
  return {
    id: booking.id,
    date: booking.confirmedDate || booking.preferredDate || '',
    timeWindow: booking.confirmedTimeWindow || booking.confirmedTime || booking.preferredTime || '',
    customerName: `${booking.firstName || 'Customer'}${lastInitial ? ` ${lastInitial}.` : ''}`,
    address: booking.address || '',
    phone: booking.phone || '',
    vehicle: booking.vehicleLabel || booking.vehicle || booking.vehicleCategory || '',
    package: booking.package || booking.service || '',
    addons: (booking.addons || booking.addOns || []).map(item => ({
      name: String(item.name || ''), qty: Number(item.qty || 1),
    })),
    customerNote: booking.customerNote || booking.notes || '',
    jobStatus: booking.jobStatus || 'assigned',
    updatedAt: booking.updatedAt || '',
  };
}

exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  const auth = await validateTechSession(event);
  if (!auth.ok) return json(auth.status, { ok: false, error: auth.error });

  try {
    const store = await blobStore(BOOKING_STORE);
    if (event.httpMethod === 'GET') {
      const jobs = (await listStore(store))
        .filter(b => (b.assignedTechId || b.assignedTech) === auth.tech.techId && !b.isDraft && !b.archived)
        .map(safeJob)
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
      return json(200, { ok: true, jobs });
    }
    if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { ok: false, error: 'invalid_json' }); }
    const allowedKeys = new Set(['bookingId', 'jobStatus', 'note']);
    const forbiddenKey = Object.keys(body).find(key => !allowedKeys.has(key));
    if (forbiddenKey) return json(400, { ok: false, error: 'field_not_allowed', field: forbiddenKey });
    const bookingId = normalizeId(body.bookingId);
    const jobStatus = String(body.jobStatus || '').trim();
    const note = String(body.note || '').trim().slice(0, 1000);
    if (!bookingId || !STATUSES.has(jobStatus)) return json(400, { ok: false, error: 'invalid_status_update' });
    const booking = await store.get(bookingId, { type: 'json' }).catch(() => null);
    if (!booking) return json(404, { ok: false, error: 'booking_not_found' });
    if ((booking.assignedTechId || booking.assignedTech) !== auth.tech.techId) {
      await securityEvent('technician_cross_job_access', { techId: auth.tech.techId, bookingId, action: 'status_update' });
      return json(403, { ok: false, error: 'job_not_assigned_to_technician' });
    }
    const now = new Date().toISOString();
    booking.jobStatus = jobStatus;
    booking.updatedAt = now;
    booking.technicianId = auth.tech.techId;
    booking.technicianName = auth.tech.fullName;
    if (note) booking.technicianNote = note;
    booking.eventLog = [...(Array.isArray(booking.eventLog) ? booking.eventLog : []), {
      type: 'technician_job_status', at: now, actorRole: 'technician',
      technicianId: auth.tech.techId, technicianName: auth.tech.fullName,
      jobStatus, ...(note ? { note } : {}),
    }].slice(-200);
    await store.setJSON(bookingId, booking);
    return json(200, { ok: true, job: safeJob(booking) });
  } catch (error) {
    console.error('[tech-jobs]', error.message);
    return json(500, { ok: false, error: 'server_error' });
  }
};
