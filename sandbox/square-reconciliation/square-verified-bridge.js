'use strict';

/**
 * Isolated bridge from a verified Square webhook fixture to sandbox settlement.
 *
 * Signature checks reuse verifySquareWebhookSignature. Interpretation reuses
 * interpretVerifiedSquareWebhook. Money movement reuses the sandbox settlement
 * service. This module does not implement a second HMAC, does not register a
 * notification URL, and does not replace the published sandbox webhook receiver.
 *
 * A webhook becomes eligible for settlement only after all of these are true:
 * the raw body matches the signature over the trusted notification URL, the
 * merchant matches trusted server configuration, a payment operation was
 * already stored, and the injected GetPayment mock returns that same payment
 * as COMPLETED. Event type and timestamp are observations. They do not settle.
 *
 * The signing key is a synthetic test value supplied by the caller. This
 * module does not read environment variables and does not retrieve a Square key.
 * Retrieval uses the payment id stored on the operation. The mock is injected.
 * There is no path to global fetch.
 */

const { verifySquareWebhookSignature } = require('../../netlify/lib/square-webhook-verifier');
const { interpretVerifiedSquareWebhook } = require('../../netlify/lib/square-webhook-event');
const { TEST_CONTEXT } = require('../../netlify/lib/square-sandbox-adapter-contract');
const {
  associatePayment,
  ingestObservation,
} = require('../square-settlement/square-sandbox-settlement');

const SANDBOX_ORIGIN = 'https://connect.squareupsandbox.com';
const SYNTHETIC_KEY_PATTERN = /^synthetic-square-webhook-[A-Za-z0-9_-]{12,80}$/;
const MERCHANT_PATTERN = /^MERCHANT_TEST_[A-Z0-9_]{1,48}$/;
const LOCATION_PATTERN = /^LOC_TEST_[A-Z0-9_]{1,40}$/;
const SYNTHETIC_RETRIEVAL_TOKEN = 'synthetic-square-sandbox-token-7e-not-real-0001';

const CALLER_AUTHORITY = new Set([
  'sourceKind',
  'configuredBy',
  'authenticated',
  'verified',
  'verification',
  'verificationBypass',
  'bypassVerification',
  'financiallySettled',
  'settlementCommitted',
  'settlementAuthorized',
  'providerCompleted',
  'eligibleForReconciliation',
  'trusted',
  'paid',
  'hmacValid',
  'signatureValid',
  'host',
  'baseUrl',
  'squareHost',
  'url',
  'env',
  'payment',
  'receipt_url',
  'receiptUrl',
]);

function bridgeResult(error, extra = {}) {
  return {
    result: extra.result || 'rejected',
    operationId: extra.operationId || '',
    obligationId: extra.obligationId || '',
    squarePaymentId: extra.squarePaymentId || '',
    processingStatus: extra.processingStatus || 'rejected',
    settlementStatus: 'none',
    providerCompleted: false,
    financiallySettled: false,
    settlementCommitted: false,
    paid: false,
    ledgerWrite: false,
    bookingWrite: false,
    commercialDatabaseWrite: false,
    retrySafe: extra.retrySafe === true,
    error,
    signatureAccepted: extra.signatureAccepted === true,
    externalCall: false,
  };
}

function annotate(outcome, signatureAccepted) {
  const source = outcome && typeof outcome === 'object' ? outcome : {};
  return {
    ...source,
    paid: false,
    ledgerWrite: false,
    bookingWrite: false,
    commercialDatabaseWrite: false,
    signatureAccepted: signatureAccepted === true,
    externalCall: false,
  };
}

function ownBlockedKey(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return '';
  const keys = Object.keys(source);
  for (let i = 0; i < keys.length; i += 1) {
    if (CALLER_AUTHORITY.has(keys[i])) return keys[i];
  }
  return '';
}

function blockCallerAuthority(input) {
  if (ownBlockedKey(input)) return 'square_bridge_authentication_marker_rejected';
  if (ownBlockedKey(input.trustedSandbox)) return 'square_bridge_authentication_marker_rejected';
  return '';
}

function readTrusted(input) {
  const blocked = blockCallerAuthority(input);
  if (blocked) return { ok: false, error: blocked };
  if (!input || input.testContext !== TEST_CONTEXT) {
    return { ok: false, error: 'square_bridge_test_context_required' };
  }
  const trusted = input.trustedSandbox;
  if (!trusted || typeof trusted !== 'object') {
    return { ok: false, error: 'square_bridge_merchant_untrusted' };
  }
  if (typeof trusted.merchantId !== 'string' || !MERCHANT_PATTERN.test(trusted.merchantId)) {
    return { ok: false, error: 'square_bridge_merchant_untrusted' };
  }
  if (typeof trusted.locationId !== 'string' || !LOCATION_PATTERN.test(trusted.locationId)) {
    return { ok: false, error: 'square_bridge_location_untrusted' };
  }
  if (trusted.locationMerchantId !== trusted.merchantId) {
    return { ok: false, error: 'square_bridge_merchant_untrusted' };
  }
  return { ok: true, merchantId: trusted.merchantId, locationId: trusted.locationId };
}

function readSyntheticKey(signatureKey) {
  if (typeof signatureKey !== 'string' || !SYNTHETIC_KEY_PATTERN.test(signatureKey)) {
    return { ok: false, error: 'square_bridge_signature_key_not_synthetic' };
  }
  return { ok: true, value: signatureKey };
}

function trustedSandbox(trusted) {
  return {
    merchantId: trusted.merchantId,
    locationId: trusted.locationId,
    locationMerchantId: trusted.merchantId,
  };
}

function guardRetrieval(fetchImpl) {
  if (fetchImpl === globalThis.fetch) {
    return async () => {
      throw new Error('square_bridge_network_forbidden');
    };
  }
  return async (url, init) => {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      throw new Error('square_bridge_host_rejected');
    }
    const method = init && init.method ? String(init.method).toUpperCase() : '';
    if (
      parsed.origin !== SANDBOX_ORIGIN
      || parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || parsed.search
      || method !== 'GET'
      || !/^\/v2\/payments\/[A-Za-z0-9]{8,80}$/.test(parsed.pathname)
    ) {
      throw new Error('square_bridge_retrieval_rejected');
    }
    return fetchImpl(url, init);
  };
}

function providerOptions(input) {
  if (typeof input.fetchImpl !== 'function') return {};
  const options = {
    fetchImpl: guardRetrieval(input.fetchImpl),
    env: { SQUARE_SANDBOX_ACCESS_TOKEN: SYNTHETIC_RETRIEVAL_TOKEN },
    timeoutMs: Number.isInteger(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : 50,
  };
  if (input.fault === 'before_commit') options.fault = 'before_commit';
  return options;
}

function authenticateFixture(input, trusted) {
  const key = readSyntheticKey(input.signatureKey);
  if (!key.ok) return { ok: false, error: key.error, signatureAccepted: false };
  const verification = verifySquareWebhookSignature({
    rawBody: input.rawBody,
    signatureKey: key.value,
    notificationUrl: input.notificationUrl,
    headers: input.headers,
  });
  if (verification.verified !== true) {
    return {
      ok: false,
      error: verification.error || 'square_webhook_signature_invalid',
      signatureAccepted: false,
    };
  }
  const interpreted = interpretVerifiedSquareWebhook({
    rawBody: input.rawBody,
    verification,
    expectedMerchantId: trusted.merchantId,
  });
  if (
    interpreted.bound !== true
    || interpreted.verified !== true
    || interpreted.ok !== true
    || interpreted.recognized !== true
    || interpreted.unknownEvent === true
  ) {
    return {
      ok: false,
      error: interpreted.error || 'square_webhook_event_unsupported',
      signatureAccepted: true,
      squarePaymentId: interpreted.paymentId || '',
    };
  }
  let payload;
  try {
    const text = Buffer.isBuffer(input.rawBody) ? input.rawBody.toString('utf8') : input.rawBody;
    payload = JSON.parse(text);
  } catch {
    return { ok: false, error: 'square_webhook_payload_invalid', signatureAccepted: true };
  }
  const payment = payload
    && payload.data
    && payload.data.object
    && payload.data.object.payment;
  if (!payment || typeof payment !== 'object') {
    return { ok: false, error: 'square_webhook_payload_incomplete', signatureAccepted: true };
  }
  if (payment.location_id != null && payment.location_id !== '' && payment.location_id !== trusted.locationId) {
    return {
      ok: false,
      error: 'square_bridge_location_untrusted',
      signatureAccepted: true,
      squarePaymentId: interpreted.paymentId,
    };
  }
  return {
    ok: true,
    signatureAccepted: true,
    eventId: interpreted.eventId,
    eventType: interpreted.type,
    squarePaymentId: interpreted.paymentId,
    merchantId: interpreted.merchantId,
    locationId: trusted.locationId,
    paymentStatus: interpreted.status,
    amountCents: interpreted.amountCents,
    currency: interpreted.currency,
    observedAt: interpreted.createdAt,
  };
}

async function receiveVerifiedWebhook(connectionString, input = {}) {
  const trusted = readTrusted(input);
  if (!trusted.ok) return bridgeResult(trusted.error);
  if (
    input.merchantId
    || input.locationId
    || input.expectedMerchantId
    || input.expectedLocationId
    || input.operationId
    || input.obligationId
    || input.squarePaymentId
    || input.paymentId
    || input.referenceId
    || input.reference_id
    || input.bookingId
    || input.booking
    || input.bookingRef
  ) {
    return bridgeResult('square_bridge_webhook_cannot_select_operation');
  }
  const authenticated = authenticateFixture(input, trusted);
  if (!authenticated.ok) {
    return bridgeResult(authenticated.error, {
      signatureAccepted: authenticated.signatureAccepted === true,
      squarePaymentId: authenticated.squarePaymentId || '',
    });
  }
  try {
    const outcome = await ingestObservation(connectionString, {
      testContext: TEST_CONTEXT,
      trustedSandbox: trustedSandbox(trusted),
      eventId: authenticated.eventId,
      eventType: authenticated.eventType,
      squarePaymentId: authenticated.squarePaymentId,
      merchantId: authenticated.merchantId,
      locationId: authenticated.locationId,
      paymentStatus: authenticated.paymentStatus,
      amountCents: authenticated.amountCents,
      currency: authenticated.currency,
      observedAt: authenticated.observedAt,
      ...providerOptions(input),
    });
    return annotate(outcome, true);
  } catch {
    return bridgeResult('square_bridge_failed', {
      result: 'failed',
      squarePaymentId: authenticated.squarePaymentId,
      retrySafe: true,
      signatureAccepted: true,
    });
  }
}

async function associateTrustedPayment(connectionString, input = {}) {
  const trusted = readTrusted(input);
  if (!trusted.ok) return bridgeResult(trusted.error);
  if (
    input.rawBody
    || input.headers
    || input.signatureKey
    || input.notificationUrl
    || input.referenceId
    || input.reference_id
    || input.bookingId
    || input.booking
    || input.bookingRef
    || input.merchantId
    || input.locationId
  ) {
    return bridgeResult('square_bridge_association_not_a_webhook');
  }
  if (typeof input.operationId !== 'string' || typeof input.squarePaymentId !== 'string') {
    return bridgeResult('square_bridge_association_incomplete');
  }
  try {
    const outcome = await associatePayment(connectionString, {
      testContext: TEST_CONTEXT,
      trustedSandbox: trustedSandbox(trusted),
      operationId: input.operationId,
      squarePaymentId: input.squarePaymentId,
      ...providerOptions(input),
    });
    return annotate(outcome, false);
  } catch {
    return bridgeResult('square_bridge_failed', {
      result: 'failed',
      operationId: input.operationId,
      squarePaymentId: input.squarePaymentId,
      retrySafe: true,
    });
  }
}

module.exports = {
  SYNTHETIC_RETRIEVAL_TOKEN,
  associateTrustedPayment,
  receiveVerifiedWebhook,
};
