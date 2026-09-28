'use strict';

const { commitBooking } = require('./booking-repository');
const { buildNextAggregate } = require('./booking-aggregate');
const { appendEventLog } = require('./ops-workflow');
const { financialProjection, supersedeOpenAttempts } = require('./payment-service');
const {
  createAdjustment,
  applyAdjustment,
  listAdjustments,
  findAdjustment,
  decideAdjustment,
} = require('./price-adjustments');
const { bookingStatus, dollarsFromCents } = require('./admin-quick-ops-view');

const MIN_NOTE = 8;
const MAX_INCREASE_CENTS = 500000;

function parseAdjustmentAmount(body = {}) {
  if (body.amountCents != null && body.amountCents !== '' && body.amountDollars == null) {
    const cents = Math.round(Number(body.amountCents));
    if (!Number.isFinite(cents) || cents <= 0 || Math.abs(Number(body.amountCents) - cents) > 1e-8) {
      return { ok: false, error: 'invalid_amount' };
    }
    return { ok: true, amountCents: cents };
  }
  const raw = String(body.amountDollars != null ? body.amountDollars : body.amount || '')
    .trim()
    .replace(/[$,\s]/g, '');
  if (!raw) return { ok: false, error: 'amount_required' };
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return { ok: false, error: 'invalid_amount' };
  const cents = Math.round(Number(raw) * 100);
  if (!Number.isFinite(cents) || cents <= 0) return { ok: false, error: 'invalid_amount' };
  return { ok: true, amountCents: cents };
}

/**
 * Scale an existing technician payout by the same ratio as the approved total.
 * A decrease in the job price lowers the payout. An increase raises it.
 * Jobs with no payout on file are left unset.
 */
function scaleTechPayout(booking, previousApprovedCents, nextApprovedCents) {
  const prev = Math.max(0, Math.round(Number(previousApprovedCents) || 0));
  const next = Math.max(0, Math.round(Number(nextApprovedCents) || 0));
  const current = booking && booking.techPayoutAmount;
  if (current == null || current === '' || !Number.isFinite(Number(current))) {
    return {
      techPayoutAmount: current == null ? null : current,
      platformFeeAmount: booking && booking.platformFeeAmount != null ? booking.platformFeeAmount : null,
      scaled: false,
      beforeCents: null,
      afterCents: null,
    };
  }
  const beforeCents = Math.max(0, Math.round(Number(current) * 100));
  if (prev <= 0) {
    return {
      techPayoutAmount: beforeCents / 100,
      platformFeeAmount: booking.platformFeeAmount != null ? booking.platformFeeAmount : null,
      scaled: false,
      beforeCents,
      afterCents: beforeCents,
    };
  }
  const afterCents = Math.max(0, Math.min(next, Math.round(beforeCents * next / prev)));
  const payout = afterCents / 100;
  const fee = Math.round((next - afterCents)) / 100;
  return {
    techPayoutAmount: payout,
    platformFeeAmount: fee,
    scaled: afterCents !== beforeCents,
    beforeCents,
    afterCents,
  };
}

/**
 * Add a typed extra onto the technician pay the admin already set.
 * Leaves pay unset when the office has not entered one, so the customer
 * total is never copied onto the technician screen.
 */
function addTechPayout(booking, nextApprovedCents, deltaCents) {
  const nextApproved = Math.max(0, Math.round(Number(nextApprovedCents) || 0));
  const current = booking && booking.techPayoutAmount;
  if (current == null || current === '' || !Number.isFinite(Number(current))) {
    return {
      techPayoutAmount: null,
      platformFeeAmount: booking && booking.platformFeeAmount != null ? booking.platformFeeAmount : null,
      scaled: false,
      beforeCents: null,
      afterCents: null,
    };
  }
  const beforeCents = Math.max(0, Math.round(Number(current) * 100));
  const afterCents = Math.max(0, Math.min(nextApproved, beforeCents + Math.round(Number(deltaCents) || 0)));
  return {
    techPayoutAmount: afterCents / 100,
    platformFeeAmount: (nextApproved - afterCents) / 100,
    scaled: afterCents !== beforeCents,
    beforeCents,
    afterCents,
  };
}

/**
 * Office-set pay for this job. Does not change what the customer owes.
 * This is the only amount the technician page is allowed to show.
 */
async function setTechnicianPay(booking, opts = {}) {
  if (!booking) return { ok: false, error: 'not_found', statusCode: 404 };
  if (bookingStatus(booking) === 'cancelled') {
    return { ok: false, error: 'cancelled', statusCode: 409, message: 'Canceled jobs cannot be updated' };
  }
  const parsed = parseAdjustmentAmount(opts);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, statusCode: 400, message: 'Enter the technician pay' };
  }
  const projection = opts.projection || financialProjection(booking);
  const approvedCents = Math.max(0, Math.round(Number(projection.approvedCents) || 0));
  if (parsed.amountCents > approvedCents) {
    return {
      ok: false,
      error: 'payout_exceeds_job',
      statusCode: 400,
      message: 'Technician pay cannot be higher than the job total',
    };
  }
  const bookingId = booking.id || booking.bookingId;
  const now = new Date().toISOString();
  const next = buildNextAggregate(booking, {
    techPayoutAmount: parsed.amountCents / 100,
    platformFeeAmount: (approvedCents - parsed.amountCents) / 100,
    updatedAt: now,
    eventLog: appendEventLog(booking, {
      action: 'quick_ops_tech_pay_set',
      by: 'quick_ops',
      amountCents: parsed.amountCents,
    }),
  });
  const committed = await commitBooking({
    bookingId,
    expectedBookingVersion: booking.bookingVersion,
    nextAggregate: next,
  });
  if (!committed.ok) return committed;
  const label = dollarsFromCents(parsed.amountCents);
  return {
    ok: true,
    booking: committed.booking,
    bookingVersion: committed.bookingVersion,
    payoutCents: parsed.amountCents,
    message: `Technician pay set to ${label}. That is the only amount the technician sees.`,
  };
}

function payoutMessage(type, payout, approvedCents) {
  const total = dollarsFromCents(approvedCents);
  if (!payout || payout.beforeCents == null) {
    return type === 'decrease'
      ? `Price is now ${total}. No technician payout was on file, so only the job total changed. A later payout based on this total will be lower.`
      : `Price is now ${total}.`;
  }
  const before = dollarsFromCents(payout.beforeCents);
  const after = dollarsFromCents(payout.afterCents);
  if (type === 'decrease') {
    return `Price is now ${total}. Technician payout dropped from ${before} to ${after}.`;
  }
  return `Price is now ${total}. Technician payout moved from ${before} to ${after}.`;
}

function samePendingExtra(record, amountCents, reason) {
  return record
    && record.type === 'increase'
    && record.status === 'pending_customer'
    && Math.round(Number(record.amountCents) || 0) === amountCents
    && String(record.reason || '') === reason;
}

/**
 * Technician extra. Stored in cents with the note and author, and left
 * pending until the customer approves it. It does not change the approved
 * total, the technician pay, or any open payment.
 */
async function recordTechExtra(booking, opts = {}) {
  if (!booking) return { ok: false, error: 'not_found', statusCode: 404 };
  if (bookingStatus(booking) === 'cancelled') {
    return { ok: false, error: 'cancelled', statusCode: 409, message: 'Canceled jobs cannot be updated' };
  }
  const reason = String(opts.reason || opts.note || '').replace(/\s+/g, ' ').trim();
  if (reason.length < MIN_NOTE) {
    return {
      ok: false,
      error: 'reason_required',
      statusCode: 400,
      message: 'A note of at least 8 characters is required',
    };
  }
  const parsed = parseAdjustmentAmount(opts);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, statusCode: 400, message: 'Enter a valid amount' };
  }
  if (parsed.amountCents > MAX_INCREASE_CENTS) {
    return { ok: false, error: 'increase_too_large', statusCode: 400, message: 'Increase is limited to $5,000 at a time' };
  }
  const existing = listAdjustments(booking).find((row) => samePendingExtra(row, parsed.amountCents, reason));
  if (existing) {
    return {
      ok: true,
      idempotent: true,
      pending: true,
      booking,
      bookingVersion: booking.bookingVersion,
      adjustment: existing,
      addedCents: parsed.amountCents,
      message: `Extra of ${dollarsFromCents(parsed.amountCents)} is already waiting for customer approval. It is not charged yet, and your pay is unchanged.`,
    };
  }
  const projection = opts.projection || financialProjection(booking);
  const actorId = String(opts.actorId || 'tech_quick_ops').slice(0, 80);
  const created = createAdjustment(booking, {
    type: 'increase',
    amountCents: parsed.amountCents,
    reason,
    actorId,
    expectedBookingVersion: booking.bookingVersion,
  }, { authoritativeProjection: projection });
  if (!created.ok) return created;
  const now = new Date().toISOString();
  const next = buildNextAggregate(booking, {
    ...created.patch,
    updatedAt: now,
    eventLog: appendEventLog(booking, {
      action: 'quick_ops_extra_pending',
      by: actorId,
      amountCents: parsed.amountCents,
      reason: reason.slice(0, 180),
    }),
  });
  const committed = await commitBooking({
    bookingId: booking.id || booking.bookingId,
    expectedBookingVersion: booking.bookingVersion,
    nextAggregate: next,
  });
  if (!committed.ok) return committed;
  return {
    ok: true,
    pending: true,
    booking: committed.booking,
    bookingVersion: committed.bookingVersion,
    adjustment: created.adjustment,
    addedCents: parsed.amountCents,
    approvedCents: Math.max(0, Math.round(Number(projection.approvedCents) || 0)),
    remainingCents: Math.max(0, Math.round(Number(projection.remainingCents) || 0)),
    message: `Extra of ${dollarsFromCents(parsed.amountCents)} recorded. It is waiting for customer approval and is not charged yet. Your pay is unchanged.`,
  };
}

/**
 * Apply one customer-approved extra onto the approved total.
 * Technician pay is left as the office set it. Open payment links and
 * attempts for the previous total are superseded. A second apply is a no-op.
 */
async function applyCustomerApprovedExtra(booking, opts = {}) {
  if (!booking) return { ok: false, error: 'not_found', statusCode: 404 };
  if (bookingStatus(booking) === 'cancelled') {
    return { ok: false, error: 'cancelled', statusCode: 409, message: 'Canceled jobs cannot be updated' };
  }
  const projection = opts.projection || financialProjection(booking);
  const actorId = String(opts.actorId || 'customer').slice(0, 80);
  const applied = applyAdjustment(booking, {
    adjustmentId: opts.adjustmentId,
    expectedBookingVersion: booking.bookingVersion,
    actorId,
  }, { authoritativeProjection: projection });
  if (!applied.ok) return applied;
  if (applied.alreadyApplied) {
    return {
      ok: true,
      idempotent: true,
      booking,
      bookingVersion: booking.bookingVersion,
      approvedCents: Math.max(0, Math.round(Number(projection.approvedCents) || 0)),
      remainingCents: Math.max(0, Math.round(Number(projection.remainingCents) || 0)),
      payoutUnchanged: true,
    };
  }

  let nextApproved = applied.approvedCents;
  let nextSettled = Math.max(0, Math.round(Number(projection.settledCents) || 0));
  let quoteVersion = Math.round(Number(booking.quoteVersion) || 0) + 1;
  const env = opts.env || process.env;
  const { postgresPaymentEnabled } = require('./db/operational-payment');
  if (postgresPaymentEnabled(env)) {
    const { ensureBookingFinancial } = require('./db/ensure-booking-financial');
    const authority = require('./db/payment-authority-service');
    const bookingId = booking.id || booking.bookingId;
    const ensured = await ensureBookingFinancial(booking);
    if (!ensured.ok) {
      return { ok: false, error: ensured.error || 'ensure_failed', statusCode: 503, message: 'Price change is unavailable' };
    }
    const authoritative = await authority.createAdjustment({
      bookingId,
      newApprovedCents: nextApproved,
      reason: applied.adjustment.reason,
      adjustmentId: applied.adjustment.adjustmentId,
      expectedQuoteVersion: Math.round(Number(booking.quoteVersion) || 0),
      approvedBy: actorId,
    });
    if (!authoritative.ok) {
      return {
        ok: false,
        error: authoritative.error || 'adjustment_failed',
        statusCode: authoritative.statusCode || 409,
        message: 'Price change was not saved',
      };
    }
    const pg = authoritative.after || {};
    nextApproved = Math.max(0, Math.round(Number(pg.approvedCents) || nextApproved));
    nextSettled = Math.max(0, Math.round(Number(pg.settledCents) || nextSettled));
    quoteVersion = Math.round(Number(pg.quoteVersion) || quoteVersion);
  }

  const creditedCents = Math.max(0, Math.round(Number(booking.ledger && booking.ledger.creditedCents) || 0));
  const remainingCents = Math.max(0, nextApproved - nextSettled - creditedCents);
  const now = new Date().toISOString();
  const next = buildNextAggregate(booking, {
    ...applied.patch,
    quoteVersion,
    quote: {
      ...(booking.quote || {}),
      quoteVersion,
      approvedCents: nextApproved,
      currency: 'usd',
      adjustmentId: applied.adjustment.adjustmentId,
      adjustmentReason: applied.adjustment.reason,
    },
    ledger: {
      ...(booking.ledger || {}),
      currency: 'usd',
      approvedCents: nextApproved,
      settledCents: nextSettled,
      creditedCents,
      pendingCents: 0,
      entries: Array.isArray(booking.ledger && booking.ledger.entries) ? booking.ledger.entries : [],
    },
    approvedFinalAmount: nextApproved / 100,
    finalAmount: nextApproved / 100,
    totalPrice: nextApproved / 100,
    payLink: '',
    stripeCheckoutSessionId: '',
    payLinkAmount: null,
    payLinkInvalidatedAt: now,
    paymentAttempts: supersedeOpenAttempts(booking.paymentAttempts, { quoteVersion }),
    updatedAt: now,
    eventLog: appendEventLog(booking, {
      action: 'quick_ops_extra_applied',
      by: actorId,
      amountCents: applied.adjustment.amountCents,
      payoutUnchanged: true,
    }),
  });
  const committed = await commitBooking({
    bookingId: booking.id || booking.bookingId,
    expectedBookingVersion: booking.bookingVersion,
    nextAggregate: next,
  });
  if (!committed.ok) return committed;
  return {
    ok: true,
    booking: committed.booking,
    bookingVersion: committed.bookingVersion,
    quoteVersion,
    approvedCents: nextApproved,
    settledCents: nextSettled,
    remainingCents,
    payoutUnchanged: true,
  };
}

/**
 * Customer decision on one pending extra.
 * Approve applies the amount onto the approved total once and leaves the
 * technician pay the office entered. Decline does not change the total.
 * A repeated approve is a no-op.
 */
async function respondToCustomerExtra(booking, opts = {}) {
  if (!booking) return { ok: false, error: 'not_found', statusCode: 404 };
  const decision = String(opts.decision || '').trim().toLowerCase();
  if (decision !== 'approve' && decision !== 'decline') {
    return { ok: false, error: 'invalid_decision', statusCode: 400 };
  }
  const adjustmentId = opts.adjustmentId;
  const actorId = String(opts.actorId || 'customer').slice(0, 80);
  const decided = decideAdjustment(booking, {
    adjustmentId,
    decision,
    actorId,
    reason: opts.reason || '',
    expectedBookingVersion: booking.bookingVersion,
  });
  if (!decided.ok) {
    const existing = findAdjustment(booking, adjustmentId);
    if (decision === 'decline' && existing && existing.status === 'declined') {
      const projection = financialProjection(booking);
      return {
        ok: true,
        idempotent: true,
        declined: true,
        booking,
        bookingVersion: booking.bookingVersion,
        approvedCents: Math.max(0, Math.round(Number(projection.approvedCents) || 0)),
        remainingCents: Math.max(0, Math.round(Number(projection.remainingCents) || 0)),
      };
    }
    if (decision === 'approve') {
      return applyCustomerApprovedExtra(booking, { adjustmentId, actorId });
    }
    return decided;
  }
  const staged = {
    ...booking,
    priceAdjustments: decided.patch.priceAdjustments,
  };
  if (decision === 'decline') {
    const next = buildNextAggregate(booking, {
      priceAdjustments: decided.patch.priceAdjustments,
      updatedAt: new Date().toISOString(),
      eventLog: appendEventLog(booking, {
        action: 'quick_ops_extra_declined',
        by: actorId,
        adjustmentId: String(adjustmentId || ''),
      }),
    });
    const committed = await commitBooking({
      bookingId: booking.id || booking.bookingId,
      expectedBookingVersion: booking.bookingVersion,
      nextAggregate: next,
    });
    if (!committed.ok) return committed;
    const projection = financialProjection(committed.booking);
    return {
      ok: true,
      declined: true,
      booking: committed.booking,
      bookingVersion: committed.bookingVersion,
      approvedCents: Math.max(0, Math.round(Number(projection.approvedCents) || 0)),
      remainingCents: Math.max(0, Math.round(Number(projection.remainingCents) || 0)),
      payoutUnchanged: true,
    };
  }
  return applyCustomerApprovedExtra(staged, { adjustmentId, actorId });
}

/**
 * Apply an immediate price increase or decrease with a required note.
 * Decreases cannot go below money already collected. The technician payout
 * moves by the same share as the approved total.
 */
async function adjustQuickOpsPrice(booking, opts = {}) {
  if (!booking) return { ok: false, error: 'not_found', statusCode: 404 };
  if (bookingStatus(booking) === 'cancelled') {
    return { ok: false, error: 'cancelled', statusCode: 409, message: 'Canceled jobs cannot be repriced' };
  }
  const type = String(opts.type || '').trim().toLowerCase();
  if (type !== 'increase' && type !== 'decrease') {
    return { ok: false, error: 'invalid_adjustment_type', statusCode: 400, message: 'Choose increase or decrease' };
  }
  const reason = String(opts.reason || opts.note || '').replace(/\s+/g, ' ').trim();
  if (reason.length < MIN_NOTE) {
    return {
      ok: false,
      error: 'reason_required',
      statusCode: 400,
      message: 'A note of at least 8 characters is required',
    };
  }
  const parsed = parseAdjustmentAmount(opts);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, statusCode: 400, message: 'Enter a valid amount' };
  }
  if (type === 'increase' && parsed.amountCents > MAX_INCREASE_CENTS) {
    return { ok: false, error: 'increase_too_large', statusCode: 400, message: 'Increase is limited to $5,000 at a time' };
  }

  const projection = opts.projection || financialProjection(booking);
  const approvedCents = Math.max(0, Math.round(Number(projection.approvedCents) || 0));
  const settledCents = Math.max(0, Math.round(Number(projection.settledCents) || 0));
  if (type === 'decrease' && parsed.amountCents > Math.max(0, approvedCents - settledCents)) {
    return {
      ok: false,
      error: 'decrease_below_paid',
      statusCode: 400,
      message: 'That decrease goes below what is already paid. Use Admin refund review for money already collected.',
    };
  }

  const actorId = String(opts.actorId || 'quick_ops').slice(0, 80);
  const bookingId = booking.id || booking.bookingId;
  const created = createAdjustment(booking, {
    type,
    amountCents: parsed.amountCents,
    reason,
    actorId,
    expectedBookingVersion: booking.bookingVersion,
    customerApprovalRequired: false,
  }, { authoritativeProjection: projection });
  if (!created.ok) {
    return { ...created, message: created.error === 'reason_required' ? 'A note is required' : 'Could not change the price' };
  }
  const withRecord = { ...booking, ...created.patch };
  const applied = applyAdjustment(withRecord, {
    adjustmentId: created.adjustment.adjustmentId,
    expectedBookingVersion: booking.bookingVersion,
    actorId,
  }, { authoritativeProjection: projection });
  if (!applied.ok) return applied;

  let nextApproved = applied.approvedCents;
  let nextSettled = settledCents;
  let quoteVersion = Math.round(Number(booking.quoteVersion) || 0) + 1;
  const env = opts.env || process.env;
  const { postgresPaymentEnabled } = require('./db/operational-payment');
  if (postgresPaymentEnabled(env)) {
    const { ensureBookingFinancial } = require('./db/ensure-booking-financial');
    const authority = require('./db/payment-authority-service');
    const ensured = await ensureBookingFinancial(booking);
    if (!ensured.ok) {
      return { ok: false, error: ensured.error || 'ensure_failed', statusCode: 503, message: 'Price change is unavailable' };
    }
    const authoritative = await authority.createAdjustment({
      bookingId,
      newApprovedCents: nextApproved,
      reason,
      adjustmentId: created.adjustment.adjustmentId,
      expectedQuoteVersion: Math.round(Number(booking.quoteVersion) || 0),
      approvedBy: actorId,
    });
    if (!authoritative.ok) {
      return {
        ok: false,
        error: authoritative.error || 'adjustment_failed',
        statusCode: authoritative.statusCode || 409,
        message: 'Price change was not saved',
      };
    }
    const pg = authoritative.after || {};
    nextApproved = Math.max(0, Math.round(Number(pg.approvedCents) || nextApproved));
    nextSettled = Math.max(0, Math.round(Number(pg.settledCents) || nextSettled));
    quoteVersion = Math.round(Number(pg.quoteVersion) || quoteVersion);
  }

  const payout = opts.payoutMode === 'add'
    ? addTechPayout(booking, nextApproved, type === 'increase' ? parsed.amountCents : -parsed.amountCents)
    : scaleTechPayout(booking, approvedCents, nextApproved);
  const creditedCents = Math.max(0, Math.round(Number(booking.ledger && booking.ledger.creditedCents) || 0));
  const remainingCents = Math.max(0, nextApproved - nextSettled - creditedCents);
  const now = new Date().toISOString();
  const patch = {
    ...applied.patch,
    quoteVersion,
    quote: {
      ...(booking.quote || {}),
      quoteVersion,
      approvedCents: nextApproved,
      currency: 'usd',
      adjustmentId: created.adjustment.adjustmentId,
      adjustmentReason: reason,
    },
    ledger: {
      ...(booking.ledger || {}),
      currency: 'usd',
      approvedCents: nextApproved,
      settledCents: nextSettled,
      creditedCents,
      pendingCents: 0,
      entries: Array.isArray(booking.ledger && booking.ledger.entries) ? booking.ledger.entries : [],
    },
    payLink: '',
    stripeCheckoutSessionId: '',
    payLinkAmount: null,
    payLinkInvalidatedAt: now,
    paymentAttempts: supersedeOpenAttempts(booking.paymentAttempts, { quoteVersion }),
    techPayoutAmount: payout.techPayoutAmount,
    platformFeeAmount: payout.platformFeeAmount,
    updatedAt: now,
    eventLog: appendEventLog(booking, {
      action: 'quick_ops_price_adjusted',
      by: actorId,
      type,
      amountCents: parsed.amountCents,
      reason: reason.slice(0, 180),
      payoutBeforeCents: payout.beforeCents,
      payoutAfterCents: payout.afterCents,
    }),
  };
  const next = buildNextAggregate(booking, patch);
  const committed = await commitBooking({
    bookingId,
    expectedBookingVersion: booking.bookingVersion,
    nextAggregate: next,
  });
  if (!committed.ok) return committed;
  return {
    ok: true,
    booking: committed.booking,
    bookingVersion: committed.bookingVersion,
    quoteVersion,
    type,
    addedCents: parsed.amountCents,
    approvedCents: nextApproved,
    remainingCents,
    payout,
    message: payoutMessage(type, payout, nextApproved),
  };
}

module.exports = {
  MIN_NOTE,
  parseAdjustmentAmount,
  scaleTechPayout,
  addTechPayout,
  setTechnicianPay,
  recordTechExtra,
  applyCustomerApprovedExtra,
  respondToCustomerExtra,
  adjustQuickOpsPrice,
};
