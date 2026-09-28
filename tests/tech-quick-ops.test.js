'use strict';

const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { createCasMemoryStore } = require('./helpers/cas-memory-store');
const { setBookingStoreOverride, getBookingRecord } = require('../netlify/lib/booking-repository');
const { setSlotIndexStoreOverride } = require('../netlify/lib/slot-index');
const { projectQuickOpsBooking } = require('../netlify/lib/admin-quick-ops-view');
const { projectTechQuickOpsBooking } = require('../netlify/lib/tech-quick-ops-view');
const { quickOpsPage, techQuickOpsPage } = require('../netlify/lib/quick-ops-html');
const { buildPaymentCompatibilityPatch } = require('../netlify/lib/db/operational-payment');
const { renderSmsTemplate, TEMPLATE_KEYS } = require('../netlify/lib/sms-templates');
const { canonicalBookingSmsConsent } = require('../netlify/lib/sms-program');
const {
  setPaymentResumeStoreFactory,
  resetPaymentResumeStoreFactory,
} = require('../netlify/lib/payment-resume-token');
const {
  setQuickOpsSmsRuntime,
  resetQuickOpsSmsRuntime,
} = require('../netlify/lib/admin-quick-ops-actions');
const { recordTechExtra, applyCustomerApprovedExtra } = require('../netlify/lib/quick-ops-price');
const { decideAdjustment } = require('../netlify/lib/price-adjustments');
const { financialProjection, reconcileCustomerBalanceSession } = require('../netlify/lib/payment-service');
const { moneyFromBooking } = require('../netlify/lib/admin-quick-ops-view');
const { buildIdempotencyKey } = require('../netlify/lib/db/payment-authority-service');
const { chargeEligibility } = require('../netlify/lib/charge-saved-card-after-service');
const { normalizeAggregate } = require('../netlify/lib/booking-aggregate');
const {
  PURPOSE_TECH_QUICK_OPS,
  TOKEN_PREFIX: TECH_PREFIX,
  COOKIE_NAME: TECH_COOKIE,
  createTechQuickOpsToken,
  loadTechQuickOpsToken,
  setTechQuickOpsStoreFactories,
  resetTechQuickOpsStoreFactories,
} = require('../netlify/lib/tech-quick-ops-token');
const { TOKEN_PREFIX: ADMIN_PREFIX } = require('../netlify/lib/admin-quick-ops-token');
const {
  assignQuickOpsTech,
  unassignQuickOpsTech,
  retryQuickOpsTechNotification,
  listAssignableTechs,
  setQuickOpsTechRoster,
  resetQuickOpsTechRoster,
} = require('../netlify/lib/quick-ops-assign');
const { suppressPhone, clearSuppression } = require('../netlify/lib/sms-suppression');
const { adjustQuickOpsPrice, scaleTechPayout, setTechnicianPay } = require('../netlify/lib/quick-ops-price');
const techHandler = require('../netlify/functions/tech-quick-ops');
const adminHandler = require('../netlify/functions/admin-quick-ops');
const {
  createQuickOpsSession,
  COOKIE_NAME: ADMIN_COOKIE,
  setQuickOpsStoreFactories,
  resetQuickOpsStoreFactories,
} = require('../netlify/lib/admin-quick-ops-token');

const SECRET = 'test-admin-quick-ops-secret-32chars';
const TEST_FORWARD_CALLS_TO = '+12025550123';

function testForwardCallsDigits() {
  const digits = TEST_FORWARD_CALLS_TO.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

function testForwardCallsLabel() {
  const ten = testForwardCallsDigits();
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function booking(overrides = {}) {
  return {
    id: 'CD1-TQ-01',
    firstName: 'Alex',
    lastName: 'Rivera',
    email: 'alex.rivera@example.test',
    phone: '+12015550177',
    package: 'Interior Detail',
    preferredDate: '2026-09-19',
    preferredTime: '9:00 AM - 10:00 AM',
    confirmedDate: '2026-09-19',
    confirmedTimeWindow: '9:00 AM - 10:00 AM',
    address: '12 Harbor View, Fort Lee, NJ',
    status: 'Pending Review',
    appointmentStatus: 'pending_review',
    jobStatus: 'pending_review',
    bookingVersion: 1,
    quoteVersion: 1,
    approvedFinalAmount: 190,
    totalPrice: 190,
    techPayoutAmount: 120,
    notes: 'Gate code 12',
    vehicles: [{ year: 2025, make: 'Honda', model: 'Civic', category: 'cars' }],
    ledger: { currency: 'usd', approvedCents: 19000, settledCents: 0, creditedCents: 0, entries: [] },
    transactionalSmsConsentAccepted: true,
    changeRequests: [],
    ...overrides,
  };
}

function roster() {
  return [
    { techId: 'sam', fullName: 'Sam Lee', active: true, phone: '2015550199', smsConsent: true },
    { techId: 'inactive', fullName: 'Idle Tech', active: false, phone: '2015550100' },
  ];
}

function smsDispatchEnv() {
  return {
    CONTEXT: 'production',
    BRANCH: 'master',
    URL: 'https://cardetail1.com',
    TWILIO_OUTBOX_ENABLED: 'true',
    TWILIO_ENABLED: 'true',
    TWILIO_PRODUCTION_SENDS_ENABLED: 'true',
    TWILIO_ACCOUNT_SID: 'AC0000000000',
    TWILIO_API_KEY: 'SK0000000000',
    TWILIO_API_SECRET: 'test-secret',
    TWILIO_MESSAGING_SERVICE_SID: 'MG0000000000',
    TWILIO_STATUS_CALLBACK_URL: 'https://cardetail1.com/.netlify/functions/twilio-status-callback',
  };
}

function memorySmsOutbox() {
  const rows = new Map();
  const prisma = {
    smsOutbox: {
      async findUnique({ where }) {
        for (const row of rows.values()) {
          if (where && where.id && row.id === where.id) return row;
          if (where && where.idempotencyKey && row.idempotencyKey === where.idempotencyKey) return row;
        }
        return null;
      },
      async create({ data }) {
        const row = {
          id: `sms_${rows.size + 1}`,
          attemptCount: 0,
          providerMessageSid: null,
          createdAt: new Date(),
          availableAt: new Date(),
          ...data,
        };
        rows.set(row.id, row);
        return row;
      },
      async update({ where, data }) {
        const row = [...rows.values()].find((item) => item.id === where.id);
        if (!row) throw new Error('missing');
        Object.assign(row, data);
        return row;
      },
      async updateMany({ where, data }) {
        const row = rows.get(where.id);
        if (!row || row.status !== where.status || row.providerMessageSid) return { count: 0 };
        row.attemptCount = (row.attemptCount || 0) + (data.attemptCount && data.attemptCount.increment || 1);
        row.leaseToken = data.leaseToken;
        row.leaseExpiresAt = data.leaseExpiresAt;
        return { count: 1 };
      },
    },
  };
  return { rows, prisma };
}

before(() => {
  process.env.PUBLIC_SITE_URL = 'https://cardetail1.com';
  process.env.CONTEXT = 'production';
  process.env.ADMIN_QUICK_OPS_SECRET = SECRET;
  process.env.PAYMENT_RESUME_SECRET = 'test-payment-resume-secret-32';
  process.env.CD1_POSTGRES_PAYMENT = 'false';
});

beforeEach(() => {
  const tokenStore = createCasMemoryStore();
  const sessionStore = createCasMemoryStore();
  const adminTokenStore = createCasMemoryStore();
  const adminSessionStore = createCasMemoryStore();
  setTechQuickOpsStoreFactories({
    tokenStore: () => tokenStore,
    sessionStore: () => sessionStore,
  });
  setQuickOpsStoreFactories({
    tokenStore: () => adminTokenStore,
    sessionStore: () => adminSessionStore,
  });
  setQuickOpsTechRoster(async () => roster());
  setBookingStoreOverride(createCasMemoryStore({ 'CD1-TQ-01': booking() }));
  setSlotIndexStoreOverride(createCasMemoryStore());
});

afterEach(() => {
  resetTechQuickOpsStoreFactories();
  resetQuickOpsStoreFactories();
  resetQuickOpsTechRoster();
  resetQuickOpsSmsRuntime();
  resetPaymentResumeStoreFactory();
  setBookingStoreOverride(null);
  setSlotIndexStoreOverride(null);
});

describe('tech quick ops access', () => {
  it('keeps the technician link separate from admin quick ops', () => {
    assert.equal(PURPOSE_TECH_QUICK_OPS, 'tech_quick_ops');
    assert.equal(TECH_PREFIX, 'tqt_');
    assert.notEqual(TECH_PREFIX, ADMIN_PREFIX);
  });

  it('shows assign and the payout warning on admin quick ops', () => {
    const view = projectQuickOpsBooking(booking());
    assert.equal(view.actions.assign, true);
    assert.equal(view.actions.adjust, true);
    assert.equal(view.money.payoutLabel, '$120');
    const html = quickOpsPage(view, 'csrf-token');
    assert.match(html.body, /Assign technician/);
    assert.match(html.body, /No technician is assigned/);
    assert.match(html.body, /id="qo-unassign"[^>]*hidden/);
    assert.match(html.body, /lowers the technician payout/);
    assert.match(html.body, /Freelance phone/);
    const assigned = projectQuickOpsBooking(booking({
      assignmentKind: 'freelance',
      freelancePhone: TEST_FORWARD_CALLS_TO,
      assignedTechName: 'Freelance Tech',
      quickOpsTechClose: true,
    }));
    assert.equal(assigned.assignment.label, testForwardCallsLabel());
    const assignedHtml = quickOpsPage(assigned, 'csrf-token');
    assert.match(assignedHtml.body, new RegExp(`Assigned to ${escapeRegExp(testForwardCallsLabel())}`));
    assert.match(assignedHtml.body, /Remove assignment/);
    assert.doesNotMatch(assignedHtml.body, /id="qo-unassign"[^>]*hidden/);
    const named = projectQuickOpsBooking(booking({
      assignmentKind: 'registered',
      assignedTechId: 'pat',
      assignedTechName: 'Pat Diaz',
    }));
    assert.equal(named.assignment.label, 'Pat Diaz');
  });

  it('shows the technician only the office pay, not the customer total', () => {
    const row = booking({
      assignmentKind: 'freelance',
      freelancePhone: '+12015550123',
      quickOpsTechClose: true,
      ceramic: { internal: { internalSku: 'SECRET-SKU', coatingProduct: 'Hidden product' } },
      serviceFamily: 'ceramic_coating',
    });
    const view = projectTechQuickOpsBooking(row);
    assert.equal(view.customer.name, 'Alex Rivera');
    assert.equal(view.customer.phone, undefined);
    assert.equal(view.money, undefined);
    assert.equal(view.actions.cash, undefined);
    assert.equal(view.actions.card, undefined);
    assert.equal(view.yourPay.label, '$120');
    const html = techQuickOpsPage(view, 'csrf-token');
    assert.match(html.body, /12 Harbor View/);
    assert.match(html.body, /Alex Rivera/);
    assert.match(html.body, /Your pay/);
    assert.match(html.body, /\$120/);
    assert.match(html.body, /Text payment link/);
    assert.doesNotMatch(html.body, /\$190|Record cash|Record card|Approved|Confirm appointment|SECRET-SKU|Hidden product|alex\.rivera/);
    const adminHtml = quickOpsPage(projectQuickOpsBooking(row), 'csrf-token');
    assert.match(adminHtml.body, /Technician pay/);
    assert.match(adminHtml.body, /\$190/);
  });

  it('assigns a roster technician a booking-scoped link', async () => {
    const result = await assignQuickOpsTech(booking(), { techId: 'sam', skipSms: true });
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'registered');
    assert.match(result.techUrl, /^https:\/\/cardetail1\.com\/ops\/t\/tqt_/);
    const saved = await getBookingRecord('CD1-TQ-01');
    assert.equal(saved.booking.assignedTechId, 'sam');
    assert.equal(saved.booking.assignmentKind, 'registered');
    assert.equal(saved.booking.quickOpsTechClose, false);
    assert.equal(saved.booking.techLinkPhone, '+12015550199');
    assert.ok(saved.booking.techQuickOpsTokenHash);
    assert.equal(saved.booking.jobStatus, 'assigned');
  });

  it('sends a freelance phone a basic link and revokes it on reassignment', async () => {
    const first = await assignQuickOpsTech(booking(), { phone: '(201) 555-0123', skipSms: true });
    assert.equal(first.ok, true, first.message || first.error);
    assert.equal(first.kind, 'freelance');
    assert.match(first.techUrl, /^https:\/\/cardetail1\.com\/ops\/t\/tqt_/);
    assert.doesNotMatch(first.techUrl, /Alex|Harbor|Rivera/);
    const saved = await getBookingRecord('CD1-TQ-01');
    assert.equal(saved.booking.quickOpsTechClose, true);
    assert.equal(saved.booking.freelancePhone, '+12015550123');
    assert.equal(saved.booking.assignedTechId, null);

    const token = first.techUrl.split('/').pop();
    const loaded = await loadTechQuickOpsToken(decodeURIComponent(token));
    assert.equal(loaded.ok, true);

    const second = await assignQuickOpsTech(saved.booking, { phone: '2015550124', skipSms: true });
    assert.equal(second.ok, true, second.error);
    assert.equal(second.kind, 'freelance');
    const revoked = await loadTechQuickOpsToken(decodeURIComponent(token));
    assert.equal(revoked.ok, false);
    const again = await getBookingRecord('CD1-TQ-01');
    assert.equal(again.booking.freelancePhone, '+12015550124');
  });

  it('uses the roster when the typed phone already belongs to a technician', async () => {
    const result = await assignQuickOpsTech(booking(), { phone: '201-555-0199', skipSms: true });
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'registered');
    assert.equal(result.assignedTechId, 'sam');
    const techs = await listAssignableTechs();
    assert.deepEqual(techs.map((row) => row.techId), ['sam']);
    assert.equal(techs[0].phone, undefined);
  });

  it('requires a note and lowers payout by the same share', async () => {
    const missing = await adjustQuickOpsPrice(booking(), { type: 'decrease', amountDollars: '20', reason: 'short' });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'reason_required');

    const scaled = scaleTechPayout(booking(), 19000, 17000);
    assert.equal(scaled.afterCents, Math.round(12000 * 17000 / 19000));
    assert.ok(scaled.afterCents < scaled.beforeCents);

    const result = await adjustQuickOpsPrice(booking(), {
      type: 'decrease',
      amountDollars: '20.00',
      reason: 'Customer removed the pet-hair add-on',
    });
    assert.equal(result.ok, true, result.error || result.message);
    assert.match(result.message, /payout dropped/);
    const saved = await getBookingRecord('CD1-TQ-01');
    assert.equal(saved.booking.ledger.approvedCents, 17000);
    assert.equal(saved.booking.techPayoutAmount, scaled.afterCents / 100);
    assert.ok(saved.booking.quoteVersion > 1);

    const tooFar = await adjustQuickOpsPrice(booking({
      ledger: { approvedCents: 19000, settledCents: 15000, creditedCents: 0, entries: [] },
      bookingVersion: 1,
    }), {
      type: 'decrease',
      amountDollars: '50',
      reason: 'Trying to cut below cash already collected',
    });
    assert.equal(tooFar.ok, false);
    assert.equal(tooFar.error, 'decrease_below_paid');
  });

  it('stores the office technician pay without changing the customer total', async () => {
    const result = await setTechnicianPay(booking(), { amountDollars: '80' });
    assert.equal(result.ok, true, result.error || result.message);
    assert.match(result.message, /\$80/);
    const saved = await getBookingRecord('CD1-TQ-01');
    assert.equal(saved.booking.techPayoutAmount, 80);
    assert.equal(saved.booking.ledger.approvedCents, 19000);
    const tooHigh = await setTechnicianPay(saved.booking, { amountDollars: '500' });
    assert.equal(tooHigh.ok, false);
    assert.equal(tooHigh.error, 'payout_exceeds_job');
  });

  it('closes a freelance job when the customer payment lands', () => {
    const patch = buildPaymentCompatibilityPatch(booking({
      assignmentKind: 'freelance',
      quickOpsTechClose: true,
      jobStatus: 'assigned',
    }), {
      quoteVersion: 1,
      approvedCents: 19000,
      settledCents: 19000,
      refundedCents: 0,
      remainingCents: 0,
      paymentStatus: 'paid',
      paidAt: '2026-09-19T18:00:00.000Z',
    });
    assert.equal(patch.jobStatus, 'completed_paid');
    assert.equal(patch.completionSource, 'tech_quick_ops_payment');
    assert.equal(patch.serviceStatus, 'completed');

    const registered = buildPaymentCompatibilityPatch(booking({
      assignmentKind: 'registered',
      quickOpsTechClose: false,
      jobStatus: 'assigned',
    }), {
      approvedCents: 19000,
      settledCents: 19000,
      remainingCents: 0,
      paymentStatus: 'paid',
    });
    assert.equal(registered.jobStatus, undefined);
  });

  it('opens the freelance link and refuses admin actions', async () => {
    const assigned = await assignQuickOpsTech(booking(), { phone: '2015550123', skipSms: true });
    const token = decodeURIComponent(assigned.techUrl.split('/').pop());
    const opened = await techHandler.handler({
      httpMethod: 'GET',
      path: `/ops/t/${token}`,
      rawUrl: `https://cardetail1.com/ops/t/${token}`,
      headers: { host: 'cardetail1.com', accept: 'text/html' },
    });
    assert.equal(opened.statusCode, 302);
    assert.match(opened.headers['Set-Cookie'], new RegExp(TECH_COOKIE));
    const cookie = String(opened.headers['Set-Cookie']).split(';')[0];
    const page = await techHandler.handler({
      httpMethod: 'GET',
      path: '/ops/t',
      headers: { cookie, host: 'cardetail1.com', accept: 'application/json' },
    });
    assert.equal(page.statusCode, 200);
    const body = JSON.parse(page.body);
    assert.equal(body.view.customer.name, 'Alex Rivera');
    assert.equal(body.view.service.address, '12 Harbor View, Fort Lee, NJ');
    assert.equal(body.view.actions.cash, undefined);
    assert.equal(body.view.actions.confirm, undefined);
    assert.equal(body.view.yourPay.label, '$120');
    assert.doesNotMatch(page.body, /19000|\$190/);

    const used = await techHandler.handler({
      httpMethod: 'GET',
      path: `/ops/t/${token}`,
      rawUrl: `https://cardetail1.com/ops/t/${token}`,
      headers: { host: 'cardetail1.com', accept: 'application/json' },
    });
    assert.equal(used.statusCode, 400);
    assert.doesNotMatch(used.body, /Alex|Harbor/);

    const denied = await techHandler.handler({
      httpMethod: 'POST',
      path: '/ops/t',
      headers: {
        cookie,
        host: 'cardetail1.com',
        'content-type': 'application/json',
        'x-tq-csrf': body.csrfToken,
      },
      body: JSON.stringify({ action: 'confirm' }),
    });
    assert.equal(denied.statusCode, 400);

    const cash = await techHandler.handler({
      httpMethod: 'POST',
      path: '/ops/t',
      headers: {
        cookie,
        host: 'cardetail1.com',
        'content-type': 'application/json',
        'x-tq-csrf': body.csrfToken,
      },
      body: JSON.stringify({ action: 'record_cash', bookingVersion: body.view.bookingVersion }),
    });
    assert.equal(cash.statusCode, 400);

    const added = await techHandler.handler({
      httpMethod: 'POST',
      path: '/ops/t',
      headers: {
        cookie,
        host: 'cardetail1.com',
        'content-type': 'application/json',
        'x-tq-csrf': body.csrfToken,
      },
      body: JSON.stringify({
        action: 'adjust_price',
        type: 'increase',
        amountDollars: '20',
        reason: 'Extra pet hair in the cabin',
        bookingVersion: body.view.bookingVersion,
      }),
    });
    assert.equal(added.statusCode, 200, added.body);
    const addedBody = JSON.parse(added.body);
    assert.match(addedBody.message, /\$20/);
    assert.match(addedBody.message, /waiting for customer approval/);
    assert.doesNotMatch(addedBody.message, /\$140|payment link sent|Payment link texted/);
    assert.doesNotMatch(added.body, /19000|21000|payout dropped/);
    const after = await getBookingRecord('CD1-TQ-01');
    assert.equal(after.booking.ledger.approvedCents, 19000);
    assert.equal(after.booking.techPayoutAmount, 120);
    assert.equal(after.booking.priceAdjustments.length, 1);
    assert.equal(after.booking.priceAdjustments[0].status, 'pending_customer');
    assert.equal(after.booking.priceAdjustments[0].amountCents, 2000);
    assert.equal(after.booking.priceAdjustments[0].createdBy, 'tech_quick_ops');

    const adminToken = `${ADMIN_PREFIX}${'a'.repeat(40)}`;
    const wrong = await techHandler.handler({
      httpMethod: 'GET',
      path: `/ops/t/${adminToken}`,
      headers: { accept: 'application/json', host: 'cardetail1.com' },
    });
    assert.equal(wrong.statusCode, 401);
    assert.doesNotMatch(wrong.body, /Alex|Harbor/);
  });

  it('assigns from the admin quick ops session', async () => {
    const session = await createQuickOpsSession({ bookingId: 'CD1-TQ-01' });
    const res = await adminHandler.handler({
      httpMethod: 'POST',
      path: '/ops/q',
      headers: {
        cookie: `${ADMIN_COOKIE}=${encodeURIComponent(session.sessionId)}`,
        host: 'cardetail1.com',
        'content-type': 'application/json',
        'x-qo-csrf': session.csrfToken,
      },
      body: JSON.stringify({ action: 'assign_tech', phone: '2015550123' }),
    });
    assert.equal(res.statusCode, 200, res.body);
    const payload = JSON.parse(res.body);
    assert.equal(payload.kind, 'freelance');
    assert.match(payload.techUrl, /\/ops\/t\/tqt_/);
    assert.equal(payload.assignment.label, '(201) 555-0123');
    const saved = await getBookingRecord('CD1-TQ-01');
    assert.equal(saved.booking.assignmentKind, 'freelance');

    const removed = await adminHandler.handler({
      httpMethod: 'POST',
      path: '/ops/q',
      headers: {
        cookie: `${ADMIN_COOKIE}=${encodeURIComponent(session.sessionId)}`,
        host: 'cardetail1.com',
        'content-type': 'application/json',
        'x-qo-csrf': session.csrfToken,
      },
      body: JSON.stringify({ action: 'unassign_tech' }),
    });
    assert.equal(removed.statusCode, 200, removed.body);
    const removedBody = JSON.parse(removed.body);
    assert.match(removedBody.message, /Removed \(201\) 555-0123/);
    assert.equal(removedBody.assignment.assigned, false);
    const after = await getBookingRecord('CD1-TQ-01');
    assert.equal(after.booking.freelancePhone, null);
    assert.equal(after.booking.assignmentKind, null);
  });

  it('texts a saved technician and a freelance phone immediately', async () => {
    const rows = new Map();
    const prisma = {
      smsOutbox: {
        async findUnique({ where }) {
          for (const row of rows.values()) {
            if (where && where.id && row.id === where.id) return row;
            if (where && where.idempotencyKey && row.idempotencyKey === where.idempotencyKey) return row;
          }
          return null;
        },
        async create({ data }) {
          const row = {
            id: `sms_${rows.size + 1}`,
            attemptCount: 0,
            providerMessageSid: null,
            createdAt: new Date(),
            ...data,
          };
          rows.set(row.id, row);
          return row;
        },
        async update({ where, data }) {
          const row = [...rows.values()].find((item) => item.id === where.id);
          if (!row) throw new Error('missing');
          Object.assign(row, data);
          return row;
        },
        async updateMany({ where, data }) {
          const row = rows.get(where.id);
          if (!row || row.status !== where.status || row.providerMessageSid) return { count: 0 };
          row.attemptCount = (row.attemptCount || 0) + (data.attemptCount && data.attemptCount.increment || 1);
          row.leaseToken = data.leaseToken;
          row.leaseExpiresAt = data.leaseExpiresAt;
          return { count: 1 };
        },
      },
    };
    const sent = [];
    const provider = {
      ok: true,
      async send({ to, body }) {
        sent.push({ to, body });
        return { sid: `SM${'a'.repeat(32)}`, status: 'sent' };
      },
    };
    const env = {
      CONTEXT: 'production',
      BRANCH: 'master',
      URL: 'https://cardetail1.com',
      TWILIO_OUTBOX_ENABLED: 'true',
      TWILIO_ENABLED: 'true',
      TWILIO_PRODUCTION_SENDS_ENABLED: 'true',
      TWILIO_ACCOUNT_SID: 'AC0000000000',
      TWILIO_API_KEY: 'SK0000000000',
      TWILIO_API_SECRET: 'test-secret',
      TWILIO_MESSAGING_SERVICE_SID: 'MG0000000000',
      TWILIO_STATUS_CALLBACK_URL: 'https://cardetail1.com/.netlify/functions/twilio-status-callback',
    };
    setQuickOpsTechRoster(async () => [{
      techId: 'pat',
      fullName: 'Pat Diaz',
      active: true,
      phone: testForwardCallsDigits(),
      smsConsent: false,
    }]);

    const saved = await assignQuickOpsTech(booking(), {
      techId: 'pat',
      prisma,
      env,
      provider,
    });
    assert.equal(saved.ok, true, saved.message);
    assert.equal(saved.kind, 'registered');
    assert.equal(saved.sms.sent, true, JSON.stringify(saved.sms && (saved.sms.reason || saved.sms.error)));
    assert.equal(saved.message, 'Assigned — notification sent');
    assert.doesNotMatch(saved.message, /delivered/i);
    assert.match(saved.techUrl, /\/ops\/t\/tqt_/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, TEST_FORWARD_CALLS_TO);
    assert.match(sent[0].body, /Interior Detail/);
    assert.match(sent[0].body, /Open: https:\/\/cardetail1\.com\/ops\/t\/tqt_/);
    assert.doesNotMatch(sent[0].body, /Alex|Rivera|\$|190|120|Harbor|2015550177|\+12015550177/);
    const queuedSaved = await getBookingRecord('CD1-TQ-01');
    assert.equal(queuedSaved.booking.techNotifyStatus, 'sent');
    assert.equal(queuedSaved.booking.assignmentKind, 'registered');

    const afterSaved = await getBookingRecord('CD1-TQ-01');
    const matched = await assignQuickOpsTech(afterSaved.booking, {
      phone: testForwardCallsDigits(),
      prisma,
      env,
      provider,
    });
    assert.equal(matched.ok, true, matched.message);
    assert.equal(matched.idempotent, true);
    assert.equal(matched.kind, 'registered');
    assert.equal(matched.sms.sent, true);
    assert.equal(sent.length, 1);

    setQuickOpsTechRoster(async () => []);
    const afterMatch = await getBookingRecord('CD1-TQ-01');
    const typed = await assignQuickOpsTech(afterMatch.booking, {
      phone: testForwardCallsLabel(),
      prisma,
      env,
      provider,
    });
    assert.equal(typed.ok, true, typed.message);
    assert.equal(typed.kind, 'freelance');
    assert.equal(typed.sms.sent, true, JSON.stringify(typed.sms && (typed.sms.reason || typed.sms.error)));
    assert.equal(typed.message, 'Assigned — notification sent');
    assert.equal(sent.length, 2);
    assert.equal(sent[1].to, TEST_FORWARD_CALLS_TO);
    assert.match(sent[1].body, /\/ops\/t\/tqt_/);
    assert.doesNotMatch(sent[1].body, /Alex|Rivera|\$/);
  });

  it('removes the assignment so the job can go to someone else', async () => {
    const first = await assignQuickOpsTech(booking(), { phone: testForwardCallsDigits(), skipSms: true });
    assert.equal(first.ok, true, first.message || first.error);
    assert.equal(first.kind, 'freelance');
    assert.equal(first.assignment.label, testForwardCallsLabel());
    const token = first.techUrl.split('/').pop();
    assert.equal((await loadTechQuickOpsToken(decodeURIComponent(token))).ok, true);

    const removed = await unassignQuickOpsTech(first.booking);
    assert.equal(removed.ok, true, removed.message || removed.error);
    assert.match(removed.message, new RegExp(`Removed ${escapeRegExp(testForwardCallsLabel())}`));
    assert.equal(removed.assignment.assigned, false);
    const cleared = await getBookingRecord('CD1-TQ-01');
    assert.equal(cleared.booking.assignedTechId, null);
    assert.equal(cleared.booking.freelancePhone, null);
    assert.equal(cleared.booking.assignmentKind, null);
    assert.equal(cleared.booking.quickOpsTechClose, false);
    assert.equal(cleared.booking.jobStatus, 'confirmed');
    assert.equal(cleared.booking.techLinkPhone, null);
    assert.equal(cleared.booking.techNotifyStatus, null);
    assert.equal(cleared.booking.techNotifyKey, null);
    assert.equal(cleared.booking.techQuickOpsTokenHash, null);
    assert.equal((await loadTechQuickOpsToken(decodeURIComponent(token))).ok, false);

    const again = await unassignQuickOpsTech(cleared.booking);
    assert.equal(again.ok, true);
    assert.equal(again.idempotent, true);

    const next = await assignQuickOpsTech(cleared.booking, { techId: 'sam', skipSms: true });
    assert.equal(next.ok, true, next.message || next.error);
    assert.equal(next.kind, 'registered');
    assert.equal(next.assignment.label, 'Sam Lee');
    assert.match(next.techUrl, /\/ops\/t\/tqt_/);
    const saved = await getBookingRecord('CD1-TQ-01');
    assert.equal(saved.booking.assignedTechId, 'sam');
    assert.equal(saved.booking.quickOpsTechClose, false);
    assert.equal(saved.booking.techLinkPhone, '+12015550199');
    const reopened = await techHandler.handler({
      httpMethod: 'GET',
      path: `/ops/t/${decodeURIComponent(next.techUrl.split('/').pop())}`,
      headers: { host: 'cardetail1.com', accept: 'application/json' },
    });
    assert.equal(reopened.statusCode, 302);
  });

  it('renders the technician job text', () => {
    const rendered = renderSmsTemplate(TEMPLATE_KEYS.TECH_JOB_LINK, {
      service: 'Interior Detail',
      date: '2026-09-19',
      window: '9:00 AM - 10:00 AM',
      place: '12 Harbor View, Fort Lee, NJ',
      city: 'Fort Lee',
      phone: '+12015550177',
      url: 'https://cardetail1.com/ops/t/tqt_example',
    });
    assert.equal(rendered.ok, true);
    assert.match(rendered.body, /Sep 19, 2026/);
    assert.match(rendered.body, /Interior Detail/);
    assert.match(rendered.body, /Fort Lee/);
    assert.match(rendered.body, /Open: https:\/\/cardetail1\.com\/ops\/t\/tqt_example/);
    assert.match(rendered.body, /Reply STOP/);
    assert.doesNotMatch(rendered.body, /Harbor|2015550177|Alex|Rivera|\$|Job assigned/);
  });

  it('rejects an invalid freelance number before saving an assignment', async () => {
    const result = await assignQuickOpsTech(booking(), { phone: '123', skipSms: true });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'invalid_phone');
    const saved = await getBookingRecord('CD1-TQ-01');
    assert.equal(saved.booking.bookingVersion, 1);
    assert.equal(saved.booking.assignedTechId, undefined);
    assert.equal(saved.booking.techQuickOpsTokenHash, undefined);
  });

  it('keeps a registered assignment when the account has no phone', async () => {
    setQuickOpsTechRoster(async () => [{ techId: 'nope', fullName: 'No Phone', active: true }]);
    const result = await assignQuickOpsTech(booking(), { techId: 'nope' });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.notification, 'failed');
    assert.equal(result.message, 'Assigned — notification failed');
    assert.equal(result.techUrl, undefined);
    const saved = await getBookingRecord('CD1-TQ-01');
    assert.equal(saved.booking.assignedTechId, 'nope');
    assert.equal(saved.booking.techQuickOpsTokenHash, null);
    assert.equal(saved.booking.techNotifyStatus, 'failed');
  });

  it('opens only the job assigned to that technician', async () => {
    setBookingStoreOverride(createCasMemoryStore({
      'CD1-TQ-01': booking(),
      'CD1-TQ-02': booking({
        id: 'CD1-TQ-02',
        address: '99 Other Road, Newark, NJ',
        firstName: 'Blair',
        lastName: 'Chen',
      }),
    }));
    const first = await assignQuickOpsTech(booking(), { techId: 'sam', skipSms: true });
    const second = await assignQuickOpsTech(booking({ id: 'CD1-TQ-02', address: '99 Other Road, Newark, NJ' }), {
      phone: '2015550123',
      skipSms: true,
    });
    assert.equal(first.ok, true, first.error);
    assert.equal(second.ok, true, second.error);
    const token = decodeURIComponent(first.techUrl.split('/').pop());
    const opened = await techHandler.handler({
      httpMethod: 'GET',
      path: `/ops/t/${token}`,
      headers: { host: 'cardetail1.com', accept: 'application/json' },
    });
    assert.equal(opened.statusCode, 302);
    const cookie = String(opened.headers['Set-Cookie']).split(';')[0];
    const page = await techHandler.handler({
      httpMethod: 'GET',
      path: '/ops/t',
      headers: { cookie, host: 'cardetail1.com', accept: 'application/json' },
    });
    assert.equal(page.statusCode, 200);
    const body = JSON.parse(page.body);
    assert.equal(body.view.bookingId, 'CD1-TQ-01');
    assert.equal(body.view.service.address, '12 Harbor View, Fort Lee, NJ');
    assert.doesNotMatch(page.body, /Newark|Blair/);

    const reused = await techHandler.handler({
      httpMethod: 'GET',
      path: `/ops/t/${token}`,
      headers: { host: 'cardetail1.com', accept: 'application/json' },
    });
    assert.equal(reused.statusCode, 400);

    const foreign = await createTechQuickOpsToken({
      bookingId: 'CD1-TQ-01',
      phoneE164: '+12015550123',
    });
    const otherTech = await techHandler.handler({
      httpMethod: 'GET',
      path: `/ops/t/${foreign.token}`,
      headers: { host: 'cardetail1.com', accept: 'application/json' },
    });
    assert.equal(otherTech.statusCode, 401);
    assert.doesNotMatch(otherTech.body, /Harbor|Alex/);

    const expired = await createTechQuickOpsToken({
      bookingId: 'CD1-TQ-01',
      phoneE164: '+12015550199',
      ttlMs: -1000,
    });
    const stale = await techHandler.handler({
      httpMethod: 'GET',
      path: `/ops/t/${expired.token}`,
      headers: { host: 'cardetail1.com', accept: 'text/html' },
    });
    assert.equal(stale.statusCode, 400);
    assert.match(stale.body, /no longer valid/);
    assert.doesNotMatch(stale.body, /Harbor|Alex/);
  });

  it('records suppression and a provider failure without calling the text delivered', async () => {
    const { rows, prisma } = memorySmsOutbox();
    const sent = [];
    const provider = {
      ok: true,
      async send({ to, body }) {
        sent.push({ to, body });
        return { sid: `SM${String(sent.length).padStart(32, 'c')}`, status: 'sent' };
      },
    };
    const env = smsDispatchEnv();
    await suppressPhone('+12015550123');
    try {
      const blocked = await assignQuickOpsTech(booking(), {
        phone: '2015550123',
        prisma,
        env,
        provider,
      });
      assert.equal(blocked.ok, true, blocked.error);
      assert.equal(blocked.kind, 'freelance');
      assert.equal(blocked.notification, 'failed');
      assert.equal(blocked.message, 'Assigned — notification failed');
      assert.equal(blocked.sms.reason, 'suppressed');
      assert.equal(sent.length, 0);
      assert.equal(rows.size, 1);
      const blockedRow = [...rows.values()][0];
      assert.equal(blockedRow.status, 'failed');
      assert.equal(blockedRow.lastErrorCode, 'suppressed');
      const blockedSaved = await getBookingRecord('CD1-TQ-01');
      assert.equal(blockedSaved.booking.techNotifyStatus, 'failed');
      assert.equal(blockedSaved.booking.assignmentKind, 'freelance');
      const hash = blockedSaved.booking.techQuickOpsTokenHash;
      const link = blockedRow.templateData && blockedRow.templateData.url;

      const stillBlocked = await retryQuickOpsTechNotification(blockedSaved.booking, { prisma, env, provider });
      assert.equal(stillBlocked.notification, 'failed');
      assert.equal(stillBlocked.message, 'Assigned — notification failed');
      assert.equal(sent.length, 0);
      assert.equal(rows.size, 1);

      await clearSuppression('+12015550123');
      const retried = await retryQuickOpsTechNotification((await getBookingRecord('CD1-TQ-01')).booking, {
        prisma,
        env,
        provider,
      });
      assert.equal(retried.notification, 'sent');
      assert.equal(retried.message, 'Assigned — notification sent');
      assert.doesNotMatch(retried.message, /delivered/i);
      assert.equal(sent.length, 1);
      assert.equal(rows.size, 1);
      assert.equal([...rows.values()][0].templateData.url, link);
      assert.match(link, /\/ops\/t\/tqt_/);
      const afterRetry = await getBookingRecord('CD1-TQ-01');
      assert.equal(afterRetry.booking.techQuickOpsTokenHash, hash);
      assert.equal(afterRetry.booking.techNotifyStatus, 'sent');

      const again = await retryQuickOpsTechNotification(afterRetry.booking, { prisma, env, provider });
      assert.equal(again.idempotent, true);
      assert.equal(again.notification, 'sent');
      assert.equal(sent.length, 1);
      assert.equal(rows.size, 1);
    } finally {
      await clearSuppression('+12015550123');
    }
  });

  it('retries a provider failure on the same queued text', async () => {
    const { rows, prisma } = memorySmsOutbox();
    const sent = [];
    let failOnce = true;
    const provider = {
      ok: true,
      async send({ to, body }) {
        if (failOnce) {
          failOnce = false;
          const err = new Error('provider_down');
          err.status = 400;
          throw err;
        }
        sent.push({ to, body });
        return { sid: `SM${'d'.repeat(32)}`, status: 'queued' };
      },
    };
    const env = smsDispatchEnv();
    const failed = await assignQuickOpsTech(booking(), {
      techId: 'sam',
      prisma,
      env,
      provider,
    });
    assert.equal(failed.ok, true, failed.error);
    assert.equal(failed.notification, 'failed');
    assert.equal(failed.message, 'Assigned — notification failed');
    assert.doesNotMatch(failed.message, /delivered/i);
    assert.equal(sent.length, 0);
    assert.equal(rows.size, 1);
    const saved = await getBookingRecord('CD1-TQ-01');
    const hash = saved.booking.techQuickOpsTokenHash;
    const link = [...rows.values()][0].templateData.url;
    const retried = await retryQuickOpsTechNotification(saved.booking, { prisma, env, provider });
    assert.equal(retried.notification, 'sent');
    assert.equal(retried.message, 'Assigned — notification sent');
    assert.doesNotMatch(retried.message, /delivered/i);
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /Open: /);
    assert.doesNotMatch(sent[0].body, /Alex|Rivera|\$/);
    assert.equal(rows.size, 1);
    assert.equal([...rows.values()][0].templateData.url, link);
    const after = await getBookingRecord('CD1-TQ-01');
    assert.equal(after.booking.techQuickOpsTokenHash, hash);
    assert.equal(after.booking.assignedTechId, 'sam');

    const repeat = await assignQuickOpsTech(after.booking, {
      techId: 'sam',
      prisma,
      env,
      provider,
    });
    assert.equal(repeat.idempotent, true);
    assert.equal(repeat.notification, 'sent');
    assert.equal(sent.length, 1);
    assert.equal(rows.size, 1);
    assert.equal((await getBookingRecord('CD1-TQ-01')).booking.techQuickOpsTokenHash, hash);
  });

  it('lets only one of two concurrent assignments stay active', async () => {
    const tokenStore = createCasMemoryStore();
    setTechQuickOpsStoreFactories({
      tokenStore: () => tokenStore,
      sessionStore: () => createCasMemoryStore(),
    });
    const [left, right] = await Promise.all([
      assignQuickOpsTech(booking(), { techId: 'sam', skipSms: true }),
      assignQuickOpsTech(booking(), { phone: '2015550123', skipSms: true }),
    ]);
    const results = [left, right];
    assert.equal(results.filter((row) => row.ok).length, 1);
    assert.equal(results.filter((row) => row.error === 'version_conflict').length, 1);
    const saved = await getBookingRecord('CD1-TQ-01');
    const records = [...tokenStore._data.values()].map((entry) => JSON.parse(entry.value));
    const live = records.filter((row) => row && !row.revokedAt);
    assert.equal(live.length, 1);
    assert.equal(live[0].tokenHash, saved.booking.techQuickOpsTokenHash);
    assert.equal(records.filter((row) => row && row.revokedAt).length, 1);
    if (saved.booking.assignmentKind === 'registered') {
      assert.equal(saved.booking.assignedTechId, 'sam');
      assert.equal(saved.booking.freelancePhone, null);
    } else {
      assert.equal(saved.booking.assignmentKind, 'freelance');
      assert.equal(saved.booking.assignedTechId, null);
      assert.equal(saved.booking.freelancePhone, '+12015550123');
    }
  });
});

function consentedBooking(overrides = {}) {
  return booking({
    transactionalSmsConsentAccepted: true,
    transactionalSmsConsent: canonicalBookingSmsConsent(true, '2026-09-01T12:00:00.000Z', '+12015550177'),
    ...overrides,
  });
}

function fakeProvider(sent, mode) {
  return {
    ok: true,
    async send({ to, body }) {
      sent.push({ to, body });
      if (mode === 'fail') {
        const err = new Error('provider_down');
        err.status = 400;
        throw err;
      }
      return {
        sid: `SM${String(sent.length).padStart(32, 'b')}`,
        status: mode === 'delivered' ? 'delivered' : 'accepted',
      };
    },
  };
}

async function openAssignedTech(row) {
  setBookingStoreOverride(createCasMemoryStore({ 'CD1-TQ-01': row }));
  const assigned = await assignQuickOpsTech(row, { phone: '2015550123', skipSms: true });
  assert.equal(assigned.ok, true, assigned.error || assigned.message);
  const token = decodeURIComponent(assigned.techUrl.split('/').pop());
  const opened = await techHandler.handler({
    httpMethod: 'GET',
    path: `/ops/t/${token}`,
    rawUrl: `https://cardetail1.com/ops/t/${token}`,
    headers: { host: 'cardetail1.com', accept: 'application/json' },
  });
  assert.equal(opened.statusCode, 302);
  const cookie = String(opened.headers['Set-Cookie']).split(';')[0];
  const page = await techHandler.handler({
    httpMethod: 'GET',
    path: '/ops/t',
    headers: { cookie, host: 'cardetail1.com', accept: 'application/json' },
  });
  assert.equal(page.statusCode, 200);
  const body = JSON.parse(page.body);
  return { cookie, csrf: body.csrfToken, view: body.view };
}

describe('technician payment, arrival, and contact', () => {
  it('reports provider acceptance and retries the same payment link', async () => {
    setPaymentResumeStoreFactory(() => createCasMemoryStore());
    const sent = [];
    const { rows, prisma } = memorySmsOutbox();
    const row = consentedBooking();
    const session = await openAssignedTech(row);
    setQuickOpsSmsRuntime({ prisma, env: smsDispatchEnv(), provider: fakeProvider(sent, 'fail') });
    const headers = {
      cookie: session.cookie,
      host: 'cardetail1.com',
      'content-type': 'application/json',
      'x-tq-csrf': session.csrf,
    };
    const failed = await techHandler.handler({
      httpMethod: 'POST',
      path: '/ops/t',
      headers,
      body: JSON.stringify({ action: 'text_pay' }),
    });
    assert.equal(failed.statusCode, 409);
    const failedBody = JSON.parse(failed.body);
    assert.equal(failedBody.ok, false);
    assert.equal(failedBody.delivery, 'failed');
    assert.match(failedBody.message, /Payment link was not sent/);
    assert.doesNotMatch(failedBody.message, /texted/i);
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /\/pay\/prt_/);
    assert.doesNotMatch(sent[0].body, /Harbor|2015550177/);
    assert.equal(rows.size, 1);
    const savedAfterFail = await getBookingRecord('CD1-TQ-01');
    assert.equal(savedAfterFail.booking.ledger.approvedCents, 19000);
    assert.equal(savedAfterFail.booking.techPayoutAmount, 120);
    assert.equal(savedAfterFail.booking.priceAdjustments, undefined);

    setQuickOpsSmsRuntime({ prisma, env: smsDispatchEnv(), provider: fakeProvider(sent, 'accepted') });
    const retried = await techHandler.handler({
      httpMethod: 'POST',
      path: '/ops/t',
      headers,
      body: JSON.stringify({ action: 'text_pay' }),
    });
    assert.equal(retried.statusCode, 200, retried.body);
    const retriedBody = JSON.parse(retried.body);
    assert.equal(retriedBody.delivery, 'accepted');
    assert.equal(retriedBody.message, 'Payment link accepted by the provider.');
    assert.equal(sent.length, 2);
    assert.equal(sent[1].body, sent[0].body);
    assert.equal(rows.size, 1);

    const admin = await createQuickOpsSession({ bookingId: 'CD1-TQ-01' });
    const adminSend = await adminHandler.handler({
      httpMethod: 'POST',
      path: '/ops/q',
      headers: {
        cookie: `${ADMIN_COOKIE}=${encodeURIComponent(admin.sessionId)}`,
        host: 'cardetail1.com',
        'content-type': 'application/json',
        'x-qo-csrf': admin.csrfToken,
      },
      body: JSON.stringify({ action: 'text_pay' }),
    });
    assert.equal(adminSend.statusCode, 200, adminSend.body);
    const adminBody = JSON.parse(adminSend.body);
    assert.equal(adminBody.delivery, 'accepted');
    assert.equal(adminBody.message, 'Payment link accepted by the provider.');
    assert.equal(adminBody.payUrl, undefined);
    assert.equal(retriedBody.payUrl, undefined);
    assert.doesNotMatch(retried.body, /prt_|\/pay\//);
    assert.doesNotMatch(adminSend.body, /prt_|\/pay\//);
    assert.equal(sent.length, 2);
    assert.equal(rows.size, 1);
    assert.equal((await getBookingRecord('CD1-TQ-01')).booking.quoteVersion, 1);
  });

  it('keeps a stopped number suppressed and a disabled kick pending', async () => {
    setPaymentResumeStoreFactory(() => createCasMemoryStore());
    const sent = [];
    const { prisma } = memorySmsOutbox();
    const session = await openAssignedTech(consentedBooking());
    await suppressPhone('+12015550177');
    try {
      setQuickOpsSmsRuntime({ prisma, env: smsDispatchEnv(), provider: fakeProvider(sent, 'accepted') });
      const blocked = await techHandler.handler({
        httpMethod: 'POST',
        path: '/ops/t',
        headers: {
          cookie: session.cookie,
          host: 'cardetail1.com',
          'content-type': 'application/json',
          'x-tq-csrf': session.csrf,
        },
        body: JSON.stringify({ action: 'text_pay' }),
      });
      const blockedBody = JSON.parse(blocked.body);
      assert.equal(blockedBody.delivery, 'suppressed');
      assert.match(blockedBody.message, /opted out/);
      assert.equal(sent.length, 0);
      const again = await techHandler.handler({
        httpMethod: 'POST',
        path: '/ops/t',
        headers: {
          cookie: session.cookie,
          host: 'cardetail1.com',
          'content-type': 'application/json',
          'x-tq-csrf': session.csrf,
        },
        body: JSON.stringify({ action: 'text_pay' }),
      });
      assert.equal(JSON.parse(again.body).delivery, 'suppressed');
      assert.equal(sent.length, 0);
    } finally {
      await clearSuppression('+12015550177');
    }

    const pendingEnv = { ...smsDispatchEnv(), TWILIO_PRODUCTION_SENDS_ENABLED: 'false' };
    const pendingBox = memorySmsOutbox();
    setQuickOpsSmsRuntime({ prisma: pendingBox.prisma, env: pendingEnv, provider: fakeProvider(sent, 'accepted') });
    const pending = await techHandler.handler({
      httpMethod: 'POST',
      path: '/ops/t',
      headers: {
        cookie: session.cookie,
        host: 'cardetail1.com',
        'content-type': 'application/json',
        'x-tq-csrf': session.csrf,
      },
      body: JSON.stringify({ action: 'text_pay' }),
    });
    const pendingBody = JSON.parse(pending.body);
    assert.equal(pendingBody.delivery, 'pending');
    assert.equal(pendingBody.message, 'Payment link send is pending.');
    assert.equal(sent.length, 0);
  });

  it('charges an approved extra once from the shared remaining balance', async () => {
    const base = booking({
      id: 'CD1-BAL',
      approvedFinalAmount: 300,
      totalPrice: 300,
      techPayoutAmount: 80,
      quoteVersion: 1,
      ledger: { currency: 'usd', approvedCents: 30000, settledCents: 0, creditedCents: 0, entries: [] },
      paymentAttempts: [{
        bookingId: 'CD1-BAL',
        providerObjectId: 'pi_old_300',
        amountCents: 30000,
        quoteVersion: 1,
        bookingVersion: 1,
        currency: 'usd',
        status: 'open',
      }],
    });
    setBookingStoreOverride(createCasMemoryStore({ 'CD1-BAL': base }));
    const pending = await recordTechExtra(base, {
      amountDollars: '152.00',
      reason: 'Paint correction add-on',
      actorId: 'tech_quick_ops',
    });
    assert.equal(pending.ok, true, pending.error || pending.message);
    assert.equal(pending.adjustment.amountCents, 15200);
    assert.equal(pending.adjustment.status, 'pending_customer');
    assert.equal(pending.adjustment.customerApprovalRequired, true);
    assert.equal(pending.booking.ledger.approvedCents, 30000);
    assert.equal(pending.booking.techPayoutAmount, 80);
    const replay = await recordTechExtra(pending.booking, {
      amountDollars: '152.00',
      reason: 'Paint correction add-on',
      actorId: 'tech_quick_ops',
    });
    assert.equal(replay.idempotent, true);
    assert.equal(replay.booking.priceAdjustments.length, 1);

    const gate = chargeEligibility({
      ...pending.booking,
      paymentMethodPreference: 'online_after_service',
      cardOnFileStatus: 'saved',
      acceptedCardOnFilePolicy: true,
      afterServiceChargeConsentVersion: '2026-09-after-service-charge',
      afterServiceChargeConsentAt: '2026-09-27T15:00:00.000Z',
      stripeCustomerId: 'cus_test_saved',
      stripePaymentMethodId: 'pm_test_saved',
    }, financialProjection(pending.booking));
    assert.equal(gate.ok, true);
    assert.equal(gate.amountCents, 30000);

    const decided = decideAdjustment(pending.booking, {
      adjustmentId: pending.adjustment.adjustmentId,
      decision: 'approve',
      actorId: 'customer',
      expectedBookingVersion: pending.booking.bookingVersion,
    });
    assert.equal(decided.ok, true, decided.error);
    const approvedBooking = { ...pending.booking, ...decided.patch };
    const applied = await applyCustomerApprovedExtra(approvedBooking, {
      adjustmentId: pending.adjustment.adjustmentId,
      actorId: 'customer',
    });
    assert.equal(applied.ok, true, applied.error || applied.message);
    assert.equal(applied.approvedCents, 45200);
    assert.equal(applied.remainingCents, 45200);
    assert.equal(applied.booking.techPayoutAmount, 80);
    assert.equal(applied.booking.payLink, '');
    assert.equal(applied.booking.paymentAttempts[0].status, 'superseded');
    assert.equal(financialProjection(applied.booking).remainingCents, 45200);
    assert.equal(moneyFromBooking(applied.booking).remainingCents, 45200);
    const stripeBody = new URLSearchParams({
      amount: String(financialProjection(applied.booking).remainingCents),
      currency: 'usd',
    });
    assert.equal(stripeBody.get('amount'), '45200');
    assert.notEqual(
      buildIdempotencyKey({ bookingId: 'CD1-BAL', quoteVersion: applied.quoteVersion, amountCents: 45200, generation: 1 }),
      buildIdempotencyKey({ bookingId: 'CD1-BAL', quoteVersion: 1, amountCents: 30000, generation: 1 })
    );

    const second = await applyCustomerApprovedExtra(applied.booking, {
      adjustmentId: pending.adjustment.adjustmentId,
      actorId: 'customer',
    });
    assert.equal(second.idempotent, true);
    assert.equal(second.approvedCents, 45200);
    assert.equal(financialProjection(second.booking).remainingCents, 45200);

    const partial = booking({
      id: 'CD1-PART',
      approvedFinalAmount: 300,
      totalPrice: 300,
      techPayoutAmount: 80,
      ledger: {
        currency: 'usd',
        approvedCents: 30000,
        settledCents: 10000,
        creditedCents: 0,
        entries: [{ entryId: 'le_100', kind: 'settlement', amountCents: 10000, providerObjectId: 'pi_paid_100' }],
      },
    });
    setBookingStoreOverride(createCasMemoryStore({ 'CD1-PART': partial }));
    const partialPending = await recordTechExtra(partial, {
      amountDollars: '152',
      reason: 'Paint correction add-on',
    });
    const partialDecided = decideAdjustment(partialPending.booking, {
      adjustmentId: partialPending.adjustment.adjustmentId,
      decision: 'approve',
      actorId: 'customer',
      expectedBookingVersion: partialPending.booking.bookingVersion,
    });
    const partialApplied = await applyCustomerApprovedExtra(
      { ...partialPending.booking, ...partialDecided.patch },
      { adjustmentId: partialPending.adjustment.adjustmentId }
    );
    assert.equal(partialApplied.remainingCents, 35200);
    assert.equal(partialApplied.booking.ledger.settledCents, 10000);
    assert.equal(partialApplied.booking.ledger.entries.length, 1);
    assert.equal(financialProjection(partialApplied.booking).remainingCents, 35200);
    const partialStripe = new URLSearchParams({
      amount: String(moneyFromBooking(partialApplied.booking).remainingCents),
      currency: 'usd',
    });
    assert.equal(partialStripe.get('amount'), '35200');

    const { aggregate } = normalizeAggregate(applied.booking);
    const session = {
      id: 'cs_balance_452',
      amount_total: 45200,
      currency: 'usd',
      payment_status: 'paid',
      metadata: {
        purpose: 'customer_balance',
        booking_id: 'CD1-BAL',
        bookingVersion: String(aggregate.bookingVersion),
        quoteVersion: String(aggregate.quoteVersion),
      },
    };
    const payable = {
      ...aggregate,
      paymentAttempts: [{
        bookingId: 'CD1-BAL',
        providerObjectId: 'cs_balance_452',
        amountCents: 45200,
        quoteVersion: aggregate.quoteVersion,
        bookingVersion: aggregate.bookingVersion,
        currency: 'usd',
        status: 'open',
      }],
    };
    const firstPay = reconcileCustomerBalanceSession({
      aggregate: payable,
      session,
      stripeEventId: 'evt_balance_1',
    });
    assert.equal(firstPay.ok, true, firstPay.error);
    assert.equal(firstPay.duplicate, false);
    assert.equal(firstPay.aggregate.ledger.settledCents, 45200);
    const secondPay = reconcileCustomerBalanceSession({
      aggregate: firstPay.aggregate,
      session,
      stripeEventId: 'evt_balance_1',
    });
    assert.equal(secondPay.duplicate, true);
    assert.equal(secondPay.aggregate.ledger.entries.length, 1);
    assert.equal(financialProjection(secondPay.aggregate).remainingCents, 0);
  });

  it('records arrival once and retries only the customer text', async () => {
    const sent = [];
    const { prisma } = memorySmsOutbox();
    const session = await openAssignedTech(consentedBooking());
    setQuickOpsSmsRuntime({ prisma, env: smsDispatchEnv(), provider: fakeProvider(sent, 'fail') });
    const headers = {
      cookie: session.cookie,
      host: 'cardetail1.com',
      'content-type': 'application/json',
      'x-tq-csrf': session.csrf,
    };
    const failed = await techHandler.handler({
      httpMethod: 'POST',
      path: '/ops/t',
      headers,
      body: JSON.stringify({ action: 'arrive' }),
    });
    assert.equal(failed.statusCode, 200, failed.body);
    const failedBody = JSON.parse(failed.body);
    assert.match(failedBody.message, /Arrival recorded/);
    assert.match(failedBody.message, /was not sent/);
    const arrived = await getBookingRecord('CD1-TQ-01');
    assert.ok(arrived.booking.arrivedAt);
    assert.equal(arrived.booking.jobStatus, 'assigned');
    assert.equal(arrived.booking.paymentStatus, undefined);
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /Cardetail1: Your technician has arrived at your service location/);
    assert.doesNotMatch(sent[0].body, /Harbor|2015550177/);

    setQuickOpsSmsRuntime({ prisma, env: smsDispatchEnv(), provider: fakeProvider(sent, 'accepted') });
    const retried = await techHandler.handler({
      httpMethod: 'POST',
      path: '/ops/t',
      headers,
      body: JSON.stringify({ action: 'arrive' }),
    });
    const retriedBody = JSON.parse(retried.body);
    assert.equal(retriedBody.delivery, 'accepted');
    assert.equal(sent.length, 2);
    const still = await getBookingRecord('CD1-TQ-01');
    assert.equal(still.booking.arrivedAt, arrived.booking.arrivedAt);
    assert.equal(still.booking.jobStatus, 'assigned');

    const repeat = await techHandler.handler({
      httpMethod: 'POST',
      path: '/ops/t',
      headers,
      body: JSON.stringify({ action: 'arrive' }),
    });
    assert.equal(JSON.parse(repeat.body).message, 'Arrival already recorded.');
    assert.equal(sent.length, 2);

    await suppressPhone('+12015550177');
    try {
      const stoppedRow = consentedBooking({ id: 'CD1-TQ-01', bookingVersion: 1 });
      const stoppedSession = await openAssignedTech(stoppedRow);
      const stopped = await techHandler.handler({
        httpMethod: 'POST',
        path: '/ops/t',
        headers: {
          cookie: stoppedSession.cookie,
          host: 'cardetail1.com',
          'content-type': 'application/json',
          'x-tq-csrf': stoppedSession.csrf,
        },
        body: JSON.stringify({ action: 'arrive' }),
      });
      assert.match(JSON.parse(stopped.body).message, /opted out/);
      assert.ok((await getBookingRecord('CD1-TQ-01')).booking.arrivedAt);
      assert.equal(sent.length, 2);
    } finally {
      await clearSuppression('+12015550177');
    }
  });

  it('blocks arrival when the job is closed or the assignment is gone', async () => {
    const session = await openAssignedTech(consentedBooking());
    const headers = {
      cookie: session.cookie,
      host: 'cardetail1.com',
      'content-type': 'application/json',
      'x-tq-csrf': session.csrf,
    };
    const current = await getBookingRecord('CD1-TQ-01');
    setBookingStoreOverride(createCasMemoryStore({
      'CD1-TQ-01': { ...current.booking, appointmentStatus: 'cancelled', jobStatus: 'cancelled', status: 'cancelled' },
    }));
    const cancelled = await techHandler.handler({
      httpMethod: 'POST',
      path: '/ops/t',
      headers,
      body: JSON.stringify({ action: 'arrive' }),
    });
    assert.equal(cancelled.statusCode, 409);
    assert.equal((await getBookingRecord('CD1-TQ-01')).booking.arrivedAt, undefined);

    setBookingStoreOverride(createCasMemoryStore({
      'CD1-TQ-01': { ...current.booking, jobStatus: 'completed', completedAt: '2026-09-20T18:00:00.000Z' },
    }));
    const completed = await techHandler.handler({
      httpMethod: 'POST',
      path: '/ops/t',
      headers,
      body: JSON.stringify({ action: 'arrive' }),
    });
    assert.equal(completed.statusCode, 409);

    await unassignQuickOpsTech(current.booking);
    const revoked = await techHandler.handler({
      httpMethod: 'GET',
      path: '/ops/t',
      headers: { cookie: session.cookie, host: 'cardetail1.com', accept: 'application/json' },
    });
    assert.equal(revoked.statusCode, 401);
    assert.doesNotMatch(revoked.body, /Harbor|2015550177|tel:/);
  });

  it('hides customer contact from the technician API only after full payment', () => {
    const partial = booking({
      ledger: { approvedCents: 19000, settledCents: 10000, creditedCents: 0, entries: [] },
      paymentStatus: 'partially_paid',
      notes: 'Gate code 12. Address 12 Harbor View, Fort Lee, NJ',
    });
    const partialView = projectTechQuickOpsBooking(partial);
    assert.equal(partialView.contactRestricted, false);
    assert.equal(partialView.service.address, '12 Harbor View, Fort Lee, NJ');
    assert.equal(partialView.actions.call, true);
    assert.equal(partialView.telUrl, 'tel:+12015550177');

    const pendingPay = booking({ paymentStatus: 'processing', paymentWorkflowStatus: 'awaiting_customer_payment' });
    assert.equal(projectTechQuickOpsBooking(pendingPay).contactRestricted, false);
    const declined = booking({ paymentStatus: 'failed' });
    assert.equal(projectTechQuickOpsBooking(declined).service.address, '12 Harbor View, Fort Lee, NJ');

    const paid = booking({
      ledger: { approvedCents: 19000, settledCents: 19000, creditedCents: 0, entries: [{ kind: 'settlement', amountCents: 19000 }] },
      paymentStatus: 'paid',
      jobStatus: 'assigned',
      notes: 'Gate code 12. Meet at 12 Harbor View. Phone 201-555-0177',
      assignmentKind: 'registered',
      assignedTechId: 'sam',
      techLinkPhone: '+12015550199',
      techQuickOpsTokenHash: 'hash',
    });
    const paidView = projectTechQuickOpsBooking(paid);
    assert.equal(paidView.contactRestricted, true);
    assert.equal(paidView.service.address, '');
    assert.equal(paidView.service.note, '');
    assert.equal(paidView.telUrl, '');
    assert.equal(paidView.mapUrl, '');
    assert.equal(paidView.actions.call, false);
    assert.equal(paidView.actions.map, false);
    assert.equal(paidView.yourPay.label, '$120');
    assert.equal(paidView.money, undefined);
    const html = techQuickOpsPage(paidView, 'csrf-token');
    assert.doesNotMatch(html.body, /Harbor|201-555-0177|Call customer|Open map|tel:|maps\.google|localStorage/);
    assert.match(html.body, /Customer contact is hidden after payment/);
    assert.match(html.body, /I've arrived/);
    const admin = projectQuickOpsBooking(paid);
    assert.match(admin.service.address, /Harbor/);
    assert.equal(admin.customer.phone, '+12015550177');

    const safeNote = booking({
      ledger: { approvedCents: 19000, settledCents: 19000, creditedCents: 0, entries: [] },
      paymentStatus: 'paid',
      notes: 'Gate code 12',
    });
    assert.equal(projectTechQuickOpsBooking(safeNote).service.note, 'Gate code 12');
    assert.equal(projectTechQuickOpsBooking(safeNote).service.address, '');

    const unset = projectTechQuickOpsBooking(booking({ techPayoutAmount: null }));
    assert.equal(unset.yourPay.set, false);
    const unsetHtml = techQuickOpsPage(unset, 'csrf-token');
    assert.match(unsetHtml.body, /Not set yet/);
    assert.doesNotMatch(unsetHtml.body, /\$190/);
    const adminUnset = quickOpsPage(projectQuickOpsBooking(booking({ techPayoutAmount: null })), 'csrf-token');
    assert.match(adminUnset.body, /Technician pay is not set/);
  });
});
