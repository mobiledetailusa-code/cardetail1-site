'use strict';

const crypto = require('crypto');

const MAX_KEY_LENGTH = 96;
const MAX_RECEIPTS = 100;

function normalizeIdempotencyKey(value) {
  const key = String(value || '').trim();
  if (!/^[A-Za-z0-9_.:-]{8,96}$/.test(key)) return '';
  return key.slice(0, MAX_KEY_LENGTH);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    out[key] = canonicalize(value[key]);
  }
  return out;
}

function mutationFingerprint(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function requestIdFromKey(bookingId, key) {
  const normalized = normalizeIdempotencyKey(key);
  if (!normalized) return '';
  return `cr_${crypto
    .createHash('sha256')
    .update(`${String(bookingId || '').trim()}:${normalized}`)
    .digest('base64url')
    .slice(0, 20)}`;
}

function adjustmentIdFromKey(prefix, bookingId, key) {
  const normalized = normalizeIdempotencyKey(key);
  if (!normalized) return '';
  const digest = crypto
    .createHash('sha256')
    .update(`${bookingId}:${normalized}`)
    .digest('base64url')
    .slice(0, 32);
  return `${String(prefix || 'op').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16)}_${digest}`;
}

function receiptsOf(booking) {
  return Array.isArray(booking?.operationReceipts) ? booking.operationReceipts : [];
}

function findOperationReceipt(booking, key) {
  const normalized = normalizeIdempotencyKey(key);
  if (!normalized) return null;
  return receiptsOf(booking).find((row) => row && row.idempotencyKey === normalized) || null;
}

function replayResult(booking, key, fingerprint) {
  const receipt = findOperationReceipt(booking, key);
  if (!receipt) return null;
  if (receipt.fingerprint !== fingerprint) {
    return {
      ok: false,
      error: 'idempotency_conflict',
      statusCode: 409,
    };
  }
  return {
    ok: true,
    idempotent: true,
    receipt,
  };
}

function appendOperationReceipt(booking, {
  idempotencyKey,
  fingerprint,
  action,
  actor,
  bookingVersion,
  quoteVersion,
  result = 'applied',
  at = new Date().toISOString(),
}) {
  const key = normalizeIdempotencyKey(idempotencyKey);
  if (!key) return receiptsOf(booking);
  const withoutKey = receiptsOf(booking).filter((row) => row && row.idempotencyKey !== key);
  return [...withoutKey, {
    idempotencyKey: key,
    fingerprint,
    action: String(action || '').slice(0, 64),
    actor: String(actor || '').slice(0, 64),
    bookingVersion: Math.max(0, Math.round(Number(bookingVersion) || 0)),
    quoteVersion: Math.max(0, Math.round(Number(quoteVersion) || 0)),
    result: String(result || 'applied').slice(0, 32),
    at,
  }].slice(-MAX_RECEIPTS);
}

module.exports = {
  MAX_RECEIPTS,
  normalizeIdempotencyKey,
  canonicalize,
  mutationFingerprint,
  requestIdFromKey,
  adjustmentIdFromKey,
  findOperationReceipt,
  replayResult,
  appendOperationReceipt,
};
