'use strict';

const { commitBooking } = require('./booking-repository');
const { buildNextAggregate } = require('./booking-aggregate');
const { appendEventLog } = require('./ops-workflow');
const { financialProjection, supersedeOpenAttempts } = require('./payment-service');
const { createAdjustment, applyAdjustment } = require('./price-adjustments');
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

  const payout = scaleTechPayout(booking, approvedCents, nextApproved);
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
  adjustQuickOpsPrice,
};
