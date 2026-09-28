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
    assert.match(addedBody.message, /\$140/);
    assert.doesNotMatch(added.body, /190|210|payout dropped/);
    const after = await getBookingRecord('CD1-TQ-01');
    assert.equal(after.booking.ledger.approvedCents, 21000);
    assert.equal(after.booking.techPayoutAmount, 140);

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
    assert.doesNotMatch(sent[0].body, /Alex|Rivera|\$|190|120/);
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
      url: 'https://cardetail1.com/ops/t/tqt_example',
    });
    assert.equal(rendered.ok, true);
    assert.match(rendered.body, /Sep 19, 2026/);
    assert.match(rendered.body, /Interior Detail/);
    assert.match(rendered.body, /12 Harbor View, Fort Lee, NJ/);
    assert.match(rendered.body, /Open: https:\/\/cardetail1\.com\/ops\/t\/tqt_example/);
    assert.match(rendered.body, /Reply STOP/);
    assert.doesNotMatch(rendered.body, /Alex|Rivera|\$|Job assigned/);
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
