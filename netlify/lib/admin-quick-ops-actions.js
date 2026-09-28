'use strict';

const { getBookingRecord, commitBooking } = require('./booking-repository');
const { buildNextAggregate } = require('./booking-aggregate');
const { appendEventLog } = require('./ops-workflow');
const { confirmBookingTransition } = require('./booking-confirm');
const { cancelBookingTransition } = require('./booking-cancel');
const { decideChangeRequestCommand } = require('./booking-commands');
const {
  projectQuickOpsBooking,
  moneyFromBooking,
  bookingStatus,
  paidInFull,
  jobCompleted,
  dollarsFromCents,
} = require('./admin-quick-ops-view');
const { createPaymentResumeToken } = require('./payment-resume-token');
const { enqueueSms, kickSmsOutboxByIds, smsSafeIdempotencyKey } = require('./sms-outbox');
const { TEMPLATE_KEYS } = require('./sms-templates');
const { bookingSmsConsentGranted } = require('./sms-program');
const { normalizeUsPhoneE164 } = require('./phone-auth');

let smsRuntime = null;

function setQuickOpsSmsRuntime(runtime) {
  smsRuntime = runtime && typeof runtime === 'object' ? runtime : null;
}

function resetQuickOpsSmsRuntime() {
  smsRuntime = null;
}

function smsOpts(opts = {}) {
  return {
    prisma: opts.prisma || (smsRuntime && smsRuntime.prisma) || undefined,
    env: opts.env || (smsRuntime && smsRuntime.env) || undefined,
    provider: opts.provider || (smsRuntime && smsRuntime.provider) || undefined,
  };
}

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
    shared,
    view: projectQuickOpsBooking(rec.booking, shared),
    reads: 1,
    paymentAuthority: shared && shared.ok ? 'postgres' : 'blob',
  };
}

async function completeServiceLineQuickOps(booking, serviceId) {
  const { completeServiceLine } = require('./ceramic-coating');
  const { commitBooking } = require('./booking-repository');
  const paymentStatus = booking.paymentStatus;
  const amountPaid = booking.amountPaid;
  const balanceDue = booking.balanceDue;
  const completed = completeServiceLine(booking, serviceId, { role: 'quick_ops', id: 'quick_ops' });
  if (!completed.ok) return completed;
  completed.booking.paymentStatus = paymentStatus;
  completed.booking.amountPaid = amountPaid;
  completed.booking.balanceDue = balanceDue;
  completed.booking.updatedAt = new Date().toISOString();
  return commitBooking({
    bookingId: booking.id || booking.bookingId,
    expectedBookingVersion: booking.bookingVersion,
    nextAggregate: completed.booking,
  });
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

function safeDeliveryReason(reason) {
  const raw = String(reason || '').trim();
  if (!raw || raw === 'not_sent' || raw === 'not_queued') return '';
  if (/https?:|token|secret|prt_|tqt_|\/pay\/|\/ops\//i.test(raw)) return '';
  const cleaned = raw.replace(/[^\w.:-]+/g, ' ').trim().slice(0, 48);
  return cleaned;
}

function deliveryFromOutbox(outbox) {
  if (!outbox) return { delivery: 'failed', reason: 'not_queued' };
  const code = String(outbox.lastErrorCode || '');
  if (code === 'suppressed') return { delivery: 'suppressed', reason: 'suppressed' };
  const sid = outbox.providerMessageSid;
  const status = String(outbox.status || '');
  if (status === 'delivered' && sid) return { delivery: 'delivered', reason: null };
  if (sid && (status === 'accepted' || status === 'sent')) return { delivery: 'accepted', reason: null };
  if (status === 'failed') return { delivery: 'failed', reason: code || 'not_sent' };
  return { delivery: 'pending', reason: code || null };
}

function paymentLinkMessage(result = {}) {
  if (result.error === 'zero_balance') return 'Paid / No balance due';
  if (result.reason === 'booking_sms_consent_required') return 'Customer SMS consent required.';
  if (result.reason === 'sms_suppressed' || result.delivery === 'suppressed') {
    return 'Payment link was not sent. This number opted out.';
  }
  if (result.delivery === 'delivered') return 'Payment link delivered.';
  if (result.delivery === 'accepted') return 'Payment link accepted by the provider.';
  if (result.delivery === 'pending') return 'Payment link send is pending.';
  const reason = safeDeliveryReason(result.reason || result.error);
  return reason ? `Payment link was not sent. ${reason}` : 'Payment link was not sent.';
}

function extraProposalMessage(result = {}, amountLabel) {
  const saved = `Extra of ${amountLabel} saved for customer approval. Your pay is unchanged.`;
  if (result.reason === 'booking_sms_consent_required') {
    return `${saved} Customer SMS consent required.`;
  }
  if (result.delivery === 'suppressed' || result.reason === 'sms_suppressed') {
    return `${saved} The approval text was not sent. This number opted out.`;
  }
  if (result.delivery === 'delivered') return `${saved} Approval text delivered.`;
  if (result.delivery === 'accepted') return `${saved} Approval text accepted by the provider.`;
  if (result.delivery === 'pending') return `${saved} Approval text send is pending.`;
  const reason = safeDeliveryReason(result.reason || result.error);
  return reason
    ? `${saved} The approval text was not sent. ${reason}`
    : `${saved} The approval text was not sent.`;
}

function arrivalMessage(result = {}, repeat) {
  if (repeat && (result.delivery === 'delivered' || result.delivery === 'accepted')) {
    return 'Arrival already recorded.';
  }
  if (result.reason === 'booking_sms_consent_required') {
    return 'Arrival recorded. Customer text was not sent. Customer SMS consent required.';
  }
  if (result.delivery === 'suppressed' || result.reason === 'sms_suppressed') {
    return 'Arrival recorded. Customer text was not sent. This number opted out.';
  }
  if (result.delivery === 'delivered') return 'Arrival recorded. Customer text delivered.';
  if (result.delivery === 'accepted') return 'Arrival recorded. Customer text accepted by the provider.';
  if (result.delivery === 'pending') return 'Arrival recorded. Customer text send is pending.';
  const reason = safeDeliveryReason(result.reason || result.error);
  return reason
    ? `Arrival recorded. Customer text was not sent. ${reason}`
    : 'Arrival recorded. Customer text was not sent.';
}

async function resetOutboxForRetry(prisma, outbox) {
  if (!prisma || !prisma.smsOutbox || !outbox || !outbox.id) return outbox;
  if (outbox.lastErrorCode === 'suppressed') return outbox;
  if (outbox.providerMessageSid && ['accepted', 'sent', 'delivered'].includes(outbox.status)) return outbox;
  const failed = outbox.status === 'failed';
  const waiting = outbox.status === 'accepted' && !outbox.providerMessageSid && outbox.lastErrorCode;
  if (!failed && !waiting) return outbox;
  return prisma.smsOutbox.update({
    where: { id: outbox.id },
    data: {
      status: 'accepted',
      providerMessageSid: null,
      leaseToken: null,
      leaseExpiresAt: null,
      availableAt: new Date(),
      lastErrorCode: null,
    },
  });
}

async function dispatchCustomerTemplate({
  booking,
  idempotencyKey,
  templateKey,
  templateData,
  prisma,
  env,
  provider,
}) {
  if (!bookingSmsConsentGranted(booking)) {
    return { ok: true, queued: false, skipped: true, delivery: 'failed', reason: 'booking_sms_consent_required' };
  }
  const toE164 = normalizeUsPhoneE164(booking.phone || booking.customerPhone || '');
  if (!toE164) return { ok: false, delivery: 'failed', error: 'invalid_sms_recipient', statusCode: 400 };
  const runtime = smsOpts({ prisma, env, provider });
  const bookingId = booking.id || booking.bookingId;
  let queued;
  try {
    queued = await enqueueSms({
      idempotencyKey: smsSafeIdempotencyKey(idempotencyKey),
      audience: 'customer',
      bookingId,
      booking,
      toE164,
      templateKey,
      templateData: templateData || {},
    }, runtime);
  } catch (err) {
    return { ok: false, delivery: 'failed', error: 'sms_failed', reason: 'sms_failed', statusCode: 503 };
  }
  if (!queued || !queued.ok) {
    return {
      ok: false,
      delivery: 'failed',
      reason: (queued && (queued.reason || queued.error)) || 'not_queued',
      statusCode: (queued && queued.statusCode) || 400,
    };
  }
  if (!queued.queued) {
    const suppressed = queued.reason === 'sms_suppressed';
    return {
      ok: true,
      queued: false,
      skipped: true,
      delivery: suppressed ? 'suppressed' : 'failed',
      reason: queued.reason || 'not_queued',
    };
  }
  const existing = deliveryFromOutbox(queued.outbox);
  if (existing.delivery === 'delivered' || existing.delivery === 'accepted' || existing.delivery === 'suppressed') {
    return { ok: true, queued: true, idempotent: true, ...existing };
  }
  const outbox = await resetOutboxForRetry(runtime.prisma, queued.outbox);
  const outboxId = outbox && outbox.id;
  if (!outboxId) return { ok: false, delivery: 'failed', reason: 'not_queued' };
  let kick = null;
  try {
    kick = await kickSmsOutboxByIds([outboxId], runtime);
  } catch {
    kick = { ok: false, skipped: true, reason: 'kick_failed' };
  }
  let fresh = outbox;
  if (runtime.prisma && runtime.prisma.smsOutbox) {
    fresh = await runtime.prisma.smsOutbox.findUnique({ where: { id: outboxId } }) || outbox;
  }
  const kicked = Array.isArray(kick && kick.results) ? kick.results.find((row) => row && row.outbox) : null;
  if (kicked && kicked.reason === 'suppressed') {
    return { ok: true, queued: true, delivery: 'suppressed', reason: 'suppressed' };
  }
  const outcome = deliveryFromOutbox(fresh);
  const resent = !!(kick && kick.processed > 0);
  if (kick && kick.skipped && outcome.delivery === 'pending') {
    return {
      ok: true,
      queued: true,
      idempotent: !resent && !!queued.idempotent,
      delivery: 'pending',
      reason: kick.reason || 'pending',
    };
  }
  return { ok: true, queued: true, idempotent: !resent && !!queued.idempotent, ...outcome };
}

async function textCustomer(booking, { kind, prisma, env, provider } = {}) {
  const bookingId = booking.id || booking.bookingId;
  if (kind === 'payment') {
    const link = await mintPaymentLink(booking, { env: (smsOpts({ env }).env) });
    if (!link.ok) return link;
    const sent = await dispatchCustomerTemplate({
      booking,
      idempotencyKey: `qo.paylink:${bookingId}:${link.quoteVersion}`,
      templateKey: TEMPLATE_KEYS.PAYMENT_RESUME,
      templateData: { url: link.payUrl },
      prisma,
      env,
      provider,
    });
    return { ...sent, payUrl: link.payUrl };
  }
  if (!bookingSmsConsentGranted(booking)) {
    return { ok: true, queued: false, skipped: true, reason: 'booking_sms_consent_required' };
  }
  const toE164 = normalizeUsPhoneE164(booking.phone || booking.customerPhone || '');
  if (!toE164) return { ok: false, error: 'invalid_sms_recipient', statusCode: 400 };
  const runtime = smsOpts({ prisma, env, provider });
  const queued = await enqueueSms({
    idempotencyKey: smsSafeIdempotencyKey(`qo.followup:${bookingId}`),
    audience: 'customer',
    bookingId,
    booking,
    toE164,
    templateKey: TEMPLATE_KEYS.OWNER_FOLLOWUP,
    templateData: {},
  }, runtime);
  return {
    ok: queued.ok,
    queued: queued.queued,
    idempotent: queued.idempotent,
    skipped: queued.skipped,
    reason: queued.reason || queued.error,
  };
}

async function offerExtraToCustomer(booking, adjustment) {
  if (!booking || !adjustment || !adjustment.adjustmentId) {
    return { ok: false, delivery: 'failed', reason: 'missing_adjustment' };
  }
  const bookingId = booking.id || booking.bookingId;
  const adjustmentId = String(adjustment.adjustmentId);
  let current = booking;
  let token = String(adjustment.proposalToken || '');
  if (!token) {
    const { createCompletionLink } = require('./customer-completion-link');
    let minted;
    try {
      minted = await createCompletionLink(bookingId, 'extra_approval', { adjustmentId });
    } catch {
      return {
        ok: false,
        delivery: 'failed',
        reason: 'proposal_unavailable',
        booking: current,
        bookingVersion: current.bookingVersion,
        message: extraProposalMessage({ delivery: 'failed', reason: 'proposal_unavailable' }, dollarsFromCents(adjustment.amountCents)),
      };
    }
    token = minted.token;
    const { listAdjustments } = require('./price-adjustments');
    const priceAdjustments = listAdjustments(current).map((row) => (
      String(row.adjustmentId) === adjustmentId ? { ...row, proposalToken: token } : row
    ));
    const next = buildNextAggregate(current, {
      priceAdjustments,
      updatedAt: new Date().toISOString(),
    });
    const committed = await commitBooking({
      bookingId,
      expectedBookingVersion: current.bookingVersion,
      nextAggregate: next,
    });
    if (!committed.ok) {
      return {
        ok: false,
        delivery: 'failed',
        reason: committed.error || 'version_conflict',
        booking: current,
        bookingVersion: current.bookingVersion,
      };
    }
    current = committed.booking;
  }
  const amountLabel = dollarsFromCents(adjustment.amountCents);
  const base = String(process.env.PUBLIC_SITE_URL || process.env.URL || 'https://cardetail1.com').replace(/\/$/, '');
  const url = `${base}/.netlify/functions/customer-portal-action?token=${encodeURIComponent(token)}`;
  const sent = await dispatchCustomerTemplate({
    booking: current,
    idempotencyKey: `qo.extra:${bookingId}:${adjustmentId}`,
    templateKey: TEMPLATE_KEYS.EXTRA_APPROVAL,
    templateData: { url, amount: amountLabel },
    ...smsOpts({}),
  });
  return {
    ok: true,
    booking: current,
    bookingVersion: current.bookingVersion,
    delivery: sent.delivery,
    reason: sent.reason || null,
    idempotent: !!sent.idempotent,
    message: extraProposalMessage(sent, amountLabel),
  };
}

async function commitArrival(booking, patch) {
  const next = buildNextAggregate(booking, patch);
  return commitBooking({
    bookingId: booking.id || booking.bookingId,
    expectedBookingVersion: booking.bookingVersion,
    nextAggregate: next,
  });
}

/**
 * Record arrival for the assigned technician. A failed customer text stays
 * retryable. Arrival does not complete the job or change payment.
 */
async function recordTechnicianArrival(booking, opts = {}) {
  if (!booking) return { ok: false, error: 'not_found', statusCode: 404 };
  if (bookingStatus(booking) === 'cancelled' || jobCompleted(booking)) {
    return { ok: false, error: 'locked', statusCode: 409, message: 'This job is closed.' };
  }
  if (!booking.techQuickOpsTokenHash) {
    return { ok: false, error: 'not_assigned', statusCode: 409, message: 'This job is not assigned.' };
  }
  const bookingId = booking.id || booking.bookingId;
  const key = `qo.arrived:${bookingId}`;
  const already = !!booking.arrivedAt;
  let current = booking;
  if (!already) {
    const now = new Date().toISOString();
    const committed = await commitArrival(booking, {
      arrivedAt: now,
      arrivalNotifyKey: smsSafeIdempotencyKey(key),
      arrivalNotifyStatus: 'pending',
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'tech_arrived', by: 'tech_quick_ops' }),
    });
    if (!committed.ok) return committed;
    current = committed.booking;
  }
  const sent = await dispatchCustomerTemplate({
    booking: current,
    idempotencyKey: key,
    templateKey: TEMPLATE_KEYS.TECH_ARRIVED,
    templateData: {},
    prisma: opts.prisma,
    env: opts.env,
    provider: opts.provider,
  });
  const notifyStatus = sent.delivery === 'delivered'
    ? 'delivered'
    : sent.delivery === 'accepted'
      ? 'accepted'
      : sent.delivery === 'suppressed'
        ? 'suppressed'
        : sent.delivery === 'pending'
          ? 'pending'
          : 'failed';
  if (current.arrivalNotifyStatus !== notifyStatus) {
    const recorded = await commitArrival(current, {
      arrivalNotifyStatus: notifyStatus,
      arrivalNotifyKey: smsSafeIdempotencyKey(key),
      updatedAt: new Date().toISOString(),
    });
    if (recorded.ok) current = recorded.booking;
  }
  const repeat = already && !!sent.idempotent && (sent.delivery === 'delivered' || sent.delivery === 'accepted');
  return {
    ok: true,
    booking: current,
    bookingVersion: current.bookingVersion,
    arrivedAt: current.arrivedAt,
    delivery: sent.delivery,
    reason: sent.reason || null,
    idempotent: repeat,
    message: arrivalMessage(sent, repeat),
  };
}

module.exports = {
  loadProjectedBooking,
  confirmQuickOps,
  cancelQuickOps,
  decideQuickOps,
  mintPaymentLink,
  textCustomer,
  paymentLinkMessage,
  offerExtraToCustomer,
  recordTechnicianArrival,
  recordOnSitePayment,
  completeServiceLineQuickOps,
  setQuickOpsSmsRuntime,
  resetQuickOpsSmsRuntime,
};
