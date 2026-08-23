// Server-authoritative opaque appointment access tokens.
// Tokens are cryptographically random, stored hashed, time-limited, and
// consumable. Raw booking IDs / phones / emails / account IDs never appear in URLs.

'use strict';

const crypto = require('crypto');

const TOKEN_STORE = 'cd1-appointment-access-tokens';
const FOCUS_STORE = 'cd1-appointment-focus-refs';
const TOKEN_PREFIX = 'aat_';
const FOCUS_PREFIX = 'aptr_';
const ACCESS_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FOCUS_REF_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PURPOSE_APPOINTMENT_ACCESS = 'appointment_access';

let tokenStoreFactoryOverride = null;
let focusStoreFactoryOverride = null;

function tokenSecret() {
  const secret = String(
    process.env.CUSTOMER_SESSION_SECRET
    || process.env.DRAFT_TOKEN_SECRET
    || process.env.ADMIN_SESSION_SECRET
    || ''
  ).trim();
  if (!secret || secret.length < 16) throw new Error('missing_token_secret');
  return secret;
}

function hashToken(token) {
  return crypto.createHmac('sha256', tokenSecret()).update(String(token)).digest('hex');
}

function generateOpaqueToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

function generateFocusRef() {
  return FOCUS_PREFIX + crypto.randomBytes(18).toString('base64url');
}

async function resolveTokenStore() {
  if (typeof tokenStoreFactoryOverride === 'function') {
    return tokenStoreFactoryOverride(TOKEN_STORE);
  }
  const { blobsStore } = require('./tech-security');
  return blobsStore(TOKEN_STORE);
}

async function resolveFocusStore() {
  if (typeof focusStoreFactoryOverride === 'function') {
    return focusStoreFactoryOverride(FOCUS_STORE);
  }
  const { blobsStore } = require('./tech-security');
  return blobsStore(FOCUS_STORE);
}

function tokenKey(tokenHash) {
  return `tok_${String(tokenHash).slice(0, 32)}`;
}

function focusKey(focusRef) {
  return `focus_${String(focusRef).slice(0, 48)}`;
}

function bookingIndexKey(bookingId) {
  return `booking_${String(bookingId || '').trim()}`;
}

const CONSUME_RESULT = {
  CONSUMED_SUCCESSFULLY: 'consumed_successfully',
  ALREADY_CONSUMED: 'already_consumed',
  EXPIRED: 'expired',
  INVALID: 'invalid',
  STORAGE_UNAVAILABLE: 'storage_unavailable',
};

function siteBaseFromEnv(_event) {
  // Outbound customer links must never use request Host / X-Forwarded-Host.
  const { trustedSiteOrigin } = require('./trusted-site-origin');
  return trustedSiteOrigin();
}

function currentEnvBinding() {
  const { deployEnvironmentKey } = require('./trusted-site-origin');
  return deployEnvironmentKey();
}

/**
 * Tokens are bound to the issuing deploy environment. A branch-deploy token
 * must not authenticate through production (and vice versa), even when Blobs
 * are site-scoped. Binding is server-side only — never placed in public URLs.
 */
function envBindingMatches(record) {
  const expected = currentEnvBinding();
  const actual = String(record?.envBinding || '').trim();
  // Legacy records without binding: only acceptable in production (historical).
  if (!actual) {
    return expected === 'production';
  }
  return actual === expected;
}

function buildAccessUrl(token, _event) {
  const base = siteBaseFromEnv();
  return `${base}/a?t=${encodeURIComponent(token)}`;
}

/** Relative portal focus path — avoids open redirects / Host poisoning on exchange. */
function buildPortalFocusPath(focusRef) {
  return `/my-garage?appointment=${encodeURIComponent(focusRef)}`;
}

function buildPortalFocusUrl(focusRef, _event) {
  const base = siteBaseFromEnv();
  return `${base}${buildPortalFocusPath(focusRef)}`;
}

function writeWasApplied(result) {
  if (result == null) return true;
  return result.modified !== false;
}

async function readTokenWithEtag(store, key) {
  if (typeof store.getWithMetadata === 'function') {
    const result = await store.getWithMetadata(key, {
      type: 'json',
      consistency: 'strong',
    }).catch(() => null);
    if (!result || !result.data) return { record: null, etag: null, exists: false };
    return { record: result.data, etag: result.etag || null, exists: true };
  }
  const data = await store.get(key, { type: 'json' }).catch(() => null);
  if (!data) return { record: null, etag: null, exists: false };
  const etag = data.__etag || data._etag || null;
  return { record: data, etag, exists: true };
}

/**
 * Ensure booking has a durable opaque appointmentPublicRef (not the CD1 id).
 */
async function ensureAppointmentPublicRef(booking) {
  const existing = String(booking?.appointmentPublicRef || '').trim();
  if (existing.startsWith(FOCUS_PREFIX) && existing.length >= 20) {
    return { booking, focusRef: existing, created: false };
  }
  const focusRef = generateFocusRef();
  const next = {
    ...booking,
    appointmentPublicRef: focusRef,
    appointmentPublicRefAt: new Date().toISOString(),
  };
  try {
    const store = await resolveFocusStore();
    await store.setJSON(focusKey(focusRef), {
      focusRef,
      bookingId: String(booking.id || booking.bookingId || ''),
      customerAccountId: booking.customerAccountId || null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + FOCUS_REF_TTL_MS).toISOString(),
    }, { ttl: FOCUS_REF_TTL_MS });
  } catch {
    // Fail-open: ref still usable via booking.appointmentPublicRef once persisted by caller.
  }
  return { booking: next, focusRef, created: true };
}

async function resolveFocusRef(focusRef) {
  const ref = String(focusRef || '').trim();
  if (!ref.startsWith(FOCUS_PREFIX) || ref.length < 20) return null;
  try {
    const store = await resolveFocusStore();
    const record = await store.get(focusKey(ref), { type: 'json' }).catch(() => null);
    if (!record || String(record.focusRef) !== ref) return null;
    if (record.expiresAt && new Date(record.expiresAt).getTime() < Date.now()) return null;
    return {
      focusRef: ref,
      bookingId: String(record.bookingId || ''),
      customerAccountId: record.customerAccountId || null,
    };
  } catch {
    return null;
  }
}

async function indexTokenForBooking(store, bookingId, tokenHash) {
  const key = bookingIndexKey(bookingId);
  const existing = await store.get(key, { type: 'json' }).catch(() => null);
  const hashes = Array.isArray(existing?.tokenHashes) ? existing.tokenHashes.slice(-20) : [];
  if (!hashes.includes(tokenHash)) hashes.push(tokenHash);
  await store.setJSON(key, {
    bookingId: String(bookingId),
    tokenHashes: hashes,
    updatedAt: new Date().toISOString(),
  }, { ttl: ACCESS_TOKEN_TTL_MS * 2 });
}

/**
 * Create a new appointment access token for one booking + customer.
 * Supersedes prior active tokens for the same booking when supersede=true.
 */
async function createAppointmentAccessToken({
  bookingId,
  customerAccountId = null,
  email = null,
  phoneDigits = null,
  eventType = 'booking.request_received',
  purpose = PURPOSE_APPOINTMENT_ACCESS,
  ttlMs = ACCESS_TOKEN_TTL_MS,
  supersede = true,
  event = null,
} = {}) {
  const bid = String(bookingId || '').trim();
  if (!bid) throw new Error('booking_id_required');

  const store = await resolveTokenStore();
  if (supersede) {
    await revokeActiveTokensForBooking(bid, { store, reason: 'superseded' });
  }

  const token = generateOpaqueToken();
  const tokenHash = hashToken(token);
  const now = Date.now();
  const emailNorm = String(email || '').trim().toLowerCase() || null;
  const envBinding = currentEnvBinding();
  const record = {
    tokenHash,
    bookingId: bid,
    customerAccountId: customerAccountId ? String(customerAccountId) : null,
    emailHash: emailNorm
      ? crypto.createHash('sha256').update(emailNorm).digest('base64url')
      : null,
    phoneDigits: phoneDigits || null,
    purpose,
    eventType: String(eventType || ''),
    envBinding,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    consumedAt: null,
    revokedAt: null,
    revokeReason: null,
    uses: 0,
  };

  const key = tokenKey(tokenHash);
  const writeResult = typeof store.setJSON === 'function'
    ? await store.setJSON(key, { ...record, __etag: `v0:${record.createdAt}` }, {
      ttl: ttlMs,
      onlyIfNew: true,
    })
    : null;
  if (!writeWasApplied(writeResult)) {
    throw new Error('token_create_conflict');
  }
  await indexTokenForBooking(store, bid, tokenHash);

  return {
    token,
    tokenHash,
    expiresAt: record.expiresAt,
    accessUrl: buildAccessUrl(token, event),
    purpose,
    eventType: record.eventType,
    envBinding: record.envBinding,
  };
}

async function loadTokenRecord(rawToken, { allowExpired = false, allowConsumed = false } = {}) {
  const t = String(rawToken || '').trim();
  if (!t.startsWith(TOKEN_PREFIX) || t.length < 24) {
    return { ok: false, error: 'invalid_token', classification: CONSUME_RESULT.INVALID };
  }
  let tokenHash;
  try {
    tokenHash = hashToken(t);
  } catch {
    return { ok: false, error: 'invalid_token', classification: CONSUME_RESULT.INVALID };
  }

  const store = await resolveTokenStore();
  const { record } = await readTokenWithEtag(store, tokenKey(tokenHash));
  if (!record || record.tokenHash !== tokenHash) {
    return { ok: false, error: 'invalid_token', classification: CONSUME_RESULT.INVALID };
  }
  if (!envBindingMatches(record)) {
    return { ok: false, error: 'invalid_token', classification: CONSUME_RESULT.INVALID };
  }
  if (record.revokedAt) {
    return { ok: false, error: 'invalid_token', record, classification: CONSUME_RESULT.INVALID };
  }
  const expired = new Date(record.expiresAt).getTime() < Date.now();
  if (expired && !allowExpired) {
    return {
      ok: false,
      error: 'expired_token',
      record,
      expired: true,
      classification: CONSUME_RESULT.EXPIRED,
    };
  }
  if (record.consumedAt && !allowConsumed) {
    return {
      ok: false,
      error: 'consumed_token',
      record,
      consumed: true,
      classification: CONSUME_RESULT.ALREADY_CONSUMED,
    };
  }
  if (record.purpose !== PURPOSE_APPOINTMENT_ACCESS) {
    return { ok: false, error: 'invalid_token', record, classification: CONSUME_RESULT.INVALID };
  }
  return {
    ok: true,
    record,
    tokenHash,
    expired,
    consumed: !!record.consumedAt,
    classification: record.consumedAt
      ? CONSUME_RESULT.ALREADY_CONSUMED
      : CONSUME_RESULT.CONSUMED_SUCCESSFULLY,
  };
}

/**
 * Atomically consume an appointment access token using Blob CAS (onlyIfMatch).
 * At most one concurrent unauthenticated exchange may succeed.
 */
async function consumeAppointmentAccessToken(rawToken) {
  const t = String(rawToken || '').trim();
  if (!t.startsWith(TOKEN_PREFIX) || t.length < 24) {
    return { ok: false, error: 'invalid_token', classification: CONSUME_RESULT.INVALID };
  }

  let tokenHash;
  try {
    tokenHash = hashToken(t);
  } catch {
    return { ok: false, error: 'invalid_token', classification: CONSUME_RESULT.INVALID };
  }

  let store;
  try {
    store = await resolveTokenStore();
  } catch {
    return {
      ok: false,
      error: 'storage_unavailable',
      classification: CONSUME_RESULT.STORAGE_UNAVAILABLE,
    };
  }

  const key = tokenKey(tokenHash);
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let read;
    try {
      read = await readTokenWithEtag(store, key);
    } catch {
      return {
        ok: false,
        error: 'storage_unavailable',
        classification: CONSUME_RESULT.STORAGE_UNAVAILABLE,
      };
    }

    if (!read.exists || !read.record || read.record.tokenHash !== tokenHash) {
      return { ok: false, error: 'invalid_token', classification: CONSUME_RESULT.INVALID };
    }
    const record = read.record;
    if (!envBindingMatches(record)) {
      return { ok: false, error: 'invalid_token', classification: CONSUME_RESULT.INVALID };
    }
    if (record.revokedAt || record.purpose !== PURPOSE_APPOINTMENT_ACCESS) {
      return {
        ok: false,
        error: 'invalid_token',
        record,
        classification: CONSUME_RESULT.INVALID,
      };
    }
    if (new Date(record.expiresAt).getTime() < Date.now()) {
      return {
        ok: false,
        error: 'expired_token',
        record,
        expired: true,
        classification: CONSUME_RESULT.EXPIRED,
      };
    }
    if (record.consumedAt) {
      return {
        ok: false,
        error: 'consumed_token',
        record,
        consumed: true,
        classification: CONSUME_RESULT.ALREADY_CONSUMED,
      };
    }

    // CAS precondition required — never unconditional read-then-write.
    if (!read.etag && typeof store.getWithMetadata === 'function') {
      return {
        ok: false,
        error: 'storage_unavailable',
        classification: CONSUME_RESULT.STORAGE_UNAVAILABLE,
      };
    }
    if (!read.etag && typeof store.getWithMetadata !== 'function') {
      // Test/memory adapters without metadata: synthesize etag from record.
      read.etag = record.__etag || record._etag || `v${Number(record.uses) || 0}:${record.createdAt}`;
    }

    const next = {
      ...record,
      consumedAt: new Date().toISOString(),
      uses: (Number(record.uses) || 0) + 1,
      __etag: `consumed:${Date.now()}`,
    };
    const remainingMs = Math.max(60_000, new Date(next.expiresAt).getTime() - Date.now());

    let writeResult;
    try {
      writeResult = await store.setJSON(key, next, {
        ttl: remainingMs,
        onlyIfMatch: read.etag,
      });
    } catch {
      return {
        ok: false,
        error: 'storage_unavailable',
        classification: CONSUME_RESULT.STORAGE_UNAVAILABLE,
      };
    }

    if (writeWasApplied(writeResult)) {
      return {
        ok: true,
        record: next,
        classification: CONSUME_RESULT.CONSUMED_SUCCESSFULLY,
      };
    }
    // Lost CAS race — loop to classify winner state (already_consumed / etc).
  }

  const finalRead = await readTokenWithEtag(store, key).catch(() => null);
  if (finalRead?.record?.consumedAt) {
    return {
      ok: false,
      error: 'consumed_token',
      record: finalRead.record,
      consumed: true,
      classification: CONSUME_RESULT.ALREADY_CONSUMED,
    };
  }
  return {
    ok: false,
    error: 'storage_unavailable',
    classification: CONSUME_RESULT.STORAGE_UNAVAILABLE,
  };
}

async function revokeActiveTokensForBooking(bookingId, { store: storeArg = null, reason = 'revoked' } = {}) {
  const store = storeArg || await resolveTokenStore();
  const index = await store.get(bookingIndexKey(bookingId), { type: 'json' }).catch(() => null);
  const hashes = Array.isArray(index?.tokenHashes) ? index.tokenHashes : [];
  const now = new Date().toISOString();
  for (const h of hashes) {
    const rec = await store.get(tokenKey(h), { type: 'json' }).catch(() => null);
    if (!rec || rec.revokedAt || rec.consumedAt) continue;
    await store.setJSON(tokenKey(h), {
      ...rec,
      revokedAt: now,
      revokeReason: reason,
    }).catch(() => {});
  }
  return { ok: true, revoked: hashes.length };
}

/**
 * Resend: revoke prior active tokens and mint a new one for the same booking.
 * Callers must already have authorized ownership (via expired token or admin).
 */
async function resendAppointmentAccessToken(opts) {
  return createAppointmentAccessToken({ ...opts, supersede: true });
}

function setAppointmentAccessStoreFactories({ tokenStore, focusStore } = {}) {
  tokenStoreFactoryOverride = typeof tokenStore === 'function' ? tokenStore : null;
  focusStoreFactoryOverride = typeof focusStore === 'function' ? focusStore : null;
}

function resetAppointmentAccessStoreFactories() {
  tokenStoreFactoryOverride = null;
  focusStoreFactoryOverride = null;
}

module.exports = {
  TOKEN_STORE,
  FOCUS_STORE,
  TOKEN_PREFIX,
  FOCUS_PREFIX,
  ACCESS_TOKEN_TTL_MS,
  FOCUS_REF_TTL_MS,
  PURPOSE_APPOINTMENT_ACCESS,
  CONSUME_RESULT,
  currentEnvBinding,
  envBindingMatches,
  hashToken,
  generateOpaqueToken,
  generateFocusRef,
  buildAccessUrl,
  buildPortalFocusPath,
  buildPortalFocusUrl,
  ensureAppointmentPublicRef,
  resolveFocusRef,
  createAppointmentAccessToken,
  loadTokenRecord,
  consumeAppointmentAccessToken,
  revokeActiveTokensForBooking,
  resendAppointmentAccessToken,
  setAppointmentAccessStoreFactories,
  resetAppointmentAccessStoreFactories,
  siteBaseFromEnv,
};
