// Transactional booking notifications — request_received / confirmed / action_required.
// Delivery is decoupled from booking persistence and idempotent per channel.

'use strict';

const crypto = require('crypto');
// Shared with the booking pages so Review, confirmation and email itemize
// a multi-vehicle booking identically.
const lineItems = require('../../assets/booking-line-items.js');
const {
  createAppointmentAccessToken,
  ensureAppointmentPublicRef,
  buildAccessUrl,
  ACCESS_TOKEN_TTL_MS,
} = require('./appointment-access-token');
const {
  customerFacingStatusLabel,
  isActionRequiredState,
  actionRequiredStateKey,
} = require('./booking-customer-status');
const { normalizeUsPhoneDigits, normalizeUsPhoneE164 } = require('./phone-auth');
const { smsOutboxPolicy, enabled } = require('./twilio-runtime-policy');
const { enqueueSms } = require('./sms-outbox');
const { renderSmsTemplate, bookingTemplateData } = require('./sms-templates');

const EVENT_REQUEST_RECEIVED = 'booking.request_received';
const EVENT_CONFIRMED = 'booking.confirmed';
const EVENT_ACTION_REQUIRED = 'booking.customer_action_required';
const EVENT_PAYMENT_RECEIVED = 'booking.payment_received';

const CHANNELS = ['email', 'sms'];
const CLAIM_STORE = 'cd1-notification-claims';

let claimStoreFactoryOverride = null;

function setNotificationClaimStoreFactory(factory) {
  claimStoreFactoryOverride = typeof factory === 'function' ? factory : null;
}

function resetNotificationClaimStoreFactory() {
  claimStoreFactoryOverride = null;
}

async function resolveClaimStore() {
  if (typeof claimStoreFactoryOverride === 'function') {
    return claimStoreFactoryOverride(CLAIM_STORE);
  }
  const { blobsStore } = require('./tech-security');
  return blobsStore(CLAIM_STORE);
}

function claimKeyFor(idempotencyKeyValue) {
  return `claim_${crypto.createHash('sha256').update(String(idempotencyKeyValue)).digest('hex').slice(0, 32)}`;
}

function writeWasApplied(result) {
  if (result == null) return true;
  return result.modified !== false;
}

/**
 * Atomically claim a notification channel send (Blob onlyIfNew / CAS).
 * Prevents duplicate provider calls when concurrent emitters share a stateKey.
 */
async function claimChannelSend(idempotencyKeyValue) {
  const store = await resolveClaimStore();
  const claimKey = claimKeyFor(idempotencyKeyValue);
  const now = new Date().toISOString();

  let existing = null;
  let etag = null;
  if (typeof store.getWithMetadata === 'function') {
    const read = await store.getWithMetadata(claimKey, {
      type: 'json',
      consistency: 'strong',
    }).catch(() => null);
    if (read && read.data) {
      existing = read.data;
      etag = read.etag || null;
    }
  } else {
    existing = await store.get(claimKey, { type: 'json' }).catch(() => null);
    etag = existing?.__etag || null;
  }

  if (existing && (existing.status === 'sent' || existing.status === 'suppressed')) {
    return { claimed: false, reason: existing.status, claimKey };
  }

  if (existing && existing.status === 'pending') {
    const ageMs = Date.now() - new Date(existing.at || 0).getTime();
    // Fresh in-flight claim — another worker owns the send.
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 60_000) {
      return { claimed: false, reason: 'pending', claimKey };
    }
    // Stale pending (crashed worker) — reclaim via CAS when etag available.
    if (etag) {
      const next = { key: idempotencyKeyValue, status: 'pending', at: now, retry: true };
      const writeResult = await store.setJSON(claimKey, next, { onlyIfMatch: etag });
      return { claimed: writeWasApplied(writeResult), reason: 'stale_pending_reclaim', claimKey };
    }
    return { claimed: false, reason: 'pending', claimKey };
  }

  if (existing && existing.status === 'failed' && etag) {
    const next = { key: idempotencyKeyValue, status: 'pending', at: now, retry: true };
    const writeResult = await store.setJSON(claimKey, next, { onlyIfMatch: etag });
    return { claimed: writeWasApplied(writeResult), reason: 'retry_claim', claimKey };
  }

  const writeResult = await store.setJSON(claimKey, {
    key: idempotencyKeyValue,
    status: 'pending',
    at: now,
  }, { onlyIfNew: true });
  return { claimed: writeWasApplied(writeResult), reason: 'new_claim', claimKey };
}

async function completeChannelClaim(claimKey, status) {
  if (!claimKey) return;
  try {
    const store = await resolveClaimStore();
    await store.setJSON(claimKey, {
      status,
      at: new Date().toISOString(),
    });
  } catch {
    // Claim completion is best-effort; ledger remains authoritative for retries.
  }
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function brandName() {
  return 'Detailing Zone';
}

function siteUrl(_event) {
  const { trustedSiteOrigin } = require('./trusted-site-origin');
  return trustedSiteOrigin();
}

function vehicleDescription(booking) {
  const vehicles = Array.isArray(booking.vehicles) ? booking.vehicles : [];
  if (vehicles.length) {
    return vehicles.map((v) => {
      const label = [v.year, v.make || v.vehicleMake, v.model || v.vehicleModel]
        .filter(Boolean).join(' ').trim();
      return label || v.vehicleLabel || v.label || '';
    }).filter(Boolean).join('; ') || 'Vehicle on file';
  }
  return booking.vehicleLabel || booking.vehicle || booking.vehicleCategory || 'Vehicle on file';
}

function serviceDescription(booking) {
  return booking.package || booking.service || booking.serviceLabel || 'Detailing service';
}

/**
 * Per-vehicle itemization for multi-vehicle bookings, from the same shared
 * projection the Review & Submit and confirmation screens use — so a booking
 * never reaches the customer showing one vehicle and a combined package price.
 *
 * Returns null for single-vehicle bookings, which keep their existing copy.
 */
function serviceItemization(booking) {
  const { items } = lineItems.projectBooking(booking);
  if (items.length <= 1) return null;
  return {
    items,
    text: [
      `Vehicles on this booking: ${items.length}`,
      '',
      ...lineItems.summaryTextLines(items),
    ],
    html: `<p><strong>Vehicles on this booking: ${items.length}</strong></p>\n${lineItems.summaryEmailHtml(items)}`,
  };
}

function approvedTotalLabel(booking) {
  const cents = booking.approvedCents != null
    ? Number(booking.approvedCents)
    : Math.round(Number(booking.approvedFinalAmount != null
      ? booking.approvedFinalAmount
      : (booking.totalPrice || 0)) * 100);
  if (!Number.isFinite(cents) || cents <= 0) return null;
  return `$${(cents / 100).toFixed(2)}`;
}

function arrivalWindow(booking) {
  return booking.confirmedTimeWindow
    || booking.confirmedWindow
    || booking.confirmedTime
    || booking.preferredTime
    || '';
}

/** Fields reserved for future Twilio / scheduling messages (not always SMS-emitted). */
function schedulingMessageFields(booking) {
  const b = booking || {};
  let site = null;
  try {
    site = require('./site-access').siteAccessForMessaging(b);
  } catch (_) {
    site = null;
  }
  let flexLabel = 'Exact date only';
  try {
    flexLabel = require('./schedule-flexibility').scheduleFlexibilityLabel(b.scheduleFlexibility);
  } catch (_) { /* */ }
  let preferredArrivalWindowLabel = '';
  let alternateArrivalWindowLabel = '';
  let confirmedTimeWindowLabel = '';
  try {
    const { arrivalWindowLabel } = require('./arrival-windows');
    preferredArrivalWindowLabel = arrivalWindowLabel(b.preferredArrivalWindow);
    alternateArrivalWindowLabel = arrivalWindowLabel(b.alternateArrivalWindow);
  } catch (_) { /* */ }
  confirmedTimeWindowLabel = arrivalWindow(b);
  return {
    preferredDate: b.preferredDate || '',
    preferredTime: b.preferredTime || '',
    preferredArrivalWindow: b.preferredArrivalWindow || '',
    preferredArrivalWindowLabel,
    alternatePreferredDate: b.alternatePreferredDate || null,
    alternateArrivalWindow: b.alternateArrivalWindow || null,
    alternateArrivalWindowLabel,
    confirmedDate: b.confirmedDate || '',
    confirmedTimeWindowLabel,
    arrivalWindow: arrivalWindow(b),
    scheduleFlexibility: b.scheduleFlexibility || 'exact',
    scheduleFlexibilityLabel: flexLabel,
    notes: b.notes || b.customerNote || '',
    siteAccess: site,
  };
}

function eventStateKey(eventType, booking) {
  if (eventType === EVENT_REQUEST_RECEIVED) {
    // Stable for the finalize transition — not a request-time timestamp.
    return `received:${booking.finalizedAt || booking.createdAt || '1'}`;
  }
  if (eventType === EVENT_CONFIRMED) {
    // Prefer the CAS-authored confirmationEventId / confirmedAt written once
    // by the winning confirmBookingTransition. Never invent a new timestamp here.
    if (booking.confirmationEventId) {
      return String(booking.confirmationEventId);
    }
    if (booking.confirmedAt) {
      return `confirmed:${booking.id || booking.bookingId}:${booking.confirmedAt}`;
    }
    return 'confirmed:missing_identity';
  }
  if (eventType === EVENT_ACTION_REQUIRED) {
    return actionRequiredStateKey(booking) || `action:v${booking.bookingVersion || 1}`;
  }
  if (eventType === EVENT_PAYMENT_RECEIVED) {
    // Keyed to the settlement itself, so a retried Admin click, a webhook replay
    // and a Blob/Postgres double-write all resolve to one email — while a second,
    // genuinely different payment still gets its own.
    const p = booking.__paymentEvent || {};
    const settlementRef = String(p.settlementId || p.entryId || p.providerEventId || '').trim();
    if (settlementRef) return `payment:${settlementRef}`;
    return `payment:${p.method || 'unknown'}:${p.amountCents || 0}:${p.settledCentsAfter || 0}`;
  }
  return `v${booking.bookingVersion || 1}`;
}

function idempotencyKey(bookingId, eventType, stateKey, channel) {
  return `${bookingId}:${eventType}:${stateKey}:${channel}`;
}

/**
 * Resend is a distinct logical event from the original booking notification.
 * The generation is server-authoritative so a terminal request_received ledger
 * entry can never suppress a legitimate resend.
 */
function resendIdempotencyKey(bookingId, resendGeneration, channel) {
  return `appointment_access.resend:${bookingId}:${resendGeneration}:${channel}`;
}

function normalizeResendGeneration(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function getNotificationLedger(booking) {
  const ledger = booking?.transactionalNotifications;
  return ledger && typeof ledger === 'object' ? { ...ledger } : {};
}

function channelAlreadySent(ledger, key) {
  const entry = ledger[key];
  return entry && (entry.status === 'accepted' || entry.status === 'sent' || entry.status === 'delivered');
}

function channelTerminal(ledger, key) {
  const entry = ledger[key];
  // accepted/sent/delivered/suppressed are terminal for enqueue idempotency.
  // failed remains retryable.
  return entry && (
    entry.status === 'accepted'
    || entry.status === 'sent'
    || entry.status === 'delivered'
    || entry.status === 'suppressed'
  );
}

function markChannelResult(ledger, key, result) {
  const now = new Date().toISOString();
  const next = { ...ledger };
  if (result && (result.accepted === true || result.queued === true)) {
    next[key] = { status: 'accepted', at: now, reason: null, outboxId: result.outboxId || null };
  } else if (result && result.sent === true) {
    next[key] = { status: 'sent', at: now, reason: null, providerId: result.providerId || null };
  } else if (result && result.skipped) {
    next[key] = { status: 'suppressed', at: now, reason: result.reason || 'skipped' };
  } else {
    next[key] = {
      status: 'failed',
      at: now,
      reason: (result && result.reason) || 'send_failed',
      retryable: true,
    };
  }
  return next;
}

function customerTransactionalSmsEnabled() {
  return enabled(process.env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED)
    && smsOutboxPolicy(process.env).ok;
}

function resendEmailConfigured() {
  return !!String(process.env.RESEND_API_KEY || '').trim();
}

function buildEmailContent(eventType, booking, accessUrl) {
  const name = [booking.firstName, booking.lastName].filter(Boolean).join(' ').trim() || 'there';
  const first = escapeHtml(name.split(/\s+/)[0] || 'there');
  const safeName = escapeHtml(name);
  const service = escapeHtml(serviceDescription(booking));
  const vehicle = escapeHtml(vehicleDescription(booking));
  const date = escapeHtml(booking.confirmedDate || booking.preferredDate || '—');
  const window = escapeHtml(arrivalWindow(booking) || '—');
  const total = approvedTotalLabel(booking);
  const status = escapeHtml(customerFacingStatusLabel(booking));
  const link = escapeHtml(accessUrl);
  const brand = escapeHtml(brandName());
  const itemization = serviceItemization(booking);

  if (eventType === EVENT_REQUEST_RECEIVED) {
    const subject = 'We received your detailing request';
    const cta = 'View Booking Status';
    const text = [
      `Hi ${name.split(/\s+/)[0] || 'there'},`,
      '',
      `We received your booking request. It is currently under review.`,
      'This is not yet a confirmed appointment.',
      '',
      ...(itemization ? itemization.text : [
        `Requested service: ${serviceDescription(booking)}`,
        `Vehicle: ${vehicleDescription(booking)}`,
      ]),
      '',
      `Preferred date: ${booking.preferredDate || '—'}`,
      '',
      `${cta}:`,
      accessUrl,
      '',
      'This secure link opens your Customer Portal appointment.',
      '',
      brandName(),
      siteUrl(),
    ].join('\n');
    const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.5;color:#111;max-width:560px;margin:0 auto;padding:20px">
<p>Hi ${first},</p>
<p>We received your booking request. It is currently under review.</p>
<p><strong>This is not yet a confirmed appointment.</strong></p>
${itemization ? itemization.html : ''}
<ul>
${itemization ? '' : `<li>Service: ${service}</li>
<li>Vehicle: ${vehicle}</li>
`}<li>Preferred date: ${escapeHtml(booking.preferredDate || '—')}</li>
<li>Status: ${status}</li>
</ul>
<p><a href="${link}" style="display:inline-block;background:#0b3d2e;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px">${escapeHtml(cta)}</a></p>
<p style="font-size:13px;color:#555">If the button does not work, open:<br>${link}</p>
<p>${brand}</p>
</body></html>`;
    return { subject, text, html, cta };
  }

  if (eventType === EVENT_CONFIRMED) {
    const subject = 'Your detailing appointment is confirmed';
    const cta = 'View Confirmed Appointment';
    const textLines = [
      `Hi ${name.split(/\s+/)[0] || 'there'},`,
      '',
      'Your appointment is confirmed.',
      '',
      `Date: ${booking.confirmedDate || booking.preferredDate || '—'}`,
      `Arrival window: ${arrivalWindow(booking) || '—'}`,
      ...(itemization ? ['', ...itemization.text, ''] : [
        `Vehicle: ${vehicleDescription(booking)}`,
        `Service: ${serviceDescription(booking)}`,
      ]),
    ];
    if (total) textLines.push(`Approved total: ${total}`);
    textLines.push('', `${cta}:`, accessUrl, '', brandName(), siteUrl());
    const text = textLines.join('\n');
    const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.5;color:#111;max-width:560px;margin:0 auto;padding:20px">
<p>Hi ${first},</p>
<p><strong>Your appointment is confirmed.</strong></p>
<ul>
<li>Date: ${date}</li>
<li>Arrival window: ${window}</li>
${itemization ? '' : `<li>Vehicle: ${vehicle}</li>
<li>Service: ${service}</li>
`}${total ? `<li>Approved total: ${escapeHtml(total)}</li>` : ''}
</ul>
${itemization ? itemization.html : ''}
<p><a href="${link}" style="display:inline-block;background:#0b3d2e;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px">${escapeHtml(cta)}</a></p>
<p style="font-size:13px;color:#555">If the button does not work, open:<br>${link}</p>
<p>${brand}</p>
</body></html>`;
    return { subject, text, html, cta };
  }

  if (eventType === EVENT_PAYMENT_RECEIVED) {
    return buildPaymentReceivedEmail(booking, accessUrl);
  }

  // customer_action_required
  const subject = 'Action needed for your detailing appointment';
  const cta = 'Review Appointment';
  const text = [
    `Hi ${name.split(/\s+/)[0] || 'there'},`,
    '',
    'Action is needed for your detailing appointment.',
    `Current status: ${customerFacingStatusLabel(booking)}`,
    '',
    `${cta}:`,
    accessUrl,
    '',
    brandName(),
    siteUrl(),
  ].join('\n');
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.5;color:#111;max-width:560px;margin:0 auto;padding:20px">
<p>Hi ${first},</p>
<p>Action is needed for your detailing appointment.</p>
<p>Current status: <strong>${status}</strong></p>
<p>Hi ${safeName}, please review your appointment for any required payment, schedule confirmation, or missing information.</p>
<p><a href="${link}" style="display:inline-block;background:#0b3d2e;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px">${escapeHtml(cta)}</a></p>
<p style="font-size:13px;color:#555">If the button does not work, open:<br>${link}</p>
<p>${brand}</p>
</body></html>`;
  return { subject, text, html, cta };
}

const PAYMENT_METHOD_LABELS = Object.freeze({
  cash: 'Cash',
  card: 'Card',
  card_on_site: 'Card',
  online: 'Card',
  stripe: 'Card',
});

function money(cents) {
  return `$${(Math.max(0, Math.round(Number(cents) || 0)) / 100).toFixed(2)}`;
}

/**
 * Payment confirmation. Strictly transactional: what was received, against what
 * total, what is left, and where the receipt is. No offers, no upsell, no
 * "while you're here" — a receipt email that sells is not a receipt.
 */
function buildPaymentReceivedEmail(booking, accessUrl) {
  const p = (booking && booking.__paymentEvent) || {};
  const name = [booking.firstName, booking.lastName].filter(Boolean).join(' ').trim() || 'there';
  const first = name.split(/\s+/)[0] || 'there';
  const brand = brandName();
  const reference = String(booking.id || booking.bookingId || '');
  const methodKey = String(p.method || '').toLowerCase();
  const methodLabel = PAYMENT_METHOD_LABELS[methodKey] || 'Card';
  const amount = money(p.amountCents);
  const total = money(p.approvedCents);
  const remaining = money(p.remainingCents);
  const recordedAt = String(p.recordedAt || new Date().toISOString()).slice(0, 10);
  const receiptUrl = String(p.receiptUrl || '').trim();
  const fullyPaid = Math.max(0, Math.round(Number(p.remainingCents) || 0)) === 0;
  const thanks = 'Thank you for choosing Detailing Zone.';

  const subject = 'Payment received for your Detailing Zone appointment';
  const cta = 'View your appointment';

  const textLines = [
    `Hi ${first},`,
    '',
    `We have recorded your payment for booking ${reference}.`,
    '',
    `Booking reference: ${reference}`,
    `Amount received: ${amount}`,
    `Payment method: ${methodLabel}`,
    `Total: ${total}`,
    `Remaining balance: ${remaining}`,
    `Date recorded: ${recordedAt}`,
  ];
  if (!fullyPaid) {
    textLines.push('', `A balance of ${remaining} is still outstanding on this appointment.`);
  }
  if (receiptUrl) textLines.push('', `Receipt: ${receiptUrl}`);
  if (accessUrl) textLines.push('', `${cta}:`, accessUrl);
  textLines.push('', thanks, brand, siteUrl());

  const link = escapeHtml(accessUrl || '');
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.5;color:#111;max-width:560px;margin:0 auto;padding:20px">
<p>Hi ${escapeHtml(first)},</p>
<p><strong>We have recorded your payment.</strong></p>
<ul>
<li>Booking reference: ${escapeHtml(reference)}</li>
<li>Amount received: ${escapeHtml(amount)}</li>
<li>Payment method: ${escapeHtml(methodLabel)}</li>
<li>Total: ${escapeHtml(total)}</li>
<li>Remaining balance: ${escapeHtml(remaining)}</li>
<li>Date recorded: ${escapeHtml(recordedAt)}</li>
</ul>
${fullyPaid ? '' : `<p>A balance of ${escapeHtml(remaining)} is still outstanding on this appointment.</p>`}
${receiptUrl ? `<p><a href="${escapeHtml(receiptUrl)}">View your receipt</a></p>` : ''}
${accessUrl ? `<p><a href="${link}" style="display:inline-block;background:#0b3d2e;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px">${escapeHtml(cta)}</a></p>
<p style="font-size:13px;color:#555">If the button does not work, open:<br>${link}</p>` : ''}
<p>${escapeHtml(thanks)}</p>
<p>${escapeHtml(brand)}</p>
</body></html>`;

  return { subject, text: textLines.join('\n'), html, cta };
}

function buildSmsBody(eventType, booking, accessUrl) {
  const rendered = renderSmsTemplate(eventType, bookingTemplateData(eventType, booking, accessUrl));
  return rendered.ok ? rendered.body : '';
}

async function sendResendEmail({ to, subject, text, html }) {
  const { RESEND_API_KEY, RESEND_FROM, ADMIN_EMAIL } = process.env;
  if (!RESEND_API_KEY) return { sent: false, skipped: true, reason: 'email_not_configured' };
  if (!to) return { sent: false, skipped: true, reason: 'no_customer_email' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: RESEND_FROM || 'Cardetail1 <onboarding@resend.dev>',
        to: [to],
        subject,
        text,
        html,
        reply_to: ADMIN_EMAIL || undefined,
      }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      return { sent: false, reason: `resend_${res.status}`, detail: String(err).slice(0, 120) };
    }
    const body = await res.json().catch(() => ({}));
    return { sent: true, providerId: body.id || null };
  } catch (e) {
    return { sent: false, reason: 'email_send_error', detail: e.message };
  }
}

async function sendCustomerSms(toE164, _body, metadata = {}) {
  if (!customerTransactionalSmsEnabled()) {
    return { sent: false, skipped: true, reason: 'customer_sms_not_enabled' };
  }
  if (!toE164) return { sent: false, skipped: true, reason: 'no_customer_phone' };
  const queued = await enqueueSms({
    idempotencyKey: metadata.idempotencyKey,
    audience: 'customer',
    customerAccountId: metadata.customerAccountId,
    bookingId: metadata.bookingId,
    toE164,
    templateKey: metadata.eventType,
    templateData: bookingTemplateData(metadata.eventType, metadata.booking, metadata.accessUrl),
  });
  if (!queued.ok) return { sent: false, reason: queued.error || 'sms_outbox_failed' };
  if (!queued.queued) return { sent: false, skipped: true, reason: queued.reason || 'sms_not_queued' };
  return {
    sent: false,
    accepted: true,
    queued: true,
    idempotent: !!queued.idempotent,
    outboxId: queued.outbox?.id || null,
  };
}

async function resolveCustomerAccountForBooking(booking, opts = {}) {
  try {
    const { resolveOrCreateCustomerAccount, linkBookingToAccount } = require('./customer-account-service');
    const resolution = await resolveOrCreateCustomerAccount({
      verifiedEmail: booking.email,
      email: booking.email,
      verifiedPhone: booking.phone || booking.customerPhone,
      phone: booking.phone || booking.customerPhone,
      bookingIds: [booking.id || booking.bookingId].filter(Boolean),
      stripeCustomerId: booking.stripeCustomerId || null,
    }, {
      allowPhoneOnly: false,
      createIfMissing: true,
      trustSessionAccountId: false,
      acceptBrowserAccountId: false,
      allowNonTransactional: opts.allowNonTransactional === true,
      prisma: opts.prisma,
    });
    if (!resolution.ok || !resolution.customerAccountId) {
      return { customerAccountId: booking.customerAccountId || null, resolution };
    }
    const bookingId = booking.id || booking.bookingId;
    if (bookingId) {
      const { tryGetPrisma } = require('./prisma');
      const prisma = opts.prisma || tryGetPrisma();
      if (prisma) {
        await linkBookingToAccount(prisma, {
          bookingId,
          customerAccountId: resolution.customerAccountId,
        }).catch(() => null);
      }
    }
    return { customerAccountId: resolution.customerAccountId, resolution };
  } catch {
    return { customerAccountId: booking.customerAccountId || null, resolution: null };
  }
}

/**
 * Emit a transactional notification event. Never throws into the booking write path.
 * Returns { booking, delivery, skipped, accessToken } — caller should persist booking patch.
 */
async function emitBookingNotification(booking, eventType, opts = {}) {
  const correlationId = `ntf_${crypto.randomBytes(6).toString('hex')}`;
  try {
    if (!booking || !(booking.id || booking.bookingId)) {
      return { ok: false, error: 'booking_required', correlationId };
    }
    if (
      eventType !== EVENT_REQUEST_RECEIVED
      && eventType !== EVENT_CONFIRMED
      && eventType !== EVENT_ACTION_REQUIRED
      && eventType !== EVENT_PAYMENT_RECEIVED
    ) {
      return { ok: false, error: 'unknown_event', correlationId };
    }

    if (eventType === EVENT_ACTION_REQUIRED && !isActionRequiredState(booking)) {
      return { ok: true, skipped: true, reason: 'not_actionable', correlationId, booking };
    }

    // Guard: never describe pending review as confirmed.
    if (eventType === EVENT_CONFIRMED) {
      const appt = String(booking.appointmentStatus || '').toLowerCase();
      const js = String(booking.jobStatus || '').toLowerCase();
      const st = String(booking.status || '').toLowerCase();
      if (!(appt === 'confirmed' || js === 'confirmed' || st === 'confirmed')) {
        return { ok: false, error: 'not_confirmed', correlationId, booking };
      }
    }

    let working = { ...booking };
    const refResult = await ensureAppointmentPublicRef(working);
    working = refResult.booking;

    const account = await resolveCustomerAccountForBooking(working, opts);
    if (account.customerAccountId) {
      working = { ...working, customerAccountId: account.customerAccountId };
    }

    const resendGeneration = normalizeResendGeneration(opts.resendGeneration);
    const stateKey = resendGeneration
      ? `resend:${resendGeneration}`
      : eventStateKey(eventType, working);
    const bookingId = working.id || working.bookingId;
    let ledger = getNotificationLedger(working);

    const emailKey = resendGeneration
      ? resendIdempotencyKey(bookingId, resendGeneration, 'email')
      : idempotencyKey(bookingId, eventType, stateKey, 'email');
    const smsKey = resendGeneration
      ? resendIdempotencyKey(bookingId, resendGeneration, 'sms')
      : idempotencyKey(bookingId, eventType, stateKey, 'sms');
    const emailDone = channelAlreadySent(ledger, emailKey);
    const smsDone = channelAlreadySent(ledger, smsKey);
    const emailTerminal = channelTerminal(ledger, emailKey);
    const smsTerminal = channelTerminal(ledger, smsKey);

    if (emailTerminal && smsTerminal) {
      return {
        ok: true,
        skipped: true,
        reason: 'already_sent',
        correlationId,
        booking: { ...working, transactionalNotifications: ledger },
        delivery: { email: ledger[emailKey], sms: ledger[smsKey] },
      };
    }

    const phoneDigits = normalizeUsPhoneDigits(working.phone || working.customerPhone || '');
    // Do not revoke an already-emailed link when only retrying a failed SMS channel.
    const supersede = !(emailDone || smsDone);
    const access = await createAppointmentAccessToken({
      bookingId,
      customerAccountId: working.customerAccountId || null,
      email: working.email,
      phoneDigits: phoneDigits || null,
      eventType,
      ttlMs: ACCESS_TOKEN_TTL_MS,
      supersede,
      event: opts.event || null,
    });

    const accessUrl = access.accessUrl || buildAccessUrl(access.token, opts.event);
    const emailContent = buildEmailContent(eventType, working, accessUrl);
    const smsBody = buildSmsBody(eventType, working, accessUrl);

    const delivery = { email: null, sms: null, accessTokenExpiresAt: access.expiresAt };

    if (!emailTerminal) {
      const emailClaim = await claimChannelSend(emailKey);
      if (!emailClaim.claimed) {
        delivery.email = { sent: true, skipped: true, reason: 'claim_' + (emailClaim.reason || 'held') };
        // Do not overwrite a terminal ledger entry from a losing racer.
        if (!channelTerminal(ledger, emailKey)) {
          ledger = markChannelResult(ledger, emailKey, { skipped: true, reason: 'claim_held' });
        }
      } else if (!resendEmailConfigured()) {
        delivery.email = { sent: false, skipped: true, reason: 'email_not_configured' };
        ledger = markChannelResult(ledger, emailKey, delivery.email);
        await completeChannelClaim(emailClaim.claimKey, 'suppressed');
      } else {
        delivery.email = await sendResendEmail({
          to: working.email,
          subject: emailContent.subject,
          text: emailContent.text,
          html: emailContent.html,
        });
        ledger = markChannelResult(ledger, emailKey, delivery.email);
        await completeChannelClaim(
          emailClaim.claimKey,
          delivery.email.sent ? 'sent' : (delivery.email.skipped ? 'suppressed' : 'failed')
        );
      }
    } else {
      delivery.email = emailDone
        ? { sent: true, skipped: true, reason: 'already_sent' }
        : { sent: false, skipped: true, reason: ledger[emailKey]?.reason || 'suppressed' };
    }

    if (eventType === EVENT_PAYMENT_RECEIVED) {
      // Payment confirmation is email-only: an SMS here would spend Twilio credit
      // on a message the receipt already carries in full.
      delivery.sms = { sent: false, skipped: true, reason: 'sms_not_enabled_for_event' };
      ledger = markChannelResult(ledger, smsKey, delivery.sms);
    } else if (!smsTerminal) {
      const e164 = normalizeUsPhoneE164(working.phone || working.customerPhone || '');
      delivery.sms = await sendCustomerSms(e164, smsBody, {
        idempotencyKey: smsKey,
        customerAccountId: working.customerAccountId || null,
        bookingId,
        eventType,
        booking: working,
        accessUrl,
      });
      ledger = markChannelResult(ledger, smsKey, delivery.sms);
    } else {
      delivery.sms = smsDone
        ? { sent: true, skipped: true, reason: 'already_sent' }
        : { sent: false, skipped: true, reason: ledger[smsKey]?.reason || 'suppressed' };
    }

    // Never log raw tokens, emails, or phones.
    console.log('[txn-notify]', {
      eventType,
      bookingIdPrefix: String(bookingId).slice(0, 12),
      correlationId,
      resendGeneration: resendGeneration || null,
      emailStatus: ledger[emailKey]?.status || null,
      smsStatus: ledger[smsKey]?.status || null,
    });

    const nextBooking = {
      ...working,
      transactionalNotifications: ledger,
      lastTransactionalNotificationAt: new Date().toISOString(),
      lastTransactionalNotificationEvent: eventType,
    };
    // Per-emit context is an argument, not booking state — never persist it.
    delete nextBooking.__paymentEvent;

    return {
      ok: true,
      correlationId,
      eventType,
      stateKey,
      resendGeneration: resendGeneration || null,
      accessToken: access.token,
      accessUrl,
      focusRef: working.appointmentPublicRef || null,
      delivery,
      booking: nextBooking,
    };
  } catch (e) {
    console.warn('[txn-notify] unexpected', { correlationId, error: e.message });
    return { ok: false, error: 'notify_failed', correlationId, booking };
  }
}

async function emitRequestReceived(booking, opts) {
  return emitBookingNotification(booking, EVENT_REQUEST_RECEIVED, opts);
}

async function emitConfirmed(booking, opts) {
  return emitBookingNotification(booking, EVENT_CONFIRMED, opts);
}

async function emitCustomerActionRequired(booking, opts) {
  return emitBookingNotification(booking, EVENT_ACTION_REQUIRED, opts);
}

/**
 * Payment confirmation for a recorded settlement.
 *
 * `payment` describes the settlement that just happened — it is passed through
 * as emit context and is never written to the booking. Delivery failure is
 * reported, not thrown: the money is already recorded and must not be unwound
 * because an email bounced.
 */
async function emitPaymentReceived(booking, payment = {}, opts = {}) {
  const result = await emitBookingNotification(
    { ...booking, __paymentEvent: payment },
    EVENT_PAYMENT_RECEIVED,
    opts
  );
  // Strip on every path, including the early returns and the failure path — the
  // caller persists this booking, and emit context is not booking state.
  if (result && result.booking && result.booking.__paymentEvent) {
    const { __paymentEvent, ...clean } = result.booking;
    return { ...result, booking: clean };
  }
  return result;
}

module.exports = {
  EVENT_REQUEST_RECEIVED,
  EVENT_CONFIRMED,
  EVENT_ACTION_REQUIRED,
  EVENT_PAYMENT_RECEIVED,
  CHANNELS,
  CLAIM_STORE,
  escapeHtml,
  brandName,
  vehicleDescription,
  serviceDescription,
  serviceItemization,
  arrivalWindow,
  schedulingMessageFields,
  eventStateKey,
  idempotencyKey,
  resendIdempotencyKey,
  getNotificationLedger,
  channelAlreadySent,
  buildEmailContent,
  buildPaymentReceivedEmail,
  buildSmsBody,
  customerTransactionalSmsEnabled,
  emitBookingNotification,
  emitRequestReceived,
  emitConfirmed,
  emitCustomerActionRequired,
  emitPaymentReceived,
  resolveCustomerAccountForBooking,
  setNotificationClaimStoreFactory,
  resetNotificationClaimStoreFactory,
  claimChannelSend,
};
