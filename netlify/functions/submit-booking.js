// netlify/functions/submit-booking.js
// Accepts a booking, assigns a server-side ID, stores to Netlify Blobs,
// notifies admin, and optionally sends customer confirmation.
//
// Security model:
//   C-1: paymentStatus can only be set by stripe-webhook.js (HMAC-verified).
//        This endpoint never trusts client-submitted payment state.
//   C-3: Booking ID is always generated server-side. Client-submitted id/bookingId
//        are ignored. Collision-checked against Blobs before writing.
//   Draft mode: payByCard() pre-registers a minimal draft so create-payment-intent
//        can fetch the stored totalPrice (C-2). No emails sent for drafts.
//   Finalization: submitBooking() passes draftBookingId to merge full details into
//        an existing draft, preserving webhook-set payment fields.
//
// Canonical paymentStatus enum:
//   no_payment_required_yet | authorization_pending | authorized |
//   authorization_failed | capture_pending | paid | canceled |
//   refunded | expired
//
// Dispatch rule: only stripe-webhook.js triggers auction (via payment_intent.amount_capturable_updated).
// This endpoint's postAuction() is retained for idempotency on finalization but
// will always find 'dispatch blocked' or 'auction already exists'.

const crypto = require('crypto');

// Fields that must never come from the browser.
// Payment state is owned exclusively by stripe-webhook.js (HMAC-verified).
// Admin/assignment state is owned by admin-authenticated endpoints.
const CLIENT_BLOCKED_FIELDS = [
  'paymentStatus', 'paymentIntentId', 'amountAuthorizedCents', 'amountCapturedCents',
  'capturedAt', 'captureInitiatedAt', 'stripeCustomerId', 'paymentMethodId',
  'status', 'appointmentStatus', 'jobStatus', 'adminNotes', 'assignedTech',
  'assignedTechName', 'confirmedDate', 'confirmedTimeWindow',
  'adminReviewed', 'archived',
];

async function blobsStore(name) {
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token) ? getStore({ name, siteID, token }) : getStore(name);
}

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// C-1: Never returns 'authorized' or 'paid'.
// Those values are set exclusively by stripe-webhook.js after HMAC verification.
function resolvePaymentStatus(b) {
  const method = String(b.paymentMethod || '');
  if (method === 'cash_onsite' || method === 'card_onsite') return 'no_payment_required_yet';
  if (method === 'link') return 'authorization_pending';
  // deposit_card | preauth_full | pending | unknown → awaiting Stripe webhook
  return 'authorization_pending';
}

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

function signBid(jobId, techId, secret) {
  return crypto.createHmac('sha256', secret)
    .update(String(jobId) + '|' + String(techId))
    .digest('hex');
}

// Dispatch is gated: only fires when paymentStatus is 'authorized' or 'paid'.
// After C-1, this endpoint sets neither value — so postAuction() will always
// return 'dispatch blocked' for new bookings. It remains here to handle the
// rare case where finalization runs after the webhook has already set 'authorized'.
// The idempotency guard ('auction already exists') prevents double-dispatch.
async function postAuction(b) {
  const secret = process.env.BID_SECRET;
  if (!secret) return { posted: false, reason: 'BID_SECRET not set' };

  const payStatus = String(b.paymentStatus || '');
  if (!['authorized', 'paid'].includes(payStatus)) {
    return { posted: false, reason: 'dispatch blocked: paymentStatus=' + payStatus };
  }

  try {
    const existing = await (await blobsStore('cd1-auctions')).get(b.id, { type: 'json' });
    if (existing) return { posted: false, reason: 'auction already exists for ' + b.id };

    const roster = (await (await blobsStore('cd1-techs')).get('roster', { type: 'json' })) || [];
    const job = {
      package: b.package || '',
      vehicle: b.vehicle || b.vehicleCategory || '',
      date: b.preferredDate || '',
      time: b.preferredTime || '',
      area: b.zone || b.zipCode || '',
      total: b.totalPrice || 0,
    };
    await (await blobsStore('cd1-auctions')).setJSON(b.id, {
      jobId: b.id,
      status: 'open',
      job,
      bids: [],
      winner: null,
      createdAt: new Date().toISOString(),
      paymentStatus: b.paymentStatus,
      amountAuthorizedCents: b.amountAuthorizedCents || 0,
    });

    const base = process.env.SITE_URL || '';
    const { TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM } = process.env;
    let notified = 0;
    if (TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM && base && roster.length) {
      const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
      await Promise.all(roster.map(t => {
        const sig = signBid(b.id, t.id, secret);
        const link = `${base}/bid.html?job=${encodeURIComponent(b.id)}&tech=${encodeURIComponent(t.id)}&sig=${sig}`;
        const body = new URLSearchParams({
          To: t.phone, From: TWILIO_FROM,
          Body: `New Cardetail1 job: ${job.package} · ${job.date} · ${job.area}. Place your bid (lowest wins): ${link}`,
        });
        return fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
          method: 'POST',
          headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        }).then(r => { if (r.ok) notified++; }).catch(() => {});
      }));
    }
    return { posted: true, techs: roster.length, notified };
  } catch (e) {
    return { posted: false, reason: e.message };
  }
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
    no_payment_required_yet: 'Cash / pay on-site',
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
    `Thank you for choosing Cardetail1.`,
    ``,
    `We received your booking request for ${service}. Our team will review your location, vehicle details, service selection, and availability before final confirmation.`,
    ``,
    `If your appointment requires travel approval, quote review, payment authorization, or additional service details, we will contact you before confirming the job.`,
    ``,
    `Requested details:`,
    ``,
    `  * Service: ${service}`,
    `  * Vehicle: ${vehicle}`,
    `  * Date/time: ${dateTime}`,
    `  * Location/ZIP: ${zip}`,
    `  * Booking ID: ${b.id}`,
    ``,
    `Please make sure the vehicle will be accessible, legally parked, and has enough space around it for mobile detailing.`,
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
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  let b;
  try { b = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'Invalid JSON' }); }

  // C-1: Strip all fields the browser must never control.
  for (const f of CLIENT_BLOCKED_FIELDS) delete b[f];
  // C-3: Ignore any client-submitted ID entirely.
  delete b.id;
  delete b.bookingId;

  if (!b.firstName || !b.phone) return json(400, { ok: false, error: 'Missing customer name or phone' });

  const store = await blobsStore('cd1-bookings');

  // ── Draft pre-registration (supports C-2: create-payment-intent fetches amount from Blobs) ──
  if (b.isDraft) {
    const draftId = await newUniqueId(store);
    const draft = {
      id: draftId,
      isDraft: true,
      createdAt: new Date().toISOString(),
      totalPrice: Number(b.totalPrice) || 0,
      paymentMethod: b.paymentMethod || 'pending',
      paymentStatus: 'authorization_pending',
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

    // Preserve fields the webhook may have already set on the draft.
    b = {
      ...b,
      id: rawDraftId,
      status: 'Pending Review',
      isDraft: false,
      createdAt: existing.createdAt,
      finalizedAt: new Date().toISOString(),
      // Payment fields: trust Blobs, not the browser
      paymentStatus: existing.paymentStatus,
      paymentIntentId: existing.paymentIntentId,
      amountAuthorizedCents: existing.amountAuthorizedCents,
      amountCapturedCents: existing.amountCapturedCents,
      capturedAt: existing.capturedAt,
    };

    let stored = { saved: false };
    try {
      await store.setJSON(rawDraftId, b);
      stored = { saved: true };
    } catch (e) {
      stored = { saved: false, reason: e.message };
    }

    const [email, customerEmail, sms, auction] = await Promise.all([
      sendEmail(b).catch(e => ({ sent: false, reason: e.message })),
      sendCustomerEmail(b).catch(e => ({ sent: false, reason: e.message })),
      sendSms(b).catch(e => ({ sent: false, reason: e.message })),
      postAuction(b).catch(e => ({ posted: false, reason: e.message })),
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
      auction,
    });
  }

  // ── New booking (cash/on-site or any path that didn't pre-register a draft) ──
  const newId = await newUniqueId(store);
  b.id = newId;
  b.status = 'Pending Review';
  b.createdAt = new Date().toISOString();
  b.paymentStatus = resolvePaymentStatus(b);

  let stored = { saved: false };
  try {
    await store.setJSON(b.id, b);
    stored = { saved: true };
  } catch (e) {
    stored = { saved: false, reason: e.message };
  }

  const [email, customerEmail, sms, auction] = await Promise.all([
    sendEmail(b).catch(e => ({ sent: false, reason: e.message })),
    sendCustomerEmail(b).catch(e => ({ sent: false, reason: e.message })),
    sendSms(b).catch(e => ({ sent: false, reason: e.message })),
    postAuction(b).catch(e => ({ posted: false, reason: e.message })),
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
    auction,
  });
};
