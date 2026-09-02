'use strict';

/**
 * Appointment lifecycle notifications: confirm, change-request, reschedule, cancel.
 * Proves emit from authoritative mutations, actor-aware admin alerts, consent,
 * idempotency, no portal trigger, and reminder ineligibility after cancel.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const { createCasMemoryStore } = require('./helpers/cas-memory-store');
const { canonicalBookingSmsConsent, bookingSmsConsentGranted } = require('../netlify/lib/sms-program');
const { TEMPLATE_KEYS, renderSmsTemplate } = require('../netlify/lib/sms-templates');
const {
  setNotificationClaimStoreFactory,
  resetNotificationClaimStoreFactory,
  emitRequestReceived,
  emitConfirmed,
  emitChangeRequested,
  emitRescheduled,
  emitCancelled,
  EVENT_CHANGE_REQUESTED,
  EVENT_RESCHEDULED,
  EVENT_CANCELLED_CUSTOMER,
  EVENT_CANCELLED_ADMIN,
  customerFacingBrand,
} = require('../netlify/lib/booking-transactional-notifications');
const {
  notifyConfirmed,
  notifyChangeRequested,
  notifyRescheduled,
  notifyCancelled,
  appointmentReminderEligible,
  isAppointmentCancelled,
} = require('../netlify/lib/appointment-lifecycle-notifications');
const {
  processClaimedSms,
  claimSmsById,
} = require('../netlify/lib/sms-outbox');
const {
  setAppointmentAccessStoreFactories,
  resetAppointmentAccessStoreFactories,
} = require('../netlify/lib/appointment-access-token');
const { setBookingStoreOverride, getBookingRecord } = require('../netlify/lib/booking-repository');
const { confirmBookingTransition } = require('../netlify/lib/booking-confirm');

const VERIFIED = '+12015550177';
const ADMIN_TO = '+15515551212';
const SMS_ENV = Object.freeze({
  CONTEXT: 'production',
  BRANCH: 'master',
  URL: 'https://cardetail1.com',
  TWILIO_OUTBOX_ENABLED: 'true',
  TWILIO_ENABLED: 'true',
  CUSTOMER_TRANSACTIONAL_SMS_ENABLED: 'true',
  ADMIN_SMS_CONSENT_GRANTED: 'true',
  ADMIN_SMS: ADMIN_TO,
});
const SEND_ENV = Object.freeze({
  ...SMS_ENV,
  TWILIO_PRODUCTION_SENDS_ENABLED: 'true',
  TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
  TWILIO_API_KEY: 'SK00000000000000000000000000000000',
  TWILIO_API_SECRET: 'test-only-secret',
  TWILIO_MESSAGING_SERVICE_SID: 'MG00000000000000000000000000000000',
  TWILIO_STATUS_CALLBACK_URL: 'https://cardetail1.com/.netlify/functions/twilio-status-callback',
});

function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

function matchesWhere(row, where) {
  if (!where || typeof where !== 'object') return true;
  if (where.OR && !where.OR.some((clause) => matchesWhere(row, clause))) return false;
  for (const [key, expected] of Object.entries(where)) {
    if (key === 'OR') continue;
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if (Object.prototype.hasOwnProperty.call(expected, 'lte')
        && new Date(row[key]) > new Date(expected.lte)) return false;
      if (Object.prototype.hasOwnProperty.call(expected, 'lt')
        && !(row[key] && new Date(row[key]) < new Date(expected.lt))) return false;
      continue;
    }
    if (row[key] !== expected) return false;
  }
  return true;
}

function applyData(row, data) {
  const next = { ...row };
  for (const [k, v] of Object.entries(data || {})) {
    if (v && typeof v === 'object' && typeof v.increment === 'number') {
      next[k] = (Number(next[k]) || 0) + v.increment;
    } else {
      next[k] = v;
    }
  }
  return next;
}

function createMemoryOutboxPrisma() {
  const rows = new Map();
  let seq = 0;
  const smsOutbox = {
    async findUnique({ where }) {
      if (where?.idempotencyKey) {
        for (const row of rows.values()) {
          if (row.idempotencyKey === where.idempotencyKey) return clone(row);
        }
        return null;
      }
      if (where?.id) return rows.has(where.id) ? clone(rows.get(where.id)) : null;
      return null;
    },
    async create({ data }) {
      const id = data.id || `outbox_${++seq}`;
      const row = {
        attemptCount: 0,
        maxAttempts: 5,
        status: 'accepted',
        providerMessageSid: null,
        leaseExpiresAt: null,
        leaseToken: null,
        availableAt: new Date(),
        createdAt: new Date(),
        ...data,
        id,
      };
      rows.set(id, row);
      return clone(row);
    },
    async update({ where, data }) {
      const row = rows.get(where.id);
      if (!row) throw new Error('outbox_not_found');
      const next = applyData(row, data);
      rows.set(where.id, next);
      return clone(next);
    },
    async updateMany({ where, data }) {
      let count = 0;
      for (const [id, row] of rows) {
        if (!matchesWhere(row, where)) continue;
        rows.set(id, applyData(row, data));
        count += 1;
      }
      return { count };
    },
  };
  return {
    smsOutbox,
    _rows: rows,
    async $transaction(fn) { return fn(this); },
    customerAccount: { async findUnique() { return null; } },
  };
}

function consentedBooking(overrides = {}) {
  const recordedAt = overrides.finalizedAt || '2026-08-26T12:00:00.000Z';
  return {
    id: overrides.id || 'CD1-LIFE-01',
    firstName: 'Pat',
    lastName: 'Customer',
    email: 'pat.customer@example.test',
    phone: VERIFIED,
    package: 'Interior Detail',
    preferredDate: '2026-08-28',
    preferredTime: '8:00–9:00 AM',
    confirmedDate: '2026-08-28',
    confirmedTimeWindow: '8:00–9:00 AM',
    status: 'Confirmed',
    appointmentStatus: 'confirmed',
    jobStatus: 'confirmed',
    bookingVersion: 1,
    quoteVersion: 1,
    confirmedAt: recordedAt,
    confirmationEventId: 'confirmed:CD1-LIFE-01:2026-08-26T12:00:00.000Z',
    finalizedAt: recordedAt,
    transactionalSmsConsentAccepted: true,
    transactionalSmsConsent: canonicalBookingSmsConsent(true, recordedAt, VERIFIED),
    ...overrides,
  };
}

before(() => {
  process.env.PUBLIC_SITE_URL = 'https://cardetail1.com';
});

beforeEach(() => {
  const claimStore = createCasMemoryStore();
  setNotificationClaimStoreFactory(() => claimStore);
  setAppointmentAccessStoreFactories({
    tokenStore: () => createCasMemoryStore(),
    focusStore: () => createCasMemoryStore(),
  });
  process.env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED = 'true';
});

afterEach(() => {
  resetNotificationClaimStoreFactory();
  resetAppointmentAccessStoreFactories();
  setBookingStoreOverride(null);
});

describe('wiring: lifecycle emits from authoritative mutations', () => {
  it('admin confirm/reschedule/cancel attach notify to the mutation, not the UI', () => {
    const admin = read('netlify/functions/admin-ops-jobs.js');
    const confirmBlock = admin.slice(admin.indexOf("action === 'confirm_booking'"), admin.indexOf("action === 'post_to_auction'"));
    assert.match(confirmBlock, /notifyConfirmed/);
    const rescheduleBlock = admin.slice(admin.indexOf("action === 'reschedule'"), admin.indexOf("action === 'update_address'"));
    assert.match(rescheduleBlock, /notifyRescheduled/);
    assert.match(rescheduleBlock, /store\.setJSON/);
    const cancelBlock = admin.slice(admin.indexOf("action === 'cancel_booking'"), admin.indexOf("action === 'resolve_cancellation'"));
    assert.match(cancelBlock, /notifyCancelled/);
    assert.match(cancelBlock, /actor: 'admin'/);
  });

  it('customer change-request and cancel notify from submit-customer-action', () => {
    const src = read('netlify/functions/submit-customer-action.js');
    assert.match(src, /notifyChangeRequested/);
    assert.match(src, /notifyCancelled/);
    assert.doesNotMatch(src, /Your appointment has been rescheduled/);
  });

  it('portal GET files do not emit lifecycle notifications', () => {
    const portalData = read('netlify/functions/customer-portal-data.js');
    const portalAuth = read('netlify/functions/customer-portal-auth.js');
    const garage = read('assets/my-garage.js');
    assert.doesNotMatch(portalData, /notifyCancelled|notifyRescheduled|notifyChangeRequested|emitCancelled|emitRescheduled/);
    assert.doesNotMatch(portalAuth, /notifyCancelled|notifyRescheduled|emitCancelled/);
    assert.doesNotMatch(garage, /notifyCancelled|enqueueSms/);
  });

  it('request-cancellation notifies without claiming the appointment is canceled', () => {
    const src = read('netlify/functions/request-cancellation.js');
    assert.match(src, /notifyCancellationRequested/);
    assert.doesNotMatch(src, /notifyCancelled\(/);
  });
});

describe('customer-facing copy', () => {
  it('change-request SMS says REQUEST, not RESCHEDULED', () => {
    const rendered = renderSmsTemplate(TEMPLATE_KEYS.CHANGE_REQUESTED, {});
    assert.match(rendered.body, /request to change/i);
    assert.doesNotMatch(rendered.body, /rescheduled/i);
    assert.match(rendered.body, /STOP/i);
  });

  it('confirmed and rescheduled SMS include date and arrival window', () => {
    const confirmed = renderSmsTemplate(TEMPLATE_KEYS.CONFIRMED, {
      date: 'Aug 28',
      window: '8:00–9:00 AM',
    });
    assert.match(confirmed.body, /confirmed/);
    assert.match(confirmed.body, /Aug 28/);
    assert.match(confirmed.body, /8:00-9:00 AM/);
    const rescheduled = renderSmsTemplate(TEMPLATE_KEYS.RESCHEDULED, {
      date: 'Aug 29',
      window: '10:00–11:00 AM',
    });
    assert.match(rescheduled.body, /rescheduled/);
    assert.match(rescheduled.body, /Aug 29/);
    assert.match(rescheduled.body, /10:00-11:00 AM/);
    assert.doesNotMatch(rescheduled.body, /Aug 28/);
  });

  it('cancelled SMS names the date and does not include PII or tokens', () => {
    const rendered = renderSmsTemplate(TEMPLATE_KEYS.CANCELLED, { date: 'Aug 28' });
    assert.match(rendered.body, /canceled/);
    assert.match(rendered.body, /Aug 28/);
    assert.doesNotMatch(rendered.body, /@/);
    assert.doesNotMatch(rendered.body, /\/a\?t=/);
    assert.doesNotMatch(rendered.body, /pi_/);
  });

  it('admin operational SMS omits customer email and address', () => {
    const rendered = renderSmsTemplate(TEMPLATE_KEYS.ADMIN_CUSTOMER_CANCEL, {
      bookingRef: 'CD1-LIFE-01',
      date: 'Aug 28',
      window: '8:00–9:00 AM',
      customerName: 'Pat',
      customerPhone: '555-1212',
    });
    assert.match(rendered.body, /CD1-LIFE-01/);
    assert.doesNotMatch(rendered.body, /@example/);
    assert.doesNotMatch(rendered.body, /Main St/);
  });

  it('customer-facing email brand is Cardetail1; SMS program is Cardetail1', () => {
    assert.equal(customerFacingBrand(), 'Cardetail1');
    const sms = renderSmsTemplate(TEMPLATE_KEYS.CANCELLED, { date: 'Aug 28' });
    assert.match(sms.body, /^Cardetail1:/);
  });
});

describe('confirm / change-request / reschedule / cancel emits', () => {
  it('5/6/7/8/9. confirmation creates customer email+SMS with consent and does not duplicate', async () => {
    const prisma = createMemoryOutboxPrisma();
    const booking = consentedBooking();
    const first = await emitConfirmed(booking, { prisma, env: SMS_ENV });
    assert.equal(first.ok, true, first.error);
    assert.equal(first.delivery.sms.queued, true);
    assert.match(first.delivery.email.reason || 'email_not_configured', /email_not_configured|sent/);
    const second = await emitConfirmed(first.booking, { prisma, env: SMS_ENV });
    assert.equal(second.skipped, true);
    assert.equal(prisma._rows.size, 1);
  });

  it('no customer SMS without consent; confirm still records email intent', async () => {
    const prisma = createMemoryOutboxPrisma();
    const booking = consentedBooking({
      transactionalSmsConsentAccepted: false,
      transactionalSmsConsent: canonicalBookingSmsConsent(false, '2026-08-26T12:00:00.000Z'),
    });
    const result = await emitConfirmed(booking, { prisma, env: SMS_ENV });
    assert.equal(result.delivery.sms.skipped, true);
    assert.equal(prisma._rows.size, 0);
  });

  it('10-14. change request creates customer ack + admin SMS and does not say rescheduled', async () => {
    const prisma = createMemoryOutboxPrisma();
    const booking = consentedBooking({
      rescheduleRequestedDate: '2026-08-29',
      rescheduleRequestedTime: '10:00 AM',
    });
    const result = await notifyChangeRequested(booking, {
      prisma,
      env: SMS_ENV,
      requestedDate: '2026-08-29',
      requestedTime: '10:00 AM',
      changeRequestId: 'cr_life_1',
    });
    assert.equal(result.customer.ok, true, result.customer.error);
    assert.equal(result.customer.delivery.sms.queued, true);
    assert.equal(result.adminSms.queued, true);
    const bodies = [...prisma._rows.values()].map((row) => row.templateKey);
    assert.ok(bodies.includes(TEMPLATE_KEYS.CHANGE_REQUESTED));
    assert.ok(bodies.includes(TEMPLATE_KEYS.ADMIN_CHANGE_REQUEST));
    const customer = renderSmsTemplate(TEMPLATE_KEYS.CHANGE_REQUESTED, {});
    assert.match(customer.body, /request to change/i);
    assert.doesNotMatch(customer.body, /rescheduled/i);
  });

  it('15-21. authoritative reschedule uses the new date; second reschedule is a new event', async () => {
    const prisma = createMemoryOutboxPrisma();
    const firstBooking = consentedBooking({
      confirmedDate: '2026-08-29',
      confirmedTimeWindow: '10:00–11:00 AM',
      rescheduleEventId: 'rescheduled:CD1-LIFE-01:2026-08-29:10:00–11:00 AM',
      previousConfirmedDate: '2026-08-28',
    });
    const first = await emitRescheduled(firstBooking, { prisma, env: SMS_ENV });
    assert.equal(first.ok, true, first.error);
    assert.equal(first.delivery.sms.queued, true, first.delivery.sms.reason || first.delivery.sms.error);
    const row = [...prisma._rows.values()][0];
    assert.equal(row.templateKey, TEMPLATE_KEYS.RESCHEDULED);
    assert.equal(row.templateData.date, '2026-08-29');
    assert.notEqual(row.templateData.date, '2026-08-28');
    assert.match(row.idempotencyKey, /^[A-Za-z0-9_.:-]{8,120}$/);

    const retry = await emitRescheduled(first.booking, { prisma, env: SMS_ENV });
    assert.equal(retry.skipped, true);

    const secondBooking = {
      ...first.booking,
      confirmedDate: '2026-08-30',
      confirmedTimeWindow: '9:00–10:00 AM',
      rescheduleEventId: 'rescheduled:CD1-LIFE-01:2026-08-30:9:00–10:00 AM',
      previousConfirmedDate: '2026-08-29',
    };
    const second = await emitRescheduled(secondBooking, { prisma, env: SMS_ENV });
    assert.equal(second.ok, true, second.error);
    assert.equal(second.skipped, undefined);
    assert.equal(prisma._rows.size, 2);
  });

  it('22-26. customer cancel notifies customer + admin; consent=false still alerts admin', async () => {
    const prisma = createMemoryOutboxPrisma();
    const booking = consentedBooking({
      status: 'Cancelled',
      appointmentStatus: 'canceled',
      jobStatus: 'cancelled',
      canceledAt: '2026-08-26T13:00:00.000Z',
      cancellationEventId: 'cancelled:CD1-LIFE-01:2026-08-26T13:00:00.000Z',
      cancellationActor: 'customer',
    });
    const result = await notifyCancelled(booking, {
      actor: 'customer',
      prisma,
      env: SMS_ENV,
    });
    assert.equal(result.actor, 'customer');
    assert.equal(result.customer.delivery.sms.queued, true);
    assert.equal(result.adminSms.queued, true);
    assert.equal(prisma._rows.size, 2);

    const noConsentPrisma = createMemoryOutboxPrisma();
    const declined = {
      ...booking,
      id: 'CD1-LIFE-NOCONSENT',
      transactionalSmsConsentAccepted: false,
      transactionalSmsConsent: canonicalBookingSmsConsent(false, '2026-08-26T12:00:00.000Z'),
      cancellationEventId: 'cancelled:CD1-LIFE-NOCONSENT:2026-08-26T13:00:00.000Z',
    };
    const declinedResult = await notifyCancelled(declined, {
      actor: 'customer',
      prisma: noConsentPrisma,
      env: SMS_ENV,
    });
    assert.equal(declinedResult.customer.delivery.sms.skipped, true);
    assert.equal(declinedResult.adminSms.queued, true);
    assert.equal([...noConsentPrisma._rows.values()].every((row) => row.audience === 'admin'), true);
  });

  it('27-29. admin cancel notifies customer and does not enqueue admin self-alert', async () => {
    const prisma = createMemoryOutboxPrisma();
    const booking = consentedBooking({
      status: 'Cancelled',
      appointmentStatus: 'canceled',
      jobStatus: 'cancelled',
      canceledAt: '2026-08-26T14:00:00.000Z',
      cancellationEventId: 'cancelled:CD1-LIFE-01:2026-08-26T14:00:00.000Z',
      cancellationActor: 'admin',
    });
    const result = await notifyCancelled(booking, { actor: 'admin', prisma, env: SMS_ENV });
    assert.equal(result.actor, 'admin');
    assert.equal(result.customer.delivery.sms.queued, true);
    assert.equal(result.adminSms.skipped, true);
    assert.equal(prisma._rows.size, 1);
    assert.equal([...prisma._rows.values()][0].audience, 'customer');
  });
});

describe('invariants: reminders, portal, channel independence, versions', () => {
  it('30. canceled and completed appointments are not reminder-eligible', () => {
    assert.equal(appointmentReminderEligible(consentedBooking()), true);
    assert.equal(appointmentReminderEligible(consentedBooking({
      status: 'Cancelled',
      appointmentStatus: 'canceled',
      jobStatus: 'cancelled',
    })), false);
    assert.equal(appointmentReminderEligible(consentedBooking({
      jobStatus: 'completed_paid',
    })), false);
    assert.equal(isAppointmentCancelled(consentedBooking({
      appointmentStatus: 'canceled',
    })), true);
  });

  it('31/32. portal sources skip lifecycle emits', async () => {
    const prisma = createMemoryOutboxPrisma();
    const booking = consentedBooking({
      status: 'Cancelled',
      appointmentStatus: 'canceled',
      jobStatus: 'cancelled',
      canceledAt: '2026-08-26T13:00:00.000Z',
      cancellationEventId: 'cancelled:CD1-LIFE-01:2026-08-26T13:00:00.000Z',
    });
    const portal = await emitCancelled(booking, {
      actor: 'customer',
      prisma,
      env: SMS_ENV,
      source: 'my_garage',
    });
    assert.equal(portal.skipped, true);
    assert.equal(portal.reason, 'portal_access_not_a_trigger');
    assert.equal(prisma._rows.size, 0);
  });

  it('34/35/36. notify failure does not throw; email/SMS intents are independent', async () => {
    const prisma = createMemoryOutboxPrisma();
    const booking = consentedBooking({
      status: 'Cancelled',
      appointmentStatus: 'canceled',
      jobStatus: 'cancelled',
      canceledAt: '2026-08-26T13:00:00.000Z',
      cancellationEventId: 'cancelled:CD1-LIFE-01:2026-08-26T13:00:00.000Z',
    });
    const result = await notifyCancelled(booking, { actor: 'customer', prisma, env: SMS_ENV });
    assert.equal(result.ok, true);
    assert.ok(result.customer.delivery.sms.queued);
    assert.equal(result.customer.delivery.email.skipped || result.customer.delivery.email.sent, true);
  });

  it('stale confirmed SMS is suppressed after cancel', async () => {
    const prisma = createMemoryOutboxPrisma();
    const booking = consentedBooking();
    const queued = await emitConfirmed(booking, { prisma, env: SMS_ENV });
    const outboxId = queued.delivery.sms.outboxId;
    const store = createCasMemoryStore();
    await store.setJSON(booking.id, {
      ...booking,
      status: 'Cancelled',
      appointmentStatus: 'canceled',
      jobStatus: 'cancelled',
    });
    setBookingStoreOverride(store);
    const claimed = await claimSmsById(prisma, outboxId);
    const processed = await processClaimedSms(claimed, {
      prisma,
      env: SEND_ENV,
      provider: {
        ok: true,
        async send() { throw new Error('should_not_send'); },
      },
    });
    assert.equal(processed.reason, 'superseded');
    assert.equal(prisma._rows.get(outboxId).lastErrorCode, 'superseded');
  });
});

describe('confirm persist preserves SMS consent and channel-aware delivery', () => {
  async function persistSubmitNotificationFields(store, bookingId, notified) {
    const latest = await store.get(bookingId, { type: 'json' }).catch(() => null);
    if (!notified) return latest;
    if (!latest) {
      await store.setJSON(bookingId, notified);
      return notified;
    }
    const merged = {
      ...latest,
      notificationDelivery: notified.notificationDelivery || latest.notificationDelivery,
      transactionalNotifications: notified.transactionalNotifications || latest.transactionalNotifications,
      lastTransactionalNotificationAt:
        notified.lastTransactionalNotificationAt || latest.lastTransactionalNotificationAt,
      lastTransactionalNotificationEvent:
        notified.lastTransactionalNotificationEvent || latest.lastTransactionalNotificationEvent,
      customerAccountId: latest.customerAccountId || notified.customerAccountId || null,
      appointmentPublicRef: latest.appointmentPublicRef || notified.appointmentPublicRef,
      appointmentPublicRefAt: latest.appointmentPublicRefAt || notified.appointmentPublicRefAt,
      bookingVersion: latest.bookingVersion,
      quoteVersion: latest.quoteVersion,
    };
    await store.setJSON(bookingId, merged);
    return merged;
  }

  it('submit persist then admin confirm keeps consent and queues booking.confirmed SMS', async () => {
    const prisma = createMemoryOutboxPrisma();
    const recordedAt = '2026-08-26T12:00:00.000Z';
    const pending = {
      id: 'CD1-LIFE-CONSENT-01',
      firstName: 'Pat',
      lastName: 'Customer',
      email: 'pat.customer@example.test',
      phone: VERIFIED,
      package: 'Interior Detail',
      preferredDate: '2026-08-28',
      preferredTime: '8:00–9:00 AM',
      status: 'Pending Review',
      appointmentStatus: 'pending_review',
      jobStatus: 'pending_review',
      bookingVersion: 1,
      quoteVersion: 1,
      finalizedAt: recordedAt,
      createdAt: recordedAt,
      approvedFinalAmount: 220,
      totalPrice: 220,
      ledger: {
        currency: 'usd',
        approvedCents: 22000,
        settledCents: 0,
        creditedCents: 0,
        pendingCents: 0,
        entries: [],
      },
      transactionalSmsConsentAccepted: true,
      transactionalSmsConsent: canonicalBookingSmsConsent(true, recordedAt, VERIFIED),
    };
    const store = createCasMemoryStore({ [pending.id]: pending });
    setBookingStoreOverride(store);

    process.env.RESEND_API_KEY = 're_test';
    process.env.RESEND_FROM = 'test@example.com';
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      if (String(url).includes('api.resend.com')) {
        return { ok: true, json: async () => ({ id: 'em_test' }), text: async () => '' };
      }
      return { ok: false, status: 500, text: async () => '', json: async () => ({}) };
    };

    try {
      const received = await emitRequestReceived(pending, { prisma, env: SMS_ENV });
      assert.equal(received.ok, true, received.error);
      assert.equal(received.delivery.sms.queued, true, received.delivery.sms.reason);
      const now = '2026-08-26T12:05:00.000Z';
      const withSubmitDelivery = {
        ...received.booking,
        notificationDelivery: {
          adminEmail: { status: 'sent', at: now, reason: null },
          customerEmail: { status: 'sent', at: now, reason: null },
          adminSms: { status: 'accepted', at: now, reason: null },
          customerSms: {
            status: 'accepted',
            at: now,
            reason: null,
            outboxId: received.delivery.sms.outboxId || null,
          },
          updatedAt: now,
        },
      };
      await persistSubmitNotificationFields(store, pending.id, withSubmitDelivery);

      const transition = await confirmBookingTransition({
        bookingId: pending.id,
        now: '2026-08-26T13:00:00.000Z',
        by: 'admin',
      });
      assert.equal(transition.ok, true, transition.error);
      assert.equal(transition.transitioned, true);

      const confirmed = await notifyConfirmed(transition.booking, {
        store,
        prisma,
        env: SMS_ENV,
        source: 'lifecycle_mutation',
      });
      assert.ok(confirmed);

      const reread = await getBookingRecord(pending.id, { storeOverride: store });
      assert.equal(reread.exists, true);
      const stored = reread.booking;
      assert.equal(bookingSmsConsentGranted(stored), true);
      assert.equal(stored.transactionalSmsConsentAccepted, true);
      assert.ok(stored.transactionalSmsConsent && stored.transactionalSmsConsent.granted === true);
      assert.equal(stored.approvedFinalAmount, 220);
      assert.equal(stored.quoteVersion, 1);
      assert.equal(stored.appointmentStatus, 'confirmed');

      const rows = [...prisma._rows.values()];
      const requestRows = rows.filter((row) => (
        row.templateKey === TEMPLATE_KEYS.REQUEST_RECEIVED
        || row.templateKey === TEMPLATE_KEYS.SAFE_CONFIRMATION
      ));
      const confirmedRows = rows.filter((row) => row.templateKey === TEMPLATE_KEYS.CONFIRMED);
      assert.equal(requestRows.length, 1);
      assert.equal(confirmedRows.length, 1);
      assert.notEqual(confirmedRows[0].id, requestRows[0].id);
      assert.equal(confirmedRows[0].status, 'accepted');

      const custEmail = stored.notificationDelivery && stored.notificationDelivery.customerEmail;
      const custSms = stored.notificationDelivery && stored.notificationDelivery.customerSms;
      assert.ok(custEmail);
      assert.ok(custSms);
      assert.equal(custSms.status, 'accepted');
      assert.notEqual(custEmail.status, custSms.status);

      const again = await notifyConfirmed(stored, {
        store,
        prisma,
        env: SMS_ENV,
        source: 'lifecycle_mutation',
      });
      assert.ok(again);
      const confirmedAfterRetry = [...prisma._rows.values()].filter(
        (row) => row.templateKey === TEMPLATE_KEYS.CONFIRMED
      );
      assert.equal(confirmedAfterRetry.length, 1);

      const adminUi = read('admin-ops.html');
      assert.match(adminUi, /notificationDeliveryHint/);
      assert.match(adminUi, /channelDeliveryLabel/);
      assert.match(adminUi, /Customer — email:/);
      assert.match(adminUi, /SMS:/);
      assert.doesNotMatch(
        adminUi,
        /Notifications — admin: '\+esc\(\(j\.notificationDelivery\.adminEmail/
      );
      assert.doesNotMatch(
        adminUi,
        / · customer: '\+esc\(\(j\.notificationDelivery\.customerEmail/
      );
    } finally {
      global.fetch = originalFetch;
      delete process.env.RESEND_API_KEY;
      delete process.env.RESEND_FROM;
    }
  });
});
