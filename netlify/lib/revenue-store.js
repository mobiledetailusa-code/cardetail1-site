// Netlify Blob helpers for Revenue Operations private stores.

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

async function getRevenueStore(name) {
  const storeName = REVENUE_STORES[name] || name;
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token)
    ? getStore({ name: storeName, siteID, token })
    : getStore(storeName);
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

async function blobListKeys(store, { prefix = '', limit = 500 } = {}) {
  const out = [];
  for await (const entry of store.list({ prefix, limit })) {
    out.push(entry.key || entry.blobKey || entry);
  }
  return out;
}

function retentionExpiresAt(storeKey) {
  const days = RETENTION_DAYS[storeKey] || 365;
  return new Date(Date.now() + days * 86400000).toISOString();
}

function generateOpaqueId(prefix) {
  const crypto = require('crypto');
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
};
