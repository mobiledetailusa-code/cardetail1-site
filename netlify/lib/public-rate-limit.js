// Application-level IP rate limiting for public Netlify Functions.
// Not a substitute for edge WAF/DDoS protection. Blobs outage → fail-open.
//
// IP trust: relies on Netlify/platform headers (x-forwarded-for,
// x-nf-client-connection-ip, client-ip) as populated by the hosting edge.
//
// Privacy: no raw IP addresses, customer data, request bodies, phone numbers,
// emails, booking data, or card data are stored. Only deterministic pseudonymous
// rate-limit identifiers are persisted.
const crypto = require('crypto');
const { clientIp } = require('./admin-security');

const PUBLIC_RATE_STORE = 'cd1-public-rate-limit';
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const STRONG_CONSISTENCY = 'strong';
const MAX_WRITE_RETRIES = 4;
const ENV_MAX_MIN = 1;
const ENV_MAX_MAX = 10_000;
const ENV_WINDOW_SEC_MIN = 60;
const ENV_WINDOW_SEC_MAX = 86_400;

/** @type {Record<string, { max: number, windowMs: number }>} */
const DEFAULT_LIMITS = {
  'submit-booking:draft': { max: 15, windowMs: DEFAULT_WINDOW_MS },
  'submit-booking:finalize': { max: 8, windowMs: DEFAULT_WINDOW_MS },
  'lookup-booking': { max: 20, windowMs: DEFAULT_WINDOW_MS },
  'create-setup-intent': { max: 10, windowMs: DEFAULT_WINDOW_MS },
  'submit-inquiry': { max: 10, windowMs: DEFAULT_WINDOW_MS },
  'ai-chat': { max: 30, windowMs: DEFAULT_WINDOW_MS },
  'revenue-event:track': { max: 120, windowMs: DEFAULT_WINDOW_MS },
  'garage-plan-submit:submit': { max: 10, windowMs: DEFAULT_WINDOW_MS },
  'revenue-resume-link:validate': { max: 20, windowMs: DEFAULT_WINDOW_MS },
  'submit-customer-action': { max: 12, windowMs: DEFAULT_WINDOW_MS },
  'request-cancellation': { max: 8, windowMs: DEFAULT_WINDOW_MS },
  'customer-portal-auth:start': { max: 8, windowMs: DEFAULT_WINDOW_MS },
  'customer-portal-auth:verify': { max: 12, windowMs: DEFAULT_WINDOW_MS },
  'booking-card-status': { max: 40, windowMs: DEFAULT_WINDOW_MS },
};

const ENV_SCOPE_BY_BUCKET = {
  'submit-booking:draft': 'SUBMIT_BOOKING_DRAFT',
  'submit-booking:finalize': 'SUBMIT_BOOKING_FINALIZE',
  'lookup-booking': 'LOOKUP_BOOKING',
  'create-setup-intent': 'CREATE_SETUP_INTENT',
  'submit-inquiry': 'SUBMIT_INQUIRY',
  'ai-chat': 'AI_CHAT',
  'revenue-event:track': 'REVENUE_EVENT',
  'garage-plan-submit:submit': 'GARAGE_PLAN_SUBMIT',
  'revenue-resume-link:validate': 'REVENUE_RESUME_LINK',
  'submit-customer-action': 'SUBMIT_CUSTOMER_ACTION',
  'request-cancellation': 'REQUEST_CANCELLATION',
  'customer-portal-auth:start': 'CUSTOMER_PORTAL_AUTH_START',
  'customer-portal-auth:verify': 'CUSTOMER_PORTAL_AUTH_VERIFY',
  'booking-card-status': 'BOOKING_CARD_STATUS',
};

let storeFactoryOverride = null;

function isOptionsRequest(event) {
  return String(event && event.httpMethod || '').toUpperCase() === 'OPTIONS';
}

function normalizeClientIp(event) {
  const raw = clientIp(event);
  if (!raw || raw === 'unknown') return null;
  const trimmed = String(raw).trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.startsWith('::ffff:')) return trimmed.slice(7);
  return trimmed;
}

function bucketName(endpoint, action) {
  const ep = String(endpoint || '').trim();
  const act = String(action || '').trim();
  return act ? `${ep}:${act}` : ep;
}

function parseEnvPositiveInt(raw, { min, max, fallback }) {
  const text = String(raw ?? '').trim();
  if (!text) return fallback;
  const n = Number(text);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function getLimitConfig(endpoint, action) {
  const bucket = bucketName(endpoint, action);
  const defaults = DEFAULT_LIMITS[bucket];
  if (!defaults) {
    return { max: 60, windowMs: DEFAULT_WINDOW_MS, bucket };
  }

  const scope = ENV_SCOPE_BY_BUCKET[bucket] || bucket.replace(/[^a-z0-9]+/gi, '_').toUpperCase();
  const max = parseEnvPositiveInt(process.env[`PUBLIC_RATE_LIMIT_${scope}_MAX`], {
    min: ENV_MAX_MIN,
    max: ENV_MAX_MAX,
    fallback: defaults.max,
  });
  const windowSec = parseEnvPositiveInt(process.env[`PUBLIC_RATE_LIMIT_${scope}_WINDOW_SEC`], {
    min: ENV_WINDOW_SEC_MIN,
    max: ENV_WINDOW_SEC_MAX,
    fallback: Math.floor(defaults.windowMs / 1000),
  });

  return {
    max,
    windowMs: windowSec * 1000,
    bucket,
  };
}

function rateLimitNamespace(env = process.env) {
  const context = String(env.CONTEXT || 'dev').trim().toLowerCase();

  if (context === 'production') {
    return 'production';
  }

  const deployIdentity =
    env.DEPLOY_ID ||
    env.COMMIT_REF ||
    env.BRANCH ||
    'local';

  return `${context}:${deployIdentity}`;
}

function deriveRateLimitKey(normalizedIp, endpoint, action, env = process.env) {
  const namespace = rateLimitNamespace(env);
  const ep = String(endpoint || '').trim();
  const act = String(action || '').trim();
  const digest = crypto
    .createHash('sha256')
    .update(`${namespace}|${normalizedIp}|${ep}|${act}`)
    .digest('hex');
  return `rl-${digest.slice(0, 40)}`;
}

async function defaultBlobsStore(name) {
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  const opts = { name, consistency: STRONG_CONSISTENCY };
  if (siteID && token) {
    opts.siteID = siteID;
    opts.token = token;
  }
  return getStore(opts);
}

async function resolveStore() {
  if (typeof storeFactoryOverride === 'function') {
    return storeFactoryOverride(PUBLIC_RATE_STORE);
  }
  return defaultBlobsStore(PUBLIC_RATE_STORE);
}

function identifySubmitBookingAction(body) {
  if (!body || typeof body !== 'object') return 'finalize';
  if (body.isDraft) return 'draft';
  return 'finalize';
}

function buildRateLimitedResponse(retryAfterSec, { cors = false } = {}) {
  const sec = Math.max(1, Math.ceil(Number(retryAfterSec) || 1));
  const body = { ok: false, error: 'rate_limited', retryAfterSec: sec };
  const headers = {
    'Content-Type': 'application/json',
    'Retry-After': String(sec),
    'Cache-Control': 'no-store',
  };
  if (cors) {
    headers['Access-Control-Allow-Origin'] = '*';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, x-admin-key, x-tech-token';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
  }
  return { statusCode: 429, headers, body: JSON.stringify(body) };
}

function retryJitterMs() {
  return 5 + Math.floor(Math.random() * 20);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function effectiveCounterState(record, now, windowMs) {
  let count = record.count;
  let windowStart = record.windowStart || now;
  if (!record.exists || now - windowStart >= windowMs) {
    count = 0;
    windowStart = now;
  }
  return { count, windowStart };
}

async function readCounter(store, key, now) {
  const result = await store.getWithMetadata(key, {
    type: 'json',
    consistency: STRONG_CONSISTENCY,
  }).catch(() => null);

  if (!result) {
    return { exists: false, count: 0, windowStart: now, etag: null };
  }

  const data = result.data && typeof result.data === 'object' ? result.data : {};
  return {
    exists: true,
    count: Number(data.count) || 0,
    windowStart: Number(data.windowStart) || now,
    etag: result.etag || null,
  };
}

async function conditionalWrite(store, key, value, { exists, etag }) {
  if (!exists) {
    return store.setJSON(key, value, { onlyIfNew: true });
  }
  if (!etag) {
    throw new Error('missing_counter_etag');
  }
  return store.setJSON(key, value, { onlyIfMatch: etag });
}

function writeWasApplied(result) {
  if (result == null) return true;
  return result.modified !== false;
}

async function incrementCounterAtomically(store, key, { max, windowMs, bucket, now }) {
  for (let attempt = 1; attempt <= MAX_WRITE_RETRIES; attempt += 1) {
    if (attempt > 1) {
      await sleep(retryJitterMs());
    }

    const record = await readCounter(store, key, now);
    const { count, windowStart } = effectiveCounterState(record, now, windowMs);

    if (count >= max) {
      const retryAfterSec = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
      return { allowed: false, retryAfterSec, remaining: 0, bucket, key };
    }

    const nextValue = {
      count: count + 1,
      windowStart,
      bucket,
      expiresAt: windowStart + windowMs,
    };

    const writeResult = await conditionalWrite(store, key, nextValue, {
      exists: record.exists,
      etag: record.etag,
    });

    if (writeWasApplied(writeResult)) {
      return {
        allowed: true,
        remaining: Math.max(0, max - nextValue.count),
        bucket,
        key,
      };
    }
  }

  console.warn('[public-rate-limit] conditional write retries exhausted; allowing request (fail-open)');
  return { allowed: true, failOpen: true, reason: 'retry_exhausted' };
}

function failOpenDecision(reason, err) {
  const detail = err && err.message ? err.message : reason;
  console.warn(`[public-rate-limit] ${reason}; allowing request (fail-open):`, detail);
  return { allowed: true, failOpen: true, reason };
}

/**
 * @returns {Promise<{ allowed: boolean, remaining?: number, retryAfterSec?: number, failOpen?: boolean, reason?: string }>}
 */
async function checkPublicRateLimit(event, { endpoint, action = '', now = Date.now() } = {}) {
  if (isOptionsRequest(event)) {
    return { allowed: true, bypassed: true };
  }

  const normalizedIp = normalizeClientIp(event);
  if (!normalizedIp) {
    return failOpenDecision(
      'missing_client_ip',
      new Error('No trusted client IP in platform headers')
    );
  }

  const { max, windowMs, bucket } = getLimitConfig(endpoint, action);
  const key = deriveRateLimitKey(normalizedIp, endpoint, action);

  try {
    const store = await resolveStore();
    return await incrementCounterAtomically(store, key, { max, windowMs, bucket, now });
  } catch (err) {
    return failOpenDecision('storage_unavailable', err);
  }
}

async function enforcePublicRateLimit(event, { endpoint, action = '', cors = false, now = Date.now() } = {}) {
  if (isOptionsRequest(event)) {
    return { blocked: false, allowed: true, bypassed: true };
  }

  const decision = await checkPublicRateLimit(event, { endpoint, action, now });
  if (decision.allowed) {
    return { blocked: false, ...decision };
  }

  return {
    blocked: true,
    allowed: false,
    response: buildRateLimitedResponse(decision.retryAfterSec, { cors }),
    retryAfterSec: decision.retryAfterSec,
  };
}

function setPublicRateLimitStoreFactory(factory) {
  storeFactoryOverride = typeof factory === 'function' ? factory : null;
}

function resetPublicRateLimitStoreFactory() {
  storeFactoryOverride = null;
}

module.exports = {
  PUBLIC_RATE_STORE,
  DEFAULT_LIMITS,
  STRONG_CONSISTENCY,
  MAX_WRITE_RETRIES,
  ENV_MAX_MIN,
  ENV_MAX_MAX,
  ENV_WINDOW_SEC_MIN,
  ENV_WINDOW_SEC_MAX,
  isOptionsRequest,
  normalizeClientIp,
  rateLimitNamespace,
  deriveRateLimitKey,
  getLimitConfig,
  parseEnvPositiveInt,
  identifySubmitBookingAction,
  checkPublicRateLimit,
  enforcePublicRateLimit,
  buildRateLimitedResponse,
  incrementCounterAtomically,
  effectiveCounterState,
  setPublicRateLimitStoreFactory,
  resetPublicRateLimitStoreFactory,
};
