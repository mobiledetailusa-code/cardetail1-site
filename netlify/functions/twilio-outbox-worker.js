'use strict';

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

// x-nf-event, user-agent, Host, and next_run are not authentication.
// Netlify invokes this scheduled function without a caller-supplied secret.
// next_run is checked only when the body includes it, and only as a format.
function presentedNextRun(event = {}) {
  if (event.next_run != null && String(event.next_run).trim()) return String(event.next_run).trim();
  const body = decodeEventBody(event);
  if (body?.next_run != null && String(body.next_run).trim()) return String(body.next_run).trim();
  return '';
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
    disabled: !!payload.disabled,
    reason: payload.reason ? String(payload.reason).slice(0, 64) : null,
    processed: Number.isFinite(Number(payload.processed)) ? Number(payload.processed) : 0,
    statusCode: Number(payload.statusCode) || 0,
    error: payload.error ? String(payload.error).slice(0, 48) : null,
  });
}

exports.handler = async (event = {}) => {
  const nextRun = presentedNextRun(event);
  if (nextRun && !isIsoNextRun(nextRun)) {
    const response = json(400, { ok: false, error: 'invalid_next_run', processed: 0 });
    safeWorkerLog({ statusCode: 400, error: 'invalid_next_run', processed: 0 });
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
      disabled: true,
      reason: policy.reason,
      processed: 0,
      statusCode: 200,
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
    safeWorkerLog({ statusCode: 503, error: 'rate_limit_unavailable', processed: 0 });
    return response;
  }
  if (rate.blocked) {
    const response = json(429, {
      ok: false,
      error: 'rate_limited',
      processed: 0,
      retryAfterSec: rate.retryAfterSec || 1,
    });
    safeWorkerLog({ statusCode: 429, error: 'rate_limited', processed: 0 });
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
    disabled: !!result.disabled,
    reason: result.reason || result.error || null,
    processed: result.processed || 0,
    statusCode: result.ok ? 200 : 503,
    error: result.ok ? null : (result.error || 'outbox_failed'),
  });
  return response;
};

// Native scheduled function. `path` is mutually exclusive with `schedule`, so
// production does not publish a public URL for this worker. netlify.toml pins
// the same cron because an in-code schedule was previously dropped at build.
exports.config = { schedule: '*/2 * * * *' };
exports.isIsoNextRun = isIsoNextRun;
exports.header = header;
exports.__test = {
  setProcessOverride(fn) {
    processOverride = typeof fn === 'function' ? fn : null;
  },
};
