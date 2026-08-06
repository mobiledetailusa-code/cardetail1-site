/**
 * Price adjustment authority.
 *
 * An approved total is not an editable number. Changing what a customer owes is
 * an event with an author, a reason and a version — so it lives as a record, and
 * the total is a consequence of that record rather than something typed over.
 *
 * The three financial positions behave differently, and conflating them is what
 * makes money go missing:
 *
 *   nothing settled  → the adjustment simply revises the approved total.
 *   partly settled   → the approved total moves; remaining stays ledger-derived.
 *   fully settled    → an increase creates a *new* balance to collect; a decrease
 *                      creates a refund/credit review. Neither rewrites the
 *                      settlement that already happened.
 *
 * No path in this module issues a refund. Money leaving the business is a
 * separate authority with its own approval.
 */

const crypto = require('crypto');

const { financialProjection } = require('./payment-service');

const ADJUSTMENT_TYPES = ['increase', 'decrease'];

const ADJUSTMENT_STATUSES = [
  'draft',
  'pending_customer',
  'approved',
  'declined',
  'applied',
];

/** Outcome an applied adjustment produced, once the ledger position is known. */
const ADJUSTMENT_OUTCOMES = [
  'total_revised',
  'supplemental_balance_due',
  'refund_or_credit_review',
];

function adjustmentId() {
  return `adj_${crypto.randomBytes(6).toString('hex')}`;
}

function listAdjustments(booking) {
  return Array.isArray(booking && booking.priceAdjustments) ? booking.priceAdjustments : [];
}

function findAdjustment(booking, id) {
  const key = String(id || '').trim();
  if (!key) return null;
  return listAdjustments(booking).find((a) => a && String(a.adjustmentId) === key) || null;
}

function parseAmountCents(value) {
  if (value === undefined || value === null || value === '') {
    return { ok: false, error: 'amount_required' };
  }
  if (typeof value === 'boolean' || typeof value === 'object') {
    return { ok: false, error: 'invalid_amount' };
  }
  const num = Number(value);
  if (!Number.isFinite(num)) return { ok: false, error: 'invalid_amount' };
  const cents = Math.round(num);
  if (Math.abs(num - cents) > 1e-8) return { ok: false, error: 'invalid_amount' };
  if (cents <= 0) return { ok: false, error: 'invalid_amount' };
  return { ok: true, amountCents: cents };
}

function validateExpectedBookingVersion(booking, body = {}) {
  const expected = body.expectedBookingVersion;
  const actualBookingVersion = Math.round(Number(booking && booking.bookingVersion) || 0);
  if (expected == null || expected === '') {
    return { ok: false, error: 'expected_version_required', statusCode: 400, actualBookingVersion };
  }
  const expectedBookingVersion = Math.round(Number(expected));
  if (!Number.isFinite(expectedBookingVersion) || expectedBookingVersion !== actualBookingVersion) {
    return {
      ok: false,
      error: 'version_conflict',
      statusCode: 409,
      expectedBookingVersion: Number.isFinite(expectedBookingVersion) ? expectedBookingVersion : null,
      actualBookingVersion,
    };
  }
  return { ok: true, expectedBookingVersion, actualBookingVersion };
}

/**
 * Which outcome an adjustment of this type would produce against the current
 * ledger. Computed up front so Admin sees the consequence before confirming and
 * the customer is never surprised by a charge.
 */
function projectedOutcome(projection, type, amountCents) {
  const settled = Math.max(0, Math.round(Number(projection.settledCents) || 0));
  const remaining = Math.max(0, Math.round(Number(projection.remainingCents) || 0));
  const fullySettled = settled > 0 && remaining === 0;
  if (!fullySettled) return 'total_revised';
  return type === 'increase' ? 'supplemental_balance_due' : 'refund_or_credit_review';
}

/**
 * Create the adjustment record. Creation alone never moves money — the record
 * has to reach `approved` and then be applied.
 */
function createAdjustment(booking, body = {}, opts = {}) {
  const projection = opts.authoritativeProjection || financialProjection(booking);
  const type = String(body.type || '').trim().toLowerCase();
  const reason = String(body.reason || '').trim();
  const createdBy = String(body.actorId || opts.actorId || 'admin').trim() || 'admin';

  if (!ADJUSTMENT_TYPES.includes(type)) {
    return { ok: false, error: 'invalid_adjustment_type', statusCode: 400, types: ADJUSTMENT_TYPES };
  }
  if (!reason) return { ok: false, error: 'reason_required', statusCode: 400 };

  const parsed = parseAmountCents(body.amountCents);
  if (!parsed.ok) return { ok: false, error: parsed.error, statusCode: 400 };

  const expected = body.expectedBookingVersion;
  if (expected == null || expected === '') {
    return { ok: false, error: 'expected_version_required', statusCode: 400 };
  }
  const expectedVersion = Math.round(Number(expected));
  const actualVersion = Math.round(Number(booking && booking.bookingVersion) || 0);
  if (!Number.isFinite(expectedVersion) || expectedVersion !== actualVersion) {
    return {
      ok: false,
      error: 'version_conflict',
      statusCode: 409,
      expectedBookingVersion: expectedVersion,
      actualBookingVersion: actualVersion,
    };
  }

  const approvedCents = Math.max(0, Math.round(Number(projection.approvedCents) || 0));
  if (type === 'decrease' && parsed.amountCents > approvedCents) {
    return {
      ok: false,
      error: 'decrease_exceeds_approved',
      statusCode: 400,
      approvedCents,
      amountCents: parsed.amountCents,
    };
  }

  const now = new Date().toISOString();
  // An increase that a customer has to fund is theirs to accept. Admin may still
  // require approval explicitly for anything else.
  const outcome = projectedOutcome(projection, type, parsed.amountCents);
  const customerApprovalRequired = body.customerApprovalRequired != null
    ? body.customerApprovalRequired === true
    : (type === 'increase');

  const record = {
    adjustmentId: adjustmentId(),
    bookingId: String((booking && (booking.id || booking.bookingId)) || ''),
    expectedBookingVersion: expectedVersion,
    quoteVersion: Math.round(Number(booking && (booking.quoteVersion || booking.quote?.quoteVersion)) || 0),
    type,
    amountCents: parsed.amountCents,
    reason: reason.slice(0, 500),
    customerApprovalRequired,
    createdBy,
    createdAt: now,
    status: customerApprovalRequired ? 'pending_customer' : 'approved',
    projectedOutcome: outcome,
    originalApprovedCents: approvedCents,
    revisedApprovedCents: type === 'increase'
      ? approvedCents + parsed.amountCents
      : Math.max(0, approvedCents - parsed.amountCents),
    settledCentsAtCreate: Math.max(0, Math.round(Number(projection.settledCents) || 0)),
    remainingCentsAtCreate: Math.max(0, Math.round(Number(projection.remainingCents) || 0)),
  };

  return {
    ok: true,
    adjustment: record,
    patch: { priceAdjustments: [...listAdjustments(booking), record].slice(-100) },
  };
}

/** Customer or Admin decision on a pending adjustment. */
function decideAdjustment(booking, body = {}, opts = {}) {
  const version = validateExpectedBookingVersion(booking, body);
  if (!version.ok) return version;
  const record = findAdjustment(booking, body.adjustmentId);
  if (!record) return { ok: false, error: 'adjustment_not_found', statusCode: 404 };
  if (record.status !== 'pending_customer' && record.status !== 'draft') {
    return { ok: false, error: 'adjustment_not_pending', statusCode: 409, status: record.status };
  }
  const decision = String(body.decision || '').trim().toLowerCase();
  if (decision !== 'approve' && decision !== 'decline') {
    return { ok: false, error: 'invalid_decision', statusCode: 400 };
  }
  const actor = String(body.actorId || opts.actorId || 'customer').trim() || 'customer';
  const now = new Date().toISOString();
  const next = {
    ...record,
    status: decision === 'approve' ? 'approved' : 'declined',
    decidedBy: actor,
    decidedAt: now,
    decisionReason: String(body.reason || '').trim().slice(0, 500),
  };
  return {
    ok: true,
    adjustment: next,
    patch: {
      priceAdjustments: listAdjustments(booking).map((a) => (
        String(a.adjustmentId) === String(record.adjustmentId) ? next : a
      )),
    },
  };
}

/**
 * Apply an approved adjustment. Returns the new approved total and the outcome,
 * plus whatever review record the outcome demands. It never writes the ledger's
 * settled/credited figures — those belong to real settlements and refunds.
 */
function applyAdjustment(booking, body = {}, opts = {}) {
  const version = validateExpectedBookingVersion(booking, body);
  if (!version.ok) return version;
  const projection = opts.authoritativeProjection || financialProjection(booking);
  const record = findAdjustment(booking, body.adjustmentId);
  if (!record) return { ok: false, error: 'adjustment_not_found', statusCode: 404 };
  if (record.status === 'applied') {
    // Replaying an apply is a no-op, not a second price change.
    return { ok: true, alreadyApplied: true, adjustment: record, patch: {} };
  }
  if (record.status !== 'approved') {
    return {
      ok: false,
      error: record.status === 'pending_customer' ? 'customer_approval_required' : 'adjustment_not_approved',
      statusCode: 409,
      status: record.status,
    };
  }

  const approvedCents = Math.max(0, Math.round(Number(projection.approvedCents) || 0));
  const settledCents = Math.max(0, Math.round(Number(projection.settledCents) || 0));
  const remainingBefore = Math.max(0, Math.round(Number(projection.remainingCents) || 0));
  const outcome = projectedOutcome(projection, record.type, record.amountCents);

  const revisedApprovedCents = record.type === 'increase'
    ? approvedCents + record.amountCents
    : Math.max(0, approvedCents - record.amountCents);

  // Remaining is always derived from the ledger identity, never carried over.
  const creditedCents = Math.max(0, Math.round(Number(booking?.ledger?.creditedCents) || 0));
  const remainingAfter = Math.max(0, revisedApprovedCents - settledCents - creditedCents);

  const now = new Date().toISOString();
  const applied = {
    ...record,
    status: 'applied',
    appliedAt: now,
    appliedBy: String(body.actorId || opts.actorId || 'admin').trim() || 'admin',
    appliedOutcome: outcome,
    approvedCentsBefore: approvedCents,
    approvedCentsAfter: revisedApprovedCents,
    remainingCentsBefore: remainingBefore,
    remainingCentsAfter: remainingAfter,
  };

  const patch = {
    priceAdjustments: listAdjustments(booking).map((a) => (
      String(a.adjustmentId) === String(record.adjustmentId) ? applied : a
    )),
    // Compatibility total for legacy readers; persistMutation re-derives the
    // ledger and quote version from this on the money-mutation path.
    approvedFinalAmount: revisedApprovedCents / 100,
    finalAmount: revisedApprovedCents / 100,
    totalPrice: revisedApprovedCents / 100,
  };

  if (outcome === 'refund_or_credit_review') {
    // A decrease against fully settled money owes the customer something. That
    // is a decision for whoever authorises refunds, so it is queued, not paid.
    patch.refundReview = {
      reviewId: `rfr_${crypto.randomBytes(5).toString('hex')}`,
      adjustmentId: record.adjustmentId,
      amountCents: Math.min(record.amountCents, settledCents),
      reason: record.reason,
      status: 'pending_review',
      openedAt: now,
      openedBy: applied.appliedBy,
    };
    patch.refundReviewRequired = true;
  }

  return {
    ok: true,
    adjustment: applied,
    outcome,
    approvedCents: revisedApprovedCents,
    remainingCents: remainingAfter,
    supplementalDueCents: outcome === 'supplemental_balance_due' ? remainingAfter : 0,
    patch,
  };
}

/**
 * Gate for the legacy direct-total write. Once money has settled, a bare number
 * is not enough — an approved adjustment has to justify it.
 */
function guardDirectTotalMutation(booking, body = {}, opts = {}) {
  const projection = opts.authoritativeProjection || financialProjection(booking);
  const settledCents = Math.max(0, Math.round(Number(projection.settledCents) || 0));
  if (settledCents <= 0) return { ok: true, requiresAdjustment: false };

  const record = findAdjustment(booking, body.adjustmentId);
  if (!record) {
    return {
      ok: false,
      error: 'adjustment_required',
      statusCode: 409,
      message: 'A payment has already been recorded. Change the price through a price adjustment so the reason and approval are recorded.',
      settledCents,
    };
  }
  if (record.status !== 'approved' && record.status !== 'applied') {
    return {
      ok: false,
      error: 'adjustment_not_approved',
      statusCode: 409,
      status: record.status,
    };
  }
  return { ok: true, requiresAdjustment: true, adjustment: record };
}

/**
 * Customer-facing statement: original, adjustment, reason, revised, paid,
 * remaining. Same numbers Admin sees for the same booking version.
 */
function adjustmentStatement(booking, opts = {}) {
  const projection = opts.authoritativeProjection || financialProjection(booking);
  const all = listAdjustments(booking);
  const appliedRows = all.filter((a) => a && a.status === 'applied');
  const latest = appliedRows[appliedRows.length - 1] || null;
  const pending = all.filter((a) => a && (a.status === 'pending_customer' || a.status === 'approved'));

  const approvedCents = Math.max(0, Math.round(Number(projection.approvedCents) || 0));
  const settledCents = Math.max(0, Math.round(Number(projection.settledCents) || 0));
  const remainingCents = Math.max(0, Math.round(Number(projection.remainingCents) || 0));
  const originalCents = latest ? Math.max(0, Math.round(Number(latest.approvedCentsBefore) || 0)) : approvedCents;

  return {
    originalTotalCents: originalCents,
    adjustmentCents: approvedCents - originalCents,
    adjustmentReason: latest ? String(latest.reason || '') : '',
    revisedTotalCents: approvedCents,
    paidCents: settledCents,
    remainingCents,
    lastAdjustment: latest
      ? {
        adjustmentId: latest.adjustmentId,
        type: latest.type,
        amountCents: latest.amountCents,
        reason: latest.reason,
        outcome: latest.appliedOutcome,
        appliedAt: latest.appliedAt,
      }
      : null,
    pendingAdjustments: pending.map((a) => ({
      adjustmentId: a.adjustmentId,
      type: a.type,
      amountCents: a.amountCents,
      reason: a.reason,
      status: a.status,
      customerApprovalRequired: !!a.customerApprovalRequired,
      projectedOutcome: a.projectedOutcome,
    })),
    refundReview: booking && booking.refundReview
      ? {
        reviewId: booking.refundReview.reviewId,
        amountCents: booking.refundReview.amountCents,
        status: booking.refundReview.status,
        openedAt: booking.refundReview.openedAt,
      }
      : null,
  };
}

module.exports = {
  ADJUSTMENT_TYPES,
  ADJUSTMENT_STATUSES,
  ADJUSTMENT_OUTCOMES,
  listAdjustments,
  findAdjustment,
  parseAmountCents,
  validateExpectedBookingVersion,
  projectedOutcome,
  createAdjustment,
  decideAdjustment,
  applyAdjustment,
  guardDirectTotalMutation,
  adjustmentStatement,
};
