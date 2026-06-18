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

const json = (status, body) => ({
  statusCode: status,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Cache-Control': 'no-store',
  },
  body: JSON.stringify(body),
});

async function blobsStore(name) {
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token) ? getStore({ name, siteID, token }) : getStore(name);
}

// Normalize phone: strip non-digits, strip leading US country code (1) if 11 digits
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.charAt(0) === '1') return digits.slice(1);
  return digits;
}

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
    confirmedWindow: b.confirmedWindow || '',
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
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST')    return json(405, { ok: false, error: 'method_not_allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'invalid_request' }); }

  // Normalize inputs
  const rawId    = String(body.bookingId || body.id || '').trim().toUpperCase().replace(/[^A-Z0-9\-]/g, '');
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
        ok: false, found: 'id_only',
        message: 'We found the booking ID, but the phone number does not match our records.',
      });
    }

    return json(200, { ok: true, booking: safeBooking(booking) });
  } catch (e) {
    return json(500, { ok: false, error: 'lookup_failed' });
  }
};
