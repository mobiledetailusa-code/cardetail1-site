// Admin authentication — username + password login, signed session tokens (no Blobs required).
const crypto = require('crypto');

const ADMIN_SESSION_STORE = 'cd1-admin-sessions';
const ADMIN_RATE_STORE = 'cd1-admin-login-rate';
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_ADMIN_SESSIONS = 5;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_FAILURES = 12;
const RATE_LOCK_MS = 15 * 60 * 1000;
const TOKEN_PREFIX = 'v1.';
const LEGACY_TOKEN_LEN = 64;
const MIN_SESSION_SECRET_LEN = 32;
const ADMIN_COOKIE_NAME = 'cd1_admin_session';
let devSessionSecretFallbackWarned = false;

function normalizeEnvValue(v) {
  return String(v || '').replace(/^\uFEFF/, '').trim();
}

function isProductionRuntime() {
  return String(process.env.CONTEXT || '').toLowerCase() === 'production';
}

function isDevOrPreviewRuntime() {
  const ctx = String(process.env.CONTEXT || '').toLowerCase();
  return (
    process.env.NETLIFY_DEV === 'true' ||
    ctx === 'dev' ||
    ctx === 'deploy-preview' ||
    ctx === 'branch-deploy' ||
    !ctx
  );
}

/**
 * Resolves the HMAC secret for v1 admin session tokens.
 * Production: ADMIN_SESSION_SECRET only (min 32 chars).
 * Dev/preview: may fall back to BID_SECRET or ADMIN_DASH_PASSWORD with a console warning.
 */
function getSessionSecretStatus() {
  const primary = normalizeEnvValue(process.env.ADMIN_SESSION_SECRET);

  if (isProductionRuntime()) {
    if (!primary || primary.length < MIN_SESSION_SECRET_LEN) {
      return { ok: false, error: 'missing_admin_session_secret' };
    }
    return { ok: true, secret: primary };
  }

  if (primary) {
    if (primary.length < MIN_SESSION_SECRET_LEN) {
      return { ok: false, error: 'missing_admin_session_secret' };
    }
    return { ok: true, secret: primary };
  }

  const fallback = normalizeEnvValue(process.env.BID_SECRET) ||
    normalizeEnvValue(process.env.ADMIN_DASH_PASSWORD);
  if (fallback) {
    if (!devSessionSecretFallbackWarned) {
      devSessionSecretFallbackWarned = true;
      console.warn(
        '[admin-security] ADMIN_SESSION_SECRET not set; using dev/preview fallback for admin session signing. Configure ADMIN_SESSION_SECRET (32+ chars) before production deploy.'
      );
    }
    return { ok: true, secret: fallback, usedFallback: true };
  }

  return { ok: false, error: 'missing_admin_session_secret' };
}

function sessionSecret() {
  const status = getSessionSecretStatus();
  return status.ok ? status.secret : '';
}

async function blobsStore(name) {
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token) ? getStore({ name, siteID, token }) : getStore(name);
}

function timingSafeString(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function getAdminConfig() {
  const username = normalizeEnvValue(process.env.ADMIN_USERNAME || 'admin').toLowerCase();
  const password = normalizeEnvValue(process.env.ADMIN_DASH_PASSWORD);
  return { username, password, configured: !!password };
}

function verifyAdminCredentials(username, password) {
  const cfg = getAdminConfig();
  if (!cfg.configured) return false;
  const uOk = timingSafeString(String(username || '').trim().toLowerCase(), cfg.username);
  const pOk = timingSafeString(String(password || '').trim(), cfg.password);
  return uOk && pOk;
}

function clientIp(event) {
  const h = (event && event.headers) || {};
  // Prefer Netlify/platform-injected client identity over client-supplied X-Forwarded-For.
  const platform = h['x-nf-client-connection-ip'] || h['client-ip'];
  if (platform) return String(platform).trim();
  const fwd = h['x-forwarded-for'] || h['X-Forwarded-For'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return 'unknown';
}

function rateKey(ip) {
  return 'rate-' + crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 20);
}

async function checkLoginRateLimit(ip) {
  try {
    const store = await blobsStore(ADMIN_RATE_STORE);
    const key = rateKey(ip);
    const now = Date.now();
    const rec = await store.get(key, { type: 'json' }).catch(() => null) || { failures: 0, lockedUntil: 0, windowStart: now };
    if (rec.lockedUntil > now) return { ok: false, retryAfterMs: rec.lockedUntil - now };
    if (now - rec.windowStart > RATE_WINDOW_MS) {
      rec.failures = 0;
      rec.windowStart = now;
    }
    return { ok: true, key, rec, store };
  } catch {
    return { ok: true };
  }
}

async function recordLoginFailure(ip) {
  try {
    const check = await checkLoginRateLimit(ip);
    if (!check.ok || !check.store) return;
    const { key, rec, store } = check;
    const now = Date.now();
    rec.failures = (rec.failures || 0) + 1;
    if (rec.failures >= RATE_MAX_FAILURES) rec.lockedUntil = now + RATE_LOCK_MS;
    await store.setJSON(key, rec);
  } catch (_) {}
}

async function clearLoginFailures(ip) {
  try {
    const store = await blobsStore(ADMIN_RATE_STORE);
    await store.delete(rateKey(ip));
  } catch (_) {}
}

function validateStatelessToken(token) {
  const secret = sessionSecret();
  if (!secret) return null;
  try {
    const raw = JSON.parse(Buffer.from(token.slice(TOKEN_PREFIX.length), 'base64url').toString('utf8'));
    const u = String(raw.u || '').toLowerCase();
    const e = Number(raw.e);
    const n = String(raw.n || '');
    const s = String(raw.s || '');
    if (!u || !e || !n || !s) return null;
    if (Date.now() > e) return null;
    const payload = `${u}|${e}|${n}`;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    const a = Buffer.from(s);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return { username: u, expiresAt: e, token };
  } catch {
    return null;
  }
}

async function validateLegacyBlobToken(token) {
  const t = String(token || '').trim();
  if (!t || t.length !== LEGACY_TOKEN_LEN || !/^[a-f0-9]+$/.test(t)) return null;
  try {
    const store = await blobsStore(ADMIN_SESSION_STORE);
    const session = await store.get('asess-' + t.slice(0, 16), { type: 'json' }).catch(() => null);
    if (!session || Date.now() > session.expiresAt) return null;
    if (!timingSafeString(session.token, t)) return null;
    return session;
  } catch {
    return null;
  }
}

async function createAdminSession(username) {
  const secretStatus = getSessionSecretStatus();
  if (!secretStatus.ok) throw new Error(secretStatus.error || 'missing_admin_session_secret');
  const secret = secretStatus.secret;
  const now = Date.now();
  const expiresAt = now + ADMIN_SESSION_TTL_MS;
  const u = String(username || '').trim().toLowerCase();
  const nonce = crypto.randomBytes(12).toString('base64url');
  const payload = `${u}|${expiresAt}|${nonce}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const token = TOKEN_PREFIX + Buffer.from(JSON.stringify({ u, e: expiresAt, n: nonce, s: sig })).toString('base64url');
  return { token, expiresAt };
}

async function validateAdminToken(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  if (t.startsWith(TOKEN_PREFIX)) return validateStatelessToken(t);
  return validateLegacyBlobToken(t);
}

/**
 * The admin session is also carried in an HttpOnly cookie so that every tab of the
 * same browser origin authenticates automatically (sessionStorage is per-tab and a
 * newly opened tab would otherwise have no token). Secure on every deployed https
 * context; dropped only for local `netlify dev` (plain http).
 */
function adminCookieIsSecure() {
  if (process.env.NETLIFY_DEV === 'true') return false;
  const ctx = String(process.env.CONTEXT || '').toLowerCase();
  return ctx !== 'dev';
}

function parseAdminCookies(headers) {
  const raw = String((headers && (headers.cookie || headers.Cookie)) || '');
  const out = {};
  raw.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function adminSessionCookieHeader(token, { maxAgeSec = ADMIN_SESSION_TTL_MS / 1000 } = {}) {
  const parts = [
    `${ADMIN_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`,
  ];
  if (adminCookieIsSecure()) parts.push('Secure');
  return parts.join('; ');
}

function clearAdminSessionCookieHeader() {
  const parts = [`${ADMIN_COOKIE_NAME}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (adminCookieIsSecure()) parts.push('Secure');
  return parts.join('; ');
}

function readAdminTokenFromHeaders(headers) {
  const h = headers || {};
  const header = ((h['x-admin-key'] || h['X-Admin-Key']) || '').trim();
  if (header) return header;
  // Cross-tab fallback: the HttpOnly session cookie is shared across same-origin tabs.
  const cookies = parseAdminCookies(h);
  return String(cookies[ADMIN_COOKIE_NAME] || '').trim();
}

async function verifyAdminRequest(headers) {
  const cfg = getAdminConfig();
  if (!cfg.configured) return { ok: false, error: 'missing_admin_config' };
  const token = readAdminTokenFromHeaders(headers);
  if (!token || token.length < 16) return { ok: false, error: 'unauthorized' };
  const session = await validateAdminToken(token);
  if (!session) return { ok: false, error: 'unauthorized' };
  return { ok: true, username: session.username };
}

async function destroyAdminSession(token) {
  const t = String(token || '').trim();
  if (!t || t.startsWith(TOKEN_PREFIX)) return;
  if (t.length !== LEGACY_TOKEN_LEN) return;
  try {
    const store = await blobsStore(ADMIN_SESSION_STORE);
    await store.delete('asess-' + t.slice(0, 16));
  } catch (_) {}
}

function redactBookingForLegacyAdmin(b) {
  const j = { ...b };
  delete j.stripeCustomerId;
  delete j.stripePaymentMethodId;
  delete j.setupIntentId;
  delete j.paymentIntentId;
  delete j.stripeSubscriptionId;
  delete j.stripeSubscriptionScheduleId;
  return j;
}

module.exports = {
  getAdminConfig,
  verifyAdminCredentials,
  createAdminSession,
  validateAdminToken,
  verifyAdminRequest,
  destroyAdminSession,
  checkLoginRateLimit,
  recordLoginFailure,
  clearLoginFailures,
  clientIp,
  redactBookingForLegacyAdmin,
  getSessionSecretStatus,
  isProductionRuntime,
  isDevOrPreviewRuntime,
  adminSessionCookieHeader,
  clearAdminSessionCookieHeader,
  parseAdminCookies,
  readAdminTokenFromHeaders,
  ADMIN_SESSION_TTL_MS,
  ADMIN_COOKIE_NAME,
  TOKEN_PREFIX,
  MIN_SESSION_SECRET_LEN,
};
