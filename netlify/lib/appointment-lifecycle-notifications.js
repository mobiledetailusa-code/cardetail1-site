'use strict';

/**
 * Actor-aware appointment lifecycle notifications.
 *
 * Customer email/SMS go through emit* (durable intent → outbox).
 * Admin operational SMS is independent of customer consent.
 * Provider failure never rolls back the appointment mutation.
 */

const { enabled } = require('./twilio-runtime-policy');
const { enqueueSms, kickSmsOutboxByIds, smsSafeIdempotencyKey } = require('./sms-outbox');
const { TEMPLATE_KEYS } = require('./sms-templates');
const { normalizeUsPhoneE164 } = require('./phone-auth');
const {
  emitChangeRequested,
  emitCancellationRequested,
  emitRescheduled,
  emitCancelled,
  emitConfirmed,
  arrivalWindow,
  eventStateKey,
  EVENT_CHANGE_REQUESTED,
  EVENT_CANCELLATION_REQUESTED,
  EVENT_CANCELLED_CUSTOMER,
} = require('./booking-transactional-notifications');
const {
  isAppointmentCancelled,
  isAppointmentCompleted,
  appointmentReminderEligible,
} = require('./appointment-lifecycle-state');

function safeBookingRef(bookingId) {
  return String(bookingId || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 24);
}

function scheduleDate(booking) {
  return String(booking?.confirmedDate || booking?.preferredDate || '').slice(0, 40);
}

function scheduleWindow(booking) {
  return String(arrivalWindow(booking) || '').slice(0, 40);
}

async function enqueueAdminOpsSms({
  idempotencyKey,
  bookingId,
  templateKey,
  templateData,
}, opts = {}) {
  if (!enabled(opts.env?.ADMIN_SMS_CONSENT_GRANTED || process.env.ADMIN_SMS_CONSENT_GRANTED)) {
    return { ok: true, queued: false, skipped: true, reason: 'admin_sms_consent_required' };
  }
  const toE164 = normalizeUsPhoneE164(opts.env?.ADMIN_SMS || process.env.ADMIN_SMS || '');
  if (!toE164) {
    return { ok: true, queued: false, skipped: true, reason: 'admin_sms_destination_missing' };
  }
  return enqueueSms({
    idempotencyKey,
    audience: 'admin',
    consentGranted: true,
    toE164,
    bookingId: bookingId || null,
    templateKey,
    templateData: templateData || {},
  }, { prisma: opts.prisma, env: opts.env });
}

async function kickLifecycleOutbox(ids, opts = {}) {
  const unique = [...new Set((ids || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!unique.length) return { ok: true, processed: 0, skipped: true };
  try {
    return await kickSmsOutboxByIds(unique, {
      prisma: opts.prisma,
      env: opts.env,
    });
  } catch (err) {
    console.warn('[lifecycle-notify] kick_failed', String(err && err.message || err).slice(0, 80));
    return { ok: true, processed: 0, error: 'kick_failed' };
  }
}

async function persistLifecycleNotify(store, bookingId, notified) {
  if (!store || !bookingId || !notified) return notified;
  try {
    const latest = await store.get(bookingId, { type: 'json' }).catch(() => null);
    if (!latest) {
      await store.setJSON(bookingId, notified);
      return notified;
    }
    const merged = {
      ...latest,
      transactionalNotifications: notified.transactionalNotifications || latest.transactionalNotifications,
      lastTransactionalNotificationAt:
        notified.lastTransactionalNotificationAt || latest.lastTransactionalNotificationAt,
      lastTransactionalNotificationEvent:
        notified.lastTransactionalNotificationEvent || latest.lastTransactionalNotificationEvent,
      customerAccountId: latest.customerAccountId || notified.customerAccountId || null,
      appointmentPublicRef: latest.appointmentPublicRef || notified.appointmentPublicRef,
      bookingVersion: latest.bookingVersion,
      quoteVersion: latest.quoteVersion,
    };
    await store.setJSON(bookingId, merged);
    return merged;
  } catch {
    return notified;
  }
}

function outboxIdFrom(result) {
  return result?.delivery?.sms?.outboxId || result?.outbox?.id || null;
}

async function notifyConfirmed(booking, opts = {}) {
  const txn = await emitConfirmed(booking, {
    event: opts.event,
    source: opts.source || 'lifecycle_mutation',
    prisma: opts.prisma,
    env: opts.env,
  });
  await kickLifecycleOutbox([outboxIdFrom(txn)], opts);
  if (opts.store && txn?.booking) {
    return persistLifecycleNotify(opts.store, booking.id || booking.bookingId, txn.booking);
  }
  return txn?.booking || booking;
}

async function notifyChangeRequested(booking, opts = {}) {
  const bookingId = booking.id || booking.bookingId;
  const changeRequestId = opts.changeRequestId || booking.changeRequestId || '';
  const working = {
    ...booking,
    __changeRequestId: changeRequestId,
    rescheduleRequestedDate: opts.requestedDate || booking.rescheduleRequestedDate,
    rescheduleRequestedTime: opts.requestedTime || booking.rescheduleRequestedTime,
  };
  const txn = await emitChangeRequested(working, {
    event: opts.event,
    source: opts.source || 'lifecycle_mutation',
    prisma: opts.prisma,
    env: opts.env,
  });
  const stateKey = eventStateKey(EVENT_CHANGE_REQUESTED, working);
  const admin = await enqueueAdminOpsSms({
    idempotencyKey: smsSafeIdempotencyKey(`admin.change_requested:${bookingId}:${stateKey}`),
    bookingId,
    templateKey: TEMPLATE_KEYS.ADMIN_CHANGE_REQUEST,
    templateData: {
      bookingRef: safeBookingRef(bookingId),
      date: String(opts.requestedDate || scheduleDate(booking) || '').slice(0, 40),
    },
  }, opts);
  await kickLifecycleOutbox([outboxIdFrom(txn), admin.outbox?.id], opts);
  let next = txn?.booking || booking;
  if (opts.store) next = await persistLifecycleNotify(opts.store, bookingId, next);
  return {
    ok: true,
    booking: next,
    customer: txn,
    adminSms: admin,
  };
}

async function notifyCancellationRequested(booking, opts = {}) {
  const bookingId = booking.id || booking.bookingId;
  const txn = await emitCancellationRequested(booking, {
    event: opts.event,
    source: opts.source || 'lifecycle_mutation',
    prisma: opts.prisma,
    env: opts.env,
  });
  const stateKey = eventStateKey(EVENT_CANCELLATION_REQUESTED, booking);
  const admin = await enqueueAdminOpsSms({
    idempotencyKey: smsSafeIdempotencyKey(`admin.cancellation_requested:${bookingId}:${stateKey}`),
    bookingId,
    templateKey: TEMPLATE_KEYS.ADMIN_CUSTOMER_CANCEL,
    templateData: {
      bookingRef: safeBookingRef(bookingId),
      date: scheduleDate(booking),
      window: scheduleWindow(booking),
    },
  }, opts);
  await kickLifecycleOutbox([outboxIdFrom(txn), admin.outbox?.id], opts);
  let next = txn?.booking || booking;
  if (opts.store) next = await persistLifecycleNotify(opts.store, bookingId, next);
  return { ok: true, booking: next, customer: txn, adminSms: admin };
}

async function notifyRescheduled(booking, opts = {}) {
  const txn = await emitRescheduled(booking, {
    event: opts.event,
    source: opts.source || 'lifecycle_mutation',
    prisma: opts.prisma,
    env: opts.env,
  });
  await kickLifecycleOutbox([outboxIdFrom(txn)], opts);
  const bookingId = booking.id || booking.bookingId;
  let next = txn?.booking || booking;
  if (opts.store) next = await persistLifecycleNotify(opts.store, bookingId, next);
  return { ok: true, booking: next, customer: txn };
}

async function notifyCancelled(booking, opts = {}) {
  const actor = String(opts.actor || booking.cancellationActor || 'admin').toLowerCase() === 'customer'
    ? 'customer'
    : 'admin';
  const bookingId = booking.id || booking.bookingId;
  const txn = await emitCancelled(booking, {
    actor,
    event: opts.event,
    source: opts.source || 'lifecycle_mutation',
    prisma: opts.prisma,
    env: opts.env,
  });
  let admin = { queued: false, skipped: true, reason: 'admin_self_action' };
  if (actor === 'customer') {
    const stateKey = eventStateKey(EVENT_CANCELLED_CUSTOMER, booking);
    admin = await enqueueAdminOpsSms({
      idempotencyKey: smsSafeIdempotencyKey(`admin.cancelled.customer:${bookingId}:${stateKey}`),
      bookingId,
      templateKey: TEMPLATE_KEYS.ADMIN_CUSTOMER_CANCEL,
      templateData: {
        bookingRef: safeBookingRef(bookingId),
        date: scheduleDate(booking),
        window: scheduleWindow(booking),
      },
    }, opts);
  }
  await kickLifecycleOutbox([outboxIdFrom(txn), admin.outbox?.id], opts);
  let next = txn?.booking || booking;
  if (opts.store) next = await persistLifecycleNotify(opts.store, bookingId, next);
  return { ok: true, booking: next, customer: txn, adminSms: admin, actor };
}

module.exports = {
  safeBookingRef,
  enqueueAdminOpsSms,
  kickLifecycleOutbox,
  persistLifecycleNotify,
  notifyConfirmed,
  notifyChangeRequested,
  notifyCancellationRequested,
  notifyRescheduled,
  notifyCancelled,
  isAppointmentCancelled,
  isAppointmentCompleted,
  appointmentReminderEligible,
};
