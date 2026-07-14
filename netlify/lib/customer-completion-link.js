// Secure booking-scoped customer completion / action links.
const crypto = require('crypto');

const TOKEN_STORE = 'cd1-customer-action-tokens';
const TOKEN_TTL_MS = 72 * 60 * 60 * 1000;
const TOKEN_PREFIX = 'cat_';

function hashToken(token) {
  const secret = String(process.env.DRAFT_TOKEN_SECRET || process.env.CUSTOMER_SESSION_SECRET || process.env.ADMIN_SESSION_SECRET || '').trim();
  if (!secret || secret.length < 16) throw new Error('missing_token_secret');
  return crypto.createHmac('sha256', secret).update(token).digest('hex');
}

async function blobsStore(name) {
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token) ? getStore({ name, siteID, token }) : getStore(name);
}

function generateActionToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

async function createCompletionLink(bookingId, purpose = 'completion_review') {
  const token = generateActionToken();
  const tokenHash = hashToken(token);
  const now = Date.now();
  const record = {
    bookingId,
    purpose,
    tokenHash,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TOKEN_TTL_MS).toISOString(),
    revoked: false,
    uses: 0,
  };
  const store = await blobsStore(TOKEN_STORE);
  await store.setJSON(`tok_${tokenHash.slice(0, 24)}`, record);
  return { token, expiresAt: record.expiresAt };
}

async function verifyActionToken(token) {
  const t = String(token || '').trim();
  if (!t.startsWith(TOKEN_PREFIX) || t.length < 20) return null;
  let tokenHash;
  try { tokenHash = hashToken(t); } catch { return null; }
  const store = await blobsStore(TOKEN_STORE);
  const record = await store.get(`tok_${tokenHash.slice(0, 24)}`, { type: 'json' }).catch(() => null);
  if (!record || record.revoked) return null;
  if (record.tokenHash !== tokenHash) return null;
  if (new Date(record.expiresAt).getTime() < Date.now()) return null;
  return record;
}

async function revokeActionToken(token) {
  const verified = await verifyActionToken(token);
  if (!verified) return false;
  const store = await blobsStore(TOKEN_STORE);
  const key = `tok_${verified.tokenHash.slice(0, 24)}`;
  await store.setJSON(key, { ...verified, revoked: true, revokedAt: new Date().toISOString() });
  return true;
}

function buildCompletionUrl(siteUrl, token) {
  const base = String(siteUrl || process.env.URL || 'https://cardetail1.com').replace(/\/$/, '');
  return `${base}/my-garage.html?action=${encodeURIComponent(token)}`;
}

module.exports = {
  TOKEN_STORE,
  TOKEN_TTL_MS,
  generateActionToken,
  createCompletionLink,
  verifyActionToken,
  revokeActionToken,
  buildCompletionUrl,
  hashToken,
};
