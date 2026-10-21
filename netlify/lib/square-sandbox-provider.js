'use strict';

/**
 * Square Sandbox client for an explicit local smoke test.
 *
 * This is not the active payment provider. getActivePaymentProvider() stays
 * DisabledPaymentProvider and the selected provider stays "none". Nothing in
 * booking, My Garage, Quick Ops, Admin, or the Stripe path imports this file.
 *
 * The only host is the Square Sandbox constant below. The production host is
 * rejected and is not configurable. The only credential read for authorization
 * is SQUARE_SANDBOX_ACCESS_TOKEN. Production token variables are never sent.
 *
 * Netlify production, deploy previews, and branch deploys cannot call Square,
 * even when the local confirmation string is present. CI tests pass a mock
 * fetch. The manual script is the only intended caller.
 *
 * createPayment and getPayment talk to Square Sandbox. refundPayment,
 * saveCard, chargeSavedCard, and createPaymentLink stay disabled. No
 * financial row is written.
 */

const {
  DISABLED_ERROR,
  OFFLINE_ERROR,
  activePaymentProviderId,
  classifySettlementMethod,
} = require('./payment-provider-adapter');

const SANDBOX_ORIGIN = 'https://connect.squareupsandbox.com';
const PRODUCTION_ORIGIN = 'https://connect.squareup.com';
const SQUARE_VERSION = '2026-09-16';
const SANDBOX_TOKEN_ENV = 'SQUARE_SANDBOX_ACCESS_TOKEN';
const LOCAL_CONFIRMATION = 'square-sandbox';
const PROVIDER_ID = 'square_sandbox';

const PRODUCTION_TOKEN_ENVS = Object.freeze([
  'SQUARE_ACCESS_TOKEN',
  'SQUARE_PRODUCTION_ACCESS_TOKEN',
  'SQUARE_PROD_ACCESS_TOKEN',
]);

const BLOCKED_CONTEXTS = new Set(['production', 'deploy-preview', 'branch-deploy']);

const SANDBOX_SOURCE_IDS = new Set([
  'cnon:card-nonce-ok',
  'cnon:card-nonce-declined',
  'cnon:card-nonce-rejected-cvv',
  'cnon:card-nonce-rejected-postalcode',
  'cnon:card-nonce-rejected-expiration',
  'cnon:card-nonce-already-used',
]);

const DECLINE_CODES = new Set([
  'ADDRESS_VERIFICATION_FAILURE',
  'ALLOWABLE_PIN_TRIES_EXCEEDED',
  'BAD_EXPIRATION',
  'CARD_DECLINED',
  'CARD_DECLINED_CALL_ISSUER',
  'CARD_DECLINED_VERIFICATION_REQUIRED',
  'CARD_EXPIRED',
  'CARD_NOT_SUPPORTED',
  'CARD_TOKEN_EXPIRED',
  'CARD_TOKEN_USED',
  'CHIP_INSERTION_REQUIRED',
  'CVV_FAILURE',
  'GENERIC_DECLINE',
  'GIFT_CARD_AVAILABLE_AMOUNT',
  'INSUFFICIENT_FUNDS',
  'INSUFFICIENT_PERMISSIONS',
  'INVALID_CARD',
  'INVALID_CARD_DATA',
  'INVALID_EXPIRATION',
  'INVALID_PIN',
  'MANUALLY_ENTERED_PAYMENT_NOT_SUPPORTED',
  'PAN_FAILURE',
  'PAYMENT_LIMIT_EXCEEDED',
  'TRANSACTION_LIMIT',
  'VERIFY_AVS_FAILURE',
  'VERIFY_CVV_FAILURE',
  'VOICE_FAILURE',
]);

const DISABLED_OPERATIONS = Object.freeze([
  'refundPayment',
  'saveCard',
  'chargeSavedCard',
  'createPaymentLink',
]);

function sandboxResult(operation, fields = {}) {
  return {
    ok: fields.ok === true,
    error: fields.error || '',
    statusCode: fields.statusCode == null ? 403 : fields.statusCode,
    operation,
    provider: PROVIDER_ID,
    activeProvider: activePaymentProviderId(),
    environment: 'sandbox',
    providerCalled: fields.providerCalled === true,
    externalCall: fields.externalCall === true,
    paid: false,
    created: false,
    completed: fields.completed === true,
    declined: fields.declined === true,
    outcome: fields.outcome || 'rejected',
    outcomeUnknown: fields.outcomeUnknown === true,
    definitiveFinancialFailure: false,
    additionalCharge: false,
    idempotencyKey: fields.idempotencyKey || '',
    paymentId: fields.paymentId || '',
    status: fields.status || '',
    amountCents: Number.isInteger(fields.amountCents) ? fields.amountCents : null,
    currency: fields.currency || '',
    squareCode: fields.squareCode || '',
    sandboxReceiptConfirmed: fields.sandboxReceiptConfirmed === true,
  };
}

function blockedContext(env) {
  const source = env && typeof env === 'object' ? env : {};
  const context = String(source.CONTEXT || source.NETLIFY_CONTEXT || '').trim().toLowerCase();
  if (BLOCKED_CONTEXTS.has(context)) return context;
  if (String(source.NETLIFY || '').trim().toLowerCase() === 'true') return 'netlify';
  if (source.AWS_LAMBDA_FUNCTION_NAME || source.LAMBDA_TASK_ROOT) return 'lambda';
  return '';
}

function isProductionSquareUrl(value) {
  try {
    return new URL(String(value)).hostname === 'connect.squareup.com';
  } catch {
    return false;
  }
}

function sandboxRequestUrl(pathname) {
  const url = new URL(pathname, SANDBOX_ORIGIN);
  if (url.origin !== SANDBOX_ORIGIN || url.hostname !== 'connect.squareupsandbox.com' || url.protocol !== 'https:') {
    return null;
  }
  if (isProductionSquareUrl(url)) return null;
  return url.toString();
}

function readSandboxToken(env) {
  const source = env && typeof env === 'object' ? env : {};
  const token = source[SANDBOX_TOKEN_ENV];
  if (typeof token !== 'string' || token.trim() === '') {
    return { ok: false, error: 'square_sandbox_credentials_missing' };
  }
  if (token !== token.trim() || /\s/.test(token) || token.length < 40 || token.length > 4096) {
    return { ok: false, error: 'square_sandbox_credentials_invalid' };
  }
  if (/^(sk_live_|sk_test_|pk_|sq0idp-|sq0csp-|sandbox-sq0idb-)/.test(token)) {
    return { ok: false, error: 'square_sandbox_credentials_invalid' };
  }
  for (const name of PRODUCTION_TOKEN_ENVS) {
    if (typeof source[name] === 'string' && source[name] !== '' && source[name] === token) {
      return { ok: false, error: 'square_sandbox_credentials_invalid' };
    }
  }
  return { ok: true, token };
}

function localRefusal(operation, error, statusCode, extra) {
  return sandboxResult(operation, {
    error,
    statusCode,
    outcome: 'rejected',
    ...extra,
  });
}

function gate(operation, env, confirmation, extra) {
  if (confirmation !== LOCAL_CONFIRMATION) {
    return localRefusal(operation, 'square_sandbox_confirmation_required', 403, extra);
  }
  const context = blockedContext(env);
  if (context) {
    return localRefusal(operation, 'square_sandbox_context_forbidden', 403, extra);
  }
  const token = readSandboxToken(env);
  if (!token.ok) {
    return localRefusal(operation, token.error, 403, extra);
  }
  return { ok: true, token: token.token };
}

function offlineOrBookingRefusal(operation, input) {
  if (!input || typeof input !== 'object') return null;
  if (input.bookingId || input.booking) {
    return localRefusal(operation, 'square_sandbox_booking_not_connected', 409);
  }
  const method = input.method || input.settlementMethod || input.paymentMethod || input.paymentMethodPreference;
  const classified = classifySettlementMethod(method);
  if (
    classified.kind === 'offline_settlement'
    || classified.kind === 'offline_preference'
    || classified.kind === 'manual_handling'
  ) {
    return localRefusal(operation, OFFLINE_ERROR, 409, { outcome: 'rejected' });
  }
  return null;
}

function idempotencyKey(input) {
  const key = input && typeof input.idempotencyKey === 'string' ? input.idempotencyKey : '';
  if (!key) return { ok: false, error: 'square_sandbox_idempotency_key_required' };
  if (!/^[A-Za-z0-9._:-]{1,45}$/.test(key)) {
    return { ok: false, error: 'square_sandbox_idempotency_key_invalid' };
  }
  return { ok: true, key };
}

function paymentIdOk(paymentId) {
  return typeof paymentId === 'string' && /^[A-Za-z0-9]{8,80}$/.test(paymentId);
}

function squareError(body) {
  const errors = body && Array.isArray(body.errors) ? body.errors : [];
  const first = errors[0] && typeof errors[0] === 'object' ? errors[0] : {};
  return {
    code: typeof first.code === 'string' ? first.code : '',
    category: typeof first.category === 'string' ? first.category : '',
  };
}

function isDecline(parsed) {
  return parsed.category === 'PAYMENT_METHOD_ERROR' || DECLINE_CODES.has(parsed.code);
}

function receiptConfirmed(payment) {
  const receipt = payment && payment.receipt_url;
  if (typeof receipt !== 'string' || receipt === '') return false;
  try {
    const url = new URL(receipt);
    return url.protocol === 'https:'
      && (url.hostname === 'squareupsandbox.com' || url.hostname.endsWith('.squareupsandbox.com'));
  } catch {
    return false;
  }
}

function interpretPayment(operation, httpStatus, body, expected) {
  const payment = body && body.payment && typeof body.payment === 'object' ? body.payment : null;
  const parsed = squareError(body);
  const status = payment && typeof payment.status === 'string' ? payment.status : '';
  const amount = payment && payment.amount_money && Number.isInteger(payment.amount_money.amount)
    ? payment.amount_money.amount
    : null;
  const currency = payment && payment.amount_money && typeof payment.amount_money.currency === 'string'
    ? payment.amount_money.currency
    : '';
  const id = payment && typeof payment.id === 'string' ? payment.id : '';
  const shared = {
    providerCalled: true,
    externalCall: true,
    idempotencyKey: expected.idempotencyKey || '',
    paymentId: paymentIdOk(id) ? id : '',
    status,
    amountCents: amount,
    currency,
    squareCode: parsed.code,
    sandboxReceiptConfirmed: receiptConfirmed(payment),
  };

  if (parsed.code === 'IDEMPOTENCY_KEY_REUSED') {
    return sandboxResult(operation, {
      ...shared,
      error: 'square_sandbox_idempotency_conflict',
      statusCode: httpStatus,
      outcome: 'idempotency_conflict',
    });
  }
  if (httpStatus === 401) {
    return sandboxResult(operation, {
      ...shared,
      error: 'square_sandbox_credentials_invalid',
      statusCode: 401,
      outcome: 'rejected',
    });
  }
  if (httpStatus === 404 || parsed.code === 'NOT_FOUND') {
    return sandboxResult(operation, {
      ...shared,
      error: 'square_sandbox_not_found',
      statusCode: httpStatus || 404,
      outcome: 'rejected',
    });
  }
  if (httpStatus === 429) {
    return sandboxResult(operation, {
      ...shared,
      error: 'square_sandbox_rate_limited',
      statusCode: 429,
      outcome: 'unknown',
      outcomeUnknown: true,
    });
  }
  if (httpStatus >= 500 || httpStatus === 0) {
    return sandboxResult(operation, {
      ...shared,
      error: 'square_sandbox_unknown',
      statusCode: httpStatus || 503,
      outcome: 'unknown',
      outcomeUnknown: true,
    });
  }
  if (isDecline(parsed) || status === 'FAILED' || status === 'CANCELED') {
    return sandboxResult(operation, {
      ...shared,
      error: 'square_sandbox_declined',
      statusCode: httpStatus,
      declined: true,
      outcome: 'declined',
    });
  }
  if (httpStatus < 200 || httpStatus >= 300 || !payment) {
    return sandboxResult(operation, {
      ...shared,
      error: httpStatus === 400 ? 'square_sandbox_bad_request' : 'square_sandbox_invalid_response',
      statusCode: httpStatus,
      outcome: httpStatus === 400 ? 'rejected' : 'unknown',
      outcomeUnknown: httpStatus !== 400,
    });
  }
  if (expected.paymentId && id !== expected.paymentId) {
    return sandboxResult(operation, {
      ...shared,
      error: 'square_sandbox_identity_mismatch',
      statusCode: httpStatus,
      outcome: 'unknown',
      outcomeUnknown: true,
    });
  }
  if (!paymentIdOk(id) || !shared.sandboxReceiptConfirmed || isProductionSquareUrl(payment.receipt_url)) {
    return sandboxResult(operation, {
      ...shared,
      paymentId: '',
      error: 'square_sandbox_identity_unconfirmed',
      statusCode: httpStatus,
      outcome: 'unknown',
      outcomeUnknown: true,
      sandboxReceiptConfirmed: false,
    });
  }
  if (status !== 'COMPLETED') {
    return sandboxResult(operation, {
      ...shared,
      error: 'square_sandbox_not_completed',
      statusCode: httpStatus,
      outcome: status === 'APPROVED' || status === 'PENDING' ? 'pending' : 'rejected',
    });
  }
  if (expected.amountCents != null && amount !== expected.amountCents) {
    return sandboxResult(operation, {
      ...shared,
      error: 'square_sandbox_amount_mismatch',
      statusCode: httpStatus,
      outcome: 'unknown',
      outcomeUnknown: true,
    });
  }
  if (currency !== 'USD') {
    return sandboxResult(operation, {
      ...shared,
      error: 'square_sandbox_amount_mismatch',
      statusCode: httpStatus,
      outcome: 'unknown',
      outcomeUnknown: true,
    });
  }
  return sandboxResult(operation, {
    ...shared,
    ok: true,
    error: '',
    statusCode: httpStatus,
    completed: true,
    outcome: 'completed',
  });
}

function unknownTransport(operation, idempotencyKeyValue) {
  return sandboxResult(operation, {
    error: 'square_sandbox_unknown',
    statusCode: 503,
    outcome: 'unknown',
    outcomeUnknown: true,
    providerCalled: true,
    externalCall: false,
    idempotencyKey: idempotencyKeyValue || '',
  });
}

async function squareFetch({ url, method, token, body, fetchImpl, timeoutMs }) {
  if (isProductionSquareUrl(url) || !String(url).startsWith(`${SANDBOX_ORIGIN}/`)) {
    return { refused: true };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Square-Version': SQUARE_VERSION,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        return { httpStatus: response.status, invalid: true };
      }
    }
    return { httpStatus: response.status, body: parsed };
  } catch {
    return { transport: true };
  } finally {
    clearTimeout(timer);
  }
}

class SquareSandboxProvider {
  constructor({ env, fetchImpl, confirmation, timeoutMs } = {}) {
    this.env = env || {};
    this.fetchImpl = fetchImpl;
    this.confirmation = confirmation;
    this.timeoutMs = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000;
    this.id = PROVIDER_ID;
  }

  refundPayment() {
    return Promise.resolve(localRefusal('refundPayment', DISABLED_ERROR, 403));
  }

  saveCard() {
    return Promise.resolve(localRefusal('saveCard', DISABLED_ERROR, 403));
  }

  chargeSavedCard() {
    return Promise.resolve(localRefusal('chargeSavedCard', DISABLED_ERROR, 403));
  }

  createPaymentLink() {
    return Promise.resolve(localRefusal('createPaymentLink', DISABLED_ERROR, 403));
  }

  async createPayment(input = {}) {
    const refused = offlineOrBookingRefusal('createPayment', input);
    if (refused) return refused;
    const key = idempotencyKey(input);
    if (!key.ok) return localRefusal('createPayment', key.error, 400);
    const amountCents = input.amountCents;
    const currency = input.currency;
    const sourceId = input.sourceId;
    if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > 100000) {
      return localRefusal('createPayment', 'square_sandbox_amount_invalid', 400, { idempotencyKey: key.key });
    }
    if (currency !== 'USD') {
      return localRefusal('createPayment', 'square_sandbox_amount_invalid', 400, { idempotencyKey: key.key });
    }
    if (!SANDBOX_SOURCE_IDS.has(sourceId)) {
      return localRefusal('createPayment', 'square_sandbox_source_rejected', 400, { idempotencyKey: key.key });
    }
    const allowed = gate('createPayment', this.env, this.confirmation, { idempotencyKey: key.key });
    if (!allowed.ok) return allowed;
    const url = sandboxRequestUrl('/v2/payments');
    if (!url) {
      return localRefusal('createPayment', 'square_sandbox_production_host_forbidden', 403, { idempotencyKey: key.key });
    }
    const payload = {
      source_id: sourceId,
      idempotency_key: key.key,
      amount_money: { amount: amountCents, currency: 'USD' },
      autocomplete: true,
    };
    const response = await squareFetch({
      url,
      method: 'POST',
      token: allowed.token,
      body: payload,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
    });
    if (response.refused) {
      return localRefusal('createPayment', 'square_sandbox_production_host_forbidden', 403, { idempotencyKey: key.key });
    }
    if (response.transport) return unknownTransport('createPayment', key.key);
    if (response.invalid) {
      return sandboxResult('createPayment', {
        error: 'square_sandbox_invalid_response',
        statusCode: response.httpStatus || 502,
        outcome: 'unknown',
        outcomeUnknown: true,
        providerCalled: true,
        externalCall: true,
        idempotencyKey: key.key,
      });
    }
    return interpretPayment('createPayment', response.httpStatus, response.body, {
      idempotencyKey: key.key,
      amountCents,
    });
  }

  async getPayment(input = {}) {
    const refused = offlineOrBookingRefusal('getPayment', input);
    if (refused) return refused;
    if (!paymentIdOk(input.paymentId)) {
      return localRefusal('getPayment', 'square_sandbox_payment_id_invalid', 400);
    }
    const allowed = gate('getPayment', this.env, this.confirmation);
    if (!allowed.ok) return allowed;
    const url = sandboxRequestUrl(`/v2/payments/${encodeURIComponent(input.paymentId)}`);
    if (!url || isProductionSquareUrl(url)) {
      return localRefusal('getPayment', 'square_sandbox_production_host_forbidden', 403);
    }
    const response = await squareFetch({
      url,
      method: 'GET',
      token: allowed.token,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
    });
    if (response.refused) {
      return localRefusal('getPayment', 'square_sandbox_production_host_forbidden', 403);
    }
    if (response.transport) return unknownTransport('getPayment', '');
    if (response.invalid) {
      return sandboxResult('getPayment', {
        error: 'square_sandbox_invalid_response',
        statusCode: response.httpStatus || 502,
        outcome: 'unknown',
        outcomeUnknown: true,
        providerCalled: true,
        externalCall: true,
      });
    }
    return interpretPayment('getPayment', response.httpStatus, response.body, {
      paymentId: input.paymentId,
    });
  }
}

function createSquareSandboxProvider(options) {
  return new SquareSandboxProvider(options);
}

module.exports = {
  SANDBOX_ORIGIN,
  PRODUCTION_ORIGIN,
  SQUARE_VERSION,
  SANDBOX_TOKEN_ENV,
  LOCAL_CONFIRMATION,
  PROVIDER_ID,
  DISABLED_OPERATIONS,
  SANDBOX_SOURCE_IDS,
  SquareSandboxProvider,
  createSquareSandboxProvider,
  isProductionSquareUrl,
  sandboxRequestUrl,
};
