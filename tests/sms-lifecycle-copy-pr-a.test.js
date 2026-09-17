'use strict';

/**
 * PR A — Twilio lifecycle copy, truth, cost, consent, and dedupe.
 * Does not change outbox, provider, inbound, Stripe, or Requests.
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
  adminBookingTemplateData,
  measureSms,
} = require('../netlify/lib/sms-templates');
const {
  setNotificationClaimStoreFactory,
  resetNotificationClaimStoreFactory,
  emitConfirmed,
  emitRescheduled,
  emitChangeRejected,
} = require('../netlify/lib/booking-transactional-notifications');
const {
  notifyConfirmed,
  notifyChangeRequested,
  notifyChangeApproved,
  notifyChangeRejected,
  notifyCancellationRequested,
  notifyRescheduled,
  notifyCancelled,
} = require('../netlify/lib/appointment-lifecycle-notifications');
const {
  setAppointmentAccessStoreFactories,
  resetAppointmentAccessStoreFactories,
} = require('../netlify/lib/appointment-access-token');

const VERIFIED = '+12015550177';
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

function booking(overrides = {}) {
  const recordedAt = overrides.finalizedAt || '2026-09-16T12:00:00.000Z';
  const phone = overrides.phone || VERIFIED;
  return {
    id: overrides.id || 'CD1-LIFE-PRA-01',
    firstName: 'Alex',
    lastName: 'Rivera',
    email: 'alex.secret@example.test',
    phone,
    address: '14 Harbor View Rd, Fort Lee, NJ 07024',
    notes: 'gate code 9911',
    package: 'Maintenance Detail',
    vehicles: [{ year: 2025, make: 'Harley-Davidson', model: 'Road Glide', packageName: 'Maintenance Detail' }],
    preferredDate: '2026-09-19',
    preferredTime: '9:00 AM',
    preferredArrivalWindow: '9:00 AM – 10:00 AM',
    confirmedDate: '2026-09-19',
    confirmedTimeWindow: '9:00 AM – 10:00 AM',
    status: 'Pending Review',
    appointmentStatus: 'pending_review',
    jobStatus: 'pending_review',
    bookingVersion: 1,
    quoteVersion: 1,
    totalPrice: 190,
    approvedFinalAmount: 190,
    ledger: { approvedCents: 19000, settledCents: 0 },
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

function assertNoPii(body) {
  assert.doesNotMatch(body, /Harbor View/i);
  assert.doesNotMatch(body, /07024/);
  assert.doesNotMatch(body, /@example/);
  assert.doesNotMatch(body, /gate code/i);
  assert.doesNotMatch(body, /pi_/);
  assert.doesNotMatch(body, /cus_/);
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

function renderCustomer(key, row = booking(), url = TYPICAL_URL) {
  return renderSmsTemplate(key, bookingTemplateData(key, row, url));
}

describe('customer lifecycle copy', () => {
  it('booking requested is under review, not confirmed, and includes vehicle/package/when/link', () => {
    const rendered = renderCustomer(TEMPLATE_KEYS.REQUEST_RECEIVED);
    assert.match(rendered.body, /Request received/);
    assert.match(rendered.body, /Under review/);
    assert.match(rendered.body, /Alex/);
    assert.match(rendered.body, /2025 Harley-Davidson Road Glide/);
    assert.match(rendered.body, /Maintenance Detail/);
    assert.match(rendered.body, /Sep 19, 2026/);
    assert.match(rendered.body, /9:00 AM - 10:00 AM/);
    assert.match(rendered.body, /View: https:\/\/cardetail1\.com\/a\?t=/);
    assert.doesNotMatch(rendered.body, /Confirmed -/);
    assert.doesNotMatch(rendered.body, /Your appointment is confirmed/i);
    assertNoPii(rendered.body);
  });

  it('booking confirmed uses confirmed schedule, package, price, and the customer link', () => {
    const rendered = renderCustomer(TEMPLATE_KEYS.CONFIRMED, booking({
      status: 'Confirmed',
      appointmentStatus: 'confirmed',
      jobStatus: 'confirmed',
    }));
    assert.match(rendered.body, /Confirmed -/);
    assert.match(rendered.body, /Sep 19, 2026/);
    assert.match(rendered.body, /9:00 AM - 10:00 AM/);
    assert.match(rendered.body, /Maintenance Detail/);
    assert.match(rendered.body, /\$190/);
    assert.match(rendered.body, /View: https:\/\/cardetail1\.com\/a\?t=/);
    assertNoPii(rendered.body);
  });

  it('reschedule requested keeps the current appointment unchanged', () => {
    const rendered = renderSmsTemplate(TEMPLATE_KEYS.CHANGE_REQUESTED, {
      ...bookingTemplateData(TEMPLATE_KEYS.CHANGE_REQUESTED, booking(), TYPICAL_URL),
      changeKind: 'reschedule',
    });
    assert.match(rendered.body, /reschedule request/);
    assert.match(rendered.body, /remains unchanged while we review it/);
    assert.doesNotMatch(rendered.body, /has been rescheduled/i);
    assert.match(rendered.body, /View: https:\/\/cardetail1\.com\/a\?t=/);
  });

  it('package/add-on change request keeps generic request copy', () => {
    const rendered = renderCustomer(TEMPLATE_KEYS.CHANGE_REQUESTED);
    assert.match(rendered.body, /request to change your appointment/);
    assert.match(rendered.body, /Current appointment is unchanged/);
    assert.doesNotMatch(rendered.body, /reschedule request/);
  });

  it('reschedule approved names the new confirmed time', () => {
    const rendered = renderCustomer(TEMPLATE_KEYS.RESCHEDULED, booking({
      confirmedDate: '2026-09-20',
      confirmedTimeWindow: '11:00 AM – 12:00 PM',
      previousConfirmedDate: '2026-09-19',
    }));
    assert.match(rendered.body, /rescheduled to Sep 20, 2026/);
    assert.match(rendered.body, /11:00 AM - 12:00 PM/);
    assert.doesNotMatch(rendered.body, /Sep 19, 2026/);
  });

  it('reschedule/package rejection says the current appointment remains', () => {
    const rendered = renderSmsTemplate(TEMPLATE_KEYS.CHANGE_REJECTED, {
      ...bookingTemplateData(TEMPLATE_KEYS.CHANGE_REJECTED, booking(), TYPICAL_URL),
    });
    assert.match(rendered.body, /was not approved/);
    assert.match(rendered.body, /remains unchanged/);
    assert.match(rendered.body, /View:/);
  });

  it('cancellation request is not final; cancelled is final and has no private link', () => {
    const requested = renderCustomer(TEMPLATE_KEYS.CANCELLATION_REQUESTED);
    assert.match(requested.body, /cancellation request/);
    assert.match(requested.body, /remains scheduled/);
    assert.doesNotMatch(requested.body, /\bcanceled\b/i);
    const cancelled = renderCustomer(TEMPLATE_KEYS.CANCELLED, booking({
      status: 'Cancelled',
      appointmentStatus: 'canceled',
    }), TYPICAL_URL);
    assert.match(cancelled.body, /has been canceled/);
    assert.doesNotMatch(cancelled.body, /\/a\?t=/);
  });

  it('payment received does not claim the service is completed', () => {
    const rendered = renderCustomer(TEMPLATE_KEYS.PAYMENT_RECEIVED, booking({
      __paymentEvent: { remainingCents: 0 },
    }));
    assert.match(rendered.body, /Payment received/);
    assert.doesNotMatch(rendered.body, /completed/i);
    assert.doesNotMatch(rendered.body, /finished/i);
  });
});

describe('admin lifecycle copy', () => {
  it('new booking request includes customer, vehicle, package, price, when, city', () => {
    const data = adminBookingTemplateData(booking());
    const rendered = renderSmsTemplate(TEMPLATE_KEYS.ADMIN_BOOKING, data);
    assert.match(rendered.body, /New request/);
    assert.match(rendered.body, /Alex Rivera/);
    assert.match(rendered.body, /Harley-Davidson/);
    assert.match(rendered.body, /Maintenance Detail/);
    assert.match(rendered.body, /\$190/);
    assert.match(rendered.body, /Sep 19, 2026/);
    assert.match(rendered.body, /Fort Lee/);
    assert.doesNotMatch(rendered.body, /Harbor View/);
    assert.doesNotMatch(rendered.body, /07024/);
    assert.doesNotMatch(rendered.body, /ops\/q\//);
  });

  it('reschedule request names current -> requested time and vehicle', () => {
    const rendered = renderSmsTemplate(TEMPLATE_KEYS.ADMIN_CHANGE_REQUEST, {
      customerName: 'Alex Rivera',
      changeKind: 'reschedule',
      currentWhen: 'Sep 19, 2026 9:00 AM - 10:00 AM',
      requestedWhen: 'Sep 20, 2026 11:00 AM',
      vehicle: '2025 Harley-Davidson Road Glide',
    });
    assert.match(rendered.body, /Reschedule request/);
    assert.match(rendered.body, /Sep 19, 2026 9:00 AM - 10:00 AM -> Sep 20, 2026 11:00 AM/);
    assert.match(rendered.body, /Harley-Davidson/);
    assert.doesNotMatch(rendered.body, /Customer canceled/i);
  });

  it('cancel request is distinct from final customer cancel', () => {
    const requested = renderSmsTemplate(TEMPLATE_KEYS.ADMIN_CANCELLATION_REQUESTED, {
      customerName: 'Alex Rivera',
      vehicle: '2025 Harley-Davidson Road Glide',
      date: '2026-09-19',
      window: '9:00 AM – 10:00 AM',
      bookingRef: 'CD1-LIFE-PRA-01',
    });
    assert.match(requested.body, /Cancel request/);
    assert.match(requested.body, /Still scheduled/);
    assert.doesNotMatch(requested.body, /Customer canceled/i);
    const finalCancel = renderSmsTemplate(TEMPLATE_KEYS.ADMIN_CUSTOMER_CANCEL, {
      bookingRef: 'CD1-LIFE-PRA-01',
      date: 'Sep 19, 2026',
      window: '9:00 AM - 10:00 AM',
    });
    assert.match(finalCancel.body, /Customer canceled appointment/);
  });
});

describe('self-SMS and dedupe', () => {
  it('Admin confirmation / reschedule / reject / admin-cancel do not self-SMS', async () => {
    const prisma = createMemoryOutboxPrisma();
    await notifyConfirmed(booking({
      id: 'CD1-PRA-CONF',
      status: 'Confirmed',
      appointmentStatus: 'confirmed',
      confirmationEventId: 'confirmed:CD1-PRA-CONF:2026-09-16T12:00:00.000Z',
    }), { prisma, env: SMS_ENV });
    await notifyRescheduled(booking({
      id: 'CD1-PRA-RESCH',
      confirmedDate: '2026-09-20',
      rescheduleEventId: 'rescheduled:CD1-PRA-RESCH:2026-09-20:11:00',
    }), { prisma, env: SMS_ENV });
    await notifyChangeRejected(booking({ id: 'CD1-PRA-REJ' }), {
      prisma,
      env: SMS_ENV,
      changeRequestId: 'cr_pra_rej',
    });
    await notifyCancelled(booking({
      id: 'CD1-PRA-ACAN',
      status: 'Cancelled',
      appointmentStatus: 'canceled',
      jobStatus: 'cancelled',
      canceledAt: '2026-09-16T13:00:00.000Z',
      cancellationEventId: 'cancelled:CD1-PRA-ACAN:2026-09-16T13:00:00.000Z',
    }), { actor: 'admin', prisma, env: SMS_ENV });
    const adminRows = [...prisma._rows.values()].filter((row) => row.audience === 'admin');
    assert.equal(adminRows.length, 0);
  });

  it('package change request still alerts Admin; approval does not', async () => {
    const prisma = createMemoryOutboxPrisma();
    const row = booking({ id: 'CD1-PRA-PKG' });
    const requested = await notifyChangeRequested(row, {
      prisma,
      env: SMS_ENV,
      changeRequestId: 'cr_pra_pkg',
      customerName: 'Alex Rivera',
      changeSummary: 'Maintenance Detail -> Interior Detail',
      requestType: 'package_change_request',
      requestTypeLabel: 'Package change',
    });
    assert.equal(requested.adminSms.queued, true);
    const approved = await notifyChangeApproved(row, {
      prisma,
      env: SMS_ENV,
      changeRequestId: 'cr_pra_pkg',
      requestType: 'package_change_request',
    });
    assert.equal(approved.adminSms.reason, 'admin_self_action');
    const adminKeys = [...prisma._rows.values()]
      .filter((item) => item.audience === 'admin')
      .map((item) => item.templateKey);
    assert.deepEqual(adminKeys, [TEMPLATE_KEYS.ADMIN_CHANGE_REQUEST]);
  });

  it('retried lifecycle events do not duplicate customer or Admin SMS', async () => {
    const prisma = createMemoryOutboxPrisma();
    const row = booking({
      id: 'CD1-PRA-IDEM',
      confirmationEventId: 'confirmed:CD1-PRA-IDEM:2026-09-16T12:00:00.000Z',
      status: 'Confirmed',
      appointmentStatus: 'confirmed',
    });
    const first = await emitConfirmed(row, { prisma, env: SMS_ENV });
    const second = await emitConfirmed(first.booking || row, { prisma, env: SMS_ENV });
    assert.equal(first.delivery.sms.queued, true);
    assert.equal(second.skipped, true);
    assert.equal([...prisma._rows.values()].filter((item) => item.audience === 'customer').length, 1);

    const changePrisma = createMemoryOutboxPrisma();
    const change = booking({ id: 'CD1-PRA-IDEM-CR' });
    await notifyChangeRequested(change, {
      prisma: changePrisma,
      env: SMS_ENV,
      changeRequestId: 'cr_pra_idem',
      requestedDate: '2026-09-21',
      requestedTime: '11:00 AM',
      requestType: 'reschedule_request',
    });
    await notifyChangeRequested(change, {
      prisma: changePrisma,
      env: SMS_ENV,
      changeRequestId: 'cr_pra_idem',
      requestedDate: '2026-09-21',
      requestedTime: '11:00 AM',
      requestType: 'reschedule_request',
    });
    const admin = [...changePrisma._rows.values()].filter((item) => item.audience === 'admin');
    const customer = [...changePrisma._rows.values()].filter((item) => item.audience === 'customer');
    assert.equal(admin.length, 1);
    assert.equal(customer.length, 1);
  });

  it('customer cancel still alerts Admin; consent=false still blocks only customer SMS', async () => {
    const prisma = createMemoryOutboxPrisma();
    const declined = booking({
      id: 'CD1-PRA-NOCONSENT',
      transactionalSmsConsentAccepted: false,
      transactionalSmsConsent: canonicalBookingSmsConsent(false, '2026-09-16T12:00:00.000Z'),
      status: 'Cancelled',
      appointmentStatus: 'canceled',
      jobStatus: 'cancelled',
      canceledAt: '2026-09-16T13:00:00.000Z',
      cancellationEventId: 'cancelled:CD1-PRA-NOCONSENT:2026-09-16T13:00:00.000Z',
      cancellationActor: 'customer',
    });
    const result = await notifyCancelled(declined, { actor: 'customer', prisma, env: SMS_ENV });
    assert.equal(result.customer.delivery.sms.skipped, true);
    assert.equal(result.adminSms.queued, true);
    assert.equal([...prisma._rows.values()].every((row) => row.audience === 'admin'), true);
  });

  it('reschedule emit retry is skipped; a new schedule is a new event', async () => {
    const prisma = createMemoryOutboxPrisma();
    const firstBooking = booking({
      id: 'CD1-PRA-RESCH-IDEM',
      confirmedDate: '2026-09-20',
      confirmedTimeWindow: '11:00 AM – 12:00 PM',
      rescheduleEventId: 'rescheduled:CD1-PRA-RESCH-IDEM:2026-09-20:11:00 AM – 12:00 PM',
    });
    const first = await emitRescheduled(firstBooking, { prisma, env: SMS_ENV });
    const retry = await emitRescheduled(first.booking || firstBooking, { prisma, env: SMS_ENV });
    assert.equal(first.delivery.sms.queued, true);
    assert.equal(retry.skipped, true);
    const second = await emitRescheduled({
      ...first.booking,
      confirmedDate: '2026-09-22',
      confirmedTimeWindow: '8:00 AM – 9:00 AM',
      rescheduleEventId: 'rescheduled:CD1-PRA-RESCH-IDEM:2026-09-22:8:00 AM – 9:00 AM',
    }, { prisma, env: SMS_ENV });
    assert.equal(second.skipped, undefined);
    assert.equal(prisma._rows.size, 2);
  });

  it('rejected change emit is idempotent', async () => {
    const prisma = createMemoryOutboxPrisma();
    const row = booking({
      id: 'CD1-PRA-REJ-IDEM',
      __changeRequestId: 'cr_pra_rej_idem',
      __changeDecision: 'rejected',
    });
    const first = await emitChangeRejected(row, { prisma, env: SMS_ENV });
    const second = await emitChangeRejected(row, { prisma, env: SMS_ENV });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal([...prisma._rows.values()].filter((item) => item.templateKey === TEMPLATE_KEYS.CHANGE_REJECTED).length, 1);
  });
});

describe('segment budget and architecture freeze', () => {
  const cases = [
    {
      name: 'customer request + link',
      key: TEMPLATE_KEYS.REQUEST_RECEIVED,
      max: 2,
      data: bookingTemplateData(TEMPLATE_KEYS.REQUEST_RECEIVED, booking(), TYPICAL_URL),
    },
    {
      name: 'customer confirmed + link',
      key: TEMPLATE_KEYS.CONFIRMED,
      max: 2,
      data: bookingTemplateData(TEMPLATE_KEYS.CONFIRMED, booking({
        status: 'Confirmed',
        appointmentStatus: 'confirmed',
      }), TYPICAL_URL),
    },
    {
      name: 'customer reschedule request + link',
      key: TEMPLATE_KEYS.CHANGE_REQUESTED,
      max: 2,
      data: {
        ...bookingTemplateData(TEMPLATE_KEYS.CHANGE_REQUESTED, booking(), TYPICAL_URL),
        changeKind: 'reschedule',
      },
    },
    {
      name: 'admin new request',
      key: TEMPLATE_KEYS.ADMIN_BOOKING,
      max: 1,
      data: adminBookingTemplateData(booking()),
    },
    {
      name: 'admin reschedule request',
      key: TEMPLATE_KEYS.ADMIN_CHANGE_REQUEST,
      max: 1,
      data: {
        customerName: 'Alex Rivera',
        changeKind: 'reschedule',
        currentWhen: 'Sep 19, 2026 9:00 AM - 10:00 AM',
        requestedWhen: 'Sep 20, 2026 11:00 AM',
        vehicle: '2025 Harley-Davidson Road Glide',
      },
    },
    {
      name: 'admin cancel request',
      key: TEMPLATE_KEYS.ADMIN_CANCELLATION_REQUESTED,
      max: 1,
      data: {
        customerName: 'Alex Rivera',
        vehicle: '2025 Harley-Davidson Road Glide',
        date: '2026-09-19',
        window: '9:00 AM – 10:00 AM',
        bookingRef: 'CD1-LIFE-PRA-01',
      },
    },
  ];

  for (const fixture of cases) {
    it(`${fixture.name} stays GSM-7 within ${fixture.max} segment(s)`, () => {
      const rendered = renderSmsTemplate(fixture.key, fixture.data);
      const measure = measureSms(rendered.body);
      assert.equal(rendered.ok, true, rendered.error);
      assert.equal(measure.encoding, 'GSM-7', rendered.body);
      assert.ok(
        measure.segmentCount <= fixture.max,
        `${fixture.name} ${measure.segmentCount} segments (${measure.characterCount} chars): ${rendered.body}`
      );
    });
  }

  it('does not add payment-link SMS, Quick Ops, or a new provider', () => {
    const templates = read('netlify/lib/sms-templates.js');
    const lifecycle = read('netlify/lib/appointment-lifecycle-notifications.js');
    assert.doesNotMatch(templates, /payment.link|ops\/q\/|TWILIO_FROM/i);
    assert.doesNotMatch(lifecycle, /ops\/q\/|payment.link/i);
    assert.match(lifecycle, /enqueueAdminOpsSms/);
    assert.match(read('netlify/lib/twilio-provider.js'), /messagingServiceSid/);
    assert.doesNotMatch(read('netlify/lib/twilio-provider.js'), /from:/);
  });

  it('inbound STOP/START/HELP and status callback files stay in place', () => {
    const inbound = read('netlify/lib/twilio-inbound-handler.js');
    const callback = read('netlify/functions/twilio-status-callback.js');
    assert.match(inbound, /STOP_WORDS/);
    assert.match(inbound, /HELP_WORDS/);
    assert.match(inbound, /emptyTwiml/);
    assert.match(callback, /applyStatusCallback/);
    assert.match(read('netlify/lib/sms-outbox.js'), /STATUS_RANK/);
  });
});
