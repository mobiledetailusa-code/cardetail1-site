'use strict';

/**
 * Read-only historical payment classification. Pure functions only.
 * Never writes Blob, Postgres, Stripe, or the ledger.
 */

const { computeFinancialProjection } = require('./db/financial-projection');
const { canPayBalance } = require('./appointment-status-policy');

const CLASSIFICATIONS = Object.freeze([
  'consistent_paid',
  'consistent_partial',
  'consistent_due',
  'blob_paid_ledger_missing',
  'stripe_paid_blob_due',
  'captured_without_purpose',
  'amount_mismatch',
  'currency_mismatch',
  'booking_mismatch',
  'duplicate_settlement_risk',
  'duplicate_charge_confirmed',
  'refunded_or_disputed',
  'cash_conflict',
  'provider_missing',
  'manual_review',
]);

const OBSERVED_PURPOSES = new Set([
  'approved_balance_after_service',
  'authoritative_balance',
  'customer_balance',
]);

const FORBIDDEN_BODY_KEYS = new Set([
  'apply',
  'fix',
  'backfill',
  'write',
  'reconcile',
  'environment',
  'env',
  'stripeMode',
  'context',
  'database',
  'paymentIntent',
  'payment_intent',
  'paymentStatus',
  'price',
  'amount',
  'remainingCents',
  'approvedFinalAmount',
  'DATABASE_URL',
  'STRIPE_SECRET_KEY',
]);

const PAID_BLOB = new Set([
  'paid',
  'paid_cash',
  'paid_card_on_site',
  'succeeded',
  'captured',
]);

function roundCents(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'bigint') return Number(value);
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

/** Parse a dollar amount into integer cents without leaving a float remainder. */
function dollarsToCents(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 0;
    const scaled = value * 100;
    const asInt = Math.round(scaled);
    return asInt;
  }
  const text = String(value).trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) {
    const n = Number(text);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 100);
  }
  const sign = match[1] === '-' ? -1 : 1;
  const whole = Number.parseInt(match[2], 10);
  const frac = Number.parseInt((match[3] || '00').padEnd(2, '0').slice(0, 2), 10);
  return sign * (whole * 100 + frac);
}

function remainingUnclamped(approvedCents, netSettledCents) {
  return roundCents(approvedCents) - roundCents(netSettledCents);
}

function remainingClamped(approvedCents, netSettledCents) {
  const raw = remainingUnclamped(approvedCents, netSettledCents);
  return raw < 0 ? 0 : raw;
}

function blobIndicatesPaid(blob) {
  const pay = String(blob.paymentStatus || '').toLowerCase();
  const pwf = String(blob.paymentWorkflowStatus || '').toLowerCase();
  const job = String(blob.jobStatus || '').toLowerCase();
  if (PAID_BLOB.has(pay)) return true;
  if (pwf === 'payment_succeeded' || pwf === 'cash_paid') return true;
  if (job === 'completed_paid') return true;
  const captured = roundCents(blob.amountCapturedCents);
  return captured > 0;
}

function blobIndicatesCash(blob) {
  const pay = String(blob.paymentStatus || '').toLowerCase();
  const pwf = String(blob.paymentWorkflowStatus || '').toLowerCase();
  if (pay === 'paid_cash' || pwf === 'cash_paid') return true;
  const entries = Array.isArray(blob.ledger && blob.ledger.entries) ? blob.ledger.entries : [];
  return entries.some((entry) => {
    const provider = String(entry && entry.providerObjectId || '');
    const eventId = String(entry && entry.providerEventId || '');
    return provider === 'cash' || eventId.startsWith('cash_full_balance:');
  });
}

function blobIndicatesRefund(blob) {
  const refundStatus = String(blob.refundStatus || '').toLowerCase();
  if (refundStatus && refundStatus !== 'none') return true;
  const entries = Array.isArray(blob.ledger && blob.ledger.entries) ? blob.ledger.entries : [];
  return entries.some((entry) => String(entry && entry.kind || '').toLowerCase() === 'refund');
}

function collectPaymentIntentIds(blob, postgres) {
  const ids = new Set();
  const add = (value) => {
    const id = String(value || '').trim();
    if (id.startsWith('pi_')) ids.add(id);
  };
  if (blob) {
    add(blob.paymentIntentId);
    add(blob.stripePaymentIntentId);
    add(blob.afterServiceCharge && blob.afterServiceCharge.paymentIntentId);
    const entries = Array.isArray(blob.ledger && blob.ledger.entries) ? blob.ledger.entries : [];
    for (const entry of entries) add(entry && entry.providerObjectId);
  }
  if (postgres) {
    for (const attempt of postgres.paymentAttempts || []) add(attempt.providerObjectId);
    for (const entry of postgres.ledgerEntries || []) add(entry.providerObjectId);
  }
  return [...ids].sort();
}

function isCashSettlement(entry) {
  if (!entry || entry.kind !== 'settlement') return false;
  const provider = String(entry.providerObjectId || '');
  const eventId = String(entry.providerEventId || '');
  return provider === 'cash' || eventId.startsWith('cash_full_balance:');
}

function extractBlobSnapshot(blob) {
  const bookingId = String((blob && (blob.id || blob.bookingId)) || '').trim();
  const approvedCents = blob && blob.ledger && blob.ledger.approvedCents != null
    ? roundCents(blob.ledger.approvedCents)
    : dollarsToCents(blob && blob.approvedFinalAmount);
  const amountPaidCents = blob && blob.ledger && blob.ledger.settledCents != null
    ? roundCents(blob.ledger.settledCents)
    : dollarsToCents(blob && (blob.amountPaid != null ? blob.amountPaid : blob.paidAmount));
  const amountCapturedCents = roundCents(blob && blob.amountCapturedCents);
  const currency = String((blob && blob.currency) || (blob && blob.ledger && blob.ledger.currency) || 'usd')
    .trim()
    .toLowerCase() || 'usd';
  return {
    bookingId,
    approvedCents,
    amountPaidCents,
    amountCapturedCents,
    paymentStatus: String((blob && blob.paymentStatus) || ''),
    paymentWorkflowStatus: String((blob && blob.paymentWorkflowStatus) || ''),
    jobStatus: String((blob && blob.jobStatus) || ''),
    currency,
    hasPackageSnapshot: !!(blob && blob.packageSnapshot),
    cash: blobIndicatesCash(blob || {}),
    refund: blobIndicatesRefund(blob || {}),
    paid: blobIndicatesPaid(blob || {}),
  };
}

function extractPostgresSnapshot(rows) {
  if (!rows || !rows.booking) {
    return {
      exists: false,
      paymentAttempts: [],
      ledgerEntries: [],
      stripeEvents: [],
      approvedCents: 0,
      currency: null,
      grossSettledCents: 0,
      cashSettledCents: 0,
      refundedCents: 0,
      netSettledCents: 0,
      remainingCents: 0,
      remainingUnclamped: 0,
      paymentStatus: null,
    };
  }
  const quote = rows.quote || null;
  const paymentAttempts = Array.isArray(rows.paymentAttempts) ? rows.paymentAttempts : [];
  const ledgerEntries = Array.isArray(rows.ledgerEntries) ? rows.ledgerEntries : [];
  const refundRequests = Array.isArray(rows.refundRequests) ? rows.refundRequests : [];
  const projection = computeFinancialProjection({
    booking: rows.booking,
    quote,
    paymentAttempts,
    ledgerEntries,
    refundRequests,
  });
  const cashSettledCents = ledgerEntries
    .filter(isCashSettlement)
    .reduce((sum, entry) => sum + roundCents(entry.amountCents), 0);
  const stripeSettledCents = ledgerEntries
    .filter((entry) => entry.kind === 'settlement' && !isCashSettlement(entry))
    .reduce((sum, entry) => sum + roundCents(entry.amountCents), 0);
  const remainingRaw = remainingUnclamped(projection.approvedCents, projection.settledCents);
  return {
    exists: true,
    quoteVersion: quote ? quote.quoteVersion : null,
    paymentAttempts,
    ledgerEntries,
    stripeEvents: Array.isArray(rows.stripeEvents) ? rows.stripeEvents : [],
    refundRequests,
    approvedCents: projection.approvedCents,
    currency: String((quote && quote.currency) || 'usd').toLowerCase(),
    grossSettledCents: projection.grossSettledCents,
    cashSettledCents,
    stripeSettledCents,
    refundedCents: projection.refundedCents,
    netSettledCents: projection.settledCents,
    remainingCents: projection.remainingCents,
    remainingUnclamped: remainingRaw,
    paymentStatus: projection.paymentStatus,
    outstandingCreditCents: projection.outstandingCreditCents,
  };
}

function garageProjection({ blob, postgres }) {
  const blobSnap = extractBlobSnapshot(blob || {});
  const payAllowed = canPayBalance(blob || {});
  const authority = postgres.exists ? 'postgres' : 'blob';
  const approvedCents = postgres.exists ? postgres.approvedCents : blobSnap.approvedCents;
  const settledCents = postgres.exists ? postgres.netSettledCents : blobSnap.amountPaidCents;
  const remainingCents = postgres.exists
    ? remainingClamped(approvedCents, settledCents)
    : remainingClamped(blobSnap.approvedCents, blobSnap.amountPaidCents);
  const paymentStatus = postgres.exists
    ? postgres.paymentStatus
    : (blobSnap.paid && remainingCents === 0 ? 'paid' : (remainingCents > 0 ? 'due' : 'not_due'));
  const canPay = !!(payAllowed.ok && paymentStatus !== 'paid' && remainingCents > 0);
  const blobBalanceDueCents = blob && blob.balanceDue != null
    ? dollarsToCents(blob.balanceDue)
    : (blob && blob.amountDueApproved != null ? dollarsToCents(blob.amountDueApproved) : remainingCents);
  return {
    authority,
    paymentStatus,
    remainingCents,
    approvedCents,
    settledCents,
    canPay,
    blobBalanceDueCents,
  };
}

function garageSignals({ blob, postgres, garage, classification }) {
  const ledgerPaid = postgres.exists
    && postgres.netSettledCents > 0
    && postgres.remainingCents === 0
    && postgres.paymentStatus === 'paid';
  const ledgerDue = postgres.exists && postgres.remainingCents > 0;
  const shownDue = garage.paymentStatus === 'due' || garage.remainingCents > 0;
  const shownPaid = garage.paymentStatus === 'paid';
  return {
    ledgerPaidShownDue: !!(ledgerPaid && shownDue),
    ledgerDueShownPaid: !!(ledgerDue && shownPaid),
    canPayZeroBalance: !!(garage.canPay && garage.remainingCents === 0),
    canPayUnreconciledCapture: !!(
      garage.canPay && classification === 'blob_paid_ledger_missing'
    ),
    balanceDueMismatch: !!(
      postgres.exists && garage.blobBalanceDueCents !== postgres.remainingCents
    ),
  };
}

function stripeGrossCaptured(stripeById) {
  let sum = 0;
  let captures = 0;
  for (const row of Object.values(stripeById || {})) {
    if (!row || !row.found) continue;
    const received = roundCents(row.amountReceived);
    if (received > 0) {
      sum += received;
      captures += 1;
    }
  }
  return { sum, captures };
}

function classifyBooking({ blob, postgres, stripeById, stripeErrors = 0 }) {
  const blobSnap = extractBlobSnapshot(blob || {});
  const pg = extractPostgresSnapshot(postgres);
  const garage = garageProjection({ blob, postgres: pg });
  const knownIds = collectPaymentIntentIds(blob, pg);
  const stripeRows = knownIds.map((id) => stripeById && stripeById[id]).filter(Boolean);
  const foundRows = stripeRows.filter((row) => row.found);
  const missingIds = knownIds.filter((id) => {
    const row = stripeById && stripeById[id];
    return row && row.missing === true;
  });
  const { sum: stripeCapturedCents, captures } = stripeGrossCaptured(stripeById);
  const approvedCents = pg.exists ? pg.approvedCents : blobSnap.approvedCents;
  const netSettledCents = pg.exists ? pg.netSettledCents : blobSnap.amountPaidCents;
  const remainingRaw = remainingUnclamped(approvedCents, netSettledCents);
  const remainingCents = remainingClamped(approvedCents, netSettledCents);
  const values = {
    approvedCents,
    stripeGrossCapturedCents: stripeCapturedCents,
    ledgerGrossSettlementsCents: pg.exists ? pg.grossSettledCents : blobSnap.amountPaidCents,
    cashSettlementsCents: pg.exists ? pg.cashSettledCents : (blobSnap.cash ? blobSnap.amountPaidCents : 0),
    refundsCents: pg.exists ? pg.refundedCents : 0,
    netSettledCents,
    remainingBalanceCents: remainingCents,
    remainingUnclampedCents: remainingRaw,
  };

  let classification = 'manual_review';
  if (stripeErrors > 0 && foundRows.length === 0 && missingIds.length === 0 && knownIds.length > 0) {
    classification = 'manual_review';
  } else if (missingIds.length > 0) {
    classification = 'provider_missing';
  } else if (foundRows.some((row) => {
    const metaId = String(row.metadataBookingId || '').trim();
    return metaId && blobSnap.bookingId && metaId !== blobSnap.bookingId;
  })) {
    classification = 'booking_mismatch';
  } else if (
    (blobSnap.currency && blobSnap.currency !== 'usd')
    || (pg.exists && pg.currency && pg.currency !== 'usd')
    || foundRows.some((row) => row.currency && String(row.currency).toLowerCase() !== 'usd')
  ) {
    classification = 'currency_mismatch';
  } else if (foundRows.some((row) => roundCents(row.amountReceived) > 0 && !OBSERVED_PURPOSES.has(String(row.metadataPurpose || '')))) {
    classification = 'captured_without_purpose';
  } else if (
    foundRows.some((row) => row.disputed || roundCents(row.refundedAmount) > 0)
    || (pg.exists && pg.refundedCents > 0)
    || blobSnap.refund
  ) {
    classification = 'refunded_or_disputed';
  } else if (pg.cashSettledCents > 0 && stripeCapturedCents > 0) {
    classification = 'cash_conflict';
  } else if (captures > 1) {
    classification = 'duplicate_charge_confirmed';
  } else {
    const settlements = pg.ledgerEntries.filter((entry) => entry.kind === 'settlement');
    const succeededAttempts = pg.paymentAttempts.filter((attempt) => attempt.status === 'succeeded');
    const activeAttempts = pg.paymentAttempts.filter((attempt) => (
      attempt.status === 'creating' || attempt.status === 'open' || attempt.status === 'requires_action'
    ));
    const settlementEventIds = settlements.map((entry) => String(entry.providerEventId || ''));
    const duplicateEvent = settlementEventIds.some((id, i) => id && settlementEventIds.indexOf(id) !== i);
    const multiAttemptSameQuote = (() => {
      const byQuote = new Map();
      for (const attempt of pg.paymentAttempts) {
        const key = String(attempt.quoteVersion);
        byQuote.set(key, (byQuote.get(key) || 0) + 1);
      }
      return [...byQuote.values()].some((count) => count > 1);
    })();
    if (duplicateEvent || (succeededAttempts.length > 1 && captures <= 1) || (activeAttempts.length > 0 && succeededAttempts.length > 0) || (multiAttemptSameQuote && knownIds.length > 1)) {
      classification = 'duplicate_settlement_risk';
    } else if (remainingRaw < 0 || (pg.exists && pg.outstandingCreditCents > 0 && pg.grossSettledCents > 0)) {
      classification = 'amount_mismatch';
    } else if (
      blobSnap.paid
      && stripeCapturedCents > 0
      && (!pg.exists || pg.grossSettledCents === 0 || pg.paymentAttempts.length === 0)
    ) {
      classification = 'blob_paid_ledger_missing';
    } else if (
      pg.exists
      && captures === 1
      && stripeCapturedCents !== pg.stripeSettledCents
      && pg.cashSettledCents === 0
    ) {
      classification = 'amount_mismatch';
    } else if (
      pg.exists
      && pg.remainingCents === 0
      && pg.grossSettledCents > 0
      && stripeCapturedCents > 0
      && (!blobSnap.paid || garage.remainingCents > 0 || garage.canPay)
    ) {
      classification = 'stripe_paid_blob_due';
    } else if (
      stripeCapturedCents > 0
      && pg.exists
      && pg.grossSettledCents > 0
      && remainingCents === 0
      && blobSnap.paid
      && stripeCapturedCents === pg.stripeSettledCents
    ) {
      classification = 'consistent_paid';
    } else if (
      stripeCapturedCents > 0
      && pg.exists
      && remainingCents > 0
      && remainingCents === remainingUnclamped(approvedCents, netSettledCents)
      && stripeCapturedCents === pg.stripeSettledCents
      && stripeCapturedCents < approvedCents
    ) {
      classification = 'consistent_partial';
    } else if (
      stripeCapturedCents === 0
      && captures === 0
      && missingIds.length === 0
      && (!pg.exists || pg.grossSettledCents === 0)
      && remainingCents === approvedCents
      && !blobSnap.paid
    ) {
      classification = 'consistent_due';
    } else {
      classification = 'manual_review';
    }
  }

  if (
    String(classification).startsWith('consistent_')
    && (stripeErrors > 0 || stripeRows.some((row) => row && row.error))
  ) {
    classification = 'manual_review';
  }

  const signals = garageSignals({ blob, postgres: pg, garage, classification });
  return {
    classification,
    values,
    garage,
    garageSignals: signals,
    paymentIntentCount: knownIds.length,
    stripeErrorCount: stripeErrors,
  };
}

function emptyTotals() {
  const byClass = {};
  for (const name of CLASSIFICATIONS) {
    byClass[name] = { count: 0, approvedCents: 0, stripeGrossCapturedCents: 0, netSettledCents: 0 };
  }
  return {
    bookingsExamined: 0,
    byClassification: byClass,
    oldestDivergenceAgeMs: 0,
    paymentIntentsRetrieved: 0,
    stripeErrors: 0,
    pagesProcessed: 0,
    garage: {
      ledgerPaidShownDue: 0,
      ledgerDueShownPaid: 0,
      canPayZeroBalance: 0,
      canPayUnreconciledCapture: 0,
      balanceDueMismatch: 0,
    },
  };
}

function addClassification(totals, result, ageMs) {
  totals.bookingsExamined += 1;
  const bucket = totals.byClassification[result.classification];
  bucket.count += 1;
  bucket.approvedCents += result.values.approvedCents;
  bucket.stripeGrossCapturedCents += result.values.stripeGrossCapturedCents;
  bucket.netSettledCents += result.values.netSettledCents;
  if (result.classification !== 'consistent_paid'
    && result.classification !== 'consistent_partial'
    && result.classification !== 'consistent_due'
    && ageMs > totals.oldestDivergenceAgeMs) {
    totals.oldestDivergenceAgeMs = ageMs;
  }
  totals.paymentIntentsRetrieved += result.paymentIntentCount;
  totals.stripeErrors += result.stripeErrorCount;
  for (const key of Object.keys(totals.garage)) {
    if (result.garageSignals[key]) totals.garage[key] += 1;
  }
}

function findForbiddenBodyKeys(body, trail = []) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const hits = [];
  for (const [key, value] of Object.entries(body)) {
    const path = trail.concat(key).join('.');
    if (FORBIDDEN_BODY_KEYS.has(key)) hits.push(path);
    if (key === 'reconcile' && value === true) hits.push(path);
    if (value && typeof value === 'object') hits.push(...findForbiddenBodyKeys(value, trail.concat(key)));
  }
  return hits;
}

module.exports = {
  CLASSIFICATIONS,
  FORBIDDEN_BODY_KEYS,
  OBSERVED_PURPOSES,
  roundCents,
  dollarsToCents,
  remainingUnclamped,
  remainingClamped,
  collectPaymentIntentIds,
  extractBlobSnapshot,
  extractPostgresSnapshot,
  garageProjection,
  classifyBooking,
  emptyTotals,
  addClassification,
  findForbiddenBodyKeys,
  blobIndicatesPaid,
};
