'use strict';

/**
 * Booking-scoped Admin Quick Ops tokens and short sessions.
 * Purpose is admin_quick_ops only — never interchangeable with /a?t= or /pay.
 * Raw tokens are never stored. GET may mint a session; it must not mutate bookings.
 */

const crypto = require('crypto');

const TOKEN_STORE = 'cd1-admin-quick-ops-tokens';
const SESSION_STORE = 'cd1-admin-quick-ops-sessions';
const TOKEN_PREFIX = 'qot_';
const SESSION_PREFIX = 'qos_';
const PURPOSE_ADMIN_QUICK_OPS = 'admin_quick_ops';
const TOKEN_TTL_MS = 48 * 60 * 60 * 1000;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const COOKIE_NAME = 'cd1_qo_session';

let tokenStoreFactoryOverride = null;
let sessionStoreFactoryOverride = null;

function tokenSecret() {
  const secret = String(
    process.env.ADMIN_QUICK_OPS_SECRET
    || process.env.CUSTOMER_SESSION_SECRET
    || process.env.DRAFT_TOKEN_SECRET
    || ''
  ).trim();
  if (!secret || secret.length < 16) throw new Error('missing_quick_ops_secret');
  return secret;
}

function hashToken(value) {
  return crypto.createHmac('sha256', tokenSecret()).update(String(value)).digest('hex');
}

function deriveOpaqueToken(bookingId) {
  const digest = crypto.createHmac('sha256', tokenSecret())
    .update(`${PURPOSE_ADMIN_QUICK_OPS}|${String(bookingId || '').trim()}|${currentEnvBinding()}`)
    .digest();
  return TOKEN_PREFIX + digest.toString('base64url');
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

function buildOpsUrl(token) {
  return `${siteBase()}/ops/q/${encodeURIComponent(token)}`;
}

function tokenKey(tokenHash) {
  return `tok_${String(tokenHash).slice(0, 32)}`;
}

function bookingIndexKey(bookingId) {
  return `booking_${String(bookingId || '').trim()}`;
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

function setQuickOpsStoreFactories({ tokenStore, sessionStore } = {}) {
  tokenStoreFactoryOverride = typeof tokenStore === 'function' ? tokenStore : null;
  sessionStoreFactoryOverride = typeof sessionStore === 'function' ? sessionStore : null;
}

function resetQuickOpsStoreFactories() {
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

function looksLikeToken(raw) {
  const token = String(raw || '').trim();
  return token.startsWith(TOKEN_PREFIX) && token.length >= 20;
}

async function createQuickOpsToken({ bookingId, ttlMs = TOKEN_TTL_MS } = {}) {
  const id = String(bookingId || '').trim();
  if (!id) return { ok: false, error: 'booking_required' };
  const token = deriveOpaqueToken(id);
  const tokenHash = hashToken(token);
  const store = await resolveTokenStore();
  const existing = await readJson(store, tokenKey(tokenHash));
  const now = new Date();
  if (
    existing
    && existing.purpose === PURPOSE_ADMIN_QUICK_OPS
    && existing.bookingId === id
    && envBindingMatches(existing)
    && Date.parse(existing.expiresAt) > Date.now()
  ) {
    return {
      ok: true,
      token,
      opsUrl: buildOpsUrl(token),
      expiresAt: existing.expiresAt,
      reused: true,
      bookingId: id,
    };
  }
  const expiresAt = new Date(now.getTime() + Math.max(60_000, Number(ttlMs) || TOKEN_TTL_MS)).toISOString();
  const record = {
    tokenHash,
    purpose: PURPOSE_ADMIN_QUICK_OPS,
    audience: PURPOSE_ADMIN_QUICK_OPS,
    bookingId: id,
    envBinding: currentEnvBinding(),
    createdAt: existing?.createdAt || now.toISOString(),
    expiresAt,
  };
  const ttlSec = Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000);
  await store.setJSON(tokenKey(tokenHash), record, { ttl: ttlSec });
  await store.setJSON(bookingIndexKey(id), {
    bookingId: id,
    tokenHash,
    expiresAt,
    updatedAt: now.toISOString(),
  }, { ttl: ttlSec });
  return {
    ok: true,
    token,
    opsUrl: buildOpsUrl(token),
    expiresAt,
    reused: false,
    bookingId: id,
  };
}

async function loadQuickOpsToken(rawToken) {
  const token = String(rawToken || '').trim();
  if (!looksLikeToken(token)) {
    return { ok: false, error: 'invalid', statusCode: 400 };
  }
  let record = null;
  try {
    const store = await resolveTokenStore();
    record = await readJson(store, tokenKey(hashToken(token)));
  } catch {
    return { ok: false, error: 'store_unavailable', statusCode: 503 };
  }
  if (!record || record.purpose !== PURPOSE_ADMIN_QUICK_OPS || record.audience !== PURPOSE_ADMIN_QUICK_OPS) {
    return { ok: false, error: 'invalid', statusCode: 400 };
  }
  if (!envBindingMatches(record)) {
    return { ok: false, error: 'invalid', statusCode: 400 };
  }
  if (Date.parse(record.expiresAt) <= Date.now()) {
    return { ok: false, error: 'expired', statusCode: 410 };
  }
  return {
    ok: true,
    bookingId: record.bookingId,
    expiresAt: record.expiresAt,
    purpose: record.purpose,
  };
}

async function createQuickOpsSession({ bookingId }) {
  const id = String(bookingId || '').trim();
  if (!id) return { ok: false, error: 'booking_required' };
  const sessionId = generateSessionId();
  const csrfToken = crypto.randomBytes(18).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  const record = {
    sessionIdHash: hashToken(sessionId),
    purpose: PURPOSE_ADMIN_QUICK_OPS,
    bookingId: id,
    csrfToken,
    envBinding: currentEnvBinding(),
    createdAt: now.toISOString(),
    expiresAt,
  };
  const store = await resolveSessionStore();
  await store.setJSON(sessionKey(sessionId), record, { ttl: Math.ceil(SESSION_TTL_MS / 1000) });
  return { ok: true, sessionId, csrfToken, expiresAt, bookingId: id };
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

async function loadQuickOpsSession(event) {
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
  if (!record || record.purpose !== PURPOSE_ADMIN_QUICK_OPS) {
    return { ok: false, error: 'no_session', statusCode: 401 };
  }
  if (!envBindingMatches(record) || Date.parse(record.expiresAt) <= Date.now()) {
    return { ok: false, error: 'expired', statusCode: 401 };
  }
  return {
    ok: true,
    bookingId: record.bookingId,
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

function verifyQuickOpsCsrf(event, session) {
  const supplied = headerValue(event, 'x-qo-csrf') || '';
  if (!session?.csrfToken || !supplied) return false;
  const left = Buffer.from(String(session.csrfToken));
  const right = Buffer.from(String(supplied));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function mintQuickOpsUrl(bookingId) {
  try {
    const minted = await createQuickOpsToken({ bookingId });
    return minted.ok ? minted.opsUrl : '';
  } catch {
    return '';
  }
}

/**
 * Admin-email footer only. Never attach this to customer mail — customer
 * messages keep /a?t=. Fail-open: a mint miss still sends the original body.
 */
async function appendAdminOpsEmailLink(text, bookingId) {
  const body = String(text || '');
  const id = String(bookingId || '').trim();
  if (!id) return body;
  if (/\/ops\/q\//i.test(body)) return body;
  const url = await mintQuickOpsUrl(id);
  if (!url) return body;
  return `${body.replace(/\s+$/, '')}\n\nQuick Ops (admin only):\n${url}\n`;
}

module.exports = {
  TOKEN_PREFIX,
  SESSION_PREFIX,
  PURPOSE_ADMIN_QUICK_OPS,
  TOKEN_TTL_MS,
  SESSION_TTL_MS,
  COOKIE_NAME,
  hashToken,
  buildOpsUrl,
  looksLikeToken,
  createQuickOpsToken,
  loadQuickOpsToken,
  createQuickOpsSession,
  loadQuickOpsSession,
  sessionCookieHeader,
  isLocalDev,
  verifyQuickOpsCsrf,
  mintQuickOpsUrl,
  appendAdminOpsEmailLink,
  setQuickOpsStoreFactories,
  resetQuickOpsStoreFactories,
};
