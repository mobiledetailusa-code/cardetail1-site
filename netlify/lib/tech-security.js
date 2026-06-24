// Shared technician auth helpers for Netlify functions.
const crypto = require('crypto');

const PBKDF2_ITERATIONS = 100000;
const PBKDF2_KEYLEN = 64;
const PBKDF2_DIGEST = 'sha256';
const SESSION_TTL_MS = 10 * 60 * 60 * 1000;
const MAX_TECH_SESSIONS = 3;
const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;

async function blobsStore(name) {
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token) ? getStore({ name, siteID, token }) : getStore(name);
}

/** List all blob keys in a store; paginates and never throws. */
async function listAllBlobs(store, label = 'store') {
  const blobs = [];
  try {
    for await (const page of store.list({ paginate: true })) {
      blobs.push(...((page && page.blobs) || []));
    }
    return blobs;
  } catch (e) {
    console.error(`[blobs] paginated list failed (${label}):`, e.message);
  }
  try {
    const listing = await store.list();
    return (listing && listing.blobs) || [];
  } catch (e) {
    console.error(`[blobs] list failed (${label}):`, e.message);
    return [];
  }
}

/** Fetch JSON records for blob keys in bounded parallel batches. */
async function fetchBlobRecords(store, blobs, concurrency = 20) {
  const records = [];
  for (let i = 0; i < blobs.length; i += concurrency) {
    const chunk = blobs.slice(i, i + concurrency);
    const rows = await Promise.all(
      chunk.map(b => store.get(b.key, { type: 'json' }).catch(() => null))
    );
    for (const row of rows) if (row) records.push(row);
  }
  return records;
}

function jsonCors(status, body, extraHeaders = {}) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-admin-key, x-tech-token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

const { verifyAdminRequest } = require('./admin-security');

async function verifyAdminKey(headers) {
  return verifyAdminRequest(headers || {});
}

function hashPassword(password) {
  const salt = crypto.randomBytes(32).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString('hex');
  return { salt, hash, iterations: PBKDF2_ITERATIONS, keylen: PBKDF2_KEYLEN, digest: PBKDF2_DIGEST };
}

function verifyPassword(password, record) {
  if (!record || !record.hash || !record.salt) return false;
  const hash = crypto.pbkdf2Sync(
    password, record.salt, record.iterations || PBKDF2_ITERATIONS,
    record.keylen || PBKDF2_KEYLEN, record.digest || PBKDF2_DIGEST
  ).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(record.hash));
}

function isWeakPassword(pw) {
  if (pw.length < MIN_PASSWORD_LENGTH) return 'Password must be at least 8 characters.';
  if (!/[A-Z]/.test(pw)) return 'Must contain at least one uppercase letter.';
  if (!/[a-z]/.test(pw)) return 'Must contain at least one lowercase letter.';
  if (!/[0-9]/.test(pw)) return 'Must contain at least one number.';
  return null;
}

function sanitizeText(value, max = 2000) {
  return String(value == null ? '' : value).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim().slice(0, max);
}

function generateInviteToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function generateTechId() {
  return 'TECH-' + crypto.randomBytes(6).toString('hex').toUpperCase();
}

async function findTechByEmail(store, email) {
  const listing = await store.list().catch(() => ({ blobs: [] }));
  for (const b of ((listing && listing.blobs) || [])) {
    if (!b.key.startsWith('tech-')) continue;
    const t = await store.get(b.key, { type: 'json' }).catch(() => null);
    if (t && String(t.email || '').toLowerCase() === String(email).toLowerCase()) return { key: b.key, tech: t };
  }
  return null;
}

async function findTechByInviteToken(store, inviteToken) {
  const listing = await store.list().catch(() => ({ blobs: [] }));
  for (const b of ((listing && listing.blobs) || [])) {
    if (!b.key.startsWith('tech-')) continue;
    const t = await store.get(b.key, { type: 'json' }).catch(() => null);
    if (t && t.inviteToken === inviteToken) return { key: b.key, tech: t };
  }
  return null;
}

async function createTechSession(sessStore, techId, techName) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const session = { token, techId, techName, createdAt: now, expiresAt: now + SESSION_TTL_MS };
  const listing = await sessStore.list().catch(() => ({ blobs: [] }));
  const existing = [];
  for (const b of ((listing && listing.blobs) || [])) {
    if (!b.key.startsWith('tsess-')) continue;
    const s = await sessStore.get(b.key, { type: 'json' }).catch(() => null);
    if (!s) continue;
    if (s.expiresAt <= now) { try { await sessStore.delete(b.key); } catch (_) {} continue; }
    if (s.techId === techId) existing.push({ key: b.key, ...s });
  }
  if (existing.length >= MAX_TECH_SESSIONS) {
    existing.sort((a, b) => a.createdAt - b.createdAt);
    for (let i = 0; i <= existing.length - MAX_TECH_SESSIONS; i++) {
      try { await sessStore.delete(existing[i].key); } catch (_) {}
    }
  }
  await sessStore.setJSON('tsess-' + token.slice(0, 16), session);
  return session;
}

async function validateTechSession(headersOrToken) {
  const token = typeof headersOrToken === 'string'
    ? headersOrToken
    : ((headersOrToken && (headersOrToken['x-tech-token'] || headersOrToken['X-Tech-Token'])) || '').trim();
  if (!token || token.length < 32) return null;
  const sessStore = await blobsStore('cd1-tech-sessions');
  const key = 'tsess-' + token.slice(0, 16);
  const s = await sessStore.get(key, { type: 'json' }).catch(() => null);
  if (!s || Date.now() > s.expiresAt) return null;
  if (!crypto.timingSafeEqual(Buffer.from(s.token), Buffer.from(token))) return null;
  const techStore = await blobsStore('cd1-tech-accounts');
  const tech = await techStore.get('tech-' + s.techId, { type: 'json' }).catch(() => null);
  if (!tech || !tech.active) return null;
  return { ...s, tech };
}

function bookingAssignedToTech(booking, techId, techName) {
  const at = String(booking.assignedTechId || booking.assignedTech || '').toLowerCase();
  const name = String(booking.assignedTechName || '').toLowerCase();
  const tid = String(techId || '').toLowerCase();
  const tname = String(techName || '').toLowerCase();
  return at === tid || at === tname || name === tname;
}

module.exports = {
  blobsStore,
  listAllBlobs,
  fetchBlobRecords,
  jsonCors,
  verifyAdminKey,
  hashPassword,
  verifyPassword,
  isWeakPassword,
  sanitizeText,
  generateInviteToken,
  generateTechId,
  findTechByEmail,
  findTechByInviteToken,
  createTechSession,
  validateTechSession,
  bookingAssignedToTech,
  INVITE_TTL_MS,
  SESSION_TTL_MS,
};
