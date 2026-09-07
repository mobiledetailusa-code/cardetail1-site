// First-visit WELCOME10 email captures — first-party store, no name/phone required.

'use strict';

const crypto = require('crypto');
const revenueStore = require('./revenue-store');
const {
  blobGetJson,
  blobSetJson,
  blobCreateJson,
  generateOpaqueId,
  retentionExpiresAt,
} = require('./revenue-store');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || e.length > 254 || !EMAIL_RE.test(e)) return '';
  return e;
}

function emailKey(email) {
  const n = normalizeEmail(email);
  if (!n) return '';
  return 'wl-' + crypto.createHash('sha256').update(n).digest('hex').slice(0, 40);
}

async function welcomeLeadStore() {
  return revenueStore.getRevenueStore('welcomeLeads');
}

async function findWelcomeLeadCapture(email) {
  const key = emailKey(email);
  if (!key) return null;
  try {
    const store = await welcomeLeadStore();
    const rec = await blobGetJson(store, key);
    if (!rec || !rec.email) return null;
    return rec;
  } catch {
    return null;
  }
}

async function hasWelcomeLeadCapture(email) {
  const rec = await findWelcomeLeadCapture(email);
  return !!(rec && rec.claimedAt);
}

async function saveWelcomeLeadCapture(input) {
  const email = normalizeEmail(input && input.email);
  if (!email) {
    const err = new Error('invalid_email');
    err.code = 'invalid_email';
    throw err;
  }

  const existing = await findWelcomeLeadCapture(email);
  if (existing) {
    return { record: existing, created: false, idempotent: true };
  }

  const now = new Date().toISOString();
  const record = {
    captureId: generateOpaqueId('wlc'),
    email,
    source: String((input && input.source) || 'first_visit_balloon').slice(0, 80),
    landingPage: String((input && input.landingPage) || '').slice(0, 200),
    utmCampaign: String((input && input.utmCampaign) || '').slice(0, 80) || null,
    marketingConsent: !!(input && input.marketingConsent),
    offerEmailConsent: true,
    offerId: 'first_booking_welcome',
    claimedAt: now,
    createdAt: now,
    updatedAt: now,
    expiresAt: retentionExpiresAt('welcomeLeads'),
  };

  const store = await welcomeLeadStore();
  const key = emailKey(email);
  const created = await blobCreateJson(store, key, record);
  if (!created.created) {
    const raced = await findWelcomeLeadCapture(email);
    return { record: raced || record, created: false, idempotent: true };
  }
  return { record, created: true, idempotent: false };
}

async function touchWelcomeLeadCapture(email, patch) {
  const rec = await findWelcomeLeadCapture(email);
  if (!rec) return null;
  const next = {
    ...rec,
    ...(patch && typeof patch === 'object' ? patch : {}),
    email: rec.email,
    updatedAt: new Date().toISOString(),
  };
  const store = await welcomeLeadStore();
  await blobSetJson(store, emailKey(email), next);
  return next;
}

module.exports = {
  normalizeEmail,
  emailKey,
  findWelcomeLeadCapture,
  hasWelcomeLeadCapture,
  saveWelcomeLeadCapture,
  touchWelcomeLeadCapture,
};
