// netlify/functions/submit-booking.js
// Accepts a booking, normalizes paymentStatus to the canonical enum,
// stores it in Netlify Blobs, notifies admin by email + SMS, and
// triggers technician dispatch ONLY when paymentStatus is 'authorized' or 'paid'.
//
// Canonical paymentStatus enum:
//   no_payment_required_yet | authorization_pending | authorized |
//   authorization_failed | capture_pending | paid | canceled |
//   refunded | expired
//
// Dispatch rule (enforced here AND in stripe-webhook.js):
//   - 'authorized' or 'paid'  → post auction + SMS techs
//   - anything else           → store booking, notify admin, do NOT dispatch
//
// Env (Netlify → Site settings → Environment variables):
//   ADMIN_EMAIL, RESEND_API_KEY, RESEND_FROM  (email notifications)
//   TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM, ADMIN_SMS  (SMS, optional)
//   BID_SECRET   (required for dispatch / auction magic links)
//   SITE_URL     (required for bid magic links)

const crypto = require('crypto');

// @netlify/blobs auto-configures in hosted Functions via NETLIFY_BLOBS_CONTEXT.
// If that injection isn't available (older site infra), fall back to explicit
// siteID + token from env vars (set NETLIFY_SITE_ID + NETLIFY_AUTH_TOKEN).
async function blobsStore(name) {
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token) ? getStore({ name, siteID, token }) : getStore(name);
}

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const json = (status, body) => ({ statusCode: status, headers: CORS, body: JSON.stringify(body) });

// ── Normalize whatever the front-end sends to the canonical enum ──
// Front-end may send 'authorized', 'authorized_full', 'link_sent', 'none',
// 'cash_onsite', 'card_onsite', or nothing.
function resolvePaymentStatus(b) {
  const raw = String(b.paymentStatus || '');
  const method = String(b.paymentMethod || '');

  // Front-end confirmed a Stripe hold (both deposit and full-amount pre-auth
  // map to 'authorized' in the canonical enum).
  if (raw === 'authorized' || raw === 'authorized_full') return 'authorized';

  // Already captured (edge case — webhook normally handles this).
  if (raw === 'paid' || raw === 'captured') return 'paid';

  // Cash / pay-on-site: no card required at booking time.
  if (method === 'cash_onsite' || method === 'card_onsite') return 'no_payment_required_yet';

  // Payment link sent — customer has not paid yet.
  if (method === 'link' || raw === 'link_sent') return 'authorization_pending';

  // Stripe key not configured (STRIPE_READY=false on the front-end):
  // card UI shown but no actual PI created.
  if (method === 'deposit_card' || method === 'preauth_full') return 'authorization_pending';

  // Default: no payment path selected or unknown.
  return 'authorization_pending';
}

function signBid(jobId, techId, secret) {
  return crypto.createHmac('sha256', secret)
    .update(String(jobId) + '|' + String(techId))
    .digest('hex');
}

// ── Post auction to Blobs and SMS techs (idempotent) ──
// Dispatch is gated on paymentStatus === 'authorized' | 'paid'.
// SMS is skipped unless all Twilio env vars are set — safe for test mode.
async function postAuction(b) {
  const secret = process.env.BID_SECRET;
  if (!secret) return { posted: false, reason: 'BID_SECRET not set' };

  const payStatus = String(b.paymentStatus || '');
  if (!['authorized', 'paid'].includes(payStatus)) {
    return { posted: false, reason: 'dispatch blocked: paymentStatus=' + payStatus };
  }

  try {
    // Idempotency: do not create a second auction for the same booking.
    const existing = await (await blobsStore('cd1-auctions')).get(b.id, { type: 'json' });
    if (existing) return { posted: false, reason: 'auction already exists for ' + b.id };

    const roster = (await (await blobsStore('cd1-techs')).get('roster', { type: 'json' })) || [];
    // 'total' is stored for admin visibility. auction.js techView() strips it
    // before returning data to technicians — customer payment info is never
    // exposed through the tech-facing API endpoint.
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
      amountAuthorizedCents: b.amountAuthorizedCents || b.depositCents || 0,
    });

    const base = process.env.SITE_URL || '';
    const { TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM } = process.env;
    let notified = 0;
    // NOTE: SMS dispatch requires TWILIO_* env vars. In test mode these are
    // typically not set, so notified stays 0. The auction record is still
    // created in Blobs and visible in the admin panel.
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

// Field length caps — prevents oversized payloads from being stored in Blobs.
const FIELD_LIMITS = {
  firstName: 60, lastName: 60, email: 120, phone: 20, address: 200,
  zipCode: 10, zone: 60, notes: 1000, package: 80, vehicle: 80, vehicleCategory: 80,
};

function sanitizeBooking(b) {
  const out = { ...b };
  for (const [field, max] of Object.entries(FIELD_LIMITS)) {
    if (typeof out[field] === 'string' && out[field].length > max) {
      out[field] = out[field].slice(0, max);
    }
  }
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  // Reject oversized payloads (> 32 KB) before parsing.
  const bodyLen = (event.body || '').length;
  if (bodyLen > 32768) return json(413, { ok: false, error: 'payload_too_large' });

  let b;
  try { b = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'Invalid JSON' }); }

  if (!b.firstName || !b.phone) return json(400, { ok: false, error: 'Missing customer name or phone' });
  b = sanitizeBooking(b);
  if (!b.id) b.id = 'CD1-' + Date.now().toString(36).toUpperCase();

  // Normalize paymentStatus to canonical enum before storing.
  b.paymentStatus = resolvePaymentStatus(b);

  // Preserve amountAuthorizedCents from front-end (depositCents / authAmountCents).
  if (!b.amountAuthorizedCents && b.depositCents) {
    b.amountAuthorizedCents = b.depositCents;
  }

  // Store centrally in Netlify Blobs. Degrades gracefully if unavailable.
  let stored = { saved: false };
  try {
    await (await blobsStore('cd1-bookings')).setJSON(b.id, b);
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
    status: b.status || 'Pending Review',
    paymentStatus: b.paymentStatus,
    stored,
    email,
    customerEmail,
    sms,
    auction,
  });
};
