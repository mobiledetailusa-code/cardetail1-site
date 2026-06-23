// netlify/functions/admin-auth.js
// Lightweight admin password validation.
// Compares submitted password against ADMIN_DASH_PASSWORD env var (trimmed both sides).
// Never returns booking data. Never logs the password.
//
// POST { password }
// 200 { ok: true }
// 401 { ok: false, error: 'invalid_password' }
// 503 { ok: false, error: 'missing_admin_password_config' }

const { json: secureJson, rateLimit, safeEq } = require('./_security');

let currentEvent;
const json = (status, body) => secureJson(currentEvent, status, body, { allowHeaders: 'Content-Type' });

exports.handler = async (event) => {
  currentEvent = event;
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });
  const rl = await rateLimit(event, 'admin-auth', 8, 60);
  if (!rl.ok) return json(rl.status, rl.body);

  const expected = (process.env.ADMIN_DASH_PASSWORD || '').trim();
  if (!expected) return json(503, { ok: false, error: 'missing_admin_password_config' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'invalid_request' }); }

  const submitted = String(body.password || '').trim();
  if (!submitted) return json(401, { ok: false, error: 'invalid_password' });

  return safeEq(submitted, expected)
    ? json(200, { ok: true })
    : json(401, { ok: false, error: 'invalid_password' });
};
