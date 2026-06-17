// netlify/functions/update-booking.js
// Admin/tech: persist mutable booking fields to Netlify Blobs.
// This is the single source of truth for all post-submission booking mutations —
// status changes, tech assignment, confirmed date/time, admin notes, and
// job lifecycle transitions (en-route, in-progress, completed).
//
// Optionally sends emails:
//   status → 'Confirmed'   → confirmation email to customer
//   status → 'Completed'   → completion receipt email to customer (if paid)
//
// POST { bookingId, ...fields }
// Auth (one of):
//   x-admin-key: <ADMIN_DASH_PASSWORD>          → full field access
//   x-tech-id + x-tech-email headers            → lifecycle fields only, own jobs
//
// Admin-writable fields (all others silently ignored):
//   status, assignedTech, assignedTechName,
//   confirmedDate, confirmedTime,
//   preferredDate, preferredTime,
//   adminNotes, adminContacted, adminReviewed,
//   adminContactedAt, adminReviewedAt,
//   completedAt, startedAt, enRouteAt,
//   hasProblem, lastProblem
//
// Tech-writable fields:
//   status, completedAt, startedAt, enRouteAt, hasProblem, lastProblem
//   + assignedTech/assignedTechName when value === own tech ID (job accept)
//
// Responses: { ok, bookingId, updated } | { ok: false, error }

const crypto = require('crypto');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-key, x-tech-id, x-tech-email',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const json = (status, body) => ({ statusCode: status, headers: CORS, body: JSON.stringify(body) });

async function blobsStore(name) {
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token) ? getStore({ name, siteID, token }) : getStore(name);
}

// Fields admins can update
const ADMIN_ALLOWED = new Set([
  'status', 'assignedTech', 'assignedTechName',
  'confirmedDate', 'confirmedTime',
  'preferredDate', 'preferredTime',
  'adminNotes', 'adminContacted', 'adminReviewed',
  'adminContactedAt', 'adminReviewedAt',
  'completedAt', 'startedAt', 'enRouteAt',
  'hasProblem', 'lastProblem',
]);

// Fields techs can update (only lifecycle transitions on their own assigned jobs)
const TECH_ALLOWED = new Set([
  'status', 'completedAt', 'startedAt', 'enRouteAt', 'hasProblem', 'lastProblem',
]);

async function sendEmail(to, subject, text) {
  const { RESEND_API_KEY, RESEND_FROM } = process.env;
  if (!RESEND_API_KEY || !to) return { sent: false, reason: 'not configured or no address' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: RESEND_FROM || 'Cardetail1 <onboarding@resend.dev>',
        to: [to],
        subject,
        text,
      }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.warn('[update-booking] email failed:', res.status, err.slice(0, 200));
      return { sent: false, reason: `resend ${res.status}` };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

function confirmationEmail(b) {
  const name = [b.firstName, b.lastName].filter(Boolean).join(' ') || 'Valued Customer';
  const first = name.split(' ')[0];
  const service = b.package || b.service || 'Detailing Service';
  const vehicle = b.vehicleLabel || b.vehicle || b.vehicleCategory || '—';
  const date    = b.confirmedDate  || b.preferredDate  || '—';
  const time    = b.confirmedTime  || b.preferredTime  || '—';
  const address = b.address || 'your specified location';
  const tech    = b.assignedTechName || 'our team';

  const text = [
    `Hi ${first},`,
    ``,
    `Your Cardetail1 appointment is CONFIRMED! ✓`,
    ``,
    `  Service:  ${service}`,
    `  Vehicle:  ${vehicle}`,
    `  Date:     ${date}`,
    `  Time:     ${time}`,
    `  Location: ${address}`,
    `  Tech:     ${tech}`,
    `  Booking:  ${b.id}`,
    ``,
    `What to expect:`,
    `  • Your technician will arrive at the time above`,
    `  • Please make sure the vehicle is accessible and legally parked`,
    `  • Have enough clear space around the vehicle for equipment`,
    `  • Final pricing may be adjusted for actual vehicle size/condition`,
    ``,
    `Need to make changes? Call or text: 551-313-2956`,
    ``,
    `See you soon!`,
    `Cardetail1 Mobile Detailing`,
  ].join('\n');

  return {
    subject: `Cardetail1 — Appointment Confirmed: ${date} at ${time}`,
    text,
  };
}

function completionEmail(b) {
  const name = [b.firstName, b.lastName].filter(Boolean).join(' ') || 'Valued Customer';
  const first = name.split(' ')[0];
  const service = b.package || b.service || 'Detailing Service';
  const total   = b.totalPrice || '—';

  const text = [
    `Hi ${first},`,
    ``,
    `Your Cardetail1 service is complete! ✓`,
    ``,
    `  Service: ${service}`,
    `  Total:   $${total}`,
    `  Booking: ${b.id}`,
    ``,
    `Thank you for choosing Cardetail1. We hope you love the results!`,
    ``,
    `We'd really appreciate a quick review:`,
    `https://g.page/r/CTJwfJerrQeCEAI/review`,
    ``,
    `Book your next detail: https://cardetail1.netlify.app`,
    `Phone/text: 551-313-2956`,
    ``,
    `Cardetail1 Mobile Detailing`,
  ].join('\n');

  return {
    subject: `Cardetail1 — Service Complete · Booking ${b.id}`,
    text,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST')    return json(405, { ok: false, error: 'method_not_allowed' });

  const hdrs = event.headers || {};
  const adminKeyProvided = (hdrs['x-admin-key'] || hdrs['X-Admin-Key'] || '').trim();
  const techIdProvided   = (hdrs['x-tech-id']   || hdrs['X-Tech-Id']   || '').trim();
  const techEmailProvided= (hdrs['x-tech-email'] || hdrs['X-Tech-Email']|| '').trim().toLowerCase();

  let isAdmin = false;
  let isTech  = false;
  let allowedFields = ADMIN_ALLOWED;

  // ── Admin auth ──
  const expectedAdmin = (process.env.ADMIN_DASH_PASSWORD || '').trim();
  if (adminKeyProvided && expectedAdmin) {
    const a = Buffer.from(adminKeyProvided);
    const b = Buffer.from(expectedAdmin);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) isAdmin = true;
  }

  // ── Tech auth (only checked if no admin key) ──
  let verifiedTech = null;
  if (!isAdmin && techIdProvided && techEmailProvided) {
    try {
      const roster = (await (await blobsStore('cd1-techs')).get('roster', { type: 'json' })) || [];
      verifiedTech = roster.find(
        t => t.id === techIdProvided &&
             (t.email || '').toLowerCase() === techEmailProvided &&
             t.status === 'approved'
      ) || null;
      if (verifiedTech) isTech = true;
    } catch (e) {
      console.warn('[update-booking] tech roster read failed:', e.message);
    }
  }

  if (!isAdmin && !isTech) return json(401, { ok: false, error: 'unauthorized' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'invalid_json' }); }

  const bookingId = String(body.bookingId || '').trim().toUpperCase().replace(/[^A-Z0-9\-]/g, '');
  if (!bookingId) return json(400, { ok: false, error: 'bookingId_required' });

  // Build the effective allowed set for this request
  if (isTech) {
    // Tech can set their own tech ID (job accept) or lifecycle fields
    const extra = new Set(TECH_ALLOWED);
    if (body.assignedTech === techIdProvided) {
      extra.add('assignedTech');
      extra.add('assignedTechName');
    }
    allowedFields = extra;
  }

  const updates = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'bookingId') continue;
    if (!allowedFields.has(key)) continue;
    updates[key] = value;
  }
  if (!Object.keys(updates).length) return json(400, { ok: false, error: 'no_valid_fields' });

  try {
    const store   = await blobsStore('cd1-bookings');
    const booking = await store.get(bookingId, { type: 'json' }).catch(() => null);
    if (!booking) return json(404, { ok: false, error: 'booking_not_found' });

    // Tech can only update their own jobs (or unassigned jobs they're accepting)
    if (isTech) {
      const isAccepting = body.assignedTech === techIdProvided;
      const alreadyAssigned = booking.assignedTech && booking.assignedTech !== techIdProvided;
      if (!isAccepting && alreadyAssigned) {
        return json(403, { ok: false, error: 'booking_not_assigned_to_you' });
      }
    }

    const prevStatus = booking.status || 'Pending Review';
    const newStatus  = updates.status || prevStatus;

    if (newStatus === 'Completed' && !updates.completedAt) {
      updates.completedAt = new Date().toISOString();
    }
    if (newStatus === 'In Progress' && !updates.startedAt) {
      updates.startedAt = new Date().toISOString();
    }
    if (newStatus === 'En Route' && !updates.enRouteAt) {
      updates.enRouteAt = new Date().toISOString();
    }

    const patched = { ...booking, ...updates, updatedAt: new Date().toISOString() };
    await store.setJSON(bookingId, patched);

    const emailResults = {};

    if (prevStatus !== 'Confirmed' && newStatus === 'Confirmed' && patched.email) {
      const { subject, text } = confirmationEmail(patched);
      emailResults.confirmationEmail = await sendEmail(patched.email, subject, text);
    }

    if (prevStatus !== 'Completed' && newStatus === 'Completed' && patched.email) {
      const { subject, text } = completionEmail(patched);
      emailResults.completionEmail = await sendEmail(patched.email, subject, text);
    }

    const authBy = isAdmin ? 'admin' : `tech:${techIdProvided}`;
    console.log('[update-booking]', bookingId, authBy, JSON.stringify(updates), JSON.stringify(emailResults));
    return json(200, { ok: true, bookingId, updated: updates, ...emailResults });
  } catch (e) {
    console.error('[update-booking] error:', e.message);
    return json(500, { ok: false, error: 'update_failed' });
  }
};
