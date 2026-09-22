'use strict';

const crypto = require('crypto');
const { normalizeUsPhoneE164 } = require('./phone-auth');

const STORE = 'cd1-sms-suppression';
const memory = new Map();

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

async function isPhoneSuppressed(rawPhone) {
  const key = suppressionKey(rawPhone);
  if (!key) return false;
  if (!runningInNetlifyFunction()) return memory.has(key);
  try {
    const store = await blobStore();
    const row = await store.get(key, { type: 'json' });
    if (!row || row.suppressed === false || row.clearedAt) return false;
    return !!row.suppressedAt;
  } catch (err) {
    console.warn('[sms-suppression] read_failed', err && err.message ? err.message : err);
    return false;
  }
}

module.exports = {
  suppressPhone,
  clearSuppression,
  isPhoneSuppressed,
};
