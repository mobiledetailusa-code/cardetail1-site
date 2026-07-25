// Branch/deploy-preview only — admin-gated mint of an appointment access URL
// for E2E validation. Never enabled in production context.

'use strict';

const { verifyAdminKey, jsonCors } = require('../lib/tech-security');
const {
  createAppointmentAccessToken,
} = require('../lib/appointment-access-token');
const { trustedSiteOrigin, deployContext } = require('../lib/trusted-site-origin');

function allowedContext() {
  const ctx = deployContext();
  return ctx === 'branch-deploy' || ctx === 'deploy-preview' || ctx === 'dev';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') return jsonCors(404, { ok: false, error: 'not_found' });
  if (!allowedContext()) return jsonCors(404, { ok: false, error: 'not_found' });

  const auth = await verifyAdminKey(event.headers || {});
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
