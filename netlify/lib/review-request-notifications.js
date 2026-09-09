'use strict';

/**
 * Post-service first-party review request over Twilio SMS.
 *
 * A completed job with transactional SMS consent can receive one review SMS.
 * When the destination matches the account verified phone, the SMS carries a
 * purpose-scoped /reviews?t= token (not a full /a?t= portal link). Otherwise
 * the SMS points at the public reviews / My Garage lookup page.
 *
 * Appointment access tokens are never superseded by this path.
 */

const { enabled, smsOutboxPolicy } = require('./twilio-runtime-policy');
const { enqueueSms, kickSmsOutboxByIds, smsSafeIdempotencyKey } = require('./sms-outbox');
const { TEMPLATE_KEYS } = require('./sms-templates');
const { bookingSmsConsentGranted } = require('./sms-program');
const { normalizeUsPhoneE164 } = require('./phone-auth');
const { postServiceState } = require('./post-service-experience');
const { loadAccountVerifiedPhoneE164 } = require('./sms-consent-service');
const { getBooking } = require('./ops-db');
const {
  createAppointmentAccessToken,
  loadTokenRecord,
  consumeReviewInviteToken,
  buildReviewUrl,
  PURPOSE_REVIEW_REQUEST,
  REVIEW_TOKEN_TTL_MS,
} = require('./appointment-access-token');

function customerTransactionalSmsEnabled(env = process.env) {
  return enabled(env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED) && smsOutboxPolicy(env).ok;
}

function publicReviewsUrl() {
  const { trustedSiteOrigin } = require('./trusted-site-origin');
  return `${trustedSiteOrigin()}/reviews`;
}

function publicGarageUrl() {
  const { trustedSiteOrigin } = require('./trusted-site-origin');
  return `${trustedSiteOrigin()}/my-garage`;
}

function shouldAskForReview(booking) {
  if (!booking) return false;
  const js = String(booking.jobStatus || '').toLowerCase();
  const svc = String(booking.serviceStatus || '').toLowerCase();
  if (js === 'issue_reported' || svc === 'disputed') return false;
  const state = postServiceState(booking);
  return !!(state.completed && state.review && state.review.available);
}

function reviewInvitePublicView(booking, extras = {}) {
  const first = String(booking && booking.firstName || '').trim().slice(0, 80);
  const { serviceLabel, locationLabel, formatMonthYear } = require('./first-party-reviews');
  return {
    ok: true,
    available: extras.available === true,
    submitted: extras.submitted === true,
    firstName: first || 'there',
    service: serviceLabel(booking || {}),
    location: locationLabel(booking || {}),
    date: formatMonthYear(booking && (booking.completedAt || booking.confirmedDate || booking.preferredDate)) || '',
  };
}

async function authorizeReviewInviteToken(rawToken, { allowConsumed = false } = {}) {
  const loaded = await loadTokenRecord(rawToken, {
    expectedPurpose: PURPOSE_REVIEW_REQUEST,
    allowConsumed,
    allowExpired: false,
  });
  if (!loaded.ok) {
    const expired = loaded.error === 'expired_token';
    return {
      ok: false,
      error: loaded.error || 'invalid_token',
      message: expired
        ? 'This review link has expired. Look up your booking in My Garage.'
        : 'This review link is not valid.',
      statusCode: 401,
    };
  }
  const bookingId = String(loaded.record.bookingId || '').trim();
  const booking = bookingId ? await getBooking(bookingId) : null;
  if (!booking) {
    return {
      ok: false,
      error: 'booking_not_found',
      message: 'We could not find this appointment.',
      statusCode: 404,
    };
  }
  return {
    ok: true,
    booking,
    record: loaded.record,
    consumed: !!loaded.consumed,
  };
}

async function resolveReviewInvite(rawToken) {
  const auth = await authorizeReviewInviteToken(rawToken, { allowConsumed: true });
  if (!auth.ok) return auth;
  const state = postServiceState(auth.booking);
  if (state.review && state.review.submitted) {
    return reviewInvitePublicView(auth.booking, { available: false, submitted: true });
  }
  if (auth.consumed) {
    return {
      ok: false,
      error: 'consumed_token',
      message: 'This review link was already used.',
      statusCode: 401,
    };
  }
  if (!state.completed || !(state.review && state.review.available)) {
    return reviewInvitePublicView(auth.booking, { available: false, submitted: false });
  }
  return reviewInvitePublicView(auth.booking, { available: true, submitted: false });
}

async function mintReviewInviteUrl(booking, opts = {}) {
  const bookingId = String(booking.id || booking.bookingId || '').trim();
  if (!bookingId) return '';
  try {
    const access = await createAppointmentAccessToken({
      bookingId,
      customerAccountId: booking.customerAccountId || null,
      email: booking.email,
      phoneDigits: String(booking.phone || booking.customerPhone || '').replace(/\D/g, '').slice(-10) || null,
      eventType: TEMPLATE_KEYS.REVIEW_REQUESTED,
      purpose: PURPOSE_REVIEW_REQUEST,
      ttlMs: REVIEW_TOKEN_TTL_MS,
      supersede: false,
      event: opts.event || null,
    });
    return buildReviewUrl(access.token, opts.event);
  } catch (err) {
    console.warn('[review-sms] token_unavailable', String(err && err.message || err).slice(0, 80));
    return '';
  }
}

async function notifyReviewRequested(booking, opts = {}) {
  if (!shouldAskForReview(booking)) {
    return { ok: true, skipped: true, reason: 'review_not_available' };
  }
  const env = opts.env || process.env;
  if (!customerTransactionalSmsEnabled(env)) {
    return { ok: true, skipped: true, reason: 'customer_sms_not_enabled' };
  }
  if (!bookingSmsConsentGranted(booking)) {
    return { ok: true, skipped: true, reason: 'booking_sms_consent_required' };
  }

  const dest = normalizeUsPhoneE164(booking.phone || booking.customerPhone || '');
  if (!dest) return { ok: true, skipped: true, reason: 'invalid_sms_recipient' };

  const bookingId = String(booking.id || booking.bookingId || '').trim();
  const idempotencyKey = smsSafeIdempotencyKey(`booking.review_requested:${bookingId}`);
  if (!idempotencyKey) return { ok: false, error: 'invalid_idempotency_key' };

  const verifiedPhoneE164 = opts.verifiedPhoneE164 !== undefined
    ? opts.verifiedPhoneE164
    : await loadAccountVerifiedPhoneE164(booking.customerAccountId, { prisma: opts.prisma });
  const accessAuthorized = !!(normalizeUsPhoneE164(verifiedPhoneE164 || '') === dest);

  let url = publicGarageUrl();
  if (accessAuthorized) {
    const minted = await mintReviewInviteUrl(booking, opts);
    if (minted) url = minted;
    else url = publicReviewsUrl();
  } else {
    url = publicReviewsUrl();
  }

  const queued = await enqueueSms({
    idempotencyKey,
    audience: 'customer',
    customerAccountId: booking.customerAccountId || null,
    bookingId,
    booking,
    toE164: dest,
    templateKey: TEMPLATE_KEYS.REVIEW_REQUESTED,
    templateData: { url },
  }, { prisma: opts.prisma, env });

  if (!queued.ok) return { ok: false, error: queued.error || 'sms_outbox_failed' };
  if (!queued.queued) return { ok: true, skipped: true, reason: queued.reason || 'sms_not_queued' };

  const outboxId = queued.outbox?.id || null;
  if (outboxId) {
    try {
      await kickSmsOutboxByIds([outboxId], { prisma: opts.prisma, env });
    } catch (err) {
      console.warn('[review-sms] kick_failed', String(err && err.message || err).slice(0, 80));
    }
  }

  return {
    ok: true,
    queued: true,
    outboxId,
    accessLinkIncluded: accessAuthorized && /\/reviews\?t=/.test(url),
    templateKey: TEMPLATE_KEYS.REVIEW_REQUESTED,
  };
}

function notifyReviewRequestedQuietly(booking, opts = {}) {
  return notifyReviewRequested(booking, opts).catch((err) => {
    console.warn('[review-sms] notify_failed', String(err && err.message || err).slice(0, 80));
    return { ok: true, skipped: true, reason: 'notify_failed' };
  });
}

module.exports = {
  PURPOSE_REVIEW_REQUEST,
  shouldAskForReview,
  authorizeReviewInviteToken,
  resolveReviewInvite,
  consumeReviewInviteToken,
  notifyReviewRequested,
  notifyReviewRequestedQuietly,
  publicReviewsUrl,
  publicGarageUrl,
  customerTransactionalSmsEnabled,
};
