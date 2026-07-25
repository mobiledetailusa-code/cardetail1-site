// HttpOnly customer portal sessions — no raw tokens stored server-side.
// Server-side session records in cd1-customer-sessions are authoritative for
// expiration and revocation. Cookie payloads alone are never sufficient.

const crypto = require('crypto');
const { blobsStore } = require('./tech-security');
const { normalizeUsPhoneDigits, normalizeUsPhoneE164 } = require('./phone-auth');

const SESSION_STORE = 'cd1-customer-sessions';
const TOKEN_STORE = 'cd1-customer-auth-tokens';
// Device session. A customer who returns days later must still re-enter through
// their (single-use) appointment link, so the session has to outlive a browser
// restart. Cookie Max-Age, signed payload exp, and the Blob record TTL are all
// derived from this one constant — the cookie must never outlive the record.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_AUTH_ATTEMPTS = 5;

const COOKIE_NAME = 'cd1_customer_session';

let sessionStoreFactoryOverride = null;
let productionCustomerSecretFallbackWarned = false;

function sessionSecret() {
  // Prefer a dedicated customer secret so customer cookies are cryptographically
  // separated from admin sessions. Production should set CUSTOMER_SESSION_SECRET.
  const customer = String(process.env.CUSTOMER_SESSION_SECRET || '').trim();
  if (customer.length >= 32) return customer;

  const admin = String(process.env.ADMIN_SESSION_SECRET || '').trim();
  if (admin.length >= 32) {
    const ctx = String(process.env.CONTEXT || '').toLowerCase();
    if (ctx === 'production' && !productionCustomerSecretFallbackWarned) {
      productionCustomerSecretFallbackWarned = true;
      // Non-PII operational warning only — never log the secret value.
      console.warn(
        '[customer-session] CUSTOMER_SESSION_SECRET missing in production; falling back to ADMIN_SESSION_SECRET. Configure a dedicated CUSTOMER_SESSION_SECRET (32+ chars) for cryptographic separation.'
      );
    }
    return admin;
  }

  const ctx = String(process.env.CONTEXT || '').toLowerCase();
  const isProd = ctx === 'production';
  if (!isProd) {
    const fallback = String(process.env.BID_SECRET || process.env.ADMIN_DASH_PASSWORD || 'dev-customer-session-secret-32chars-min').trim();
    if (fallback.length >= 32) return fallback;
  }
  return '';
}

async function resolveSessionStore() {
  if (typeof sessionStoreFactoryOverride === 'function') {
    return sessionStoreFactoryOverride(SESSION_STORE);
  }
  return blobsStore(SESSION_STORE);
}

function hashToken(token) {
  const secret = sessionSecret();
  if (!secret) throw new Error('customer_session_not_configured');
  return crypto.createHmac('sha256', secret).update(String(token)).digest('base64url');
}

function signSessionPayload(payload) {
  const secret = sessionSecret();
  if (!secret) throw new Error('customer_session_not_configured');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/**
 * Cryptographically verify a session cookie token.
 * @param {string} token
 * @param {{ allowExpired?: boolean }} [opts]
 * @returns {object|null}
 */
function verifySessionToken(token, opts = {}) {
  const secret = sessionSecret();
  if (!secret || !token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || !payload.sid || !payload.exp) return null;
    if (!opts.allowExpired && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(event) {
  const raw = String(event?.headers?.cookie || event?.headers?.Cookie || '');
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

/**
 * Secure by default. Every deployed context — production, branch-deploy and
 * deploy-preview alike — is HTTPS-only, so the flag is dropped only for a local
 * `netlify dev` server, which serves the portal over plain http.
 */
function cookieIsSecure() {
  if (process.env.NETLIFY_DEV === 'true') return false;
  const ctx = String(process.env.CONTEXT || '').toLowerCase();
  return ctx !== 'dev';
}

function sessionCookieHeader(token, { maxAgeSec = SESSION_TTL_MS / 1000 } = {}) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeSec)}`,
  ];
  if (cookieIsSecure()) parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookieHeader() {
  const parts = [`${COOKIE_NAME}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (cookieIsSecure()) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Fail-closed session validation: signature, expiry, stored record, revoked state,
 * and session-id match. Never logs raw cookies or tokens.
 */
async function validateCustomerSession(event) {
  const cookies = parseCookies(event);
  const token = cookies[COOKIE_NAME];
  const payload = verifySessionToken(token);
  if (!payload) return { ok: false, error: 'session_invalid' };

  let record;
  try {
    const store = await resolveSessionStore();
    record = await store.get(payload.sid, { type: 'json' });
  } catch {
    return { ok: false, error: 'session_invalid' };
  }

  if (!record) return { ok: false, error: 'session_invalid' };
  if (record.revoked === true || record.revokedAt) return { ok: false, error: 'session_invalid' };
  if (String(record.sid || '') !== String(payload.sid)) return { ok: false, error: 'session_invalid' };
  const recordExp = Number(record.exp) || 0;
  if (!recordExp || Date.now() > recordExp) return { ok: false, error: 'session_invalid' };

  return {
    ok: true,
    scope: payload.scope || record.scope || 'account',
    sessionId: payload.sid,
    customerAccountId: payload.customerAccountId || record.customerAccountId || null,
    phoneDigits: payload.phoneDigits || record.phoneDigits || null,
    emailHash: payload.emailHash || record.emailHash || null,
    bookingIds: payload.bookingIds || record.bookingIds || [],
    exp: payload.exp,
  };
}

/**
 * Mark the server-side session revoked so a captured cookie cannot be reused.
 * Clears nothing locally — callers must also send clearSessionCookieHeader().
 */
async function revokeCustomerSession(event) {
  const cookies = parseCookies(event);
  const token = cookies[COOKIE_NAME];
  // Allow expired signatures so logout still revokes a lingering server record.
  const payload = verifySessionToken(token, { allowExpired: true });
  if (!payload || !payload.sid) return { ok: true, revoked: false };

  try {
    const store = await resolveSessionStore();
    const record = await store.get(payload.sid, { type: 'json' }).catch(() => null);
    if (!record) return { ok: true, revoked: false };
    if (record.revoked === true || record.revokedAt) return { ok: true, revoked: true };

    const remainingMs = Math.max(60_000, (Number(record.exp) || Date.now()) - Date.now());
    await store.setJSON(payload.sid, {
      ...record,
      revoked: true,
      revokedAt: new Date().toISOString(),
    }, { ttl: remainingMs });
    return { ok: true, revoked: true };
  } catch {
    // Logout still clears the browser cookie; fail soft on storage errors.
    return { ok: true, revoked: false };
  }
}

async function createAccountSession({
  phoneDigits,
  email,
  bookingIds = [],
  customerAccountId = null,
} = {}) {
  const sid = `cs_${crypto.randomBytes(12).toString('base64url')}`;
  const exp = Date.now() + SESSION_TTL_MS;
  const emailNorm = String(email || '').trim().toLowerCase();
  const emailHash = emailNorm
    ? crypto.createHash('sha256').update(emailNorm).digest('base64url')
    : null;
  // Only the safe account id is stored in the signed cookie payload — never
  // Stripe ids, raw email/phone, or auth metadata.
  const safeAccountId = customerAccountId ? String(customerAccountId) : null;
  const payload = {
    sid,
    scope: 'account',
    customerAccountId: safeAccountId,
    phoneDigits: phoneDigits || null,
    emailHash,
    bookingIds: Array.isArray(bookingIds) ? bookingIds.slice(0, 50) : [],
    exp,
  };
  const token = signSessionPayload(payload);
  const store = await resolveSessionStore();
  await store.setJSON(sid, {
    ...payload,
    revoked: false,
    createdAt: new Date().toISOString(),
  }, { ttl: SESSION_TTL_MS });
  return { token, session: payload };
}

function setCustomerSessionStoreFactory(factory) {
  sessionStoreFactoryOverride = typeof factory === 'function' ? factory : null;
}

function resetCustomerSessionStoreFactory() {
  sessionStoreFactoryOverride = null;
}

async function storeAuthChallenge({ type, email, phoneDigits, codeOrTokenHash }) {
  const store = await blobsStore(TOKEN_STORE);
  const id = `auth_${crypto.randomBytes(10).toString('base64url')}`;
  const ttl = type === 'otp' ? OTP_TTL_MS : MAGIC_LINK_TTL_MS;
  await store.setJSON(id, {
    type,
    email: String(email || '').trim().toLowerCase(),
    phoneDigits: phoneDigits || null,
    hash: codeOrTokenHash,
    attempts: 0,
    used: false,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttl).toISOString(),
  }, { ttl });
  return id;
}

function resendConfigured() {
  return !!String(process.env.RESEND_API_KEY || '').trim() && !!String(process.env.ADMIN_EMAIL || process.env.RESEND_FROM || '').trim();
}

function twilioOtpEnabled() {
  return String(process.env.CUSTOMER_PORTAL_SMS_OTP_ENABLED || '').toLowerCase() === 'true'
    && !!String(process.env.TWILIO_SID || '').trim()
    && !!String(process.env.TWILIO_TOKEN || '').trim()
    && !!String(process.env.TWILIO_FROM || '').trim();
}

module.exports = {
  COOKIE_NAME,
  SESSION_STORE,
  SESSION_TTL_MS,
  MAGIC_LINK_TTL_MS,
  OTP_TTL_MS,
  MAX_AUTH_ATTEMPTS,
  hashToken,
  signSessionPayload,
  verifySessionToken,
  parseCookies,
  sessionCookieHeader,
  clearSessionCookieHeader,
  validateCustomerSession,
  revokeCustomerSession,
  createAccountSession,
  storeAuthChallenge,
  setCustomerSessionStoreFactory,
  resetCustomerSessionStoreFactory,
  resendConfigured,
  twilioOtpEnabled,
  normalizeUsPhoneDigits,
  normalizeUsPhoneE164,
};
