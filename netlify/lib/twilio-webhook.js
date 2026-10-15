'use strict';

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

function contentType(event) {
  return header(event, 'content-type').split(';')[0].trim().toLowerCase();
}

function signedWebhookUrl(policyUrl, event = {}) {
  const parsed = new URL(policyUrl);
  const rawQuery = String(event.rawQuery || '').replace(/^\?/, '');
  if (!rawQuery) return policyUrl;
  return `${parsed.origin}${parsed.pathname}?${rawQuery}`;
}

function validateTwilioWebhook(event, kind, env = process.env) {
  const policy = webhookPolicy(kind, env);
  if (!policy.ok) return { ok: false, reason: policy.reason, statusCode: 503 };
  const type = contentType(event);
  if (type && type !== 'application/x-www-form-urlencoded') {
    return { ok: false, reason: 'unsupported_content_type', statusCode: 403 };
  }
  const signature = header(event, 'x-twilio-signature');
  if (!signature) return { ok: false, reason: 'signature_missing', statusCode: 403 };
  const params = parseForm(event);
  const url = signedWebhookUrl(policy.url, event);
  // Loaded lazily, behind the policy gate — see twilio-provider.js.
  let twilio;
  try {
    twilio = require('twilio');
  } catch (e) {
    return { ok: false, reason: 'twilio_sdk_unavailable', statusCode: 503 };
  }
  const valid = twilio.validateRequest(policy.authToken, signature, url, params);
  if (!valid) return { ok: false, reason: 'invalid_signature', statusCode: 403 };
  return { ok: true, params, url };
}

module.exports = { header, parseForm, signedWebhookUrl, validateTwilioWebhook };
