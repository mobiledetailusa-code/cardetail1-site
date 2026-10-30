'use strict';

/**
 * Durable administrative preparation for a future Square payment link.
 *
 * This writes one server-owned issuance on the existing booking record.
 * It does not call Square, does not create a hosted URL, and does not
 * settle the booking. Status "prepared" means the issuance identity was
 * reserved. It does not mean a link exists or a payment was collected.
 *
 * A later explicit reissue, for the same balance, is not implemented.
 * That future action needs its own admin authorization, a recorded reason,
 * and a rule that an in-flight prepared issuance stays the retry target
 * until an administrator deliberately closes it. This phase must not
 * invent that permission, and it must not pretend to cancel a Square link.
 *
 * No trusted Square location is configured on this path. The disabled
 * legacy create-payment function mentions SQUARE_LOCATION_ID, but that
 * endpoint does not run. This record therefore omits location rather
 * than inventing one.
 */

const crypto = require('crypto');
const { moneyConflict } = require('./payment-service');
const { getBookingRecord, commitBooking } = require('./booking-repository');

const MAX_ATTEMPTS = 3;
const PREPARED = 'prepared';
const SUPERSEDED = 'superseded';

const CLIENT_FINANCIAL_FIELDS = [
  'amount',
  'amountCents',
  'approvedCents',
  'remainingCents',
  'currency',
  'locationId',
  'location_id',
];

const CLIENT_AUTHORITY_FIELDS = [
  'issuanceId',
  'correlationReference',
  'operationId',
  'squareLinkPreparation',
  'paymentLinkId',
  'orderId',
  'paymentId',
  'paymentLinkUrl',
];

function inactive(statusCode, payload) {
  return {
    statusCode,
    payload: {
      ...payload,
      authoritative: false,
      paid: false,
      financiallySettled: false,
      providerCalled: false,
      createsPayment: false,
      createsPaymentLink: false,
      remoteLinkCancelled: false,
    },
  };
}

function hasOwn(body, key) {
  return !!body && Object.prototype.hasOwnProperty.call(body, key);
}

function createIssuanceId() {
  return crypto.randomUUID();
}

function operationIdentity({ issuanceId, bookingId, amountCents, currency }) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([issuanceId, bookingId, amountCents, currency]), 'utf8')
    .digest('hex');
}

function publicPreparation(record) {
  return {
    bookingId: record.bookingId,
    issuanceId: record.issuanceId,
    state: PREPARED,
    amountCents: record.amountCents,
    currency: record.currency,
    correlationReference: record.correlationReference,
    preparedAt: record.preparedAt,
    operationId: record.operationId,
  };
}

function appendPreparationEvent(booking, now, issuanceId) {
  const eventLog = Array.isArray(booking.eventLog) ? booking.eventLog.slice() : [];
  eventLog.push({
    action: 'square_payment_link_prepared',
    by: 'admin',
    note: 'preparation_not_authoritative',
    issuanceId,
    at: now,
  });
  return eventLog;
}

/**
 * Reserve or replay one prepared issuance for the booking's current balance.
 * Financial amounts come from the stored booking, never from `body`.
 *
 * @param {object} args
 * @param {object} args.store in-memory or Blob store used by commitBooking
 * @param {string} args.bookingId
 * @param {object} [args.body]
 * @param {string} [args.now]
 * @param {function} [args.createIssuanceId]
 * @param {number} [args.maxAttempts]
 */
async function prepareSquarePaymentLink({
  store,
  bookingId,
  body = {},
  now = new Date().toISOString(),
  createIssuanceId: createId = createIssuanceId,
  maxAttempts = MAX_ATTEMPTS,
}) {
  const id = String(bookingId || '').trim();
  if (!id) return inactive(400, { ok: false, error: 'bookingId_required' });
  if (!store || typeof store.get !== 'function') {
    return inactive(500, { ok: false, error: 'store_unavailable' });
  }

  if (CLIENT_FINANCIAL_FIELDS.some((key) => hasOwn(body, key))) {
    return inactive(400, { ok: false, error: 'client_financial_input_rejected' });
  }
  if (CLIENT_AUTHORITY_FIELDS.some((key) => hasOwn(body, key))) {
    return inactive(400, { ok: false, error: 'client_issuance_rejected' });
  }
  if (body && body.newIssuance === true) {
    return inactive(409, { ok: false, error: 'new_issuance_not_authorized' });
  }

  const attempts = Math.max(1, Math.min(5, Math.round(Number(maxAttempts) || MAX_ATTEMPTS)));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const rec = await getBookingRecord(id, { storeOverride: store });
    if (!rec.exists || !rec.booking) {
      return inactive(404, { ok: false, error: 'booking_not_found' });
    }

    const booking = rec.booking;
    const money = moneyConflict(booking);
    if (money.conflict || !money.payable || !(money.remainingCents > 0)) {
      return inactive(409, {
        ok: false,
        error: 'not_payable',
        reason: money.reason || 'zero_balance',
      });
    }

    const ledgerCurrency = String(booking.ledger && booking.ledger.currency || 'usd').trim().toLowerCase();
    if (ledgerCurrency !== 'usd') {
      return inactive(409, { ok: false, error: 'currency_unsupported' });
    }

    const amountCents = money.remainingCents;
    const current = booking.squareLinkPreparation;
    if (current && typeof current === 'object' && current.state === PREPARED) {
      if (
        current.bookingId === id
        && current.amountCents === amountCents
        && current.currency === 'USD'
        && current.issuanceId
        && current.operationId
      ) {
        return inactive(200, {
          ok: true,
          replayed: true,
          supersededPrevious: false,
          bookingId: id,
          bookingVersion: booking.bookingVersion,
          preparation: publicPreparation(current),
        });
      }
      if (current.amountCents === amountCents) {
        return inactive(409, { ok: false, error: 'preparation_unusable' });
      }
    } else if (current && typeof current === 'object' && current.state !== PREPARED) {
      return inactive(409, { ok: false, error: 'preparation_state_unsupported' });
    }

    const issuanceId = createId();
    if (typeof issuanceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(issuanceId)) {
      return inactive(500, { ok: false, error: 'issuance_identity_invalid' });
    }

    const next = {
      bookingId: id,
      issuanceId,
      state: PREPARED,
      amountCents,
      currency: 'USD',
      correlationReference: issuanceId,
      preparedAt: now,
      operationId: operationIdentity({
        issuanceId,
        bookingId: id,
        amountCents,
        currency: 'USD',
      }),
    };

    const history = Array.isArray(booking.squareLinkPreparationHistory)
      ? booking.squareLinkPreparationHistory.slice()
      : [];
    let supersededPrevious = false;
    if (current && typeof current === 'object' && current.state === PREPARED) {
      history.push({
        ...current,
        state: SUPERSEDED,
        supersededAt: now,
        supersededReason: 'approved_amount_changed',
      });
      supersededPrevious = true;
    }

    const patched = {
      ...booking,
      squareLinkPreparation: next,
      squareLinkPreparationHistory: history,
      eventLog: appendPreparationEvent(booking, now, issuanceId),
      updatedAt: now,
    };
    delete patched.__etag;
    delete patched._etag;

    const committed = await commitBooking({
      bookingId: id,
      expectedBookingVersion: booking.bookingVersion,
      nextAggregate: patched,
      storeOverride: store,
      syncSlots: false,
    });
    if (committed.ok) {
      return inactive(200, {
        ok: true,
        replayed: false,
        supersededPrevious,
        bookingId: id,
        bookingVersion: committed.bookingVersion,
        preparation: publicPreparation(next),
      });
    }
    if (committed.error === 'version_conflict' && attempt < attempts) continue;
    return inactive(committed.statusCode || 409, {
      ok: false,
      error: committed.error || 'version_conflict',
    });
  }

  return inactive(409, { ok: false, error: 'version_conflict' });
}

module.exports = {
  MAX_ATTEMPTS,
  createIssuanceId,
  operationIdentity,
  prepareSquarePaymentLink,
};
