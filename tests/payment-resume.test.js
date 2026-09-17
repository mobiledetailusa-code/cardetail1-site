'use strict';

/**
 * PR B — secure payment resume over existing PaymentIntent / Payment Element.
 * Amount comes from remainingCents + quoteVersion. No Stripe Payment Links.
 */

const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const { createCasMemoryStore } = require('./helpers/cas-memory-store');
const { setBookingStoreOverride } = require('../netlify/lib/booking-repository');
const {
  PURPOSE_CUSTOMER_BALANCE,
  TOKEN_PREFIX,
  createPaymentResumeToken,
  loadPaymentResumeToken,
  setPaymentResumeStoreFactory,
  resetPaymentResumeStoreFactory,
} = require('../netlify/lib/payment-resume-token');
const {
  PURPOSE_ADMIN_QUICK_OPS,
  TOKEN_PREFIX: QO_PREFIX,
  setQuickOpsStoreFactories,
  resetQuickOpsStoreFactories,
} = require('../netlify/lib/admin-quick-ops-token');
const { PURPOSE_APPOINTMENT_ACCESS } = require('../netlify/lib/appointment-access-token');
const { mintPaymentLink } = require('../netlify/lib/admin-quick-ops-actions');
const pay = require('../netlify/functions/payment-resume');

const SECRET = 'test-payment-resume-secret-32chars';
const QO_SECRET = 'test-admin-quick-ops-secret-32chars';

function dueBooking(overrides = {}) {
  return {
    id: overrides.id || 'CD1-PAY-01',
    firstName: 'Alex',
    lastName: 'Rivera',
    phone: '+12015550177',
    package: 'Interior Detail',
    status: 'Confirmed',
    appointmentStatus: 'confirmed',
    jobStatus: 'confirmed',
    bookingVersion: 2,
    quoteVersion: overrides.quoteVersion != null ? overrides.quoteVersion : 1,
    approvedFinalAmount: 190,
    totalPrice: 190,
    ledger: {
      currency: 'usd',
      approvedCents: overrides.approvedCents != null ? overrides.approvedCents : 19000,
      settledCents: overrides.settledCents != null ? overrides.settledCents : 0,
      creditedCents: 0,
      pendingCents: 0,
      entries: [],
    },
    ...overrides,
  };
}

before(() => {
  process.env.PUBLIC_SITE_URL = 'https://cardetail1.com';
  process.env.CONTEXT = 'production';
  process.env.PAYMENT_RESUME_SECRET = SECRET;
  process.env.ADMIN_QUICK_OPS_SECRET = QO_SECRET;
  process.env.CD1_POSTGRES_PAYMENT = 'false';
});

beforeEach(() => {
  const payStore = createCasMemoryStore();
  const qoTokens = createCasMemoryStore();
  const qoSessions = createCasMemoryStore();
  setPaymentResumeStoreFactory(() => payStore);
  setQuickOpsStoreFactories({
    tokenStore: () => qoTokens,
    sessionStore: () => qoSessions,
  });
});

afterEach(() => {
  resetPaymentResumeStoreFactory();
  resetQuickOpsStoreFactories();
  setBookingStoreOverride(null);
});

describe('payment resume token', () => {
  it('binds booking + quoteVersion + customer_balance and stays opaque', async () => {
    const minted = await createPaymentResumeToken({ bookingId: 'CD1-PAY-01', quoteVersion: 1 });
    assert.equal(minted.ok, true);
    assert.equal(minted.quoteVersion, 1);
    assert.match(minted.payUrl, /^https:\/\/cardetail1\.com\/pay\/prt_/);
    assert.doesNotMatch(minted.token, /Alex|190|Rivera/);
    const loaded = await loadPaymentResumeToken(minted.token);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.purpose, PURPOSE_CUSTOMER_BALANCE);
    assert.equal(loaded.bookingId, 'CD1-PAY-01');
    assert.equal(loaded.quoteVersion, 1);
    assert.notEqual(loaded.purpose, PURPOSE_ADMIN_QUICK_OPS);
    assert.notEqual(loaded.purpose, PURPOSE_APPOINTMENT_ACCESS);
  });

  it('reuses the same URL for the same booking + quoteVersion', async () => {
    const first = await createPaymentResumeToken({ bookingId: 'CD1-PAY-01', quoteVersion: 1 });
    const second = await createPaymentResumeToken({ bookingId: 'CD1-PAY-01', quoteVersion: 1 });
    assert.equal(first.token, second.token);
    assert.equal(second.reused, true);
    const nextQuote = await createPaymentResumeToken({ bookingId: 'CD1-PAY-01', quoteVersion: 2 });
    assert.notEqual(nextQuote.token, first.token);
  });

  it('rejects appointment and quick-ops tokens', async () => {
    const aat = await loadPaymentResumeToken(`aat_${'A'.repeat(43)}`);
    assert.equal(aat.ok, false);
    const qot = await loadPaymentResumeToken(`${QO_PREFIX}${'B'.repeat(40)}`);
    assert.equal(qot.ok, false);
    const missing = await loadPaymentResumeToken(`${TOKEN_PREFIX}missingtokenvalue`);
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'invalid');
  });
});

describe('payment resume page', () => {
  it('GET /pay/<token> shows $190 from remainingCents and does not create a PaymentIntent', async () => {
    const booking = dueBooking();
    setBookingStoreOverride(createCasMemoryStore({ [booking.id]: booking }));
    const minted = await createPaymentResumeToken({ bookingId: booking.id, quoteVersion: 1 });
    const src = read('netlify/functions/payment-resume.js');
    const getFn = src.slice(src.indexOf('async function handleGet'), src.indexOf('async function handlePost'));
    assert.match(getFn, /authorizePay/);
    assert.doesNotMatch(getFn, /prepareEmbeddedPayment/);
    const res = await pay.handler({
      httpMethod: 'GET',
      path: `/pay/${minted.token}`,
      rawUrl: `https://cardetail1.com/pay/${minted.token}`,
      headers: { host: 'cardetail1.com' },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Cardetail1/);
    assert.match(res.body, /\$190/);
    assert.match(res.body, /payment-element/);
    assert.match(res.body, /js\.stripe\.com/);
    assert.doesNotMatch(res.body, /checkout\.stripe|plink_/);
    assert.doesNotMatch(res.body, /Alex Rivera|CD1-PAY-01/);
  });

  it('stale quoteVersion is rejected instead of collecting the old amount', async () => {
    const booking = dueBooking({ quoteVersion: 2, approvedCents: 24000, approvedFinalAmount: 240 });
    setBookingStoreOverride(createCasMemoryStore({ [booking.id]: booking }));
    const stale = await createPaymentResumeToken({ bookingId: booking.id, quoteVersion: 1 });
    const res = await pay.handler({
      httpMethod: 'GET',
      path: `/pay/${stale.token}`,
      headers: { host: 'cardetail1.com' },
    });
    assert.equal(res.statusCode, 409);
    assert.match(res.body, /Payment details changed/);
    assert.doesNotMatch(res.body, /\$190/);
    const post = await pay.handler({
      httpMethod: 'POST',
      path: `/pay/${stale.token}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'intent', token: stale.token, amount: 19000 }),
    });
    const payload = JSON.parse(post.body);
    assert.equal(payload.ok, false);
    assert.equal(payload.error, 'stale_quote_version');
    assert.match(payload.message, /Payment details changed/);
  });

  it('$0 remaining and invalid tokens stay closed', async () => {
    const paid = dueBooking({
      id: 'CD1-PAY-ZERO',
      settledCents: 19000,
    });
    setBookingStoreOverride(createCasMemoryStore({ [paid.id]: paid }));
    const minted = await mintPaymentLink(paid);
    assert.equal(minted.ok, false);
    assert.equal(minted.error, 'zero_balance');
    const token = await createPaymentResumeToken({ bookingId: paid.id, quoteVersion: 1 });
    const res = await pay.handler({
      httpMethod: 'GET',
      path: `/pay/${token.token}`,
      headers: { host: 'cardetail1.com' },
    });
    assert.equal(res.statusCode, 409);
    assert.match(res.body, /Paid \/ No balance due/);

    const invalid = await pay.handler({
      httpMethod: 'GET',
      path: '/pay/prt_not-a-real-token-value',
      headers: { host: 'cardetail1.com' },
    });
    assert.match(invalid.body, /Payment link expired or invalid/);
    assert.doesNotMatch(invalid.body, /CD1-PAY|Alex|19000/);
  });

  it('status POST never accepts a client-provided amount', async () => {
    const booking = dueBooking();
    setBookingStoreOverride(createCasMemoryStore({ [booking.id]: booking }));
    const minted = await createPaymentResumeToken({ bookingId: booking.id, quoteVersion: 1 });
    const res = await pay.handler({
      httpMethod: 'POST',
      path: `/pay/${minted.token}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'status', token: minted.token, remainingCents: 1, amount: 1 }),
    });
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.remainingCents, 19000);
    const src = read('netlify/functions/payment-resume.js');
    assert.doesNotMatch(src, /body\.amount|body\.remainingCents|query\.amount/);
  });

  it('cancelled booking cannot pay through an old token', async () => {
    const booking = dueBooking({
      status: 'Cancelled',
      appointmentStatus: 'canceled',
      jobStatus: 'cancelled',
    });
    setBookingStoreOverride(createCasMemoryStore({ [booking.id]: booking }));
    const minted = await createPaymentResumeToken({ bookingId: booking.id, quoteVersion: 1 });
    const res = await pay.handler({
      httpMethod: 'GET',
      path: `/pay/${minted.token}`,
      headers: { host: 'cardetail1.com' },
    });
    assert.match(res.body, /Payment link expired or invalid/);
  });
});

describe('payment architecture freeze', () => {
  it('reuses Payment Element + PaymentIntent purpose=customer_balance', () => {
    const src = [
      read('netlify/functions/payment-resume.js'),
      read('netlify/lib/payment-resume-token.js'),
      read('netlify/lib/quick-ops-html.js'),
    ].join('\n');
    assert.match(src, /prepareEmbeddedPayment/);
    assert.match(src, /PURPOSE_CUSTOMER_BALANCE/);
    assert.match(src, /elements\.create\('payment'/);
    assert.doesNotMatch(src, /checkout\.sessions\.create/);
    assert.doesNotMatch(src, /paymentLinks\.create/);
    assert.doesNotMatch(read('netlify/functions/stripe-webhook.js'), /payment-resume/);
  });
});
