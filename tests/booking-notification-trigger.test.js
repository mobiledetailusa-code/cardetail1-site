'use strict';

/**
 * CARDDETAIL1 P0 — booking-time notification trigger.
 * Proves SMS/email intents are created from booking persistence, not from
 * My Garage, /a?t=, portal hydration, or access-link consumption.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const { createCasMemoryStore } = require('./helpers/cas-memory-store');
const {
  canonicalBookingSmsConsent,
  bookingSmsConsentGranted,
} = require('../netlify/lib/sms-program');
const { assertCustomerSmsConsent } = require('../netlify/lib/sms-consent-service');
const {
  emitRequestReceived,
  sendCustomerSms,
  resolveCustomerBookingSmsPlan,
  EVENT_REQUEST_RECEIVED,
  setNotificationClaimStoreFactory,
  resetNotificationClaimStoreFactory,
  idempotencyKey,
  eventStateKey,
} = require('../netlify/lib/booking-transactional-notifications');
const {
  bookingCreatedNotificationsIncomplete,
  sendNotificationsDecoupled,
} = require('../netlify/lib/notification-delivery');
const { enqueueSms, kickSmsOutboxByIds } = require('../netlify/lib/sms-outbox');
const { TEMPLATE_KEYS } = require('../netlify/lib/sms-templates');
const {
  setAppointmentAccessStoreFactories,
  resetAppointmentAccessStoreFactories,
} = require('../netlify/lib/appointment-access-token');

const VERIFIED = '+12015550177';
const BOOKING_OTHER = '+15513983986';
const ADMIN_TO = '+15515551212';

const SMS_ENV = Object.freeze({
  CONTEXT: 'production',
  BRANCH: 'master',
  URL: 'https://cardetail1.com',
  TWILIO_OUTBOX_ENABLED: 'true',
  TWILIO_ENABLED: 'true',
  CUSTOMER_TRANSACTIONAL_SMS_ENABLED: 'true',
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

const ENV_KEYS = [
  ...Object.keys(SEND_ENV),
  'CUSTOMER_TRANSACTIONAL_SMS_ENABLED',
  'ADMIN_SMS_CONSENT_GRANTED',
  'ADMIN_SMS',
  'RESEND_API_KEY',
  'RESEND_FROM',
  'PUBLIC_SITE_URL',
];
const priorEnv = {};

function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

function matchesWhere(row, where) {
  if (!where || typeof where !== 'object') return true;
  if (where.OR) {
    if (!where.OR.some((clause) => matchesWhere(row, clause))) return false;
  }
  for (const [key, expected] of Object.entries(where)) {
    if (key === 'OR') continue;
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if (Object.prototype.hasOwnProperty.call(expected, 'lte')) {
        if (new Date(row[key]) > new Date(expected.lte)) return false;
      }
      if (Object.prototype.hasOwnProperty.call(expected, 'lt')) {
        if (!(row[key] && new Date(row[key]) < new Date(expected.lt))) return false;
      }
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
      if (where?.providerMessageSid) {
        for (const row of rows.values()) {
          if (row.providerMessageSid === where.providerMessageSid) return clone(row);
        }
      }
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
    async $transaction(fn) {
      return fn(this);
    },
    customerAccount: {
      async findUnique() {
        return null;
      },
    },
  };
}

function consentedBooking(overrides = {}) {
  const recordedAt = overrides.finalizedAt || '2026-08-26T12:00:00.000Z';
  const phone = overrides.phone || '2015550177';
  return {
    id: overrides.id || 'CD1-TRIGGER-01',
    firstName: 'Pat',
    lastName: 'Customer',
    email: 'pat.customer@example.test',
    phone,
    package: 'Interior Detail',
    preferredDate: '2026-09-01',
    preferredTime: '10:00 AM',
    status: 'Pending Review',
    appointmentStatus: 'pending_review',
    jobStatus: 'pending_review',
    bookingVersion: 1,
    quoteVersion: 1,
    finalizedAt: recordedAt,
    transactionalSmsConsentAccepted: true,
    transactionalSmsConsent: canonicalBookingSmsConsent(true, recordedAt, phone),
    ...overrides,
  };
}

function declinedBooking(overrides = {}) {
  const recordedAt = overrides.finalizedAt || '2026-08-26T12:00:00.000Z';
  return consentedBooking({
    id: 'CD1-TRIGGER-NOCONSENT',
    transactionalSmsConsentAccepted: false,
    transactionalSmsConsent: canonicalBookingSmsConsent(false, recordedAt),
    ...overrides,
  });
}

function installNotifyStores() {
  const claimStore = createCasMemoryStore();
  const tokenStore = createCasMemoryStore();
  setNotificationClaimStoreFactory(() => claimStore);
  setAppointmentAccessStoreFactories({
    tokenStore: () => tokenStore,
    focusStore: () => createCasMemoryStore(),
  });
  return { claimStore, tokenStore };
}

before(() => {
  for (const key of ENV_KEYS) priorEnv[key] = process.env[key];
});

after(() => {
  for (const key of ENV_KEYS) {
    if (priorEnv[key] == null) delete process.env[key];
    else process.env[key] = priorEnv[key];
  }
});

beforeEach(() => {
  // Do not stamp production Twilio policy onto process.env. That would let
  // HTTP-handler tests enqueue into the shared CI Postgres outbox and steal
  // PR5 processSmsOutbox(limit:1) claims. Unit tests pass SMS_ENV explicitly.
  process.env.PUBLIC_SITE_URL = 'https://cardetail1.com';
  process.env.RESEND_API_KEY = '';
  delete process.env.RESEND_API_KEY;
  installNotifyStores();
});

afterEach(() => {
  resetNotificationClaimStoreFactory();
  resetAppointmentAccessStoreFactories();
  for (const key of ENV_KEYS) {
    if (priorEnv[key] == null) delete process.env[key];
    else process.env[key] = priorEnv[key];
  }
});

describe('portal and /a?t= are not booking-created notification authorities', () => {
  it('3/4. submit-booking orchestrates notify after persist; portal files do not enqueue', () => {
    const submit = read('netlify/functions/submit-booking.js');
    const access = read('netlify/functions/customer-appointment-access.js');
    const portalData = read('netlify/functions/customer-portal-data.js');
    const portalAuth = read('netlify/functions/customer-portal-auth.js');
    const garageJs = read('assets/my-garage.js');

    assert.match(submit, /deliverBookingCreatedNotifications/);
    assert.match(submit, /source: 'booking_persist'/);
    assert.match(submit, /kickSmsOutboxByIds/);
    assert.match(submit, /bookingCreatedNotificationsIncomplete/);
    assert.match(submit, /Admin SMS is independent of customer consent/);

    const resendAt = access.indexOf('async function resendFromToken');
    assert.ok(resendAt > 0);
    const beforeResend = access.slice(0, resendAt);
    assert.doesNotMatch(beforeResend, /emitBookingNotification\(/);
    assert.match(access.slice(resendAt), /resendGeneration/);
    assert.match(access.slice(resendAt), /appointment_access_resend/);
    assert.match(access, /must not create, enqueue, or repair booking-created/);
    assert.match(access, /must not emit/);

    assert.doesNotMatch(portalData, /emitRequestReceived|emitBookingNotification|enqueueSms/);
    assert.doesNotMatch(portalAuth, /emitRequestReceived|emitBookingNotification|enqueueSms/);
    assert.doesNotMatch(garageJs, /emitRequestReceived|enqueueSms/);
  });

  it('QA runtime SMS relay stays absent', () => {
    assert.equal(fs.existsSync(path.join(ROOT, 'netlify/functions/qa-notification-pipeline.js')), false);
  });
});

describe('booking-time SMS decision does not wait for account hydration', () => {
  it('customer SMS enablement follows the passed env, not leaked process.env policy', () => {
    const { customerTransactionalSmsEnabled } = require('../netlify/lib/booking-transactional-notifications');
    assert.equal(customerTransactionalSmsEnabled(SMS_ENV), true);
    assert.equal(customerTransactionalSmsEnabled({
      ...SMS_ENV,
      TWILIO_OUTBOX_ENABLED: 'false',
    }), false);
    assert.notEqual(String(process.env.TWILIO_OUTBOX_ENABLED || ''), 'true');
  });
  it('2. booking checkbox consent allows customer SMS without customerAccountId', async () => {
    const result = await assertCustomerSmsConsent({
      customerAccountId: null,
      toE164: VERIFIED,
      booking: consentedBooking({ phone: VERIFIED }),
    }, { prisma: null });
    assert.equal(result.ok, true);
    assert.equal(result.source, 'public_booking_checkbox');
    assert.equal(result.accessAuthorized, false);
  });

  it('consent=false still requires no customer SMS even without an account', async () => {
    const result = await assertCustomerSmsConsent({
      customerAccountId: null,
      toE164: VERIFIED,
      booking: declinedBooking({ phone: VERIFIED }),
    }, { prisma: createMemoryOutboxPrisma() });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'customer_account_required');
  });
});

describe('booking persisted → notification events without portal or /a?t=', () => {
  it('1/3. admin SMS event is created without portal access or customer consent', async () => {
    const prisma = createMemoryOutboxPrisma();
    const queued = await enqueueSms({
      idempotencyKey: 'admin.booking:CD1-TRIGGER-01',
      audience: 'admin',
      consentGranted: true,
      toE164: ADMIN_TO,
      bookingId: 'CD1-TRIGGER-01',
      templateKey: TEMPLATE_KEYS.ADMIN_BOOKING,
      templateData: { bookingRef: 'CD1-TRIGGER-01', customerName: 'Pat Customer' },
    }, { prisma, env: SMS_ENV });
    assert.equal(queued.ok, true, queued.error);
    assert.equal(queued.queued, true);
    assert.equal(queued.outbox.status, 'accepted');
    assert.equal(queued.outbox.audience, 'admin');
    assert.equal(queued.outbox.customerAccountId, null);
  });

  it('2/3/4. consented booking creates customer SMS decision without portal or /a?t=', async () => {
    const prisma = createMemoryOutboxPrisma();
    const booking = consentedBooking();
    assert.equal(bookingSmsConsentGranted(booking), true);
    const result = await emitRequestReceived(booking, { prisma, env: SMS_ENV });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.skipped, undefined);
    assert.equal(result.delivery.sms.queued, true);
    assert.equal(result.delivery.sms.accepted, true);
    assert.ok(result.delivery.sms.outboxId);
    assert.equal(result.delivery.sms.smsMode, 'safe_confirmation');
    assert.equal(result.delivery.sms.accessLinkIncluded, false);
    assert.equal(prisma._rows.size, 1);
    const row = [...prisma._rows.values()][0];
    assert.equal(row.templateKey, TEMPLATE_KEYS.SAFE_CONFIRMATION);
    assert.doesNotMatch(JSON.stringify(row.templateData || {}), /\/a\?t=/);
  });

  it('5/6. later My Garage / portal source does not create initial booking SMS', async () => {
    const prisma = createMemoryOutboxPrisma();
    const first = await emitRequestReceived(consentedBooking({ id: 'CD1-TRIGGER-PORTAL' }), {
      prisma,
      env: SMS_ENV,
    });
    assert.equal(first.delivery.sms.queued, true);
    const garage = await emitRequestReceived(first.booking, {
      prisma,
      env: SMS_ENV,
      source: 'my_garage',
    });
    assert.equal(garage.skipped, true);
    assert.equal(garage.reason, 'portal_access_not_a_trigger');
    const access = await emitRequestReceived(first.booking, {
      prisma,
      env: SMS_ENV,
      source: 'appointment_access',
    });
    assert.equal(access.skipped, true);
    assert.equal(access.reason, 'portal_access_not_a_trigger');
    assert.equal(prisma._rows.size, 1);
  });

  it('7. repeated portal polling does not duplicate SMS', async () => {
    const prisma = createMemoryOutboxPrisma();
    const booking = consentedBooking({ id: 'CD1-TRIGGER-POLL' });
    const first = await emitRequestReceived(booking, { prisma, env: SMS_ENV });
    const second = await emitRequestReceived(first.booking, { prisma, env: SMS_ENV });
    const third = await emitRequestReceived(first.booking, { prisma, env: SMS_ENV, source: 'my_garage' });
    assert.equal(second.skipped, true);
    assert.equal(second.reason, 'already_sent');
    assert.equal(third.reason, 'portal_access_not_a_trigger');
    assert.equal(prisma._rows.size, 1);
  });

  it('8. repeated access-link clicks do not duplicate initial booking SMS', async () => {
    const prisma = createMemoryOutboxPrisma();
    const first = await emitRequestReceived(consentedBooking({ id: 'CD1-TRIGGER-CLICK' }), {
      prisma,
      env: SMS_ENV,
    });
    for (let i = 0; i < 3; i += 1) {
      const again = await emitRequestReceived(first.booking, {
        prisma,
        env: SMS_ENV,
        source: 'appointment_access',
      });
      assert.equal(again.reason, 'portal_access_not_a_trigger');
    }
    assert.equal(prisma._rows.size, 1);
  });

  it('9. consent=false → customer SMS suppressed; admin SMS still created', async () => {
    const prisma = createMemoryOutboxPrisma();
    const booking = declinedBooking();
    const plan = resolveCustomerBookingSmsPlan({
      booking,
      toE164: VERIFIED,
      verifiedPhoneE164: VERIFIED,
      eventType: EVENT_REQUEST_RECEIVED,
    });
    assert.equal(plan.send, false);

    const customer = await sendCustomerSms(VERIFIED, '', {
      booking,
      eventType: EVENT_REQUEST_RECEIVED,
      idempotencyKey: 'cust.sms.noconstent',
      prisma,
      env: SMS_ENV,
    });
    assert.equal(customer.skipped, true);
    assert.equal(customer.reason, 'booking_sms_consent_required');

    const admin = await enqueueSms({
      idempotencyKey: 'admin.booking:CD1-TRIGGER-NOCONSENT',
      audience: 'admin',
      consentGranted: true,
      toE164: ADMIN_TO,
      bookingId: booking.id,
      templateKey: TEMPLATE_KEYS.ADMIN_BOOKING,
      templateData: { bookingRef: booking.id, customerName: 'Pat' },
    }, { prisma, env: SMS_ENV });
    assert.equal(admin.queued, true);
    assert.equal([...prisma._rows.values()].every((row) => row.audience === 'admin'), true);
  });

  it('10. verified_phone_mismatch does not affect admin SMS', async () => {
    const prisma = createMemoryOutboxPrisma();
    const booking = consentedBooking({ id: 'CD1-TRIGGER-MISMATCH', phone: BOOKING_OTHER });
    const result = await emitRequestReceived(booking, {
      prisma,
      env: SMS_ENV,
      verifiedPhoneE164: VERIFIED,
    });
    assert.equal(result.delivery.sms.queued, true);
    assert.equal(result.delivery.sms.smsMode, 'safe_confirmation');
    const admin = await enqueueSms({
      idempotencyKey: 'admin.booking:CD1-TRIGGER-MISMATCH',
      audience: 'admin',
      consentGranted: true,
      toE164: ADMIN_TO,
      bookingId: booking.id,
      templateKey: TEMPLATE_KEYS.ADMIN_BOOKING,
      templateData: { bookingRef: booking.id, customerName: 'Pat' },
    }, { prisma, env: SMS_ENV });
    assert.equal(admin.queued, true);
    assert.equal(prisma._rows.size, 2);
  });

  it('11. worker retry keeps a stable SMS event identity', async () => {
    const prisma = createMemoryOutboxPrisma();
    const booking = consentedBooking({ id: 'CD1-TRIGGER-RETRY' });
    const stateKey = eventStateKey(EVENT_REQUEST_RECEIVED, booking);
    const key = idempotencyKey(booking.id, EVENT_REQUEST_RECEIVED, stateKey, 'sms');
    const first = await emitRequestReceived(booking, { prisma, env: SMS_ENV });
    const queued = [...prisma._rows.values()][0];
    const duplicate = await enqueueSms({
      idempotencyKey: key,
      audience: 'customer',
      bookingId: booking.id,
      booking,
      toE164: VERIFIED,
      templateKey: first.delivery.sms.templateKey,
      templateData: queued.templateData,
    }, { prisma, env: SMS_ENV });
    assert.equal(duplicate.idempotent, true);
    assert.equal(duplicate.outbox.id, first.delivery.sms.outboxId);
    assert.equal(prisma._rows.size, 1);
  });

  it('12. Twilio unavailable does not block booking persistence or enqueue', async () => {
    const prisma = createMemoryOutboxPrisma();
    const booking = consentedBooking({ id: 'CD1-TRIGGER-TWILIO-DOWN' });
    const result = await emitRequestReceived(booking, { prisma, env: SMS_ENV });
    assert.equal(result.ok, true);
    assert.equal(result.booking.id, booking.id);
    assert.equal(result.booking.bookingVersion, 1);
    assert.equal(result.delivery.sms.queued, true);
    const kick = await kickSmsOutboxByIds([result.delivery.sms.outboxId], {
      prisma,
      env: SMS_ENV, // production sends disabled
    });
    assert.equal(kick.skipped, true);
    assert.equal(kick.reason, 'production_sends_disabled');
    const row = prisma._rows.get(result.delivery.sms.outboxId);
    assert.equal(row.status, 'accepted');
    assert.equal(row.attemptCount, 0);
  });

  it('immediate kick sends without waiting for the scheduler, still fail-open', async () => {
    const prisma = createMemoryOutboxPrisma();
    const queued = await enqueueSms({
      idempotencyKey: 'admin.booking:CD1-TRIGGER-KICK',
      audience: 'admin',
      consentGranted: true,
      toE164: ADMIN_TO,
      bookingId: 'CD1-TRIGGER-KICK',
      templateKey: TEMPLATE_KEYS.ADMIN_BOOKING,
      templateData: { bookingRef: 'CD1-TRIGGER-KICK', customerName: 'Pat' },
    }, { prisma, env: SMS_ENV });
    let sends = 0;
    const kick = await kickSmsOutboxByIds([queued.outbox.id], {
      prisma,
      env: SEND_ENV,
      provider: {
        ok: true,
        async send() {
          sends += 1;
          return { sid: 'SM00000000000000000000000000000099', status: 'sent' };
        },
      },
    });
    assert.equal(kick.processed, 1);
    assert.equal(sends, 1);
    const row = prisma._rows.get(queued.outbox.id);
    assert.equal(row.status, 'sent');
    const again = await kickSmsOutboxByIds([queued.outbox.id], {
      prisma,
      env: SEND_ENV,
      provider: {
        ok: true,
        async send() {
          sends += 1;
          return { sid: 'SM00000000000000000000000000000098', status: 'sent' };
        },
      },
    });
    assert.equal(again.processed, 0);
    assert.equal(sends, 1);
  });

  it('access-token failure still records the customer SMS decision', async () => {
    const prisma = createMemoryOutboxPrisma();
    setAppointmentAccessStoreFactories({
      tokenStore: () => ({
        async setJSON() {
          throw new Error('token_store_down');
        },
        async get() { return null; },
        async getWithMetadata() { return null; },
      }),
      focusStore: () => createCasMemoryStore(),
    });
    const result = await emitRequestReceived(consentedBooking({ id: 'CD1-TRIGGER-TOKEN' }), {
      prisma,
      env: SMS_ENV,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.delivery.sms.queued, true);
    assert.equal(result.accessToken, null);
    assert.equal(result.accessUrl, '');
  });

  it('13. email channel remains independent of SMS enqueue', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.RESEND_FROM = 'test@example.com';
    const originalFetch = global.fetch;
    let emailCalls = 0;
    global.fetch = async (url) => {
      if (String(url).includes('api.resend.com')) {
        emailCalls += 1;
        return { ok: true, json: async () => ({ id: 'email_ok' }), text: async () => '' };
      }
      return { ok: false, status: 500, text: async () => '', json: async () => ({}) };
    };
    const prisma = createMemoryOutboxPrisma();
    try {
      const result = await emitRequestReceived(consentedBooking({ id: 'CD1-TRIGGER-EMAIL' }), {
        prisma,
        env: SMS_ENV,
      });
      assert.equal(result.delivery.email.sent, true);
      assert.equal(result.delivery.sms.queued, true);
      assert.equal(emailCalls, 1);
    } finally {
      global.fetch = originalFetch;
      delete process.env.RESEND_API_KEY;
      delete process.env.RESEND_FROM;
    }
  });
});

describe('booking persist regression: version, stripe, incomplete repair', () => {
  it('incomplete helper is true before notify and false after a terminal decision', () => {
    const pending = consentedBooking();
    assert.equal(bookingCreatedNotificationsIncomplete(pending), true);
    const done = {
      ...pending,
      notificationDelivery: {
        adminEmail: { status: 'sent' },
        adminSms: { status: 'accepted' },
        customerEmail: { status: 'sent' },
        customerSms: { status: 'accepted' },
        updatedAt: '2026-08-26T12:00:01.000Z',
      },
      transactionalNotifications: { 'x:sms': { status: 'accepted' } },
    };
    assert.equal(bookingCreatedNotificationsIncomplete(done), false);
    const failedSms = {
      ...done,
      notificationDelivery: {
        ...done.notificationDelivery,
        customerSms: { status: 'failed', reason: 'sms_outbox_unavailable' },
      },
    };
    assert.equal(bookingCreatedNotificationsIncomplete(failedSms), true);
    const suppressed = {
      ...done,
      notificationDelivery: {
        ...done.notificationDelivery,
        customerSms: { status: 'suppressed', reason: 'booking_sms_consent_required' },
      },
    };
    assert.equal(bookingCreatedNotificationsIncomplete(suppressed), false);
  });

  it('14/15. HTTP finalize keeps bookingVersion/quoteVersion and does not require Stripe', async () => {
    const submitBooking = require('../netlify/functions/submit-booking');
    const opsDb = require('../netlify/lib/ops-db');
    const { issueDraftSaveToken } = require('../netlify/lib/draft-save-token');
    const data = new Map();
    const store = {
      async get(key) {
        const value = data.get(key);
        return value == null ? null : structuredClone(value);
      },
      async setJSON(key, value) {
        data.set(key, structuredClone(value));
        return { modified: true };
      },
    };
    const prior = {
      DRAFT_TOKEN_SECRET: process.env.DRAFT_TOKEN_SECRET,
      STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    };
    process.env.DRAFT_TOKEN_SECRET = 's'.repeat(40);
    delete process.env.STRIPE_SECRET_KEY;
    submitBooking.__test.setPreviewTransactionGuardOverride(async () => ({ previewRequest: false }));
    submitBooking.__test.setBlobsStoreOverride(async () => store);
    opsDb.setOpsStoreOverride(store);
    const originalFetch = global.fetch;
    global.fetch = async () => {
      throw new Error('unexpected_external_call');
    };

    const payload = {
      firstName: 'Pat',
      lastName: 'Trigger',
      phone: '2015550177',
      email: 'pat.trigger@example.test',
      address: '1 Main St, Newark, NJ',
      zipCode: '07102',
      preferredDate: '2099-08-24',
      preferredTime: '10:00 AM',
      preferredArrivalWindow: '',
      scheduleFlexibility: 'exact',
      vehicle: '2024 Honda Civic',
      vehicleCategory: 'cars',
      vehicleTier: 'Small Car',
      package: 'Premium Detail',
      packageId: 'full',
      vehicles: [{
        vehicleId: 'vehicle-1',
        cat: 'cars',
        pkgId: 'full',
        pkgName: 'Premium Detail',
        tierKey: 'small',
        tierLabel: 'Small Car',
        vehicleLabel: '2024 Honda Civic',
        addons: [],
        addonTotal: 0,
      }],
      totalPrice: 240,
      travelFeeAmount: 0,
      zoneSurcharge: 0,
      paymentMethod: '',
      paymentMethodPreference: '',
      cardOnFileRequired: false,
      acceptedCardOnFilePolicy: false,
      acceptedBookingPolicy: true,
      transactionalSmsConsentAccepted: true,
      marketingSmsConsentAccepted: false,
    };

    try {
      // Keep CI fail-closed Twilio flags. This test proves persist/version/Stripe
      // isolation, not live outbox writes against shared Postgres.
      process.env.TWILIO_OUTBOX_ENABLED = 'false';
      process.env.TWILIO_ENABLED = 'false';
      process.env.TWILIO_PRODUCTION_SENDS_ENABLED = 'false';
      process.env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED = 'false';
      process.env.ADMIN_SMS_CONSENT_GRANTED = 'false';
      const draftRes = await submitBooking.handler({
        httpMethod: 'POST',
        headers: { 'x-nf-client-connection-ip': '203.0.113.80' },
        body: JSON.stringify({ ...payload, isDraft: true }),
      });
      assert.equal(draftRes.statusCode, 200, draftRes.body);
      const draftBody = JSON.parse(draftRes.body);
      const finalRes = await submitBooking.handler({
        httpMethod: 'POST',
        headers: { 'x-nf-client-connection-ip': '203.0.113.80' },
        body: JSON.stringify({
          ...payload,
          draftBookingId: draftBody.id,
          draftSaveToken: draftBody.draftSaveToken,
        }),
      });
      assert.equal(finalRes.statusCode, 200, finalRes.body);
      const finalBody = JSON.parse(finalRes.body);
      assert.equal(finalBody.bookingCreated, true);
      assert.equal(finalBody.bookingVersion, 1);
      const saved = await store.get(draftBody.id);
      assert.equal(saved.isDraft, false);
      assert.equal(saved.bookingVersion, 1);
      assert.equal(saved.quoteVersion, 1);
      assert.equal(saved.paymentStatus, 'no_payment_required_yet');
      assert.ok(saved.notificationDelivery);
      assert.ok(saved.notificationDelivery.adminSms);
      assert.ok(saved.notificationDelivery.customerSms);
      assert.equal(saved.cardOnFileStatus, 'not_collected');
      assert.equal('setupIntentId' in saved, false);

      const again = await submitBooking.handler({
        httpMethod: 'POST',
        headers: { 'x-nf-client-connection-ip': '203.0.113.80' },
        body: JSON.stringify({
          ...payload,
          draftBookingId: draftBody.id,
          draftSaveToken: draftBody.draftSaveToken || issueDraftSaveToken({
            bookingId: draftBody.id,
            phone: payload.phone,
          }).token,
        }),
      });
      assert.equal(again.statusCode, 200);
      const againBody = JSON.parse(again.body);
      assert.equal(againBody.idempotent, true);
      assert.equal(againBody.bookingVersion, 1);
      const savedAgain = await store.get(draftBody.id);
      assert.equal(savedAgain.bookingVersion, 1);
      assert.equal(savedAgain.quoteVersion, 1);
    } finally {
      global.fetch = originalFetch;
      submitBooking.__test.setPreviewTransactionGuardOverride(null);
      submitBooking.__test.setBlobsStoreOverride(null);
      opsDb.setOpsStoreOverride(null);
      if (prior.DRAFT_TOKEN_SECRET == null) delete process.env.DRAFT_TOKEN_SECRET;
      else process.env.DRAFT_TOKEN_SECRET = prior.DRAFT_TOKEN_SECRET;
      if (prior.STRIPE_SECRET_KEY == null) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = prior.STRIPE_SECRET_KEY;
    }
  });

  it('admin decoupled helper still retries failed SMS and skips suppressed', async () => {
    let adminSmsCalls = 0;
    const first = await sendNotificationsDecoupled({ id: 'CD1-DEC' }, {
      adminSms: async () => {
        adminSmsCalls += 1;
        return { sent: false, reason: 'sms_outbox_failed' };
      },
    });
    assert.equal(first.adminSms.status, 'failed');
    const second = await sendNotificationsDecoupled({
      id: 'CD1-DEC',
      notificationDelivery: first,
    }, {
      adminSms: async () => {
        adminSmsCalls += 1;
        return { accepted: true, queued: true, outboxId: 'outbox_retry' };
      },
    });
    assert.equal(second.adminSms.status, 'accepted');
    assert.equal(adminSmsCalls, 2);

    let suppressedCalls = 0;
    await sendNotificationsDecoupled({
      id: 'CD1-DEC-SUP',
      notificationDelivery: {
        adminSms: { status: 'suppressed', reason: 'sms_consent_required' },
      },
    }, {
      adminSms: async () => {
        suppressedCalls += 1;
        return { accepted: true, queued: true };
      },
    });
    assert.equal(suppressedCalls, 0);
  });
});
