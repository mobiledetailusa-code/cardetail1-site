// netlify/functions/admin-auth.js
// Lightweight admin password validation.
// Compares submitted password against ADMIN_DASH_PASSWORD env var (trimmed both sides).
// Never returns booking data. Never logs the password.
//
// POST { password }
// 200 { ok: true }
// 401 { ok: false, error: 'invalid_password' }
// 503 { ok: false, error: 'missing_admin_password_config' }

const crypto = require('crypto');

const json = (status, body) => ({
  statusCode: status,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });

  const envRaw      = process.env.ADMIN_DASH_PASSWORD || '';
  const expected    = envRaw.trim();
  if (!expected) return json(503, { ok: false, error: 'missing_admin_password_config' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'invalid_request' }); }

  const submittedRaw = String(body.password || '');
  const submitted    = submittedRaw.trim();
  if (!submitted) return json(401, { ok: false, error: 'invalid_password' });

  // Constant-time comparison prevents timing-based enumeration
  const a = Buffer.from(submitted);
  const b = Buffer.from(expected);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (match) return json(200, { ok: true });

  // Temporary diagnostic — lengths only, never the value.
  // Remove before final merge.
  return json(401, {
    ok: false,
    error: 'invalid_password',
    _debug: {
      env_trimmed_length:       expected.length,
      env_had_outer_whitespace: envRaw.length !== expected.length,
      submitted_length:         submitted.length,
    },
  });
};
