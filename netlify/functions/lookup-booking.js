// netlify/functions/lookup-booking.js
// Customer-facing booking lookup — no admin auth required.
// Requires both bookingId AND phone to prevent enumeration attacks.
//
// POST { bookingId, phone }
//   bookingId — e.g. "CD1-XXXXX" (normalized: trim + uppercase)
//   phone     — any format; normalized to 10 digits (strips non-digits, strips leading +1)
//
// Responses:
//   { ok: true,  booking: <safe fields> }
//   { ok: false, found: false,      message: '…' }  — ID not found
//   { ok: false, found: 'id_only',  message: '…' }  — ID found but phone mismatch
//
// Safe fields returned — never exposes: paymentIntentId, amountAuthorizedCents,
// card data, admin notes, technician payout, dispatch fields, BID_SECRET.
//
// Env: NETLIFY_SITE_ID + NETLIFY_AUTH_TOKEN (same pattern as submit-booking.js)

const {
  blobsStore,
  cleanBookingId,
  json: secureJson,
  normalizePhone,
  rateLimit,
} = require('./_security');

let currentEvent;
const json = (status, body) => secureJson(currentEvent, status, body, { allowHeaders: 'Content-Type' });

// Returns only fields safe to expose to customers.
function safeBooking(b) {
  return {
    id:              b.id,
    status:          b.status || 'Pending Review',
    package:         b.package  || b.service || '',
    vehicle:         b.vehicle  || b.vehicleCategory || '',
    vehicles: (b.vehicles || []).map(v => ({
      pkgName:      v.pkgName      || '',
      vehicleLabel: v.vehicleLabel || '',
      pkgIcon:      v.pkgIcon      || '🚗',
      subtotal:     v.subtotal     || 0,
      addons: (v.addons || []).map(a => ({ name: a.name || '', qty: a.qty || 1 })),
    })),
    addons:          (b.addons || []).map(a => ({ name: a.name || '' })),
    preferredDate:   b.preferredDate   || '',
    confirmedWindow: b.confirmedTimeWindow || b.confirmedWindow || '',
    preferredTime:   b.preferredTime   || '',
    address:         b.address         || '',
    totalPrice:      b.totalPrice      || 0,
    tip:             b.tip             || 0,
    payLink:         b.payLink         || '',
    paymentMethodPreference: b.paymentMethodPreference || '',
    cardOnFileStatus: b.cardOnFileStatus || 'pending',
    appointmentStatus: b.appointmentStatus || 'pending_review',
    jobStatus:       b.jobStatus || 'not_started',
    cancellationRequestStatus: b.cancellationRequestStatus || '',
    cancellationRequestedAt: b.cancellationRequestedAt || '',
    createdAt:       b.createdAt       || '',
  };
}

exports.handler = async (event) => {
  currentEvent = event;
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST')    return json(405, { ok: false, error: 'method_not_allowed' });
  const rl = await rateLimit(event, 'lookup-booking', 30, 60);
  if (!rl.ok) return json(rl.status, rl.body);

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'invalid_request' }); }

  // Normalize inputs
  const rawId    = cleanBookingId(body.bookingId || body.id);
  const rawPhone = normalizePhone(body.phone || body.customerPhone || '');

  if (!rawId)    return json(400, { ok: false, error: 'bookingId is required' });
  if (!rawPhone) return json(400, { ok: false, error: 'phone is required' });
  if (rawPhone.length < 7) return json(400, { ok: false, error: 'invalid_phone' });

  try {
    const store   = await blobsStore('cd1-bookings');
    const booking = await store.get(rawId, { type: 'json' }).catch(() => null);

    if (!booking) {
      return json(200, {
        ok: false, found: false,
        message: 'No booking found. Please check your booking ID and phone number.',
      });
    }

    // Validate phone — prevents booking ID enumeration from exposing any data
    const storedPhone = normalizePhone(booking.phone || booking.customerPhone || '');
    if (!storedPhone || storedPhone !== rawPhone) {
      return json(200, {
        ok: false, found: false,
        message: 'No booking found. Please check your booking ID and phone number.',
      });
    }

    return json(200, { ok: true, booking: safeBooking(booking) });
  } catch (e) {
    return json(500, { ok: false, error: 'lookup_failed' });
  }
};
