/**
 * Resolve a first-party review invite from the SMS /reviews?t= link.
 *
 * GET /.netlify/functions/review-invite?t=
 * 200 { ok, available, submitted, firstName, service, location, date }
 *
 * Never returns phone, email, booking id, or the raw token.
 */

const { jsonCors } = require('../lib/tech-security');
const { enforcePublicRateLimit } = require('../lib/public-rate-limit');
const { resolveReviewInvite } = require('../lib/review-request-notifications');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'GET') return jsonCors(405, { ok: false, error: 'method_not_allowed' });

  const rateLimit = await enforcePublicRateLimit(event, { endpoint: 'review-invite' });
  if (rateLimit.blocked) return rateLimit.response;

  const params = event.queryStringParameters || {};
  const token = String(params.t || params.token || '').trim();
  if (!token) {
    return jsonCors(400, {
      ok: false,
      error: 'token_required',
      message: 'Open the review link from your text message, or look up the booking in My Garage.',
    });
  }

  try {
    const resolved = await resolveReviewInvite(token);
    if (!resolved.ok) {
      return jsonCors(resolved.statusCode || 401, {
        ok: false,
        error: resolved.error,
        message: resolved.message,
      });
    }
    return jsonCors(200, {
      ok: true,
      available: !!resolved.available,
      submitted: !!resolved.submitted,
      firstName: resolved.firstName,
      service: resolved.service,
      location: resolved.location,
      date: resolved.date,
    });
  } catch (e) {
    console.warn('[review-invite] resolve failed:', e && e.message);
    return jsonCors(500, { ok: false, error: 'review_invite_unavailable' });
  }
};
