'use strict';

/**
 * Review request lifecycle: one ledger, one lock, fail-closed consent.
 *
 * Ledger. The PostgreSQL SmsOutbox is the only record of what was asked. A
 * solicitation is any customer row whose template asks for a review:
 *   - booking.review_requested           (initial ask, unpaid completion path)
 *   - booking.service_completed          (counts only while it carries the review link)
 *   - booking.review_reminder ...:auto   (automatic reminder, at most one)
 *   - booking.review_reminder ...:manual (owner resend, at most one)
 *
 * Consent. Every solicitation, the initial ask included, requires:
 *   - REVIEW_SOLICITATION_A2P_CAMPAIGN_VERIFIED=true (owner confirmed the Twilio
 *     campaign covers review requests), and
 *   - the booking's consent text version listed in REVIEW_SOLICITATION_CONSENT_VERSIONS.
 * Both are empty by default, and no existing transactional consent version is
 * treated as review consent. Without them the completion text still delivers
 * its receipt, only without the review link.
 * Follow-ups additionally need their own switch: REVIEW_REMINDER_AUTOMATION_ENABLED
 * or REVIEW_MANUAL_RESEND_ENABLED (independent of each other).
 *
 * Neutrality. Eligibility never depends on satisfaction, complaints, service
 * issues, ratings or predicted ratings. A review already left (first-party, or
 * marked received by the owner) ends asking, whatever its rating.
 *
 * Atomicity. Every review enqueue and every review dispatch decision for a
 * booking runs under one PostgreSQL transaction-scoped advisory lock keyed by
 * the booking id, so concurrent completion paths, double clicks and parallel
 * workers see each other's rows. No schema change is needed.
 *
 * Nothing here detects Google reviews or infers delivery.
 */

const { enabled, smsOutboxPolicy } = require('./twilio-runtime-policy');
const { TEMPLATE_KEYS } = require('./sms-templates');
const { bookingSmsConsentGranted } = require('./sms-program');
const { normalizeUsPhoneE164 } = require('./phone-auth');
const { postServiceState } = require('./post-service-experience');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const REMINDER_DELAY_MS = 48 * HOUR_MS;
const COOLDOWN_MS = 24 * HOUR_MS;
const EXPIRY_MS = 14 * DAY_MS;
// A reminder is scheduled only from a live completion. Older completions are
// historical and never get one, which blocks retroactive mass sends.
const LIVE_COMPLETION_MS = 6 * HOUR_MS;
const MAX_AUTOMATIC = 2;
const MAX_TOTAL = 3;
const IN_FLIGHT_RETRY_MS = 2 * 60 * 1000;
const GATE_RETRY_MS = 10 * 60 * 1000;

const SEND_WINDOW = Object.freeze({
  timeZone: 'America/New_York',
  startHour: 10,
  endHour: 18, // exclusive
  days: Object.freeze([1, 2, 3, 4, 5, 6]), // Monday..Saturday
});

const CANCEL_PREFIX = 'review_cancelled_';
const OFFICIAL_GOOGLE_REVIEW_URL = 'https://g.page/r/CTJwfJerrQeCEAI/review';

const FOLLOWUP_TEMPLATE = TEMPLATE_KEYS.REVIEW_REMINDER;
const SOLICITATION_TEMPLATE_KEYS = Object.freeze([
  TEMPLATE_KEYS.REVIEW_REQUESTED,
  TEMPLATE_KEYS.SERVICE_COMPLETED,
  TEMPLATE_KEYS.REVIEW_REMINDER,
]);
// Templates the worker re-checks under the lock right before dispatch.
const REVIEW_GATED_TEMPLATE_KEYS = new Set(SOLICITATION_TEMPLATE_KEYS);

// Failure codes recorded before any provider call. Any other failure on a row
// that reached the provider call (network timeout, 5xx after retries, etc.) is
// ambiguous: the text may have gone out, so it keeps its solicitation slot.
const PRE_SEND_FAILURE_CODES = new Set([
  'superseded',
  'suppressed',
  'suppression_unavailable',
  'unknown_sms_template',
  'invalid_sms_template_data',
  'invalid_sms_recipient',
]);

// ---------------------------------------------------------------------------
// Flags and compliance

function listEnv(value) {
  return String(value || '').split(',').map((part) => part.trim()).filter(Boolean);
}

function reviewFlags(env = process.env) {
  return {
    automationEnabled: enabled(env.REVIEW_REMINDER_AUTOMATION_ENABLED),
    manualResendEnabled: enabled(env.REVIEW_MANUAL_RESEND_ENABLED),
    campaignVerified: enabled(env.REVIEW_SOLICITATION_A2P_CAMPAIGN_VERIFIED),
    consentVersions: listEnv(env.REVIEW_SOLICITATION_CONSENT_VERSIONS),
    customerSmsEnabled: enabled(env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED) && smsOutboxPolicy(env).ok,
  };
}

/** Blockers that apply to every solicitation, independent of the booking. */
function programBlockers(env = process.env) {
  const flags = reviewFlags(env);
  const blockers = [];
  if (!flags.customerSmsEnabled) blockers.push('customer_sms_not_enabled');
  if (!flags.campaignVerified) blockers.push('a2p_campaign_not_verified');
  if (!flags.consentVersions.length) blockers.push('review_consent_not_established');
  return blockers;
}

function bookingConsentCoversReviews(booking, env = process.env) {
  if (!bookingSmsConsentGranted(booking)) return false;
  const version = String(booking.transactionalSmsConsent?.textVersion || '');
  return reviewFlags(env).consentVersions.includes(version);
}

/** Consent and campaign gate for ANY review solicitation (fail closed). */
function solicitationCompliance(booking, env = process.env) {
  const blockers = programBlockers(env);
  if (blockers.length) return { ok: false, reason: blockers[0] };
  if (!booking) return { ok: false, reason: 'booking_not_found' };
  if (!bookingSmsConsentGranted(booking)) return { ok: false, reason: 'booking_sms_consent_required' };
  if (!bookingConsentCoversReviews(booking, env)) return { ok: false, reason: 'consent_version_not_covered' };
  if (!normalizeUsPhoneE164(booking.phone || booking.customerPhone || '')) {
    return { ok: false, reason: 'invalid_sms_recipient' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Send window (America/New_York, Monday..Saturday, 10:00-18:00)

const windowFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: SEND_WINDOW.timeZone,
  weekday: 'short',
  hour: 'numeric',
  hourCycle: 'h23',
});
const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function isWithinSendWindow(at) {
  const parts = windowFormatter.formatToParts(new Date(at));
  const weekday = WEEKDAY[parts.find((p) => p.type === 'weekday')?.value];
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  return SEND_WINDOW.days.includes(weekday) && hour >= SEND_WINDOW.startHour && hour < SEND_WINDOW.endHour;
}

/** Earliest instant >= at inside the window (15-minute resolution). */
function nextSendWindowStart(at) {
  const start = ms(at);
  if (start == null) return null;
  if (isWithinSendWindow(start)) return new Date(start);
  const step = 15 * 60 * 1000;
  let t = Math.ceil(start / step) * step;
  for (let i = 0; i < 8 * 96; i += 1, t += step) {
    if (isWithinSendWindow(t)) return new Date(t);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prisma helpers: lock and ledger reads

function prismaClient(override) {
  if (override) return override;
  const { tryGetPrisma } = require('./prisma');
  return tryGetPrisma();
}

function bookingIdOf(booking) {
  return String(booking && (booking.id || booking.bookingId) || '').trim();
}

function lockKey(bookingId) {
  return `cd1-review:${String(bookingId || '').trim()}`;
}

/**
 * Run fn(tx) holding the booking's review lock. With a real Prisma client this
 * is a transaction-scoped PostgreSQL advisory lock, released on commit or
 * rollback. Test doubles without raw SQL run fn directly (no concurrency).
 */
async function withReviewLock(prisma, bookingId, fn) {
  if (!prisma || typeof prisma.$transaction !== 'function' || typeof prisma.$executeRawUnsafe !== 'function') {
    return fn(prisma);
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      'SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended($1, 0))) AS lock_taken',
      lockKey(bookingId),
    );
    return fn(tx);
  }, { timeout: 20_000, maxWait: 20_000 });
}

function reminderIdempotencyKey(bookingId, kind) {
  const { smsSafeIdempotencyKey } = require('./sms-outbox');
  return smsSafeIdempotencyKey(`booking.review_reminder:${bookingId}:${kind === 'manual' ? 'manual' : 'auto'}`);
}

const ROW_SELECT = {
  id: true,
  idempotencyKey: true,
  bookingId: true,
  templateKey: true,
  templateData: true,
  status: true,
  providerMessageSid: true,
  providerStatus: true,
  attemptCount: true,
  maxAttempts: true,
  availableAt: true,
  leaseExpiresAt: true,
  lastErrorCode: true,
  acceptedAt: true,
  sentAt: true,
  deliveredAt: true,
  failedAt: true,
};

/** Review rows for many bookings in ONE query. Throws when the ledger is unavailable. */
async function loadReviewRows(bookingIds, opts = {}) {
  const ids = [...new Set((bookingIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return new Map();
  const prisma = prismaClient(opts.prisma);
  if (!prisma?.smsOutbox || typeof prisma.smsOutbox.findMany !== 'function') {
    const err = new Error('sms_outbox_unavailable');
    err.code = 'sms_outbox_unavailable';
    throw err;
  }
  const rows = await prisma.smsOutbox.findMany({
    where: {
      bookingId: { in: ids },
      audience: 'customer',
      templateKey: { in: [...SOLICITATION_TEMPLATE_KEYS] },
    },
    orderBy: { acceptedAt: 'asc' },
    select: ROW_SELECT,
  });
  const byBooking = new Map(ids.map((id) => [id, []]));
  for (const row of rows || []) {
    if (byBooking.has(row.bookingId)) byBooking.get(row.bookingId).push(row);
  }
  return byBooking;
}

async function loadReviewRowsForBooking(bookingId, opts = {}) {
  const map = await loadReviewRows([bookingId], opts);
  return map.get(String(bookingId || '').trim()) || [];
}

// ---------------------------------------------------------------------------
// Row classification

function ms(value) {
  if (value == null || value === '') return null;
  let t;
  if (value instanceof Date) t = value.getTime();
  else if (typeof value === 'number') t = value;
  else t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function iso(value) {
  const t = ms(value);
  return t == null ? null : new Date(t).toISOString();
}

function rowKind(row) {
  const key = String(row.templateKey || '');
  if (key === TEMPLATE_KEYS.REVIEW_REQUESTED) return 'initial_request';
  if (key === TEMPLATE_KEYS.SERVICE_COMPLETED) {
    return String(row.templateData?.reviewUrl || '') ? 'completion_with_review_link' : 'completion_receipt_only';
  }
  if (key === TEMPLATE_KEYS.REVIEW_REMINDER) {
    return /:manual$/.test(String(row.idempotencyKey || '')) ? 'manual_resend' : 'automatic_reminder';
  }
  return 'other';
}

function isSolicitationKind(kind) {
  return kind === 'initial_request' || kind === 'completion_with_review_link'
    || kind === 'automatic_reminder' || kind === 'manual_resend';
}

function isInitialKind(kind) {
  return kind === 'initial_request' || kind === 'completion_with_review_link';
}

function isAutomaticKind(kind) {
  return isInitialKind(kind) || kind === 'automatic_reminder';
}

function preSendFailure(row) {
  const code = String(row.lastErrorCode || '');
  return code.startsWith(CANCEL_PREFIX) || PRE_SEND_FAILURE_CODES.has(code);
}

/**
 * Delivery stage, strictly from what the ledger records. "submitted" = Twilio
 * accepted the request (Message SID held); "sent"/"delivered" come only from
 * Twilio's own status values. "ambiguous" = the provider call failed in a way
 * that does not prove the text was not sent.
 */
function rowStage(row, now = Date.now()) {
  const status = String(row.status || '');
  const code = String(row.lastErrorCode || '');
  if (status === 'delivered') return 'delivered';
  if (status === 'sent') return 'sent';
  if (status === 'failed') {
    if (code.startsWith(CANCEL_PREFIX) || code === 'superseded') return 'cancelled';
    if (code === 'suppressed') return 'opted_out';
    if (!row.providerMessageSid && !preSendFailure(row)) return 'ambiguous';
    return 'failed';
  }
  if (row.providerMessageSid) return 'submitted';
  const available = ms(row.availableAt);
  if (available != null && available > now) return code ? 'retry_scheduled' : 'scheduled';
  return 'queued';
}

/**
 * Whether a row uses a solicitation slot. Only rows proven never to have
 * reached the customer give their slot back: cancelled or rejected before the
 * provider call. Ambiguous provider failures keep it, so they cannot cause a
 * second ask.
 */
function consumesSlot(row) {
  if (!isSolicitationKind(rowKind(row))) return false;
  if (String(row.status || '') !== 'failed') return true;
  if (row.providerMessageSid) return true;
  return !preSendFailure(row);
}

function reachedProvider(row) {
  return !!row.providerMessageSid || ['sent', 'delivered'].includes(String(row.status || ''));
}

function inFlight(row, now) {
  const lease = ms(row.leaseExpiresAt);
  return String(row.status || '') === 'accepted' && !row.providerMessageSid && lease != null && lease > now;
}

function lastSolicitationAtMs(rows, { excludeId } = {}) {
  let last = null;
  for (const row of rows) {
    if (row.id === excludeId || !isSolicitationKind(rowKind(row))) continue;
    if (!reachedProvider(row) && rowStage(row) !== 'ambiguous') continue;
    const t = ms(row.sentAt) ?? ms(row.failedAt) ?? ms(row.acceptedAt);
    if (t != null && (last == null || t > last)) last = t;
  }
  return last;
}

function slotCounts(rows, { excludeId } = {}) {
  let automatic = 0;
  let total = 0;
  for (const row of rows) {
    if (row.id === excludeId || !consumesSlot(row)) continue;
    total += 1;
    if (isAutomaticKind(rowKind(row))) automatic += 1;
  }
  return { automatic, total };
}

/** An initial ask that holds a slot, other than `excludeId` (and, if given, accepted before it). */
function otherInitial(rows, { excludeId, before } = {}) {
  return rows.find((row) => {
    if (row.id === excludeId || !isInitialKind(rowKind(row)) || !consumesSlot(row)) return false;
    if (before == null) return true;
    const a = ms(row.acceptedAt);
    return a != null && (a < before.acceptedAtMs || (a === before.acceptedAtMs && String(row.id) < String(before.id)));
  }) || null;
}

// ---------------------------------------------------------------------------
// Booking state (no sentiment, no complaints)

function ownerMarkers(booking) {
  const rr = booking && booking.reviewRequest && typeof booking.reviewRequest === 'object' ? booking.reviewRequest : {};
  return { receivedAt: rr.receivedAt || null, stoppedAt: rr.stoppedAt || null, stopReason: rr.stopReason || null };
}

function completionMs(booking) {
  const state = postServiceState(booking || {});
  return state.completed ? ms(state.completedAt || booking.completedAt || booking.techCompletedAt) : null;
}

function reviewAlreadyReceived(booking) {
  if (ownerMarkers(booking).receivedAt) return true;
  const state = postServiceState(booking || {});
  return !!(state.review && state.review.submitted);
}

/** Booking-level reasons to stop asking. Deliberately none depend on satisfaction. */
function stateBlocker(booking, nowMs) {
  if (!booking) return 'booking_not_found';
  const completedAt = completionMs(booking);
  if (completedAt == null) return 'not_completed';
  if (ownerMarkers(booking).stoppedAt) return 'stopped';
  if (reviewAlreadyReceived(booking)) return 'review_received';
  if (nowMs - completedAt > EXPIRY_MS) return 'expired';
  return null;
}

/** Initial ask (review_requested, or the receipt's review link). */
function initialEligibility(booking, rows, { now = Date.now(), env = process.env, excludeId, before } = {}) {
  const nowMs = ms(now) ?? Date.now();
  const compliance = solicitationCompliance(booking, env);
  if (!compliance.ok) return { ok: false, reason: compliance.reason, terminal: true };
  const blocker = stateBlocker(booking, nowMs);
  if (blocker) return { ok: false, reason: blocker, terminal: true };
  if (otherInitial(rows, { excludeId, before })) return { ok: false, reason: 'duplicate_initial', terminal: true };
  if (slotCounts(rows, { excludeId }).total >= MAX_TOTAL) return { ok: false, reason: 'total_cap_reached', terminal: true };
  return { ok: true };
}

/**
 * Follow-up solicitation (automatic reminder or manual resend).
 * { ok } | { ok:false, reason, terminal:true } | { ok:false, reason, terminal:false, retryAt }
 */
function followUpEligibility(booking, rows, { kind = 'auto', now = Date.now(), env = process.env, excludeId } = {}) {
  const flags = reviewFlags(env);
  const nowMs = ms(now) ?? Date.now();
  const terminal = (reason) => ({ ok: false, reason, terminal: true });

  if (kind === 'manual' ? !flags.manualResendEnabled : !flags.automationEnabled) {
    return terminal(kind === 'manual' ? 'manual_resend_disabled' : 'automation_disabled');
  }
  const compliance = solicitationCompliance(booking, env);
  if (!compliance.ok) return terminal(compliance.reason);
  const blocker = stateBlocker(booking, nowMs);
  if (blocker) return terminal(blocker);

  const counts = slotCounts(rows, { excludeId });
  if (counts.total >= MAX_TOTAL) return terminal('total_cap_reached');
  if (kind !== 'manual' && counts.automatic >= MAX_AUTOMATIC) return terminal('automatic_cap_reached');
  if (!otherInitial(rows, { excludeId })) return terminal('no_initial_request');

  const completedAt = completionMs(booking);
  let earliest = nowMs;
  let reason = 'outside_send_window';
  if (kind !== 'manual' && completedAt + REMINDER_DELAY_MS > earliest) {
    earliest = completedAt + REMINDER_DELAY_MS;
    reason = 'reminder_delay';
  }
  const last = lastSolicitationAtMs(rows, { excludeId });
  if (last != null && last + COOLDOWN_MS > earliest) {
    earliest = last + COOLDOWN_MS;
    reason = 'cooldown';
  }
  const slot = nextSendWindowStart(earliest);
  if (!slot || slot.getTime() > completedAt + EXPIRY_MS) return terminal('expired');
  if (slot.getTime() > nowMs) return { ok: false, reason, terminal: false, retryAt: slot };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Enqueue paths (all under the booking lock)

function reviewUrl() {
  try {
    const { officialGoogleReviewUrl } = require('./service-completion-notice');
    const url = officialGoogleReviewUrl();
    if (url === OFFICIAL_GOOGLE_REVIEW_URL) return url;
  } catch {
    /* listing unavailable */
  }
  return '';
}

/**
 * Enqueue the completion text with its review link decided under the lock.
 * The receipt always goes; the link is included only when an initial ask is
 * eligible (consent, campaign, no other initial ask, not stopped/received).
 * On any lock or ledger error the link is omitted (fail closed) and the
 * receipt is still queued.
 */
async function enqueueCompletionNotice(booking, input, opts = {}) {
  const { enqueueSms } = require('./sms-outbox');
  const env = opts.env || process.env;
  const nowMs = ms(opts.now) ?? Date.now();
  const defaultUrl = String(input.templateData?.reviewUrl || '');
  const prisma = prismaClient(opts.prisma);
  const run = async (tx) => {
    let url = '';
    let rows = null;
    try {
      rows = await loadReviewRowsForBooking(bookingIdOf(booking), { prisma: tx });
    } catch {
      rows = null;
    }
    const own = rows && rows.find((row) => row.idempotencyKey === input.idempotencyKey);
    if (own) {
      url = String(own.templateData?.reviewUrl || ''); // keep the stored payload (idempotent)
    } else if (rows && defaultUrl && initialEligibility(booking, rows, { now: nowMs, env }).ok) {
      url = defaultUrl;
    }
    const queued = await enqueueSms({
      ...input,
      templateData: { ...(input.templateData || {}), reviewUrl: url },
    }, { prisma: tx, env });
    return { queued, reviewLinkIncluded: !!url };
  };
  try {
    return await withReviewLock(prisma, bookingIdOf(booking), run);
  } catch (err) {
    // Lock or transaction failure: receipt without a review link.
    console.warn('[review-lifecycle] completion_lock_failed', String(err && err.message || err).slice(0, 80));
    const queued = await enqueueSms({
      ...input,
      templateData: { ...(input.templateData || {}), reviewUrl: '' },
    }, { prisma: opts.prisma, env });
    return { queued, reviewLinkIncluded: false };
  }
}

/**
 * Enqueue booking.review_requested only when an initial ask is eligible. Any
 * error means no ask (fail closed).
 */
async function enqueueInitialRequest(booking, input, opts = {}) {
  const { enqueueSms } = require('./sms-outbox');
  const env = opts.env || process.env;
  const nowMs = ms(opts.now) ?? Date.now();
  const prisma = prismaClient(opts.prisma);
  try {
    return await withReviewLock(prisma, bookingIdOf(booking), async (tx) => {
      const rows = await loadReviewRowsForBooking(bookingIdOf(booking), { prisma: tx });
      const own = rows.find((row) => row.idempotencyKey === input.idempotencyKey);
      if (own) return { ok: true, queued: true, idempotent: true, outbox: own };
      const decision = initialEligibility(booking, rows, { now: nowMs, env });
      if (!decision.ok) return { ok: true, queued: false, skipped: true, reason: decision.reason };
      return enqueueSms(input, { prisma: tx, env });
    });
  } catch (err) {
    console.warn('[review-lifecycle] initial_lock_failed', String(err && err.message || err).slice(0, 80));
    return { ok: true, queued: false, skipped: true, reason: 'review_ledger_unavailable' };
  }
}

async function enqueueFollowUp(booking, kind, opts = {}) {
  const env = opts.env || process.env;
  const nowMs = ms(opts.now) ?? Date.now();
  const bookingId = bookingIdOf(booking);
  const url = reviewUrl();
  if (!url) return { ok: true, queued: false, reason: 'review_url_unavailable' };
  const idempotencyKey = reminderIdempotencyKey(bookingId, kind);
  if (!idempotencyKey) return { ok: false, error: 'invalid_idempotency_key' };
  const { enqueueSms } = require('./sms-outbox');
  const prisma = prismaClient(opts.prisma);

  const result = await withReviewLock(prisma, bookingId, async (tx) => {
    const rows = await loadReviewRowsForBooking(bookingId, { prisma: tx });
    const own = rows.find((row) => row.idempotencyKey === idempotencyKey);
    if (own) {
      return kind === 'manual'
        ? { ok: true, queued: false, reason: 'manual_resend_already_used' }
        : { ok: true, queued: true, idempotent: true, outbox: own };
    }
    let decision = followUpEligibility(booking, rows, { kind, now: nowMs, env });
    let availableAt = new Date(nowMs);
    if (!decision.ok && !decision.terminal) {
      availableAt = decision.retryAt;
      decision = followUpEligibility(booking, rows, { kind, now: availableAt.getTime(), env });
    }
    if (!decision.ok) return { ok: true, queued: false, reason: decision.reason };
    const queued = await enqueueSms({
      idempotencyKey,
      audience: 'customer',
      customerAccountId: booking.customerAccountId || null,
      bookingId,
      booking,
      toE164: normalizeUsPhoneE164(booking.phone || booking.customerPhone || ''),
      templateKey: FOLLOWUP_TEMPLATE,
      templateData: { reviewUrl: url },
      availableAt,
      maxAttempts: 5,
    }, { prisma: tx, env });
    return { ...queued, availableAt };
  });

  if (!result.ok) return { ok: false, error: result.error || 'sms_outbox_failed' };
  if (!result.queued) return { ok: true, queued: false, reason: result.reason || 'not_queued' };
  const outboxId = result.outbox?.id || null;
  const dueNow = result.availableAt && result.availableAt.getTime() <= nowMs;
  if (outboxId && !result.idempotent && dueNow && opts.kick !== false) {
    try {
      const { kickSmsOutboxByIds } = require('./sms-outbox');
      await kickSmsOutboxByIds([outboxId], { prisma: opts.prisma, env, now: new Date(nowMs) });
    } catch (err) {
      console.warn('[review-lifecycle] kick_failed', String(err && err.message || err).slice(0, 80));
    }
  }
  return {
    ok: true,
    queued: true,
    idempotent: !!result.idempotent,
    outboxId,
    scheduledFor: iso(result.outbox?.availableAt || result.availableAt),
  };
}

/** After an initial ask is accepted: schedule the single automatic reminder, or nothing. Never throws. */
async function scheduleAutomaticReminder(booking, opts = {}) {
  try {
    const env = opts.env || process.env;
    if (!reviewFlags(env).automationEnabled) return { ok: true, queued: false, reason: 'automation_disabled' };
    const nowMs = ms(opts.now) ?? Date.now();
    const completedAt = completionMs(booking);
    if (completedAt == null) return { ok: true, queued: false, reason: 'not_completed' };
    if (nowMs - completedAt > LIVE_COMPLETION_MS) return { ok: true, queued: false, reason: 'historical_completion' };
    return await enqueueFollowUp(booking, 'auto', { ...opts, kick: false });
  } catch (err) {
    console.warn('[review-lifecycle] schedule_failed', String(err && err.message || err).slice(0, 80));
    return { ok: true, queued: false, reason: 'schedule_failed' };
  }
}

/** Owner resend from Admin. Fails closed when the ledger or lock is unavailable. */
async function manualResend(booking, opts = {}) {
  try {
    return await enqueueFollowUp(booking, 'manual', opts);
  } catch {
    return { ok: false, error: 'sms_outbox_unavailable', statusCode: 503 };
  }
}

/** Cancel follow-ups not yet with Twilio. A row leased right now is caught by its dispatch check. */
async function cancelPendingFollowUps(bookingId, reason, opts = {}) {
  const prisma = prismaClient(opts.prisma);
  if (!prisma?.smsOutbox || typeof prisma.smsOutbox.updateMany !== 'function') {
    return { ok: false, error: 'sms_outbox_unavailable' };
  }
  const now = opts.now ? new Date(opts.now) : new Date();
  const code = `${CANCEL_PREFIX}${String(reason || 'stopped').replace(/[^a-z_]/g, '').slice(0, 30)}`;
  const result = await prisma.smsOutbox.updateMany({
    where: {
      bookingId: String(bookingId || '').trim(),
      templateKey: { in: [FOLLOWUP_TEMPLATE, TEMPLATE_KEYS.REVIEW_REQUESTED] },
      status: 'accepted',
      providerMessageSid: null,
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
    },
    data: { status: 'failed', failedAt: now, lastErrorCode: code, leaseToken: null, leaseExpiresAt: null },
  });
  return { ok: true, cancelled: Number(result?.count) || 0 };
}

// ---------------------------------------------------------------------------
// Dispatch gate (worker, after claiming a row, under the booking lock)

async function loadBookingStrong(bookingId, opts = {}) {
  if (typeof opts.loadBooking === 'function') return opts.loadBooking(bookingId);
  const { getBookingRecord } = require('./booking-repository');
  const rec = await getBookingRecord(bookingId, { requireStrong: true });
  return rec && rec.booking;
}

async function accountConsentDecision(booking, row, prisma) {
  const { assertCustomerSmsConsent } = require('./sms-consent-service');
  const consent = await assertCustomerSmsConsent({
    customerAccountId: booking.customerAccountId || null,
    toE164: row.toE164,
    booking,
  }, { prisma });
  if (consent.ok) return null;
  if (consent.reason === 'suppression_unavailable') return { retry: true };
  return { reason: String(consent.reason || 'consent').slice(0, 30) };
}

/**
 * Pure-ish decision for one claimed review row, given the locked view.
 * Returns:
 *   { action: 'send' }
 *   { action: 'cancel', code }                      (solicitation-only rows)
 *   { action: 'strip_review_link', code }            (completion text: send the receipt only)
 *   { action: 'defer', availableAt, countsAttempt, code }
 */
async function decideDispatch(row, tx, opts) {
  const env = opts.env || process.env;
  const nowMs = ms(opts.now) ?? Date.now();
  const kind = rowKind(row);
  const bookingId = String(row.bookingId || '').trim();
  const receiptRow = row.templateKey === TEMPLATE_KEYS.SERVICE_COMPLETED;
  if (kind === 'completion_receipt_only' || !bookingId) return { action: 'send' };

  const failClosed = (code) => (receiptRow
    ? { action: 'strip_review_link', code }
    : { action: 'defer', availableAt: new Date(nowMs + GATE_RETRY_MS), countsAttempt: true, code });

  let booking;
  let rows;
  try {
    booking = await loadBookingStrong(bookingId, opts);
    rows = await loadReviewRowsForBooking(bookingId, { prisma: tx });
  } catch {
    return failClosed('review_gate_unavailable');
  }
  if (!booking) return receiptRow ? { action: 'strip_review_link', code: 'booking_not_found' } : { action: 'cancel', code: `${CANCEL_PREFIX}booking_not_found` };

  const others = rows.filter((other) => other.id !== row.id);
  const blocking = others.find((other) => isSolicitationKind(rowKind(other)) && inFlight(other, nowMs));
  if (blocking) {
    // Another solicitation is being sent right now. A receipt never waits on a
    // review ask: it goes without the link. A pure ask looks again shortly.
    if (receiptRow) return { action: 'strip_review_link', code: 'review_in_flight' };
    return { action: 'defer', availableAt: new Date(nowMs + IN_FLIGHT_RETRY_MS), countsAttempt: false, code: 'review_in_flight' };
  }

  let decision;
  if (isInitialKind(kind)) {
    decision = initialEligibility(booking, rows, {
      now: nowMs,
      env,
      excludeId: row.id,
      before: { acceptedAtMs: ms(row.acceptedAt) ?? nowMs, id: row.id },
    });
  } else {
    decision = followUpEligibility(booking, rows, {
      kind: kind === 'manual_resend' ? 'manual' : 'auto',
      now: nowMs,
      env,
      excludeId: row.id,
    });
  }
  if (!decision.ok) {
    if (receiptRow) return { action: 'strip_review_link', code: decision.reason };
    if (decision.terminal) return { action: 'cancel', code: `${CANCEL_PREFIX}${decision.reason}` };
    return { action: 'defer', availableAt: decision.retryAt, countsAttempt: false, code: decision.reason };
  }

  try {
    const consent = await accountConsentDecision(booking, row, tx);
    if (consent && consent.retry) return failClosed('review_gate_unavailable');
    if (consent) {
      // The receipt keeps today's path (the worker's suppression check still applies).
      return receiptRow
        ? { action: 'strip_review_link', code: consent.reason }
        : { action: 'cancel', code: `${CANCEL_PREFIX}${consent.reason}` };
    }
  } catch {
    return failClosed('review_gate_unavailable');
  }
  return { action: 'send' };
}

/**
 * Worker entry point. Runs the decision and its row update under the booking
 * lock, so two workers holding two review rows for one booking cannot both
 * pass. The row being sent keeps its lease, which makes it "in flight" for the
 * other one.
 */
async function applyDispatchDecision(row, opts = {}) {
  const prisma = opts.prisma;
  const now = opts.now ? new Date(opts.now) : new Date();
  const { payloadHash } = require('./sms-outbox');
  return withReviewLock(prisma, row.bookingId, async (tx) => {
    const decision = await decideDispatch(row, tx, { ...opts, now });
    if (decision.action === 'send') return { decision, row };
    if (decision.action === 'strip_review_link') {
      const templateData = { ...(row.templateData || {}), reviewUrl: '' };
      const fingerprint = payloadHash({
        audience: row.audience || 'customer',
        bookingId: row.bookingId || null,
        customerAccountId: row.customerAccountId || null,
        toE164: row.toE164,
        templateKey: row.templateKey,
        templateVersion: row.templateVersion,
        templateData,
      });
      const updated = await tx.smsOutbox.update({
        where: { id: row.id },
        data: { templateData, payloadHash: fingerprint },
      });
      return { decision, row: { ...row, ...updated, templateData } };
    }
    if (decision.action === 'cancel') {
      const outbox = await tx.smsOutbox.update({
        where: { id: row.id },
        data: { status: 'failed', lastErrorCode: decision.code, failedAt: now, leaseToken: null, leaseExpiresAt: null },
      });
      return { decision, outbox };
    }
    const attempts = Math.max(0, Number(row.attemptCount) || 0);
    if (decision.countsAttempt && attempts >= (Number(row.maxAttempts) || 5)) {
      const outbox = await tx.smsOutbox.update({
        where: { id: row.id },
        data: {
          status: 'failed',
          lastErrorCode: `${CANCEL_PREFIX}gate_unavailable`,
          failedAt: now,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      return { decision: { action: 'cancel', code: `${CANCEL_PREFIX}gate_unavailable` }, outbox };
    }
    const outbox = await tx.smsOutbox.update({
      where: { id: row.id },
      data: {
        status: 'accepted',
        availableAt: decision.availableAt,
        leaseToken: null,
        leaseExpiresAt: null,
        // Waiting for the window, cooldown or another in-flight ask is not a failed attempt.
        attemptCount: decision.countsAttempt ? attempts : Math.max(0, attempts - 1),
        lastErrorCode: decision.countsAttempt ? decision.code : null,
      },
    });
    return { decision, outbox };
  });
}

// ---------------------------------------------------------------------------
// Admin view

function messageView(row, now) {
  return {
    kind: rowKind(row),
    stage: rowStage(row, now),
    acceptedAt: iso(row.acceptedAt),
    scheduledFor: iso(row.availableAt),
    providerSubmitted: !!row.providerMessageSid,
    providerStatus: row.providerStatus ? String(row.providerStatus).slice(0, 24) : null,
    sentAt: iso(row.sentAt),
    deliveredAt: iso(row.deliveredAt),
    failedAt: iso(row.failedAt),
    errorCode: row.lastErrorCode ? String(row.lastErrorCode).slice(0, 48) : null,
  };
}

const STAGE_TO_STATE = {
  queued: 'queued',
  retry_scheduled: 'queued',
  submitted: 'sent',
  sent: 'sent',
  delivered: 'delivered',
  failed: 'failed',
  ambiguous: 'failed',
};

/** One booking's lifecycle for Admin. `optedOut`: true / false / null (unknown). */
function reviewLifecycleView(booking, rows, { now = Date.now(), env = process.env, optedOut = null, ledgerAvailable = true } = {}) {
  const nowMs = ms(now) ?? Date.now();
  const list = rows || [];
  const markers = ownerMarkers(booking);
  const completedAt = completionMs(booking);
  const messages = list.map((row) => messageView(row, nowMs));
  const solicitations = list.filter((row) => isSolicitationKind(rowKind(row)));
  const pendingFollowUp = list.find((row) => row.templateKey === FOLLOWUP_TEMPLATE
    && ['scheduled', 'queued', 'retry_scheduled'].includes(rowStage(row, nowMs)));

  let state = 'not_requested';
  if (!ledgerAvailable) state = 'unknown';
  else if (reviewAlreadyReceived(booking)) state = 'review_received';
  else if (markers.stoppedAt) state = 'stopped';
  else if (optedOut === true || messages.some((m) => m.stage === 'opted_out')) state = 'opted_out';
  else if (pendingFollowUp && rowStage(pendingFollowUp, nowMs) === 'scheduled') state = 'reminder_scheduled';
  else if (completedAt != null && nowMs - completedAt > EXPIRY_MS && solicitations.length) state = 'expired';
  else {
    const latest = [...solicitations].reverse().find((row) => rowStage(row, nowMs) !== 'cancelled');
    if (latest) state = STAGE_TO_STATE[rowStage(latest, nowMs)] || 'queued';
  }

  const flags = reviewFlags(env);
  const eligibility = ledgerAvailable
    ? followUpEligibility(booking, list, { kind: 'manual', now: nowMs, env })
    : { ok: false, reason: 'sms_outbox_unavailable', terminal: true };
  const manualUsed = list.some((row) => rowKind(row) === 'manual_resend');
  return {
    bookingId: bookingIdOf(booking),
    state,
    completedAt: completedAt != null ? new Date(completedAt).toISOString() : null,
    expiresAt: completedAt != null ? new Date(completedAt + EXPIRY_MS).toISOString() : null,
    receivedAt: markers.receivedAt,
    stoppedAt: markers.stoppedAt,
    optedOut,
    solicitationsUsed: slotCounts(list).total,
    solicitationsMax: MAX_TOTAL,
    messages,
    resend: {
      enabled: flags.manualResendEnabled,
      allowed: !manualUsed && (eligibility.ok || eligibility.terminal === false),
      reason: manualUsed ? 'manual_resend_already_used' : (eligibility.ok ? null : eligibility.reason),
      earliestAt: eligibility.ok ? new Date(nowMs).toISOString() : iso(eligibility.retryAt),
    },
  };
}

module.exports = {
  REMINDER_DELAY_MS,
  COOLDOWN_MS,
  EXPIRY_MS,
  LIVE_COMPLETION_MS,
  MAX_AUTOMATIC,
  MAX_TOTAL,
  SEND_WINDOW,
  CANCEL_PREFIX,
  REVIEW_GATED_TEMPLATE_KEYS,
  SOLICITATION_TEMPLATE_KEYS,
  reviewFlags,
  programBlockers,
  bookingConsentCoversReviews,
  solicitationCompliance,
  isWithinSendWindow,
  nextSendWindowStart,
  withReviewLock,
  reminderIdempotencyKey,
  loadReviewRows,
  loadReviewRowsForBooking,
  rowKind,
  rowStage,
  consumesSlot,
  slotCounts,
  initialEligibility,
  followUpEligibility,
  enqueueCompletionNotice,
  enqueueInitialRequest,
  scheduleAutomaticReminder,
  manualResend,
  cancelPendingFollowUps,
  applyDispatchDecision,
  reviewLifecycleView,
  ownerMarkers,
};
