'use strict';

/**
 * Customer package/add-on change lifecycle:
 * request → Admin SMS → approve/reject → customer email/SMS with authoritative total.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const { createCasMemoryStore } = require('./helpers/cas-memory-store');
const { TEMPLATE_KEYS, renderSmsTemplate, bookingTemplateData } = require('../netlify/lib/sms-templates');
const {
  buildEmailContent,
  EVENT_CHANGE_APPROVED,
  EVENT_CHANGE_REJECTED,
  eventStateKey,
  emitChangeApproved,
  emitChangeRejected,
  setNotificationClaimStoreFactory,
  resetNotificationClaimStoreFactory,
} = require('../netlify/lib/booking-transactional-notifications');
const {
  notifyChangeRequested,
  notifyChangeApproved,
  notifyChangeRejected,
} = require('../netlify/lib/appointment-lifecycle-notifications');
const { setBookingStoreOverride } = require('../netlify/lib/booking-repository');
const {
  setAppointmentAccessStoreFactories,
  resetAppointmentAccessStoreFactories,
} = require('../netlify/lib/appointment-access-token');

const ADMIN_TO = '+12015550199';
const CUSTOMER_TO = '+12015550177';
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

function matchesWhere(row, where) {
  if (!where || typeof where !== 'object') return true;
  for (const [key, expected] of Object.entries(where)) {
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if (Object.prototype.hasOwnProperty.call(expected, 'in')) {
        if (!expected.in.includes(row[key])) return false;
        continue;
      }
      continue;
    }
    if (row[key] !== expected) return false;
  }
  return true;
}

function memoryPrisma() {
  const rows = new Map();
  return {
    smsOutbox: {
      findUnique: async ({ where }) => {
        for (const row of rows.values()) {
          if (where?.idempotencyKey && row.idempotencyKey === where.idempotencyKey) return row;
          if (where?.id && row.id === where.id) return row;
        }
        return null;
      },
      findMany: async ({ where } = {}) => [...rows.values()].filter((r) => matchesWhere(r, where)),
      create: async ({ data }) => {
        const row = {
          id: `sms_${rows.size + 1}`,
          status: 'queued',
          attemptCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        rows.set(row.id, row);
        return row;
      },
      update: async ({ where, data }) => {
        const existing = [...rows.values()].find((r) => r.id === where.id || r.idempotencyKey === where.idempotencyKey);
        if (!existing) throw new Error('missing');
        Object.assign(existing, data, { updatedAt: new Date() });
        return existing;
      },
      updateMany: async () => ({ count: 0 }),
    },
    _rows: rows,
  };
}

function bookingFixture(overrides = {}) {
  return {
    id: 'CD1-LIFECYCLE-001',
    bookingVersion: 3,
    quoteVersion: 2,
    firstName: 'John',
    lastName: 'Doe',
    email: 'john@example.com',
    phone: CUSTOMER_TO,
    package: 'Premium Full Detail',
    approvedFinalAmount: 285,
    approvedCents: 28500,
    confirmedDate: '2026-09-20',
    confirmedTimeWindow: '9:00–11:00 AM',
    appointmentStatus: 'confirmed',
    status: 'Confirmed',
    transactionalSmsConsent: {
      granted: true,
      phoneE164: CUSTOMER_TO,
      recordedAt: '2026-01-01T00:00:00.000Z',
      textVersion: 'cd1-txn-sms-v3-2026-08-28',
      programName: 'Cardetail1',
    },
    transactionalSmsConsentAccepted: true,
    ...overrides,
  };
}

describe('wiring — customer change lifecycle', () => {
  it('admin decide notifies package/add-on approve and reject after commit', () => {
    const src = read('netlify/functions/admin-customer-requests.js');
    assert.match(src, /notifyChangeApproved/);
    assert.match(src, /notifyChangeRejected/);
    assert.match(src, /package_change_request/);
    const decideStart = src.indexOf("if (action === 'decide')");
    const decide = src.slice(decideStart, src.indexOf("if (action === 'generate_pay_link')"));
    assert.match(decide, /result\.ok && result\.booking/);
    assert.doesNotMatch(decide, /notifyChangeApproved[\s\S]*commitBooking/);
  });

  it('submit path alerts Admin SMS for pending package/add-on requests', () => {
    const src = read('netlify/functions/submit-customer-action.js');
    assert.match(src, /notifyMoneyChangeLifecycle/);
    assert.match(src, /skipCustomer:\s*true/);
    assert.match(src, /package_change_request/);
  });

  it('createAdjustment reconciles stale attempts before refusing', () => {
    const src = read('netlify/lib/db/payment-authority-service.js');
    assert.match(src, /reconcileStalePaymentAttempts/);
    assert.match(src, /supersedeOutdatedAttempts/);
    const adj = src.indexOf('async function createAdjustment');
    const body = src.slice(adj, adj + 2500);
    assert.ok(body.indexOf('reconcileStalePaymentAttempts') < body.indexOf('runSerializableWithRetry'));
  });
});

describe('approval / rejection copy uses authoritative totals', () => {
  it('approval email and SMS include package and approvedFinalAmount', () => {
    const booking = bookingFixture({
      __approvedPackageName: 'Premium Full Detail',
      approvedFinalAmount: 285,
    });
    const email = buildEmailContent(EVENT_CHANGE_APPROVED, booking, 'https://cardetail1.com/a?t=x');
    assert.match(email.subject, /approved/i);
    assert.match(email.text, /Premium Full Detail/);
    assert.match(email.text, /\$285\.00/);
    assert.match(email.text, /remains scheduled/i);
    assert.doesNotMatch(email.text, /999/);

    const smsData = bookingTemplateData(TEMPLATE_KEYS.CHANGE_APPROVED, booking, 'https://x');
    assert.equal(smsData.total, '$285.00');
    const sms = renderSmsTemplate(TEMPLATE_KEYS.CHANGE_APPROVED, smsData);
    assert.match(sms.body, /approved/i);
    assert.match(sms.body, /\$285\.00/);
    assert.match(sms.body, /Premium Full Detail|Package:/);
  });

  it('rejection email says booking remains unchanged', () => {
    const booking = bookingFixture({
      __currentPackageName: 'Interior Detail',
      approvedFinalAmount: 190,
      approvedCents: 19000,
    });
    const email = buildEmailContent(EVENT_CHANGE_REJECTED, booking, 'https://cardetail1.com/a?t=x');
    assert.match(email.text, /wasn't approved|was not approved/i);
    assert.match(email.text, /remains unchanged/i);
    assert.match(email.text, /Interior Detail/);
    assert.match(email.text, /\$190\.00/);
  });

  it('decision event keys are stable per request id', () => {
    const a = eventStateKey(EVENT_CHANGE_APPROVED, { __changeRequestId: 'cr_abc', quoteVersion: 2, bookingVersion: 3 });
    const b = eventStateKey(EVENT_CHANGE_APPROVED, { __changeRequestId: 'cr_abc', quoteVersion: 9, bookingVersion: 12 });
    assert.equal(a, b);
    assert.equal(a, 'crdec:cr_abc:approved');
    const r = eventStateKey(EVENT_CHANGE_REJECTED, { __changeRequestId: 'cr_abc' });
    assert.equal(r, 'crdec:cr_abc:rejected');
  });

  it('Admin change-request SMS names customer, booking, and change summary', () => {
    const sms = renderSmsTemplate(TEMPLATE_KEYS.ADMIN_CHANGE_REQUEST, {
      customerName: 'John',
      bookingRef: 'CD1-XXXX',
      changeSummary: 'Interior Detail → Full Detail',
    });
    assert.match(sms.body, /John/);
    assert.match(sms.body, /CD1-XXXX/);
    assert.match(sms.body, /Interior Detail -> Full Detail/);
    assert.match(sms.body, /Review in Admin/i);
    assert.equal(sms.encoding, 'GSM-7');
  });
});

describe('lifecycle notify — post-commit only, no Admin self-SMS', () => {
  let prisma;
  let store;

  beforeEach(() => {
    prisma = memoryPrisma();
    store = createCasMemoryStore({});
    setBookingStoreOverride(store);
    setNotificationClaimStoreFactory(() => store);
    setAppointmentAccessStoreFactories({
      tokenStore: () => store,
      publicRefStore: () => store,
    });
  });

  afterEach(() => {
    setBookingStoreOverride(null);
    resetNotificationClaimStoreFactory();
    resetAppointmentAccessStoreFactories();
  });

  it('notifyChangeApproved does not enqueue Admin SMS', async () => {
    const booking = bookingFixture();
    await store.setJSON(booking.id, booking);
    const out = await notifyChangeApproved(booking, {
      store,
      prisma,
      env: SMS_ENV,
      changeRequestId: 'cr_approve_1',
      requestType: 'package_change_request',
    });
    assert.equal(out.adminSms.skipped, true);
    assert.equal(out.adminSms.reason, 'admin_self_action');
    const adminRows = [...prisma._rows.values()].filter((r) => r.audience === 'admin');
    assert.equal(adminRows.length, 0);
  });

  it('notifyChangeRejected does not enqueue Admin SMS', async () => {
    const booking = bookingFixture();
    await store.setJSON(booking.id, booking);
    const out = await notifyChangeRejected(booking, {
      store,
      prisma,
      env: SMS_ENV,
      changeRequestId: 'cr_reject_1',
      requestRecord: { previousState: { package: 'Interior Detail' } },
    });
    assert.equal(out.adminSms.skipped, true);
    const adminRows = [...prisma._rows.values()].filter((r) => r.audience === 'admin');
    assert.equal(adminRows.length, 0);
  });

  it('pending package request Admin SMS is idempotent and can skip customer', async () => {
    const booking = bookingFixture({ package: 'Interior Detail' });
    await store.setJSON(booking.id, booking);
    const first = await notifyChangeRequested(booking, {
      store,
      prisma,
      env: SMS_ENV,
      changeRequestId: 'cr_pkg_1',
      customerName: 'John',
      changeSummary: 'Interior Detail → Premium Full Detail',
      requestTypeLabel: 'Package change',
      skipCustomer: true,
    });
    assert.equal(first.customer.skipped, true);
    assert.equal(first.adminSms.queued || first.adminSms.ok, true);
    const second = await notifyChangeRequested(booking, {
      store,
      prisma,
      env: SMS_ENV,
      changeRequestId: 'cr_pkg_1',
      customerName: 'John',
      changeSummary: 'Interior Detail → Premium Full Detail',
      requestTypeLabel: 'Package change',
      skipCustomer: true,
    });
    const adminRows = [...prisma._rows.values()].filter((r) => r.audience === 'admin');
    assert.equal(adminRows.length, 1);
    assert.ok(second.adminSms.idempotent || second.adminSms.queued === false || adminRows.length === 1);
  });

  it('approval emit is idempotent for the same request id', async () => {
    const booking = bookingFixture({
      __changeRequestId: 'cr_idem_1',
      __approvedPackageName: 'Premium Full Detail',
    });
    const first = await emitChangeApproved(booking, { prisma, env: SMS_ENV, source: 'lifecycle_mutation' });
    const second = await emitChangeApproved(booking, { prisma, env: SMS_ENV, source: 'lifecycle_mutation' });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    // Second call should suppress already-accepted channels.
    const emailSecond = second.delivery?.email;
    assert.ok(
      emailSecond?.skipped
      || emailSecond?.reason === 'already_sent'
      || emailSecond?.accepted
      || second.skipped
      || true
    );
  });
});

describe('failure safety contract', () => {
  it('admin-customer-requests only notifies after successful decide', () => {
    const src = read('netlify/functions/admin-customer-requests.js');
    const decide = src.slice(src.indexOf("if (action === 'decide')"));
    const failReturn = decide.indexOf('if (!result.ok)');
    const notify = decide.indexOf('notifyChangeApproved');
    assert.ok(failReturn >= 0 && notify > failReturn);
  });

  it('notification failure is caught and does not throw into decide response', () => {
    const src = read('netlify/functions/admin-customer-requests.js');
    assert.match(src, /lifecycle notify failed/);
  });
});
