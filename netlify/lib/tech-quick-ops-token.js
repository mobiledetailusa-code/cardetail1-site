'use strict';

/**
 * Booking-scoped technician Quick Ops tokens.
 * Purpose is tech_quick_ops only — never interchangeable with admin /ops/q, /a?t=, or /pay.
 * Raw tokens are never stored. A new assignment revokes the previous link.
 */

const crypto = require('crypto');

const TOKEN_STORE = 'cd1-tech-quick-ops-tokens';
const SESSION_STORE = 'cd1-tech-quick-ops-sessions';
const TOKEN_PREFIX = 'tqt_';
const SESSION_PREFIX = 'tqs_';
const PURPOSE_TECH_QUICK_OPS = 'tech_quick_ops';
const TOKEN_TTL_MS = 48 * 60 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE_NAME = 'cd1_tq_session';

let tokenStoreFactoryOverride = null;
let sessionStoreFactoryOverride = null;

function tokenSecret() {
  const secret = String(
    process.env.TECH_QUICK_OPS_SECRET
    || process.env.ADMIN_QUICK_OPS_SECRET
    || process.env.CUSTOMER_SESSION_SECRET
    || process.env.DRAFT_TOKEN_SECRET
    || ''
  ).trim();
  if (!secret || secret.length < 16) throw new Error('missing_tech_quick_ops_secret');
  return secret;
}

function hashToken(value) {
  return crypto.createHmac('sha256', tokenSecret()).update(String(value)).digest('hex');
}

function generateToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

function generateSessionId() {
  return SESSION_PREFIX + crypto.randomBytes(24).toString('base64url');
}

function currentEnvBinding() {
  const { deployEnvironmentKey } = require('./trusted-site-origin');
  return deployEnvironmentKey();
}

function envBindingMatches(record) {
  const expected = currentEnvBinding();
  const actual = String(record?.envBinding || '').trim();
  if (!actual) return expected === 'production';
  return actual === expected;
}

function siteBase() {
  const { trustedSiteOrigin } = require('./trusted-site-origin');
  return trustedSiteOrigin();
}

function buildTechOpsUrl(token) {
  return `${siteBase()}/ops/t/${encodeURIComponent(token)}`;
}

function tokenKey(tokenHash) {
  return `tok_${String(tokenHash).slice(0, 32)}`;
}

function sessionKey(sessionId) {
  return `sess_${hashToken(sessionId).slice(0, 32)}`;
}

async function resolveTokenStore() {
  if (typeof tokenStoreFactoryOverride === 'function') {
    return tokenStoreFactoryOverride(TOKEN_STORE);
  }
  const { blobsStore } = require('./tech-security');
  return blobsStore(TOKEN_STORE);
}

async function resolveSessionStore() {
  if (typeof sessionStoreFactoryOverride === 'function') {
    return sessionStoreFactoryOverride(SESSION_STORE);
  }
  const { blobsStore } = require('./tech-security');
  return blobsStore(SESSION_STORE);
}

function setTechQuickOpsStoreFactories({ tokenStore, sessionStore } = {}) {
  tokenStoreFactoryOverride = typeof tokenStore === 'function' ? tokenStore : null;
  sessionStoreFactoryOverride = typeof sessionStore === 'function' ? sessionStore : null;
}

function resetTechQuickOpsStoreFactories() {
  tokenStoreFactoryOverride = null;
  sessionStoreFactoryOverride = null;
}

async function readJson(store, key) {
  if (typeof store.getWithMetadata === 'function') {
    const result = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' }).catch(() => null);
    if (!result || !result.data) return null;
    return result.data;
  }
  return store.get(key, { type: 'json' }).catch(() => null);
}

function looksLikeTechToken(raw) {
  const token = String(raw || '').trim();
  return token.startsWith(TOKEN_PREFIX) && token.length >= 20;
}

async function createTechQuickOpsToken({ bookingId, phoneE164, ttlMs = TOKEN_TTL_MS } = {}) {
  const id = String(bookingId || '').trim();
  const phone = String(phoneE164 || '').trim();
  if (!id) return { ok: false, error: 'booking_required' };
  if (!phone) return { ok: false, error: 'phone_required' };
  const token = generateToken();
  const tokenHash = hashToken(token);
  const store = await resolveTokenStore();
  const now = new Date();
  const requestedTtl = Number(ttlMs);
  const ttl = Number.isFinite(requestedTtl) ? requestedTtl : TOKEN_TTL_MS;
  const expiresAt = new Date(now.getTime() + ttl).toISOString();
  const record = {
    tokenHash,
    purpose: PURPOSE_TECH_QUICK_OPS,
    audience: PURPOSE_TECH_QUICK_OPS,
    bookingId: id,
    phoneE164: phone,
    envBinding: currentEnvBinding(),
    createdAt: now.toISOString(),
    expiresAt,
    revokedAt: null,
  };
  const ttlSec = Math.max(1, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000));
  await store.setJSON(tokenKey(tokenHash), record, { ttl: ttlSec });
  return {
    ok: true,
    token,
    tokenHash,
    opsUrl: buildTechOpsUrl(token),
    expiresAt,
    bookingId: id,
    phoneE164: phone,
  };
}

async function consumeTechQuickOpsToken(rawToken) {
  const token = String(rawToken || '').trim();
  if (!looksLikeTechToken(token)) return { ok: false, error: 'invalid' };
  let hash = '';
  try { hash = hashToken(token); }
  catch { return { ok: false, error: 'invalid' }; }
  const store = await resolveTokenStore();
  const record = await readJson(store, tokenKey(hash));
  if (!record || record.purpose !== PURPOSE_TECH_QUICK_OPS || record.revokedAt) {
    return { ok: false, error: 'invalid' };
  }
  if (!envBindingMatches(record) || Date.parse(record.expiresAt) <= Date.now()) {
    return { ok: false, error: 'invalid' };
  }
  await store.setJSON(tokenKey(hash), { ...record, revokedAt: new Date().toISOString() });
  return { ok: true, consumed: true };
}

async function revokeTechQuickOpsToken(tokenHash) {
  const hash = String(tokenHash || '').trim();
  if (!hash) return { ok: true, revoked: false };
  const store = await resolveTokenStore();
  const record = await readJson(store, tokenKey(hash));
  if (!record) return { ok: true, revoked: false };
  if (record.revokedAt) return { ok: true, revoked: true };
  await store.setJSON(tokenKey(hash), {
    ...record,
    revokedAt: new Date().toISOString(),
  });
  return { ok: true, revoked: true };
}

async function loadTechQuickOpsToken(rawToken) {
  const token = String(rawToken || '').trim();
  if (!looksLikeTechToken(token)) {
    return { ok: false, error: 'invalid', statusCode: 400 };
  }
  let record = null;
  try {
    const store = await resolveTokenStore();
    record = await readJson(store, tokenKey(hashToken(token)));
  } catch {
    return { ok: false, error: 'store_unavailable', statusCode: 503 };
  }
  if (!record || record.purpose !== PURPOSE_TECH_QUICK_OPS || record.audience !== PURPOSE_TECH_QUICK_OPS) {
    return { ok: false, error: 'invalid', statusCode: 400 };
  }
  if (record.revokedAt || !envBindingMatches(record) || Date.parse(record.expiresAt) <= Date.now()) {
    return { ok: false, error: 'invalid', statusCode: 400 };
  }
  return {
    ok: true,
    bookingId: record.bookingId,
    phoneE164: record.phoneE164,
    expiresAt: record.expiresAt,
    purpose: record.purpose,
  };
}

async function createTechQuickOpsSession({ bookingId, phoneE164 }) {
  const id = String(bookingId || '').trim();
  const phone = String(phoneE164 || '').trim();
  if (!id || !phone) return { ok: false, error: 'booking_required' };
  const sessionId = generateSessionId();
  const csrfToken = crypto.randomBytes(18).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  const record = {
    sessionIdHash: hashToken(sessionId),
    purpose: PURPOSE_TECH_QUICK_OPS,
    bookingId: id,
    phoneE164: phone,
    csrfToken,
    envBinding: currentEnvBinding(),
    createdAt: now.toISOString(),
    expiresAt,
  };
  const store = await resolveSessionStore();
  await store.setJSON(sessionKey(sessionId), record, { ttl: Math.ceil(SESSION_TTL_MS / 1000) });
  return { ok: true, sessionId, csrfToken, expiresAt, bookingId: id, phoneE164: phone };
}

function parseCookie(header, name) {
  const raw = String(header || '');
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('=') || '');
  }
  return '';
}

function sessionCookieHeader(sessionId, { secure = true } = {}) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function isLocalDev(event) {
  const host = String(event?.headers?.host || event?.headers?.Host || '').toLowerCase();
  return host.startsWith('localhost') || host.startsWith('127.0.0.1');
}

async function loadTechQuickOpsSession(event) {
  const header = event?.headers?.cookie || event?.headers?.Cookie || '';
  const sessionId = parseCookie(header, COOKIE_NAME);
  if (!sessionId.startsWith(SESSION_PREFIX)) {
    return { ok: false, error: 'no_session', statusCode: 401 };
  }
  let record = null;
  try {
    const store = await resolveSessionStore();
    record = await readJson(store, sessionKey(sessionId));
  } catch {
    return { ok: false, error: 'store_unavailable', statusCode: 503 };
  }
  if (!record || record.purpose !== PURPOSE_TECH_QUICK_OPS) {
    return { ok: false, error: 'no_session', statusCode: 401 };
  }
  if (!envBindingMatches(record) || Date.parse(record.expiresAt) <= Date.now()) {
    return { ok: false, error: 'expired', statusCode: 401 };
  }
  return {
    ok: true,
    bookingId: record.bookingId,
    phoneE164: record.phoneE164,
    csrfToken: record.csrfToken,
    expiresAt: record.expiresAt,
  };
}

function headerValue(event, name) {
  const want = String(name).toLowerCase();
  for (const [key, value] of Object.entries(event?.headers || {})) {
    if (String(key).toLowerCase() === want) return String(value || '');
  }
  return '';
}

function verifyTechQuickOpsCsrf(event, session) {
  const supplied = headerValue(event, 'x-tq-csrf') || '';
  if (!session?.csrfToken || !supplied) return false;
  const left = Buffer.from(String(session.csrfToken));
  const right = Buffer.from(String(supplied));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

module.exports = {
  TOKEN_PREFIX,
  SESSION_PREFIX,
  PURPOSE_TECH_QUICK_OPS,
  TOKEN_TTL_MS,
  SESSION_TTL_MS,
  COOKIE_NAME,
  looksLikeTechToken,
  buildTechOpsUrl,
  createTechQuickOpsToken,
  consumeTechQuickOpsToken,
  revokeTechQuickOpsToken,
  loadTechQuickOpsToken,
  createTechQuickOpsSession,
  loadTechQuickOpsSession,
  sessionCookieHeader,
  isLocalDev,
  verifyTechQuickOpsCsrf,
  setTechQuickOpsStoreFactories,
  resetTechQuickOpsStoreFactories,
};
