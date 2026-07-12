// HttpOnly customer portal sessions — no raw tokens stored server-side.

const crypto = require('crypto');
const { blobsStore } = require('./tech-security');
const { normalizeUsPhoneDigits, normalizeUsPhoneE164 } = require('./phone-auth');

const SESSION_STORE = 'cd1-customer-sessions';
const TOKEN_STORE = 'cd1-customer-auth-tokens';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_AUTH_ATTEMPTS = 5;

const COOKIE_NAME = 'cd1_customer_session';

function sessionSecret() {
  const primary = String(process.env.CUSTOMER_SESSION_SECRET || process.env.ADMIN_SESSION_SECRET || '').trim();
  if (primary.length >= 32) return primary;
  const ctx = String(process.env.CONTEXT || '').toLowerCase();
  const isProd = ctx === 'production';
  if (!isProd) {
    const fallback = String(process.env.BID_SECRET || process.env.ADMIN_DASH_PASSWORD || 'dev-customer-session-secret-32chars-min').trim();
    if (fallback.length >= 32) return fallback;
  }
  return '';
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

function verifySessionToken(token) {
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
    if (!payload || !payload.exp || Date.now() > payload.exp) return null;
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

function sessionCookieHeader(token, { maxAgeSec = SESSION_TTL_MS / 1000 } = {}) {
  const secure = process.env.CONTEXT === 'production' || process.env.NODE_ENV === 'production';
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeSec)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookieHeader() {
  const secure = process.env.CONTEXT === 'production' || process.env.NODE_ENV === 'production';
  const parts = [`${COOKIE_NAME}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

async function validateCustomerSession(event) {
  const cookies = parseCookies(event);
  const token = cookies[COOKIE_NAME];
  const payload = verifySessionToken(token);
  if (!payload) return { ok: false, error: 'session_invalid' };
  return {
    ok: true,
    scope: payload.scope || 'account',
    sessionId: payload.sid,
    phoneDigits: payload.phoneDigits || null,
    emailHash: payload.emailHash || null,
    bookingIds: payload.bookingIds || [],
    exp: payload.exp,
  };
}

async function createAccountSession({ phoneDigits, email, bookingIds = [] }) {
  const sid = `cs_${crypto.randomBytes(12).toString('base64url')}`;
  const exp = Date.now() + SESSION_TTL_MS;
  const emailNorm = String(email || '').trim().toLowerCase();
  const emailHash = emailNorm
    ? crypto.createHash('sha256').update(emailNorm).digest('base64url')
    : null;
  const payload = {
    sid,
    scope: 'account',
    phoneDigits: phoneDigits || null,
    emailHash,
    bookingIds: Array.isArray(bookingIds) ? bookingIds.slice(0, 50) : [],
    exp,
  };
  const token = signSessionPayload(payload);
  const store = await blobsStore(SESSION_STORE);
  await store.setJSON(sid, { ...payload, createdAt: new Date().toISOString() }, { ttl: SESSION_TTL_MS });
  return { token, session: payload };
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
  createAccountSession,
  storeAuthChallenge,
  resendConfigured,
  twilioOtpEnabled,
  normalizeUsPhoneDigits,
  normalizeUsPhoneE164,
};
