'use strict';

const { describe, it, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createCasMemoryStore } = require('./helpers/cas-memory-store');
const { setBookingStoreOverride } = require('../netlify/lib/booking-repository');
const { setFinishAdminActionRunner } = require('../netlify/lib/quick-ops-finish');
const { recordOnSitePayment } = require('../netlify/lib/admin-quick-ops-actions');
const { serviceReadyToAutoClose } = require('../netlify/lib/onsite-job-close');
const { resolveAdminCashSettlement } = require('../netlify/lib/admin-booking-mutations');
const {
  customerStatusSummary,
  customerPaymentLabel,
  customerFacingStatusKey,
} = require('../netlify/lib/booking-customer-status');
const { projectBookingForCustomer } = require('../netlify/lib/ops-schema');
const { selectUpcoming, selectPortalPage } = require('../netlify/functions/customer-portal-data').__test;
const { canonicalBookingSmsConsent } = require('../netlify/lib/sms-program');
const { buildReceiptProjection } = require('../netlify/lib/receipt-projection');
const {
  renderSmsTemplate,
  TEMPLATE_KEYS,
} = require('../netlify/lib/sms-templates');
const {
  notifyIfServiceClosedAndPaid,
  shouldNotifyFromWebhook,
  receiptUrlFor,
  completionIdempotencyKey,
  officialGoogleReviewUrl,
} = require('../netlify/lib/service-completion-notice');
const { projectTechQuickOpsBooking } = require('../netlify/lib/tech-quick-ops-view');
const { techQuickOpsPage } = require('../netlify/lib/quick-ops-html');
const { productionCustomerPaymentsBlocked } = require('../netlify/lib/stripe-customer-payments');
const {
  createTechQuickOpsSession,
  COOKIE_NAME,
  setTechQuickOpsStoreFactories,
  resetTechQuickOpsStoreFactories,
} = require('../netlify/lib/tech-quick-ops-token');

const techHandler = require('../netlify/functions/tech-quick-ops');
const receiptHandler = require('../netlify/functions/customer-receipt');

const ROOT = path.join(__dirname, '..');
const NOW = new Date('2026-11-12T18:00:00.000Z');

function paidVisit(extra = {}) {
  return {
    id: 'CD1-CLOSE420',
    bookingVersion: 4,
    appointmentStatus: 'confirmed',
    jobStatus: 'in_progress',
    status: 'Confirmed',
    arrivedAt: '2020-06-01T15:00:00.000Z',
    confirmedDate: '2020-06-01',
    preferredDate: '2020-06-01',
    paymentStatus: 'paid_cash',
    paymentWorkflowStatus: 'cash_paid',
    cashReceivedAt: '2026-11-12T18:00:00.000Z',
    cashReceivedAmount: 420,
    approvedFinalAmount: 420,
    totalPrice: 420,
    phone: '2015550144',
    firstName: 'Pat',
    ledger: { currency: 'usd', approvedCents: 42000, settledCents: 42000, creditedCents: 0 },
    ...extra,
  };
}

function executedPaid(extra = {}) {
  return paidVisit({
    jobStatus: 'completed_pending_admin_review',
    techCompletedAt: '2020-06-01T17:00:00.000Z',
    ...extra,
  });
}

function openVisit(extra = {}) {
  return paidVisit({
    paymentStatus: 'due',
    paymentWorkflowStatus: 'awaiting_customer_payment',
    cashReceivedAt: null,
    cashReceivedAmount: null,
    ledger: { currency: 'usd', approvedCents: 42000, settledCents: 0, creditedCents: 0 },
    ...extra,
  });
}

before(() => {
  process.env.CONTEXT = 'production';
  process.env.BRANCH = 'master';
  process.env.PUBLIC_SITE_URL = 'https://cardetail1.com';
  process.env.URL = 'https://cardetail1.com';
  process.env.TECH_QUICK_OPS_SECRET = 'test-tech-quick-ops-secret-32';
  process.env.CD1_POSTGRES_PAYMENT = 'false';
  delete process.env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED;
});

afterEach(() => {
  setFinishAdminActionRunner(null);
  setBookingStoreOverride(null);
  resetTechQuickOpsStoreFactories();
});

describe('on-site close', () => {
  it('1. full cash closes a visit only after the service is marked complete', async () => {
    const calls = [];
    setFinishAdminActionRunner(async (body) => {
      calls.push(body.action);
      return { statusCode: 200, body: JSON.stringify({ ok: true, jobStatus: 'completed_paid', reviewRequest: { queued: false } }) };
    });
    const result = await recordOnSitePayment(openVisit(), {
      method: 'cash',
      expectedBookingVersion: 4,
      skipNotify: true,
      settle: async () => ({ ok: true, booking: executedPaid() }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.autoClose.closed, true);
    assert.deepEqual(calls, ['approve_completion']);
  });

  it('1b. full cash right after arrival does not finish the job', async () => {
    const calls = [];
    setFinishAdminActionRunner(async () => {
      calls.push('finish');
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    });
    const arrived = paidVisit({ jobStatus: 'arrived', techCompletedAt: null, completedAt: null, jobCompletedAt: null });
    const result = await recordOnSitePayment(openVisit({ jobStatus: 'arrived' }), {
      method: 'cash',
      expectedBookingVersion: 4,
      skipNotify: true,
      settle: async () => ({ ok: true, booking: arrived }),
    });
    assert.equal(result.autoClose.closed, false);
    assert.equal(result.autoClose.reason, 'not_executed');
    assert.equal(calls.length, 0);
  });

  it('1c. full cash while the job is in progress does not finish it', async () => {
    const calls = [];
    setFinishAdminActionRunner(async () => {
      calls.push('finish');
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    });
    const working = paidVisit({
      jobStatus: 'in_progress',
      serviceStatus: 'in_progress',
      arrivedAt: null,
      techCompletedAt: null,
      completedAt: null,
      jobCompletedAt: null,
    });
    const result = await recordOnSitePayment(openVisit({ jobStatus: 'in_progress', arrivedAt: null }), {
      method: 'cash',
      expectedBookingVersion: 4,
      skipNotify: true,
      settle: async () => ({ ok: true, booking: working }),
    });
    assert.equal(result.autoClose.closed, false);
    assert.equal(result.autoClose.reason, 'not_executed');
    assert.equal(calls.length, 0);
  });

  it('1d. one explicit receipt-and-finish request closes the in-progress job', async () => {
    const calls = [];
    setFinishAdminActionRunner(async (body) => {
      calls.push(body.action);
      return { statusCode: 200, body: JSON.stringify({ ok: true, jobStatus: 'completed_paid' }) };
    });
    const working = paidVisit({
      jobStatus: 'in_progress',
      arrivedAt: '2020-06-01T15:00:00.000Z',
      techCompletedAt: null,
      completedAt: null,
      jobCompletedAt: null,
    });
    const result = await recordOnSitePayment(openVisit({ jobStatus: 'in_progress' }), {
      method: 'cash',
      expectedBookingVersion: 4,
      skipNotify: true,
      confirmServicePerformed: true,
      settle: async () => ({ ok: true, booking: working }),
    });
    assert.equal(result.autoClose.closed, true);
    assert.equal(result.autoClose.explicit, true);
    assert.deepEqual(calls, ['admin_tech_status', 'approve_completion']);
    const future = await recordOnSitePayment(openVisit({ confirmedDate: '2099-01-01', preferredDate: '2099-01-01' }), {
      method: 'cash',
      expectedBookingVersion: 4,
      skipNotify: true,
      confirmServicePerformed: true,
      settle: async () => ({
        ok: true,
        booking: paidVisit({ confirmedDate: '2099-01-01', preferredDate: '2099-01-01' }),
      }),
    });
    assert.equal(future.autoClose.closed, false);
    assert.equal(future.autoClose.reason, 'future_service');
    assert.equal(calls.length, 2);
  });

  it('2. an assigned technician can record payment only after arrival', async () => {
    const phone = '+12015550123';
    const base = {
      id: 'CD1-TECHPAY',
      bookingVersion: 2,
      appointmentStatus: 'confirmed',
      jobStatus: 'confirmed',
      status: 'Confirmed',
      assignmentKind: 'freelance',
      freelancePhone: phone,
      quickOpsTechClose: true,
      techQuickOpsTokenHash: 'hash',
      confirmedDate: '2026-11-12',
      approvedFinalAmount: 420,
      totalPrice: 420,
      ledger: { approvedCents: 42000, settledCents: 0, creditedCents: 0 },
    };
    const before = projectTechQuickOpsBooking(base);
    assert.equal(before.actions.collectCash, false);
    assert.equal(before.actions.cash, undefined);
    assert.doesNotMatch(techQuickOpsPage(before, 'csrf').body, /Record cash|Record card|\$420/);
    const arrived = projectTechQuickOpsBooking({ ...base, arrivedAt: '2026-11-12T15:00:00.000Z' });
    assert.equal(arrived.actions.collectCash, true);
    assert.match(techQuickOpsPage(arrived, 'csrf').body, /Cash received/);
    assert.doesNotMatch(techQuickOpsPage(arrived, 'csrf').body, /\$420|Approved/);

    const sessionStore = createCasMemoryStore();
    setTechQuickOpsStoreFactories({
      tokenStore: () => createCasMemoryStore(),
      sessionStore: () => sessionStore,
    });
    setBookingStoreOverride(createCasMemoryStore({ 'CD1-TECHPAY': base }));
    const session = await createTechQuickOpsSession({ bookingId: base.id, phoneE164: phone });
    const denied = await techHandler.handler({
      httpMethod: 'POST',
      headers: { cookie: `${COOKIE_NAME}=${session.sessionId}`, 'x-tq-csrf': session.csrfToken },
      body: JSON.stringify({ action: 'record_cash', bookingVersion: 2 }),
    });
    assert.equal(denied.statusCode, 409);
    assert.equal(JSON.parse(denied.body).error, 'not_authorized');

    setBookingStoreOverride(createCasMemoryStore({
      'CD1-TECHPAY': { ...base, arrivedAt: '2026-11-12T15:00:00.000Z' },
    }));
    const allowed = await techHandler.handler({
      httpMethod: 'POST',
      headers: { cookie: `${COOKIE_NAME}=${session.sessionId}`, 'x-tq-csrf': session.csrfToken },
      body: JSON.stringify({ action: 'record_cash', bookingVersion: 2 }),
    });
    assert.equal(allowed.statusCode, 503);
    assert.equal(JSON.parse(allowed.body).error, 'postgres_payment_disabled');
  });

  it('3. a partial amount is rejected and does not settle', () => {
    const gate = resolveAdminCashSettlement(openVisit(), { amount: 100, reason: 'short' });
    assert.equal(gate.ok, false);
    assert.equal(gate.error, 'cash_amount_mismatch');
    assert.equal(gate.expectedAmountCents, 42000);
    assert.equal(serviceReadyToAutoClose(paidVisit({
      ledger: { approvedCents: 42000, settledCents: 10000, creditedCents: 0 },
    }), { now: NOW }).reason, 'partial');
  });

  it('4. a future appointment stays open after payment', () => {
    const future = serviceReadyToAutoClose(paidVisit({ confirmedDate: '2099-01-01', preferredDate: '2099-01-01' }), { now: NOW });
    assert.equal(future.ok, false);
    assert.equal(future.reason, 'future_service');
  });

  it('5. choosing card without a confirmed receipt does not close the job', () => {
    const selected = serviceReadyToAutoClose(openVisit({
      paymentMethodPreference: 'card_on_site',
      paymentStatus: 'not_due',
    }), { now: NOW });
    assert.equal(selected.reason, 'not_confirmed');
    const noRef = serviceReadyToAutoClose(paidVisit({
      paymentStatus: 'paid_card_on_site',
      paymentWorkflowStatus: 'payment_succeeded',
      cashReceivedAt: null,
      cardOnSiteAt: '2026-11-12T18:00:00.000Z',
      cardOnSiteReference: '',
    }), { now: NOW });
    assert.equal(noRef.reason, 'card_not_confirmed');
  });

  it('6. finishing a visit does not require the invoice to be paid', async () => {
    const { finishJobQuickOps } = require('../netlify/lib/quick-ops-finish');
    setFinishAdminActionRunner(async () => ({
      statusCode: 200,
      body: JSON.stringify({ ok: true, jobStatus: 'completed_pending_payment', reviewRequest: { queued: false } }),
    }));
    const unpaid = openVisit({ jobStatus: 'confirmed', arrivedAt: '2026-11-12T15:00:00.000Z' });
    const result = await finishJobQuickOps(unpaid, {});
    assert.equal(result.ok, true);
    assert.equal(result.jobStatus, 'completed_pending_payment');
  });

  it('7. paying after the visit notifies once and does not finish again', async () => {
    const calls = [];
    setFinishAdminActionRunner(async () => {
      calls.push('finish');
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    });
    const done = paidVisit({
      jobStatus: 'completed_paid',
      completedAt: '2026-11-12T17:00:00.000Z',
    });
    const result = await recordOnSitePayment(openVisit({ jobStatus: 'completed_pending_payment' }), {
      method: 'cash',
      expectedBookingVersion: 4,
      skipNotify: true,
      settle: async () => ({ ok: true, booking: done }),
    });
    assert.equal(result.autoClose.alreadyFinished, true);
    assert.equal(result.autoClose.notice.queued, false);
    assert.equal(calls.length, 0);
  });

  it('8. repeating the payment does not finish or notify again', async () => {
    const calls = [];
    setFinishAdminActionRunner(async () => {
      calls.push('finish');
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    });
    const settled = await recordOnSitePayment(paidVisit(), {
      method: 'cash',
      expectedBookingVersion: 4,
      settle: async () => ({ ok: false, error: 'already_paid', statusCode: 409 }),
    });
    assert.equal(settled.ok, false);
    assert.equal(settled.error, 'zero_balance');
    assert.equal(settled.autoClose, undefined);
    const raced = await recordOnSitePayment(openVisit(), {
      method: 'cash',
      expectedBookingVersion: 4,
      settle: async () => ({ ok: false, error: 'already_paid', statusCode: 409 }),
    });
    assert.equal(raced.ok, false);
    assert.equal(raced.error, 'already_paid');
    assert.equal(raced.autoClose, undefined);
    assert.equal(calls.length, 0);
    const key = completionIdempotencyKey(paidVisit());
    assert.equal(completionIdempotencyKey(paidVisit()), key);
  });

  it('9. a duplicate payment webhook does not send another completion text', () => {
    const projection = { paymentStatus: 'paid', remainingCents: 0 };
    assert.equal(shouldNotifyFromWebhook({ duplicate: false, projection }), true);
    assert.equal(shouldNotifyFromWebhook({ duplicate: true, projection }), false);
    assert.equal(shouldNotifyFromWebhook({ ignored: true, projection }), false);
  });

  it('10. a failed completion text does not undo the close', async () => {
    const notice = await notifyIfServiceClosedAndPaid(paidVisit({
      jobStatus: 'completed_paid',
      completedAt: '2026-11-12T18:00:00.000Z',
    }), {
      env: {
        ...process.env,
        CUSTOMER_TRANSACTIONAL_SMS_ENABLED: 'true',
        TWILIO_OUTBOX_ENABLED: 'true',
        TWILIO_ENABLED: 'true',
      },
      prisma: {
        smsOutbox: {
          async findUnique() { throw new Error('outbox down'); },
          async create() { throw new Error('outbox down'); },
        },
      },
    });
    assert.equal(notice.ok, true);
    assert.equal(notice.queued, false);
    assert.equal(serviceReadyToAutoClose(executedPaid(), { now: NOW }).ok, true);
  });

  it('11. the completion text carries the receipt and the official Google review link', () => {
    const booking = paidVisit({ jobStatus: 'completed_paid', completedAt: '2026-11-12T18:00:00.000Z' });
    const receiptUrl = receiptUrlFor(booking);
    assert.match(receiptUrl, /^https:\/\/cardetail1\.com\/receipt\.html\?bookingId=CD1-CLOSE420&type=final$/);
    assert.doesNotMatch(receiptUrl, /token|\/ops\/|tqt_/);
    assert.equal(officialGoogleReviewUrl(), 'https://g.page/r/CTJwfJerrQeCEAI/review');
    const rendered = renderSmsTemplate(TEMPLATE_KEYS.SERVICE_COMPLETED, {
      receiptUrl,
      reviewUrl: officialGoogleReviewUrl(),
    });
    assert.equal(rendered.ok, true);
    assert.match(rendered.body, /Your detailing service is complete/);
    assert.match(rendered.body, /View your receipt: https:\/\/cardetail1\.com\/receipt\.html/);
    assert.match(rendered.body, /Google review: https:\/\/g\.page\/r\/CTJwfJerrQeCEAI\/review/);
    assert.doesNotMatch(rendered.body, /\$\d|tech payout|\bledger\b/i);
  });

  it('12. a receipt request without the booking phone is not a receipt', async () => {
    const response = await receiptHandler.handler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify({ bookingId: 'CD1-SOMEONEELSE', receiptType: 'final' }),
    });
    const body = JSON.parse(response.body);
    assert.notEqual(body.ok, true);
    assert.equal(body.receipt, undefined);
  });

  it('13. a paid service is not labelled Payment Due or not_due', () => {
    const booking = paidVisit({
      jobStatus: 'completed_paid',
      completedAt: '2026-11-12T18:00:00.000Z',
      paymentStatus: 'not_due',
    });
    const row = projectBookingForCustomer(booking);
    assert.equal(customerPaymentLabel(booking), 'Paid');
    assert.equal(customerStatusSummary(booking), 'Completed — Paid');
    assert.equal(row.paymentStatusLabel, 'Paid');
    assert.equal(row.statusSummary, 'Completed — Paid');
    assert.notEqual(row.paymentStatusLabel, 'not_due');
    assert.notEqual(customerFacingStatusKey(booking), 'payment_due');
  });

  it('14. an open balance stays unpaid with the remaining amount', () => {
    const booking = openVisit({ jobStatus: 'completed_pending_payment', paymentStatus: 'due' });
    assert.equal(customerPaymentLabel(booking), 'Unpaid');
    assert.equal(customerStatusSummary(booking), 'Completed — Balance due');
    assert.equal(customerFacingStatusKey(booking), 'payment_due');
    const row = projectBookingForCustomer(booking);
    assert.equal(row.remainingCents, 42000);
  });

  it('15. an old or undated appointment does not replace the next service', () => {
    const old = {
      id: 'CD1-OLD',
      status: 'Confirmed',
      jobStatus: 'confirmed',
      preferredDate: '2020-03-01',
      confirmedDate: '2020-03-01',
      remainingCents: 10000,
    };
    const undated = {
      id: 'CD1-NODATE',
      status: 'Pending Review',
      jobStatus: 'pending_review',
      preferredDate: '',
      confirmedDate: '',
    };
    const next = {
      id: 'CD1-NEXT',
      status: 'Confirmed',
      jobStatus: 'confirmed',
      preferredDate: '2026-11-20',
      confirmedDate: '2026-11-20',
      remainingCents: 0,
      settledCents: 0,
    };
    assert.equal(selectUpcoming([old, undated, next], { now: NOW.getTime() }).id, 'CD1-NEXT');
    const crowd = Array.from({ length: 200 }, (_, i) => ({
      id: `CD1-OLD${i}`,
      status: 'Confirmed',
      jobStatus: 'confirmed',
      preferredDate: 'not-a-date',
      confirmedDate: '',
    }));
    assert.equal(selectUpcoming(crowd.concat(next), { now: NOW.getTime() }).id, 'CD1-NEXT');
  });

  it('16. the first history page is capped', () => {
    const js = fs.readFileSync(path.join(ROOT, 'assets', 'my-garage.js'), 'utf8');
    assert.match(js, /var LIST_PAGE = 8/);
    assert.match(js, /all\.slice\(0, pageLimit\(limit\)\)/);
    const history = Array.from({ length: 240 }, (_, i) => i);
    const firstPage = history.slice(0, 8);
    assert.equal(history.length, 240);
    assert.equal(firstPage.length, 8);
    const dash = fs.readFileSync(path.join(ROOT, 'assets', 'my-garage-dashboard.js'), 'utf8');
    assert.match(dash, /data-open/);
    assert.match(dash, /grid\.innerHTML = ''/);
  });

  it('17. a malformed date is not an upcoming appointment', () => {
    const row = {
      id: 'CD1-BAD',
      status: 'Confirmed',
      jobStatus: 'confirmed',
      preferredDate: 'next Tuesday',
      confirmedDate: '',
    };
    const real = {
      id: 'CD1-REAL',
      status: 'Confirmed',
      jobStatus: 'confirmed',
      preferredDate: '2026-11-18',
      confirmedDate: '2026-11-18',
    };
    assert.equal(selectUpcoming([row, real], { now: NOW.getTime() }).id, 'CD1-REAL');
    assert.equal(selectUpcoming([row], { now: NOW.getTime() }).id, 'CD1-BAD');
  });

  it('18. an extra waiting on approval blocks automatic close', () => {
    const blocked = serviceReadyToAutoClose(paidVisit({
      priceAdjustments: [{ adjustmentId: 'adj_1', status: 'pending_customer', amountCents: 2000 }],
    }), { now: NOW });
    assert.equal(blocked.reason, 'pending_approval');
  });

  it('19. online card charging stays disabled', () => {
    const baked = require('../netlify/lib/deploy-runtime-env.generated');
    assert.equal(baked.STRIPE_PRODUCTION_CUSTOMER_PAYMENTS_ENABLED, false);
    assert.equal(productionCustomerPaymentsBlocked(process.env), true);
    const touched = [
      'netlify/lib/onsite-job-close.js',
      'netlify/lib/service-completion-notice.js',
      'netlify/functions/admin-quick-ops.js',
      'netlify/functions/tech-quick-ops.js',
    ].map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
    assert.doesNotMatch(touched, /paymentIntents\.create|square\.payments|checkout\.sessions/i);
  });

  it('20. manual finish still runs complete then approve without charging a saved card', async () => {
    const calls = [];
    setFinishAdminActionRunner(async (body) => {
      calls.push(body);
      return { statusCode: 200, body: JSON.stringify({ ok: true, jobStatus: 'completed_paid', reviewRequest: { queued: false } }) };
    });
    const { finishJobQuickOps } = require('../netlify/lib/quick-ops-finish');
    const result = await finishJobQuickOps(paidVisit({ jobStatus: 'confirmed' }), {});
    assert.equal(result.ok, true);
    assert.deepEqual(calls.map((call) => call.action), ['admin_tech_status', 'approve_completion']);
    assert.equal(calls[0].statusAction, 'complete_service');
    assert.equal(calls[1].confirmSavedCardCharge, false);
  });

  it('labels paid, open, due, partial, prepaid, and refunded visits separately', () => {
    const paidDone = executedPaid({
      jobStatus: 'completed_paid',
      status: 'Completed',
      completedAt: '2020-06-01T18:00:00.000Z',
    });
    assert.equal(customerStatusSummary(paidDone), 'Completed — Paid');
    assert.notEqual(customerFacingStatusKey(paidDone), 'payment_due');

    const paidOpen = paidVisit({
      jobStatus: 'confirmed',
      status: 'Confirmed',
      appointmentStatus: 'confirmed',
      arrivedAt: null,
      techCompletedAt: null,
    });
    assert.equal(customerStatusSummary(paidOpen), 'Confirmed — Paid');
    assert.equal(customerPaymentLabel(paidOpen), 'Paid');

    const due = openVisit({ jobStatus: 'completed_pending_payment', paymentStatus: 'due' });
    assert.equal(customerStatusSummary(due), 'Completed — Balance due');

    const partial = paidVisit({
      jobStatus: 'in_progress',
      ledger: { currency: 'usd', approvedCents: 42000, settledCents: 10000, creditedCents: 0 },
      paymentStatus: 'partially_paid',
    });
    assert.equal(customerPaymentLabel(partial), 'Partially paid');
    assert.equal(customerStatusSummary(partial), 'In progress — Partially paid');

    const prepaid = paidVisit({
      jobStatus: 'confirmed',
      status: 'Confirmed',
      confirmedDate: '2099-01-01',
      preferredDate: '2099-01-01',
      arrivedAt: null,
      techCompletedAt: null,
    });
    assert.equal(customerStatusSummary(prepaid), 'Confirmed — Paid');
    assert.equal(serviceReadyToAutoClose(prepaid, { now: NOW }).reason, 'future_service');

    const refunded = paidVisit({
      jobStatus: 'cancelled',
      status: 'Cancelled',
      appointmentStatus: 'canceled',
      paymentStatus: 'refunded',
      remainingCents: 0,
      settledCents: 0,
    });
    assert.equal(customerStatusSummary(refunded), 'Cancelled — Refunded');
  });

  it('pages portal history without dropping the current appointment', () => {
    const current = {
      id: 'CD1-NEXT',
      status: 'Confirmed',
      jobStatus: 'confirmed',
      confirmedDate: '2026-11-20',
      preferredDate: '2026-11-20',
      service: 'Full detail',
    };
    const history = Array.from({ length: 200 }, (_, i) => ({
      id: `CD1-H${String(i).padStart(3, '0')}`,
      status: 'Completed',
      jobStatus: 'completed_paid',
      confirmedDate: '2020-01-02',
      preferredDate: '2020-01-02',
      service: 'Maintenance detail',
      vehicleLabel: '2020 Honda Civic',
    }));
    const full = [current, ...history];
    const page = selectPortalPage(full, { now: NOW.getTime(), limit: 8 });
    const fullBytes = Buffer.byteLength(JSON.stringify(full));
    const pageBytes = Buffer.byteLength(JSON.stringify(page.bookings));
    console.log(JSON.stringify({
      fullRecords: full.length,
      pageRecords: page.bookings.length,
      fullBytes,
      pageBytes,
      historyReturned: page.historyPage.returned,
    }));
    assert.equal(page.bookings[0].id, 'CD1-NEXT');
    assert.equal(page.historyPage.returned, 8);
    assert.equal(page.historyPage.total, 200);
    assert.equal(page.historyPage.hasMore, true);
    assert.equal(page.bookings.length, 9);
    assert.ok(pageBytes < fullBytes);
    const next = selectPortalPage(full, {
      now: NOW.getTime(),
      limit: 8,
      cursor: page.historyPage.nextCursor,
    });
    assert.equal(next.historyPage.returned, 8);
    assert.equal(next.bookings.some((row) => row.id === page.historyPage.nextCursor), false);
    assert.equal(next.bookings[0].id, 'CD1-NEXT');
  });

  it('builds a customer receipt from the settled ledger without admin fields', () => {
    const booking = executedPaid({
      jobStatus: 'completed_paid',
      status: 'Completed',
      completedAt: '2020-06-01T18:00:00.000Z',
      paymentWorkflowStatus: 'cash_paid',
      vehicle: '2020 Honda Civic',
      package: 'Full detail',
      techPayoutAmount: 180,
      address: '1 Test Way',
      ledger: {
        currency: 'usd',
        approvedCents: 42000,
        settledCents: 42000,
        creditedCents: 0,
        entries: [{
          kind: 'settlement',
          method: 'cash',
          amountCents: 42000,
          recordedAt: '2020-06-01T18:00:00.000Z',
          providerObjectId: 'cash',
        }],
      },
    });
    const result = buildReceiptProjection(booking, 'final');
    assert.equal(result.ok, true, result.error || result.message);
    assert.equal(result.receipt.business.name, 'Cardetail1');
    assert.equal(result.receipt.business.legalName, 'Detailing Zone L.L.C.');
    assert.equal(result.receipt.financialSummary.approvedTotal.display, '$420.00');
    assert.equal(result.receipt.financialSummary.amountPaid.display, '$420.00');
    assert.equal(result.receipt.financialSummary.remainingBalance.display, '$0.00');
    assert.equal(result.receipt.paymentMethod, 'Cash');
    assert.equal(result.receipt.status, 'Paid');
    const serialized = JSON.stringify(result.receipt);
    assert.equal(serialized.includes('techPayout'), false);
    assert.equal(serialized.includes('180'), false);
  });

  it('keeps one completion text when two closes race, and skips old webhook replays', async () => {
    const rows = new Map();
    let chain = Promise.resolve();
    const prisma = {
      smsOutbox: {
        async findUnique({ where }) {
          return rows.get(where.idempotencyKey) || null;
        },
        async create({ data }) {
          const run = chain.then(() => {
            if (rows.has(data.idempotencyKey)) {
              const err = new Error('unique');
              err.code = 'P2002';
              throw err;
            }
            const row = { id: 'sms_1', ...data };
            rows.set(data.idempotencyKey, row);
            return row;
          });
          chain = run.then(() => {}, () => {});
          return run;
        },
      },
    };
    const booking = paidVisit({
      jobStatus: 'completed_paid',
      status: 'Completed',
      completedAt: new Date().toISOString(),
      phone: '2015550144',
      transactionalSmsConsentAccepted: true,
      transactionalSmsConsent: canonicalBookingSmsConsent(true, '2020-06-01T12:00:00.000Z', '2015550144'),
    });
    const env = {
      CONTEXT: 'production',
      BRANCH: 'master',
      URL: 'https://cardetail1.com',
      PUBLIC_SITE_URL: 'https://cardetail1.com',
      CUSTOMER_TRANSACTIONAL_SMS_ENABLED: 'true',
      TWILIO_OUTBOX_ENABLED: 'true',
      TWILIO_ENABLED: 'true',
    };
    const [first, second] = await Promise.all([
      notifyIfServiceClosedAndPaid(booking, { prisma, env, source: 'approve_completion' }),
      notifyIfServiceClosedAndPaid(booking, { prisma, env, source: 'approve_completion' }),
    ]);
    assert.equal(rows.size, 1);
    assert.equal([first, second].filter((row) => row.queued).length, 2);
    assert.equal([first, second].some((row) => row.idempotent), true);
    const again = await notifyIfServiceClosedAndPaid(booking, { prisma, env });
    assert.equal(again.idempotent, true);
    assert.equal(rows.size, 1);
    const old = { ...booking, completedAt: '2020-01-01T00:00:00.000Z' };
    const replay = await notifyIfServiceClosedAndPaid(old, { prisma, env, source: 'stripe_webhook' });
    assert.equal(replay.queued, false);
    assert.equal(replay.reason, 'historical_completion');
    assert.equal(rows.size, 1);
  });
});
