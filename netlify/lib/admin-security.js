// Admin authentication — username + password login, opaque session tokens (never send password to APIs).
const crypto = require('crypto');

const ADMIN_SESSION_STORE = 'cd1-admin-sessions';
const ADMIN_RATE_STORE = 'cd1-admin-login-rate';
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_ADMIN_SESSIONS = 5;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_FAILURES = 8;
const RATE_LOCK_MS = 30 * 60 * 1000;
const TOKEN_LEN = 64;

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
  const username = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
  const password = (process.env.ADMIN_DASH_PASSWORD || '').trim();
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
  const fwd = event && event.headers && (event.headers['x-forwarded-for'] || event.headers['X-Forwarded-For']);
  if (fwd) return String(fwd).split(',')[0].trim();
  return (event && event.headers && (event.headers['client-ip'] || event.headers['x-nf-client-connection-ip'])) || 'unknown';
}

function rateKey(ip) {
  return 'rate-' + crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 20);
}

async function checkLoginRateLimit(ip) {
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
}

async function recordLoginFailure(ip) {
  const check = await checkLoginRateLimit(ip);
  if (!check.ok) return;
  const { key, rec, store } = check;
  const now = Date.now();
  rec.failures = (rec.failures || 0) + 1;
  if (rec.failures >= RATE_MAX_FAILURES) rec.lockedUntil = now + RATE_LOCK_MS;
  await store.setJSON(key, rec);
}

async function clearLoginFailures(ip) {
  const store = await blobsStore(ADMIN_RATE_STORE);
  try { await store.delete(rateKey(ip)); } catch (_) {}
}

async function createAdminSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const session = {
    token,
    username: String(username || '').trim().toLowerCase(),
    createdAt: now,
    expiresAt: now + ADMIN_SESSION_TTL_MS,
  };
  const store = await blobsStore(ADMIN_SESSION_STORE);
  const listing = await store.list().catch(() => ({ blobs: [] }));
  const existing = [];
  for (const b of ((listing && listing.blobs) || [])) {
    if (!b.key.startsWith('asess-')) continue;
    const s = await store.get(b.key, { type: 'json' }).catch(() => null);
    if (!s) continue;
    if (s.expiresAt <= now) { try { await store.delete(b.key); } catch (_) {} continue; }
    if (s.username === session.username) existing.push({ key: b.key, ...s });
  }
  if (existing.length >= MAX_ADMIN_SESSIONS) {
    existing.sort((a, b) => a.createdAt - b.createdAt);
    for (let i = 0; i <= existing.length - MAX_ADMIN_SESSIONS; i++) {
      try { await store.delete(existing[i].key); } catch (_) {}
    }
  }
  await store.setJSON('asess-' + token.slice(0, 16), session);
  return { token, expiresAt: session.expiresAt };
}

async function validateAdminToken(token) {
  const t = String(token || '').trim();
  if (!t || t.length !== TOKEN_LEN || !/^[a-f0-9]+$/.test(t)) return null;
  const store = await blobsStore(ADMIN_SESSION_STORE);
  const session = await store.get('asess-' + t.slice(0, 16), { type: 'json' }).catch(() => null);
  if (!session || Date.now() > session.expiresAt) return null;
  if (!timingSafeString(session.token, t)) return null;
  return session;
}

async function verifyAdminRequest(headers) {
  const cfg = getAdminConfig();
  if (!cfg.configured) return { ok: false, error: 'missing_admin_config' };
  const token = ((headers && (headers['x-admin-key'] || headers['X-Admin-Key'])) || '').trim();
  if (!token || token.length !== TOKEN_LEN) return { ok: false, error: 'unauthorized' };
  const session = await validateAdminToken(token);
  if (!session) return { ok: false, error: 'unauthorized' };
  return { ok: true, username: session.username };
}

async function destroyAdminSession(token) {
  const t = String(token || '').trim();
  if (!t || t.length !== TOKEN_LEN) return;
  const store = await blobsStore(ADMIN_SESSION_STORE);
  try { await store.delete('asess-' + t.slice(0, 16)); } catch (_) {}
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
  ADMIN_SESSION_TTL_MS,
};
