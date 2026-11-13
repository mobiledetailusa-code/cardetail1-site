'use strict';

/**
 * One completion text after a job is actually finished and the invoice is paid.
 *
 * The outbox key booking.service_completed:<id> is unique, so a repeated
 * payment, a second webhook, or a page refresh cannot send another copy.
 * A failed send is recorded and does not roll back the job.
 */

const { TEMPLATE_KEYS } = require('./sms-templates');
const { enqueueSms, kickSmsOutboxByIds, smsSafeIdempotencyKey } = require('./sms-outbox');
const { bookingSmsConsentGranted } = require('./sms-program');
const { normalizeUsPhoneE164 } = require('./phone-auth');
const { enabled, smsOutboxPolicy } = require('./twilio-runtime-policy');
const { financialProjection } = require('./payment-service');

const OFFICIAL_GOOGLE_REVIEW_URL = 'https://g.page/r/CTJwfJerrQeCEAI/review';
const WEBHOOK_NOTICE_WINDOW_MS = 48 * 60 * 60 * 1000;

function officialGoogleReviewUrl() {
  try {
    const reviews = require('../../assets/customer-reviews.js');
    const url = String(reviews && reviews.GOOGLE_REVIEW_URL || '');
    if (url === OFFICIAL_GOOGLE_REVIEW_URL) return url;
  } catch {
    /* the configured listing is unavailable */
  }
  return '';
}

function completionIdempotencyKey(booking) {
  const id = String(booking && (booking.id || booking.bookingId) || '').trim();
  return smsSafeIdempotencyKey(`booking.service_completed:${id}`);
}

function receiptUrlFor(booking) {
  const { trustedSiteOrigin } = require('./trusted-site-origin');
  const id = String(booking && (booking.id || booking.bookingId) || '').trim();
  if (!/^CD1-[A-Za-z0-9-]+$/.test(id)) return '';
  const origin = String(trustedSiteOrigin() || '').replace(/\/$/, '');
  if (!/^https:\/\//.test(origin)) return '';
  return `${origin}/receipt.html?bookingId=${encodeURIComponent(id)}&type=final`;
}

function jobIsClosed(booking) {
  if (!booking) return false;
  const js = String(booking.jobStatus || '').toLowerCase();
  const st = String(booking.status || '').toLowerCase();
  return js === 'completed' || js === 'completed_paid' || js === 'closed'
    || st === 'completed' || st === 'completed_paid'
    || !!booking.completedAt;
}

function invoiceSettled(booking) {
  const money = financialProjection(booking);
  const settled = Math.max(0, Math.round(Number(money.settledCents) || 0));
  const remaining = Math.max(0, Math.round(Number(money.remainingCents) || 0));
  const paid = money.paymentStatus === 'paid' || settled > 0;
  return { money, settled, remaining, paid: paid && remaining === 0 && settled > 0 };
}

function shouldNotifyFromWebhook(result) {
  if (!result || result.duplicate || result.ignored) return false;
  const projection = result.projection || {};
  const remaining = Math.max(0, Math.round(Number(projection.remainingCents) || 0));
  return projection.paymentStatus === 'paid' && remaining === 0;
}

async function notifyIfServiceClosedAndPaid(booking, opts = {}) {
  try {
    if (!booking) return { ok: true, skipped: true, queued: false, reason: 'booking_required' };
    if (!jobIsClosed(booking)) return { ok: true, skipped: true, queued: false, reason: 'not_completed' };
    const settled = invoiceSettled(booking);
    if (!settled.paid) return { ok: true, skipped: true, queued: false, reason: 'not_paid' };
    if (opts.source === 'stripe_webhook') {
      const completedAt = Date.parse(booking.completedAt || booking.jobCompletedAt || '');
      if (Number.isFinite(completedAt) && Date.now() - completedAt > WEBHOOK_NOTICE_WINDOW_MS) {
        return { ok: true, skipped: true, queued: false, reason: 'historical_completion' };
      }
    }

    const env = opts.env || process.env;
    if (!enabled(env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED) || !smsOutboxPolicy(env).ok) {
      return { ok: true, skipped: true, queued: false, reason: 'customer_sms_not_enabled' };
    }
    if (!bookingSmsConsentGranted(booking)) {
      return { ok: true, skipped: true, queued: false, reason: 'booking_sms_consent_required' };
    }
    const dest = normalizeUsPhoneE164(booking.phone || booking.customerPhone || '');
    if (!dest) return { ok: true, skipped: true, queued: false, reason: 'invalid_sms_recipient' };

    const receiptUrl = receiptUrlFor(booking);
    if (!receiptUrl || /\/ops\/|token=|tqt_|qo_/i.test(receiptUrl)) {
      return { ok: true, skipped: true, queued: false, reason: 'unsafe_receipt_url' };
    }
    const reviewUrl = officialGoogleReviewUrl();
    const idempotencyKey = completionIdempotencyKey(booking);
    if (!idempotencyKey) return { ok: true, skipped: true, queued: false, reason: 'invalid_idempotency_key' };

    const queued = await enqueueSms({
      idempotencyKey,
      audience: 'customer',
      customerAccountId: booking.customerAccountId || null,
      bookingId: booking.id || booking.bookingId,
      booking,
      toE164: dest,
      templateKey: TEMPLATE_KEYS.SERVICE_COMPLETED,
      templateData: {
        receiptUrl,
        reviewUrl: reviewUrl || '',
      },
    }, { prisma: opts.prisma, env });

    if (!queued || !queued.ok) {
      return { ok: true, skipped: true, queued: false, reason: (queued && queued.error) || 'sms_outbox_failed' };
    }
    if (!queued.queued) {
      return { ok: true, skipped: true, queued: false, reason: queued.reason || 'not_queued' };
    }
    const outboxId = queued.outbox && queued.outbox.id;
    if (outboxId && !queued.idempotent) {
      try {
        await kickSmsOutboxByIds([outboxId], { prisma: opts.prisma, env });
      } catch (err) {
        console.warn('[completion-sms] kick_failed', String(err && err.message || err).slice(0, 80));
      }
    }
    return {
      ok: true,
      queued: true,
      skipped: false,
      idempotent: !!queued.idempotent,
      reason: null,
      outboxId: outboxId || null,
    };
  } catch (err) {
    console.warn('[completion-sms] notify_failed', String(err && err.message || err).slice(0, 80));
    return { ok: true, skipped: true, queued: false, reason: 'notify_failed' };
  }
}

module.exports = {
  OFFICIAL_GOOGLE_REVIEW_URL,
  officialGoogleReviewUrl,
  completionIdempotencyKey,
  receiptUrlFor,
  jobIsClosed,
  invoiceSettled,
  shouldNotifyFromWebhook,
  notifyIfServiceClosedAndPaid,
};
