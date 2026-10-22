'use strict';

const { verifySquareWebhookSignature } = require('../../../../netlify/lib/square-webhook-verifier');
const { interpretVerifiedSquareWebhook } = require('../../../../netlify/lib/square-webhook-event');
const { assessSandboxWebhookEnvironment } = require('../../lib/square-sandbox-webhook-gate');
const {
  connectSandboxPostgres,
  insertSquareSandboxWebhookEvent,
} = require('../../lib/square-sandbox-webhook-store');

const MAX_BODY_BYTES = 1024 * 1024;

function respond(statusCode, error, extra) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
    body: JSON.stringify({
      ok: statusCode >= 200 && statusCode < 300,
      error: error || null,
      financialEffect: 'none',
      paymentConfirmed: false,
      ...extra,
    }),
  };
}

function sanitizeLogToken(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 128);
}

function logDelivery(record) {
  const line = { source: 'square-sandbox-webhook', result: sanitizeLogToken(record.result) };
  if (record.authenticated) {
    if (record.eventId) line.eventId = sanitizeLogToken(record.eventId);
    if (record.type) line.type = sanitizeLogToken(record.type);
  }
  console.log(JSON.stringify(line));
}

function decodeRawBody(event) {
  const body = event && event.body != null ? String(event.body) : '';
  if (event && event.isBase64Encoded === true) return Buffer.from(body, 'base64');
  return Buffer.from(body, 'utf8');
}

function processingStateFor(event, merchantId) {
  if (event.merchantId !== merchantId) return 'rejected_merchant';
  if (event.unknownEvent || event.recognized !== true) return 'unsupported';
  return 'stored';
}

async function handleSquareSandboxWebhook(event, deps = {}) {
  const method = String(event && event.httpMethod || '').toUpperCase();
  if (method !== 'POST') {
    logDelivery({ result: 'method_not_allowed' });
    return respond(405, 'square_sandbox_webhook_method_not_allowed');
  }

  let raw;
  try {
    raw = decodeRawBody(event);
  } catch {
    logDelivery({ result: 'body_unreadable' });
    return respond(400, 'square_sandbox_webhook_body_unusable');
  }
  if (raw.length > MAX_BODY_BYTES) {
    logDelivery({ result: 'payload_too_large' });
    return respond(413, 'square_sandbox_webhook_payload_too_large');
  }

  const config = assessSandboxWebhookEnvironment(deps.env || process.env);
  if (!config.ok) {
    logDelivery({ result: 'not_configured' });
    return respond(503, 'square_sandbox_webhook_not_configured');
  }

  const verification = verifySquareWebhookSignature({
    rawBody: raw,
    signatureKey: config.signatureKey,
    notificationUrl: config.notificationUrl,
    headers: event.headers,
  });
  if (!verification.verified) {
    logDelivery({
      result: verification.error === 'square_webhook_signature_missing'
        ? 'signature_missing'
        : 'signature_invalid',
    });
    return respond(403, verification.error || 'square_webhook_signature_invalid');
  }

  const interpreted = interpretVerifiedSquareWebhook({ rawBody: raw, verification });
  if (!interpreted.eventId) {
    logDelivery({ authenticated: true, result: 'event_id_missing', type: interpreted.type });
    return respond(400, 'square_sandbox_webhook_event_id_missing');
  }
  if (interpreted.incomplete || interpreted.verified !== true || interpreted.bound !== true) {
    logDelivery({
      authenticated: true,
      result: 'event_invalid',
      eventId: interpreted.eventId,
      type: interpreted.type,
    });
    return respond(400, 'square_sandbox_webhook_event_invalid');
  }

  const processingState = processingStateFor(interpreted, config.merchantId);
  const row = {
    eventId: interpreted.eventId,
    merchantId: interpreted.merchantId,
    eventType: interpreted.type,
    paymentId: interpreted.paymentId || null,
    paymentStatus: interpreted.status || null,
    eventCreatedAt: interpreted.createdAt || null,
    processingState,
    amountCents: interpreted.amountCents,
    currency: interpreted.currency || null,
  };

  let stored;
  let client;
  try {
    client = deps.query
      ? { query: deps.query }
      : await (deps.connectImpl || connectSandboxPostgres)(config.databaseUrl);
    stored = await insertSquareSandboxWebhookEvent(client, row);
  } catch {
    logDelivery({
      authenticated: true,
      result: 'persistence_unavailable',
      eventId: interpreted.eventId,
      type: interpreted.type,
    });
    return respond(503, 'square_sandbox_webhook_persistence_unavailable');
  } finally {
    if (client && !deps.query && typeof client.end === 'function') {
      try { await client.end(); } catch { /* the HTTP result is already decided */ }
    }
  }

  if (!stored.inserted) {
    logDelivery({
      authenticated: true,
      result: 'duplicate',
      eventId: interpreted.eventId,
      type: interpreted.type,
    });
    return respond(200, null, {
      result: 'duplicate',
      duplicate: true,
      eventId: interpreted.eventId,
    });
  }

  logDelivery({
    authenticated: true,
    result: processingState,
    eventId: interpreted.eventId,
    type: interpreted.type,
  });
  return respond(200, null, {
    result: processingState,
    duplicate: false,
    eventId: interpreted.eventId,
  });
}

exports.handler = function handler(event) {
  return handleSquareSandboxWebhook(event);
};

exports.__test = {
  MAX_BODY_BYTES,
  decodeRawBody,
  handleSquareSandboxWebhook,
};
