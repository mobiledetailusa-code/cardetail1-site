'use strict';

/**
 * Booking + quoteVersion scoped payment resume tokens.
 * Purpose is customer_balance only. Never interchangeable with /a?t= or Quick Ops.
 */

const crypto = require('crypto');

const TOKEN_STORE = 'cd1-payment-resume-tokens';
const TOKEN_PREFIX = 'prt_';
const PURPOSE_CUSTOMER_BALANCE = 'customer_balance';
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let tokenStoreFactoryOverride = null;

function tokenSecret() {
  const secret = String(
    process.env.PAYMENT_RESUME_SECRET
    || process.env.CUSTOMER_SESSION_SECRET
    || process.env.DRAFT_TOKEN_SECRET
    || ''
  ).trim();
  if (!secret || secret.length < 16) throw new Error('missing_payment_resume_secret');
  return secret;
}

function hashToken(value) {
  return crypto.createHmac('sha256', tokenSecret()).update(String(value)).digest('hex');
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

function buildPayUrl(token) {
  return `${siteBase()}/pay/${encodeURIComponent(token)}`;
}

function tokenKey(tokenHash) {
  return `tok_${String(tokenHash).slice(0, 32)}`;
}

function deriveOpaqueToken(bookingId, quoteVersion) {
  const digest = crypto.createHmac('sha256', tokenSecret())
    .update(`${PURPOSE_CUSTOMER_BALANCE}|${String(bookingId || '').trim()}|${Number(quoteVersion) || 0}|${currentEnvBinding()}`)
    .digest();
  return TOKEN_PREFIX + digest.toString('base64url');
}

async function resolveTokenStore() {
  if (typeof tokenStoreFactoryOverride === 'function') {
    return tokenStoreFactoryOverride(TOKEN_STORE);
  }
  const { blobsStore } = require('./tech-security');
  return blobsStore(TOKEN_STORE);
}

function setPaymentResumeStoreFactory(factory) {
  tokenStoreFactoryOverride = typeof factory === 'function' ? factory : null;
}

function resetPaymentResumeStoreFactory() {
  tokenStoreFactoryOverride = null;
}

async function readJson(store, key) {
  if (typeof store.getWithMetadata === 'function') {
    const result = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' }).catch(() => null);
    if (!result || !result.data) return null;
    return result.data;
  }
  return store.get(key, { type: 'json' }).catch(() => null);
}

function looksLikePayToken(raw) {
  const token = String(raw || '').trim();
  return token.startsWith(TOKEN_PREFIX) && token.length >= 20;
}

async function createPaymentResumeToken({ bookingId, quoteVersion, ttlMs = TOKEN_TTL_MS } = {}) {
  const id = String(bookingId || '').trim();
  const qv = Math.max(0, Math.round(Number(quoteVersion) || 0));
  if (!id) return { ok: false, error: 'booking_required' };
  const token = deriveOpaqueToken(id, qv);
  const tokenHash = hashToken(token);
  const store = await resolveTokenStore();
  const existing = await readJson(store, tokenKey(tokenHash));
  const now = new Date();
  if (
    existing
    && existing.purpose === PURPOSE_CUSTOMER_BALANCE
    && existing.bookingId === id
    && Number(existing.quoteVersion) === qv
    && envBindingMatches(existing)
    && Date.parse(existing.expiresAt) > Date.now()
  ) {
    return {
      ok: true,
      token,
      payUrl: buildPayUrl(token),
      expiresAt: existing.expiresAt,
      reused: true,
      bookingId: id,
      quoteVersion: qv,
    };
  }
  const expiresAt = new Date(now.getTime() + Math.max(60_000, Number(ttlMs) || TOKEN_TTL_MS)).toISOString();
  const record = {
    tokenHash,
    purpose: PURPOSE_CUSTOMER_BALANCE,
    audience: 'customer_payment',
    bookingId: id,
    quoteVersion: qv,
    envBinding: currentEnvBinding(),
    createdAt: existing?.createdAt || now.toISOString(),
    expiresAt,
  };
  await store.setJSON(tokenKey(tokenHash), record, {
    ttl: Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000),
  });
  return {
    ok: true,
    token,
    payUrl: buildPayUrl(token),
    expiresAt,
    reused: false,
    bookingId: id,
    quoteVersion: qv,
  };
}

async function loadPaymentResumeToken(rawToken) {
  const token = String(rawToken || '').trim();
  if (!looksLikePayToken(token)) {
    return { ok: false, error: 'invalid', statusCode: 400 };
  }
  let record = null;
  try {
    const store = await resolveTokenStore();
    record = await readJson(store, tokenKey(hashToken(token)));
  } catch {
    return { ok: false, error: 'store_unavailable', statusCode: 503 };
  }
  if (!record || record.purpose !== PURPOSE_CUSTOMER_BALANCE) {
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
    quoteVersion: Math.max(0, Math.round(Number(record.quoteVersion) || 0)),
    expiresAt: record.expiresAt,
    purpose: record.purpose,
  };
}

module.exports = {
  TOKEN_PREFIX,
  PURPOSE_CUSTOMER_BALANCE,
  TOKEN_TTL_MS,
  looksLikePayToken,
  buildPayUrl,
  createPaymentResumeToken,
  loadPaymentResumeToken,
  setPaymentResumeStoreFactory,
  resetPaymentResumeStoreFactory,
};
