// netlify/functions/submit-booking.js
// Accepts a booking, assigns a server-side ID, stores to Netlify Blobs,
// notifies admin, and optionally sends customer confirmation.
//
// Security model:
//   C-1: paymentStatus can only be set by stripe-webhook.js (HMAC-verified).
//        This endpoint never trusts client-submitted payment state.
//   C-3: Booking ID is always generated server-side. Client-submitted id/bookingId
//        are ignored. Collision-checked against Blobs before writing.
//   Draft mode: Step 5 pre-registers a minimal booking so create-setup-intent
//        can create a SetupIntent tied to a server-owned booking ID.
//   Finalization: submitBooking() passes draftBookingId to merge full details into
//        an existing draft, preserving webhook-set payment fields.
//
// Canonical paymentStatus enum:
//   no_payment_required_yet | authorization_pending | authorized |
//   authorization_failed | capture_pending | paid | canceled |
//   refunded | expired
//
// This endpoint never dispatches or creates an auction.

const {
  blobsStore,
  cleanEmail,
  cleanText,
  clampNumber,
  json: secureJson,
  normalizePhone,
  rateLimit,
} = require('./_security');

let currentEvent;
const json = (status, body) => secureJson(currentEvent, status, body, { allowHeaders: 'Content-Type' });

// Fields that must never come from the browser.
// Payment state is owned exclusively by stripe-webhook.js (HMAC-verified).
// Admin/assignment state is owned by admin-authenticated endpoints.
const CLIENT_BLOCKED_FIELDS = [
  'paymentStatus', 'paymentIntentId', 'amountAuthorizedCents', 'amountCapturedCents',
  'capturedAt', 'captureInitiatedAt', 'stripeCustomerId', 'paymentMethodId',
  'stripePaymentMethodId', 'setupIntentId', 'cardOnFileSavedAt',
  // cardOnFileStatus is set exclusively by stripe-webhook (setup_intent.succeeded).
  'cardOnFileStatus', 'cardSavedAt',
  'status', 'appointmentStatus', 'jobStatus', 'adminNotes', 'assignedTech',
  'assignedTechName', 'confirmedDate', 'confirmedTimeWindow',
  'adminReviewed', 'archived',
];

const PAYMENT_PREFERENCES = new Set([
  'cash_onsite',
  'card_onsite',
  'online_after_service',
]);

// C-3: Generate a collision-resistant server-side booking ID.
function generateId() {
  return 'CD1-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

// C-3: Ensure the generated ID doesn't already exist in Blobs.
async function newUniqueId(store) {
  for (let i = 0; i < 5; i++) {
    const id = generateId();
    const existing = await store.get(id, { type: 'json' }).catch(() => null);
    if (!existing) return id;
  }
  return generateId(); // unlikely collision after 5 tries; proceed anyway
}

function cleanLine(value, max = 160) {
  return cleanText(value, max);
}

function cleanDate(value) {
  const s = cleanText(value, 20);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function cleanAddon(a) {
  if (!a || typeof a !== 'object') return null;
  const name = cleanLine(a.name, 100);
  if (!name) return null;
  return {
    id: cleanLine(a.id, 60),
    name,
    price: clampNumber(a.price, 0, 5000, 0),
    qty: Math.round(clampNumber(a.qty || 1, 1, 20, 1)),
  };
}

function cleanVehicle(v) {
  if (!v || typeof v !== 'object') return null;
  const addons = (Array.isArray(v.addons) ? v.addons : []).map(cleanAddon).filter(Boolean).slice(0, 30);
  const addonTotal = addons.reduce((sum, a) => sum + (a.price * a.qty), 0);
  const basePrice = clampNumber(v.basePrice || v.packagePrice || 0, 0, 20000, 0);
  return {
    pkgName: cleanLine(v.pkgName || v.package || '', 120),
    pkgIcon: cleanLine(v.pkgIcon || '', 8),
    vehicleLabel: cleanLine(v.vehicleLabel || v.vehicle || '', 180),
    basePrice,
    addonTotal,
    addons,
    subtotal: basePrice + addonTotal,
  };
}

function sanitizeBooking(raw) {
  const vehicles = (Array.isArray(raw.vehicles) && raw.vehicles.length
    ? raw.vehicles
    : [{ ...raw, pkgName: raw.package, vehicleLabel: raw.vehicleLabel || raw.vehicle, basePrice: raw.packagePrice, addons: raw.addons }]
  ).map(cleanVehicle).filter(Boolean).slice(0, 20);

  const zoneSurcharge = clampNumber(raw.zoneSurcharge, 0, 5000, 0);
  const totalPrice = vehicles.reduce((sum, v) => sum + v.subtotal, 0) + zoneSurcharge;
  const phone = normalizePhone(raw.phone);

  return {
    ...raw,
    firstName: cleanLine(raw.firstName, 80),
    lastName: cleanLine(raw.lastName, 80),
    phone,
    email: cleanEmail(raw.email),
    address: cleanLine(raw.address, 240),
    zipCode: cleanLine(raw.zipCode || raw.zip, 12),
    zone: cleanLine(raw.zone || raw.zip_city, 120),
    vehicle: cleanLine(raw.vehicle, 180),
    vehicleLabel: cleanLine(raw.vehicleLabel || raw.vehicle_label, 180),
    package: cleanLine(raw.package || raw.package_name, 120),
    addons: vehicles[0] ? vehicles[0].addons : [],
    vehicles,
    vehicleCount: vehicles.length,
    packagePrice: vehicles[0] ? vehicles[0].basePrice : 0,
    addonTotal: vehicles[0] ? vehicles[0].addonTotal : 0,
    totalPrice,
    total_price: totalPrice,
    preferredDate: cleanDate(raw.preferredDate || raw.preferred_date),
    preferredTime: cleanLine(raw.preferredTime, 80),
    notes: cleanText(raw.notes, 1000),
    source: cleanLine(raw.source, 120),
    richSurcharge: cleanLine(raw.richSurcharge, 80),
    zoneSurcharge,
  };
}

function bookingText(b) {
  const vehicles = (b.vehicles || [])
    .map(v => `  • ${v.vehicleLabel || v.vehicle || 'Vehicle'} — ${v.pkgName || ''} ($${v.subtotal || 0})`)
    .join('\n');

  const PAY_STATUS_LABEL = {
    authorized:              'Card authorized (hold) — dispatch allowed',
    paid:                    'Captured / Paid',
    authorization_pending:   'Card not yet authorized — awaiting payment',
    authorization_failed:    'Authorization failed',
    no_payment_required_yet: 'No payment required yet',
    capture_pending:         'Authorized — capture pending after service',
    canceled:                'Canceled',
    refunded:                'Refunded',
    expired:                 'Authorization expired',
  };
  const payLabel = PAY_STATUS_LABEL[b.paymentStatus] || (b.paymentStatus || 'Unknown');
  const authorizedAmt = b.amountAuthorizedCents
    ? ' ($' + (b.amountAuthorizedCents / 100).toFixed(2) + ' held)'
    : '';

  return [
    `NEW BOOKING — ${b.id}`,
    `Status: ${b.status || 'Pending Review'}`,
    `Payment: ${payLabel}${authorizedAmt}`,
    `Payment preference: ${b.paymentMethodPreference || '—'}`,
    `Card on file: ${b.cardOnFileStatus || 'pending'}`,
    `Appointment: ${b.appointmentStatus || 'pending_review'}`,
    b.paymentIntentId ? `PaymentIntent: ${b.paymentIntentId}` : '',
    ``,
    `Customer: ${b.firstName || ''} ${b.lastName || ''}`,
    `Phone:    ${b.phone || ''}`,
    `Email:    ${b.email || ''}`,
    `Address:  ${b.address || ''}`,
    `ZIP/Zone: ${b.zipCode || ''} ${b.zone ? '· ' + b.zone : ''}`,
    `Date:     ${b.preferredDate || ''} ${b.preferredTime || ''}`,
    ``,
    `Service:  ${b.package || b.service || ''}`,
    vehicles ? `Vehicles:\n${vehicles}` : '',
    `Add-ons:  ${(b.addons || []).map(a => a.name).join(', ') || 'None'}`,
    `TOTAL:    $${b.totalPrice || 0}`,
    ``,
    `Notes:    ${b.notes || '—'}`,
  ].filter(Boolean).join('\n');
}

async function sendEmail(b) {
  const { ADMIN_EMAIL, RESEND_API_KEY, RESEND_FROM } = process.env;
  if (!ADMIN_EMAIL || !RESEND_API_KEY) return { sent: false, reason: 'email not configured' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: RESEND_FROM || 'Cardetail1 <onboarding@resend.dev>',
      to: [ADMIN_EMAIL],
      reply_to: b.email || undefined,
      subject: `New Cardetail1 Booking ${b.id} — ${b.firstName || ''} ${b.lastName || ''} ($${b.totalPrice || 0}) · ${b.paymentStatus || 'pending'}`,
      text: bookingText(b),
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    return { sent: false, reason: `resend ${res.status}: ${err}` };
  }
  return { sent: true };
}

async function sendCustomerEmail(b) {
  const { RESEND_API_KEY, RESEND_FROM } = process.env;
  if (!RESEND_API_KEY) return { sent: false, reason: 'email not configured' };
  if (!b.email) return { sent: false, reason: 'no customer email' };

  const name = [b.firstName, b.lastName].filter(Boolean).join(' ');
  const service = b.package || b.service || 'Detailing Service';
  const vehicle = b.vehicle || b.vehicleCategory || '—';
  const dateTime = [b.preferredDate, b.preferredTime].filter(Boolean).join(' ') || '—';
  const zip = b.zipCode || b.zone || '—';

  const text = [
    `Hi ${name},`,
    ``,
    `Your card was securely saved with Stripe. No charge has been made today.`,
    `Your booking request was received. This is not yet a confirmed appointment.`,
    ``,
    `Our team will review your location, vehicle condition, service type, weather, access, and availability before confirming. You will receive a separate confirmation once your appointment is approved.`,
    ``,
    `Requested details:`,
    ``,
    `  * Service: ${service}`,
    `  * Vehicle: ${vehicle}`,
    `  * Preferred date/time: ${dateTime}`,
    `  * Location/ZIP: ${zip}`,
    `  * Booking ID: ${b.id}`,
    ``,
    `What to expect next:`,
    `  * Our team reviews your request (usually within a few hours during business hours).`,
    `  * You will receive a confirmation with your confirmed date and time window.`,
    `  * Cancellation/no-show policy applies after appointment confirmation.`,
    ``,
    `Please make sure the vehicle will be accessible, legally parked, and has enough working space around it on the day of service.`,
    ``,
    `Cardetail1 Mobile Detailing`,
    `https://cardetail1.com`,
  ].join('\n');

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: RESEND_FROM || 'Cardetail1 <onboarding@resend.dev>',
        to: [b.email],
        subject: 'Cardetail1 — Booking Request Received',
        text,
      }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.log('[submit-booking] customer email failed:', res.status, err.slice(0, 200));
      return { sent: false, reason: `resend ${res.status}` };
    }
    console.log('[submit-booking] customer email sent to:', b.email);
    return { sent: true };
  } catch (e) {
    console.log('[submit-booking] customer email error:', e.message);
    return { sent: false, reason: e.message };
  }
}

async function sendSms(b) {
  const { TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM, ADMIN_SMS } = process.env;
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM || !ADMIN_SMS) return { sent: false, reason: 'sms not configured' };
  const body = new URLSearchParams({
    To: ADMIN_SMS,
    From: TWILIO_FROM,
    Body: `New booking ${b.id}: ${b.firstName || ''} ${b.lastName || ''} · ${b.package || b.service || ''} · $${b.totalPrice || 0} · ${b.preferredDate || ''} · pay:${b.paymentStatus || 'unknown'} · ${b.phone || ''}`,
  });
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    return { sent: false, reason: `twilio ${res.status}: ${err}` };
  }
  return { sent: true };
}

exports.handler = async (event) => {
  currentEvent = event;
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  const rl = await rateLimit(event, 'submit-booking', 12, 60);
  if (!rl.ok) return json(rl.status, rl.body);

  let b;
  try { b = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'Invalid JSON' }); }

  // C-1: Strip all fields the browser must never control.
  for (const f of CLIENT_BLOCKED_FIELDS) delete b[f];
  // C-3: Ignore any client-submitted ID entirely.
  delete b.id;
  delete b.bookingId;
  b = sanitizeBooking(b);

  if (!b.firstName || !b.phone || b.phone.length < 7) return json(400, { ok: false, error: 'Missing customer name or phone' });
  if (!b.address || !b.preferredDate) return json(400, { ok: false, error: 'Missing address or preferred date' });

  const store = await blobsStore('cd1-bookings');

  // ── Draft pre-registration (supports C-2: create-payment-intent fetches amount from Blobs) ──
  if (b.isDraft) {
    const preference = String(b.paymentMethodPreference || '');
    if (!PAYMENT_PREFERENCES.has(preference)) {
      return json(400, { ok: false, error: 'payment_preference_required' });
    }
    if (b.acceptedCardOnFilePolicy !== true) {
      return json(400, { ok: false, error: 'card_on_file_policy_required' });
    }
    const now = new Date().toISOString();
    const draftId = await newUniqueId(store);
    const draft = {
      id: draftId,
      isDraft: true,
      createdAt: now,
      totalPrice: b.totalPrice,
      paymentMethod: preference,
      // paymentMethodPreference: client-supplied ('card_on_file'|'card_onsite'|'cash_onsite')
      paymentMethodPreference: preference,
      // cardOnFileStatus: server-controlled. Only stripe-webhook may set 'saved'.
      cardOnFileRequired: true,
      cardOnFileStatus: 'pending',
      paymentStatus: 'no_payment_required_yet',
      appointmentStatus: 'pending_review',
      jobStatus: 'not_started',
      acceptedCardOnFilePolicy: true,
      acceptedCardOnFilePolicyAt: now,
      policyVersion: '2026-06-card-on-file',
      firstName: b.firstName || '',
      lastName: b.lastName || '',
      phone: b.phone || '',
      email: b.email || '',
      address: b.address || '',
      zipCode: b.zipCode || '',
      zone: b.zone || '',
      vehicle: b.vehicle || '',
      vehicleLabel: b.vehicleLabel || '',
      package: b.package || '',
      addons: b.addons || [],
      vehicles: b.vehicles || [],
      preferredDate: b.preferredDate || '',
      preferredTime: b.preferredTime || '',
      notes: b.notes || '',
    };
    try {
      await store.setJSON(draftId, draft);
    } catch (e) {
      return json(500, { ok: false, error: 'Failed to pre-register booking' });
    }
    return json(200, { ok: true, id: draftId, isDraft: true });
  }

  // ── Draft finalization: merge full booking into an existing draft ──
  // Preserves webhook-set payment fields (paymentStatus, paymentIntentId, amounts).
  const rawDraftId = String(b.draftBookingId || '').replace(/[^A-Za-z0-9\-]/g, '').slice(0, 48);
  if (rawDraftId) {
    delete b.draftBookingId;
    const existing = await store.get(rawDraftId, { type: 'json' }).catch(() => null);
    if (!existing) return json(404, { ok: false, error: 'Draft booking not found' });
    if (!existing.isDraft) return json(409, { ok: false, error: 'Booking already finalized' });
    if (existing.cardOnFileStatus !== 'saved') {
      return json(409, { ok: false, error: 'card_on_file_not_saved' });
    }
    const preference = String(b.paymentMethodPreference || '');
    if (!PAYMENT_PREFERENCES.has(preference) || preference !== existing.paymentMethodPreference) {
      return json(400, { ok: false, error: 'invalid_payment_preference' });
    }
    if (b.acceptedCardOnFilePolicy !== true || b.acceptedBookingPolicy !== true) {
      return json(400, { ok: false, error: 'booking_policy_required' });
    }
    const finalizedAt = new Date().toISOString();

    // Preserve fields the webhook may have already set on the draft.
    b = {
      ...b,
      id: rawDraftId,
      status: 'Pending Review',
      isDraft: false,
      createdAt: existing.createdAt,
      finalizedAt,
      paymentMethod: preference,
      paymentMethodPreference: preference,
      cardOnFileRequired: true,
      acceptedBookingPolicy: true,
      acceptedBookingPolicyAt: finalizedAt,
      acceptedCardOnFilePolicy: true,
      acceptedCardOnFilePolicyAt: existing.acceptedCardOnFilePolicyAt,
      policyVersion: '2026-06-card-on-file',
      // Payment fields: trust Blobs, not the browser
      paymentStatus:        'no_payment_required_yet',
      appointmentStatus:    'pending_review',
      jobStatus:            'not_started',
      // Card-on-file fields: set by stripe-webhook (setup_intent.succeeded)
      cardOnFileStatus:     existing.cardOnFileStatus,
      setupIntentId:        existing.setupIntentId,
      stripeCustomerId:     existing.stripeCustomerId,
      stripePaymentMethodId: existing.stripePaymentMethodId,
      cardOnFileSavedAt:    existing.cardOnFileSavedAt,
    };

    let stored = { saved: false };
    try {
      await store.setJSON(rawDraftId, b);
      stored = { saved: true };
    } catch (e) {
      return json(500, { ok: false, error: 'booking_store_failed' });
    }

    const [email, customerEmail, sms] = await Promise.all([
      sendEmail(b).catch(e => ({ sent: false, reason: e.message })),
      sendCustomerEmail(b).catch(e => ({ sent: false, reason: e.message })),
      sendSms(b).catch(e => ({ sent: false, reason: e.message })),
    ]);

    return json(200, {
      ok: true,
      id: b.id,
      status: b.status,
      paymentStatus: b.paymentStatus,
      stored,
      email,
      customerEmail,
      sms,
      appointmentStatus: b.appointmentStatus,
      cardOnFileStatus: b.cardOnFileStatus,
    });
  }

  // ── New booking (cash/on-site or any path that didn't pre-register a draft) ──
  return json(409, { ok: false, error: 'card_on_file_required' });
};
