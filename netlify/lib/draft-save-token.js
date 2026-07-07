// Stateless HMAC draft ownership tokens for create-setup-intent possession checks.
const crypto = require('crypto');
const { normalizePhone } = require('./ops-db');

const TOKEN_PREFIX = 'v1.';
const TOKEN_VERSION = 'v1';
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const MIN_SECRET_LEN = 32;
const MAX_FUTURE_SKEW_MS = 60 * 1000;

let devFallbackWarned = false;

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

function phoneSigningKey(phone) {
  const digits = normalizePhone(phone);
  if (!digits || digits.length < 7) return '';
  return digits.slice(-10);
}

function getDraftTokenSecretStatus() {
  const primary = normalizeEnvValue(process.env.DRAFT_TOKEN_SECRET);

  if (isProductionRuntime()) {
    if (!primary || primary.length < MIN_SECRET_LEN) {
      return { ok: false, error: 'missing_draft_token_secret' };
    }
    return { ok: true, secret: primary };
  }

  if (primary && primary.length >= MIN_SECRET_LEN) {
    return { ok: true, secret: primary };
  }

  const fallback = normalizeEnvValue(process.env.ADMIN_SESSION_SECRET);
  if (fallback && fallback.length >= MIN_SECRET_LEN) {
    if (!devFallbackWarned) {
      devFallbackWarned = true;
      console.warn(
        '[draft-save-token] DRAFT_TOKEN_SECRET not set; using ADMIN_SESSION_SECRET fallback in dev/preview only. Configure DRAFT_TOKEN_SECRET (32+ chars) for production.'
      );
    }
    return { ok: true, secret: fallback, usedFallback: true };
  }

  return { ok: false, error: 'missing_draft_token_secret' };
}

function draftTokenSecret() {
  const status = getDraftTokenSecretStatus();
  return status.ok ? status.secret : '';
}

function signingPayload({ bookingId, phone, expiryUnixSeconds }) {
  const phoneKey = phoneSigningKey(phone);
  return `${TOKEN_VERSION}|${String(bookingId || '').trim()}|${phoneKey}|${expiryUnixSeconds}`;
}

function signPayload(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function timingSafeString(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function issueDraftSaveToken({ bookingId, phone, now = Date.now() }) {
  const status = getDraftTokenSecretStatus();
  if (!status.ok) return status;

  const id = String(bookingId || '').trim();
  const phoneKey = phoneSigningKey(phone);
  if (!id || !phoneKey) {
    return { ok: false, error: 'invalid_draft_token_inputs' };
  }

  const expiryUnixSeconds = Math.floor((now + TOKEN_TTL_MS) / 1000);
  const payload = signingPayload({ bookingId: id, phone, expiryUnixSeconds });
  const signature = signPayload(payload, status.secret);

  return {
    ok: true,
    token: `${TOKEN_PREFIX}${expiryUnixSeconds}.${signature}`,
    draftSaveTokenExp: expiryUnixSeconds,
  };
}

function verifyDraftSaveToken({ token, bookingId, phone, now = Date.now() }) {
  const status = getDraftTokenSecretStatus();
  if (!status.ok) return { ok: false, error: status.error };

  const raw = String(token || '').trim();
  if (!raw.startsWith(TOKEN_PREFIX)) {
    return { ok: false, error: 'invalid_draft_token' };
  }

  const body = raw.slice(TOKEN_PREFIX.length);
  const dot = body.indexOf('.');
  if (dot <= 0) return { ok: false, error: 'invalid_draft_token' };

  const version = TOKEN_PREFIX.slice(0, -1);
  if (version !== TOKEN_VERSION) {
    return { ok: false, error: 'invalid_draft_token' };
  }

  const expiryUnixSeconds = Number(body.slice(0, dot));
  const signature = body.slice(dot + 1);
  if (!Number.isFinite(expiryUnixSeconds) || !signature) {
    return { ok: false, error: 'invalid_draft_token' };
  }

  const nowSec = Math.floor(now / 1000);
  if (expiryUnixSeconds < nowSec) {
    return { ok: false, error: 'invalid_draft_token' };
  }

  const maxExpirySec = Math.floor((now + TOKEN_TTL_MS + MAX_FUTURE_SKEW_MS) / 1000);
  if (expiryUnixSeconds > maxExpirySec) {
    return { ok: false, error: 'invalid_draft_token' };
  }

  const id = String(bookingId || '').trim();
  const phoneKey = phoneSigningKey(phone);
  if (!id || !phoneKey) {
    return { ok: false, error: 'invalid_draft_token' };
  }

  const payload = signingPayload({ bookingId: id, phone, expiryUnixSeconds });
  const expected = signPayload(payload, status.secret);
  if (!timingSafeString(signature, expected)) {
    return { ok: false, error: 'invalid_draft_token' };
  }

  return { ok: true, expiryUnixSeconds };
}

module.exports = {
  TOKEN_PREFIX,
  TOKEN_VERSION,
  TOKEN_TTL_MS,
  MIN_SECRET_LEN,
  isProductionRuntime,
  isDevOrPreviewRuntime,
  getDraftTokenSecretStatus,
  draftTokenSecret,
  phoneSigningKey,
  issueDraftSaveToken,
  verifyDraftSaveToken,
  signingPayload,
};
