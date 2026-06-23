const crypto = require('crypto');

const DEFAULT_ALLOWED_METHODS = 'POST, OPTIONS';

function header(event, name) {
  const headers = event && event.headers ? event.headers : {};
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '';
}

function requestOrigin(event) {
  return String(header(event, 'origin') || '').trim();
}

function allowedOrigins(event) {
  const values = [
    process.env.SITE_URL,
    process.env.URL,
    process.env.DEPLOY_PRIME_URL,
    process.env.DEPLOY_URL,
    ...(String(process.env.ALLOWED_ORIGINS || '').split(',')),
  ]
    .map(v => String(v || '').trim().replace(/\/+$/, ''))
    .filter(Boolean);

  const host = String(header(event, 'host') || '').trim();
  if (host) values.push(`https://${host}`);
  return new Set(values);
}

function corsHeaders(event, options = {}) {
  const origin = requestOrigin(event).replace(/\/+$/, '');
  const allow = allowedOrigins(event);
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  const allowOrigin = !origin
    ? (process.env.SITE_URL || '*')
    : (allow.has(origin) || isLocal ? origin : 'null');

  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': options.allowHeaders || 'Content-Type, x-admin-key',
    'Access-Control-Allow-Methods': options.allowMethods || DEFAULT_ALLOWED_METHODS,
    'Cache-Control': options.cacheControl || 'no-store',
    'Vary': 'Origin',
  };
}

function json(event, statusCode, body, options) {
  return {
    statusCode,
    headers: corsHeaders(event, options),
    body: JSON.stringify(body),
  };
}

function safeEq(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function getAdminKey(event) {
  return String(header(event, 'x-admin-key') || '').trim();
}

function requireAdmin(event) {
  const expected = String(process.env.ADMIN_DASH_PASSWORD || '').trim();
  if (!expected) return { ok: false, status: 503, body: { ok: false, error: 'missing_admin_password_config' } };
  const provided = getAdminKey(event);
  if (!provided || !safeEq(provided, expected)) {
    return { ok: false, status: 401, body: { ok: false, error: 'unauthorized' } };
  }
  return { ok: true };
}

function clientIp(event) {
  const raw = header(event, 'x-nf-client-connection-ip') ||
    header(event, 'client-ip') ||
    header(event, 'x-forwarded-for') ||
    'unknown';
  return String(raw).split(',')[0].trim() || 'unknown';
}

async function blobsStore(name) {
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token) ? getStore({ name, siteID, token }) : getStore(name);
}

async function rateLimit(event, bucket, limit = 20, windowSeconds = 60) {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const ipHash = crypto.createHash('sha256').update(clientIp(event)).digest('hex').slice(0, 24);
  const key = `${String(bucket || 'global').replace(/[^a-z0-9_-]/gi, '_')}:${ipHash}`;

  try {
    const store = await blobsStore('cd1-rate-limits');
    const current = await store.get(key, { type: 'json' }).catch(() => null);
    const record = current && current.resetAt > now
      ? { count: Number(current.count) || 0, resetAt: current.resetAt }
      : { count: 0, resetAt: now + windowMs };

    record.count += 1;
    await store.setJSON(key, record);

    if (record.count > limit) {
      return {
        ok: false,
        status: 429,
        body: { ok: false, error: 'rate_limited', retryAfter: Math.ceil((record.resetAt - now) / 1000) },
      };
    }
  } catch (e) {
    // Do not take the site down if the rate-limit backing store is unavailable.
    console.warn('[security] rate limit unavailable:', e.message);
  }
  return { ok: true };
}

function parseJson(event) {
  try {
    return { ok: true, value: JSON.parse(event.body || '{}') };
  } catch {
    return { ok: false };
  }
}

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.charAt(0) === '1') return digits.slice(1);
  return digits;
}

function phonesMatchExact(input, stored) {
  const a = normalizePhone(input);
  const b = normalizePhone(stored);
  return a.length >= 7 && a === b;
}

function cleanText(value, max = 500) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

function cleanEmail(value) {
  const email = cleanText(value, 160).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function cleanBookingId(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 48);
}

function safeHttpUrl(value, allowedHosts = []) {
  const raw = cleanText(value, 2000);
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return '';
    if (allowedHosts.length && !allowedHosts.some(host => u.hostname === host || u.hostname.endsWith(`.${host}`))) return '';
    return u.toString();
  } catch {
    return '';
  }
}

function clampNumber(value, min, max, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

module.exports = {
  blobsStore,
  cleanBookingId,
  cleanEmail,
  cleanText,
  clampNumber,
  corsHeaders,
  getAdminKey,
  json,
  normalizePhone,
  parseJson,
  phonesMatchExact,
  rateLimit,
  requireAdmin,
  safeEq,
  safeHttpUrl,
};
