'use strict';

/**
 * Read-only historical payment classification. Pure functions only.
 * Never writes Blob, Postgres, Stripe, or the ledger.
 */

const { computeFinancialProjection } = require('./db/financial-projection');
const { canPayBalance } = require('./appointment-status-policy');

const CLASSIFICATIONS = Object.freeze([
  'duplicate_charge_confirmed',
  'booking_mismatch',
  'currency_mismatch',
  'refunded_or_disputed',
  'cash_conflict',
  'amount_mismatch',
  'blob_paid_ledger_missing',
  'stripe_paid_blob_due',
  'captured_without_purpose',
  'provider_missing',
  'stripe_capture_unreferenced_locally',
  'stripe_capture_without_booking',
  'duplicate_settlement_risk',
  'consistent_paid',
  'consistent_partial',
  'consistent_due',
  'manual_review',
]);

/** Primary classification precedence. First match among collected reasons wins. */
const PRIMARY_PRECEDENCE = Object.freeze([
  'duplicate_charge_confirmed',
  'booking_mismatch',
  'stripe_capture_without_booking',
  'stripe_capture_unreferenced_locally',
  'currency_mismatch',
  'refunded_or_disputed',
  'cash_conflict',
  'amount_mismatch',
  'blob_paid_ledger_missing',
  'stripe_paid_blob_due',
  'captured_without_purpose',
  'provider_missing',
  'duplicate_settlement_risk',
  'consistent_paid',
  'consistent_partial',
  'consistent_due',
  'manual_review',
]);

const REASON_CODES = Object.freeze([
  ...CLASSIFICATIONS,
  'multiple_succeeded_payment_intents',
  'provider_payment_known_locally',
  'provider_scan_incomplete',
]);

const OBSERVED_PURPOSES = new Set([
  'approved_balance_after_service',
  'authoritative_balance',
  'customer_balance',
]);

const CONSISTENT = new Set(['consistent_paid', 'consistent_partial', 'consistent_due']);

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
  'from',
  'to',
  'since',
  'until',
  'created',
  'coverageStart',
  'coverageEnd',
  'startAt',
  'endAt',
]);

const PAID_BLOB = new Set([
  'paid',
  'paid_cash',
  'paid_card_on_site',
  'succeeded',
  'captured',
]);

const CANONICAL_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const COVERAGE_OVERRIDE_KEYS = new Set([
  'from',
  'to',
  'since',
  'until',
  'created',
  'coverageStart',
  'coverageEnd',
  'startAt',
  'endAt',
  'FINANCIAL_AUDIT_COVERAGE_START',
  'x-coverage-start',
  'x-coverage-end',
]);

class FinancialAuditConfigurationError extends Error {
  constructor(reason) {
    super('financial_audit_not_configured');
    this.name = 'FinancialAuditConfigurationError';
    this.reason = reason;
  }
}

function roundCents(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'bigint') return Number(value);
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

function dollarsToCents(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 0;
    return Math.round(value * 100);
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
  return roundCents(blob.amountCapturedCents) > 0;
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

function looksLikeCardetail1BookingId(value) {
  return /^CD1[-_A-Za-z0-9]/i.test(String(value || '').trim());
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

function extractPostgresSnapshot(rows, bookingId) {
  const paymentAttempts = Array.isArray(rows && rows.paymentAttempts) ? rows.paymentAttempts : [];
  const ledgerEntries = Array.isArray(rows && rows.ledgerEntries) ? rows.ledgerEntries : [];
  const refundRequests = Array.isArray(rows && rows.refundRequests) ? rows.refundRequests : [];
  const stripeEvents = Array.isArray(rows && rows.stripeEvents) ? rows.stripeEvents : [];
  const hasFinancial = !!(rows && (rows.booking || paymentAttempts.length || ledgerEntries.length || stripeEvents.length));
  if (!hasFinancial) {
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
  const quote = (rows && rows.quote) || null;
  const booking = (rows && rows.booking) || { id: bookingId };
  const projection = computeFinancialProjection({
    booking,
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
    stripeEvents,
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
  const authority = postgres.exists ? 'postgres' : (blob ? 'blob' : 'none');
  const approvedCents = postgres.exists ? postgres.approvedCents : blobSnap.approvedCents;
  const settledCents = postgres.exists ? postgres.netSettledCents : blobSnap.amountPaidCents;
  const remainingCents = remainingClamped(approvedCents, settledCents);
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

function garageSignals({ postgres, garage, reasons }) {
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
    canPayUnreconciledCapture: !!(garage.canPay && reasons.includes('blob_paid_ledger_missing')),
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
    if (received > 0 && String(row.status || '') === 'succeeded') {
      sum += received;
      captures += 1;
    } else if (received > 0) {
      sum += received;
      captures += 1;
    }
  }
  return { sum, captures };
}

function pickPrimary(reasons) {
  for (const name of PRIMARY_PRECEDENCE) {
    if (reasons.includes(name)) return name;
  }
  return 'manual_review';
}

function classifyBooking({
  blob,
  postgres,
  stripeById,
  stripeErrors = 0,
  providerScanIncomplete = false,
  extraSucceededFromProvider = 0,
} = {}) {
  const blobSnap = extractBlobSnapshot(blob || {});
  const pg = extractPostgresSnapshot(postgres, blobSnap.bookingId);
  const garage = garageProjection({ blob, postgres: pg });
  const knownLocalIds = collectPaymentIntentIds(blob, pg);
  const stripeRows = Object.values(stripeById || {});
  const foundRows = stripeRows.filter((row) => row && row.found);
  const missingIds = knownLocalIds.filter((id) => {
    const row = stripeById && stripeById[id];
    return row && row.missing === true;
  });
  const { sum: stripeCapturedCents, captures } = stripeGrossCaptured(stripeById);
  const approvedCents = pg.exists ? pg.approvedCents : blobSnap.approvedCents;
  const netSettledCents = pg.exists ? pg.netSettledCents : blobSnap.amountPaidCents;
  const remainingRaw = remainingUnclamped(approvedCents, netSettledCents);
  const remainingCents = remainingClamped(approvedCents, netSettledCents);
  const settlementCount = pg.ledgerEntries.filter((entry) => entry.kind === 'settlement').length;
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

  const reasons = [];
  const add = (code) => {
    if (code && !reasons.includes(code)) reasons.push(code);
  };

  if (providerScanIncomplete) add('provider_scan_incomplete');

  const succeededFound = foundRows.filter((row) => (
    String(row.status || '') === 'succeeded' || roundCents(row.amountReceived) > 0
  ));
  if (captures > 1 || extraSucceededFromProvider > 1 || succeededFound.length > 1) {
    add('duplicate_charge_confirmed');
    add('multiple_succeeded_payment_intents');
  }

  if (foundRows.some((row) => {
    const metaId = String(row.metadataBookingId || '').trim();
    return metaId && blobSnap.bookingId && metaId !== blobSnap.bookingId;
  })) {
    add('booking_mismatch');
  }

  if (
    (blobSnap.currency && blobSnap.currency !== 'usd')
    || (pg.exists && pg.currency && pg.currency !== 'usd')
    || foundRows.some((row) => row.currency && String(row.currency).toLowerCase() !== 'usd')
  ) {
    add('currency_mismatch');
  }

  if (
    foundRows.some((row) => row.disputed || roundCents(row.refundedAmount) > 0)
    || (pg.exists && pg.refundedCents > 0)
    || blobSnap.refund
  ) {
    add('refunded_or_disputed');
  }

  if (pg.cashSettledCents > 0 && stripeCapturedCents > 0) add('cash_conflict');

  if (remainingRaw < 0 || (pg.exists && pg.outstandingCreditCents > 0 && pg.grossSettledCents > 0)) {
    add('amount_mismatch');
  } else if (
    pg.exists
    && captures === 1
    && stripeCapturedCents !== pg.stripeSettledCents
    && pg.cashSettledCents === 0
    && pg.grossSettledCents > 0
  ) {
    add('amount_mismatch');
  }

  if (
    blobSnap.paid
    && stripeCapturedCents > 0
    && (!pg.exists || pg.grossSettledCents === 0 || pg.paymentAttempts.length === 0)
  ) {
    add('blob_paid_ledger_missing');
  }

  if (
    pg.exists
    && pg.remainingCents === 0
    && pg.grossSettledCents > 0
    && stripeCapturedCents > 0
    && (!blobSnap.paid || garage.remainingCents > 0 || garage.canPay)
  ) {
    add('stripe_paid_blob_due');
  }

  if (foundRows.some((row) => (
    roundCents(row.amountReceived) > 0 && !OBSERVED_PURPOSES.has(String(row.metadataPurpose || ''))
  ))) {
    add('captured_without_purpose');
  }

  if (missingIds.length > 0) add('provider_missing');

  const localKnown = knownLocalIds.length > 0 || pg.paymentAttempts.length > 0 || settlementCount > 0;
  if (localKnown) add('provider_payment_known_locally');

  if (
    stripeCapturedCents > 0
    && !blob
    && (!pg.exists || (pg.paymentAttempts.length === 0 && pg.grossSettledCents === 0))
  ) {
    add('stripe_capture_unreferenced_locally');
  }

  if (foundRows.some((row) => (
    roundCents(row.amountReceived) > 0 && !String(row.metadataBookingId || '').trim()
  ))) {
    add('stripe_capture_without_booking');
  }

  const settlements = pg.ledgerEntries.filter((entry) => entry.kind === 'settlement');
  const succeededAttempts = pg.paymentAttempts.filter((attempt) => attempt.status === 'succeeded');
  const activeAttempts = pg.paymentAttempts.filter((attempt) => (
    attempt.status === 'creating' || attempt.status === 'open' || attempt.status === 'requires_action'
  ));
  const settlementEventIds = settlements.map((entry) => String(entry.providerEventId || ''));
  const duplicateEvent = settlementEventIds.some((id, i) => id && settlementEventIds.indexOf(id) !== i);
  if (duplicateEvent || (succeededAttempts.length > 1 && captures <= 1) || (activeAttempts.length > 0 && succeededAttempts.length > 0)) {
    add('duplicate_settlement_risk');
  }

  const hasBlocking = reasons.some((code) => !CONSISTENT.has(code)
    && code !== 'provider_payment_known_locally'
    && code !== 'provider_scan_incomplete');

  if (!hasBlocking) {
    if (providerScanIncomplete) {
      add('manual_review');
    } else if (
      stripeCapturedCents > 0
      && pg.exists
      && pg.grossSettledCents > 0
      && remainingCents === 0
      && blobSnap.paid
      && stripeCapturedCents === pg.stripeSettledCents
    ) {
      add('consistent_paid');
    } else if (
      stripeCapturedCents > 0
      && pg.exists
      && remainingCents > 0
      && remainingRaw === remainingCents
      && stripeCapturedCents === pg.stripeSettledCents
      && stripeCapturedCents < approvedCents
    ) {
      add('consistent_partial');
    } else if (
      stripeCapturedCents === 0
      && captures === 0
      && missingIds.length === 0
      && (!pg.exists || pg.grossSettledCents === 0)
      && remainingCents === approvedCents
      && !blobSnap.paid
    ) {
      add('consistent_due');
    } else {
      add('manual_review');
    }
  }

  if (
    (stripeErrors > 0 || stripeRows.some((row) => row && row.error))
    && reasons.some((code) => CONSISTENT.has(code))
  ) {
    add('manual_review');
  }

  if (reasons.length === 0) add('manual_review');

  const primaryClassification = pickPrimary(reasons);
  const signals = garageSignals({ postgres: pg, garage, reasons });
  const requiresManualReview = !CONSISTENT.has(primaryClassification);
  return {
    classification: primaryClassification,
    primaryClassification,
    reasonCodes: reasons,
    values,
    garage,
    garageSignals: signals,
    paymentIntentCount: Math.max(knownLocalIds.length, Object.keys(stripeById || {}).length),
    settlementCount,
    stripeErrorCount: stripeErrors,
    requiresManualReview,
  };
}

function classifyOrphanProviderIntent(row, { knownLocally, providerScanIncomplete }) {
  const reasons = [];
  if (providerScanIncomplete) reasons.push('provider_scan_incomplete');
  if (knownLocally) reasons.push('provider_payment_known_locally');
  const received = roundCents(row && row.amountReceived);
  const bookingMeta = String((row && row.metadataBookingId) || '').trim();
  if (received > 0 && !bookingMeta) reasons.push('stripe_capture_without_booking');
  if (received > 0 && bookingMeta && !knownLocally) reasons.push('stripe_capture_unreferenced_locally');
  if (received > 0 && !OBSERVED_PURPOSES.has(String((row && row.metadataPurpose) || ''))) {
    reasons.push('captured_without_purpose');
  }
  if (row && (row.disputed || roundCents(row.refundedAmount) > 0)) reasons.push('refunded_or_disputed');
  if (reasons.length === 0) reasons.push('manual_review');
  const primaryClassification = pickPrimary(reasons);
  return {
    classification: primaryClassification,
    primaryClassification,
    reasonCodes: reasons,
    values: {
      approvedCents: 0,
      stripeGrossCapturedCents: received,
      ledgerGrossSettlementsCents: 0,
      cashSettlementsCents: 0,
      refundsCents: roundCents(row && row.refundedAmount),
      netSettledCents: 0,
      remainingBalanceCents: 0,
      remainingUnclampedCents: 0,
    },
    garage: {
      authority: 'none',
      paymentStatus: 'unknown',
      remainingCents: 0,
      approvedCents: 0,
      settledCents: 0,
      canPay: false,
      blobBalanceDueCents: 0,
    },
    garageSignals: {
      ledgerPaidShownDue: false,
      ledgerDueShownPaid: false,
      canPayZeroBalance: false,
      canPayUnreconciledCapture: false,
      balanceDueMismatch: false,
    },
    paymentIntentCount: 1,
    settlementCount: 0,
    stripeErrorCount: row && row.error ? 1 : 0,
    requiresManualReview: true,
  };
}

function mergeUniverse(groups) {
  const counts = {};
  const set = new Set();
  for (const [source, ids] of Object.entries(groups || {})) {
    const unique = new Set();
    for (const id of ids || []) {
      const value = String(id || '').trim();
      if (!value) continue;
      unique.add(value);
      set.add(value);
    }
    counts[source] = unique.size;
  }
  const union = [...set].sort();
  return { counts, union, unionCount: union.length };
}

function pageSortedIds(sortedIds, afterId, limit) {
  const list = Array.isArray(sortedIds) ? sortedIds : [];
  const next = afterId
    ? list.filter((id) => id > afterId)
    : list.slice();
  return next.slice(0, limit);
}

function emptyTotals() {
  const byClass = {};
  for (const name of CLASSIFICATIONS) {
    byClass[name] = { count: 0, approvedCents: 0, stripeGrossCapturedCents: 0, netSettledCents: 0 };
  }
  const byReason = {};
  for (const name of REASON_CODES) byReason[name] = 0;
  return {
    bookingsExamined: 0,
    byClassification: byClass,
    byReasonOverlapping: byReason,
    oldestDivergenceAgeMs: 0,
    paymentIntentsRetrieved: 0,
    stripeErrors: 0,
    postgresErrors: 0,
    blobErrors: 0,
    unclassifiedCount: 0,
    pagesProcessed: 0,
    garage: {
      ledgerPaidShownDue: 0,
      ledgerDueShownPaid: 0,
      canPayZeroBalance: 0,
      canPayUnreconciledCapture: 0,
      balanceDueMismatch: 0,
    },
    sources: {
      blob: 0,
      postgresBookings: 0,
      paymentAttempts: 0,
      ledgerEntries: 0,
      stripeEvents: 0,
      stripeMetadata: 0,
      union: 0,
    },
  };
}

function addClassification(totals, result, ageMs) {
  totals.bookingsExamined += 1;
  const primary = result.primaryClassification || result.classification;
  const bucket = totals.byClassification[primary];
  if (bucket) {
    bucket.count += 1;
    bucket.approvedCents += result.values.approvedCents;
    bucket.stripeGrossCapturedCents += result.values.stripeGrossCapturedCents;
    bucket.netSettledCents += result.values.netSettledCents;
  } else {
    totals.unclassifiedCount += 1;
  }
  for (const reason of result.reasonCodes || []) {
    if (totals.byReasonOverlapping[reason] == null) totals.byReasonOverlapping[reason] = 0;
    totals.byReasonOverlapping[reason] += 1;
  }
  if (!CONSISTENT.has(primary) && ageMs > totals.oldestDivergenceAgeMs) {
    totals.oldestDivergenceAgeMs = ageMs;
  }
  totals.paymentIntentsRetrieved += result.paymentIntentCount;
  totals.stripeErrors += result.stripeErrorCount;
  for (const key of Object.keys(totals.garage)) {
    if (result.garageSignals && result.garageSignals[key]) totals.garage[key] += 1;
  }
}

function candidateFromResult(auditRef, result) {
  if (CONSISTENT.has(result.primaryClassification || result.classification)) return null;
  return {
    auditRef,
    primaryClassification: result.primaryClassification || result.classification,
    reasonCodes: result.reasonCodes || [],
    values: {
      approved: result.values.approvedCents,
      stripeCaptured: result.values.stripeGrossCapturedCents,
      ledgerSettled: result.values.ledgerGrossSettlementsCents,
      refunded: result.values.refundsCents,
      netSettled: result.values.netSettledCents,
      remaining: result.values.remainingBalanceCents,
    },
    paymentIntentCount: result.paymentIntentCount,
    settlementCount: result.settlementCount,
    requiresManualReview: result.requiresManualReview !== false,
  };
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

function coverageWindow(env = process.env, nowMs = Date.now()) {
  if (env == null || typeof env !== 'object') {
    throw new FinancialAuditConfigurationError('coverage_start_missing');
  }
  if (!Object.prototype.hasOwnProperty.call(env, 'FINANCIAL_AUDIT_COVERAGE_START')) {
    throw new FinancialAuditConfigurationError('coverage_start_missing');
  }
  const value = env.FINANCIAL_AUDIT_COVERAGE_START;
  if (value === undefined || value === null) {
    throw new FinancialAuditConfigurationError('coverage_start_missing');
  }
  if (typeof value !== 'string') {
    throw new FinancialAuditConfigurationError('coverage_start_invalid');
  }
  if (value === '' || /^\s+$/.test(value)) {
    throw new FinancialAuditConfigurationError('coverage_start_missing');
  }
  if (!CANONICAL_UTC_MS.test(value)) {
    throw new FinancialAuditConfigurationError('coverage_start_invalid');
  }
  const startedMs = Date.parse(value);
  if (!Number.isFinite(startedMs)) {
    throw new FinancialAuditConfigurationError('coverage_start_invalid');
  }
  if (new Date(startedMs).toISOString() !== value) {
    throw new FinancialAuditConfigurationError('coverage_start_invalid');
  }
  const endedMs = nowMs;
  if (!Number.isFinite(endedMs) || startedMs >= endedMs) {
    throw new FinancialAuditConfigurationError('coverage_start_not_before_end');
  }
  return {
    coverageStartedAt: value,
    coverageEndedAt: new Date(endedMs).toISOString(),
    startedMs,
    endedMs,
  };
}

function findCoverageOverrideChannels(event) {
  const hits = [];
  const body = event && event.__parsedBody;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    hits.push(...findForbiddenBodyKeys(body).filter((path) => {
      const key = path.split('.').pop();
      return COVERAGE_OVERRIDE_KEYS.has(key);
    }));
  }
  const query = Object.assign(
    {},
    (event && event.queryStringParameters) || {},
    (event && event.multiValueQueryStringParameters) || {},
  );
  for (const key of Object.keys(query)) {
    if (COVERAGE_OVERRIDE_KEYS.has(key) || FORBIDDEN_BODY_KEYS.has(key)) {
      hits.push(`query.${key}`);
    }
  }
  const headers = (event && event.headers) || {};
  for (const key of Object.keys(headers)) {
    const lower = String(key).toLowerCase();
    if (COVERAGE_OVERRIDE_KEYS.has(lower) || COVERAGE_OVERRIDE_KEYS.has(key) || FORBIDDEN_BODY_KEYS.has(lower)) {
      if (lower === 'from' || lower === 'to' || lower === 'since' || lower === 'until' || lower === 'created'
        || lower.startsWith('x-coverage') || lower === 'coveragestart' || lower === 'coverageend'
        || lower === 'startat' || lower === 'endat' || lower === 'financial_audit_coverage_start') {
        hits.push(`header.${lower}`);
      }
    }
  }
  return hits;
}

module.exports = {
  CLASSIFICATIONS,
  PRIMARY_PRECEDENCE,
  REASON_CODES,
  FORBIDDEN_BODY_KEYS,
  COVERAGE_OVERRIDE_KEYS,
  OBSERVED_PURPOSES,
  CONSISTENT,
  FinancialAuditConfigurationError,
  roundCents,
  dollarsToCents,
  remainingUnclamped,
  remainingClamped,
  collectPaymentIntentIds,
  extractBlobSnapshot,
  extractPostgresSnapshot,
  garageProjection,
  classifyBooking,
  classifyOrphanProviderIntent,
  mergeUniverse,
  pageSortedIds,
  emptyTotals,
  addClassification,
  candidateFromResult,
  findForbiddenBodyKeys,
  blobIndicatesPaid,
  looksLikeCardetail1BookingId,
  coverageWindow,
  findCoverageOverrideChannels,
  pickPrimary,
};
