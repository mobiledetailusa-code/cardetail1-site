// netlify/functions/tag-booking.js
// Admin-only: set archive/test flags on a booking stored in Blobs.
// Only updates: isTest, archived, archivedReason, archivedAt.
// All other booking fields (customer, payment, service, dispatch) are never touched.
//
// POST { bookingId, isTest?, archived?, archivedReason?, archivedAt? }
// Header: x-admin-key: <ADMIN_DASH_PASSWORD>
//
// Responses:
//   { ok: true, bookingId, updated: { ... } }
//   { ok: false, error: '...' }

const crypto = require('crypto');
const { json: secureJson } = require('./_security');

let currentEvent;
const json = (status, body) => secureJson(currentEvent, status, body);

async function blobsStore(name) {
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token) ? getStore({ name, siteID, token }) : getStore(name);
}

exports.handler = async (event) => {
  currentEvent = event;
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST')    return json(405, { ok: false, error: 'method_not_allowed' });

  const expected = (process.env.ADMIN_DASH_PASSWORD || '').trim();
  if (!expected) return json(503, { ok: false, error: 'missing_admin_password_config' });

  const provided = (
    (event.headers && (event.headers['x-admin-key'] || event.headers['X-Admin-Key'])) || ''
  ).trim();

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) return json(401, { ok: false, error: 'unauthorized' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'invalid_request' }); }

  const bookingId = String(body.bookingId || '').trim().toUpperCase().replace(/[^A-Z0-9\-]/g, '');
  if (!bookingId) return json(400, { ok: false, error: 'bookingId_required' });

  // Only accept the four allowed flag fields — no arbitrary booking modification.
  const updates = {};
  if (typeof body.isTest         === 'boolean') updates.isTest         = body.isTest;
  if (typeof body.archived       === 'boolean') updates.archived       = body.archived;
  if (typeof body.archivedReason === 'string')  updates.archivedReason = body.archivedReason.slice(0, 200);
  if (typeof body.archivedAt     === 'string')  updates.archivedAt     = body.archivedAt.slice(0, 64);

  if (!Object.keys(updates).length)
    return json(400, { ok: false, error: 'provide at least one valid flag field' });

  try {
    const store   = await blobsStore('cd1-bookings');
    const booking = await store.get(bookingId, { type: 'json' }).catch(() => null);
    if (!booking) return json(404, { ok: false, error: 'booking_not_found' });

    const now = new Date().toISOString();
    const isArchivingTest = updates.archived === true || updates.isTest === true;

    // Augment with metadata fields when archiving.
    if (isArchivingTest) {
      updates.archivedBy     = 'admin';
      updates.previousStatus = booking.status || '';
      updates.status         = 'archived_test';
      if (!updates.archivedAt) updates.archivedAt = now;
    }

    const eventLog = Array.isArray(booking.eventLog) ? [...booking.eventLog] : [];
    eventLog.push({
      action: isArchivingTest ? 'archived_test' : 'tag_updated',
      at: now,
      by: 'admin',
      flags: Object.keys(updates),
    });

    // Patch only the allowed flags + metadata; all other fields remain exactly as stored.
    const patched = { ...booking, ...updates, eventLog, updatedAt: now };
    await store.setJSON(bookingId, patched);

    return json(200, { ok: true, bookingId, updated: updates });
  } catch (e) {
    return json(500, { ok: false, error: 'update_failed' });
  }
};
