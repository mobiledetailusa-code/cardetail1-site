// netlify/functions/tech-auth.js
// Technician authentication: login, set password (invite token), logout.
//
// POST { action, ...params }
//   set_password  { inviteToken, email, newPassword, confirmPassword } ΓåÆ { ok, token }
//   login         { email, password }                                  ΓåÆ { ok, token, techId, name }
//   validate      { token }                                            ΓåÆ { ok, techId, name }
//   logout        { token }                                            ΓåÆ { ok }

const crypto = require('crypto');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-tech-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const json = (status, body) => ({ statusCode: status, headers: CORS, body: JSON.stringify(body) });

const PBKDF2_ITERATIONS = 100000;
const PBKDF2_KEYLEN = 64;
const PBKDF2_DIGEST = 'sha256';
const SESSION_TTL_MS = 10 * 60 * 60 * 1000; // 10 hours
const MAX_TECH_SESSIONS = 3;
const MIN_PASSWORD_LENGTH = 8;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_FAILURES = 5;
const RATE_LOCKOUT_MS = 60 * 1000;

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
  } catch (_) {}
}

function hashPassword(password) {
  const salt = crypto.randomBytes(32).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString('hex');
  return { salt, hash, iterations: PBKDF2_ITERATIONS, keylen: PBKDF2_KEYLEN, digest: PBKDF2_DIGEST };
}

function verifyHash(password, record) {
  if (!record || !record.hash || !record.salt) return false;
  const hash = crypto.pbkdf2Sync(
    password, record.salt, record.iterations || PBKDF2_ITERATIONS,
    record.keylen || PBKDF2_KEYLEN, record.digest || PBKDF2_DIGEST
  ).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(record.hash));
}

function isWeakPassword(pw) {
  if (pw.length < MIN_PASSWORD_LENGTH) return 'Password must be at least 8 characters.';
  if (!/[A-Z]/.test(pw)) return 'Must contain at least one uppercase letter.';
  if (!/[a-z]/.test(pw)) return 'Must contain at least one lowercase letter.';
  if (!/[0-9]/.test(pw)) return 'Must contain at least one number.';
  return null;
}

async function findTechByEmail(store, email) {
  const listing = await store.list().catch(() => ({ blobs: [] }));
  for (const b of ((listing && listing.blobs) || [])) {
    if (!b.key.startsWith('tech-')) continue;
    const t = await store.get(b.key, { type: 'json' }).catch(() => null);
    if (t && t.email === email) return { key: b.key, tech: t };
  }
  return null;
}

async function findTechByInviteToken(store, inviteToken) {
  const listing = await store.list().catch(() => ({ blobs: [] }));
  for (const b of ((listing && listing.blobs) || [])) {
    if (!b.key.startsWith('tech-')) continue;
    const t = await store.get(b.key, { type: 'json' }).catch(() => null);
    if (t && t.inviteToken === inviteToken) return { key: b.key, tech: t };
  }
  return null;
}

async function createTechSession(sessStore, techId, techName) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const session = { token, techId, techName, createdAt: now, expiresAt: now + SESSION_TTL_MS };

  // Prune expired + enforce max sessions per tech
  const listing = await sessStore.list().catch(() => ({ blobs: [] }));
  const existing = [];
  for (const b of ((listing && listing.blobs) || [])) {
    if (!b.key.startsWith('tsess-')) continue;
    const s = await sessStore.get(b.key, { type: 'json' }).catch(() => null);
    if (!s) continue;
    if (s.expiresAt <= now) { try { await sessStore.delete(b.key); } catch (_) {} continue; }
    if (s.techId === techId) existing.push({ key: b.key, ...s });
  }
  if (existing.length >= MAX_TECH_SESSIONS) {
    existing.sort((a, b) => a.createdAt - b.createdAt);
    for (let i = 0; i <= existing.length - MAX_TECH_SESSIONS; i++) {
      try { await sessStore.delete(existing[i].key); } catch (_) {}
    }
  }

  await sessStore.setJSON('tsess-' + token.slice(0, 16), session);
  return session;
}

async function validateTechSession(sessStore, token) {
  if (!token || token.length < 32) return null;
  const key = 'tsess-' + token.slice(0, 16);
  const s = await sessStore.get(key, { type: 'json' }).catch(() => null);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    try { await sessStore.delete(key); } catch (_) {}
    return null;
  }
  if (!crypto.timingSafeEqual(Buffer.from(s.token), Buffer.from(token))) return null;
  return s;
}

async function checkRateLimit(store, identifier) {
  const key = 'trate-' + identifier.replace(/[^a-zA-Z0-9.@_-]/g, '_').slice(0, 80);
  const rec = await store.get(key, { type: 'json' }).catch(() => null);
  if (!rec) return { allowed: true, key };
  const now = Date.now();
  if (now - rec.windowStart > RATE_WINDOW_MS) return { allowed: true, key };
  if (rec.failures >= RATE_MAX_FAILURES) {
    const lockoutEnd = rec.lastFailure + RATE_LOCKOUT_MS;
    if (now < lockoutEnd) return { allowed: false, key, retryAfter: Math.ceil((lockoutEnd - now) / 1000) };
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

// ΓöÇΓöÇ Handler ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { ok: false, error: 'invalid_json' }); }

  const action = String(body.action || '');
  const ip = ((event.headers || {})['x-forwarded-for'] || '').slice(0, 45);
  const techStore = await getStore('cd1-tech-accounts');
  const sessStore = await getStore('cd1-tech-sessions');

  // ΓöÇΓöÇ SET PASSWORD (invite token flow) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  if (action === 'set_password') {
    const inviteToken = String(body.inviteToken || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const newPassword = String(body.newPassword || '');
    const confirmPassword = String(body.confirmPassword || '');

    if (!inviteToken || !email) return json(400, { ok: false, error: 'invite_token_and_email_required' });
    if (!newPassword || !confirmPassword) return json(400, { ok: false, error: 'password_required' });
    if (newPassword !== confirmPassword) return json(400, { ok: false, error: 'passwords_do_not_match' });

    const weakness = isWeakPassword(newPassword);
    if (weakness) return json(400, { ok: false, error: 'weak_password', message: weakness });

    const result = await findTechByInviteToken(techStore, inviteToken);
    if (!result) return json(404, { ok: false, error: 'invalid_invite_token' });
    if (result.tech.inviteExpiresAt && new Date(result.tech.inviteExpiresAt) < new Date()) {
      await securityLog({ type: 'tech_invite_expired', email, ip });
      return json(410, { ok: false, error: 'invite_expired', message: 'Invite expired. Please ask the admin to send a new invite.' });
    }
    if (result.tech.email !== email) return json(403, { ok: false, error: 'email_mismatch' });
    if (!result.tech.active) return json(403, { ok: false, error: 'account_deactivated' });

    result.tech.passwordHash = hashPassword(newPassword);
    result.tech.inviteToken = null;
    result.tech.inviteTokenCreatedAt = null;
    result.tech.inviteExpiresAt = null;
    result.tech.updatedAt = new Date().toISOString();
    await techStore.setJSON(result.key, result.tech);

    // Create session
    const session = await createTechSession(sessStore, result.tech.id, result.tech.name);
    await securityLog({ type: 'tech_password_set', techId: result.tech.id, ip });

    return json(200, {
      ok: true,
      token: session.token,
      techId: result.tech.id,
      name: result.tech.name,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  }

  // ΓöÇΓöÇ LOGIN ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  if (action === 'login') {
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (!email || !password) return json(400, { ok: false, error: 'email_and_password_required' });

    const rl = await checkRateLimit(techStore, email);
    if (!rl.allowed) {
      await securityLog({ type: 'tech_login_rate_limited', email, ip });
      return json(429, { ok: false, error: 'too_many_attempts', retryAfter: rl.retryAfter });
    }

    const result = await findTechByEmail(techStore, email);
    if (!result || !result.tech.passwordHash) {
      await recordFailure(techStore, rl.key);
      await securityLog({ type: 'tech_login_failure', email, ip, reason: result ? 'no_password_set' : 'not_found' });
      return json(401, { ok: false, error: 'invalid_credentials' });
    }

    if (!result.tech.active) {
      await securityLog({ type: 'tech_login_failure', email, ip, reason: 'deactivated' });
      return json(403, { ok: false, error: 'account_deactivated' });
    }

    if (!verifyHash(password, result.tech.passwordHash)) {
      await recordFailure(techStore, rl.key);
      await securityLog({ type: 'tech_login_failure', email, ip });
      return json(401, { ok: false, error: 'invalid_credentials' });
    }

    await clearRateLimit(techStore, rl.key);

    // Update last login
    result.tech.lastLoginAt = new Date().toISOString();
    await techStore.setJSON(result.key, result.tech);

    const session = await createTechSession(sessStore, result.tech.id, result.tech.name);
    await securityLog({ type: 'tech_login_success', techId: result.tech.id, ip });

    return json(200, {
      ok: true,
      token: session.token,
      techId: result.tech.id,
      name: result.tech.name,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  }

  // ΓöÇΓöÇ VALIDATE ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  if (action === 'validate') {
    const token = String(body.token || '');
    const session = await validateTechSession(sessStore, token);
    if (!session) return json(401, { ok: false, error: 'invalid_or_expired_session' });

    // Also verify the tech is still active
    const tech = await techStore.get('tech-' + session.techId, { type: 'json' }).catch(() => null);
    if (!tech || !tech.active) {
      return json(403, { ok: false, error: 'account_deactivated' });
    }

    return json(200, { ok: true, techId: session.techId, name: session.techName });
  }

  // ΓöÇΓöÇ LOGOUT ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  if (action === 'logout') {
    const token = String(body.token || '');
    if (token && token.length >= 32) {
      const key = 'tsess-' + token.slice(0, 16);
      try { await sessStore.delete(key); } catch (_) {}
    }
    await securityLog({ type: 'tech_logout', ip });
    return json(200, { ok: true });
  }

  return json(400, { ok: false, error: 'unknown_action' });
};
