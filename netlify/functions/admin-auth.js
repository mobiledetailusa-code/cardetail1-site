// Admin sign-in — username + password → opaque session token (never expose password to other APIs).
//
// POST { action:'login', username, password }  → { ok, token, expiresAt }
// POST { action:'validate', token }            → { ok, username, expiresAt }
// POST { action:'logout', token }              → { ok }
//
// Env: ADMIN_USERNAME (default: admin), ADMIN_DASH_PASSWORD

const { jsonCors } = require('../lib/tech-security');
const {
  getAdminConfig,
  verifyAdminCredentials,
  createAdminSession,
  validateAdminToken,
  destroyAdminSession,
  checkLoginRateLimit,
  recordLoginFailure,
  clearLoginFailures,
  clientIp,
} = require('../lib/admin-security');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') return jsonCors(405, { ok: false, error: 'method_not_allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'invalid_request' }); }

  const action = String(body.action || 'login').toLowerCase();
  const hdrToken = ((event.headers && (event.headers['x-admin-key'] || event.headers['X-Admin-Key'])) || '').trim();

  if (action === 'validate') {
    const token = String(body.token || hdrToken || '').trim();
    const session = await validateAdminToken(token);
    if (!session) return jsonCors(401, { ok: false, error: 'invalid_session' });
    return jsonCors(200, { ok: true, username: session.username, expiresAt: session.expiresAt });
  }

  if (action === 'logout') {
    const token = String(body.token || hdrToken || '').trim();
    await destroyAdminSession(token);
    return jsonCors(200, { ok: true });
  }

  const cfg = getAdminConfig();
  if (!cfg.configured) return jsonCors(503, { ok: false, error: 'missing_admin_config' });

  const ip = clientIp(event);
  const rate = await checkLoginRateLimit(ip);
  if (!rate.ok) {
    return jsonCors(429, { ok: false, error: 'too_many_attempts', retryAfterMs: rate.retryAfterMs });
  }

  const username = String(body.username || '').trim();
  const password = String(body.password || '').trim();
  if (!username || !password) return jsonCors(401, { ok: false, error: 'invalid_credentials' });

  if (!verifyAdminCredentials(username, password)) {
    await recordLoginFailure(ip);
    return jsonCors(401, { ok: false, error: 'invalid_credentials' });
  }

  await clearLoginFailures(ip);
  const sess = await createAdminSession(username);
  return jsonCors(200, {
    ok: true,
    token: sess.token,
    expiresAt: sess.expiresAt,
    username: cfg.username,
  });
};
