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
  listAssignableTechs,
  setQuickOpsTechRoster,
  resetQuickOpsTechRoster,
} = require('../netlify/lib/quick-ops-assign');
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
    assert.match(html.body, /lowers the technician payout/);
    assert.match(html.body, /Freelance phone/);
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

  it('assigns a roster technician without a magic link', async () => {
    const result = await assignQuickOpsTech(booking(), { techId: 'sam', skipSms: true });
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'registered');
    assert.equal(result.techUrl, undefined);
    const saved = await getBookingRecord('CD1-TQ-01');
    assert.equal(saved.booking.assignedTechId, 'sam');
    assert.equal(saved.booking.assignmentKind, 'registered');
    assert.equal(saved.booking.quickOpsTechClose, false);
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
    const saved = await getBookingRecord('CD1-TQ-01');
    assert.equal(saved.booking.assignmentKind, 'freelance');
  });

  it('renders the technician job text', () => {
    const rendered = renderSmsTemplate(TEMPLATE_KEYS.TECH_JOB_LINK, {
      service: 'Interior Detail',
      date: '2026-09-19',
      url: 'https://cardetail1.com/ops/t/tqt_example',
    });
    assert.equal(rendered.ok, true);
    assert.match(rendered.body, /Job assigned/);
    assert.match(rendered.body, /\/ops\/t\/tqt_example/);
  });
});
