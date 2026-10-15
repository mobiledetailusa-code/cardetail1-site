'use strict';

const crypto = require('crypto');
const { normalizeUsPhoneE164 } = require('./phone-auth');

const STORE = 'cd1-sms-suppression';
const memory = new Map();
const inboundMemory = new Map();
let readOverride = null;
const OPT_OUT_PROVIDER_CODES = new Set(['21610', '30630']);

function isCarrierOptOutCode(code) {
  return OPT_OUT_PROVIDER_CODES.has(String(code || '').trim());
}

function setSuppressionReadOverride(fn) {
  readOverride = typeof fn === 'function' ? fn : null;
}

function runningInNetlifyFunction() {
  return !!(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);
}

function suppressionKey(rawPhone) {
  const e164 = normalizeUsPhoneE164(rawPhone);
  if (!e164) return null;
  return crypto.createHash('sha256').update(e164).digest('hex');
}

async function blobStore() {
  const { blobsStore } = require('./tech-security');
  return blobsStore(STORE);
}

async function suppressPhone(rawPhone) {
  const key = suppressionKey(rawPhone);
  if (!key) return { ok: false, error: 'invalid_phone' };
  const record = { suppressedAt: new Date().toISOString() };
  if (!runningInNetlifyFunction()) {
    memory.set(key, record);
    return { ok: true, suppressed: true };
  }
  try {
    const store = await blobStore();
    await store.setJSON(key, record);
    memory.set(key, record);
    return { ok: true, suppressed: true };
  } catch (err) {
    console.warn('[sms-suppression] write_failed', err && err.message ? err.message : err);
    return { ok: false, error: 'suppression_unavailable' };
  }
}

async function clearSuppression(rawPhone) {
  const key = suppressionKey(rawPhone);
  if (!key) return { ok: false, error: 'invalid_phone' };
  memory.delete(key);
  if (!runningInNetlifyFunction()) return { ok: true, cleared: true };
  try {
    const store = await blobStore();
    if (typeof store.delete === 'function') await store.delete(key);
    else await store.setJSON(key, { clearedAt: new Date().toISOString(), suppressed: false });
    return { ok: true, cleared: true };
  } catch (err) {
    console.warn('[sms-suppression] clear_failed', err && err.message ? err.message : err);
    return { ok: false, error: 'suppression_unavailable' };
  }
}

async function readPhoneSuppression(rawPhone) {
  const key = suppressionKey(rawPhone);
  if (!key) return { ok: true, suppressed: false };
  if (readOverride) {
    try {
      return await readOverride(rawPhone, key);
    } catch (err) {
      console.warn('[sms-suppression] read_failed', err && err.message ? err.message : err);
      return { ok: false, error: 'suppression_unavailable' };
    }
  }
  if (!runningInNetlifyFunction()) return { ok: true, suppressed: memory.has(key) };
  try {
    const store = await blobStore();
    const row = await store.get(key, { type: 'json' });
    if (!row || row.suppressed === false || row.clearedAt) return { ok: true, suppressed: false };
    return { ok: true, suppressed: !!row.suppressedAt };
  } catch (err) {
    console.warn('[sms-suppression] read_failed', err && err.message ? err.message : err);
    return { ok: false, error: 'suppression_unavailable' };
  }
}

async function isPhoneSuppressed(rawPhone) {
  const read = await readPhoneSuppression(rawPhone);
  if (!read.ok) {
    const error = new Error('suppression_unavailable');
    error.code = 'suppression_unavailable';
    throw error;
  }
  return !!read.suppressed;
}

function inboundEventKey(messageSid) {
  const sid = String(messageSid || '').trim();
  if (!/^SM[a-zA-Z0-9]{8,}$/.test(sid)) return null;
  return `in_${crypto.createHash('sha256').update(sid).digest('hex')}`;
}

async function readInboundCommand(messageSid) {
  const key = inboundEventKey(messageSid);
  if (!key) return { ok: false, error: 'invalid_message_sid' };
  if (inboundMemory.has(key)) return { ok: true, duplicate: true, action: inboundMemory.get(key) };
  if (!runningInNetlifyFunction()) return { ok: true, duplicate: false };
  try {
    const store = await blobStore();
    const row = await store.get(key, { type: 'json' });
    if (row && row.action) {
      inboundMemory.set(key, row.action);
      return { ok: true, duplicate: true, action: row.action };
    }
    return { ok: true, duplicate: false };
  } catch (err) {
    console.warn('[sms-suppression] inbound_read_failed', err && err.message ? err.message : err);
    return { ok: false, error: 'suppression_unavailable' };
  }
}

async function recordInboundCommand(messageSid, action) {
  const key = inboundEventKey(messageSid);
  if (!key) return { ok: false, error: 'invalid_message_sid' };
  const safeAction = String(action || '').slice(0, 24);
  inboundMemory.set(key, safeAction);
  if (!runningInNetlifyFunction()) return { ok: true };
  try {
    const store = await blobStore();
    await store.setJSON(key, { action: safeAction, at: new Date().toISOString() });
    return { ok: true };
  } catch (err) {
    inboundMemory.delete(key);
    console.warn('[sms-suppression] inbound_write_failed', err && err.message ? err.message : err);
    return { ok: false, error: 'suppression_unavailable' };
  }
}

module.exports = {
  suppressPhone,
  clearSuppression,
  readPhoneSuppression,
  isPhoneSuppressed,
  isCarrierOptOutCode,
  readInboundCommand,
  recordInboundCommand,
  setSuppressionReadOverride,
};
