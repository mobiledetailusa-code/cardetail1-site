'use strict';

/**
 * Quick Ops amount change — same Admin price-adjustment + quote authority.
 * plus/minus require notes. original is a no-op write.
 * GET must never call this.
 */

const { getBookingRecord, commitBooking } = require('./booking-repository');
const { buildNextAggregate, normalizeAggregate } = require('./booking-aggregate');
const { appendEventLog } = require('./ops-workflow');
const {
  createAdjustment,
  applyAdjustment,
} = require('./price-adjustments');
const { moneyFromBooking } = require('./admin-quick-ops-view');

function normalizeAmountMode(raw) {
  const mode = String(raw || 'original').trim().toLowerCase();
  if (mode === 'plus' || mode === 'increase' || mode === 'add') return 'plus';
  if (mode === 'minus' || mode === 'decrease' || mode === 'reduce') return 'minus';
  return 'original';
}

function dollarsToAmountCents(value) {
  if (value === undefined || value === null || value === '') {
    return { ok: false, error: 'amount_required' };
  }
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return { ok: false, error: 'invalid_amount' };
  return { ok: true, amountCents: Math.round(num * 100) };
}

async function sharedProjection(booking, env) {
  try {
    const { getSharedFinancialProjection } = require('./db/operational-payment');
    const shared = await getSharedFinancialProjection(booking, { env });
    if (shared && shared.ok) return shared;
  } catch {
    /* blob fallback */
  }
  return null;
}

function expectedVersionFrom(booking, opts) {
  const raw = opts.expectedBookingVersion != null
    ? opts.expectedBookingVersion
    : booking.bookingVersion;
  const expected = Math.round(Number(raw));
  const actual = Math.round(Number(booking.bookingVersion) || 0);
  if (raw == null || raw === '' || !Number.isFinite(expected) || expected !== actual) {
    return {
      ok: false,
      error: 'version_conflict',
      statusCode: 409,
      expectedBookingVersion: Number.isFinite(expected) ? expected : null,
      actualBookingVersion: actual,
    };
  }
  return { ok: true, expected };
}

async function persistAmountPatch(booking, updates, opts = {}) {
  const bookingId = String(booking.id || booking.bookingId || '').trim();
  const version = expectedVersionFrom(booking, opts);
  if (!version.ok) return version;
  const { ok: normOk, aggregate: base } = normalizeAggregate(booking, { allowDraft: false });
  const next = buildNextAggregate(normOk ? base : booking, updates);
  const committed = await commitBooking({
    bookingId,
    expectedBookingVersion: version.expected,
    nextAggregate: next,
  });
  if (!committed.ok) {
    return {
      ok: false,
      error: committed.error || 'version_conflict',
      statusCode: committed.statusCode || 409,
      actualBookingVersion: committed.actualBookingVersion,
    };
  }
  return { ok: true, booking: committed.booking, bookingVersion: committed.bookingVersion };
}

/**
 * Apply original / plus / minus against one booking.
 * plus and minus require notes. Uses Postgres quote authority when enabled;
 * otherwise revises the blob ledger so /pay remainingCents stays in sync.
 */
async function applyQuickOpsAmountChange(booking, opts = {}) {
  const mode = normalizeAmountMode(opts.amountMode);
  const actor = String(opts.actor || 'quick_ops').trim() || 'quick_ops';
  const env = opts.env || process.env;
  if (mode === 'original') {
    return { ok: true, unchanged: true, booking, amountMode: 'original' };
  }

  const notes = String(opts.notes || opts.reason || '').trim();
  if (notes.length < 3) {
    return { ok: false, error: 'notes_required', statusCode: 400 };
  }

  const parsed = opts.amountCents != null
    ? { ok: true, amountCents: Math.round(Number(opts.amountCents)) }
    : dollarsToAmountCents(opts.amountDollars);
  if (!parsed.ok || !(parsed.amountCents > 0)) {
    return { ok: false, error: parsed.error || 'invalid_amount', statusCode: 400 };
  }

  const shared = await sharedProjection(booking, env);
  const projection = shared && shared.projection ? shared.projection : null;
  const type = mode === 'plus' ? 'increase' : 'decrease';
  const expected = opts.expectedBookingVersion != null
    ? opts.expectedBookingVersion
    : booking.bookingVersion;

  const created = createAdjustment(booking, {
    type,
    amountCents: parsed.amountCents,
    reason: notes,
    expectedBookingVersion: expected,
    actorId: actor,
    customerApprovalRequired: false,
  }, projection ? { authoritativeProjection: projection } : {});
  if (!created.ok) return created;

  const staged = { ...booking, ...created.patch };
  const applied = applyAdjustment(staged, {
    adjustmentId: created.adjustment.adjustmentId,
    expectedBookingVersion: expected,
    actorId: actor,
  }, projection ? { authoritativeProjection: projection } : {});
  if (!applied.ok) return applied;

  let patch = { ...applied.patch };
  const {
    postgresPaymentEnabled,
  } = require('./db/operational-payment');

  if (postgresPaymentEnabled(env)) {
    const { ensureBookingFinancial } = require('./db/ensure-booking-financial');
    const authority = require('./db/payment-authority-service');
    const ensured = await ensureBookingFinancial(booking);
    if (!ensured.ok) {
      return { ok: false, error: ensured.error || 'ensure_failed', statusCode: 503 };
    }
    const authoritative = await authority.createAdjustment({
      bookingId: String(booking.id || booking.bookingId || ''),
      newApprovedCents: applied.approvedCents,
      reason: notes,
      adjustmentId: applied.adjustment.adjustmentId,
      expectedQuoteVersion: created.adjustment.quoteVersion,
      approvedBy: actor,
    });
    if (!authoritative.ok) {
      return {
        ok: false,
        error: authoritative.error || 'adjustment_failed',
        statusCode: authoritative.statusCode || 409,
        expectedQuoteVersion: authoritative.expectedQuoteVersion,
        actualQuoteVersion: authoritative.actualQuoteVersion,
      };
    }
    const pg = authoritative.after;
    patch = {
      ...patch,
      quoteVersion: pg.quoteVersion,
      quote: {
        ...(booking.quote || {}),
        quoteVersion: pg.quoteVersion,
        approvedCents: pg.approvedCents,
        currency: 'usd',
        adjustmentId: applied.adjustment.adjustmentId,
        adjustmentReason: notes,
      },
      ledger: {
        ...(booking.ledger || {}),
        currency: 'usd',
        approvedCents: pg.approvedCents,
        settledCents: pg.settledCents,
        refundedCents: pg.refundedCents,
      },
      approvedFinalAmount: pg.approvedCents / 100,
      finalAmount: pg.approvedCents / 100,
      totalPrice: pg.approvedCents / 100,
      amountDueApproved: pg.remainingCents / 100,
      balanceDue: pg.remainingCents / 100,
    };
  } else {
    const nextQuoteVersion = Math.max(
      1,
      Math.round(Number(booking.quoteVersion) || 0) + 1
    );
    patch = {
      ...patch,
      quoteVersion: nextQuoteVersion,
      quote: {
        ...(booking.quote || {}),
        quoteVersion: nextQuoteVersion,
        approvedCents: applied.approvedCents,
        currency: 'usd',
        adjustmentId: applied.adjustment.adjustmentId,
        adjustmentReason: notes,
      },
      ledger: {
        ...(booking.ledger || {}),
        currency: 'usd',
        approvedCents: applied.approvedCents,
        settledCents: Math.max(0, Math.round(Number((booking.ledger || {}).settledCents) || 0)),
        creditedCents: Math.max(0, Math.round(Number((booking.ledger || {}).creditedCents) || 0)),
      },
    };
  }

  const now = new Date().toISOString();
  const updates = {
    ...patch,
    updatedAt: now,
    updatedBy: actor,
    lastAction: `quick_ops_amount_${type}`,
    eventLog: appendEventLog(booking, {
      action: `quick_ops_amount_${type}`,
      by: actor,
      amountCents: parsed.amountCents,
      reason: notes.slice(0, 180),
      adjustmentId: applied.adjustment.adjustmentId,
    }),
  };

  const persisted = await persistAmountPatch(booking, updates, {
    expectedBookingVersion: expected,
  });
  if (!persisted.ok) return persisted;
  return {
    ok: true,
    booking: persisted.booking,
    bookingVersion: persisted.bookingVersion,
    amountMode: mode,
    approvedCents: applied.approvedCents,
    remainingCents: applied.remainingCents,
    adjustment: applied.adjustment,
    outcome: applied.outcome,
  };
}

async function prepareQuickOpsMoney(booking, opts = {}) {
  const changed = await applyQuickOpsAmountChange(booking, opts);
  if (!changed.ok) return changed;
  const next = changed.booking || booking;
  const shared = await sharedProjection(next, opts.env);
  return {
    ok: true,
    booking: next,
    viewMoney: moneyFromBooking(next, shared),
    unchanged: !!changed.unchanged,
    amountMode: changed.amountMode || 'original',
    adjustment: changed.adjustment || null,
  };
}

async function reloadBooking(bookingId) {
  const rec = await getBookingRecord(bookingId);
  if (!rec.exists || !rec.booking) return { ok: false, error: 'not_found', statusCode: 404 };
  return { ok: true, booking: rec.booking };
}

module.exports = {
  normalizeAmountMode,
  dollarsToAmountCents,
  applyQuickOpsAmountChange,
  prepareQuickOpsMoney,
  reloadBooking,
};
