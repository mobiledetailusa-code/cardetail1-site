// POST /.netlify/functions/welcome-lead-capture — first-visit 10% offer email capture.

'use strict';

const { enforcePublicRateLimit } = require('../lib/public-rate-limit');
const { trustedSiteOrigin, buildTrustedAbsoluteUrl } = require('../lib/trusted-site-origin');
const {
  normalizeEmail,
  saveWelcomeLeadCapture,
} = require('../lib/welcome-lead-store');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

function json(status, body) {
  return { statusCode: status, headers: cors, body: JSON.stringify(body) };
}

function isHoneypotFilled(body) {
  const trap = String(body && (body.website || body.company || body.hp) || '').trim();
  return trap.length > 0;
}

function publicOffer() {
  return {
    offerId: 'first_booking_welcome',
    publicName: 'New Customer Welcome — 10%',
    percent: 10,
    capCents: 4000,
    termsPath: '/terms-conditions#welcome-offer',
  };
}

async function notifyAdmin(record) {
  const { ADMIN_EMAIL, RESEND_API_KEY, RESEND_FROM } = process.env;
  if (!ADMIN_EMAIL || !RESEND_API_KEY) return { sent: false, reason: 'email not configured' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: RESEND_FROM || 'Cardetail1 <onboarding@resend.dev>',
      to: [ADMIN_EMAIL],
      reply_to: record.email,
      subject: `First-visit 10% lead — ${record.email}`,
      text: [
        'NEW FIRST-VISIT WELCOME LEAD',
        `Capture ID: ${record.captureId}`,
        `Email: ${record.email}`,
        `Source: ${record.source || 'first_visit_balloon'}`,
        `Page: ${record.landingPage || '—'}`,
        `Campaign: ${record.utmCampaign || '—'}`,
        `Marketing consent: ${record.marketingConsent ? 'yes' : 'no'}`,
        `Claimed: ${record.claimedAt}`,
      ].join('\n'),
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    return { sent: false, reason: `resend ${res.status}: ${err}` };
  }
  return { sent: true };
}

async function sendCustomerOfferEmail(record) {
  const { RESEND_API_KEY, RESEND_FROM } = process.env;
  if (!RESEND_API_KEY) return { sent: false, reason: 'email not configured' };
  const origin = trustedSiteOrigin();
  const bookUrl = buildTrustedAbsoluteUrl('/') || `${origin}/`;
  const termsUrl = buildTrustedAbsoluteUrl('/terms-conditions#welcome-offer')
    || `${origin}/terms-conditions#welcome-offer`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: RESEND_FROM || 'Cardetail1 <onboarding@resend.dev>',
      to: [record.email],
      subject: 'Your 10% Cardetail1 welcome offer',
      text: [
        'Your first-visit welcome offer is ready.',
        '',
        'Use this email when you book online. Eligible new customers receive 10% off the eligible service subtotal, up to $40, on the first qualifying booking.',
        '',
        `Book here: ${bookUrl}`,
        `Terms: ${termsUrl}`,
        '',
        'No promo code needed — the discount is applied automatically at checkout when this email is used.',
        '',
        'Cardetail1 · Palisades Park, NJ · 551-373-5668',
      ].join('\n'),
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    return { sent: false, reason: `resend ${res.status}: ${err}` };
  }
  return { sent: true };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });

  const rateLimit = await enforcePublicRateLimit(event, {
    endpoint: 'welcome-lead-capture',
    cors: true,
  });
  if (rateLimit.blocked) return rateLimit.response;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'invalid_json' }); }

  if (isHoneypotFilled(body)) {
    return json(200, { ok: true, idempotent: true, offer: publicOffer() });
  }

  const email = normalizeEmail(body.email);
  if (!email) return json(400, { ok: false, error: 'invalid_email' });

  try {
    const saved = await saveWelcomeLeadCapture({
      email,
      source: body.source || 'first_visit_balloon',
      landingPage: body.landingPage || body.source_page || '',
      utmCampaign: body.utm_campaign || body.utmCampaign || '',
      marketingConsent: !!body.marketingConsent,
    });

    if (saved.created) {
      await Promise.all([
        notifyAdmin(saved.record).catch(() => ({ sent: false })),
        sendCustomerOfferEmail(saved.record).catch(() => ({ sent: false })),
      ]);
    }

    return json(200, {
      ok: true,
      idempotent: !!saved.idempotent,
      captureId: saved.record.captureId,
      offer: publicOffer(),
    });
  } catch (err) {
    if (err && err.code === 'invalid_email') {
      return json(400, { ok: false, error: 'invalid_email' });
    }
    console.error('[welcome-lead-capture]', err && err.message ? err.message : err);
    return json(500, { ok: false, error: 'server_error' });
  }
};
