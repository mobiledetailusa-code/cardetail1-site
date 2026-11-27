'use strict';

/**
 * Review request lifecycle: one ledger, three gates, no second notification system.
 *
 * Ledger. The PostgreSQL SmsOutbox is the only record of what was asked. A
 * solicitation is any customer row whose template asks for a review:
 *   - booking.review_requested         (initial, unpaid completion path)
 *   - booking.service_completed        (initial, only when it carries the review link)
 *   - booking.review_reminder ...:auto   (automatic reminder, at most one)
 *   - booking.review_reminder ...:manual (owner resend, at most one)
 * Unique idempotency keys make each slot single-use, so worker retries, double
 * clicks and the four completion paths cannot create a second row for a slot.
 *
 * Owner markers. "Review received" and "Stop" live on the booking aggregate
 * (booking.reviewRequest) because they are owner decisions about the job.
 *
 * Gates. Every follow-up send needs all of:
 *   1. its switch (REVIEW_REMINDER_AUTOMATION_ENABLED or REVIEW_MANUAL_RESEND_ENABLED);
 *   2. REVIEW_SOLICITATION_A2P_CAMPAIGN_VERIFIED=true, set only after the owner has
 *      confirmed the registered Twilio campaign covers review requests;
 *   3. the booking's consent text version listed in
 *      REVIEW_SOLICITATION_CONSENT_VERSIONS. Transactional consent is NOT assumed
 *      to cover review requests; the list is empty by default.
 * Eligibility is evaluated when the row is created and again by the worker right
 * before dispatch. The dispatch check fails closed for follow-ups.
 *
 * Nothing here detects Google reviews. "Received" is either a first-party review
 * on the booking or the owner's explicit mark.
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
// A reminder is scheduled only from a live completion. A completion older than
// this is historical and never gets one, which blocks retroactive mass sends.
const LIVE_COMPLETION_MS = 6 * HOUR_MS;
const MAX_AUTOMATIC = 2;
const MAX_TOTAL = 3;

const SEND_WINDOW = Object.freeze({
  timeZone: 'America/New_York',
  startHour: 10,
  endHour: 18, // exclusive: the last send starts before 18:00
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
// Templates the worker re-checks right before dispatch.
const REVIEW_GATED_TEMPLATE_KEYS = new Set([
  TEMPLATE_KEYS.REVIEW_REQUESTED,
  TEMPLATE_KEYS.REVIEW_REMINDER,
]);

// ---------------------------------------------------------------------------
// Flags and compliance

function listEnv(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
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

/** Compliance blockers that apply to every follow-up, independent of the booking. */
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

// ---------------------------------------------------------------------------
// Send window (America/New_York, Monday..Saturday, 10:00-18:00)

const windowFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: SEND_WINDOW.timeZone,
  weekday: 'short',
  hour: 'numeric',
  hourCycle: 'h23',
});
const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function windowParts(at) {
  const parts = windowFormatter.formatToParts(new Date(at));
  const weekday = WEEKDAY[parts.find((p) => p.type === 'weekday')?.value];
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  return { weekday, hour };
}

function isWithinSendWindow(at) {
  const { weekday, hour } = windowParts(at);
  return SEND_WINDOW.days.includes(weekday)
    && hour >= SEND_WINDOW.startHour
    && hour < SEND_WINDOW.endHour;
}

/** Earliest instant >= at that is inside the window (15-minute resolution). */
function nextSendWindowStart(at) {
  const start = new Date(at).getTime();
  if (!Number.isFinite(start)) return null;
  if (isWithinSendWindow(start)) return new Date(start);
  const step = 15 * 60 * 1000;
  let t = Math.ceil(start / step) * step;
  for (let i = 0; i < 8 * 96; i += 1, t += step) {
    if (isWithinSendWindow(t)) return new Date(t);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ledger reads

function prismaClient(override) {
  if (override) return override;
  const { tryGetPrisma } = require('./prisma');
  return tryGetPrisma();
}

function bookingIdOf(booking) {
  return String(booking && (booking.id || booking.bookingId) || '').trim();
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

/**
 * Review-related outbox rows for some bookings. Throws when the ledger is
 * unavailable; callers decide whether to fail open or closed.
 */
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
    const reviewUrl = String(row.templateData?.reviewUrl || '');
    return reviewUrl ? 'completion_with_review_link' : 'completion_receipt_only';
  }
  if (key === TEMPLATE_KEYS.REVIEW_REMINDER) {
    return /:manual$/.test(String(row.idempotencyKey || '')) ? 'manual_resend' : 'automatic_reminder';
  }
  return 'other';
}

function isSolicitationKind(kind) {
  return kind === 'initial_request'
    || kind === 'completion_with_review_link'
    || kind === 'automatic_reminder'
    || kind === 'manual_resend';
}

function isAutomaticKind(kind) {
  return kind === 'initial_request' || kind === 'completion_with_review_link' || kind === 'automatic_reminder';
}

/**
 * Delivery stage, from what the ledger actually records. "submitted" means
 * Twilio accepted the request (we hold a Message SID); "sent" and "delivered"
 * come only from Twilio's own status values. Nothing is inferred.
 */
function rowStage(row, now = Date.now()) {
  const code = String(row.lastErrorCode || '');
  const status = String(row.status || '');
  if (status === 'delivered') return 'delivered';
  if (status === 'sent') return 'sent';
  if (status === 'failed') {
    if (code.startsWith(CANCEL_PREFIX)) return 'cancelled';
    if (code === 'superseded') return 'cancelled';
    if (code === 'suppressed') return 'opted_out';
    return 'failed';
  }
  if (row.providerMessageSid) return 'submitted';
  const available = ms(row.availableAt);
  if (available != null && available > now) {
    return code ? 'retry_scheduled' : 'scheduled';
  }
  return 'queued';
}

/** A row consumes a solicitation slot unless it ended before reaching Twilio. */
function consumesSlot(row, now = Date.now()) {
  const stage = rowStage(row, now);
  if (stage === 'cancelled' || stage === 'opted_out') return !!row.providerMessageSid;
  if (stage === 'failed') return !!row.providerMessageSid;
  return true;
}

function reachedProvider(row) {
  return !!row.providerMessageSid
    || ['sent', 'delivered'].includes(String(row.status || ''));
}

function lastSolicitationAtMs(rows, { excludeId } = {}) {
  let last = null;
  for (const row of rows) {
    if (row.id === excludeId) continue;
    if (!isSolicitationKind(rowKind(row)) || !reachedProvider(row)) continue;
    const t = ms(row.sentAt) ?? ms(row.acceptedAt);
    if (t != null && (last == null || t > last)) last = t;
  }
  return last;
}

function slotCounts(rows, now = Date.now(), { excludeId } = {}) {
  let automatic = 0;
  let total = 0;
  for (const row of rows) {
    if (row.id === excludeId) continue;
    const kind = rowKind(row);
    if (!isSolicitationKind(kind) || !consumesSlot(row, now)) continue;
    total += 1;
    if (isAutomaticKind(kind)) automatic += 1;
  }
  return { automatic, total };
}

function hasInitialSolicitation(rows, now = Date.now(), { excludeId } = {}) {
  return rows.some((row) => row.id !== excludeId
    && (rowKind(row) === 'initial_request' || rowKind(row) === 'completion_with_review_link')
    && consumesSlot(row, now));
}

// ---------------------------------------------------------------------------
// Booking state

function ownerMarkers(booking) {
  const rr = booking && booking.reviewRequest && typeof booking.reviewRequest === 'object'
    ? booking.reviewRequest
    : {};
  return {
    receivedAt: rr.receivedAt || null,
    stoppedAt: rr.stoppedAt || null,
    stopReason: rr.stopReason || null,
  };
}

function completionMs(booking) {
  const state = postServiceState(booking || {});
  return state.completed ? ms(state.completedAt || booking.completedAt || booking.techCompletedAt) : null;
}

function reviewAlreadyReceived(booking) {
  const markers = ownerMarkers(booking);
  if (markers.receivedAt) return true;
  const state = postServiceState(booking || {});
  return !!(state.review && state.review.submitted);
}

function disputed(booking) {
  const js = String(booking?.jobStatus || '').toLowerCase();
  const svc = String(booking?.serviceStatus || '').toLowerCase();
  return js === 'issue_reported' || svc === 'disputed';
}

/**
 * Whether a follow-up solicitation of this kind may go out now.
 * Returns { ok } or { ok:false, reason, terminal, retryAt }.
 *  - terminal: the slot can never be used (cancel the row)
 *  - retryAt:  try again at this instant (cooldown, 48 h delay, send window)
 */
function followUpEligibility(booking, rows, { kind = 'auto', now = Date.now(), env = process.env, excludeId } = {}) {
  const flags = reviewFlags(env);
  const nowMs = ms(now) ?? Date.now();
  const terminal = (reason) => ({ ok: false, reason, terminal: true });

  if (kind === 'manual' ? !flags.manualResendEnabled : !flags.automationEnabled) {
    return terminal(kind === 'manual' ? 'manual_resend_disabled' : 'automation_disabled');
  }
  const blockers = programBlockers(env);
  if (blockers.length) return terminal(blockers[0]);
  if (!booking) return terminal('booking_not_found');
  if (!bookingSmsConsentGranted(booking)) return terminal('booking_sms_consent_required');
  if (!bookingConsentCoversReviews(booking, env)) return terminal('consent_version_not_covered');
  if (!normalizeUsPhoneE164(booking.phone || booking.customerPhone || '')) return terminal('invalid_sms_recipient');

  const completedAt = completionMs(booking);
  if (completedAt == null) return terminal('not_completed');
  if (disputed(booking)) return terminal('service_issue_open');
  const markers = ownerMarkers(booking);
  if (markers.stoppedAt) return terminal('stopped');
  if (reviewAlreadyReceived(booking)) return terminal('review_received');
  if (nowMs - completedAt > EXPIRY_MS) return terminal('expired');

  const counts = slotCounts(rows, nowMs, { excludeId });
  if (counts.total >= MAX_TOTAL) return terminal('total_cap_reached');
  if (kind !== 'manual' && counts.automatic >= MAX_AUTOMATIC) return terminal('automatic_cap_reached');
  if (!hasInitialSolicitation(rows, nowMs, { excludeId })) return terminal('no_initial_request');

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
  if (slot.getTime() > nowMs) {
    return { ok: false, reason, terminal: false, retryAt: slot };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Scheduling (automatic) and resend (manual)

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

async function enqueueFollowUp(booking, rows, kind, opts = {}) {
  const env = opts.env || process.env;
  const nowMs = ms(opts.now) ?? Date.now();
  const bookingId = bookingIdOf(booking);
  const url = reviewUrl();
  if (!url) return { ok: true, queued: false, reason: 'review_url_unavailable' };
  const idempotencyKey = reminderIdempotencyKey(bookingId, kind);
  if (!idempotencyKey) return { ok: false, error: 'invalid_idempotency_key' };

  // Eligibility as of the first moment this slot could be used.
  let decision = followUpEligibility(booking, rows, { kind, now: nowMs, env });
  let availableAt = new Date(nowMs);
  if (!decision.ok && !decision.terminal) {
    availableAt = decision.retryAt;
    decision = followUpEligibility(booking, rows, { kind, now: availableAt.getTime(), env });
  }
  if (!decision.ok) return { ok: true, queued: false, reason: decision.reason };

  const { enqueueSms, kickSmsOutboxByIds } = require('./sms-outbox');
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
  }, { prisma: opts.prisma, env });
  if (!queued.ok) return { ok: false, error: queued.error || 'sms_outbox_failed' };
  if (!queued.queued) return { ok: true, queued: false, reason: queued.reason || 'not_queued' };
  const outboxId = queued.outbox?.id || null;
  if (outboxId && !queued.idempotent && availableAt.getTime() <= nowMs && opts.kick !== false) {
    try {
      await kickSmsOutboxByIds([outboxId], { prisma: opts.prisma, env, now: new Date(nowMs) });
    } catch (err) {
      console.warn('[review-lifecycle] kick_failed', String(err && err.message || err).slice(0, 80));
    }
  }
  return {
    ok: true,
    queued: true,
    idempotent: !!queued.idempotent,
    outboxId,
    scheduledFor: iso(queued.outbox?.availableAt || availableAt),
  };
}

/**
 * Called right after an initial solicitation is accepted by the outbox. It
 * schedules the single automatic reminder, or does nothing. Never throws.
 */
async function scheduleAutomaticReminder(booking, opts = {}) {
  try {
    const env = opts.env || process.env;
    if (!reviewFlags(env).automationEnabled) return { ok: true, queued: false, reason: 'automation_disabled' };
    const nowMs = ms(opts.now) ?? Date.now();
    const completedAt = completionMs(booking);
    if (completedAt == null) return { ok: true, queued: false, reason: 'not_completed' };
    if (nowMs - completedAt > LIVE_COMPLETION_MS) {
      return { ok: true, queued: false, reason: 'historical_completion' };
    }
    const rows = await loadReviewRowsForBooking(bookingIdOf(booking), opts);
    return await enqueueFollowUp(booking, rows, 'auto', { ...opts, kick: false });
  } catch (err) {
    console.warn('[review-lifecycle] schedule_failed', String(err && err.message || err).slice(0, 80));
    return { ok: true, queued: false, reason: 'schedule_failed' };
  }
}

/** Owner resend from Admin. The ledger must be readable; it fails closed. */
async function manualResend(booking, opts = {}) {
  let rows;
  try {
    rows = await loadReviewRowsForBooking(bookingIdOf(booking), opts);
  } catch {
    return { ok: false, error: 'sms_outbox_unavailable', statusCode: 503 };
  }
  const existing = rows.find((row) => rowKind(row) === 'manual_resend');
  if (existing) return { ok: true, queued: false, reason: 'manual_resend_already_used' };
  return enqueueFollowUp(booking, rows, 'manual', opts);
}

/**
 * Cancel follow-ups that have not reached Twilio. A row the worker holds
 * right now is caught by the dispatch check, which re-reads the booking.
 */
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
      templateKey: FOLLOWUP_TEMPLATE,
      status: 'accepted',
      providerMessageSid: null,
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
    },
    data: {
      status: 'failed',
      failedAt: now,
      lastErrorCode: code,
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  return { ok: true, cancelled: Number(result?.count) || 0 };
}

// ---------------------------------------------------------------------------
// Initial-request de-duplication across completion paths

/**
 * For booking.review_requested: skip it when the paid completion text already
 * asked (or will ask) for a review. Fail-open: a ledger outage keeps today's
 * behaviour.
 */
async function initialRequestAlreadyMade(booking, opts = {}) {
  if (ownerMarkers(booking).stoppedAt || ownerMarkers(booking).receivedAt) return true;
  try {
    const rows = await loadReviewRowsForBooking(bookingIdOf(booking), opts);
    const nowMs = ms(opts.now) ?? Date.now();
    return rows.some((row) => rowKind(row) === 'completion_with_review_link' && consumesSlot(row, nowMs));
  } catch {
    return false;
  }
}

/**
 * Review link for booking.service_completed. The receipt always goes; the
 * review link is dropped when a review request already went, the review was
 * received, or the owner stopped requests. An existing row keeps its payload
 * so the idempotency key stays valid.
 */
async function completionNoticeReviewUrl(booking, defaultUrl, opts = {}) {
  if (!defaultUrl) return '';
  const markers = ownerMarkers(booking);
  if (markers.stoppedAt || reviewAlreadyReceived(booking)) return '';
  try {
    const rows = await loadReviewRowsForBooking(bookingIdOf(booking), opts);
    const own = rows.find((row) => row.templateKey === TEMPLATE_KEYS.SERVICE_COMPLETED);
    if (own) return String(own.templateData?.reviewUrl || '');
    const nowMs = ms(opts.now) ?? Date.now();
    if (rows.some((row) => rowKind(row) === 'initial_request' && consumesSlot(row, nowMs))) return '';
  } catch {
    /* ledger unavailable: keep today's behaviour */
  }
  return defaultUrl;
}

// ---------------------------------------------------------------------------
// Dispatch gate (called by the outbox worker after claiming a row)

async function loadBookingStrong(bookingId, opts = {}) {
  if (typeof opts.loadBooking === 'function') return opts.loadBooking(bookingId);
  const { getBookingRecord } = require('./booking-repository');
  const rec = await getBookingRecord(bookingId, { requireStrong: true });
  return rec && rec.booking;
}

/**
 * Decide what the worker does with a claimed review row:
 *   { action: 'send' }
 *   { action: 'cancel', code }
 *   { action: 'defer', availableAt, countsAttempt }
 * Follow-ups fail closed. The initial request keeps today's fail-open
 * behaviour on a lookup failure, and is cancelled only as a proven duplicate.
 */
async function reviewDispatchDecision(row, opts = {}) {
  const env = opts.env || process.env;
  const nowMs = ms(opts.now) ?? Date.now();
  const bookingId = String(row?.bookingId || '').trim();
  const followUp = row?.templateKey === FOLLOWUP_TEMPLATE;
  if (!followUp) {
    if (row?.templateKey !== TEMPLATE_KEYS.REVIEW_REQUESTED || !bookingId) return { action: 'send' };
    try {
      const rows = await loadReviewRowsForBooking(bookingId, opts);
      if (hasInitialSolicitation(rows, nowMs, { excludeId: row.id })) {
        return { action: 'cancel', code: `${CANCEL_PREFIX}duplicate_initial` };
      }
      const booking = await loadBookingStrong(bookingId, opts);
      if (booking && (ownerMarkers(booking).stoppedAt || ownerMarkers(booking).receivedAt)) {
        return { action: 'cancel', code: `${CANCEL_PREFIX}${ownerMarkers(booking).stoppedAt ? 'stopped' : 'review_received'}` };
      }
    } catch {
      /* fail-open for the existing initial request */
    }
    return { action: 'send' };
  }

  const kind = /:manual$/.test(String(row.idempotencyKey || '')) ? 'manual' : 'auto';
  let booking;
  let rows;
  try {
    booking = await loadBookingStrong(bookingId, opts);
    rows = await loadReviewRowsForBooking(bookingId, opts);
  } catch {
    return { action: 'defer', availableAt: new Date(nowMs + 10 * 60 * 1000), countsAttempt: true, code: 'review_gate_unavailable' };
  }
  if (!booking) return { action: 'cancel', code: `${CANCEL_PREFIX}booking_not_found` };

  const decision = followUpEligibility(booking, rows, { kind, now: nowMs, env, excludeId: row.id });
  if (!decision.ok) {
    if (decision.terminal) return { action: 'cancel', code: `${CANCEL_PREFIX}${decision.reason}` };
    return { action: 'defer', availableAt: decision.retryAt, countsAttempt: false, code: decision.reason };
  }

  // Account-level consent (portal revocation) and STOP are re-checked here.
  try {
    const { assertCustomerSmsConsent } = require('./sms-consent-service');
    const consent = await assertCustomerSmsConsent({
      customerAccountId: booking.customerAccountId || null,
      toE164: row.toE164,
      booking,
    }, { prisma: opts.prisma });
    if (!consent.ok) {
      if (consent.reason === 'suppression_unavailable') {
        return { action: 'defer', availableAt: new Date(nowMs + 10 * 60 * 1000), countsAttempt: true, code: 'review_gate_unavailable' };
      }
      return { action: 'cancel', code: `${CANCEL_PREFIX}${String(consent.reason || 'consent').slice(0, 30)}` };
    }
  } catch {
    return { action: 'defer', availableAt: new Date(nowMs + 10 * 60 * 1000), countsAttempt: true, code: 'review_gate_unavailable' };
  }
  return { action: 'send' };
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
};

/**
 * One booking's review lifecycle, for Admin. `optedOut` is true / false / null
 * (null = suppression could not be read; shown as unknown, never as "ok").
 */
function reviewLifecycleView(booking, rows, { now = Date.now(), env = process.env, optedOut = null, ledgerAvailable = true } = {}) {
  const nowMs = ms(now) ?? Date.now();
  const markers = ownerMarkers(booking);
  const completedAt = completionMs(booking);
  const messages = (rows || []).map((row) => messageView(row, nowMs));
  const solicitations = (rows || []).filter((row) => isSolicitationKind(rowKind(row)));
  const counts = slotCounts(rows || [], nowMs);
  const pendingFollowUp = (rows || []).find((row) => row.templateKey === FOLLOWUP_TEMPLATE
    && ['scheduled', 'queued', 'retry_scheduled'].includes(rowStage(row, nowMs)));

  let state = 'not_requested';
  if (!ledgerAvailable) state = 'unknown';
  else if (markers.receivedAt || reviewAlreadyReceived(booking)) state = 'review_received';
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
    ? followUpEligibility(booking, rows || [], { kind: 'manual', now: nowMs, env })
    : { ok: false, reason: 'sms_outbox_unavailable', terminal: true };
  const manualUsed = (rows || []).some((row) => rowKind(row) === 'manual_resend');
  return {
    bookingId: bookingIdOf(booking),
    state,
    completedAt: completedAt != null ? new Date(completedAt).toISOString() : null,
    expiresAt: completedAt != null ? new Date(completedAt + EXPIRY_MS).toISOString() : null,
    receivedAt: markers.receivedAt,
    stoppedAt: markers.stoppedAt,
    optedOut,
    solicitationsUsed: counts.total,
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
  isWithinSendWindow,
  nextSendWindowStart,
  reminderIdempotencyKey,
  loadReviewRows,
  loadReviewRowsForBooking,
  rowKind,
  rowStage,
  slotCounts,
  followUpEligibility,
  scheduleAutomaticReminder,
  manualResend,
  cancelPendingFollowUps,
  initialRequestAlreadyMade,
  completionNoticeReviewUrl,
  reviewDispatchDecision,
  reviewLifecycleView,
  ownerMarkers,
};
