'use strict';

const crypto = require('crypto');
const { processSmsOutbox } = require('../lib/sms-outbox');
const { outboundTwilioPolicy } = require('../lib/twilio-runtime-policy');

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

exports.handler = async (event = {}) => {
  const policy = outboundTwilioPolicy(process.env);
  if (!policy.ok) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: true, disabled: true, reason: policy.reason, processed: 0 }),
    };
  }
  // Netlify injects next_run for a genuine scheduled invocation. Never trust a
  // caller-controlled header as a scheduler identity.
  const scheduled = typeof event.next_run === 'string' && event.next_run.length > 0;
  if (!scheduled) {
    const expected = String(process.env.TWILIO_WORKER_SECRET || '');
    const supplied = header(event, 'x-worker-secret');
    if (!secretMatches(expected, supplied)) {
      return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'unauthorized' }) };
    }
  }
  const result = await processSmsOutbox({ limit: 10 });
  return {
    statusCode: result.ok ? 200 : 503,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      ok: result.ok,
      disabled: !!result.disabled,
      reason: result.reason || null,
      processed: result.processed || 0,
    }),
  };
};

exports.config = { schedule: '*/2 * * * *' };
exports.secretMatches = secretMatches;
