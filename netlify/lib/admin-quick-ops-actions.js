'use strict';

const { getBookingRecord } = require('./booking-repository');
const { confirmBookingTransition } = require('./booking-confirm');
const { cancelBookingTransition } = require('./booking-cancel');
const { decideChangeRequestCommand } = require('./booking-commands');
const {
  projectQuickOpsBooking,
  moneyFromBooking,
  bookingStatus,
  paidInFull,
  jobCompleted,
} = require('./admin-quick-ops-view');
const { createPaymentResumeToken } = require('./payment-resume-token');
const { enqueueSms, smsSafeIdempotencyKey } = require('./sms-outbox');
const { TEMPLATE_KEYS } = require('./sms-templates');
const { bookingSmsConsentGranted } = require('./sms-program');
const { normalizeUsPhoneE164 } = require('./phone-auth');

async function loadProjectedBooking(bookingId) {
  const rec = await getBookingRecord(bookingId);
  if (!rec.exists || !rec.booking) return { ok: false, error: 'not_found', statusCode: 404, reads: 1 };
  let shared = null;
  try {
    const { getSharedFinancialProjection } = require('./db/operational-payment');
    shared = await getSharedFinancialProjection(rec.booking);
  } catch {
    shared = null;
  }
  return {
    ok: true,
    booking: rec.booking,
    view: projectQuickOpsBooking(rec.booking, shared),
    reads: 1,
    paymentAuthority: shared && shared.ok ? 'postgres' : 'blob',
  };
}

async function confirmQuickOps(bookingId, opts = {}) {
  const result = await confirmBookingTransition({ bookingId, by: 'quick_ops' });
  if (!result.ok) return result;
  if (result.transitioned) {
    try {
      const { notifyConfirmed } = require('./appointment-lifecycle-notifications');
      await notifyConfirmed(result.booking, {
        source: 'quick_ops',
        prisma: opts.prisma,
        env: opts.env,
      });
    } catch (err) {
      console.warn('[quick-ops] confirm notify failed', String(err && err.message || err).slice(0, 80));
    }
  }
  return result;
}

async function cancelQuickOps(bookingId, opts = {}) {
  const result = await cancelBookingTransition({
    bookingId,
    by: 'quick_ops',
    reason: opts.reason || 'admin_cancelled',
  });
  if (!result.ok) return result;
  if (result.transitioned) {
    try {
      const { notifyCancelled } = require('./appointment-lifecycle-notifications');
      await notifyCancelled(result.booking, {
        actor: 'admin',
        source: 'quick_ops',
        prisma: opts.prisma,
        env: opts.env,
      });
    } catch (err) {
      console.warn('[quick-ops] cancel notify failed', String(err && err.message || err).slice(0, 80));
    }
  }
  return result;
}

async function decideQuickOps(booking, decision, opts = {}) {
  const list = Array.isArray(booking.changeRequests) ? booking.changeRequests : [];
  const pending = list.find((row) => ['pending', 'requested', 'open', 'submitted', 'awaiting_review']
    .includes(String(row.status || row.requestStatus || '').toLowerCase()));
  const target = pending || list.find((row) => (row.requestId || row.id) === opts.requestId) || list[list.length - 1];
  if (!target) return { ok: false, error: 'no_pending_request', statusCode: 409 };
  const requestId = target.requestId || target.id;
  const result = await decideChangeRequestCommand({
    bookingId: booking.id || booking.bookingId,
    requestId,
    decision,
    expectedBookingVersion: booking.bookingVersion,
    idempotencyKey: opts.idempotencyKey || `qo.decide:${booking.id || booking.bookingId}:${requestId}:${decision}`,
  });
  if (!result.ok) return result;
  if (result.idempotent) return result;
  try {
    const lifecycle = require('./appointment-lifecycle-notifications');
    const rt = target.requestType || target.type || '';
    if (decision === 'approve') {
      if (String(rt).includes('reschedule')) {
        await lifecycle.notifyRescheduled(result.booking, { source: 'quick_ops', prisma: opts.prisma, env: opts.env });
      } else {
        await lifecycle.notifyChangeApproved(result.booking, {
          source: 'quick_ops',
          changeRequestId: requestId,
          requestType: rt,
          requestRecord: target,
          prisma: opts.prisma,
          env: opts.env,
        });
      }
    } else if (decision === 'reject') {
      await lifecycle.notifyChangeRejected(result.booking, {
        source: 'quick_ops',
        changeRequestId: requestId,
        requestType: rt,
        requestRecord: target,
        prisma: opts.prisma,
        env: opts.env,
      });
    }
  } catch (err) {
    console.warn('[quick-ops] decide notify failed', String(err && err.message || err).slice(0, 80));
  }
  return result;
}

async function notifyQuickOpsPaymentReceived(booking, result, method) {
  try {
    const { emitPaymentReceived } = require('./booking-transactional-notifications');
    const projection = result.postgresProjection || result.projection || {};
    await emitPaymentReceived(result.booking || booking, {
      method: method === 'cash' ? 'cash' : 'card',
      amountCents: Math.max(0, Math.round(Number(result.settledAmountCents) || 0)),
      approvedCents: Math.max(0, Math.round(Number(projection.approvedCents) || 0)),
      remainingCents: Math.max(0, Math.round(Number(projection.remainingCents) || 0)),
      settledCentsAfter: Math.max(0, Math.round(Number(projection.settledCents) || 0)),
      recordedAt: new Date().toISOString(),
      settlementId: `${booking.id || booking.bookingId}:${projection.settledCents || 0}:${method}`,
    });
  } catch (err) {
    console.warn('[quick-ops] payment notify failed', String(err && err.message || err).slice(0, 80));
  }
}

/**
 * Record full remaining balance as cash or card on site using the same Admin
 * Postgres payment authority. Blob stays compatibility-only. Fails closed when
 * Postgres payment is disabled.
 */
async function recordOnSitePayment(booking, opts = {}) {
  const method = opts.method === 'card_on_site' || opts.method === 'card' ? 'card_on_site' : 'cash';
  const env = opts.env || process.env;
  const bookingId = String(booking && (booking.id || booking.bookingId) || '').trim();
  if (!bookingId) return { ok: false, error: 'bookingId_required', statusCode: 400 };

  const status = bookingStatus(booking);
  if (status === 'cancelled') {
    return { ok: false, error: 'cancelled', statusCode: 409 };
  }

  let shared = null;
  try {
    const { getSharedFinancialProjection } = require('./db/operational-payment');
    shared = await getSharedFinancialProjection(booking, { env });
  } catch {
    shared = null;
  }
  const money = moneyFromBooking(booking, shared);
  if (paidInFull(booking, money) || !(money.remainingCents > 0)) {
    return { ok: false, error: 'zero_balance', statusCode: 409, remainingCents: 0 };
  }

  const expectedRaw = opts.expectedBookingVersion != null
    ? opts.expectedBookingVersion
    : booking.bookingVersion;
  const expected = Math.round(Number(expectedRaw));
  const actual = Math.round(Number(booking.bookingVersion) || 0);
  if (expectedRaw == null || expectedRaw === '' || !Number.isFinite(expected) || expected !== actual) {
    return {
      ok: false,
      error: 'version_conflict',
      statusCode: 409,
      expectedBookingVersion: Number.isFinite(expected) ? expected : null,
      actualBookingVersion: actual,
    };
  }

  const injectedSettle = typeof opts.settle === 'function';
  const {
    postgresPaymentEnabled,
    settleAdminCashFullBalance,
    settleAdminOnSiteFullBalance,
  } = require('./db/operational-payment');
  if (!injectedSettle && !postgresPaymentEnabled(env)) {
    return { ok: false, error: 'postgres_payment_disabled', statusCode: 503, authority: 'unavailable' };
  }

  const body = method === 'cash'
    ? {
        reason: String(opts.reason || 'quick_ops_cash').trim().slice(0, 500),
        expectedBookingVersion: expected,
      }
    : {
        reason: String(opts.reason || 'quick_ops_card').trim().slice(0, 500),
        reference: String(opts.reference || 'onsite').trim().slice(0, 120),
        expectedBookingVersion: expected,
      };

  const settle = injectedSettle
    ? opts.settle
    : (method === 'cash' ? settleAdminCashFullBalance : settleAdminOnSiteFullBalance);
  const result = await settle({
    booking,
    body,
    method,
    env,
  });
  if (!result || !result.ok) {
    return result || { ok: false, error: 'settlement_failed', statusCode: 500 };
  }
  if (!opts.skipNotify) {
    await notifyQuickOpsPaymentReceived(booking, result, method);
  }
  return result;
}

function currentSchedule(booking) {
  return {
    date: String(booking.confirmedDate || booking.preferredDate || '').slice(0, 10),
    time: String(
      booking.confirmedTime
      || booking.preferredTime
      || booking.confirmedTimeWindow
      || booking.preferredArrivalWindow
      || ''
    ).trim(),
  };
}

/**
 * Owner-initiated move of this one booking. Validates calendar date + known
 * window only — no occupancy scan and no extra blob reads.
 */
async function rescheduleQuickOps(booking, opts = {}) {
  const bookingId = String(booking && (booking.id || booking.bookingId) || '').trim();
  if (!bookingId) return { ok: false, error: 'bookingId_required', statusCode: 400 };

  const status = bookingStatus(booking);
  if (status === 'cancelled') return { ok: false, error: 'cancelled', statusCode: 409 };

  let shared = null;
  try {
    const { getSharedFinancialProjection } = require('./db/operational-payment');
    shared = await getSharedFinancialProjection(booking, { env: opts.env });
  } catch {
    shared = null;
  }
  const money = moneyFromBooking(booking, shared);
  if (paidInFull(booking, money) || (jobCompleted(booking) && !(money.remainingCents > 0))) {
    return { ok: false, error: 'locked', statusCode: 409 };
  }

  const expectedRaw = opts.expectedBookingVersion != null
    ? opts.expectedBookingVersion
    : booking.bookingVersion;
  const expected = Math.round(Number(expectedRaw));
  const actual = Math.round(Number(booking.bookingVersion) || 0);
  if (expectedRaw == null || expectedRaw === '' || !Number.isFinite(expected) || expected !== actual) {
    return {
      ok: false,
      error: 'version_conflict',
      statusCode: 409,
      expectedBookingVersion: Number.isFinite(expected) ? expected : null,
      actualBookingVersion: actual,
    };
  }

  const {
    isoDateParts,
    normalizePreferredTime,
    slotsForDate,
    isClosedHoliday,
  } = require('./operational-availability');
  const parts = isoDateParts(opts.date);
  if (!parts) return { ok: false, error: 'invalid_date', statusCode: 400 };
  if (isClosedHoliday(parts.iso)) return { ok: false, error: 'date_unavailable', statusCode: 400 };
  const slot = normalizePreferredTime(opts.time);
  if (!slot) return { ok: false, error: 'invalid_time', statusCode: 400 };
  const allowed = slotsForDate(parts.iso);
  if (!allowed.length) return { ok: false, error: 'date_unavailable', statusCode: 400 };
  if (!allowed.includes(slot)) return { ok: false, error: 'time_unavailable', statusCode: 400 };

  const current = currentSchedule(booking);
  if (current.date === parts.iso && normalizePreferredTime(current.time) === slot) {
    return {
      ok: true,
      idempotent: true,
      booking,
      confirmedDate: parts.iso,
      confirmedTime: slot,
    };
  }

  const now = new Date().toISOString();
  const { buildNextAggregate } = require('./booking-aggregate');
  const { commitBooking } = require('./booking-repository');
  const { buildRescheduleEventId } = require('./appointment-lifecycle-state');
  const previousConfirmedDate = booking.confirmedDate || booking.preferredDate || '';
  const job = String(booking.jobStatus || '').toLowerCase();
  const next = buildNextAggregate(booking, {
    confirmedDate: parts.iso,
    preferredDate: parts.iso,
    confirmedTime: slot,
    preferredTime: slot,
    confirmedTimeWindow: slot,
    appointmentStatus: 'confirmed',
    status: 'Rescheduled',
    jobStatus: ['cancelled', 'archived_test', 'completed_paid'].includes(job)
      ? booking.jobStatus
      : 'confirmed',
    rescheduledByAdmin: true,
    rescheduledByAdminAt: now,
    rescheduledByClient: false,
    previousConfirmedDate,
    rescheduleEventId: buildRescheduleEventId(bookingId, parts.iso, slot),
    updatedAt: now,
    eventLog: [
      ...(Array.isArray(booking.eventLog) ? booking.eventLog : []),
      {
        action: 'quick_ops_reschedule',
        by: 'quick_ops',
        confirmedDate: parts.iso,
        confirmedTime: slot,
        at: now,
      },
    ],
  });
  const committed = await commitBooking({
    bookingId,
    expectedBookingVersion: expected,
    nextAggregate: next,
  });
  if (!committed.ok) return committed;

  try {
    const { notifyRescheduled } = require('./appointment-lifecycle-notifications');
    await notifyRescheduled(committed.booking, {
      source: 'quick_ops',
      prisma: opts.prisma,
      env: opts.env,
    });
  } catch (err) {
    console.warn('[quick-ops] reschedule notify failed', String(err && err.message || err).slice(0, 80));
  }
  return {
    ok: true,
    booking: committed.booking,
    bookingVersion: committed.bookingVersion,
    confirmedDate: parts.iso,
    confirmedTime: slot,
  };
}

async function mintPaymentLink(booking, opts = {}) {
  let shared = null;
  try {
    const { getSharedFinancialProjection } = require('./db/operational-payment');
    shared = await getSharedFinancialProjection(booking, { env: opts.env });
  } catch {
    shared = null;
  }
  const money = moneyFromBooking(booking, shared);
  if (!(money.remainingCents > 0)) {
    return { ok: false, error: 'zero_balance', statusCode: 409, remainingCents: 0 };
  }
  const minted = await createPaymentResumeToken({
    bookingId: booking.id || booking.bookingId,
    quoteVersion: money.quoteVersion,
  });
  if (!minted.ok) return minted;
  return {
    ok: true,
    payUrl: minted.payUrl,
    reused: minted.reused,
    remainingCents: money.remainingCents,
    quoteVersion: money.quoteVersion,
  };
}

async function textCustomer(booking, { kind, prisma, env } = {}) {
  if (!bookingSmsConsentGranted(booking)) {
    return { ok: true, queued: false, skipped: true, reason: 'booking_sms_consent_required' };
  }
  const toE164 = normalizeUsPhoneE164(booking.phone || booking.customerPhone || '');
  if (!toE164) return { ok: false, error: 'invalid_sms_recipient', statusCode: 400 };
  const bookingId = booking.id || booking.bookingId;
  if (kind === 'payment') {
    const link = await mintPaymentLink(booking, { env });
    if (!link.ok) return link;
    const queued = await enqueueSms({
      idempotencyKey: smsSafeIdempotencyKey(`qo.paylink:${bookingId}:${link.quoteVersion}`),
      audience: 'customer',
      bookingId,
      booking,
      toE164,
      templateKey: TEMPLATE_KEYS.PAYMENT_RESUME,
      templateData: { url: link.payUrl },
    }, { prisma, env });
    return {
      ok: queued.ok,
      queued: queued.queued,
      idempotent: queued.idempotent,
      skipped: queued.skipped,
      reason: queued.reason || queued.error,
      payUrl: link.payUrl,
    };
  }
  const queued = await enqueueSms({
    idempotencyKey: smsSafeIdempotencyKey(`qo.followup:${bookingId}`),
    audience: 'customer',
    bookingId,
    booking,
    toE164,
    templateKey: TEMPLATE_KEYS.OWNER_FOLLOWUP,
    templateData: {},
  }, { prisma, env });
  return {
    ok: queued.ok,
    queued: queued.queued,
    idempotent: queued.idempotent,
    skipped: queued.skipped,
    reason: queued.reason || queued.error,
  };
}

module.exports = {
  loadProjectedBooking,
  confirmQuickOps,
  cancelQuickOps,
  decideQuickOps,
  mintPaymentLink,
  textCustomer,
  recordOnSitePayment,
  rescheduleQuickOps,
};
