'use strict';

/**
 * Repair A — canonical CAS persistence for reschedule / cancel / apply / request-cancellation.
 * Uses real persistMutation / commitBooking paths, not emitter-only fixtures.
 */

const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { createCasMemoryStore } = require('./helpers/cas-memory-store');
const { canonicalBookingSmsConsent } = require('../netlify/lib/sms-program');
const { TEMPLATE_KEYS } = require('../netlify/lib/sms-templates');
const {
  setNotificationClaimStoreFactory,
  resetNotificationClaimStoreFactory,
} = require('../netlify/lib/booking-transactional-notifications');
const {
  notifyCancellationRequested,
} = require('../netlify/lib/appointment-lifecycle-notifications');
const {
  setAppointmentAccessStoreFactories,
  resetAppointmentAccessStoreFactories,
} = require('../netlify/lib/appointment-access-token');
const {
  setBookingStoreOverride,
  getBookingRecord,
  commitBooking,
} = require('../netlify/lib/booking-repository');
const {
  handleAdminAction,
  persistMutation,
} = require('../netlify/functions/admin-ops-jobs');
const {
  persistCancellationRequest,
} = require('../netlify/functions/request-cancellation');

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
    id: overrides.id || 'CD1-CAS-01',
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
    confirmationEventId: `confirmed:${overrides.id || 'CD1-CAS-01'}:${recordedAt}`,
    finalizedAt: recordedAt,
    paymentPreference: 'cash',
    transactionalSmsConsentAccepted: true,
    transactionalSmsConsent: canonicalBookingSmsConsent(true, recordedAt, VERIFIED),
    ...overrides,
  };
}

function customerSmsRows(prisma, templateKey) {
  return [...prisma._rows.values()].filter((row) => (
    row.audience === 'customer' && row.templateKey === templateKey
  ));
}

function parseBody(res) {
  return JSON.parse(res.body || '{}');
}

function installStores(seedBooking) {
  const store = createCasMemoryStore({ [seedBooking.id]: seedBooking });
  const claimStore = createCasMemoryStore();
  setBookingStoreOverride(store);
  setNotificationClaimStoreFactory(() => claimStore);
  setAppointmentAccessStoreFactories({
    tokenStore: () => createCasMemoryStore(),
    focusStore: () => createCasMemoryStore(),
  });
  return store;
}

before(() => {
  process.env.PUBLIC_SITE_URL = 'https://cardetail1.com';
});

beforeEach(() => {
  process.env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED = 'true';
  process.env.TWILIO_OUTBOX_ENABLED = 'true';
  process.env.TWILIO_ENABLED = 'true';
  process.env.ADMIN_SMS_CONSENT_GRANTED = 'true';
  process.env.ADMIN_SMS = ADMIN_TO;
});

afterEach(() => {
  resetNotificationClaimStoreFactory();
  resetAppointmentAccessStoreFactories();
  setBookingStoreOverride(null);
});

describe('Repair A — admin reschedule CAS persist', () => {
  it('TEST 1 — consent, new window, one reschedule SMS, retry does not duplicate', async () => {
    const booking = consentedBooking({ id: 'CD1-CAS-RS-01' });
    installStores(booking);
    const prisma = createMemoryOutboxPrisma();

    const first = await handleAdminAction({
      action: 'reschedule',
      bookingId: booking.id,
      confirmedDate: '2026-08-29',
      confirmedTimeWindow: '10:00–11:00 AM',
    }, { prisma, env: SMS_ENV });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(parseBody(first).ok, true);

    const rec = await getBookingRecord(booking.id);
    assert.equal(rec.booking.confirmedDate, '2026-08-29');
    assert.equal(rec.booking.confirmedTimeWindow, '10:00–11:00 AM');
    assert.equal(rec.booking.transactionalSmsConsentAccepted, true);
    assert.deepEqual(rec.booking.transactionalSmsConsent, booking.transactionalSmsConsent);
    assert.ok(rec.booking.rescheduleEventId);

    const sms = customerSmsRows(prisma, TEMPLATE_KEYS.RESCHEDULED);
    assert.equal(sms.length, 1);

    const retry = await handleAdminAction({
      action: 'reschedule',
      bookingId: booking.id,
      confirmedDate: '2026-08-29',
      confirmedTimeWindow: '10:00–11:00 AM',
    }, { prisma, env: SMS_ENV });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(customerSmsRows(prisma, TEMPLATE_KEYS.RESCHEDULED).length, 1);

    const again = await getBookingRecord(booking.id);
    assert.deepEqual(again.booking.transactionalSmsConsent, booking.transactionalSmsConsent);
    assert.equal(again.booking.confirmedDate, '2026-08-29');
  });
});

describe('Repair A — admin cancel CAS persist', () => {
  it('TEST 2 — consent, cancelled state, one cancel SMS, retry does not duplicate', async () => {
    const booking = consentedBooking({ id: 'CD1-CAS-CX-01' });
    installStores(booking);
    const prisma = createMemoryOutboxPrisma();

    const first = await handleAdminAction({
      action: 'cancel_booking',
      bookingId: booking.id,
      reason: 'admin_test_cancel',
    }, { prisma, env: SMS_ENV });
    assert.equal(first.statusCode, 200, first.body);

    const rec = await getBookingRecord(booking.id);
    assert.equal(rec.booking.jobStatus, 'cancelled');
    assert.equal(String(rec.booking.appointmentStatus).toLowerCase(), 'canceled');
    assert.equal(rec.booking.transactionalSmsConsentAccepted, true);
    assert.deepEqual(rec.booking.transactionalSmsConsent, booking.transactionalSmsConsent);
    assert.ok(rec.booking.cancellationEventId);

    const sms = customerSmsRows(prisma, TEMPLATE_KEYS.CANCELLED);
    assert.equal(sms.length, 1);

    const retry = await handleAdminAction({
      action: 'cancel_booking',
      bookingId: booking.id,
      reason: 'admin_test_cancel',
    }, { prisma, env: SMS_ENV });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(customerSmsRows(prisma, TEMPLATE_KEYS.CANCELLED).length, 1);
  });
});

describe('Repair A — customer cancellation request CAS persist', () => {
  it('TEST 3 — consent and cancellation-request state survive real persist path', async () => {
    const booking = consentedBooking({ id: 'CD1-CAS-CR-01' });
    const store = installStores(booking);
    const prisma = createMemoryOutboxPrisma();

    const persisted = await persistCancellationRequest({
      bookingId: booking.id,
      booking,
      reason: 'need to reschedule instead',
      changeRequestId: 'cr_cas_1',
      now: '2026-08-26T15:00:00.000Z',
      store,
    });
    assert.equal(persisted.ok, true, persisted.error);

    const rec = await getBookingRecord(booking.id);
    assert.equal(rec.booking.cancellationRequestStatus, 'requested');
    assert.equal(rec.booking.status, 'Cancellation Requested');
    assert.equal(rec.booking.cancellationReason, 'need to reschedule instead');
    assert.deepEqual(rec.booking.transactionalSmsConsent, booking.transactionalSmsConsent);
    assert.equal(rec.booking.firstName, 'Pat');
    assert.equal(rec.booking.phone, VERIFIED);
    assert.ok((rec.booking.eventLog || rec.booking.events || []).some((e) => e && e.action === 'cancellation_requested'));

    const notified = await notifyCancellationRequested(persisted.booking, {
      store,
      prisma,
      env: SMS_ENV,
      source: 'lifecycle_mutation',
    });
    assert.equal(notified.ok, true);
    assert.equal(notified.customer.delivery.sms.queued, true);
    const customer = customerSmsRows(prisma, TEMPLATE_KEYS.CANCELLATION_REQUESTED);
    assert.equal(customer.length, 1);

    const afterNotify = await getBookingRecord(booking.id);
    assert.deepEqual(afterNotify.booking.transactionalSmsConsent, booking.transactionalSmsConsent);
    assert.equal(afterNotify.booking.cancellationRequestStatus, 'requested');
  });
});

describe('Repair A — apply customer reschedule request CAS persist', () => {
  it('TEST 4 — apply keeps consent, new schedule, one reschedule SMS, no duplicate', async () => {
    const booking = consentedBooking({
      id: 'CD1-CAS-AP-01',
      rescheduledByClient: true,
      rescheduleRequestedDate: '2026-08-30',
      rescheduleRequestedTime: '9:00–10:00 AM',
    });
    installStores(booking);
    const prisma = createMemoryOutboxPrisma();

    const first = await handleAdminAction({
      action: 'apply_customer_request',
      bookingId: booking.id,
      requestType: 'reschedule',
    }, { prisma, env: SMS_ENV });
    assert.equal(first.statusCode, 200, first.body);

    const rec = await getBookingRecord(booking.id);
    assert.equal(rec.booking.confirmedDate, '2026-08-30');
    assert.equal(rec.booking.rescheduledByClient, false);
    assert.deepEqual(rec.booking.transactionalSmsConsent, booking.transactionalSmsConsent);
    assert.ok(rec.booking.rescheduleEventId);
    assert.equal(customerSmsRows(prisma, TEMPLATE_KEYS.RESCHEDULED).length, 1);

    const retry = await handleAdminAction({
      action: 'apply_customer_request',
      bookingId: booking.id,
      requestType: 'reschedule',
    }, { prisma, env: SMS_ENV });
    assert.equal(retry.statusCode, 400);
    assert.equal(parseBody(retry).error, 'no_pending_customer_request');

    const { notifyRescheduled } = require('../netlify/lib/appointment-lifecycle-notifications');
    await notifyRescheduled(rec.booking, {
      prisma,
      env: SMS_ENV,
      source: 'lifecycle_mutation',
    });
    assert.equal(customerSmsRows(prisma, TEMPLATE_KEYS.RESCHEDULED).length, 1);
  });
});

describe('Repair A — adversarial CAS stale write', () => {
  it('lifecycle persistMutation must not overwrite a newer unrelated field', async () => {
    const booking = consentedBooking({
      id: 'CD1-CAS-ADV-01',
      paymentPreference: 'cash',
      customerAccountId: 'acct_original',
    });
    const store = installStores(booking);

    const writerASnapshot = await store.get(booking.id, { type: 'json' });

    const recB = await getBookingRecord(booking.id);
    const writerB = await commitBooking({
      bookingId: booking.id,
      expectedBookingVersion: recB.booking.bookingVersion,
      nextAggregate: {
        ...recB.booking,
        paymentPreference: 'card',
        customerAccountId: 'acct_writer_b',
      },
    });
    assert.equal(writerB.ok, true, writerB.error);

    const stalePatch = {
      ...writerASnapshot,
      confirmedDate: '2026-09-10',
      preferredDate: '2026-09-10',
      confirmedTimeWindow: '11:00–12:00 PM',
      status: 'Rescheduled',
    };
    const staleWrite = await persistMutation(
      store,
      booking.id,
      stalePatch,
      writerASnapshot,
      'reschedule',
      'Reschedule'
    );
    assert.equal(staleWrite.ok, false);
    assert.equal(staleWrite.error, 'version_conflict');

    const afterConflict = await getBookingRecord(booking.id);
    assert.equal(afterConflict.booking.paymentPreference, 'card');
    assert.equal(afterConflict.booking.customerAccountId, 'acct_writer_b');
    assert.equal(afterConflict.booking.confirmedDate, '2026-08-28');
    assert.deepEqual(afterConflict.booking.transactionalSmsConsent, booking.transactionalSmsConsent);

    const prisma = createMemoryOutboxPrisma();
    const retry = await handleAdminAction({
      action: 'reschedule',
      bookingId: booking.id,
      confirmedDate: '2026-09-10',
      confirmedTimeWindow: '11:00–12:00 PM',
    }, { prisma, env: SMS_ENV });
    assert.equal(retry.statusCode, 200, retry.body);

    const afterRetry = await getBookingRecord(booking.id);
    assert.equal(afterRetry.booking.confirmedDate, '2026-09-10');
    assert.equal(afterRetry.booking.paymentPreference, 'card');
    assert.equal(afterRetry.booking.customerAccountId, 'acct_writer_b');
    assert.deepEqual(afterRetry.booking.transactionalSmsConsent, booking.transactionalSmsConsent);
  });
});
