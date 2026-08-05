'use strict';

const twilio = require('twilio');
const { webhookPolicy } = require('./twilio-runtime-policy');

function header(event, name) {
  const want = String(name).toLowerCase();
  for (const [key, value] of Object.entries(event?.headers || {})) {
    if (String(key).toLowerCase() === want) return String(value || '');
  }
  return '';
}

function parseForm(event) {
  const body = event?.isBase64Encoded
    ? Buffer.from(String(event.body || ''), 'base64').toString('utf8')
    : String(event?.body || '');
  const params = {};
  for (const [key, value] of new URLSearchParams(body)) params[key] = value;
  return params;
}

function validateTwilioWebhook(event, kind, env = process.env) {
  const policy = webhookPolicy(kind, env);
  if (!policy.ok) return { ok: false, reason: policy.reason, statusCode: 503 };
  const signature = header(event, 'x-twilio-signature');
  if (!signature) return { ok: false, reason: 'signature_missing', statusCode: 403 };
  const params = parseForm(event);
  const valid = twilio.validateRequest(policy.authToken, signature, policy.url, params);
  if (!valid) return { ok: false, reason: 'invalid_signature', statusCode: 403 };
  return { ok: true, params, url: policy.url };
}

module.exports = { header, parseForm, validateTwilioWebhook };
