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

function appendPreparationEvent(booking, now, issuance) {
  const eventLog = Array.isArray(booking.eventLog) ? booking.eventLog.slice() : [];
  eventLog.push({
    action: 'square_payment_link_prepared',
    by: 'admin',
    note: 'preparation_not_authoritative',
    issuanceId: issuance.issuanceId,
    amountCents: issuance.amountCents,
    currency: issuance.currency,
    at: now,
  });
  return eventLog;
}

function payableSnapshot(booking) {
  const money = moneyConflict(booking);
  const eligible = !money.conflict && money.payable && money.remainingCents > 0;
  const currency = String(booking.ledger && booking.ledger.currency || 'usd').trim().toLowerCase();
  return {
    money,
    eligible: eligible && currency === 'usd',
    amountCents: money.remainingCents,
    currencyOk: currency === 'usd',
  };
}

/**
 * Move a current prepared issuance into history when it no longer matches
 * the booking that is about to be saved. Does not create a replacement and
 * does not change ledger or payment status.
 */
function reconcilePreparedIssuance(booking, now) {
  const current = booking && booking.squareLinkPreparation;
  if (!current || typeof current !== 'object' || current.state !== PREPARED) {
    return { booking, superseded: null };
  }
  const snap = payableSnapshot(booking);
  const identityOk = current.operationId === operationIdentity({
    issuanceId: current.issuanceId,
    bookingId: current.bookingId,
    amountCents: current.amountCents,
    currency: current.currency,
  });
  const stillCurrent = snap.eligible
    && identityOk
    && current.bookingId === String(booking.id || current.bookingId || '')
    && current.amountCents === snap.amountCents
    && current.currency === 'USD';
  if (stillCurrent) return { booking, superseded: null };

  let reason = 'not_payable';
  if (!identityOk) reason = 'operation_identity_mismatch';
  else if (!snap.currencyOk) reason = 'currency_unsupported';
  else if (snap.eligible) reason = 'payable_balance_changed';
  else if (snap.money.reason) reason = snap.money.reason;

  const history = Array.isArray(booking.squareLinkPreparationHistory)
    ? booking.squareLinkPreparationHistory.slice()
    : [];
  const superseded = {
    ...current,
    state: SUPERSEDED,
    supersededAt: now,
    supersededReason: reason,
  };
  history.push(superseded);
  const eventLog = Array.isArray(booking.eventLog) ? booking.eventLog.slice() : [];
  eventLog.push({
    action: 'square_payment_link_superseded',
    by: 'system',
    note: 'preparation_not_authoritative',
    issuanceId: current.issuanceId,
    amountCents: current.amountCents,
    currency: current.currency,
    reason,
    at: now,
  });
  return {
    booking: {
      ...booking,
      squareLinkPreparation: null,
      squareLinkPreparationHistory: history,
      eventLog,
    },
    superseded,
  };
}

async function recordIssuanceAudit({
  bookingId,
  issuance,
  action,
  transition,
  actorId,
  reason,
}) {
  const { auditEntry, appendAudit } = require('./operations-audit');
  const entry = {
    ...auditEntry({
      bookingId,
      actorType: 'admin',
      actorId: actorId || '',
      action,
      reason: `issuance=${issuance.issuanceId};amountCents=${issuance.amountCents};currency=${issuance.currency || 'USD'};transition=${transition};cause=${reason || ''}`,
      sourcePortal: 'admin_ops',
    }),
    issuance_id: issuance.issuanceId,
    amount_cents: issuance.amountCents,
    currency: issuance.currency || 'USD',
    transition,
    transition_reason: reason || '',
  };
  await appendAudit(entry);
  return entry;
}

function recordSupersessionAudit(superseded, bookingId, actorId) {
  return recordIssuanceAudit({
    bookingId,
    issuance: superseded,
    action: 'square_payment_link_superseded',
    transition: 'superseded',
    actorId,
    reason: superseded.supersededReason,
  });
}

async function auditPreparation(bookingId, issuance, actorId) {
  try {
    await recordIssuanceAudit({
      bookingId,
      issuance,
      action: 'square_payment_link_prepared',
      transition: 'prepared',
      actorId,
      reason: 'administrative_preparation',
    });
    return true;
  } catch {
    return false;
  }
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
  actorId = '',
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
    const snap = payableSnapshot(booking);
    const current = booking.squareLinkPreparation;
    if (!snap.eligible) {
      if (current && current.state === PREPARED) {
        const cleared = await commitBooking({
          bookingId: id,
          expectedBookingVersion: booking.bookingVersion,
          nextAggregate: { ...booking, updatedAt: now },
          storeOverride: store,
          syncSlots: false,
          strictCas: true,
          auditActorId: actorId,
        });
        if (!cleared.ok && cleared.error === 'version_conflict' && attempt < attempts) continue;
        if (!cleared.ok && cleared.error === 'write_outcome_unknown') {
          const again = await getBookingRecord(id, { storeOverride: store });
          const still = again.booking && again.booking.squareLinkPreparation;
          if (!still || still.state !== PREPARED) {
            return inactive(409, {
              ok: false,
              error: 'not_payable',
              reason: snap.money.reason || 'zero_balance',
              recoveredFromDurableState: true,
              writeAcknowledged: false,
            });
          }
          return inactive(409, { ok: false, error: 'write_outcome_unknown', writeAcknowledged: false });
        }
        if (!cleared.ok) return inactive(cleared.statusCode || 409, { ok: false, error: cleared.error || 'version_conflict' });
      }
      return inactive(409, {
        ok: false,
        error: 'not_payable',
        reason: snap.money.reason || (snap.currencyOk ? 'zero_balance' : 'currency_unsupported'),
      });
    }

    const amountCents = snap.amountCents;
    if (current && typeof current === 'object' && current.state === PREPARED) {
      const identityOk = current.operationId === operationIdentity({
        issuanceId: current.issuanceId,
        bookingId: current.bookingId,
        amountCents: current.amountCents,
        currency: current.currency,
      });
      if (
        identityOk
        && current.bookingId === id
        && current.amountCents === amountCents
        && current.currency === 'USD'
        && current.issuanceId
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
        const cleared = await commitBooking({
          bookingId: id,
          expectedBookingVersion: booking.bookingVersion,
          nextAggregate: { ...booking, updatedAt: now },
          storeOverride: store,
          syncSlots: false,
          strictCas: true,
          auditActorId: actorId,
        });
        if (!cleared.ok && cleared.error === 'version_conflict' && attempt < attempts) continue;
        if (!cleared.ok) return inactive(cleared.statusCode || 409, { ok: false, error: cleared.error || 'preparation_unusable' });
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
    let supersededRecord = null;
    if (current && typeof current === 'object' && current.state === PREPARED) {
      supersededRecord = {
        ...current,
        state: SUPERSEDED,
        supersededAt: now,
        supersededReason: 'payable_balance_changed',
      };
      history.push(supersededRecord);
      supersededPrevious = true;
    }

    const patched = {
      ...booking,
      squareLinkPreparation: next,
      squareLinkPreparationHistory: history,
      eventLog: appendPreparationEvent(booking, now, next),
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
      strictCas: true,
      auditActorId: actorId,
    });
    if (committed.error === 'write_outcome_unknown') {
      const again = await getBookingRecord(id, { storeOverride: store });
      const found = again.booking && again.booking.squareLinkPreparation;
      if (found && found.issuanceId === issuanceId && found.state === PREPARED && found.amountCents === amountCents) {
        const audited = await auditPreparation(id, found, actorId);
        return inactive(200, {
          ok: true,
          replayed: false,
          recoveredFromDurableState: true,
          writeAcknowledged: false,
          supersededPrevious,
          auditRecorded: audited,
          bookingId: id,
          bookingVersion: again.booking.bookingVersion,
          preparation: publicPreparation(found),
        });
      }
      return inactive(409, { ok: false, error: 'write_outcome_unknown', writeAcknowledged: false });
    }
    if (committed.ok) {
      let supersessionAudited = true;
      if (supersededRecord) {
        try {
          await recordSupersessionAudit(supersededRecord, id, actorId);
        } catch {
          supersessionAudited = false;
        }
      }
      const audited = await auditPreparation(id, next, actorId);
      return inactive(200, {
        ok: true,
        replayed: false,
        writeAcknowledged: true,
        supersededPrevious,
        auditRecorded: audited && supersessionAudited,
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
  reconcilePreparedIssuance,
  recordSupersessionAudit,
  prepareSquarePaymentLink,
};
