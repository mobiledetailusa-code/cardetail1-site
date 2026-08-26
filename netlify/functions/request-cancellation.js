// Customer-initiated cancellation request with rate limiting and status policy.

const { getBooking, bookingStore } = require('../lib/ops-db');
const { authorizeBookingAccess, normalizeBookingId } = require('../lib/booking-customer-auth');
const { canRequestChange } = require('../lib/appointment-status-policy');
const { createChangeRequest, sanitizeSnapshot } = require('../lib/customer-change-requests');
const { enforcePublicRateLimit } = require('../lib/public-rate-limit');
const { phonesMatch, normalizeUsPhoneDigits } = require('../lib/phone-auth');

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

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const json = (status, body) => ({ statusCode: status, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });

  const rateLimit = await enforcePublicRateLimit(event, { endpoint: 'request-cancellation', cors: false });
  if (rateLimit.blocked) return rateLimit.response;

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'validation_error' }); }

  const bookingId = normalizeBookingId(p.bookingId);
  const phone = normalizeUsPhoneDigits(p.phone);
  const email = String(p.email || '').toLowerCase().slice(0, 120);
  const reason = String(p.reason || '').slice(0, 1000).trim();
  const ack = p.acknowledgedPolicy === true;

  if (!bookingId) return json(400, { ok: false, error: 'validation_error', message: 'Booking ID is required.' });
  if (!reason) return json(400, { ok: false, error: 'validation_error', message: 'Please provide a reason.' });
  if (!ack) return json(400, { ok: false, error: 'validation_error', message: 'Policy acknowledgment is required.' });
  if (!phone && !email) return json(400, { ok: false, error: 'validation_error', message: 'Verification required.' });

  const auth = await authorizeBookingAccess(event, { bookingId, phone: p.phone });
  let booking = auth.ok ? auth.booking : null;

  if (!booking && email) {
    const { getBooking } = require('../lib/ops-db');
    const candidate = await getBooking(bookingId);
    const bookingEmail = String(candidate?.email || '').toLowerCase();
    if (candidate && bookingEmail && email === bookingEmail) booking = candidate;
  }

  if (!booking) {
    return json(200, { ok: false, error: 'authentication_failed', message: 'Verification failed.' });
  }

  if (phone) {
    const stored = booking.phone || booking.customerPhone || '';
    if (!phonesMatch(phone, stored)) {
      return json(200, { ok: false, error: 'authentication_failed', message: 'Verification failed.' });
    }
  }

  const policy = canRequestChange(booking, 'cancel');
  if (!policy.ok) {
    return json(200, {
      ok: false,
      error: 'action_not_allowed',
      message: policy.requiresCall
        ? 'This appointment is in progress. Please call or text Cardetail1 to cancel.'
        : 'Online cancellation is not available for this appointment.',
    });
  }

  if (booking.cancellationRequestStatus === 'requested') {
    return json(200, { ok: true, alreadyRequested: true });
  }

  const now = new Date().toISOString();
  const changeRecord = await createChangeRequest({
    bookingId,
    requestType: 'cancellation',
    previousState: sanitizeSnapshot(booking),
    requestedState: { reason },
    authorizedRef: auth.ok ? auth.scope : 'email',
    status: 'pending_approval',
  });

  const eventLog = Array.isArray(booking.eventLog) ? [...booking.eventLog] : [];
  eventLog.push({ action: 'cancellation_requested', at: now, by: 'customer', reason, changeRequestId: changeRecord.id });

  const updated = {
    status: 'Cancellation Requested',
    previousStatus: booking.status || 'Pending Review',
    cancellationRequestStatus: 'requested',
    cancellationRequestedAt: now,
    cancellationReason: reason,
    cancellationAcknowledgedPolicy: true,
    updatedAt: now,
    eventLog,
  };

  let store;
  try {
    store = await bookingStore();
    await store.setJSON(bookingId, { ...booking, ...updated });
  } catch {
    return json(503, { ok: false, error: 'service_unavailable', message: 'Failed to save request. Please try again.' });
  }

  await notifyAdmin(
    `Cardetail1 — Cancellation Request · ${bookingId}`,
    `Customer requested cancellation for booking ${bookingId}.\nReason: ${reason}\nNo charge has been applied. Admin review required.`
  );

  try {
    const { notifyCancellationRequested } = require('../lib/appointment-lifecycle-notifications');
    await notifyCancellationRequested({ ...booking, ...updated }, {
      event,
      store,
      source: 'lifecycle_mutation',
    });
  } catch (e) {
    console.warn('[request-cancellation] lifecycle notify failed:', e.message);
  }

  return json(200, { ok: true, changeRequestId: changeRecord.id });
};
