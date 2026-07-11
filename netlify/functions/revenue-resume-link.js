// GET /.netlify/functions/revenue-resume-link — validate secure resume token (no PII in URL analytics).

const { validateResumeToken, revokeResumeToken } = require('../lib/revenue-resume');
const { enforcePublicRateLimit } = require('../lib/public-rate-limit');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  const rate = await enforcePublicRateLimit(event, 'revenue-resume-link', 'validate');
  if (!rate.ok) {
    return { statusCode: 429, headers: cors, body: JSON.stringify({ ok: false, error: 'rate_limited' }) };
  }

  if (event.httpMethod === 'GET') {
    const token = String((event.queryStringParameters || {}).token || '').trim();
    if (!token) return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: 'missing_token' }) };
    const v = await validateResumeToken(token);
    if (!v.ok) return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: v.error }) };
    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        ok: true,
        resumeId: v.record.resumeId,
        bookingStep: v.record.bookingStep,
        bookingId: v.record.bookingId,
        garagePlanId: v.record.garagePlanId,
        expiresAt: v.record.expiresAt,
      }),
    };
  }

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: 'invalid_json' }) }; }
    const action = String(body.action || 'consume').toLowerCase();
    const token = String(body.token || '').trim();
    if (!token) return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: 'missing_token' }) };

    if (action === 'revoke') {
      const r = await revokeResumeToken(token);
      return { statusCode: r.ok ? 200 : 400, headers: cors, body: JSON.stringify(r) };
    }

    const v = await validateResumeToken(token);
    if (!v.ok) return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: v.error }) };
    const store = await require('../lib/revenue-store').getRevenueStore('resumeTokens');
    await require('../lib/revenue-store').blobSetJson(store, v.record.tokenHash, {
      ...v.record,
      usedAt: new Date().toISOString(),
    });
    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        ok: true,
        bookingStep: v.record.bookingStep || 1,
        bookingId: v.record.bookingId,
        garagePlanId: v.record.garagePlanId,
      }),
    };
  }

  return { statusCode: 405, headers: cors, body: JSON.stringify({ ok: false, error: 'method_not_allowed' }) };
};
