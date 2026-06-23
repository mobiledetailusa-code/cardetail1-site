// netlify/functions/request-cancellation.js
// Customer-initiated cancellation request. Dual-factor auth: bookingId +
// matching phone OR email from the booking record. Does NOT charge the card,
// does NOT delete the booking, does NOT auto-set appointmentStatus.
// Sets cancellationRequestStatus: 'requested' for admin review.

const {
  blobsStore,
  cleanBookingId,
  cleanEmail,
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
        to: [ADMIN_EMAIL],
        subject,
        text,
      }),
    });
  } catch (e) { console.warn('[request-cancellation] email error:', e.message); }
}

exports.handler = async (event) => {
  currentEvent = event;
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, userMessage: 'Method not allowed' });
  const rl = await rateLimit(event, 'request-cancellation', 12, 60);
  if (!rl.ok) return json(rl.status, rl.body);

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, userMessage: 'Invalid request' }); }

  const bookingId = cleanBookingId(p.bookingId);
  const phone     = normalizePhone(p.phone);
  const email     = cleanEmail(p.email);
  const reason    = cleanText(p.reason, 1000);
  const ack       = p.acknowledgedPolicy === true;

  if (!bookingId)    return json(400, { ok: false, userMessage: 'Booking ID is required' });
  if (!reason)       return json(400, { ok: false, userMessage: 'Please provide a reason' });
  if (!ack)          return json(400, { ok: false, userMessage: 'Policy acknowledgment is required' });
  if (!phone && !email) return json(400, { ok: false, userMessage: 'Verification required' });

  let store, booking;
  try {
    store   = await blobsStore('cd1-bookings');
    booking = await store.get(bookingId, { type: 'json' });
  } catch (e) {
    return json(503, { ok: false, userMessage: 'Service unavailable. Please try again.' });
  }
  if (!booking) return json(404, { ok: false, userMessage: 'Booking not found.' });

  // Dual-factor: bookingId (verified above) + phone OR email match.
  const bookingEmail = String(booking.email || '').toLowerCase();
  const phoneOk = phonesMatchExact(phone, booking.phone);
  const emailOk = email && bookingEmail && email === bookingEmail;

  if (!phoneOk && !emailOk) {
    console.warn('[request-cancellation] auth mismatch', bookingId);
    return json(403, { ok: false, userMessage: 'Verification failed. Phone or email does not match the booking.' });
  }

  // Idempotent: return success if already requested.
  if (booking.cancellationRequestStatus === 'requested') {
    return json(200, { ok: true, alreadyRequested: true });
  }

  const now = new Date().toISOString();
  const eventLog = Array.isArray(booking.eventLog) ? [...booking.eventLog] : [];
  eventLog.push({ action: 'cancellation_requested', at: now, by: 'customer', reason });

  const updated = {
    ...booking,
    status:                      'Cancellation Requested',
    previousStatus:              booking.status || 'Pending Review',
    cancellationRequestStatus:   'requested',
    cancellationRequestedAt:     now,
    cancellationReason:          reason,
    cancellationAcknowledgedPolicy: true,
    updatedAt:                   now,
    eventLog,
  };

  try {
    await store.setJSON(bookingId, updated);
  } catch (e) {
    return json(503, { ok: false, userMessage: 'Failed to save request. Please try again.' });
  }

  await notifyAdmin(
    `Cardetail1 — Cancellation Request · ${bookingId}`,
    `Customer requested cancellation for booking ${bookingId}.\n\n` +
    `Service: ${booking.service || booking.package || '—'}\n` +
    `Preferred date: ${booking.preferredDate || '—'}\n` +
    `Reason: ${reason}\n\n` +
    `Customer acknowledged the cancellation/no-show policy.\n` +
    `No charge has been applied. Admin review required before any action.`
  );

  console.log('[request-cancellation] ok', bookingId);
  return json(200, { ok: true });
};
