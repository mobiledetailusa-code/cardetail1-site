// WELCOME10 one-time redemption authority — Blob onlyIfNew keyed by email.
// Redemption is claimed only when a non-draft booking applies the offer.
// Capture / Review preview must never write this store.

'use strict';

const crypto = require('crypto');
const revenueStore = require('./revenue-store');
const {
  blobGetJsonStrict,
  blobCreateJson,
  retentionExpiresAt,
  runningInNetlifyFunction,
} = require('./revenue-store');

const nativeGetRevenueStore = revenueStore.getRevenueStore;
const OFFER_ID = 'first_booking_welcome';

function normalizeEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return '';
  return e;
}

function redemptionKey(email) {
  const n = normalizeEmail(email);
  if (!n) return '';
  return 'welcome10:' + crypto.createHash('sha256').update(n).digest('hex').slice(0, 40);
}

function usingTestStoreDouble() {
  return revenueStore.getRevenueStore !== nativeGetRevenueStore;
}

function redemptionBlobsAvailable() {
  if (usingTestStoreDouble()) return true;
  if (runningInNetlifyFunction()) return true;
  const siteID = String(process.env.NETLIFY_SITE_ID || process.env.SITE_ID || '').trim();
  const token = String(process.env.NETLIFY_AUTH_TOKEN || '').trim();
  return Boolean(siteID && token);
}

async function redemptionStore() {
  return revenueStore.getRevenueStore('offerRedemptions');
}

/**
 * Strict lookup for offer eligibility.
 * @returns {Promise<{ ok: true, record: object|null } | { ok: false, error: string }>}
 */
async function findWelcomeOfferRedemption(email) {
  const key = redemptionKey(email);
  if (!key) return { ok: true, record: null };
  // Outside Netlify without a test double / explicit Blob credentials there is
  // no redemption ledger to consult. Treat as empty (ok) so unit tests and
  // offline tooling can evaluate pricing; Netlify runtime always binds a store.
  if (!redemptionBlobsAvailable()) {
    if (!runningInNetlifyFunction()) return { ok: true, record: null };
    return { ok: false, error: 'offer_redemption_lookup_unavailable' };
  }
  try {
    const store = await redemptionStore();
    const record = await blobGetJsonStrict(store, key);
    return { ok: true, record: record && record.offerId ? record : null, key };
  } catch (err) {
    console.warn('[welcome-offer-redemption] lookup failed:', err && err.message ? err.message : err);
    return { ok: false, error: 'offer_redemption_lookup_unavailable' };
  }
}

/**
 * Atomic one-time claim. Idempotent when the same bookingId retries.
 * @returns {Promise<{ ok: true, created?: boolean, idempotent?: boolean, record: object, key: string }
 *   | { ok: false, error: string, reason?: string, record?: object }>}
 */
async function claimWelcomeOfferRedemption({ email, bookingId }) {
  const key = redemptionKey(email);
  const id = String(bookingId || '').trim();
  if (!key) return { ok: false, error: 'offer_redemption_invalid_email' };
  if (!id) return { ok: false, error: 'offer_redemption_missing_booking_id' };
  if (!redemptionBlobsAvailable()) {
    return { ok: false, error: 'offer_redemption_claim_unavailable' };
  }

  try {
    const store = await redemptionStore();
    const existing = await blobGetJsonStrict(store, key);
    if (existing && existing.bookingId === id) {
      return { ok: true, idempotent: true, record: existing, key };
    }
    if (existing && existing.bookingId) {
      return { ok: false, error: 'offer_already_redeemed', reason: 'already_redeemed', record: existing, key };
    }

    const now = new Date().toISOString();
    const record = {
      offerId: OFFER_ID,
      email: normalizeEmail(email),
      bookingId: id,
      redeemedAt: now,
      createdAt: now,
      expiresAt: retentionExpiresAt('offerRedemptions'),
    };
    const created = await blobCreateJson(store, key, record);
    if (created.created) {
      return { ok: true, created: true, record, key };
    }

    const raced = await blobGetJsonStrict(store, key);
    if (raced && raced.bookingId === id) {
      return { ok: true, idempotent: true, record: raced, key };
    }
    return {
      ok: false,
      error: 'offer_already_redeemed',
      reason: 'already_redeemed',
      record: raced || existing,
      key,
    };
  } catch (err) {
    console.warn('[welcome-offer-redemption] claim failed:', err && err.message ? err.message : err);
    return { ok: false, error: 'offer_redemption_claim_unavailable' };
  }
}

module.exports = {
  OFFER_ID,
  normalizeEmail,
  redemptionKey,
  findWelcomeOfferRedemption,
  claimWelcomeOfferRedemption,
};
