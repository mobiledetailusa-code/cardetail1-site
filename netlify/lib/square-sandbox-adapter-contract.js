'use strict';

/**
 * Square Sandbox reconciliation contract.
 *
 * This is not the active payment provider and it is not the ledger.
 * getActivePaymentProvider() remains DisabledPaymentProvider. The contract
 * never writes a financial attempt or a ledger row, never marks a booking paid,
 * and never reads or writes the Square webhook event table.
 *
 * A future settlement component may read the returned contract. The webhook
 * receiver can later be compared by the same payment id, location id,
 * merchant id, amount, currency, and Square status. This module does not
 * import the receiver, and the receiver does not import this module.
 *
 * The only Square host is the sandbox host already enforced by
 * SquareSandboxProvider. Production https://connect.squareup.com is rejected.
 * Access tokens are never copied into the contract or logged.
 */

const {
  activePaymentProviderId,
} = require('./payment-provider-adapter');
const {
  LOCAL_CONFIRMATION,
  PRODUCTION_ORIGIN,
  createSquareSandboxProvider,
  isProductionSquareUrl,
} = require('./square-sandbox-provider');

const CONTRACT_VERSION = 'square_sandbox_reconciliation_v1';
const TEST_CONTEXT = 'noncommercial-test';
const PURPOSE = 'sandbox_adapter_test';

const SQUARE_PAYMENT_STATES = Object.freeze({
  APPROVED: Object.freeze({ authorized: true, settled: false }),
  PENDING: Object.freeze({ authorized: false, settled: false }),
  COMPLETED: Object.freeze({ authorized: true, settled: false }),
  CANCELED: Object.freeze({ authorized: false, settled: false }),
  FAILED: Object.freeze({ authorized: false, settled: false }),
});

function normalizeSquarePaymentStatus(status) {
  const token = String(status || '').trim().toUpperCase();
  const known = SQUARE_PAYMENT_STATES[token];
  if (!known) {
    return {
      status: token,
      recognized: false,
      authorized: false,
      settled: false,
      eligibleForReconciliation: false,
    };
  }
  const eligibleForReconciliation = token === 'COMPLETED';
  return {
    status: token,
    recognized: true,
    authorized: known.authorized,
    settled: eligibleForReconciliation,
    eligibleForReconciliation,
  };
}

function contractResult(fields = {}) {
  const normalized = fields.normalized || normalizeSquarePaymentStatus(fields.status);
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
    paid: false,
    settled: normalized.settled === true && fields.identityAccepted === true,
    authorized: normalized.authorized === true && fields.identityAccepted === true,
    eligibleForReconciliation: normalized.eligibleForReconciliation === true
      && fields.identityAccepted === true,
    ledgerWrite: false,
    bookingWrite: false,
    notificationSent: false,
    databaseWrite: false,
    additionalCharge: false,
    outcomeUnknown: fields.outcomeUnknown === true,
    paymentId: fields.paymentId || '',
    status: normalized.status || '',
    normalized,
    amountCents: Number.isInteger(fields.amountCents) ? fields.amountCents : null,
    currency: fields.currency || '',
    locationAccepted: fields.locationAccepted === true,
    merchantAccepted: fields.merchantAccepted === true,
    purpose: fields.purpose || '',
    serverBookingRef: fields.serverBookingRef || '',
    idempotencyKey: fields.idempotencyKey || '',
  };
}

function productionHostRefused(input) {
  if (!input || typeof input !== 'object') return false;
  const candidates = [input.host, input.baseUrl, input.url, input.squareHost];
  return candidates.some((value) => {
    if (typeof value !== 'string' || value.trim() === '') return false;
    return isProductionSquareUrl(value) || value.includes('connect.squareup.com') || value.includes(PRODUCTION_ORIGIN);
  });
}

function validateRequest(operation, input) {
  const source = input && typeof input === 'object' ? input : {};
  if (productionHostRefused(source)) {
    return { ok: false, error: 'square_sandbox_production_host_forbidden', statusCode: 403 };
  }
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
  if (typeof source.expectedLocationId !== 'string' || !/^LOC_TEST_[A-Z0-9_]{1,40}$/.test(source.expectedLocationId)) {
    return { ok: false, error: 'square_sandbox_location_invalid', statusCode: 400 };
  }
  if (typeof source.expectedMerchantId !== 'string' || !/^MERCHANT_TEST_[A-Z0-9_]{1,48}$/.test(source.expectedMerchantId)) {
    return { ok: false, error: 'square_sandbox_merchant_invalid', statusCode: 400 };
  }
  if (!Number.isInteger(source.amountCents) || source.amountCents <= 0 || source.amountCents > 100000) {
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
  return { ok: true };
}

function capturedPayment(capture) {
  if (!capture || typeof capture.text !== 'string' || capture.text === '') return null;
  try {
    const body = JSON.parse(capture.text);
    return body && body.payment && typeof body.payment === 'object' ? body.payment : null;
  } catch {
    return null;
  }
}

function identityFromPayment(payment, expected) {
  const id = payment && typeof payment.id === 'string' ? payment.id : '';
  const locationId = payment && typeof payment.location_id === 'string' ? payment.location_id : '';
  const merchantId = payment && typeof payment.merchant_id === 'string' ? payment.merchant_id : '';
  const amount = payment && payment.amount_money && Number.isInteger(payment.amount_money.amount)
    ? payment.amount_money.amount
    : null;
  const currency = payment && payment.amount_money && typeof payment.amount_money.currency === 'string'
    ? payment.amount_money.currency
    : '';
  const locationAccepted = locationId !== '' && locationId === expected.expectedLocationId;
  const merchantAccepted = merchantId !== '' && merchantId === expected.expectedMerchantId;
  const amountAccepted = amount === expected.amountCents;
  const currencyAccepted = currency === 'USD';
  const idAccepted = /^[A-Za-z0-9]{8,80}$/.test(id)
    && (expected.paymentId ? id === expected.paymentId : true);
  return {
    id: idAccepted ? id : '',
    rawIdPresent: id !== '',
    locationAccepted,
    merchantAccepted,
    amountAccepted,
    currencyAccepted,
    idAccepted,
    amount,
    currency,
    accepted: idAccepted && locationAccepted && merchantAccepted && amountAccepted && currencyAccepted,
  };
}

function contractErrorForHttp(statusCode) {
  if (statusCode === 400) return 'square_sandbox_bad_request';
  if (statusCode === 401) return 'square_sandbox_credentials_invalid';
  if (statusCode === 403) return 'square_sandbox_forbidden';
  if (statusCode === 429) return 'square_sandbox_rate_limited';
  if (statusCode >= 500 || statusCode === 0) return 'square_sandbox_unknown';
  return '';
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
  const payment = capturedPayment(capture);
  const normalized = normalizeSquarePaymentStatus(payment && payment.status);
  if (httpStatus === 429) {
    return contractResult({
      ...shared,
      error: 'square_sandbox_rate_limited',
      outcomeUnknown: true,
    });
  }
  if (httpStatus === 401 || httpStatus === 403 || httpStatus >= 500 || httpStatus === 0) {
    return contractResult({
      ...shared,
      error: contractErrorForHttp(httpStatus),
      outcomeUnknown: httpStatus >= 500 || httpStatus === 0,
    });
  }
  if (httpStatus === 400 && !normalized.recognized) {
    return contractResult({
      ...shared,
      error: 'square_sandbox_bad_request',
      outcomeUnknown: false,
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
  if (!payment || !identity.rawIdPresent) {
    return contractResult({
      ...shared,
      error: 'square_sandbox_payment_id_missing',
      statusCode: providerResult.statusCode || 502,
      normalized,
    });
  }
  if (!normalized.recognized) {
    return contractResult({
      ...shared,
      error: 'square_sandbox_status_unknown',
      statusCode: providerResult.statusCode || 200,
      paymentId: identity.id,
      normalized,
      amountCents: identity.amount,
      currency: identity.currency,
      locationAccepted: identity.locationAccepted,
      merchantAccepted: identity.merchantAccepted,
    });
  }
  if (!identity.idAccepted) {
    return contractResult({
      ...shared,
      error: 'square_sandbox_identity_mismatch',
      statusCode: providerResult.statusCode || 409,
      normalized,
      outcomeUnknown: true,
    });
  }
  if (!identity.amountAccepted) {
    return contractResult({
      ...shared,
      error: 'square_sandbox_amount_mismatch',
      statusCode: providerResult.statusCode || 409,
      paymentId: identity.id,
      normalized,
      amountCents: identity.amount,
      currency: identity.currency,
      locationAccepted: identity.locationAccepted,
      merchantAccepted: identity.merchantAccepted,
      outcomeUnknown: true,
    });
  }
  if (!identity.currencyAccepted) {
    return contractResult({
      ...shared,
      error: 'square_sandbox_currency_mismatch',
      statusCode: providerResult.statusCode || 409,
      paymentId: identity.id,
      normalized,
      amountCents: identity.amount,
      currency: identity.currency,
      outcomeUnknown: true,
    });
  }
  if (!identity.locationAccepted) {
    return contractResult({
      ...shared,
      error: 'square_sandbox_location_mismatch',
      statusCode: providerResult.statusCode || 409,
      paymentId: identity.id,
      normalized,
      amountCents: identity.amount,
      currency: identity.currency,
      merchantAccepted: identity.merchantAccepted,
      outcomeUnknown: true,
    });
  }
  if (!identity.merchantAccepted) {
    return contractResult({
      ...shared,
      error: 'square_sandbox_merchant_mismatch',
      statusCode: providerResult.statusCode || 409,
      paymentId: identity.id,
      normalized,
      amountCents: identity.amount,
      currency: identity.currency,
      locationAccepted: true,
      outcomeUnknown: true,
    });
  }
  if (providerResult.error === 'square_sandbox_identity_unconfirmed' || providerResult.sandboxReceiptConfirmed !== true) {
    return contractResult({
      ...shared,
      error: 'square_sandbox_identity_unconfirmed',
      statusCode: providerResult.statusCode || 409,
      normalized,
      amountCents: identity.amount,
      currency: identity.currency,
      locationAccepted: true,
      merchantAccepted: true,
      outcomeUnknown: true,
    });
  }

  const terminalFailure = normalized.status === 'FAILED' || normalized.status === 'CANCELED';
  return contractResult({
    ...shared,
    ok: !terminalFailure,
    error: terminalFailure ? 'square_sandbox_not_settled' : '',
    statusCode: providerResult.statusCode || 200,
    paymentId: identity.id,
    normalized,
    amountCents: identity.amount,
    currency: identity.currency,
    locationAccepted: true,
    merchantAccepted: true,
    identityAccepted: true,
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

async function createSimulatedPayment(input = {}) {
  const refused = validateRequest('createPayment', input);
  if (!refused.ok) {
    return contractResult({
      operation: 'createPayment',
      error: refused.error,
      statusCode: refused.statusCode,
      testContext: input.testContext === TEST_CONTEXT ? TEST_CONTEXT : '',
      purpose: input.purpose === PURPOSE ? PURPOSE : '',
      serverBookingRef: typeof input.serverBookingRef === 'string' ? input.serverBookingRef : '',
      idempotencyKey: typeof input.idempotencyKey === 'string' ? input.idempotencyKey : '',
    });
  }
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
  return applyProviderResult('createPayment', providerResult, capture, input);
}

async function retrieveSimulatedPayment(input = {}) {
  const refused = validateRequest('getPayment', input);
  if (!refused.ok) {
    return contractResult({
      operation: 'getPayment',
      error: refused.error,
      statusCode: refused.statusCode,
      idempotencyKey: typeof input.idempotencyKey === 'string' ? input.idempotencyKey : '',
    });
  }
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
  return applyProviderResult('getPayment', providerResult, capture, input);
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
