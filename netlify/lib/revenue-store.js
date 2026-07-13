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
  eventIdempotency: 30,
  adminAudit: 365,
};

function runningInNetlifyFunction() {
  return !!(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);
}

async function getRevenueStore(name) {
  const storeName = REVENUE_STORES[name] || name;
  const { getStore } = await import('@netlify/blobs');

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

async function blobSetJson(store, key, value) {
  await store.set(key, JSON.stringify(value));
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
  getRevenueStore,
  blobGetJson,
  blobSetJson,
  blobListKeys,
  retentionExpiresAt,
  generateOpaqueId,
  runningInNetlifyFunction,
};
