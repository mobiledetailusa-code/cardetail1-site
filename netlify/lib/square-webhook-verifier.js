'use strict';

/**
 * Square webhook signature check.
 *
 * Square signs the exact notification URL concatenated with the raw request
 * body, using HMAC-SHA256 and the webhook signature key. The digest is
 * base64. The header is x-square-hmacsha256-signature.
 *
 * This module does not parse JSON, read a Host header, call the network, or
 * write a financial row. It does not register a notification URL. The URL and
 * the key are arguments from trusted configuration or from a test. Production
 * hosts are rejected so this phase cannot be pointed at cardetail1.com.
 */

const crypto = require('crypto');

const SIGNATURE_HEADER = 'x-square-hmacsha256-signature';

const REJECTED_HOSTS = new Set([
  'cardetail1.com',
  'www.cardetail1.com',
  'connect.squareup.com',
  'connect.squareupsandbox.com',
]);

function failure(error) {
  return {
    ok: false,
    verified: false,
    parsed: false,
    error,
    statusCode: 403,
    header: SIGNATURE_HEADER,
    financialEffect: 'none',
    externalCall: false,
    ledgerWrite: false,
    chargeAuthorized: false,
    paymentConfirmed: false,
    paid: false,
    created: false,
    effectsExecuted: [],
  };
}

function rawBodyBuffer(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (typeof rawBody === 'string') return Buffer.from(rawBody, 'utf8');
  return null;
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return '';
  const target = name.toLowerCase();
  const keys = Object.keys(headers);
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i].toLowerCase() !== target) continue;
    const value = headers[keys[i]];
    if (Array.isArray(value)) return value[0] == null ? '' : String(value[0]);
    return value == null ? '' : String(value);
  }
  return '';
}

function assessNotificationUrl(notificationUrl) {
  if (typeof notificationUrl !== 'string' || notificationUrl.length === 0) {
    return { ok: false, error: 'square_webhook_notification_url_missing' };
  }
  let parsed;
  try {
    parsed = new URL(notificationUrl);
  } catch {
    return { ok: false, error: 'square_webhook_notification_url_rejected' };
  }
  const host = parsed.hostname.toLowerCase();
  const productionHost = host === 'cardetail1.com' || host.endsWith('.cardetail1.com');
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || productionHost
    || REJECTED_HOSTS.has(host)
  ) {
    return { ok: false, error: 'square_webhook_notification_url_rejected' };
  }
  return { ok: true, url: notificationUrl };
}

function resolveSignature(input) {
  if (Object.prototype.hasOwnProperty.call(input, 'signature')) {
    return typeof input.signature === 'string' && input.signature.length > 0
      ? input.signature
      : null;
  }
  const fromHeader = headerValue(input.headers, SIGNATURE_HEADER);
  return fromHeader.length > 0 ? fromHeader : null;
}

function signaturesMatch(expected, provided) {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(provided, 'utf8');
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function squareWebhookBodySha256(rawBody) {
  const raw = rawBodyBuffer(rawBody);
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function verifySquareWebhookSignature(input = {}) {
  const raw = rawBodyBuffer(input.rawBody);
  if (!raw) return failure('square_webhook_body_unusable');

  const urlCheck = assessNotificationUrl(input.notificationUrl);
  if (!urlCheck.ok) return failure(urlCheck.error);

  if (typeof input.signatureKey !== 'string' || input.signatureKey.length === 0) {
    return failure('square_webhook_signature_key_missing');
  }

  const signature = resolveSignature(input);
  if (!signature) return failure('square_webhook_signature_missing');

  const expected = crypto
    .createHmac('sha256', input.signatureKey)
    .update(Buffer.concat([Buffer.from(urlCheck.url, 'utf8'), raw]))
    .digest('base64');

  if (!signaturesMatch(expected, signature)) {
    return failure('square_webhook_signature_invalid');
  }

  return {
    ok: true,
    verified: true,
    parsed: false,
    error: null,
    statusCode: null,
    header: SIGNATURE_HEADER,
    bodySha256: crypto.createHash('sha256').update(raw).digest('hex'),
    financialEffect: 'none',
    externalCall: false,
    ledgerWrite: false,
    chargeAuthorized: false,
    paymentConfirmed: false,
    paid: false,
    created: false,
    effectsExecuted: [],
  };
}

module.exports = {
  SIGNATURE_HEADER,
  assessNotificationUrl,
  rawBodyBuffer,
  signaturesMatch,
  squareWebhookBodySha256,
  verifySquareWebhookSignature,
};
