'use strict';

/**
 * Square Sandbox reconciliation contract for Payments API V2.
 *
 * This is not the active payment provider and it is not the ledger.
 * getActivePaymentProvider() remains DisabledPaymentProvider. The contract
 * never writes a financial attempt or a ledger row, never marks a booking paid,
 * and never reads or writes the Square webhook event table.
 *
 * Square's Payment object exposes id, status, amount_money, location_id, and
 * an optional receipt_url. It does not carry a merchant field. Merchant
 * identity is the injected server configuration, paired with the trusted
 * location. This module does not call the Locations API and does not treat a
 * receipt URL as authentication.
 *
 * providerCompleted means Square reported COMPLETED and the V2 checks passed.
 * eligibleForReconciliation means a future settlement component may read it.
 * financiallySettled, paid, and the write flags stay false. Nothing here
 * persists an internal settlement.
 *
 * The booking reference is returned as server metadata. It is not sent to
 * Square, and a reference on the Payment is not adopted. A future settlement
 * step has to persist its own payment-to-booking association before it settles.
 *
 * Idempotency here follows the sandbox client's request key. The mock can
 * replay Square's same-key behavior. That replay is not a durable store.
 * Future money movement has to persist the operation identity first.
 *
 * The sandbox client still refuses amounts above 100000 cents. That figure is
 * a synthetic client cap, not a Cardetail1 price. This contract does not apply
 * it. Commercial amounts have to come from server-side obligations.
 *
 * The only Square host is the sandbox host already enforced by
 * SquareSandboxProvider. A caller cannot select the host or the environment.
 * Access tokens are never copied into the contract or logged.
 */

const {
  activePaymentProviderId,
} = require('./payment-provider-adapter');
const {
  LOCAL_CONFIRMATION,
  createSquareSandboxProvider,
  isProductionSquareUrl,
} = require('./square-sandbox-provider');

const CONTRACT_VERSION = 'square_sandbox_reconciliation_v1';
const TEST_CONTEXT = 'noncommercial-test';
const PURPOSE = 'sandbox_adapter_test';
const MERCHANT_PATTERN = /^MERCHANT_TEST_[A-Z0-9_]{1,48}$/;
const LOCATION_PATTERN = /^LOC_TEST_[A-Z0-9_]{1,40}$/;

const SQUARE_PAYMENT_STATES = Object.freeze({
  APPROVED: Object.freeze({ authorized: true, providerCompleted: false, eligibleForReconciliation: false }),
  PENDING: Object.freeze({ authorized: false, providerCompleted: false, eligibleForReconciliation: false }),
  COMPLETED: Object.freeze({ authorized: true, providerCompleted: true, eligibleForReconciliation: true }),
  CANCELED: Object.freeze({ authorized: false, providerCompleted: false, eligibleForReconciliation: false }),
  FAILED: Object.freeze({ authorized: false, providerCompleted: false, eligibleForReconciliation: false }),
});

function normalizeSquarePaymentStatus(status) {
  const token = String(status || '').trim().toUpperCase();
  const known = SQUARE_PAYMENT_STATES[token];
  if (!known) {
    return {
      status: token,
      recognized: false,
      authorized: false,
      providerCompleted: false,
      eligibleForReconciliation: false,
      financiallySettled: false,
    };
  }
  return {
    status: token,
    recognized: true,
    authorized: known.authorized,
    providerCompleted: known.providerCompleted,
    eligibleForReconciliation: known.eligibleForReconciliation,
    financiallySettled: false,
  };
}

function contractResult(fields = {}) {
  const normalized = fields.normalized || normalizeSquarePaymentStatus(fields.status);
  const identityAccepted = fields.identityAccepted === true;
  return {
    contract: CONTRACT_VERSION,
    ok: fields.ok === true,
    error: fields.error || '',
    statusCode: fields.statusCode == null ? 403 : fields.statusCode,
    operation: fields.operation || '',
    provider: 'square_sandbox',
    activeProvider: activePaymentProviderId(),
    environment: 'sandbox',
    testContext: fields.testContext || '',
    providerCalled: fields.providerCalled === true,
    externalCall: fields.externalCall === true,
    providerCompleted: normalized.providerCompleted === true && identityAccepted,
    eligibleForReconciliation: normalized.eligibleForReconciliation === true && identityAccepted,
    financiallySettled: false,
    settled: false,
    paid: false,
    authorized: normalized.authorized === true && identityAccepted,
    ledgerWrite: false,
    bookingWrite: false,
    bookingAssociationPersisted: false,
    notificationSent: false,
    databaseWrite: false,
    additionalCharge: false,
    idempotencyDurable: false,
    liveMerchantVerification: false,
    outcomeUnknown: fields.outcomeUnknown === true,
    paymentId: fields.paymentId || '',
    status: normalized.status || '',
    normalized,
    amountCents: Number.isInteger(fields.amountCents) ? fields.amountCents : null,
    currency: fields.currency || '',
    locationAccepted: fields.locationAccepted === true,
    merchantAccepted: fields.merchantAccepted === true,
    trustedMerchantId: fields.trustedMerchantId || '',
    trustedLocationId: fields.trustedLocationId || '',
    receiptMetadata: fields.receiptMetadata || 'absent',
    purpose: fields.purpose || '',
    serverBookingRef: fields.serverBookingRef || '',
    idempotencyKey: fields.idempotencyKey || '',
  };
}

function callerHostError(input) {
  if (!input || typeof input !== 'object') return '';
  const candidates = [input.host, input.baseUrl, input.url, input.squareHost];
  for (const value of candidates) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    if (isProductionSquareUrl(value) || value.includes('connect.squareup.com')) {
      return 'square_sandbox_production_host_forbidden';
    }
    return 'square_sandbox_host_not_caller_controlled';
  }
  if (input.squareEnv != null || input.apiEnvironment != null) {
    return 'square_sandbox_environment_not_caller_controlled';
  }
  return '';
}

function callerIdentitySpoof(input) {
  const merchantKeys = ['merchantId', 'expectedMerchantId'];
  const locationKeys = ['locationId', 'expectedLocationId'];
  if (merchantKeys.some((key) => input[key] != null && input[key] !== '')) {
    return 'square_sandbox_merchant_not_caller_controlled';
  }
  if (locationKeys.some((key) => input[key] != null && input[key] !== '')) {
    return 'square_sandbox_location_not_caller_controlled';
  }
  return '';
}

function trustedSandbox(input) {
  const spoof = callerIdentitySpoof(input);
  if (spoof) return { ok: false, error: spoof, statusCode: 403 };
  const trusted = input.trustedSandbox;
  if (!trusted || typeof trusted !== 'object' || trusted.configuredBy !== 'server') {
    return { ok: false, error: 'square_sandbox_merchant_untrusted', statusCode: 403 };
  }
  if (typeof trusted.locationId !== 'string' || !LOCATION_PATTERN.test(trusted.locationId)) {
    return { ok: false, error: 'square_sandbox_trusted_location_missing', statusCode: 403 };
  }
  if (typeof trusted.merchantId !== 'string' || !MERCHANT_PATTERN.test(trusted.merchantId)) {
    return { ok: false, error: 'square_sandbox_merchant_untrusted', statusCode: 403 };
  }
  if (trusted.locationMerchantId !== trusted.merchantId) {
    return { ok: false, error: 'square_sandbox_merchant_untrusted', statusCode: 403 };
  }
  return {
    ok: true,
    merchantId: trusted.merchantId,
    locationId: trusted.locationId,
  };
}

function validateRequest(operation, input) {
  const source = input && typeof input === 'object' ? input : {};
  const hostError = callerHostError(source);
  if (hostError) return { ok: false, error: hostError, statusCode: 403 };
  if (source.testContext !== TEST_CONTEXT) {
    return { ok: false, error: 'square_sandbox_test_context_required', statusCode: 403 };
  }
  if (source.confirmation !== LOCAL_CONFIRMATION) {
    return { ok: false, error: 'square_sandbox_confirmation_required', statusCode: 403 };
  }
  if (source.bookingId || source.booking) {
    return { ok: false, error: 'square_sandbox_booking_not_connected', statusCode: 409 };
  }
  if (source.purpose !== PURPOSE) {
    return { ok: false, error: 'square_sandbox_purpose_unrecognized', statusCode: 400 };
  }
  if (typeof source.serverBookingRef !== 'string' || !/^TEST-[A-Z0-9-]{1,32}$/.test(source.serverBookingRef)) {
    return { ok: false, error: 'square_sandbox_booking_ref_invalid', statusCode: 400 };
  }
  const trusted = trustedSandbox(source);
  if (!trusted.ok) return trusted;
  if (!Number.isInteger(source.amountCents) || source.amountCents <= 0) {
    return { ok: false, error: 'square_sandbox_amount_invalid', statusCode: 400 };
  }
  if (source.currency !== 'USD') {
    return { ok: false, error: 'square_sandbox_currency_invalid', statusCode: 400 };
  }
  if (operation === 'getPayment') {
    if (typeof source.paymentId !== 'string' || !/^[A-Za-z0-9]{8,80}$/.test(source.paymentId)) {
      return { ok: false, error: 'square_sandbox_payment_id_invalid', statusCode: 400 };
    }
  }
  return { ok: true, trusted };
}

function capturedResponse(capture) {
  if (!capture || typeof capture.text !== 'string' || capture.text === '') return null;
  try {
    const body = JSON.parse(capture.text);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

function identityFromPayment(payment, expected) {
  const id = payment && typeof payment.id === 'string' ? payment.id : '';
  const locationId = payment && typeof payment.location_id === 'string' ? payment.location_id : '';
  const amount = payment && payment.amount_money && Number.isInteger(payment.amount_money.amount)
    ? payment.amount_money.amount
    : null;
  const currency = payment && payment.amount_money && typeof payment.amount_money.currency === 'string'
    ? payment.amount_money.currency
    : '';
  const locationAccepted = locationId !== '' && locationId === expected.trustedLocationId;
  const amountAccepted = amount === expected.amountCents;
  const currencyAccepted = currency === 'USD';
  const idAccepted = /^[A-Za-z0-9]{8,80}$/.test(id)
    && (expected.paymentId ? id === expected.paymentId : true);
  return {
    id: idAccepted ? id : '',
    rawIdPresent: id !== '',
    locationAccepted,
    amountAccepted,
    currencyAccepted,
    idAccepted,
    amount,
    currency,
    accepted: idAccepted && locationAccepted && amountAccepted && currencyAccepted,
  };
}

function receiptMetadata(payment) {
  const receipt = payment && payment.receipt_url;
  if (receipt == null || receipt === '') return { accepted: true, classification: 'absent' };
  if (typeof receipt !== 'string') return { accepted: false, classification: 'rejected' };
  let url;
  try {
    url = new URL(receipt);
  } catch {
    return { accepted: false, classification: 'rejected' };
  }
  const host = url.hostname.toLowerCase();
  const sandboxHost = host === 'squareupsandbox.com' || host.endsWith('.squareupsandbox.com');
  const safe = url.protocol === 'https:'
    && sandboxHost
    && url.username === ''
    && url.password === ''
    && url.search === ''
    && url.hash === ''
    && url.pathname.startsWith('/receipt/');
  return { accepted: safe, classification: safe ? 'sandbox-url-accepted' : 'rejected' };
}

function contractErrorForHttp(statusCode) {
  if (statusCode === 400) return 'square_sandbox_bad_request';
  if (statusCode === 401) return 'square_sandbox_credentials_invalid';
  if (statusCode === 403) return 'square_sandbox_forbidden';
  if (statusCode === 404) return 'square_sandbox_not_found';
  if (statusCode === 409) return 'square_sandbox_conflict';
  if (statusCode === 429) return 'square_sandbox_rate_limited';
  if (statusCode >= 500 || statusCode === 0) return 'square_sandbox_unknown';
  return 'square_sandbox_invalid_response';
}

function applyProviderResult(operation, providerResult, capture, expected) {
  const shared = {
    operation,
    testContext: TEST_CONTEXT,
    purpose: PURPOSE,
    serverBookingRef: expected.serverBookingRef,
    idempotencyKey: providerResult.idempotencyKey || expected.idempotencyKey || '',
    providerCalled: providerResult.providerCalled === true,
    externalCall: providerResult.externalCall === true,
    statusCode: capture && capture.httpStatus ? capture.httpStatus : providerResult.statusCode,
    trustedMerchantId: expected.trustedMerchantId,
    trustedLocationId: expected.trustedLocationId,
  };
  if (!providerResult.providerCalled) {
    return contractResult({
      ...shared,
      error: providerResult.error || 'square_sandbox_rejected',
      outcomeUnknown: providerResult.outcomeUnknown === true,
    });
  }
  if (providerResult.error === 'square_sandbox_idempotency_conflict') {
    return contractResult({
      ...shared,
      error: 'square_sandbox_idempotency_conflict',
      outcomeUnknown: false,
    });
  }

  const httpStatus = capture && Number.isInteger(capture.httpStatus) ? capture.httpStatus : 0;
  const body = capturedResponse(capture);
  const payment = body && body.payment && typeof body.payment === 'object' ? body.payment : null;
  const normalized = normalizeSquarePaymentStatus(payment && payment.status);
  // Preserve the client's HTTP 2xx success contract. Payment-shaped error or
  // redirect bodies never become authoritative retrieval evidence.
  if (httpStatus < 200 || httpStatus >= 300) {
    return contractResult({
      ...shared,
      error: contractErrorForHttp(httpStatus),
      outcomeUnknown: httpStatus < 400 || httpStatus === 408 || httpStatus === 429 || httpStatus >= 500,
    });
  }
  const errorEnvelope = body && (
    (Object.prototype.hasOwnProperty.call(body, 'errors')
      && (!Array.isArray(body.errors) || body.errors.length > 0))
    || (Object.prototype.hasOwnProperty.call(body, 'error') && body.error != null && body.error !== '')
  );
  const contradictoryOutcome = normalized.status === 'COMPLETED'
    && (providerResult.declined === true
      || ['declined', 'rejected', 'idempotency_conflict'].includes(providerResult.outcome));
  if (errorEnvelope || contradictoryOutcome) {
    return contractResult({
      ...shared,
      error: providerResult.declined === true ? 'square_sandbox_declined' : 'square_sandbox_provider_error',
      outcomeUnknown: providerResult.declined !== true,
    });
  }
  if (!payment && providerResult.outcomeUnknown === true) {
    return contractResult({
      ...shared,
      error: providerResult.error || 'square_sandbox_unknown',
      outcomeUnknown: true,
    });
  }

  const identity = identityFromPayment(payment, expected);
  const receipt = receiptMetadata(payment);
  const matched = {
    normalized,
    amountCents: identity.amount,
    currency: identity.currency,
    locationAccepted: identity.locationAccepted,
    trustedMerchantId: expected.trustedMerchantId,
    trustedLocationId: expected.trustedLocationId,
  };
  if (!payment || !identity.rawIdPresent) {
    return contractResult({
      ...shared,
      ...matched,
      error: 'square_sandbox_payment_id_missing',
      statusCode: providerResult.statusCode || 502,
    });
  }
  if (!normalized.recognized) {
    return contractResult({
      ...shared,
      ...matched,
      error: 'square_sandbox_status_unknown',
      statusCode: providerResult.statusCode || 200,
      paymentId: identity.id,
    });
  }
  if (!identity.idAccepted) {
    return contractResult({
      ...shared,
      ...matched,
      error: 'square_sandbox_identity_mismatch',
      statusCode: providerResult.statusCode || 409,
      outcomeUnknown: true,
    });
  }
  if (!identity.amountAccepted) {
    return contractResult({
      ...shared,
      ...matched,
      error: 'square_sandbox_amount_mismatch',
      statusCode: providerResult.statusCode || 409,
      paymentId: identity.id,
      outcomeUnknown: true,
    });
  }
  if (!identity.currencyAccepted) {
    return contractResult({
      ...shared,
      ...matched,
      error: 'square_sandbox_currency_mismatch',
      statusCode: providerResult.statusCode || 409,
      paymentId: identity.id,
      outcomeUnknown: true,
    });
  }
  if (!identity.locationAccepted) {
    return contractResult({
      ...shared,
      ...matched,
      error: 'square_sandbox_location_mismatch',
      statusCode: providerResult.statusCode || 409,
      paymentId: identity.id,
      outcomeUnknown: true,
    });
  }
  if (!receipt.accepted) {
    return contractResult({
      ...shared,
      ...matched,
      error: 'square_sandbox_receipt_rejected',
      statusCode: providerResult.statusCode || 409,
      paymentId: identity.id,
      receiptMetadata: 'rejected',
      locationAccepted: true,
      outcomeUnknown: true,
    });
  }

  const terminalFailure = normalized.status === 'FAILED' || normalized.status === 'CANCELED';
  return contractResult({
    ...shared,
    ...matched,
    ok: !terminalFailure,
    error: terminalFailure ? 'square_sandbox_not_settled' : '',
    statusCode: providerResult.statusCode || 200,
    paymentId: identity.id,
    locationAccepted: true,
    merchantAccepted: true,
    identityAccepted: true,
    receiptMetadata: receipt.classification,
    outcomeUnknown: false,
  });
}

function capturingFetch(fetchImpl, capture) {
  return async (url, init) => {
    capture.url = String(url);
    capture.method = init && init.method;
    capture.requestBody = init && init.body;
    const response = await fetchImpl(url, init);
    const text = response && typeof response.text === 'function' ? await response.text() : '';
    capture.httpStatus = response && response.status;
    capture.text = text;
    return {
      status: response && response.status,
      async text() { return text; },
    };
  };
}

function providerFor(input, fetchImpl) {
  return createSquareSandboxProvider({
    env: input.env || {},
    fetchImpl,
    confirmation: input.confirmation,
    timeoutMs: input.timeoutMs,
  });
}

function refusedResult(operation, input, refused) {
  return contractResult({
    operation,
    error: refused.error,
    statusCode: refused.statusCode,
    testContext: input.testContext === TEST_CONTEXT ? TEST_CONTEXT : '',
    purpose: input.purpose === PURPOSE ? PURPOSE : '',
    serverBookingRef: typeof input.serverBookingRef === 'string' ? input.serverBookingRef : '',
    idempotencyKey: typeof input.idempotencyKey === 'string' ? input.idempotencyKey : '',
  });
}

function expectedFrom(input, trusted) {
  return {
    amountCents: input.amountCents,
    currency: 'USD',
    serverBookingRef: input.serverBookingRef,
    idempotencyKey: input.idempotencyKey,
    trustedLocationId: trusted.locationId,
    trustedMerchantId: trusted.merchantId,
    paymentId: input.paymentId,
  };
}

async function createSimulatedPayment(input = {}) {
  const refused = validateRequest('createPayment', input);
  if (!refused.ok) return refusedResult('createPayment', input, refused);
  const capture = {};
  const provider = providerFor(input, capturingFetch(input.fetchImpl, capture));
  let providerResult;
  try {
    providerResult = await provider.createPayment({
      amountCents: input.amountCents,
      currency: input.currency,
      sourceId: input.sourceId,
      idempotencyKey: input.idempotencyKey,
    });
  } catch {
    return contractResult({
      operation: 'createPayment',
      error: 'square_sandbox_unknown',
      statusCode: 503,
      outcomeUnknown: true,
      providerCalled: true,
      testContext: TEST_CONTEXT,
      purpose: PURPOSE,
      serverBookingRef: input.serverBookingRef,
      idempotencyKey: input.idempotencyKey,
    });
  }
  return applyProviderResult('createPayment', providerResult, capture, expectedFrom(input, refused.trusted));
}

async function retrieveSimulatedPayment(input = {}) {
  const refused = validateRequest('getPayment', input);
  if (!refused.ok) return refusedResult('getPayment', input, refused);
  const capture = {};
  const provider = providerFor(input, capturingFetch(input.fetchImpl, capture));
  let providerResult;
  try {
    providerResult = await provider.getPayment({ paymentId: input.paymentId });
  } catch {
    return contractResult({
      operation: 'getPayment',
      error: 'square_sandbox_unknown',
      statusCode: 503,
      outcomeUnknown: true,
      providerCalled: true,
      testContext: TEST_CONTEXT,
      purpose: PURPOSE,
      serverBookingRef: input.serverBookingRef,
      idempotencyKey: input.idempotencyKey || '',
    });
  }
  return applyProviderResult('getPayment', providerResult, capture, expectedFrom(input, refused.trusted));
}

module.exports = {
  CONTRACT_VERSION,
  TEST_CONTEXT,
  PURPOSE,
  SQUARE_PAYMENT_STATES,
  normalizeSquarePaymentStatus,
  createSimulatedPayment,
  retrieveSimulatedPayment,
};
