'use strict';

/**
 * CARDDETAIL1 — customer-facing SMS brand alignment.
 * Projection/copy only. Legal A2P entity stays Detailing Zone L.L.C.
 * Notification authority, providers, Stripe, and consent architecture stay put.
 */

const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const { createCasMemoryStore } = require('./helpers/cas-memory-store');
const {
  PROGRAM_NAME,
  DBA_NAME,
  DBA_DISCLOSURE,
  CUSTOMER_SMS_BRAND,
  ADMIN_SMS_BRAND,
  LEGAL_BUSINESS_NAME,
  LEGAL_BUSINESS_NAME_FORMAL,
  A2P_LEGAL_BRAND,
  BOOKING_CONSENT_COPY,
  BOOKING_CONSENT_TEXT_VERSION,
  BOOKING_CONSENT_SOURCE,
  LEGACY_PROGRAM_NAME,
  LEGACY_BOOKING_CONSENT_TEXT_VERSION,
  canonicalBookingSmsConsent,
  bookingSmsConsentGranted,
} = require('../netlify/lib/sms-program');
const {
  TEMPLATE_KEYS,
  ADMIN_TEMPLATE_KEYS,
  BRAND,
  renderSmsTemplate,
  bookingTemplateData,
  measureSms,
} = require('../netlify/lib/sms-templates');
const { BUSINESS, RECEIPT_FOOTER } = require('../netlify/lib/receipt-projection');
const {
  setNotificationClaimStoreFactory,
  resetNotificationClaimStoreFactory,
  emitRequestReceived,
  emitConfirmed,
  buildPaymentReceivedEmail,
} = require('../netlify/lib/booking-transactional-notifications');
const {
  notifyCancelled,
} = require('../netlify/lib/appointment-lifecycle-notifications');
const {
  setAppointmentAccessStoreFactories,
  resetAppointmentAccessStoreFactories,
} = require('../netlify/lib/appointment-access-token');

// NANP 555-01xx reserved for fiction — must not match production ADMIN_SMS / env secrets.
const VERIFIED = '+15555550101';
const ADMIN_TO = '+15555550199';
const TYPICAL_TOKEN = 'aat_' + 'A'.repeat(43);
const TYPICAL_URL = `https://cardetail1.com/a?t=${TYPICAL_TOKEN}`;

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
  };
  return {
    smsOutbox,
    _rows: rows,
    async $transaction(fn) { return fn(this); },
    customerAccount: { async findUnique() { return null; } },
  };
}

function booking(overrides = {}) {
  const recordedAt = overrides.finalizedAt || '2026-08-27T12:00:00.000Z';
  const phone = overrides.phone || VERIFIED;
  return {
    id: overrides.id || 'CD1-SMS-BRAND-01',
    firstName: 'Pat',
    lastName: 'Customer',
    email: 'pat.secret@example.test',
    phone,
    package: 'Interior Detail',
    preferredDate: '2026-08-28',
    preferredArrivalWindow: 'anytime',
    confirmedDate: '2026-08-29',
    confirmedTimeWindow: '8:00 AM – 11:00 AM',
    status: 'Pending Review',
    appointmentStatus: 'pending_review',
    jobStatus: 'pending_review',
    bookingVersion: 1,
    quoteVersion: 1,
    finalizedAt: recordedAt,
    transactionalSmsConsentAccepted: true,
    ...overrides,
    phone,
    transactionalSmsConsent: overrides.transactionalSmsConsent
      || canonicalBookingSmsConsent(
        overrides.transactionalSmsConsentAccepted !== false,
        recordedAt,
        phone
      ),
  };
}

function renderLifecycle(key, extra = {}, url = TYPICAL_URL) {
  const data = bookingTemplateData(key, booking(extra), url);
  return renderSmsTemplate(key, data);
}

before(() => {
  process.env.PUBLIC_SITE_URL = 'https://cardetail1.com';
  process.env.CONTEXT = 'production';
  process.env.CUSTOMER_SESSION_SECRET = 'test-customer-session-secret-32chars-min';
});

beforeEach(() => {
  setNotificationClaimStoreFactory(() => createCasMemoryStore());
  setAppointmentAccessStoreFactories({
    tokenStore: () => createCasMemoryStore(),
    focusStore: () => createCasMemoryStore(),
  });
});

afterEach(() => {
  resetNotificationClaimStoreFactory();
  resetAppointmentAccessStoreFactories();
});

describe('canonical SMS brand constants', () => {
  it('14. A2P legal entity is not renamed; DBA is Cardetail1', () => {
    assert.equal(A2P_LEGAL_BRAND, 'Detailing Zone L.L.C.');
    assert.equal(LEGAL_BUSINESS_NAME_FORMAL, 'Detailing Zone L.L.C.');
    assert.equal(LEGAL_BUSINESS_NAME, 'Detailing Zone LLC');
    assert.equal(DBA_NAME, 'Cardetail1');
    assert.equal(PROGRAM_NAME, 'Cardetail1');
    assert.equal(CUSTOMER_SMS_BRAND, 'Cardetail1');
    assert.equal(ADMIN_SMS_BRAND, 'Cardetail1 Admin');
    assert.equal(BRAND, 'Cardetail1');
    assert.equal(DBA_DISCLOSURE, 'Cardetail1 is a registered DBA of Detailing Zone L.L.C.');
    assert.notEqual(CUSTOMER_SMS_BRAND, A2P_LEGAL_BRAND);
    assert.notEqual(PROGRAM_NAME, LEGACY_PROGRAM_NAME);
  });
});

describe('customer and admin SMS prefixes', () => {
  it('1. booking customer SMS starts with Cardetail1', () => {
    const rendered = renderLifecycle(TEMPLATE_KEYS.REQUEST_RECEIVED);
    assert.match(rendered.body, /^Cardetail1:/);
    assert.match(rendered.body, /Booking request received/);
    assert.doesNotMatch(rendered.body, /Detailing Zone:/);
  });

  it('2. confirmed SMS starts with Cardetail1', () => {
    const rendered = renderLifecycle(TEMPLATE_KEYS.CONFIRMED, {
      status: 'Confirmed',
      appointmentStatus: 'confirmed',
    });
    assert.match(rendered.body, /^Cardetail1:/);
    assert.match(rendered.body, /Your appointment is confirmed/);
  });

  it('3. change-request SMS starts with Cardetail1', () => {
    const rendered = renderLifecycle(TEMPLATE_KEYS.CHANGE_REQUESTED);
    assert.match(rendered.body, /^Cardetail1:/);
    assert.match(rendered.body, /request to change/);
  });

  it('4. reschedule SMS starts with Cardetail1', () => {
    const rendered = renderLifecycle(TEMPLATE_KEYS.RESCHEDULED, {
      status: 'Confirmed',
      appointmentStatus: 'confirmed',
    });
    assert.match(rendered.body, /^Cardetail1:/);
    assert.match(rendered.body, /has been rescheduled/);
  });

  it('5. cancellation-request SMS starts with Cardetail1', () => {
    const rendered = renderLifecycle(TEMPLATE_KEYS.CANCELLATION_REQUESTED);
    assert.match(rendered.body, /^Cardetail1:/);
    assert.match(rendered.body, /cancellation request/);
  });

  it('6. canceled SMS starts with Cardetail1', () => {
    const rendered = renderLifecycle(TEMPLATE_KEYS.CANCELLED, {
      status: 'Cancelled',
      appointmentStatus: 'canceled',
    }, '');
    assert.match(rendered.body, /^Cardetail1:/);
    assert.match(rendered.body, /has been canceled/);
    assert.doesNotMatch(rendered.body, /\/a\?t=/);
  });

  it('7. Admin SMS uses Cardetail1 Admin', () => {
    for (const key of ADMIN_TEMPLATE_KEYS) {
      const rendered = renderSmsTemplate(key, {
        bookingRef: 'CD1-ADMIN',
        customerName: 'Owner',
        customerPhone: VERIFIED,
        date: 'Aug 28',
        window: '8:00-9:00 AM',
        message: 'Need a quote',
      });
      assert.match(rendered.body, /^Cardetail1 Admin:/, key);
      assert.doesNotMatch(rendered.body, /^Cardetail1:/, key);
      assert.doesNotMatch(rendered.body, /Detailing Zone/, key);
    }
  });
});

describe('consent copy and legacy grants', () => {
  it('8. customer consent copy identifies Cardetail1', () => {
    assert.match(BOOKING_CONSENT_COPY, /text messages from Cardetail1/);
    assert.doesNotMatch(BOOKING_CONSENT_COPY, /from Detailing Zone/);
    assert.match(BOOKING_CONSENT_COPY, /Message frequency varies/);
    assert.match(BOOKING_CONSENT_COPY, /Message and data rates may apply/);
    assert.match(BOOKING_CONSENT_COPY, /Reply STOP to opt out or HELP for help/);
    assert.match(BOOKING_CONSENT_COPY, /Consent is not a condition of booking/);
    assert.equal(BOOKING_CONSENT_TEXT_VERSION, 'cd1-txn-sms-v3-2026-08-28');
    const html = read('index.html');
    assert.match(html, new RegExp(BOOKING_CONSENT_COPY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(html, /data-consent-version="cd1-txn-sms-v3-2026-08-28"/);
    assert.match(html, /id="sms-consent-ok"/);
    assert.doesNotMatch(html.match(/<input\b[^>]*\bid="sms-consent-ok"[^>]*>/i)[0], /\bchecked\b/i);
    assert.match(read('my-garage.html'), /transactional SMS from Cardetail1/);
    assert.match(read('terms-conditions.html'), /Cardetail1 is a registered DBA of Detailing Zone L\.L\.C\./);
    assert.match(read('privacy-policy.html'), /messages from <strong>Cardetail1<\/strong>/);
  });

  it('legacy Detailing Zone consent evidence still grants SMS', () => {
    const granted = booking({
      transactionalSmsConsent: {
        granted: true,
        recordedAt: '2026-08-22T16:00:00.000Z',
        textVersion: LEGACY_BOOKING_CONSENT_TEXT_VERSION,
        source: BOOKING_CONSENT_SOURCE,
        method: 'booking_checkbox',
        programName: LEGACY_PROGRAM_NAME,
        phoneE164: VERIFIED,
      },
    });
    assert.equal(bookingSmsConsentGranted(granted), true);
    const declined = booking({
      transactionalSmsConsentAccepted: false,
      transactionalSmsConsent: canonicalBookingSmsConsent(false, '2026-08-27T12:00:00.000Z'),
    });
    assert.equal(bookingSmsConsentGranted(declined), false);
  });
});

describe('STOP/HELP, secure links, consent, outbox, payments', () => {
  it('9. STOP/HELP remain Twilio Advanced Opt-Out; app does not send a reply', () => {
    const inbound = read('netlify/functions/twilio-inbound.js');
    assert.match(inbound, /Advanced Opt-Out sends the configured STOP\/HELP response/);
    assert.match(inbound, /<Response><\/Response>/);
    assert.doesNotMatch(inbound, /Detailing Zone/);
    assert.doesNotMatch(inbound, /Cardetail1: For help/);
    assert.doesNotMatch(inbound, /You have been unsubscribed/);
  });

  it('10. secure-link rules unchanged: authorized link vs safe confirmation', () => {
    const withLink = renderLifecycle(TEMPLATE_KEYS.REQUEST_RECEIVED);
    assert.match(withLink.body, /View request: https:\/\/cardetail1\.com\/a\?t=/);
    const safe = renderSmsTemplate(TEMPLATE_KEYS.SAFE_CONFIRMATION, {
      ...bookingTemplateData(TEMPLATE_KEYS.SAFE_CONFIRMATION, booking()),
      url: TYPICAL_URL,
    });
    assert.doesNotMatch(safe.body, /\/a\?t=/);
    assert.doesNotMatch(safe.body, /aat_/);
    assert.match(safe.body, /^Cardetail1:/);
  });

  it('11/12. consent=false suppresses customer SMS; admin SMS is independent', async () => {
    const declined = booking({
      id: 'CD1-SMS-BRAND-NOCONSENT',
      transactionalSmsConsentAccepted: false,
      transactionalSmsConsent: canonicalBookingSmsConsent(false, '2026-08-27T12:00:00.000Z'),
      status: 'Cancelled',
      appointmentStatus: 'canceled',
      jobStatus: 'cancelled',
      canceledAt: '2026-08-27T13:00:00.000Z',
      cancellationEventId: 'cancelled:CD1-SMS-BRAND-NOCONSENT:2026-08-27T13:00:00.000Z',
      cancellationActor: 'customer',
    });
    const prisma = createMemoryOutboxPrisma();
    const result = await notifyCancelled(declined, {
      actor: 'customer',
      prisma,
      env: SMS_ENV,
    });
    assert.equal(result.customer.delivery.sms.skipped, true);
    assert.equal(result.adminSms.queued, true);
    const rows = [...prisma._rows.values()];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].audience, 'admin');
    assert.equal(rows[0].templateKey, TEMPLATE_KEYS.ADMIN_CUSTOMER_CANCEL);
    assert.match(
      renderSmsTemplate(rows[0].templateKey, rows[0].templateData).body,
      /^Cardetail1 Admin:/
    );
  });

  it('13. outbox/idempotency files and enqueue keys are unchanged', async () => {
    const diff = execSync('git diff --name-only origin/master', { cwd: ROOT, encoding: 'utf8' });
    assert.doesNotMatch(diff, /sms-outbox\.js/);
    assert.doesNotMatch(diff, /twilio-outbox-worker/);
    assert.doesNotMatch(diff, /twilio-provider/);
    const prisma = createMemoryOutboxPrisma();
    const first = await emitRequestReceived(booking({ id: 'CD1-SMS-BRAND-IDEM' }), {
      prisma,
      env: SMS_ENV,
      verifiedPhoneE164: VERIFIED,
    });
    assert.equal(first.delivery.sms.queued, true);
    const retry = await emitRequestReceived(first.booking, {
      prisma,
      env: SMS_ENV,
      verifiedPhoneE164: VERIFIED,
    });
    assert.equal(retry.skipped, true);
    assert.equal(prisma._rows.size, 1);
    const row = [...prisma._rows.values()][0];
    assert.match(row.idempotencyKey, /^[A-Za-z0-9_.:-]{8,120}$/);
  });

  it('15. booking/payment behavior unchanged', async () => {
    const diff = execSync('git diff --name-only origin/master', { cwd: ROOT, encoding: 'utf8' });
    assert.doesNotMatch(diff, /stripe/i);
    assert.doesNotMatch(diff, /payment-authority|refund-adjustment|canonical-quote|receipt-projection/);
    assert.doesNotMatch(diff, /submit-booking\.js/);
    assert.equal(BUSINESS.name, 'Detailing Zone L.L.C.');
    assert.equal(RECEIPT_FOOTER, 'Thank you for choosing Detailing Zone.');
    const payment = buildPaymentReceivedEmail({
      id: 'CD1-PAY',
      firstName: 'Pat',
      __paymentEvent: {
        method: 'card',
        amountCents: 19900,
        approvedCents: 19900,
        remainingCents: 0,
        recordedAt: '2026-08-28',
      },
    }, '');
    assert.equal(payment.subject, 'Payment received for your Detailing Zone appointment');
    assert.match(payment.text, /Thank you for choosing Detailing Zone\./);
    const prisma = createMemoryOutboxPrisma();
    const confirmed = await emitConfirmed(booking({
      id: 'CD1-SMS-BRAND-CONF',
      status: 'Confirmed',
      appointmentStatus: 'confirmed',
      jobStatus: 'confirmed',
      confirmationEventId: 'confirmed:CD1-SMS-BRAND-CONF:2026-08-27T12:00:00.000Z',
    }), { prisma, env: SMS_ENV, verifiedPhoneE164: VERIFIED });
    assert.equal(confirmed.ok, true, confirmed.error);
    assert.equal(confirmed.delivery.sms.queued, true);
  });
});

describe('GSM-7 length after Cardetail1 prefix', () => {
  const fixtures = [
    ['request', TEMPLATE_KEYS.REQUEST_RECEIVED, {}, TYPICAL_URL],
    ['request_safe', TEMPLATE_KEYS.SAFE_CONFIRMATION, {}, ''],
    ['confirmed', TEMPLATE_KEYS.CONFIRMED, {
      status: 'Confirmed', appointmentStatus: 'confirmed',
    }, TYPICAL_URL],
    ['change_request', TEMPLATE_KEYS.CHANGE_REQUESTED, {}, TYPICAL_URL],
    ['reschedule', TEMPLATE_KEYS.RESCHEDULED, {
      status: 'Confirmed', appointmentStatus: 'confirmed',
    }, TYPICAL_URL],
    ['cancel_request', TEMPLATE_KEYS.CANCELLATION_REQUESTED, {}, TYPICAL_URL],
    ['canceled', TEMPLATE_KEYS.CANCELLED, {
      status: 'Cancelled', appointmentStatus: 'canceled',
    }, ''],
  ];

  for (const [name, key, extra, url] of fixtures) {
    it(`${name} is GSM-7 and stays within two segments`, () => {
      const rendered = renderLifecycle(key, extra, url);
      const measure = measureSms(rendered.body);
      assert.equal(measure.encoding, 'GSM-7', rendered.body);
      assert.ok(measure.segmentCount <= 2, `${name} ${measure.segmentCount} ${rendered.body}`);
      assert.ok(measure.characterCount > 0);
    });
  }
});
