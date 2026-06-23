// netlify/functions/submit-customer-action.js
// Customer-initiated booking actions: reschedule request, address update, addon request.
// Auth: bookingId + phone verification (same pattern as request-cancellation.js).
// ALWAYS writes to Blobs first. Admin email is best-effort and never blocks the write.
//
// POST { bookingId, phone, action, ...payload }
// action: 'reschedule_request' | 'address_update' | 'addon_request'
//
// Blobs written per action:
//   reschedule_request: rescheduledByClient, rescheduleRequestedAt, rescheduleRequestedDate, rescheduleRequestedTime
//   address_update:     addressChangedByClient, addressUpdateRequestedAt, requestedAddress
//   addon_request:      addonsRequested, addonRequestedAt, requestedAddons
//
// Every action appends an eventLog entry: { action, at, by:'customer', ...details }

const {
  blobsStore,
  cleanBookingId,
  cleanText,
  json: secureJson,
  normalizePhone,
  phonesMatchExact,
  rateLimit,
} = require('./_security');

let currentEvent;
const json = (status, body) => secureJson(currentEvent, status, body, { allowHeaders: 'Content-Type' });

async function notifyAdmin(subject, text) {
  const { ADMIN_EMAIL, RESEND_API_KEY, RESEND_FROM } = process.env;
  if (!ADMIN_EMAIL || !RESEND_API_KEY) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: RESEND_FROM || 'Cardetail1 <onboarding@resend.dev>',
        to:   [ADMIN_EMAIL],
        subject,
        text,
      }),
    });
  } catch (e) {
    console.warn('[submit-customer-action] email error:', e.message);
  }
}

const ALLOWED_ACTIONS = new Set(['reschedule_request', 'address_update', 'addon_request']);

exports.handler = async (event) => {
  currentEvent = event;
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST')    return json(405, { ok: false, userMessage: 'Method not allowed' });
  const rl = await rateLimit(event, 'submit-customer-action', 20, 60);
  if (!rl.ok) return json(rl.status, rl.body);

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, userMessage: 'Invalid request' }); }

  const bookingId = cleanBookingId(p.bookingId);
  const phone     = normalizePhone(p.phone);
  const action    = String(p.action    || '');

  if (!bookingId)              return json(400, { ok: false, userMessage: 'Booking ID is required' });
  if (!phone)                  return json(400, { ok: false, userMessage: 'Phone is required' });
  if (!ALLOWED_ACTIONS.has(action)) return json(400, { ok: false, userMessage: 'Invalid action' });

  let store, booking;
  try {
    store   = await blobsStore('cd1-bookings');
    booking = await store.get(bookingId, { type: 'json' });
  } catch (e) {
    return json(503, { ok: false, userMessage: 'Service unavailable. Please try again.' });
  }
  if (!booking) return json(404, { ok: false, userMessage: 'Booking not found.' });

  // Verify phone by exact normalized match; suffix-only matching is too weak.
  if (!phonesMatchExact(phone, booking.phone)) {
    console.warn('[submit-customer-action] auth mismatch', bookingId);
    return json(403, { ok: false, userMessage: 'Verification failed. Phone does not match the booking.' });
  }

  const now = new Date().toISOString();
  let updates = {};
  let logEntry = { action, at: now, by: 'customer' };
  let adminSubject = '';
  let adminText    = '';
  const custName   = `${booking.firstName || ''} ${booking.lastName || ''}`.trim();

  if (action === 'reschedule_request') {
    const newDate = cleanText(p.newDate, 20);
    const newTime = cleanText(p.newTime, 80);
    if (!newDate) return json(400, { ok: false, userMessage: 'Please provide a new preferred date.' });
    updates = {
      rescheduledByClient:      true,
      rescheduleRequestedAt:    now,
      rescheduleRequestedDate:  newDate,
      rescheduleRequestedTime:  newTime || '',
    };
    logEntry.requestedDate = newDate;
    if (newTime) logEntry.requestedTime = newTime;
    adminSubject = `Cardetail1 — Reschedule Request · ${bookingId}`;
    adminText = [
      `Customer requested reschedule for booking ${bookingId}.`,
      ``,
      `Requested date: ${newDate}`,
      newTime ? `Requested time: ${newTime}` : '',
      `Current preferred date: ${booking.preferredDate || '—'}`,
      `Service: ${booking.package || booking.service || '—'}`,
      `Customer: ${custName}`,
      `Phone: ${booking.phone || ''}`,
    ].filter(Boolean).join('\n');
  } else if (action === 'address_update') {
    const newAddress = cleanText(p.newAddress, 400);
    if (!newAddress) return json(400, { ok: false, userMessage: 'Please provide a new address.' });
    updates = {
      addressChangedByClient:    true,
      addressUpdateRequestedAt:  now,
      requestedAddress:          newAddress,
    };
    logEntry.requestedAddress = newAddress;
    adminSubject = `Cardetail1 — Address Update Request · ${bookingId}`;
    adminText = [
      `Customer requested an address change for booking ${bookingId}.`,
      ``,
      `Requested address: ${newAddress}`,
      `Current address: ${booking.address || '—'}`,
      `Service: ${booking.package || booking.service || '—'}`,
      `Customer: ${custName}`,
      `Phone: ${booking.phone || ''}`,
    ].join('\n');
  } else if (action === 'addon_request') {
    const requestedAddons = cleanText(p.requestedAddons, 1000);
    if (!requestedAddons) return json(400, { ok: false, userMessage: 'Please select at least one add-on.' });
    updates = {
      addonsRequested:    true,
      addonRequestedAt:   now,
      requestedAddons,
    };
    logEntry.requestedAddons = requestedAddons;
    adminSubject = `Cardetail1 — Add-On Request · ${bookingId}`;
    adminText = [
      `Customer requested add-ons for booking ${bookingId}.`,
      ``,
      `Requested add-ons: ${requestedAddons}`,
      `Service: ${booking.package || booking.service || '—'}`,
      `Customer: ${custName}`,
      `Phone: ${booking.phone || ''}`,
    ].join('\n');
  }

  // Append to eventLog without overwriting existing entries
  const eventLog = Array.isArray(booking.eventLog) ? [...booking.eventLog] : [];
  eventLog.push(logEntry);

  const patched = { ...booking, ...updates, eventLog, updatedAt: now };
  try {
    await store.setJSON(bookingId, patched);
  } catch (e) {
    return json(503, { ok: false, userMessage: 'Failed to save request. Please try again.' });
  }

  // Email is best-effort — a failure here does NOT block the response
  notifyAdmin(adminSubject, adminText).catch(() => {});

  console.log('[submit-customer-action]', action, bookingId);
  return json(200, { ok: true });
};
