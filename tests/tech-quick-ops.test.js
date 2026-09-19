'use strict';

/**
 * Booking-scoped Technician Quick Ops.
 * GET never mutates. Tokens are tech_quick_ops only. Direct getBookingRecord.
 */

const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const { createCasMemoryStore } = require('./helpers/cas-memory-store');
const { setBookingStoreOverride, getBookingRecord } = require('../netlify/lib/booking-repository');
const {
  PURPOSE_TECH_QUICK_OPS,
  TOKEN_PREFIX,
  COOKIE_NAME,
  createTechQuickOpsToken,
  createTechQuickOpsSession,
  sessionCookieHeader,
  setTechQuickOpsStoreFactories,
  resetTechQuickOpsStoreFactories,
  mintTechOpsUrl,
} = require('../netlify/lib/tech-quick-ops-token');
const { PURPOSE_ADMIN_QUICK_OPS, TOKEN_PREFIX: QO_PREFIX } = require('../netlify/lib/admin-quick-ops-token');
const { PURPOSE_CUSTOMER_BALANCE, TOKEN_PREFIX: PAY_PREFIX } = require('../netlify/lib/payment-resume-token');
const { PURPOSE_APPOINTMENT_ACCESS, TOKEN_PREFIX: AAT_PREFIX } = require('../netlify/lib/appointment-access-token');
const {
  updateTechFieldStatus,
  completeTechJob,
} = require('../netlify/lib/tech-quick-ops-actions');
const { projectTechQuickOpsBooking } = require('../netlify/lib/tech-quick-ops-view');
const tqHandler = require('../netlify/functions/tech-quick-ops');

const SECRET = 'test-tech-quick-ops-secret-32chars';
const QO_SECRET = 'test-admin-quick-ops-secret-32chars';

function pendingBooking(overrides = {}) {
  const recordedAt = overrides.finalizedAt || '2026-09-16T12:00:00.000Z';
  return {
    id: overrides.id || 'CD1-TQ-01',
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
    notes: 'Gate code 12',
    vehicles: [{
      year: 2025,
      make: 'Honda',
      model: 'Civic',
      category: 'cars',
    }],
    ledger: {
      currency: 'usd',
      approvedCents: 19000,
      settledCents: 0,
      creditedCents: 0,
      pendingCents: 0,
      entries: [],
    },
    finalizedAt: recordedAt,
    createdAt: recordedAt,
    changeRequests: [],
    ...overrides,
  };
}

function assignedBooking(overrides = {}) {
  return pendingBooking({
    status: 'Confirmed',
    appointmentStatus: 'confirmed',
    jobStatus: 'assigned',
    assignedTechId: 'tech-1',
    assignedTech: 'tech-1',
    assignedTechName: 'Jordan Tech',
    ...overrides,
  });
}

async function sessionEventFor(bookingId) {
  const session = await createTechQuickOpsSession({ bookingId });
  assert.equal(session.ok, true, session.error);
  return {
    session,
    event: {
      httpMethod: 'GET',
      headers: {
        cookie: `${COOKIE_NAME}=${encodeURIComponent(session.sessionId)}`,
        accept: 'application/json',
        host: 'cardetail1.com',
      },
      path: '/tech/q',
    },
  };
}

before(() => {
  process.env.PUBLIC_SITE_URL = 'https://cardetail1.com';
  process.env.CONTEXT = 'production';
  process.env.TECH_QUICK_OPS_SECRET = SECRET;
  process.env.ADMIN_QUICK_OPS_SECRET = QO_SECRET;
  process.env.CD1_POSTGRES_PAYMENT = 'false';
});

beforeEach(() => {
  const tokenStore = createCasMemoryStore();
  const sessionStore = createCasMemoryStore();
  setTechQuickOpsStoreFactories({
    tokenStore: () => tokenStore,
    sessionStore: () => sessionStore,
  });
});

afterEach(() => {
  resetTechQuickOpsStoreFactories();
  setBookingStoreOverride(null);
});

describe('purpose isolation', () => {
  it('keeps appointment, admin quick ops, tech quick ops, and payment purposes distinct', () => {
    assert.equal(PURPOSE_APPOINTMENT_ACCESS, 'appointment_access');
    assert.equal(PURPOSE_ADMIN_QUICK_OPS, 'admin_quick_ops');
    assert.equal(PURPOSE_TECH_QUICK_OPS, 'tech_quick_ops');
    assert.equal(PURPOSE_CUSTOMER_BALANCE, 'customer_balance');
    assert.equal(TOKEN_PREFIX, 'tot_');
    assert.equal(QO_PREFIX, 'qot_');
    assert.equal(PAY_PREFIX, 'prt_');
    assert.equal(AAT_PREFIX, 'aat_');
    assert.notEqual(TOKEN_PREFIX, QO_PREFIX);
    assert.notEqual(TOKEN_PREFIX, PAY_PREFIX);
    assert.notEqual(TOKEN_PREFIX, AAT_PREFIX);
  });
});

describe('token + GET never mutates', () => {
  it('valid token mints a scoped session and redirects without changing the booking', async () => {
    const booking = assignedBooking();
    const store = createCasMemoryStore({ [booking.id]: booking });
    setBookingStoreOverride(store);
    const minted = await createTechQuickOpsToken({ bookingId: booking.id });
    assert.equal(minted.ok, true);
    assert.match(minted.techOpsUrl, /^https:\/\/cardetail1\.com\/tech\/q\/tot_/);
    assert.doesNotMatch(minted.token, /Alex|Rivera|201555|Harbor/);
    const before = await getBookingRecord(booking.id);
    const t0 = Date.now();
    const res = await tqHandler.handler({
      httpMethod: 'GET',
      path: `/tech/q/${minted.token}`,
      rawUrl: `https://cardetail1.com/tech/q/${minted.token}`,
      headers: { host: 'cardetail1.com' },
    });
    const tokenMs = Date.now() - t0;
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.Location, '/tech/q');
    assert.match(res.headers['Set-Cookie'], /HttpOnly/);
    assert.match(res.headers['Set-Cookie'], /Secure/);
    assert.match(res.headers['Set-Cookie'], /SameSite=Lax/);
    assert.doesNotMatch(res.headers['Set-Cookie'], /admin_session|cd1_qo_session|cd1_admin/i);
    const after = await getBookingRecord(booking.id);
    assert.equal(after.booking.bookingVersion, before.booking.bookingVersion);
    assert.equal(after.booking.jobStatus, 'assigned');
    assert.ok(tokenMs < 250, `token GET took ${tokenMs}ms`);
  });

  it('same token reload still does not mutate and reuses the same logical token', async () => {
    const booking = assignedBooking();
    setBookingStoreOverride(createCasMemoryStore({ [booking.id]: booking }));
    const first = await createTechQuickOpsToken({ bookingId: booking.id });
    const second = await createTechQuickOpsToken({ bookingId: booking.id });
    assert.equal(second.reused, true);
    assert.equal(first.token, second.token);
    await tqHandler.handler({
      httpMethod: 'GET',
      path: `/tech/q/${first.token}`,
      headers: { host: 'cardetail1.com' },
    });
    const again = await tqHandler.handler({
      httpMethod: 'GET',
      path: `/tech/q/${first.token}`,
      headers: { host: 'cardetail1.com' },
    });
    assert.equal(again.statusCode, 302);
    const rec = await getBookingRecord(booking.id);
    assert.equal(rec.booking.jobStatus, 'assigned');
    assert.equal(rec.booking.bookingVersion, 1);
  });

  it('expired, invalid, and wrong-audience tokens stay neutral', async () => {
    const booking = assignedBooking();
    setBookingStoreOverride(createCasMemoryStore({ [booking.id]: booking }));
    const invalid = await tqHandler.handler({
      httpMethod: 'GET',
      path: '/tech/q/tot_not-a-real-token-value',
      headers: { accept: 'application/json', host: 'cardetail1.com' },
    });
    assert.equal(invalid.statusCode, 400);
    const payload = JSON.parse(invalid.body);
    assert.equal(payload.error, 'invalid');
    assert.doesNotMatch(invalid.body, /CD1-TQ|Alex|Rivera/);

    const html = await tqHandler.handler({
      httpMethod: 'GET',
      path: '/tech/q/tot_not-a-real-token-value',
      headers: { host: 'cardetail1.com' },
    });
    assert.match(html.body, /Link expired or invalid/);
    assert.doesNotMatch(html.body, /CD1-TQ|Alex|Rivera|Harbor/);

    const adminToken = `${QO_PREFIX}${'A'.repeat(43)}`;
    const wrongAdmin = await tqHandler.handler({
      httpMethod: 'GET',
      path: `/tech/q/${adminToken}`,
      headers: { accept: 'application/json', host: 'cardetail1.com' },
    });
    assert.equal(wrongAdmin.statusCode, 400);
    assert.doesNotMatch(wrongAdmin.body, /CD1-TQ|Alex/);

    const payToken = `${PAY_PREFIX}${'B'.repeat(43)}`;
    const wrongPay = await tqHandler.handler({
      httpMethod: 'GET',
      path: `/tech/q/${payToken}`,
      headers: { accept: 'application/json', host: 'cardetail1.com' },
    });
    assert.equal(wrongPay.statusCode, 400);
  });

  it('session for booking A cannot read booking B', async () => {
    const a = assignedBooking({ id: 'CD1-TQ-A' });
    const b = assignedBooking({
      id: 'CD1-TQ-B',
      firstName: 'Other',
      lastName: 'Person',
      phone: '+12015550188',
    });
    setBookingStoreOverride(createCasMemoryStore({ [a.id]: a, [b.id]: b }));
    const { event } = await sessionEventFor(a.id);
    const res = await tqHandler.handler(event);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.view.bookingId, a.id);
    assert.equal(body.view.customer.name, 'Alex Rivera');
    assert.notEqual(body.view.bookingId, b.id);
    assert.doesNotMatch(res.body, /Other Person/);
    assert.equal(body.bookingReads, 1);
  });

  it('GET session page uses one direct booking read and no scan APIs', async () => {
    const booking = assignedBooking();
    setBookingStoreOverride(createCasMemoryStore({ [booking.id]: booking }));
    const { event } = await sessionEventFor(booking.id);
    const t0 = Date.now();
    const res = await tqHandler.handler(event);
    const readMs = Date.now() - t0;
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.bookingReads, 1);
    assert.equal(body.view.money.remainingCents, 19000);
    assert.ok(readMs < 250, `booking GET took ${readMs}ms`);
    const src = [
      read('netlify/functions/tech-quick-ops.js'),
      read('netlify/lib/tech-quick-ops-actions.js'),
      read('netlify/lib/tech-quick-ops-view.js'),
    ].join('\n');
    assert.doesNotMatch(src, /listSubmittedBookings/);
    assert.doesNotMatch(src, /listAllBlobs/);
    assert.doesNotMatch(src, /admin-ops-jobs/);
    assert.doesNotMatch(src, /store\.list\(/);
    assert.doesNotMatch(src, /adminMarkCashReceived|adminMarkCardOnSite/);
    assert.doesNotMatch(src, /getBooking\(/);
    assert.match(src, /getBookingRecord/);
  });
});

describe('tech quick ops page + actions', () => {
  it('projects the same terms with limited field actions only', () => {
    const pending = projectTechQuickOpsBooking(pendingBooking());
    assert.equal(pending.customer.name, 'Alex Rivera');
    assert.equal(pending.actions.call, true);
    assert.equal(pending.actions.map, true);
    assert.equal(pending.actions.accept, false);
    assert.equal(pending.actions.complete, false);
    assert.equal(pending.actions.confirm, false);
    assert.equal(pending.actions.cancel, false);
    assert.equal(pending.actions.payment, false);
    assert.equal(pending.actions.cash, false);
    assert.equal(pending.actions.card, false);
    assert.equal(pending.actions.text, false);

    const assigned = projectTechQuickOpsBooking(assignedBooking());
    assert.equal(assigned.assignedTech, 'Jordan Tech');
    assert.equal(assigned.fieldStatus, 'assigned');
    assert.equal(assigned.actions.accept, true);
    assert.equal(assigned.actions.en_route, true);
    assert.equal(assigned.actions.arrived, false);
    assert.equal(assigned.actions.complete, false);
    assert.equal(assigned.actions.confirm, false);
    assert.equal(assigned.money.remainingCents, 19000);
    assert.match(assigned.mapUrl, /Harbor/);

    const arrived = projectTechQuickOpsBooking(assignedBooking({ jobStatus: 'arrived' }));
    assert.equal(arrived.actions.complete, true);
    assert.equal(arrived.actions.in_progress, true);

    const done = projectTechQuickOpsBooking(assignedBooking({
      jobStatus: 'completed_pending_payment',
      completedAt: '2026-09-17T16:00:00.000Z',
    }));
    assert.equal(done.locked, true);
    assert.equal(done.actions.accept, false);
    assert.equal(done.actions.complete, false);
    assert.equal(done.actions.call, true);
  });

  it('accept and en_route are CAS writes and stay idempotent', async () => {
    const booking = assignedBooking();
    setBookingStoreOverride(createCasMemoryStore({ [booking.id]: booking }));
    const first = await updateTechFieldStatus(booking, 'accepted', { expectedBookingVersion: 1 });
    assert.equal(first.ok, true);
    assert.equal(first.transitioned, true);
    const rec = await getBookingRecord(booking.id);
    assert.equal(rec.booking.jobStatus, 'accepted');
    const again = await updateTechFieldStatus(rec.booking, 'accepted', {
      expectedBookingVersion: rec.booking.bookingVersion,
    });
    assert.equal(again.ok, true);
    assert.equal(again.idempotent, true);
    const latest = await getBookingRecord(booking.id);
    assert.equal(latest.booking.bookingVersion, rec.booking.bookingVersion);
  });

  it('rejects illegal field transitions and admin money actions', async () => {
    const booking = assignedBooking();
    setBookingStoreOverride(createCasMemoryStore({ [booking.id]: booking }));
    const arrived = await updateTechFieldStatus(booking, 'arrived', { expectedBookingVersion: 1 });
    assert.equal(arrived.ok, false);
    assert.equal(arrived.statusCode, 409);

    const { event, session } = await sessionEventFor(booking.id);
    const cash = await tqHandler.handler({
      ...event,
      httpMethod: 'POST',
      headers: { ...event.headers, 'x-tq-csrf': session.csrfToken },
      body: JSON.stringify({ action: 'record_cash', bookingVersion: 1 }),
    });
    assert.equal(cash.statusCode, 400);
    assert.equal(JSON.parse(cash.body).error, 'unknown_action');

    const confirm = await tqHandler.handler({
      ...event,
      httpMethod: 'POST',
      headers: { ...event.headers, 'x-tq-csrf': session.csrfToken },
      body: JSON.stringify({ action: 'confirm', bookingVersion: 1 }),
    });
    assert.equal(confirm.statusCode, 400);
  });

  it('POST without CSRF is rejected', async () => {
    const booking = assignedBooking();
    setBookingStoreOverride(createCasMemoryStore({ [booking.id]: booking }));
    const { event } = await sessionEventFor(booking.id);
    const res = await tqHandler.handler({
      ...event,
      httpMethod: 'POST',
      body: JSON.stringify({ action: 'accept', bookingVersion: 1 }),
    });
    assert.equal(res.statusCode, 403);
    const rec = await getBookingRecord(booking.id);
    assert.equal(rec.booking.jobStatus, 'assigned');
  });

  it('field action through the handler reloads the job', async () => {
    const booking = assignedBooking();
    setBookingStoreOverride(createCasMemoryStore({ [booking.id]: booking }));
    const { event, session } = await sessionEventFor(booking.id);
    const res = await tqHandler.handler({
      ...event,
      httpMethod: 'POST',
      headers: { ...event.headers, 'x-tq-csrf': session.csrfToken },
      body: JSON.stringify({ action: 'en_route', bookingVersion: 1 }),
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.reload, true);
    assert.equal(body.jobStatus, 'en_route');
    const rec = await getBookingRecord(booking.id);
    assert.equal(rec.booking.jobStatus, 'en_route');
    assert.ok(rec.booking.enRouteAt);
  });

  it('light mark-done uses pending payment when a balance remains', async () => {
    const booking = assignedBooking({ jobStatus: 'arrived', bookingVersion: 2 });
    setBookingStoreOverride(createCasMemoryStore({ [booking.id]: booking }));
    const result = await completeTechJob(booking, { expectedBookingVersion: 2 });
    assert.equal(result.ok, true);
    assert.equal(result.jobStatus, 'completed_pending_payment');
    const rec = await getBookingRecord(booking.id);
    assert.equal(rec.booking.jobStatus, 'completed_pending_payment');
    assert.ok(rec.booking.completedAt);
    assert.equal(rec.booking.paymentStatus || '', '');
    assert.ok(!rec.booking.cashReceivedAmount);
    assert.ok(!rec.booking.photosAfter);
  });

  it('light mark-done uses completed_paid when already settled', async () => {
    const booking = assignedBooking({
      jobStatus: 'in_progress',
      bookingVersion: 3,
      paymentStatus: 'paid_cash',
      cashReceivedAmount: 190,
      cashReceivedAt: '2026-09-17T16:00:00.000Z',
      ledger: { approvedCents: 19000, settledCents: 19000, creditedCents: 0 },
    });
    setBookingStoreOverride(createCasMemoryStore({ [booking.id]: booking }));
    const result = await completeTechJob(booking, { expectedBookingVersion: 3 });
    assert.equal(result.ok, true);
    assert.equal(result.jobStatus, 'completed_paid');
  });

  it('HTML shows field actions and hides admin money / confirm', async () => {
    const booking = assignedBooking({ jobStatus: 'arrived' });
    setBookingStoreOverride(createCasMemoryStore({ [booking.id]: booking }));
    const { event, session } = await sessionEventFor(booking.id);
    const html = await tqHandler.handler({
      ...event,
      headers: { ...event.headers, accept: 'text/html', cookie: event.headers.cookie },
    });
    assert.equal(html.statusCode, 200);
    assert.match(html.body, /Tech Quick Ops/);
    assert.match(html.body, /Mark job done/);
    assert.match(html.body, /Start job/);
    assert.match(html.body, /Call customer/);
    assert.match(html.body, /Open map/);
    assert.match(html.body, /Photos stay on the technician portal/);
    assert.doesNotMatch(html.body, /Confirm appointment/);
    assert.doesNotMatch(html.body, /Cancel appointment/);
    assert.doesNotMatch(html.body, /Record cash/);
    assert.doesNotMatch(html.body, /Record card/);
    assert.doesNotMatch(html.body, /Copy payment link/);
    assert.doesNotMatch(html.body, /Text customer/);
    assert.match(html.headers['X-Tq-Csrf'] || '', session.csrfToken);
  });
});

describe('architecture freeze', () => {
  it('does not add Stripe Payment Links, Checkout, or a second payment authority', () => {
    const files = [
      'netlify/functions/tech-quick-ops.js',
      'netlify/lib/tech-quick-ops-actions.js',
      'netlify/lib/tech-quick-ops-html.js',
    ];
    const src = files.map((file) => read(file)).join('\n');
    assert.doesNotMatch(src, /plink_/);
    assert.doesNotMatch(src, /checkout\.sessions/i);
    assert.doesNotMatch(src, /paymentLinks\.create|stripe\.paymentLinks/i);
    assert.doesNotMatch(src, /settleAdminCashFullBalance|settleAdminOnSiteFullBalance/);
    assert.doesNotMatch(src, /createPaymentResumeToken|mintPaymentLink/);
    assert.doesNotMatch(src, /enqueueSms/);
    const handlerSrc = read('netlify/functions/tech-quick-ops.js');
    const getFn = handlerSrc.slice(
      handlerSrc.indexOf('async function handleGet'),
      handlerSrc.indexOf('async function handlePost')
    );
    assert.match(handlerSrc, /if \(event\.httpMethod === 'GET'\) return handleGet/);
    assert.doesNotMatch(getFn, /updateTechFieldStatus|completeTechJob|commitBooking/);
  });

  it('cookie session is not an Admin or technician-login session', () => {
    const cookie = sessionCookieHeader('tos_testsession', { secure: true });
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.doesNotMatch(cookie, /admin_ops|owner_studio|jobs_board|cd1_qo_session/);
    const src = read('netlify/lib/tech-quick-ops-token.js');
    assert.doesNotMatch(src, /ADMIN_SESSION_SECRET/);
    assert.match(src, /TECH_QUICK_OPS_SECRET/);
  });

  it('mintTechOpsUrl is booking scoped and contains no PII', async () => {
    const url = await mintTechOpsUrl('CD1-TQ-01');
    assert.match(url, /^https:\/\/cardetail1\.com\/tech\/q\/tot_/);
    assert.doesNotMatch(url, /Alex|Rivera|5550177|Harbor/);
  });

  it('assignment returns a job-scoped tech ops URL', () => {
    const src = read('netlify/functions/tech-assignment.js');
    assert.match(src, /mintTechOpsUrl/);
    assert.match(src, /techOpsUrl/);
    assert.doesNotMatch(src, /listAllBlobs|store\.list\(/);
  });

  it('routes /tech/q without opening the scan portal', () => {
    const toml = read('netlify.toml');
    assert.match(toml, /from = "\/tech\/q"/);
    assert.match(toml, /to = "\/\.netlify\/functions\/tech-quick-ops"/);
    assert.match(toml, /from = "\/tech\/q\/\*"/);
    assert.doesNotMatch(read('netlify/functions/tech-quick-ops.js'), /technician\.html|tech-jobs/);
  });
});
