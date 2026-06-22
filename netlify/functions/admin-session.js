// netlify/functions/admin-session.js
// Admin authentication with server-side sessions, rate limiting, and password management.
//
// Actions (POST JSON):
//   login           { password }                          → { ok, token, expiresAt }
//   validate        { token }                             → { ok }
//   logout          { token }                             → { ok }
//   change_password { token, currentPassword, newPassword, confirmPassword } → { ok }
//
// Password storage: PBKDF2-SHA256 hash in Netlify Blobs (cd1-admin-auth).
// Falls back to ADMIN_DASH_PASSWORD env var for initial/legacy login.
// Sessions stored in cd1-admin-sessions with 8-hour expiry.
// Rate limiting: 5 failures per 15min window → 60s lockout.

const crypto = require('crypto');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const json = (status, body) => ({ statusCode: status, headers: CORS, body: JSON.stringify(body) });

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const MAX_SESSIONS = 10;
const RATE_WINDOW_MS = 15 * 60 * 1000; // 15 min
const RATE_MAX_FAILURES = 5;
const RATE_LOCKOUT_MS = 60 * 1000; // 60s
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_KEYLEN = 64;
const PBKDF2_DIGEST = 'sha256';
const MIN_PASSWORD_LENGTH = 8;

async function getStore(name) {
  const { getStore: gs } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token) ? gs({ name, siteID, token }) : gs(name);
}

async function securityLog(entry) {
  try {
    const store = await getStore('cd1-security-log');
    const key = 'log-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    await store.setJSON(key, { ...entry, at: new Date().toISOString() });
  } catch (_) { /* best effort */ }
}

// ── Password hashing ────────────────────────────────────────────────────────

function hashPassword(password) {
  const salt = crypto.randomBytes(32).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString('hex');
  return { salt, hash, iterations: PBKDF2_ITERATIONS, keylen: PBKDF2_KEYLEN, digest: PBKDF2_DIGEST };
}

function verifyHash(password, record) {
  const hash = crypto.pbkdf2Sync(
    password, record.salt, record.iterations || PBKDF2_ITERATIONS,
    record.keylen || PBKDF2_KEYLEN, record.digest || PBKDF2_DIGEST
  ).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(record.hash));
}

// ── Password strength ───────────────────────────────────────────────────────

function isWeakPassword(pw) {
  if (pw.length < MIN_PASSWORD_LENGTH) return 'Password must be at least 8 characters.';
  if (!/[A-Z]/.test(pw)) return 'Password must contain at least one uppercase letter.';
  if (!/[a-z]/.test(pw)) return 'Password must contain at least one lowercase letter.';
  if (!/[0-9]/.test(pw)) return 'Password must contain at least one number.';
  return null;
}

// ── Rate limiting ───────────────────────────────────────────────────────────

async function checkRateLimit(store, ip) {
  const key = 'rate-' + (ip || 'unknown').replace(/[^a-zA-Z0-9.:]/g, '_');
  const rec = await store.get(key, { type: 'json' }).catch(() => null);
  if (!rec) return { allowed: true, key };
  const now = Date.now();
  if (now - rec.windowStart > RATE_WINDOW_MS) return { allowed: true, key };
  if (rec.failures >= RATE_MAX_FAILURES) {
    const lockoutEnd = rec.lastFailure + RATE_LOCKOUT_MS;
    if (now < lockoutEnd) {
      return { allowed: false, key, retryAfter: Math.ceil((lockoutEnd - now) / 1000) };
    }
  }
  return { allowed: true, key, rec };
}

async function recordFailure(store, key) {
  const now = Date.now();
  const rec = await store.get(key, { type: 'json' }).catch(() => null);
  const record = rec && (now - rec.windowStart < RATE_WINDOW_MS)
    ? { ...rec, failures: rec.failures + 1, lastFailure: now }
    : { windowStart: now, failures: 1, lastFailure: now };
  await store.setJSON(key, record);
}

async function clearRateLimit(store, key) {
  try { await store.delete(key); } catch (_) {}
}

// ── Session management ──────────────────────────────────────────────────────

async function createSession(store) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const session = { token, createdAt: now, expiresAt: now + SESSION_TTL_MS };
  // Get existing sessions, prune expired, enforce max
  const listing = await store.list().catch(() => ({ blobs: [] }));
  const blobs = (listing && listing.blobs) || [];
  const sessions = [];
  for (const b of blobs) {
    if (!b.key.startsWith('sess-')) continue;
    const s = await store.get(b.key, { type: 'json' }).catch(() => null);
    if (s && s.expiresAt > now) sessions.push({ key: b.key, ...s });
    else if (s) try { await store.delete(b.key); } catch (_) {}
  }
  // Remove oldest if at max
  if (sessions.length >= MAX_SESSIONS) {
    sessions.sort((a, b) => a.createdAt - b.createdAt);
    for (let i = 0; i <= sessions.length - MAX_SESSIONS; i++) {
      try { await store.delete(sessions[i].key); } catch (_) {}
    }
  }
  const key = 'sess-' + token.slice(0, 16);
  await store.setJSON(key, session);
  return session;
}

async function validateSession(store, token) {
  if (!token || token.length < 32) return false;
  const key = 'sess-' + token.slice(0, 16);
  const s = await store.get(key, { type: 'json' }).catch(() => null);
  if (!s) return false;
  if (Date.now() > s.expiresAt) {
    try { await store.delete(key); } catch (_) {}
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(s.token), Buffer.from(token));
}

async function destroySession(store, token) {
  if (!token) return;
  const key = 'sess-' + token.slice(0, 16);
  try { await store.delete(key); } catch (_) {}
}

// ── Verify admin password ───────────────────────────────────────────────────

async function verifyAdminPassword(authStore, password) {
  const rec = await authStore.get('admin-password', { type: 'json' }).catch(() => null);
  if (rec && rec.hash) {
    return verifyHash(password, rec);
  }
  // Fall back to env var for initial setup
  const envPw = (process.env.ADMIN_DASH_PASSWORD || '').trim();
  if (!envPw) return false;
  const a = Buffer.from(password);
  const b = Buffer.from(envPw);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (match) {
    // Migrate: store hashed version in Blobs
    const hashed = hashPassword(password);
    await authStore.setJSON('admin-password', { ...hashed, migratedAt: new Date().toISOString() });
  }
  return match;
}

// ── Handler ─────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'invalid_json' }); }

  const action = String(body.action || '');
  const ip = (event.headers || {})['x-forwarded-for'] || (event.headers || {})['client-ip'] || 'unknown';

  const authStore = await getStore('cd1-admin-auth');
  const sessionStore = await getStore('cd1-admin-sessions');

  // ── LOGIN ─────────────────────────────────────────────────────────────
  if (action === 'login') {
    const password = String(body.password || '');
    if (!password) return json(400, { ok: false, error: 'password_required' });

    // Rate limit check
    const rl = await checkRateLimit(authStore, ip);
    if (!rl.allowed) {
      await securityLog({ type: 'admin_login_rate_limited', ip: ip.slice(0, 45) });
      return json(429, { ok: false, error: 'too_many_attempts', retryAfter: rl.retryAfter });
    }

    const valid = await verifyAdminPassword(authStore, password);
    if (!valid) {
      await recordFailure(authStore, rl.key);
      await securityLog({ type: 'admin_login_failure', ip: ip.slice(0, 45) });
      return json(401, { ok: false, error: 'invalid_password' });
    }

    await clearRateLimit(authStore, rl.key);
    const session = await createSession(sessionStore);
    await securityLog({ type: 'admin_login_success', ip: ip.slice(0, 45) });

    return json(200, {
      ok: true,
      token: session.token,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  }

  // ── VALIDATE ──────────────────────────────────────────────────────────
  if (action === 'validate') {
    const token = String(body.token || '');
    const valid = await validateSession(sessionStore, token);
    if (!valid) return json(401, { ok: false, error: 'invalid_or_expired_session' });
    return json(200, { ok: true });
  }

  // ── LOGOUT ────────────────────────────────────────────────────────────
  if (action === 'logout') {
    const token = String(body.token || '');
    await destroySession(sessionStore, token);
    await securityLog({ type: 'admin_logout', ip: ip.slice(0, 45) });
    return json(200, { ok: true });
  }

  // ── CHANGE PASSWORD ───────────────────────────────────────────────────
  if (action === 'change_password') {
    const token = String(body.token || '');
    const valid = await validateSession(sessionStore, token);
    if (!valid) return json(401, { ok: false, error: 'invalid_or_expired_session' });

    const currentPassword = String(body.currentPassword || '');
    const newPassword = String(body.newPassword || '');
    const confirmPassword = String(body.confirmPassword || '');

    if (!currentPassword || !newPassword || !confirmPassword) {
      return json(400, { ok: false, error: 'all_fields_required' });
    }
    if (newPassword !== confirmPassword) {
      return json(400, { ok: false, error: 'passwords_do_not_match' });
    }
    const weakness = isWeakPassword(newPassword);
    if (weakness) {
      return json(400, { ok: false, error: 'weak_password', message: weakness });
    }

    const currentValid = await verifyAdminPassword(authStore, currentPassword);
    if (!currentValid) {
      await securityLog({ type: 'admin_password_change_failed', reason: 'wrong_current', ip: ip.slice(0, 45) });
      return json(401, { ok: false, error: 'current_password_incorrect' });
    }

    const hashed = hashPassword(newPassword);
    await authStore.setJSON('admin-password', { ...hashed, changedAt: new Date().toISOString() });

    // Invalidate all sessions except current
    const listing = await sessionStore.list().catch(() => ({ blobs: [] }));
    const blobs = (listing && listing.blobs) || [];
    for (const b of blobs) {
      if (b.key === 'sess-' + token.slice(0, 16)) continue;
      try { await sessionStore.delete(b.key); } catch (_) {}
    }

    await securityLog({ type: 'admin_password_changed', ip: ip.slice(0, 45) });
    return json(200, { ok: true, message: 'Password changed. Other sessions invalidated.' });
  }

  return json(400, { ok: false, error: 'unknown_action' });
};
