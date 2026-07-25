// Branch/deploy-preview only — admin-gated mint of an appointment access URL
// for E2E validation. Never enabled in production context.

'use strict';

const crypto = require('crypto');
const { verifyAdminKey, jsonCors } = require('../lib/tech-security');
const {
  createAppointmentAccessToken,
} = require('../lib/appointment-access-token');
const { trustedSiteOrigin, deployContext } = require('../lib/trusted-site-origin');

function allowedContext() {
  const ctx = deployContext();
  if (ctx === 'branch-deploy' || ctx === 'deploy-preview' || ctx === 'dev') return true;
  if (ctx === 'production') return false;
  return false;
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (!ba.length || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

async function authorize(event) {
  const headers = event.headers || {};
  const admin = await verifyAdminKey(headers);
  if (admin.ok) return { ok: true, via: 'admin' };

  const expected = String(process.env.MY_GARAGE_QA_ADMIN_TOKEN || '').trim();
  const provided = String(
    headers['x-qa-admin-token'] || headers['X-Qa-Admin-Token'] || ''
  ).trim();
  if (expected && provided && timingSafeEqualStr(expected, provided)) {
    return { ok: true, via: 'qa_token' };
  }
  return { ok: false };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') return jsonCors(404, { ok: false, error: 'not_found' });
  if (!allowedContext()) return jsonCors(404, { ok: false, error: 'not_found' });

  const auth = await authorize(event);
  if (!auth.ok) return jsonCors(401, { ok: false, error: 'unauthorized' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return jsonCors(400, { ok: false, error: 'invalid_json' });
  }

  const bookingId = String(body.bookingId || '').trim();
  if (!bookingId.startsWith('CD1-')) {
    return jsonCors(400, { ok: false, error: 'invalid_booking_id' });
  }

  try {
    const minted = await createAppointmentAccessToken({
      bookingId,
      email: body.email || null,
      phoneDigits: body.phoneDigits || null,
      eventType: 'booking.request_received',
      supersede: false,
    });
    const origin = trustedSiteOrigin();
    return jsonCors(200, {
      ok: true,
      bookingId,
      accessOrigin: origin,
      accessUrl: minted.accessUrl,
      envBinding: minted.envBinding,
      expiresAt: minted.expiresAt,
    });
  } catch (e) {
    return jsonCors(500, {
      ok: false,
      error: 'mint_failed',
      detail: String(e && e.message || 'error').slice(0, 120),
    });
  }
};
