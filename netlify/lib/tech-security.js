const crypto = require('crypto');

const TECH_STORE = 'cd1-tech-accounts';
const SESSION_STORE = 'cd1-tech-sessions';
const BOOKING_STORE = 'cd1-bookings';
const SECURITY_STORE = 'cd1-security-events';
const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

async function blobStore(name) {
  if (global.__CD1_TEST_STORES) {
    if (!global.__CD1_TEST_STORES[name]) global.__CD1_TEST_STORES[name] = new Map();
    const map = global.__CD1_TEST_STORES[name];
    return {
      get: async (key) => map.has(key) ? JSON.parse(JSON.stringify(map.get(key))) : null,
      setJSON: async (key, value) => { map.set(key, JSON.parse(JSON.stringify(value))); },
      delete: async (key) => { map.delete(key); },
      list: async () => ({ blobs: [...map.keys()].map(key => ({ key })) }),
    };
  }
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token) ? getStore({ name, siteID, token }) : getStore(name);
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function requireAdmin(event) {
  const expected = String(process.env.ADMIN_DASH_PASSWORD || '').trim();
  if (!expected) return { ok: false, status: 503, error: 'missing_admin_password_config' };
  const headers = event.headers || {};
  const provided = String(headers['x-admin-key'] || headers['X-Admin-Key'] || '').trim();
  return safeEqual(provided, expected)
    ? { ok: true, adminId: 'admin' }
    : { ok: false, status: 401, error: 'unauthorized' };
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeId(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(String(password), salt, 64, { N: 16384, r: 8, p: 1 }, (error, key) => {
      if (error) return reject(error);
      resolve(`scrypt$16384$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`);
    });
  });
}

function verifyPassword(password, encoded) {
  return new Promise(resolve => {
    const [algorithm, n, r, p, saltText, keyText] = String(encoded || '').split('$');
    if (algorithm !== 'scrypt' || !saltText || !keyText) return resolve(false);
    const expected = Buffer.from(keyText, 'base64url');
    crypto.scrypt(String(password), Buffer.from(saltText, 'base64url'), expected.length,
      { N: Number(n), r: Number(r), p: Number(p) }, (error, actual) => {
        resolve(!error && actual.length === expected.length && crypto.timingSafeEqual(actual, expected));
      });
  });
}

function publicTech(tech, includeInvite = false) {
  const safe = {
    techId: tech.techId,
    fullName: tech.fullName,
    email: tech.email,
    phone: tech.phone || '',
    active: tech.active !== false,
    capabilities: Array.isArray(tech.capabilities) ? tech.capabilities : [],
    serviceArea: tech.serviceArea || '',
    createdAt: tech.createdAt,
    updatedAt: tech.updatedAt,
    lastLoginAt: tech.lastLoginAt || '',
    inviteExpiresAt: tech.inviteExpiresAt || '',
    invitePending: !!tech.inviteTokenHash,
  };
  if (includeInvite && tech._inviteToken) safe.inviteToken = tech._inviteToken;
  return safe;
}

async function listStore(store) {
  const listing = await store.list();
  return (await Promise.all((listing.blobs || []).map(item =>
    store.get(item.key, { type: 'json' }).catch(() => null)
  ))).filter(Boolean);
}

async function findTechByEmail(email) {
  const store = await blobStore(TECH_STORE);
  const all = await listStore(store);
  return all.find(tech => normalizeEmail(tech.email) === normalizeEmail(email)) || null;
}

function getBearer(event) {
  const headers = event.headers || {};
  const auth = String(headers.authorization || headers.Authorization || '');
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return String(headers['x-tech-token'] || headers['X-Tech-Token'] || '').trim();
}

async function validateTechSession(event) {
  const token = getBearer(event);
  if (!token) return { ok: false, status: 401, error: 'invalid_session' };
  const sessions = await blobStore(SESSION_STORE);
  const key = tokenHash(token);
  const session = await sessions.get(key, { type: 'json' }).catch(() => null);
  if (!session || session.revokedAt || Date.parse(session.expiresAt) <= Date.now()) {
    if (session) await sessions.delete(key).catch(() => {});
    return { ok: false, status: 401, error: 'invalid_session' };
  }
  const techs = await blobStore(TECH_STORE);
  const tech = await techs.get(session.techId, { type: 'json' }).catch(() => null);
  if (!tech || tech.active === false) return { ok: false, status: 403, error: 'technician_inactive' };
  return { ok: true, token, sessionKey: key, session, tech };
}

async function securityEvent(type, details = {}) {
  try {
    const store = await blobStore(SECURITY_STORE);
    const at = new Date().toISOString();
    await store.setJSON(`${Date.now()}-${randomToken(6)}`, { type, at, ...details });
  } catch (_) {}
}

module.exports = {
  TECH_STORE, SESSION_STORE, BOOKING_STORE, INVITE_TTL_MS, SESSION_TTL_MS,
  blobStore, requireAdmin, normalizeEmail, normalizeId, randomToken, tokenHash,
  hashPassword, verifyPassword, publicTech, listStore, findTechByEmail,
  validateTechSession, securityEvent,
};
