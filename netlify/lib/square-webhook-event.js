'use strict';

/**
 * Interpretation of a Square webhook after the signature has been checked.
 *
 * payment.created and payment.updated are recognized. Any other type is a
 * controlled result with no financial effect. COMPLETED is the only Square
 * status that means Square reported the payment complete. Receiving the event
 * does not confirm a Cardetail1 payment, create a charge, or write a ledger row.
 *
 * reviewSquareWebhookSequence is a pure function over a caller-supplied list.
 * It keeps no process-local store. Memory-only deduplication is not production
 * safe. A future integration has to persist event_id and reconciled financial
 * state before it can acknowledge a delivery.
 */

const { squareWebhookBodySha256, signaturesMatch } = require('./square-webhook-verifier');

const SUPPORTED_EVENT_TYPES = Object.freeze(['payment.created', 'payment.updated']);

const DOCUMENTED_PAYMENT_STATUSES = Object.freeze([
  'APPROVED',
  'PENDING',
  'COMPLETED',
  'CANCELED',
  'FAILED',
]);

const PERSISTENT_DEDUPLICATION_CONTRACT = Object.freeze({
  implemented: false,
  durable: false,
  productionSafe: false,
  memoryOnlySufficient: false,
  identityKey: 'event_id',
  paymentKey: 'data.object.payment.id',
  orderingKey: 'created_at',
  futureControl: 'persistent uniqueness of event_id plus reconciled financial state',
  statement: 'Deduplicating only in memory does not protect production. Square retries deliveries across processes. A future integration must persist event_id and the reconciled financial state before any financial effect.',
});

function inert(extra) {
  return {
    financialEffect: 'none',
    externalCall: false,
    ledgerWrite: false,
    chargeAuthorized: false,
    paymentConfirmed: false,
    paid: false,
    created: false,
    effectsExecuted: [],
    ...extra,
  };
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function statusClass(status) {
  if (status === 'COMPLETED') return 'completed';
  if (status === 'APPROVED') return 'approved';
  if (status === 'PENDING') return 'pending';
  if (status === 'FAILED') return 'failed';
  if (status === 'CANCELED') return 'canceled';
  return 'other';
}

function bindingMatches(rawBody, verification) {
  if (!verification || verification.verified !== true || typeof verification.bodySha256 !== 'string') {
    return false;
  }
  const actual = squareWebhookBodySha256(rawBody);
  if (!actual) return false;
  return signaturesMatch(actual, verification.bodySha256);
}

function interpretVerifiedSquareWebhook(input = {}) {
  if (!bindingMatches(input.rawBody, input.verification)) {
    return inert({
      ok: false,
      verified: false,
      parsed: false,
      bound: false,
      recognized: false,
      unknownEvent: false,
      incomplete: false,
      error: 'square_webhook_not_verified',
    });
  }

  let payload;
  try {
    const text = Buffer.isBuffer(input.rawBody) ? input.rawBody.toString('utf8') : input.rawBody;
    payload = JSON.parse(text);
  } catch {
    return inert({
      ok: false,
      verified: true,
      parsed: false,
      bound: true,
      recognized: false,
      unknownEvent: false,
      incomplete: true,
      error: 'square_webhook_payload_invalid',
    });
  }

  if (!isPlainObject(payload)) {
    return inert({
      ok: false,
      verified: true,
      parsed: true,
      bound: true,
      recognized: false,
      unknownEvent: false,
      incomplete: true,
      error: 'square_webhook_payload_incomplete',
    });
  }

  const type = payload.type;
  const eventId = payload.event_id;
  const merchantId = payload.merchant_id;
  const createdAt = payload.created_at;
  const knownType = SUPPORTED_EVENT_TYPES.includes(type);

  if (!knownType) {
    return inert({
      ok: true,
      verified: true,
      parsed: true,
      bound: true,
      recognized: false,
      unknownEvent: true,
      incomplete: false,
      error: 'square_webhook_event_unsupported',
      eventId: nonEmptyString(eventId) ? eventId : null,
      merchantId: nonEmptyString(merchantId) ? merchantId : null,
      type: nonEmptyString(type) ? type : null,
    });
  }

  const createdAtMs = nonEmptyString(createdAt) ? Date.parse(createdAt) : Number.NaN;
  const payment = isPlainObject(payload.data)
    && isPlainObject(payload.data.object)
    && isPlainObject(payload.data.object.payment)
    ? payload.data.object.payment
    : null;
  const amount = payment && isPlainObject(payment.amount_money) ? payment.amount_money : null;
  const complete = nonEmptyString(eventId)
    && nonEmptyString(merchantId)
    && nonEmptyString(createdAt)
    && Number.isFinite(createdAtMs)
    && payment
    && nonEmptyString(payment.id)
    && nonEmptyString(payment.status)
    && amount
    && Number.isInteger(amount.amount)
    && amount.amount >= 0
    && typeof amount.currency === 'string'
    && /^[A-Z]{3}$/.test(amount.currency);

  if (!complete) {
    return inert({
      ok: false,
      verified: true,
      parsed: true,
      bound: true,
      recognized: false,
      unknownEvent: false,
      incomplete: true,
      error: 'square_webhook_payload_incomplete',
      eventId: nonEmptyString(eventId) ? eventId : null,
      merchantId: nonEmptyString(merchantId) ? merchantId : null,
      type,
    });
  }

  if (
    Object.prototype.hasOwnProperty.call(input, 'expectedMerchantId')
    && input.expectedMerchantId !== merchantId
  ) {
    return inert({
      ok: false,
      verified: true,
      parsed: true,
      bound: true,
      recognized: true,
      unknownEvent: false,
      incomplete: false,
      merchantAccepted: false,
      error: 'square_webhook_merchant_unexpected',
      eventId,
      merchantId,
      type,
      createdAt,
      createdAtMs,
      paymentId: payment.id,
      status: payment.status,
      statusClass: statusClass(payment.status),
      squareReportedCompleted: payment.status === 'COMPLETED',
    });
  }

  return inert({
    ok: true,
    verified: true,
    parsed: true,
    bound: true,
    recognized: true,
    unknownEvent: false,
    incomplete: false,
    merchantAccepted: true,
    error: null,
    eventId,
    merchantId,
    type,
    createdAt,
    createdAtMs,
    paymentId: payment.id,
    status: payment.status,
    statusClass: statusClass(payment.status),
    statusDocumented: DOCUMENTED_PAYMENT_STATUSES.includes(payment.status),
    squareReportedCompleted: payment.status === 'COMPLETED',
    amountCents: amount.amount,
    currency: amount.currency,
  });
}

function reviewSquareWebhookSequence(interpretedEvents) {
  const contract = {
    durable: false,
    productionSafe: false,
    memoryOnlySufficient: false,
    persistentDedup: PERSISTENT_DEDUPLICATION_CONTRACT,
  };
  if (!Array.isArray(interpretedEvents)) {
    return inert({
      ok: false,
      error: 'square_webhook_sequence_invalid',
      ...contract,
      steps: [],
      payments: {},
    });
  }

  // This Set exists only for the list in this call. It is discarded on return.
  // It is not a production deduplication store.
  const seen = new Set();
  const payments = new Map();
  const steps = [];

  for (let i = 0; i < interpretedEvents.length; i += 1) {
    const event = interpretedEvents[i];
    const base = {
      index: i,
      eventId: event && event.eventId ? event.eventId : null,
      paymentId: event && event.paymentId ? event.paymentId : null,
      duplicate: false,
      stale: false,
      statusChanged: false,
      financialEffect: 'none',
      ledgerWrite: false,
      paymentConfirmed: false,
    };

    if (!event || event.bound !== true || event.verified !== true) {
      steps.push({ ...base, apply: false, reason: 'not_a_validated_event' });
      continue;
    }
    if (event.ok !== true || event.incomplete) {
      steps.push({ ...base, apply: false, reason: event.error || 'incomplete' });
      continue;
    }
    if (event.unknownEvent) {
      steps.push({ ...base, apply: false, reason: 'unknown_event' });
      continue;
    }
    if (!event.eventId || !event.paymentId || !Number.isFinite(event.createdAtMs)) {
      steps.push({ ...base, apply: false, reason: 'square_webhook_payload_incomplete' });
      continue;
    }
    if (seen.has(event.eventId)) {
      steps.push({ ...base, apply: false, duplicate: true, reason: 'duplicate_event_id' });
      continue;
    }
    seen.add(event.eventId);

    const current = payments.get(event.paymentId);
    if (current && current.type === 'payment.updated' && event.type === 'payment.created') {
      steps.push({
        ...base,
        apply: false,
        stale: true,
        reason: 'created_after_updated',
        ignoredStatus: event.status,
        retainedStatus: current.status,
      });
      continue;
    }
    if (current && event.createdAtMs < current.createdAtMs) {
      steps.push({
        ...base,
        apply: false,
        stale: true,
        reason: 'older_event_after_newer',
        ignoredStatus: event.status,
        retainedStatus: current.status,
      });
      continue;
    }
    if (current && event.createdAtMs === current.createdAtMs) {
      steps.push({
        ...base,
        apply: false,
        stale: true,
        reason: 'event_not_newer',
        ignoredStatus: event.status,
        retainedStatus: current.status,
      });
      continue;
    }

    const statusChanged = !!current && current.status !== event.status;
    payments.set(event.paymentId, {
      status: event.status,
      statusClass: event.statusClass,
      createdAtMs: event.createdAtMs,
      type: event.type,
      eventId: event.eventId,
      squareReportedCompleted: event.squareReportedCompleted === true,
      paymentConfirmed: false,
    });
    steps.push({
      ...base,
      apply: true,
      statusChanged,
      reason: statusChanged ? 'status_observed' : 'accepted',
      status: event.status,
      squareReportedCompleted: event.squareReportedCompleted === true,
      samePayment: !!current,
    });
  }

  const paymentView = {};
  for (const [paymentId, value] of payments) paymentView[paymentId] = value;

  return inert({
    ok: true,
    error: null,
    ...contract,
    steps,
    payments: paymentView,
  });
}

module.exports = {
  SUPPORTED_EVENT_TYPES,
  DOCUMENTED_PAYMENT_STATUSES,
  PERSISTENT_DEDUPLICATION_CONTRACT,
  interpretVerifiedSquareWebhook,
  reviewSquareWebhookSequence,
};
