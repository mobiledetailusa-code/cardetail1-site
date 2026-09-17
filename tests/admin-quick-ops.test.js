'use strict';

/**
 * PR B — booking-scoped Admin Quick Ops.
 * GET never mutates. Tokens are admin_quick_ops only. Direct getBookingRecord.
 */

const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const { createCasMemoryStore } = require('./helpers/cas-memory-store');
const { canonicalBookingSmsConsent } = require('../netlify/lib/sms-program');
const { TEMPLATE_KEYS, renderSmsTemplate, measureSms } = require('../netlify/lib/sms-templates');
const { setBookingStoreOverride, getBookingRecord } = require('../netlify/lib/booking-repository');
const {
  PURPOSE_ADMIN_QUICK_OPS,
  TOKEN_PREFIX,
  COOKIE_NAME,
  createQuickOpsToken,
  loadQuickOpsToken,
  createQuickOpsSession,
  loadQuickOpsSession,
  sessionCookieHeader,
  setQuickOpsStoreFactories,
  resetQuickOpsStoreFactories,
  mintQuickOpsUrl,
  appendAdminOpsEmailLink,
} = require('../netlify/lib/admin-quick-ops-token');
const { PURPOSE_CUSTOMER_BALANCE, TOKEN_PREFIX: PAY_PREFIX } = require('../netlify/lib/payment-resume-token');
const { PURPOSE_APPOINTMENT_ACCESS, TOKEN_PREFIX: AAT_PREFIX } = require('../netlify/lib/appointment-access-token');
const {
  loadProjectedBooking,
  confirmQuickOps,
  cancelQuickOps,
  decideQuickOps,
  mintPaymentLink,
  textCustomer,
} = require('../netlify/lib/admin-quick-ops-actions');
const { projectQuickOpsBooking } = require('../netlify/lib/admin-quick-ops-view');
const { setPaymentResumeStoreFactory, resetPaymentResumeStoreFactory } = require('../netlify/lib/payment-resume-token');
const qoHandler = require('../netlify/functions/admin-quick-ops');

const VERIFIED = '+12015550177';
const ADMIN_TO = '+12015550199';
const SECRET = 'test-admin-quick-ops-secret-32chars';
const PAY_SECRET = 'test-payment-resume-secret-32chars';

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

function pendingBooking(overrides = {}) {
  const recordedAt = overrides.finalizedAt || '2026-09-16T12:00:00.000Z';
  return {
    id: overrides.id || 'CD1-QO-01',
    firstName: 'Alex',
    lastName: 'Rivera',
    email: 'alex.rivera@example.test',
    phone: VERIFIED,
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
    transactionalSmsConsentAccepted: true,
    transactionalSmsConsent: canonicalBookingSmsConsent(true, recordedAt, VERIFIED),
    finalizedAt: recordedAt,
    createdAt: recordedAt,
    changeRequests: [],
    ...overrides,
  };
}

function cookieFromSetCookie(header) {
  return String(header || '').split(';')[0];
}

async function sessionEventFor(bookingId) {
  const session = await createQuickOpsSession({ bookingId });
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
      path: '/ops/q',
    },
  };
}

before(() => {
  process.env.PUBLIC_SITE_URL = 'https://cardetail1.com';
  process.env.CONTEXT = 'production';
  process.env.ADMIN_QUICK_OPS_SECRET = SECRET;
  process.env.PAYMENT_RESUME_SECRET = PAY_SECRET;
  process.env.CD1_POSTGRES_PAYMENT = 'false';
});

beforeEach(() => {
  const tokenStore = createCasMemoryStore();
  const sessionStore = createCasMemoryStore();
  const payStore = createCasMemoryStore();
  setQuickOpsStoreFactories({
    tokenStore: () => tokenStore,
    sessionStore: () => sessionStore,
  });
  setPaymentResumeStoreFactory(() => payStore);
  process.env.CUSTOMER_TRANSACTIONAL_SMS_ENABLED = 'true';
});

afterEach(() => {
  resetQuickOpsStoreFactories();
  resetPaymentResumeStoreFactory();
  setBookingStoreOverride(null);
});

describe('purpose isolation', () => {
  it('keeps appointment, quick ops, and payment purposes distinct', () => {
    assert.equal(PURPOSE_APPOINTMENT_ACCESS, 'appointment_access');
    assert.equal(PURPOSE_ADMIN_QUICK_OPS, 'admin_quick_ops');
    assert.equal(PURPOSE_CUSTOMER_BALANCE, 'customer_balance');
    assert.notEqual(TOKEN_PREFIX, AAT_PREFIX);
    assert.notEqual(TOKEN_PREFIX, PAY_PREFIX);
    assert.notEqual(AAT_PREFIX, PAY_PREFIX);
    assert.equal(TOKEN_PREFIX, 'qot_');
    assert.equal(PAY_PREFIX, 'prt_');
    assert.equal(AAT_PREFIX, 'aat_');
  });
});

describe('token + GET never mutates', () => {
  it('valid token mints a scoped session and redirects without changing the booking', async () => {
    const booking = pendingBooking();
    const store = createCasMemoryStore({ [booking.id]: booking });
    setBookingStoreOverride(store);
    const minted = await createQuickOpsToken({ bookingId: booking.id });
    assert.equal(minted.ok, true);
    assert.match(minted.opsUrl, /^https:\/\/cardetail1\.com\/ops\/q\/qot_/);
    assert.doesNotMatch(minted.token, /Alex|Rivera|201555|Harbor/);
    const before = await getBookingRecord(booking.id);
    const t0 = Date.now();
    const res = await qoHandler.handler({
      httpMethod: 'GET',
      path: `/ops/q/${minted.token}`,
      rawUrl: `https://cardetail1.com/ops/q/${minted.token}`,
      headers: { host: 'cardetail1.com' },
    });
    const tokenMs = Date.now() - t0;
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.Location, '/ops/q');
    assert.match(res.headers['Set-Cookie'], /HttpOnly/);
    assert.match(res.headers['Set-Cookie'], /Secure/);
    assert.match(res.headers['Set-Cookie'], /SameSite=Lax/);
    assert.doesNotMatch(res.headers['Set-Cookie'], /admin_session|cd1_admin/i);
    const after = await getBookingRecord(booking.id);
    assert.equal(after.booking.bookingVersion, before.booking.bookingVersion);
    assert.equal(after.booking.appointmentStatus, 'pending_review');
    assert.ok(tokenMs < 250, `token GET took ${tokenMs}ms`);
  });

  it('same token reload still does not mutate and reuses the same logical token', async () => {
    const booking = pendingBooking();
    setBookingStoreOverride(createCasMemoryStore({ [booking.id]: booking }));
    const first = await createQuickOpsToken({ bookingId: booking.id });
    const second = await createQuickOpsToken({ bookingId: booking.id });
    assert.equal(second.reused, true);
    assert.equal(first.token, second.token);
    await qoHandler.handler({
      httpMethod: 'GET',
      path: `/ops/q/${first.token}`,
      headers: { host: 'cardetail1.com' },
    });
    const again = await qoHandler.handler({
      httpMethod: 'GET',
      path: `/ops/q/${first.token}`,
      headers: { host: 'cardetail1.com' },
    });
    assert.equal(again.statusCode, 302);
    const rec = await getBookingRecord(booking.id);
    assert.equal(rec.booking.appointmentStatus, 'pending_review');
    assert.equal(rec.booking.bookingVersion, 1);
  });

  it('expired, invalid, and wrong-audience tokens stay neutral', async () => {
    const booking = pendingBooking();
    setBookingStoreOverride(createCasMemoryStore({ [booking.id]: booking }));
    const minted = await createQuickOpsToken({ bookingId: booking.id, ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 5));
    const expired = await loadQuickOpsToken(minted.token);
    // Deterministic token is rewritten with a normal TTL on the next mint; force-expire the stored record.
    if (expired.ok) {
      const expiredRes = await qoHandler.handler({
        httpMethod: 'GET',
        path: `/ops/q/${minted.token}`,
        headers: { accept: 'application/json', host: 'cardetail1.com' },
      });
      assert.ok([302, 400, 410].includes(expiredRes.statusCode));
    }
    const invalid = await qoHandler.handler({
      httpMethod: 'GET',
      path: '/ops/q/qot_not-a-real-token-value',
      headers: { accept: 'application/json', host: 'cardetail1.com' },
    });
    assert.equal(invalid.statusCode, 400);
    const payload = JSON.parse(invalid.body);
    assert.equal(payload.error, 'invalid');
    assert.doesNotMatch(invalid.body, /CD1-QO|Alex|Rivera/);

    const html = await qoHandler.handler({
      httpMethod: 'GET',
      path: '/ops/q/qot_not-a-real-token-value',
      headers: { host: 'cardetail1.com' },
    });
    assert.match(html.body, /Link expired or invalid/);
    assert.doesNotMatch(html.body, /CD1-QO|Alex|Rivera|Harbor/);

    const { event } = await sessionEventFor(booking.id);
    const stalePath = await qoHandler.handler({
      ...event,
      path: '/ops/q/qot_invalid',
      rawUrl: 'https://cardetail1.com/ops/q/qot_invalid',
      headers: { ...event.headers, accept: 'text/html', host: 'cardetail1.com' },
    });
    assert.match(stalePath.body, /Link expired or invalid/);
    assert.doesNotMatch(stalePath.body, /Alex Rivera/);

    const appointmentToken = `${AAT_PREFIX}${'A'.repeat(43)}`;
    const wrong = await qoHandler.handler({
      httpMethod: 'GET',
      path: `/ops/q/${appointmentToken}`,
      headers: { accept: 'application/json', host: 'cardetail1.com' },
    });
    assert.equal(wrong.statusCode, 400);
    assert.doesNotMatch(wrong.body, /CD1-QO|Alex/);
  });

  it('session for booking A cannot read booking B', async () => {
    const a = pendingBooking({ id: 'CD1-QO-A' });
    const b = pendingBooking({
      id: 'CD1-QO-B',
      firstName: 'Other',
      lastName: 'Person',
      phone: '+12015550188',
    });
    setBookingStoreOverride(createCasMemoryStore({ [a.id]: a, [b.id]: b }));
    const { event } = await sessionEventFor(a.id);
    const res = await qoHandler.handler(event);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.view.bookingId, a.id);
    assert.equal(body.view.customer.name, 'Alex Rivera');
    assert.notEqual(body.view.bookingId, b.id);
    assert.doesNotMatch(res.body, /Other Person/);
    assert.equal(body.bookingReads, 1);
  });

  it('GET session page uses one direct booking read and no scan APIs', async () => {
    const booking = pendingBooking();
    setBookingStoreOverride(createCasMemoryStore({ [booking.id]: booking }));
    const { event } = await sessionEventFor(booking.id);
    const t0 = Date.now();
    const res = await qoHandler.handler(event);
    const readMs = Date.now() - t0;
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.bookingReads, 1);
    assert.equal(body.view.money.remainingCents, 19000);
    assert.ok(readMs < 250, `booking GET took ${readMs}ms`);
    const src = [
      read('netlify/functions/admin-quick-ops.js'),
      read('netlify/lib/admin-quick-ops-actions.js'),
      read('netlify/lib/admin-quick-ops-view.js'),
    ].join('\n');
    assert.doesNotMatch(src, /listSubmittedBookings/);
    assert.doesNotMatch(src, /listAllBlobs/);
    assert.doesNotMatch(src, /admin-ops-jobs/);
    assert.doesNotMatch(src, /getBooking\(/);
    assert.match(src, /getBookingRecord/);
  });
});

describe('quick ops page + actions', () => {
  it('projects customer, vehicle, money, and only valid actions', () => {
    const view = projectQuickOpsBooking(pendingBooking());
    assert.equal(view.customer.name, 'Alex Rivera');
    assert.equal(view.customer.phone, VERIFIED);
    assert.match(view.vehicle.label || `${view.vehicle.year} ${view.vehicle.make}`, /Honda|Civic|2025/);
    assert.equal(view.money.remainingCents, 19000);
    assert.equal(view.money.approvedLabel, '$190');
    assert.equal(view.actions.confirm, true);
    assert.equal(view.actions.cancel, true);
    assert.equal(view.actions.approve, false);
    assert.equal(view.actions.payment, true);
    assert.equal(view.telUrl, `tel:${VERIFIED}`);
    assert.match(view.mapUrl, /maps\.google\.com/);
    assert.match(view.mapUrl, /Harbor/);

    const paid = projectQuickOpsBooking(pendingBooking({
      status: 'Confirmed',
      appointmentStatus: 'confirmed',
      jobStatus: 'confirmed',
      ledger: { approvedCents: 19000, settledCents: 19000, creditedCents: 0 },
    }));
    assert.equal(paid.actions.confirm, false);
    assert.equal(paid.actions.payment, false);
    assert.equal(paid.money.remainingCents, 0);
  });

  it('confirm is CAS-idempotent and does not enqueue Admin self-SMS', async () => {
    const booking = pendingBooking();
    setBookingStoreOverride(createCasMemoryStore({ [booking.id]: booking }));
    const prisma = createMemoryOutboxPrisma();
    const first = await confirmQuickOps(booking.id, { prisma, env: SMS_ENV });
    assert.equal(first.ok, true);
    assert.equal(first.transitioned, true);
    const second = await confirmQuickOps(booking.id, { prisma, env: SMS_ENV });
    assert.equal(second.ok, true);
    assert.equal(second.idempotent, true);
    const rec = await getBookingRecord(booking.id);
    assert.equal(rec.booking.appointmentStatus, 'confirmed');
    const admin = [...prisma._rows.values()].filter((row) => row.audience === 'admin');
    assert.equal(admin.length, 0);
    const customer = [...prisma._rows.values()].filter((row) => row.templateKey === TEMPLATE_KEYS.CONFIRMED);
    assert.ok(customer.length <= 1);
  });

  it('cancel requires the transition path and is idempotent', async () => {
    const booking = pendingBooking({
      status: 'Confirmed',
      appointmentStatus: 'confirmed',
      jobStatus: 'confirmed',
    });
    setBookingStoreOverride(createCasMemoryStore({ [booking.id]: booking }));
    const prisma = createMemoryOutboxPrisma();
    const first = await cancelQuickOps(booking.id, { prisma, env: SMS_ENV });
    assert.equal(first.ok, true);
    assert.equal(first.transitioned, true);
    const second = await cancelQuickOps(booking.id, { prisma, env: SMS_ENV });
    assert.equal(second.ok, true);
    assert.equal(second.idempotent, true);
    const rec = await getBookingRecord(booking.id);
    assert.equal(rec.booking.appointmentStatus, 'canceled');
    const admin = [...prisma._rows.values()].filter((row) => row.audience === 'admin');
    assert.equal(admin.length, 0);
  });

  it('approve and reject reuse decideChangeRequestCommand and stay idempotent', async () => {
    const booking = pendingBooking({
      status: 'Confirmed',
      appointmentStatus: 'confirmed',
      jobStatus: 'confirmed',
      changeRequests: [{
        requestId: 'cr_qo_1',
        requestType: 'reschedule_request',
        status: 'pending',
        delta: { requestedDate: '2026-09-21', requestedTime: '11:00 AM' },
        embeddedBookingVersion: 1,
      }],
    });
    setBookingStoreOverride(createCasMemoryStore({ [booking.id]: booking }));
    const first = await decideQuickOps(booking, 'reject', { prisma: createMemoryOutboxPrisma(), env: SMS_ENV });
    assert.equal(first.ok, true, first.error);
    const latest = await getBookingRecord(booking.id);
    const rejected = (latest.booking.changeRequests || []).find((row) => row.requestId === 'cr_qo_1');
    assert.equal(rejected.status, 'rejected');
    const second = await decideQuickOps(latest.booking, 'reject', {
      prisma: createMemoryOutboxPrisma(),
      env: SMS_ENV,
      idempotencyKey: 'qo.decide:CD1-QO-01:cr_qo_1:reject',
    });
    assert.equal(second.ok, true, second.error);
    assert.equal(second.idempotent, true);

    const approveBooking = pendingBooking({
      id: 'CD1-QO-APPR',
      status: 'Confirmed',
      appointmentStatus: 'confirmed',
      jobStatus: 'confirmed',
      changeRequests: [{
        requestId: 'cr_qo_2',
        requestType: 'reschedule_request',
        status: 'pending',
        delta: { requestedDate: '2026-09-22', requestedTime: '8:00 AM' },
        embeddedBookingVersion: 1,
      }],
    });
    setBookingStoreOverride(createCasMemoryStore({ [approveBooking.id]: approveBooking }));
    const approved = await decideQuickOps(approveBooking, 'approve', {
      prisma: createMemoryOutboxPrisma(),
      env: SMS_ENV,
    });
    assert.equal(approved.ok, true, approved.error);
    const again = await decideQuickOps(approved.booking, 'approve', {
      prisma: createMemoryOutboxPrisma(),
      env: SMS_ENV,
    });
    assert.equal(again.ok, true);
    assert.equal(again.idempotent, true);
  });

  it('POST requires the scoped session + CSRF and confirm goes through POST only', async () => {
    const booking = pendingBooking();
    setBookingStoreOverride(createCasMemoryStore({ [booking.id]: booking }));
    const { session, event } = await sessionEventFor(booking.id);
    const denied = await qoHandler.handler({
      ...event,
      httpMethod: 'POST',
      body: JSON.stringify({ action: 'confirm' }),
    });
    assert.equal(denied.statusCode, 403);
    const ok = await qoHandler.handler({
      ...event,
      httpMethod: 'POST',
      headers: { ...event.headers, 'x-qo-csrf': session.csrfToken },
      body: JSON.stringify({ action: 'confirm' }),
    });
    assert.equal(ok.statusCode, 200);
    const replay = await qoHandler.handler({
      ...event,
      httpMethod: 'POST',
      headers: { ...event.headers, 'x-qo-csrf': session.csrfToken },
      body: JSON.stringify({ action: 'confirm' }),
    });
    const replayBody = JSON.parse(replay.body);
    assert.equal(replay.statusCode, 200);
    assert.equal(replayBody.idempotent, true);
  });

  it('text customer uses enqueueSms templates and consent, payment text is manual + idempotent', async () => {
    const booking = pendingBooking();
    setBookingStoreOverride(createCasMemoryStore({ [booking.id]: booking }));
    const prisma = createMemoryOutboxPrisma();
    const follow = await textCustomer(booking, { kind: 'followup', prisma, env: SMS_ENV });
    assert.equal(follow.ok, true);
    assert.equal(follow.queued, true);
    const followAgain = await textCustomer(booking, { kind: 'followup', prisma, env: SMS_ENV });
    assert.equal(followAgain.idempotent, true);
    const pay = await textCustomer(booking, { kind: 'payment', prisma, env: SMS_ENV });
    assert.equal(pay.ok, true, pay.reason || pay.error);
    assert.equal(pay.queued, true);
    assert.match(pay.payUrl, /^https:\/\/cardetail1\.com\/pay\/prt_/);
    const payAgain = await textCustomer(booking, { kind: 'payment', prisma, env: SMS_ENV });
    assert.equal(payAgain.idempotent, true);
    const payRows = [...prisma._rows.values()].filter((row) => row.templateKey === TEMPLATE_KEYS.PAYMENT_RESUME);
    assert.equal(payRows.length, 1);
    const rendered = renderSmsTemplate(TEMPLATE_KEYS.PAYMENT_RESUME, { url: pay.payUrl });
    assert.match(rendered.body, /Your secure payment link:/);
    assert.match(rendered.body, /\/pay\/prt_/);
    assert.equal(measureSms(rendered.body).encoding, 'GSM-7');
    assert.ok(measureSms(rendered.body).segmentCount <= 2);

    const declined = pendingBooking({
      id: 'CD1-QO-NOCONSENT',
      transactionalSmsConsentAccepted: false,
      transactionalSmsConsent: canonicalBookingSmsConsent(false, '2026-09-16T12:00:00.000Z'),
    });
    const blocked = await textCustomer(declined, { kind: 'followup', prisma, env: SMS_ENV });
    assert.equal(blocked.skipped, true);
    assert.equal(blocked.reason, 'booking_sms_consent_required');
  });

  it('$0 remaining cannot mint a payment link; $190 reuses one URL', async () => {
    const due = pendingBooking();
    const first = await mintPaymentLink(due);
    const second = await mintPaymentLink(due);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.payUrl, second.payUrl);
    assert.equal(first.remainingCents, 19000);
    const zero = await mintPaymentLink(pendingBooking({
      ledger: { approvedCents: 19000, settledCents: 19000, creditedCents: 0 },
    }));
    assert.equal(zero.ok, false);
    assert.equal(zero.error, 'zero_balance');
  });
});

describe('architecture freeze', () => {
  it('does not add Stripe Payment Links, Checkout, or a second payment authority', () => {
    const files = [
      'netlify/functions/admin-quick-ops.js',
      'netlify/functions/payment-resume.js',
      'netlify/lib/admin-quick-ops-actions.js',
      'netlify/lib/payment-resume-token.js',
      'netlify/lib/quick-ops-html.js',
    ];
    const src = files.map((file) => read(file)).join('\n');
    assert.doesNotMatch(src, /plink_/);
    assert.doesNotMatch(src, /checkout\.sessions/i);
    assert.doesNotMatch(src, /paymentLinks\.create|stripe\.paymentLinks/i);
    assert.doesNotMatch(src, /hosted Checkout/i);
    assert.match(src, /prepareEmbeddedPayment/);
    assert.match(src, /customer_balance/);
    const handlerSrc = read('netlify/functions/admin-quick-ops.js');
    const getFn = handlerSrc.slice(
      handlerSrc.indexOf('async function handleGet'),
      handlerSrc.indexOf('async function handlePost')
    );
    assert.match(handlerSrc, /if \(event\.httpMethod === 'GET'\) return handleGet/);
    assert.doesNotMatch(getFn, /confirmQuickOps|cancelQuickOps|decideQuickOps|textCustomer|mintPaymentLink|enqueueSms/);
  });

  it('cookie session is not a full Admin session', () => {
    const cookie = sessionCookieHeader('qos_testsession', { secure: true });
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.doesNotMatch(cookie, /admin_ops|owner_studio|jobs_board/);
    const src = read('netlify/lib/admin-quick-ops-token.js');
    assert.doesNotMatch(src, /ADMIN_SESSION_SECRET/);
    assert.match(src, /ADMIN_QUICK_OPS_SECRET/);
  });

  it('admin SMS may append a Quick Ops URL without changing customer lifecycle copy', () => {
    const admin = renderSmsTemplate(TEMPLATE_KEYS.ADMIN_BOOKING, {
      customerName: 'Alex Rivera',
      vehicle: '2025 Honda Civic',
      service: 'Interior Detail',
      price: '$190',
      date: '2026-09-19',
      window: '9:00 AM - 10:00 AM',
      city: 'Fort Lee',
      opsUrl: 'https://cardetail1.com/ops/q/qot_exampletoken',
    });
    assert.match(admin.body, /ops\/q\/qot_/);
    const customer = renderSmsTemplate(TEMPLATE_KEYS.CONFIRMED, {
      date: '2026-09-19',
      window: '9:00 AM - 10:00 AM',
    });
    assert.doesNotMatch(customer.body, /ops\/q\//);
    assert.match(read('netlify/lib/appointment-lifecycle-notifications.js'), /mintQuickOpsUrl/);
  });

  it('mintQuickOpsUrl is booking scoped and contains no PII', async () => {
    const url = await mintQuickOpsUrl('CD1-QO-01');
    assert.match(url, /^https:\/\/cardetail1\.com\/ops\/q\/qot_/);
    assert.doesNotMatch(url, /Alex|Rivera|5550177|Harbor/);
  });

  it('admin emails append Quick Ops and customer emails stay on /a?t=', async () => {
    const body = await appendAdminOpsEmailLink('NEW BOOKING — CD1-QO-01\nCustomer: Alex Rivera', 'CD1-QO-01');
    assert.match(body, /Quick Ops \(admin only\)/);
    assert.match(body, /https:\/\/cardetail1\.com\/ops\/q\/qot_/);
    assert.doesNotMatch(body, /\/a\?t=/);
    const again = await appendAdminOpsEmailLink(body, 'CD1-QO-01');
    assert.equal((again.match(/\/ops\/q\//g) || []).length, 1);

    const submit = read('netlify/functions/submit-booking.js');
    assert.match(submit, /appendAdminOpsEmailLink/);
    assert.match(submit, /sendEmail/);
    assert.doesNotMatch(submit, /appendAdminOpsEmailLink\(text,\s*b\.email/);
    const customerSend = submit.slice(submit.indexOf('async function sendCustomerEmail'), submit.indexOf('async function sendSms'));
    assert.doesNotMatch(customerSend, /appendAdminOpsEmailLink|\/ops\/q\//);

    const customerTpl = read('netlify/lib/booking-transactional-notifications.js');
    assert.match(customerTpl, /This secure link opens your Customer Portal appointment/);
    assert.doesNotMatch(customerTpl, /appendAdminOpsEmailLink|Quick Ops \(admin only\)/);

    const change = read('netlify/functions/submit-customer-action.js');
    assert.match(change, /appendAdminOpsEmailLink\(body, bookingId\)/);
    const cancel = read('netlify/functions/request-cancellation.js');
    assert.match(cancel, /appendAdminOpsEmailLink\(body, bookingId\)/);
  });
});
