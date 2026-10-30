'use strict';

/**
 * Pure local consistency check before a future Square payment-link call.
 *
 * The caller supplies the booking, the prepared issuance, and the financial
 * projection. This function does not load them. It does not open a database,
 * a Blob store, or a provider. `providerConfig` is accepted and ignored: a
 * location, a credential, or an authorization flag on that object is not
 * server configuration.
 *
 * `authority: "postgres"` is a required shape, copied from the S2D.1
 * projection contract. It does not prove that the caller used the trusted
 * server-side reader. Authenticity of the inputs stays with the caller.
 *
 * A passing result means the supplied snapshots agree. It is not payment
 * authorization and must not be stored for a later CreatePaymentLink.
 *
 * This does not close the cross-system race:
 * 1. The preflight receives a projection the caller presents as current.
 * 2. The booking and issuance match that projection.
 * 3. The preflight returns success.
 * 4. Another process settles the remaining balance.
 * 5. A later caller creates a Square link from the stale success.
 * A final read is not an atomic guarantee with Square. The future provider
 * boundary has to take fresh evidence and its own coordination.
 *
 * A locally superseded issuance does not cancel a Square-hosted URL. Link
 * deactivation, on-site payment after a live URL, duplicate collection,
 * verified payment status, and refund handling are outside this function.
 * No Square capability is assumed here.
 */

const crypto = require('crypto');
const { moneyConflict } = require('./payment-service');

const PREPARED = 'prepared';
const ISSUANCE_ID_PATTERN = /^[0-9a-f-]{36}$/i;

function operationIdentity({ issuanceId, bookingId, amountCents, currency }) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([issuanceId, bookingId, amountCents, currency]), 'utf8')
    .digest('hex');
}

function decision(ok, error) {
  const result = {
    ok,
    preflightPassed: ok === true,
    paid: false,
    financiallySettled: false,
    authoritative: false,
    providerCalled: false,
    createsPayment: false,
    createsPaymentLink: false,
  };
  if (!ok) result.error = error;
  return result;
}

function integerCents(value) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 0 || value > Number.MAX_SAFE_INTEGER) return null;
  return value;
}

function integerVersion(value) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 0 || value > Number.MAX_SAFE_INTEGER) return null;
  return value;
}

function bookingIdOf(booking) {
  return String(booking && (booking.id || booking.bookingId) || '').trim();
}

function classifyStoredSnapshot(record) {
  const spec = [
    ['quoteVersion', integerVersion],
    ['approvedCents', integerCents],
    ['grossSettledCents', integerCents],
    ['refundedCents', integerCents],
    ['settledCents', integerCents],
  ];
  const snapshot = {};
  let missing = false;
  let invalid = false;
  spec.forEach(([key, parse]) => {
    if (record[key] == null || record[key] === '') {
      missing = true;
      return;
    }
    const parsed = parse(record[key]);
    if (parsed == null) invalid = true;
    else snapshot[key] = parsed;
  });
  if (missing) return { ok: false, error: 'financial_snapshot_missing' };
  if (invalid) return { ok: false, error: 'financial_snapshot_invalid' };
  return { ok: true, snapshot };
}

function snapshotDivergence(stored, fresh) {
  if (stored.quoteVersion !== fresh.quoteVersion) return 'financial_quote_version_changed';
  if (stored.approvedCents !== fresh.approvedCents) return 'financial_approved_amount_changed';
  if (stored.grossSettledCents !== fresh.grossSettledCents) return 'financial_gross_settled_changed';
  if (stored.refundedCents !== fresh.refundedCents) return 'financial_refunded_changed';
  if (stored.settledCents !== fresh.settledCents) return 'financial_settled_changed';
  return null;
}

/**
 * @param {object} [input]
 * @param {object} [input.booking] server booking record
 * @param {object} [input.financial] wrapper from the strict projection reader
 * @param {object} [input.issuance] stored squareLinkPreparation
 * @param {object} [input.providerConfig] ignored; not a credential or a location
 */
function evaluateSquarePaymentLinkPreflight(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const booking = source.booking;
  const financial = source.financial;
  const issuance = source.issuance;

  if (!booking || typeof booking !== 'object' || Array.isArray(booking)) {
    return decision(false, 'booking_required');
  }
  const bookingId = bookingIdOf(booking);
  if (!bookingId) return decision(false, 'booking_required');

  if (!issuance || typeof issuance !== 'object' || Array.isArray(issuance)) {
    return decision(false, 'issuance_required');
  }
  if (issuance.state !== PREPARED) return decision(false, 'preparation_state_unsupported');
  if (issuance.bookingId !== bookingId) return decision(false, 'financial_booking_mismatch');
  if (typeof issuance.issuanceId !== 'string' || !ISSUANCE_ID_PATTERN.test(issuance.issuanceId)) {
    return decision(false, 'issuance_identity_invalid');
  }
  if (typeof issuance.currency !== 'string' || issuance.currency !== 'USD') {
    return decision(false, 'financial_currency_unsupported');
  }
  const operationId = operationIdentity({
    issuanceId: issuance.issuanceId,
    bookingId: issuance.bookingId,
    amountCents: issuance.amountCents,
    currency: issuance.currency,
  });
  if (typeof issuance.operationId !== 'string' || issuance.operationId !== operationId) {
    return decision(false, 'operation_identity_mismatch');
  }

  if (!financial || typeof financial !== 'object' || Array.isArray(financial) || financial.ok !== true) {
    if (financial && financial.authority === 'blob') {
      return decision(false, 'financial_blob_fallback_rejected');
    }
    return decision(false, 'financial_authority_unavailable');
  }
  const projection = financial.projection;
  if (
    financial.authority !== 'postgres'
    || !projection
    || typeof projection !== 'object'
    || Array.isArray(projection)
    || projection.authority !== 'postgres'
  ) {
    return decision(false, 'financial_source_unverified');
  }
  if (String(projection.bookingId || '') !== bookingId) {
    return decision(false, 'financial_booking_mismatch');
  }
  if (financial.bookingId != null && String(financial.bookingId) !== bookingId) {
    return decision(false, 'financial_booking_mismatch');
  }

  const pgCurrency = typeof projection.currency === 'string'
    ? projection.currency.trim().toLowerCase()
    : '';
  const blobCurrency = String(booking.ledger && booking.ledger.currency || '').trim().toLowerCase();
  if (!pgCurrency || !blobCurrency || pgCurrency !== blobCurrency || pgCurrency !== 'usd') {
    return decision(false, 'financial_currency_unsupported');
  }

  const money = moneyConflict(booking);
  if (money.conflict || typeof money.remainingCents !== 'number') {
    return decision(false, 'financial_blob_balance_invalid');
  }
  const pgRemaining = integerCents(projection.remainingCents);
  const blobRemaining = integerCents(money.remainingCents);
  const pgApproved = integerCents(projection.approvedCents);
  const blobApproved = integerCents(booking.ledger && booking.ledger.approvedCents);
  if (pgRemaining == null || blobRemaining == null || pgApproved == null || blobApproved == null) {
    return decision(false, 'financial_amount_invalid');
  }
  if (pgApproved !== blobApproved) return decision(false, 'financial_approved_amount_mismatch');

  const pgVersion = integerVersion(projection.quoteVersion);
  const blobVersion = integerVersion(booking.quoteVersion);
  if (pgVersion == null || blobVersion == null) return decision(false, 'financial_version_invalid');
  if (pgVersion !== blobVersion) return decision(false, 'financial_quote_version_mismatch');
  if (pgRemaining !== blobRemaining) return decision(false, 'financial_balance_mismatch');

  const grossSettledCents = integerCents(projection.grossSettledCents);
  const refundedCents = integerCents(projection.refundedCents);
  const settledCents = integerCents(projection.settledCents);
  if (grossSettledCents == null || refundedCents == null || settledCents == null) {
    return decision(false, 'financial_amount_invalid');
  }
  if (!(pgRemaining > 0 && money.payable && blobRemaining === pgRemaining)) {
    return decision(false, 'not_payable');
  }

  const storedSnapshot = classifyStoredSnapshot(issuance);
  if (!storedSnapshot.ok) return decision(false, storedSnapshot.error);
  const divergence = snapshotDivergence(storedSnapshot.snapshot, {
    quoteVersion: pgVersion,
    approvedCents: pgApproved,
    grossSettledCents,
    refundedCents,
    settledCents,
  });
  if (divergence) return decision(false, divergence);

  const issuedAmount = integerCents(issuance.amountCents);
  if (issuedAmount == null) return decision(false, 'financial_amount_invalid');
  if (issuedAmount !== pgRemaining) return decision(false, 'payable_balance_changed');

  return decision(true);
}

module.exports = {
  evaluateSquarePaymentLinkPreflight,
};
