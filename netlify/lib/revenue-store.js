// Netlify Blob helpers for Revenue Operations private stores.

const crypto = require('crypto');

const REVENUE_STORES = Object.freeze({
  events: 'revenue-events',
  households: 'revenue-households',
  leads: 'revenue-leads',
  opportunities: 'revenue-opportunities',
  recovery: 'revenue-recovery-queue',
  offerRedemptions: 'revenue-offer-redemptions',
  resumeTokens: 'revenue-resume-tokens',
  eventIdempotency: 'revenue-event-idempotency',
  adminAudit: 'revenue-admin-audit',
});

const RETENTION_DAYS = {
  events: 400,
  households: 730,
  leads: 730,
  opportunities: 730,
  recovery: 180,
  offerRedemptions: 730,
  resumeTokens: 90,
  // Event-ID reservations must live at least as long as the event record or a
  // very-late replay could be treated as new. These values are policy targets,
  // not enforced TTLs: this repository has no Blob expiry/cleanup job.
  eventIdempotency: 400,
  adminAudit: 365,
};

const RETENTION_ENFORCEMENT = Object.freeze({
  mechanism: 'none',
  automaticTtl: false,
  note: 'RETENTION_DAYS are policy targets only; Netlify Blob writes here do not set a TTL.',
});

function runningInNetlifyFunction() {
  return !!(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);
}

async function getRevenueStore(name) {
  const storeName = REVENUE_STORES[name] || name;
  // Static require so Netlify esbuild always externalizes/includes @netlify/blobs.
  // Dynamic import() was omitted from some function bundles (ERR_MODULE_NOT_FOUND on Branch Deploy).
  const { getStore } = require('@netlify/blobs');

  // Prefer auto-bound runtime store inside Netlify Functions (same path used by bookings).
  if (runningInNetlifyFunction()) {
    try {
      return getStore(storeName);
    } catch (e) {
      console.warn(`[revenue-store] runtime getStore(${storeName}) failed:`, e.message);
    }
  }

  const siteID = String(process.env.NETLIFY_SITE_ID || process.env.SITE_ID || '').trim();
  const token = String(process.env.NETLIFY_AUTH_TOKEN || '').trim();
  if (siteID && token) {
    try {
      return getStore({ name: storeName, siteID, token });
    } catch (e) {
      console.warn(`[revenue-store] explicit getStore(${storeName}) failed:`, e.message);
    }
  }

  return getStore(storeName);
}

async function blobGetJson(store, key) {
  try {
    const raw = await store.get(key, { type: 'text' });
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Strict read for correctness-critical paths. Storage/parse failures propagate. */
async function blobGetJsonStrict(store, key) {
  const raw = await store.get(key, { type: 'text', consistency: 'strong' });
  if (!raw) return null;
  return JSON.parse(raw);
}

async function blobSetJson(store, key, value) {
  return store.set(key, JSON.stringify(value));
}

/**
 * Atomic create-only write backed by @netlify/blobs `onlyIfNew`.
 * The client maps this to `If-None-Match: *`; an existing key returns
 * `{ modified: false }` instead of being overwritten.
 */
async function blobCreateJson(store, key, value) {
  const result = await store.set(key, JSON.stringify(value), { onlyIfNew: true });
  return {
    created: !!(result && result.modified),
    etag: result && result.etag ? result.etag : null,
  };
}

/** List blob keys — compatible with Netlify Blobs paginated and legacy list APIs. */
async function blobListKeys(store, { prefix = '', limit = 500 } = {}) {
  const out = [];
  if (!store || typeof store.list !== 'function') {
    return out;
  }

  const cap = Math.min(Math.max(Number(limit) || 500, 1), 2000);

  try {
    const paged = store.list({ prefix, paginate: true });
    if (paged && typeof paged[Symbol.asyncIterator] === 'function') {
      for await (const page of paged) {
        for (const blob of (page && page.blobs) || []) {
          const key = blob.key || blob.blobKey || blob;
          if (key) out.push(key);
          if (out.length >= cap) return out;
        }
      }
      return out;
    }
  } catch (e) {
    console.warn('[revenue-store] paginated list failed:', e.message);
  }

  try {
    const listing = await store.list({ prefix, limit: cap });
    const blobs = (listing && listing.blobs) || [];
    for (const blob of blobs) {
      const key = blob.key || blob.blobKey || blob;
      if (key) out.push(key);
      if (out.length >= cap) return out;
    }
  } catch (e) {
    console.warn('[revenue-store] list failed:', e.message);
    throw e;
  }

  return out;
}

function retentionExpiresAt(storeKey) {
  const days = RETENTION_DAYS[storeKey] || 365;
  return new Date(Date.now() + days * 86400000).toISOString();
}

function generateOpaqueId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
}

module.exports = {
  REVENUE_STORES,
  RETENTION_DAYS,
  RETENTION_ENFORCEMENT,
  getRevenueStore,
  blobGetJson,
  blobGetJsonStrict,
  blobSetJson,
  blobCreateJson,
  blobListKeys,
  retentionExpiresAt,
  generateOpaqueId,
  runningInNetlifyFunction,
};
