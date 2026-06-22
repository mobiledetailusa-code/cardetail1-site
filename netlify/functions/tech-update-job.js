// netlify/functions/tech-update-job.js
// Technician-only: update status on assigned jobs.
// Auth: x-tech-token header (tech session token).
//
// POST { bookingId, status, note? }
// Allowed statuses: accepted, en_route, arrived, in_progress, completed, issue_reported
// Writes: status fields, technicianId, timestamp, eventLog entry.

const crypto = require('crypto');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-tech-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const json = (status, body) => ({ statusCode: status, headers: CORS, body: JSON.stringify(body) });

const ALLOWED_STATUSES = new Set([
  'accepted', 'en_route', 'arrived', 'in_progress', 'completed', 'issue_reported',
]);

// Map tech statuses to legacy status display values
const STATUS_DISPLAY = {
  accepted: 'Scheduled',
  en_route: 'En Route',
  arrived: 'In Progress',
  in_progress: 'In Progress',
  completed: 'Completed',
  issue_reported: 'Problem',
};

async function getStore(name) {
  const { getStore: gs } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token) ? gs({ name, siteID, token }) : gs(name);
}

async function securityLog(entry) {
  try {
    const store = await getStore('cd1-security-log');
    const key = 'log-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    await store.setJSON(key, { ...entry, at: new Date().toISOString() });
  } catch (_) {}
}

async function validateTechSession(token) {
  if (!token || token.length < 32) return null;
  const sessStore = await getStore('cd1-tech-sessions');
  const key = 'tsess-' + token.slice(0, 16);
  const s = await sessStore.get(key, { type: 'json' }).catch(() => null);
  if (!s || Date.now() > s.expiresAt) return null;
  if (!crypto.timingSafeEqual(Buffer.from(s.token), Buffer.from(token))) return null;

  const techStore = await getStore('cd1-tech-accounts');
  const tech = await techStore.get('tech-' + s.techId, { type: 'json' }).catch(() => null);
  if (!tech || !tech.active) return null;
  return s;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });

  const h = event.headers || {};
  const token = (h['x-tech-token'] || h['X-Tech-Token'] || '').trim();
  const session = await validateTechSession(token);
  if (!session) {
    await securityLog({ type: 'tech_update_unauthorized', ip: (h['x-forwarded-for'] || '').slice(0, 45) });
    return json(401, { ok: false, error: 'unauthorized' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'invalid_json' }); }

  const bookingId = String(body.bookingId || '').trim();
  const newStatus = String(body.status || '').trim().toLowerCase();
  const note = String(body.note || '').trim().slice(0, 500);

  if (!bookingId) return json(400, { ok: false, error: 'bookingId_required' });
  if (!ALLOWED_STATUSES.has(newStatus)) {
    return json(400, { ok: false, error: 'invalid_status', allowed: [...ALLOWED_STATUSES] });
  }

  try {
    const store = await getStore('cd1-bookings');
    const booking = await store.get(bookingId, { type: 'json' }).catch(() => null);
    if (!booking) return json(404, { ok: false, error: 'booking_not_found' });

    // Verify this job is assigned to the requesting technician
    const at = (booking.assignedTech || booking.assignedTechName || '').toLowerCase();
    if (at !== session.techId.toLowerCase() && at !== session.techName.toLowerCase()) {
      await securityLog({
        type: 'tech_update_forbidden',
        techId: session.techId,
        bookingId,
        reason: 'not_assigned',
      });
      return json(403, { ok: false, error: 'not_assigned_to_you' });
    }

    const now = new Date().toISOString();
    const eventLog = Array.isArray(booking.eventLog) ? [...booking.eventLog] : [];
    const logEntry = {
      action: 'tech_status_update',
      status: newStatus,
      at: now,
      by: 'technician',
      technicianId: session.techId,
    };
    if (note) logEntry.note = note;
    eventLog.push(logEntry);

    // Build updates
    const updates = {
      jobStatus: newStatus,
      status: STATUS_DISPLAY[newStatus] || booking.status,
      lastTechUpdate: now,
      lastTechUpdateBy: session.techId,
      eventLog,
      updatedAt: now,
    };

    // Set lifecycle timestamps
    if (newStatus === 'en_route') updates.enRouteAt = now;
    if (newStatus === 'arrived') updates.arrivedAt = now;
    if (newStatus === 'in_progress') updates.startedAt = now;
    if (newStatus === 'completed') updates.completedAt = now;
    if (newStatus === 'issue_reported') {
      updates.hasProblem = true;
      updates.lastProblem = note || 'Issue reported by technician';
    }

    if (note) updates.techNotes = ((booking.techNotes || '') + '\n[' + now.slice(0, 16) + '] ' + note).trim();

    const patched = { ...booking, ...updates };
    await store.setJSON(bookingId, patched);

    await securityLog({
      type: 'tech_status_update',
      techId: session.techId,
      bookingId,
      status: newStatus,
    });

    return json(200, {
      ok: true,
      bookingId,
      status: newStatus,
      displayStatus: STATUS_DISPLAY[newStatus],
      updatedAt: now,
    });
  } catch (e) {
    return json(500, { ok: false, error: 'update_failed' });
  }
};
