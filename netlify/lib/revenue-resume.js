// Secure resume tokens for identified booking abandonment recovery.

const crypto = require('crypto');
const { getRevenueStore, blobGetJson, blobSetJson, generateOpaqueId } = require('./revenue-store');

const TOKEN_TTL_MS = 72 * 60 * 60 * 1000;
const TOKEN_PREFIX = 'rs.';

function resumeSecret() {
  const primary = String(process.env.RESUME_TOKEN_SECRET || process.env.DRAFT_TOKEN_SECRET || '').trim();
  if (primary.length >= 32) return primary;
  const fallback = String(process.env.ADMIN_SESSION_SECRET || '').trim();
  if (fallback.length >= 32 && String(process.env.CONTEXT || '').toLowerCase() !== 'production') {
    return fallback;
  }
  return '';
}

function hashToken(token) {
  const secret = resumeSecret();
  if (!secret) return '';
  return crypto.createHmac('sha256', secret).update(String(token)).digest('base64url');
}

async function createResumeToken({ leadId, householdId, bookingId, bookingStep, garagePlanId }) {
  const secret = resumeSecret();
  if (!secret) return { ok: false, error: 'resume_not_configured' };
  const token = TOKEN_PREFIX + crypto.randomBytes(24).toString('base64url');
  const tokenHash = hashToken(token);
  const resumeId = generateOpaqueId('rsm');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  const record = {
    resumeId,
    tokenHash,
    leadId: leadId || null,
    householdId: householdId || null,
    bookingId: bookingId || null,
    garagePlanId: garagePlanId || null,
    bookingStep: bookingStep || null,
    createdAt: new Date().toISOString(),
    expiresAt,
    revoked: false,
    usedAt: null,
  };
  const store = await getRevenueStore('resumeTokens');
  await blobSetJson(store, tokenHash, record);
  return { ok: true, resumeId, token, expiresAt };
}

async function validateResumeToken(token) {
  const secret = resumeSecret();
  if (!secret) return { ok: false, error: 'resume_not_configured' };
  const raw = String(token || '').trim();
  if (!raw.startsWith(TOKEN_PREFIX)) return { ok: false, error: 'invalid_token' };
  const tokenHash = hashToken(raw);
  const store = await getRevenueStore('resumeTokens');
  const record = await blobGetJson(store, tokenHash);
  if (!record || record.revoked) return { ok: false, error: 'invalid_token' };
  if (new Date(record.expiresAt).getTime() < Date.now()) {
    return { ok: false, error: 'expired' };
  }
  return { ok: true, record };
}

async function revokeResumeToken(token) {
  const v = await validateResumeToken(token);
  if (!v.ok) return v;
  const store = await getRevenueStore('resumeTokens');
  await blobSetJson(store, v.record.tokenHash, { ...v.record, revoked: true, revokedAt: new Date().toISOString() });
  return { ok: true };
}

module.exports = {
  TOKEN_TTL_MS,
  createResumeToken,
  validateResumeToken,
  revokeResumeToken,
};
