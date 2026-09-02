'use strict';

/**
 * CARDDETAIL1 — customer SMS appointment details + secure access link.
 * Projection-only: useful lifecycle summaries, authorized /a?t= links,
 * fail-open token mint, no architecture or admin/Stripe changes.
 */

const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const { createCasMemoryStore } = require('./helpers/cas-memory-store');
const { canonicalBookingSmsConsent } = require('../netlify/lib/sms-program');
const {
  TEMPLATE_KEYS,
  renderSmsTemplate,
  bookingTemplateData,
  measureSms,
} = require('../netlify/lib/sms-templates');
const {
  setNotificationClaimStoreFactory,
  resetNotificationClaimStoreFactory,
  resolveCustomerBookingSmsPlan,
  emitRequestReceived,
  emitConfirmed,
  emitChangeRequested,
  emitCancellationRequested,
  emitRescheduled,
  emitPaymentReceived,
  emitDetailsUpdated,
  emitCustomerActionRequired,
  EVENT_REQUEST_RECEIVED,
  EVENT_CONFIRMED,
  EVENT_PAYMENT_RECEIVED,
} = require('../netlify/lib/booking-transactional-notifications');
const {
  setAppointmentAccessStoreFactories,
  resetAppointmentAccessStoreFactories,
  generateOpaqueToken,
  buildAccessUrl,
} = require('../netlify/lib/appointment-access-token');
const { SUPERSEDED_TEMPLATE_KEYS } = require('../netlify/lib/appointment-lifecycle-state');

const VERIFIED = '+12015550177';
const OTHER = '+12015550188';
const ADMIN_TO = '+12015550199';
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

function piiBooking(overrides = {}) {
  const recordedAt = overrides.finalizedAt || '2026-08-27T12:00:00.000Z';
  const phone = overrides.phone || VERIFIED;
  return {
    id: overrides.id || 'CD1-SMS-DETAIL-01',
    firstName: 'Pat',
    lastName: 'Customer',
    email: 'pat.secret@example.test',
    phone,
    address: '123 Harbor View Rd, Newark, NJ 07102',
    notes: 'gate code 4455 side door',
    package: 'Interior Detail',
    preferredDate: '2026-08-28',
    preferredTime: '8:00 AM',
    preferredArrivalWindow: 'anytime',
    confirmedDate: '2026-08-29',
    confirmedTimeWindow: '8:00 AM – 11:00 AM',
    status: 'Pending Review',
    appointmentStatus: 'pending_review',
    jobStatus: 'pending_review',
    bookingVersion: 1,
    quoteVersion: 1,
    totalPrice: 199,
    approvedFinalAmount: 199,
    stripeCustomerId: 'cus_TESTSECRET',
    paymentIntentId: 'pi_TESTSECRET',
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

function assertNoPrivateLeak(body) {
  assert.doesNotMatch(body, /Harbor View/i);
  assert.doesNotMatch(body, /Newark/);
  assert.doesNotMatch(body, /07102/);
  assert.doesNotMatch(body, /@example/);
  assert.doesNotMatch(body, /pat\.secret/i);
  assert.doesNotMatch(body, /gate code/i);
  assert.doesNotMatch(body, /CD1-SMS-DETAIL-01/);
  assert.doesNotMatch(body, /cus_/);
  assert.doesNotMatch(body, /pi_/);
  assert.doesNotMatch(body, /\$199/);
}

function customerRow(prisma) {
  return [...prisma._rows.values()].find((row) => row.audience === 'customer') || [...prisma._rows.values()][0];
}

before(() => {
  process.env.PUBLIC_SITE_URL = 'https://cardetail1.com';
  process.env.CONTEXT = 'production';
  process.env.CUSTOMER_SESSION_SECRET = 'test-customer-session-secret-32chars-min';
});

beforeEach(() => {
  const claimStore = createCasMemoryStore();
  setNotificationClaimStoreFactory(() => claimStore);
  setAppointmentAccessStoreFactories({
    tokenStore: () => createCasMemoryStore(),
    focusStore: () => createCasMemoryStore(),
  });
});

afterEach(() => {
  resetNotificationClaimStoreFactory();
  resetAppointmentAccessStoreFactories();
});

describe('1-4. booking request SMS', () => {
  it('includes requested date, arrival preference, and View link without claiming confirmation', () => {
    const data = bookingTemplateData(
      TEMPLATE_KEYS.REQUEST_RECEIVED,
      piiBooking(),
      TYPICAL_URL
    );
    const rendered = renderSmsTemplate(TEMPLATE_KEYS.REQUEST_RECEIVED, data);
    assert.match(rendered.body, /Booking request received/);
    assert.match(rendered.body, /Aug 28, 2026/);
    assert.match(rendered.body, /Any time that day/);
    // Service lives in the portal when /a?t= is present — saves Twilio segments.
    assert.doesNotMatch(rendered.body, /Interior Detail/);
    assert.match(rendered.body, /View: https:\/\/cardetail1\.com\/a\?t=/);
    assert.doesNotMatch(rendered.body, /Your appointment is confirmed/i);
    assert.doesNotMatch(rendered.body, /confirmed for/);
    assertNoPrivateLeak(rendered.body);
  });

  it('keeps the short service label when there is no appointment link', () => {
    const data = bookingTemplateData(TEMPLATE_KEYS.REQUEST_RECEIVED, piiBooking(), '');
    const rendered = renderSmsTemplate(TEMPLATE_KEYS.REQUEST_RECEIVED, data);
    assert.match(rendered.body, /Interior Detail/);
    assert.doesNotMatch(rendered.body, /View:/);
  });
});

describe('5-6. confirmed SMS', () => {
  it('uses authoritative confirmed date/window and the customer-facing service', () => {
    const booking = piiBooking({
      status: 'Confirmed',
      appointmentStatus: 'confirmed',
      jobStatus: 'confirmed',
      preferredDate: '2026-08-28',
      confirmedDate: '2026-08-29',
      preferredArrivalWindow: 'anytime',
      confirmedTimeWindow: '9:00 AM – 12:00 PM',
      package: 'Essential Marine',
    });
    const data = bookingTemplateData(TEMPLATE_KEYS.CONFIRMED, booking, TYPICAL_URL);
    assert.equal(data.date, '2026-08-29');
    assert.notEqual(data.date, booking.preferredDate);
    const rendered = renderSmsTemplate(TEMPLATE_KEYS.CONFIRMED, data);
    assert.match(rendered.body, /Your appointment is confirmed/);
    assert.match(rendered.body, /Aug 29, 2026/);
    assert.doesNotMatch(rendered.body, /Aug 28, 2026/);
    assert.match(rendered.body, /9:00 AM - 12:00 PM/);
    assert.doesNotMatch(rendered.body, /Essential Marine/);
    assert.match(rendered.body, /View: https:\/\/cardetail1\.com\/a\?t=/);
    assert.doesNotMatch(rendered.body, /View appointment:/);
    assertNoPrivateLeak(rendered.body);
  });
});

describe('7-8. reschedule SMS', () => {
  it('contains the new date/window and not the stale schedule', () => {
    const booking = piiBooking({
      status: 'Confirmed',
      appointmentStatus: 'confirmed',
      confirmedDate: '2026-08-30',
      confirmedTimeWindow: '10:00 AM – 1:00 PM',
      previousConfirmedDate: '2026-08-29',
      previousConfirmedTimeWindow: '8:00 AM – 11:00 AM',
      preferredDate: '2026-08-28',
    });
    const data = bookingTemplateData(TEMPLATE_KEYS.RESCHEDULED, booking, TYPICAL_URL);
    assert.equal(data.date, '2026-08-30');
    assert.notEqual(data.date, data.previousDate);
    const rendered = renderSmsTemplate(TEMPLATE_KEYS.RESCHEDULED, data);
    assert.match(rendered.body, /rescheduled to Aug 30, 2026/);
    assert.match(rendered.body, /10:00 AM - 1:00 PM/);
    assert.doesNotMatch(rendered.body, /Aug 29, 2026/);
    assert.doesNotMatch(rendered.body, /Aug 28, 2026/);
    assert.match(rendered.body, /View: https:\/\/cardetail1\.com\/a\?t=/);
    assert.doesNotMatch(rendered.body, /View updated appointment:/);
  });
});

describe('9-12. change-request and cancellation copy', () => {
  it('change-request says request received and does not say rescheduled', () => {
    const rendered = renderSmsTemplate(
      TEMPLATE_KEYS.CHANGE_REQUESTED,
      bookingTemplateData(TEMPLATE_KEYS.CHANGE_REQUESTED, piiBooking(), TYPICAL_URL)
    );
    assert.match(rendered.body, /We received your request to change your appointment/);
    assert.match(rendered.body, /Current appointment is unchanged/);
    assert.doesNotMatch(rendered.body, /rescheduled/i);
    assert.match(rendered.body, /View: https:\/\/cardetail1\.com\/a\?t=/);
    assert.doesNotMatch(rendered.body, /View request:/);
  });

  it('cancellation-request does not say canceled; authoritative cancel does', () => {
    const request = renderSmsTemplate(
      TEMPLATE_KEYS.CANCELLATION_REQUESTED,
      bookingTemplateData(TEMPLATE_KEYS.CANCELLATION_REQUESTED, piiBooking(), TYPICAL_URL)
    );
    assert.match(request.body, /cancellation request/);
    assert.match(request.body, /remains scheduled/);
    assert.doesNotMatch(request.body, /\bcanceled\b/i);
    assert.doesNotMatch(request.body, /\bcancelled\b/i);
    const cancelled = renderSmsTemplate(
      TEMPLATE_KEYS.CANCELLED,
      bookingTemplateData(TEMPLATE_KEYS.CANCELLED, piiBooking({
        confirmedDate: '2026-08-29',
        status: 'Cancelled',
        appointmentStatus: 'canceled',
      }), TYPICAL_URL)
    );
    assert.match(cancelled.body, /has been canceled/);
    assert.match(cancelled.body, /Aug 29, 2026/);
    assert.doesNotMatch(cancelled.body, /\/a\?t=/);
  });
});

describe('13-15. access-link policy', () => {
  it('authorized phone receives /a?t=; mismatched phone does not', () => {
    const booking = piiBooking();
    const authorized = resolveCustomerBookingSmsPlan({
      booking,
      toE164: VERIFIED,
      verifiedPhoneE164: VERIFIED,
      eventType: EVENT_REQUEST_RECEIVED,
      accessUrl: TYPICAL_URL,
    });
    assert.equal(authorized.send, true);
    assert.equal(authorized.includeAccessUrl, true);
    assert.match(authorized.templateData.url, /\/a\?t=/);
    const renderedAuth = renderSmsTemplate(authorized.templateKey, authorized.templateData);
    assert.match(renderedAuth.body, /\/a\?t=/);

    const mismatched = resolveCustomerBookingSmsPlan({
      booking: piiBooking({ phone: OTHER }),
      toE164: OTHER,
      verifiedPhoneE164: VERIFIED,
      eventType: EVENT_REQUEST_RECEIVED,
      accessUrl: TYPICAL_URL,
    });
    assert.equal(mismatched.send, true);
    assert.equal(mismatched.includeAccessUrl, false);
    assert.equal(mismatched.templateKey, TEMPLATE_KEYS.SAFE_CONFIRMATION);
    assert.equal(mismatched.templateData.url, undefined);
    const renderedSafe = renderSmsTemplate(mismatched.templateKey, mismatched.templateData);
    assert.doesNotMatch(renderedSafe.body, /\/a\?t=/);
    assert.doesNotMatch(renderedSafe.body, /aat_/);
    assert.match(renderedSafe.body, /Booking request received/);
    assert.match(renderedSafe.body, /Interior Detail/);
  });

  it('token mint failure still sends the summary SMS without a private link', async () => {
    setAppointmentAccessStoreFactories({
      tokenStore: () => ({
        async setJSON() { throw new Error('token_store_down'); },
        async get() { return null; },
        async getWithMetadata() { return null; },
      }),
      focusStore: () => createCasMemoryStore(),
    });
    const prisma = createMemoryOutboxPrisma();
    const result = await emitRequestReceived(piiBooking({ id: 'CD1-SMS-TOKEN-FAIL' }), {
      prisma,
      env: SMS_ENV,
      verifiedPhoneE164: VERIFIED,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.delivery.sms.queued, true);
    assert.equal(result.accessToken, null);
    assert.equal(result.accessUrl, '');
    const row = customerRow(prisma);
    const rendered = renderSmsTemplate(row.templateKey, row.templateData);
    assert.match(rendered.body, /Booking request received/);
    assert.match(rendered.body, /Aug 28, 2026/);
    assert.doesNotMatch(rendered.body, /\/a\?t=/);
  });
});

describe('16-18. link is not a notification trigger; consent still suppresses', () => {
  it('opening or previewing /a?t= does not enqueue lifecycle SMS', async () => {
    const prisma = createMemoryOutboxPrisma();
    const first = await emitRequestReceived(piiBooking({ id: 'CD1-SMS-LINK-CLICK' }), {
      prisma,
      env: SMS_ENV,
      verifiedPhoneE164: VERIFIED,
    });
    assert.equal(first.delivery.sms.queued, true);
    for (const source of ['appointment_access', 'portal_access', 'my_garage']) {
      const again = await emitRequestReceived(first.booking, {
        prisma,
        env: SMS_ENV,
        source,
        verifiedPhoneE164: VERIFIED,
      });
      assert.equal(again.skipped, true);
      assert.equal(again.reason, 'portal_access_not_a_trigger');
    }
    assert.equal(prisma._rows.size, 1);

    const access = read('netlify/functions/customer-appointment-access.js');
    const beginIdx = access.indexOf('async function beginAccess');
    const exchangeIdx = access.indexOf('async function exchangeToken');
    const resendIdx = access.indexOf('async function resendFromToken');
    const beginBlock = access.slice(beginIdx, exchangeIdx);
    const exchangeBlock = access.slice(exchangeIdx, resendIdx);
    assert.doesNotMatch(beginBlock, /emitBookingNotification|enqueueSms|emitRequestReceived/);
    assert.doesNotMatch(exchangeBlock, /emitBookingNotification|enqueueSms|emitRequestReceived/);
    assert.match(access, /source: 'appointment_access_resend'/);
  });

  it('SMS consent=false still suppresses customer SMS', async () => {
    const prisma = createMemoryOutboxPrisma();
    const booking = piiBooking({
      transactionalSmsConsentAccepted: false,
      transactionalSmsConsent: canonicalBookingSmsConsent(false, '2026-08-27T12:00:00.000Z'),
    });
    const plan = resolveCustomerBookingSmsPlan({
      booking,
      toE164: VERIFIED,
      verifiedPhoneE164: VERIFIED,
      eventType: EVENT_REQUEST_RECEIVED,
      accessUrl: TYPICAL_URL,
    });
    assert.equal(plan.send, false);
    const result = await emitConfirmed({
      ...booking,
      status: 'Confirmed',
      appointmentStatus: 'confirmed',
      jobStatus: 'confirmed',
      confirmationEventId: 'confirmed:CD1-SMS-DETAIL-01:2026-08-27T12:00:00.000Z',
    }, { prisma, env: SMS_ENV, verifiedPhoneE164: VERIFIED });
    assert.equal(result.delivery.sms.skipped, true);
    assert.equal(prisma._rows.size, 0);
  });
});

describe('19-20. admin SMS and Stripe/payment behavior unchanged', () => {
  it('admin booking / change-request / cancel templates are unchanged', () => {
    const booking = renderSmsTemplate(TEMPLATE_KEYS.ADMIN_BOOKING, {
      bookingRef: 'CD1-ADMIN',
      customerName: 'Owner',
      customerPhone: VERIFIED,
    });
    assert.equal(
      booking.body,
      'Cardetail1 Admin: Booking alert CD1-ADMIN - Owner - ' + VERIFIED + ' Reply STOP or HELP'
    );
    const change = renderSmsTemplate(TEMPLATE_KEYS.ADMIN_CHANGE_REQUEST, {
      date: 'Aug 28',
      bookingRef: 'CD1-LIFE-01',
    });
    assert.equal(
      change.body,
      'Cardetail1 Admin: Customer requested an appointment change for Aug 28 (CD1-LIFE-01). Reply STOP or HELP'
    );
    const cancel = renderSmsTemplate(TEMPLATE_KEYS.ADMIN_CUSTOMER_CANCEL, {
      bookingRef: 'CD1-LIFE-01',
      date: 'Aug 28',
      window: '8:00–9:00 AM',
    });
    assert.equal(
      cancel.body,
      'Cardetail1 Admin: Customer canceled appointment CD1-LIFE-01 for Aug 28, 8:00–9:00 AM. Reply STOP or HELP'
    );
  });

  it('this change does not touch Stripe, ledger, receipts, or Twilio worker files', () => {
    const templates = read('netlify/lib/sms-templates.js');
    assert.match(templates, /function renderSmsTemplate/);
    assert.doesNotMatch(templates, /stripe/i);
    assert.doesNotMatch(templates, /payment-authority|refund-adjustment|canonical-quote/);
    assert.doesNotMatch(templates, /twilio-outbox-worker|twilio-provider|sms-outbox/);
    assert.doesNotMatch(templates, /submit-booking/);
    assert.equal(fs.existsSync(path.join(ROOT, 'netlify/functions/twilio-outbox-worker.js')), true);
    assert.equal(fs.existsSync(path.join(ROOT, 'netlify/lib/sms-outbox.js')), true);
    assert.equal(fs.existsSync(path.join(ROOT, 'netlify/functions/submit-booking.js')), true);
  });
});

describe('security audit', () => {
  it('private link is never sent to an unauthorized number even if url is supplied', () => {
    const safe = renderSmsTemplate(TEMPLATE_KEYS.SAFE_CONFIRMATION, {
      url: TYPICAL_URL,
      date: '2026-08-28',
      service: 'Interior Detail',
      window: 'anytime',
    });
    assert.doesNotMatch(safe.body, /\/a\?t=/);
    assert.doesNotMatch(safe.body, /aat_/);
    const mismatched = resolveCustomerBookingSmsPlan({
      booking: piiBooking({ phone: OTHER }),
      toE164: OTHER,
      verifiedPhoneE164: VERIFIED,
      eventType: EVENT_CONFIRMED,
      accessUrl: TYPICAL_URL,
    });
    assert.equal(mismatched.send, true);
    assert.equal(mismatched.includeAccessUrl, false);
    const confirmed = renderSmsTemplate(mismatched.templateKey, mismatched.templateData);
    assert.doesNotMatch(confirmed.body, /\/a\?t=/);
  });

  it('access tokens remain opaque first-party /a?t= URLs with no PII', () => {
    const token = generateOpaqueToken();
    assert.match(token, /^aat_/);
    assert.ok(token.length >= 40);
    const url = buildAccessUrl(token);
    assert.match(url, /^https:\/\/cardetail1\.com\/a\?t=/);
    assert.doesNotMatch(url, /phone=|email=|bookingId=|address=/i);
  });
});

describe('encoding, segments, and synthetic QA fixtures', () => {
  const fixtures = [
    {
      name: 'request received',
      key: TEMPLATE_KEYS.REQUEST_RECEIVED,
      booking: piiBooking(),
      url: TYPICAL_URL,
    },
    {
      name: 'confirmed',
      key: TEMPLATE_KEYS.CONFIRMED,
      booking: piiBooking({
        status: 'Confirmed',
        appointmentStatus: 'confirmed',
        confirmedDate: '2026-08-29',
        confirmedTimeWindow: '8:00 AM – 11:00 AM',
        package: 'Interior Detail',
      }),
      url: TYPICAL_URL,
    },
    {
      name: 'change request',
      key: TEMPLATE_KEYS.CHANGE_REQUESTED,
      booking: piiBooking({ status: 'Confirmed', appointmentStatus: 'confirmed' }),
      url: TYPICAL_URL,
    },
    {
      name: 'rescheduled',
      key: TEMPLATE_KEYS.RESCHEDULED,
      booking: piiBooking({
        confirmedDate: '2026-08-30',
        confirmedTimeWindow: '10:00 AM – 1:00 PM',
        previousConfirmedDate: '2026-08-29',
      }),
      url: TYPICAL_URL,
    },
    {
      name: 'cancellation request',
      key: TEMPLATE_KEYS.CANCELLATION_REQUESTED,
      booking: piiBooking({ status: 'Confirmed', appointmentStatus: 'confirmed' }),
      url: TYPICAL_URL,
    },
    {
      name: 'canceled',
      key: TEMPLATE_KEYS.CANCELLED,
      booking: piiBooking({
        confirmedDate: '2026-08-29',
        status: 'Cancelled',
        appointmentStatus: 'canceled',
      }),
      url: '',
    },
    {
      name: 'payment received',
      key: TEMPLATE_KEYS.PAYMENT_RECEIVED,
      booking: piiBooking({
        confirmedDate: '2026-08-29',
        __paymentEvent: { remainingCents: 0 },
      }),
      url: TYPICAL_URL,
    },
    {
      name: 'details updated',
      key: TEMPLATE_KEYS.DETAILS_UPDATED,
      booking: piiBooking({
        confirmedDate: '2026-08-29',
        confirmedTimeWindow: '8:00 AM – 11:00 AM',
        package: 'Interior Detail',
      }),
      url: TYPICAL_URL,
    },
    {
      name: 'action required',
      key: TEMPLATE_KEYS.ACTION_REQUIRED,
      booking: piiBooking({
        confirmedDate: '2026-08-29',
        jobStatus: 'completed_pending_payment',
        remainingCents: 5000,
      }),
      url: TYPICAL_URL,
    },
  ];

  for (const fixture of fixtures) {
    it(`${fixture.name} is GSM-7, concise, and free of PII`, () => {
      const data = bookingTemplateData(fixture.key, fixture.booking, fixture.url);
      const rendered = renderSmsTemplate(fixture.key, data);
      const measure = measureSms(rendered.body);
      assert.equal(rendered.ok, true, rendered.error);
      assert.equal(measure.encoding, 'GSM-7', rendered.body);
      assert.ok(measure.segmentCount <= 2, `${fixture.name} ${measure.segmentCount} segments: ${rendered.body}`);
      assert.match(rendered.body, /^Cardetail1:/);
      assert.match(rendered.body, /STOP/);
      assert.match(rendered.body, /HELP/);
      assert.doesNotMatch(rendered.body, /bit\.ly|tinyurl|t\.co\b/i);
      assertNoPrivateLeak(rendered.body);
      assert.equal(rendered.encoding, 'GSM-7');
      assert.equal(rendered.segmentCount, measure.segmentCount);
    });
  }

  it('customer SMS prefix is Cardetail1; legal A2P brand stays Detailing Zone L.L.C.', () => {
    const {
      PROGRAM_NAME,
      CUSTOMER_SMS_BRAND,
      ADMIN_SMS_BRAND,
      A2P_LEGAL_BRAND,
      LEGAL_BUSINESS_NAME_FORMAL,
    } = require('../netlify/lib/sms-program');
    const { BRAND } = require('../netlify/lib/sms-templates');
    assert.equal(PROGRAM_NAME, 'Cardetail1');
    assert.equal(CUSTOMER_SMS_BRAND, 'Cardetail1');
    assert.equal(ADMIN_SMS_BRAND, 'Cardetail1 Admin');
    assert.equal(BRAND, 'Cardetail1');
    assert.equal(A2P_LEGAL_BRAND, 'Detailing Zone L.L.C.');
    assert.equal(LEGAL_BUSINESS_NAME_FORMAL, 'Detailing Zone L.L.C.');
  });
});

describe('lifecycle emit uses the new projection', () => {
  it('authorized request enqueue includes date/service/window and access URL', async () => {
    const prisma = createMemoryOutboxPrisma();
    const result = await emitRequestReceived(piiBooking({ id: 'CD1-SMS-AUTH-REQ' }), {
      prisma,
      env: SMS_ENV,
      verifiedPhoneE164: VERIFIED,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.delivery.sms.queued, true);
    assert.equal(result.delivery.sms.accessLinkIncluded, true);
    const row = customerRow(prisma);
    assert.equal(row.templateKey, TEMPLATE_KEYS.REQUEST_RECEIVED);
    assert.equal(row.templateData.date, '2026-08-28');
    assert.equal(row.templateData.window, 'anytime');
    assert.equal(row.templateData.service, 'Interior Detail');
    assert.match(row.templateData.url, /\/a\?t=/);
    const body = renderSmsTemplate(row.templateKey, row.templateData).body;
    assert.match(body, /Any time that day/);
    assert.match(body, /View:/);
    assert.doesNotMatch(body, /Interior Detail/);
  });

  it('confirmed and rescheduled emits keep authoritative windows', async () => {
    const prisma = createMemoryOutboxPrisma();
    const confirmedBooking = piiBooking({
      id: 'CD1-SMS-CONF',
      status: 'Confirmed',
      appointmentStatus: 'confirmed',
      jobStatus: 'confirmed',
      confirmationEventId: 'confirmed:CD1-SMS-CONF:2026-08-27T12:00:00.000Z',
      confirmedDate: '2026-08-29',
      confirmedTimeWindow: '8:00 AM – 11:00 AM',
      package: 'Maintenance Detail',
    });
    const confirmed = await emitConfirmed(confirmedBooking, {
      prisma,
      env: SMS_ENV,
      verifiedPhoneE164: VERIFIED,
    });
    assert.equal(confirmed.ok, true, confirmed.error);
    const confirmedRow = customerRow(prisma);
    assert.equal(confirmedRow.templateData.date, '2026-08-29');
    assert.equal(confirmedRow.templateData.service, 'Maintenance Detail');
    const confirmedBody = renderSmsTemplate(confirmedRow.templateKey, confirmedRow.templateData).body;
    assert.match(confirmedBody, /View:/);
    assert.doesNotMatch(confirmedBody, /Maintenance Detail/);

    const reschedulePrisma = createMemoryOutboxPrisma();
    const rescheduled = await emitRescheduled(piiBooking({
      id: 'CD1-SMS-RESCH',
      status: 'Confirmed',
      appointmentStatus: 'confirmed',
      jobStatus: 'confirmed',
      confirmedDate: '2026-08-31',
      confirmedTimeWindow: '2:00 PM – 5:00 PM',
      previousConfirmedDate: '2026-08-29',
      rescheduleEventId: 'rescheduled:CD1-SMS-RESCH:2026-08-31:2:00-5:00PM',
    }), { prisma: reschedulePrisma, env: SMS_ENV, verifiedPhoneE164: VERIFIED });
    assert.equal(rescheduled.ok, true, rescheduled.error);
    const rescheduleRow = customerRow(reschedulePrisma);
    assert.equal(rescheduleRow.templateData.date, '2026-08-31');
    assert.notEqual(rescheduleRow.templateData.date, '2026-08-29');
  });

  it('change-request and cancellation-request emits preserve request semantics', async () => {
    const prisma = createMemoryOutboxPrisma();
    const change = await emitChangeRequested(piiBooking({
      id: 'CD1-SMS-CHG',
      status: 'Confirmed',
      appointmentStatus: 'confirmed',
      jobStatus: 'confirmed',
      changeRequestId: 'cr_sms_1',
    }), { prisma, env: SMS_ENV, verifiedPhoneE164: VERIFIED });
    assert.equal(change.ok, true, change.error);
    const changeRow = customerRow(prisma);
    assert.equal(changeRow.templateKey, TEMPLATE_KEYS.CHANGE_REQUESTED);
    const changeBody = renderSmsTemplate(changeRow.templateKey, changeRow.templateData).body;
    assert.match(changeBody, /request to change/);
    assert.doesNotMatch(changeBody, /rescheduled/i);

    const cancelPrisma = createMemoryOutboxPrisma();
    const cancelReq = await emitCancellationRequested(piiBooking({
      id: 'CD1-SMS-CANCREQ',
      status: 'Confirmed',
      appointmentStatus: 'confirmed',
      jobStatus: 'confirmed',
      cancellationRequestedAt: '2026-08-27T13:00:00.000Z',
    }), { prisma: cancelPrisma, env: SMS_ENV, verifiedPhoneE164: VERIFIED });
    assert.equal(cancelReq.ok, true, cancelReq.error);
    const cancelRow = customerRow(cancelPrisma);
    const cancelBody = renderSmsTemplate(cancelRow.templateKey, cancelRow.templateData).body;
    assert.match(cancelBody, /cancellation request/);
    assert.doesNotMatch(cancelBody, /\bcanceled\b/i);
  });
});

describe('operational SMS: paid / due / details updated', () => {
  it('payment received SMS includes View link, no dollar amounts, and Balance remains when due', () => {
    const paid = renderSmsTemplate(
      TEMPLATE_KEYS.PAYMENT_RECEIVED,
      bookingTemplateData(
        TEMPLATE_KEYS.PAYMENT_RECEIVED,
        piiBooking({ confirmedDate: '2026-08-29', __paymentEvent: { remainingCents: 0 } }),
        TYPICAL_URL
      )
    );
    assert.match(paid.body, /Payment received for Aug 29, 2026/);
    assert.match(paid.body, /View: https:\/\/cardetail1\.com\/a\?t=/);
    assert.doesNotMatch(paid.body, /Balance remains/);
    assert.doesNotMatch(paid.body, /\$/);
    assert.doesNotMatch(paid.body, /\d+\.\d{2}/);
    assertNoPrivateLeak(paid.body);

    const due = renderSmsTemplate(
      TEMPLATE_KEYS.PAYMENT_RECEIVED,
      bookingTemplateData(
        TEMPLATE_KEYS.PAYMENT_RECEIVED,
        piiBooking({ confirmedDate: '2026-08-29', __paymentEvent: { remainingCents: 8500 } }),
        TYPICAL_URL
      )
    );
    assert.match(due.body, /Balance remains/);
    assert.doesNotMatch(due.body, /\$85|85\.00/);
  });

  it('action-required (due) SMS is a short View link, not an itemized bill', () => {
    const rendered = renderSmsTemplate(
      TEMPLATE_KEYS.ACTION_REQUIRED,
      bookingTemplateData(
        TEMPLATE_KEYS.ACTION_REQUIRED,
        piiBooking({
          confirmedDate: '2026-08-29',
          jobStatus: 'completed_pending_payment',
        }),
        TYPICAL_URL
      )
    );
    assert.match(rendered.body, /Action needed on your appointment for Aug 29, 2026/);
    assert.match(rendered.body, /View: https:\/\/cardetail1\.com\/a\?t=/);
    assert.doesNotMatch(rendered.body, /Interior Detail/);
    assert.doesNotMatch(rendered.body, /\$/);
  });

  it('details-updated SMS covers pack/car/add-on changes without itemizing', () => {
    const rendered = renderSmsTemplate(
      TEMPLATE_KEYS.DETAILS_UPDATED,
      bookingTemplateData(
        TEMPLATE_KEYS.DETAILS_UPDATED,
        piiBooking({
          confirmedDate: '2026-08-29',
          package: 'Interior Detail',
          vehicles: [{ year: 2022, make: 'Tesla', model: 'Model 3', packageName: 'Interior Detail' }],
        }),
        TYPICAL_URL
      )
    );
    assert.match(rendered.body, /Your appointment was updated for Aug 29, 2026/);
    assert.match(rendered.body, /View: https:\/\/cardetail1\.com\/a\?t=/);
    assert.doesNotMatch(rendered.body, /Interior Detail/);
    assert.doesNotMatch(rendered.body, /Tesla|Model 3|addon|add-on/i);
    assert.doesNotMatch(rendered.body, /\$/);
  });

  it('authorized payment and details-updated emits queue SMS with /a?t=', async () => {
    const payPrisma = createMemoryOutboxPrisma();
    const paid = await emitPaymentReceived(
      piiBooking({
        id: 'CD1-SMS-PAID',
        confirmedDate: '2026-08-29',
        status: 'Confirmed',
        appointmentStatus: 'confirmed',
        jobStatus: 'confirmed',
      }),
      { method: 'cash', amountCents: 19900, remainingCents: 0, settlementId: 'CD1-SMS-PAID:19900:cash' },
      { prisma: payPrisma, env: SMS_ENV, verifiedPhoneE164: VERIFIED }
    );
    assert.equal(paid.ok, true, paid.error);
    assert.equal(paid.delivery.sms.queued, true);
    assert.equal(paid.booking.__paymentEvent, undefined);
    const payRow = customerRow(payPrisma);
    assert.equal(payRow.templateKey, TEMPLATE_KEYS.PAYMENT_RECEIVED);
    const payBody = renderSmsTemplate(payRow.templateKey, payRow.templateData).body;
    assert.match(payBody, /View: https:\/\/cardetail1\.com\/a\?t=/);
    assert.doesNotMatch(payBody, /\$/);

    const detailsPrisma = createMemoryOutboxPrisma();
    const details = await emitDetailsUpdated(piiBooking({
      id: 'CD1-SMS-DETAILS',
      quoteVersion: 4,
      bookingVersion: 6,
      confirmedDate: '2026-08-29',
    }), { prisma: detailsPrisma, env: SMS_ENV, verifiedPhoneE164: VERIFIED });
    assert.equal(details.ok, true, details.error);
    assert.equal(details.delivery.sms.queued, true);
    const detailsRow = customerRow(detailsPrisma);
    assert.equal(detailsRow.templateKey, TEMPLATE_KEYS.DETAILS_UPDATED);
    assert.match(renderSmsTemplate(detailsRow.templateKey, detailsRow.templateData).body, /View:/);

    const duePrisma = createMemoryOutboxPrisma();
    const due = await emitCustomerActionRequired(piiBooking({
      id: 'CD1-SMS-DUE',
      confirmedDate: '2026-08-29',
      jobStatus: 'completed_pending_payment',
      remainingCents: 5000,
    }), { prisma: duePrisma, env: SMS_ENV, verifiedPhoneE164: VERIFIED });
    assert.equal(due.ok, true, due.error);
    assert.equal(due.skipped, undefined);
    assert.equal(due.delivery.sms.queued, true);
    const dueBody = renderSmsTemplate(
      customerRow(duePrisma).templateKey,
      customerRow(duePrisma).templateData
    ).body;
    assert.match(dueBody, /Action needed/);
    assert.match(dueBody, /View:/);
  });

  it('cancelled SMS still never includes the private appointment link', () => {
    const rendered = renderSmsTemplate(
      TEMPLATE_KEYS.CANCELLED,
      bookingTemplateData(
        TEMPLATE_KEYS.CANCELLED,
        piiBooking({ confirmedDate: '2026-08-29', status: 'Cancelled', appointmentStatus: 'canceled' }),
        TYPICAL_URL
      )
    );
    assert.match(rendered.body, /has been canceled/);
    assert.doesNotMatch(rendered.body, /\/a\?t=/);
    assert.doesNotMatch(rendered.body, /View:/);
  });

  it('payment-received on a cancelled appointment never includes /a?t=', () => {
    const cancelled = piiBooking({
      confirmedDate: '2026-08-29',
      status: 'Cancelled',
      appointmentStatus: 'canceled',
      jobStatus: 'cancelled',
      __paymentEvent: { remainingCents: 0 },
    });
    const plan = resolveCustomerBookingSmsPlan({
      booking: cancelled,
      toE164: VERIFIED,
      verifiedPhoneE164: VERIFIED,
      eventType: EVENT_PAYMENT_RECEIVED,
      accessUrl: TYPICAL_URL,
    });
    assert.equal(plan.send, true);
    assert.equal(plan.includeAccessUrl, false);
    const body = renderSmsTemplate(plan.templateKey, plan.templateData).body;
    assert.match(body, /Payment received/);
    assert.doesNotMatch(body, /\/a\?t=/);
    assert.doesNotMatch(body, /View:/);
    assert.equal(SUPERSEDED_TEMPLATE_KEYS.has('booking.payment_received'), true);
  });
});
