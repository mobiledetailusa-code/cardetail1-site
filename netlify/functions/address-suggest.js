/**
 * Public booking address suggestions — ZIP-biased street search for Step 4.
 * GET only. No Blob/DB writes. No payment imports.
 */
const { jsonCors } = require('../lib/tech-security');
const { enforcePublicRateLimit } = require('../lib/public-rate-limit');
const { suggestAddresses, sanitizeCity } = require('../lib/address-suggest');

function queryOf(event) {
  return (event && event.queryStringParameters) || {};
}

function safeError(status, error) {
  return jsonCors(status, { ok: false, error, suggestions: [] });
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
    if (event.httpMethod !== 'GET') return safeError(405, 'method_not_allowed');

    const rate = await enforcePublicRateLimit(event, {
      endpoint: 'address-suggest',
      cors: true,
    }).catch(() => ({ blocked: false, allowed: true }));
    if (rate && rate.blocked) {
      return rate.response || safeError(429, 'rate_limited');
    }

    const q = queryOf(event);
    const result = await suggestAddresses({
      q: q.q || q.query || '',
      zip: q.zip || '',
      city: sanitizeCity(q.city || ''),
    });
    if (!result.ok) {
      return jsonCors(400, { ok: false, error: result.error, suggestions: [] });
    }
    return jsonCors(200, { ok: true, suggestions: result.suggestions });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.warn('[address-suggest] failed', message);
    return jsonCors(200, { ok: true, suggestions: [] });
  }
};
