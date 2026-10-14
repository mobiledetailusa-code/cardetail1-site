'use strict';

const crypto = require('crypto');
const { processSmsOutbox } = require('../lib/sms-outbox');
const { outboundTwilioPolicy } = require('../lib/twilio-runtime-policy');
const { enforcePublicRateLimit } = require('../lib/public-rate-limit');

let processOverride = null;

const NEXT_RUN_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function header(event, name) {
  const want = String(name).toLowerCase();
  for (const [key, value] of Object.entries(event?.headers || {})) {
    if (String(key).toLowerCase() === want) return String(value || '');
  }
  return '';
}

function secretMatches(expected, supplied) {
  const left = Buffer.from(String(expected || ''), 'utf8');
  const right = Buffer.from(String(supplied || ''), 'utf8');
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function decodeEventBody(event = {}) {
  let raw = event.body;
  if (raw == null) return null;
  if (event.isBase64Encoded && typeof raw === 'string') {
    try {
      raw = Buffer.from(raw, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object') return raw;
  return null;
}

function isIsoNextRun(value) {
  return NEXT_RUN_ISO.test(String(value || '').trim());
}

// Netlify's scheduler sets X-NF-Event and next_run, but a public request can
// set those same fields. They are logged only. They never authenticate.
function isScheduledInvocation(event = {}) {
  const eventName = header(event, 'x-nf-event').trim().toLowerCase();
  if (eventName !== 'schedule') return false;
  if (isIsoNextRun(event.next_run)) return true;
  const body = decodeEventBody(event);
  return isIsoNextRun(body?.next_run);
}

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(payload),
  };
}

function safeWorkerLog(payload = {}) {
  console.info('[twilio-outbox-worker]', {
    scheduled: !!payload.scheduled,
    disabled: !!payload.disabled,
    reason: payload.reason ? String(payload.reason).slice(0, 64) : null,
    processed: Number.isFinite(Number(payload.processed)) ? Number(payload.processed) : 0,
    statusCode: Number(payload.statusCode) || 0,
    error: payload.error ? String(payload.error).slice(0, 48) : null,
  });
}

exports.handler = async (event = {}) => {
  const scheduled = isScheduledInvocation(event);
  const expected = String(process.env.TWILIO_WORKER_SECRET || '');
  const supplied = header(event, 'x-worker-secret');
  if (!secretMatches(expected, supplied)) {
    const response = json(401, { ok: false, error: 'unauthorized', processed: 0 });
    safeWorkerLog({
      scheduled,
      statusCode: 401,
      error: 'unauthorized',
      processed: 0,
    });
    return response;
  }
  let rate;
  try {
    rate = await enforcePublicRateLimit(event, {
      endpoint: 'twilio-outbox-worker',
      action: 'run',
    });
  } catch {
    const response = json(503, { ok: false, error: 'rate_limit_unavailable', processed: 0 });
    safeWorkerLog({
      scheduled,
      statusCode: 503,
      error: 'rate_limit_unavailable',
      processed: 0,
    });
    return response;
  }
  if (rate.blocked) {
    const response = json(429, {
      ok: false,
      error: 'rate_limited',
      processed: 0,
      retryAfterSec: rate.retryAfterSec || 1,
    });
    safeWorkerLog({
      scheduled,
      statusCode: 429,
      error: 'rate_limited',
      processed: 0,
    });
    return response;
  }
  const policy = outboundTwilioPolicy(process.env);
  if (!policy.ok) {
    const response = json(200, {
      ok: true,
      disabled: true,
      reason: policy.reason,
      processed: 0,
    });
    safeWorkerLog({
      scheduled,
      disabled: true,
      reason: policy.reason,
      processed: 0,
      statusCode: 200,
    });
    return response;
  }
  const runOutbox = processOverride || processSmsOutbox;
  const result = await runOutbox({ limit: 10 });
  const response = json(result.ok ? 200 : 503, {
    ok: result.ok,
    disabled: !!result.disabled,
    reason: result.reason || null,
    processed: result.processed || 0,
  });
  safeWorkerLog({
    scheduled,
    disabled: !!result.disabled,
    reason: result.reason || result.error || null,
    processed: result.processed || 0,
    statusCode: result.ok ? 200 : 503,
    error: result.ok ? null : (result.error || 'outbox_failed'),
  });
  return response;
};

exports.config = { schedule: '*/2 * * * *' };
exports.secretMatches = secretMatches;
exports.isScheduledInvocation = isScheduledInvocation;
exports.isIsoNextRun = isIsoNextRun;
exports.__test = {
  setProcessOverride(fn) {
    processOverride = typeof fn === 'function' ? fn : null;
  },
};
