/**
 * Operational Postgres payment wiring — ensure/import, shared projection,
 * embed prepare, reconcile-from-provider, settlement dedupe across events.
 */
require('dotenv/config');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prismaConfigured, getPrisma } = require('../netlify/lib/prisma');

const RUN_ID = `TESTDB-OPS-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
let idCounter = 0;
function nextId(label) {
  idCounter += 1;
  return `${RUN_ID}-${label}-${idCounter}`;
}

const FAKE_ENV = { STRIPE_SECRET_KEY: 'sk_test_fake000000000000000000' };
const dbConfigured = prismaConfigured();

function fakeStripeFetch({
  piId,
  calls,
  clientSecret = 'pi_secret_fake',
  getStatus = 'requires_payment_method',
  amount = 5000,
} = {}) {
  return async (url, opts) => {
    if (calls) calls.push({ url: String(url), method: opts?.method });
    const u = String(url);
    if (u.includes('/payment_intents') && opts?.method === 'POST') {
      return {
        ok: true,
        json: async () => ({
          id: piId,
          status: 'requires_payment_method',
          amount,
          client_secret: clientSecret,
        }),
      };
    }
    if (u.includes('/payment_intents/') && (!opts?.method || opts.method === 'GET')) {
      return {
        ok: true,
        json: async () => ({
          id: piId,
          status: getStatus,
          amount,
          amount_received: getStatus === 'succeeded' ? amount : 0,
          client_secret: clientSecret,
        }),
      };
    }
    if (u.includes('/customer_sessions')) {
      return {
        ok: true,
        json: async () => ({ client_secret: 'cuss_test_fake' }),
      };
    }
    if (u.includes('/refunds')) {
      return { ok: true, json: async () => ({ id: nextId('rf') }) };
    }
    return { ok: false, json: async () => ({ error: { message: 'unexpected_url' } }) };
  };
}

describe('operational payment wiring (Postgres)', { skip: !dbConfigured && 'DATABASE_URL not configured' }, () => {
  let prisma;
  const createdBookingIds = [];

  before(() => { prisma = getPrisma(); });

  after(async () => {
    for (const id of createdBookingIds) {
      try {
        await prisma.paymentAttempt.deleteMany({ where: { bookingId: id } });
        await prisma.quote.deleteMany({ where: { bookingId: id } });
        await prisma.booking.delete({ where: { id } });
      } catch { /* ledger residue */ }
    }
    try {
      await prisma.stripeEvent.deleteMany({ where: { stripeEventId: { startsWith: RUN_ID } } });
      await prisma.stripeEvent.deleteMany({ where: { stripeEventId: { startsWith: 'reconcile_' } } });
    } catch { /* best-effort */ }
  });

  test('ensureBookingFinancial creates Booking+Quote from Blob-shaped booking', async () => {
    const { ensureBookingFinancial } = require('../netlify/lib/db/ensure-booking-financial');
    const bookingId = nextId('BK');
    createdBookingIds.push(bookingId);
    const blob = {
      id: bookingId,
      isDraft: false,
      quoteVersion: 1,
      amountDueApproved: 50,
      totalPrice: 50,
      ledger: { approvedCents: 5000, settledCents: 0 },
    };
    const ensured = await ensureBookingFinancial(blob);
    assert.equal(ensured.ok, true);
    const quote = await prisma.quote.findUnique({
      where: { bookingId_quoteVersion: { bookingId, quoteVersion: 1 } },
    });
    assert.ok(quote);
    assert.equal(quote.approvedCents, 5000);
  });

  test('Admin and Customer shared projection match after settle', async () => {
    const authority = require('../netlify/lib/db/payment-authority-service');
    const { ensureBookingFinancial } = require('../netlify/lib/db/ensure-booking-financial');
    const { getSharedFinancialProjection } = require('../netlify/lib/db/operational-payment');
    const bookingId = nextId('BK');
    createdBookingIds.push(bookingId);
    const blob = {
      id: bookingId,
      quoteVersion: 1,
      ledger: { approvedCents: 4200, settledCents: 0 },
      amountDueApproved: 42,
    };
    await ensureBookingFinancial(blob);
    const piId = `pi_${nextId('x')}`;
    const created = await authority.reserveAndCreatePaymentIntent({
      bookingId,
      quoteVersion: 1,
      env: FAKE_ENV,
      fetchImpl: fakeStripeFetch({ piId }),
    });
    assert.equal(created.ok, true);
    await authority.reconcilePaymentIntentEvent({
      stripeEventId: nextId('EVT'),
      type: 'payment_intent.succeeded',
      paymentIntent: { id: piId, status: 'succeeded', amount_received: 4200 },
    });
    const customerView = await getSharedFinancialProjection(blob, { reconcileUncertain: false });
    const adminView = await getSharedFinancialProjection(blob, { reconcileUncertain: false });
    assert.equal(customerView.ok, true);
    assert.equal(adminView.ok, true);
    assert.equal(customerView.projection.paymentStatus, 'paid');
    assert.equal(adminView.projection.paymentStatus, 'paid');
    assert.equal(customerView.projection.remainingCents, 0);
    assert.equal(adminView.projection.remainingCents, 0);
    assert.deepEqual(
      {
        a: customerView.projection.approvedCents,
        s: customerView.projection.settledCents,
        r: customerView.projection.remainingCents,
      },
      {
        a: adminView.projection.approvedCents,
        s: adminView.projection.settledCents,
        r: adminView.projection.remainingCents,
      }
    );
  });

  test('checkout.session event + payment_intent.succeeded cannot double-credit same PI', async () => {
    const authority = require('../netlify/lib/db/payment-authority-service');
    const { ensureBookingFinancial } = require('../netlify/lib/db/ensure-booking-financial');
    const bookingId = nextId('BK');
    createdBookingIds.push(bookingId);
    await ensureBookingFinancial({
      id: bookingId,
      quoteVersion: 1,
      ledger: { approvedCents: 3000, settledCents: 0 },
    });
    const piId = `pi_${nextId('x')}`;
    await authority.reserveAndCreatePaymentIntent({
      bookingId, quoteVersion: 1, env: FAKE_ENV, fetchImpl: fakeStripeFetch({ piId }),
    });
    const first = await authority.reconcilePaymentIntentEvent({
      stripeEventId: nextId('EVT'),
      type: 'checkout.session.completed',
      paymentIntent: { id: piId, status: 'succeeded', amount_received: 3000 },
    });
    const second = await authority.reconcilePaymentIntentEvent({
      stripeEventId: nextId('EVT'),
      type: 'payment_intent.succeeded',
      paymentIntent: { id: piId, status: 'succeeded', amount_received: 3000 },
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.duplicate, true);
    const projection = await authority.getFinancialProjection(bookingId);
    assert.equal(projection.settledCents, 3000);
    assert.equal(projection.remainingCents, 0);
    const credits = await prisma.ledgerEntry.count({
      where: { bookingId, kind: 'settlement' },
    });
    assert.equal(credits, 1);
  });

  test('prepareEmbeddedPayment returns clientSecret and reuses one PI', async () => {
    const { ensureBookingFinancial } = require('../netlify/lib/db/ensure-booking-financial');
    const { prepareEmbeddedPayment } = require('../netlify/lib/db/operational-payment');
    const bookingId = nextId('BK');
    createdBookingIds.push(bookingId);
    const blob = {
      id: bookingId,
      quoteVersion: 1,
      bookingVersion: 2,
      ledger: { approvedCents: 5500, settledCents: 0 },
      stripeCustomerId: 'cus_test_fake',
    };
    await ensureBookingFinancial(blob);
    const piId = `pi_${nextId('x')}`;
    const fetchImpl = fakeStripeFetch({ piId });
    const first = await prepareEmbeddedPayment({ booking: blob, env: FAKE_ENV, fetchImpl });
    assert.equal(first.ok, true);
    assert.ok(first.clientSecret);
    assert.equal(first.paymentIntentId, piId);
    assert.equal(first.customerSessionClientSecret, 'cuss_test_fake');
    const second = await prepareEmbeddedPayment({ booking: blob, env: FAKE_ENV, fetchImpl });
    assert.equal(second.ok, true);
    assert.equal(second.created, false);
    assert.equal(second.paymentIntentId, piId);
    const count = await prisma.paymentAttempt.count({ where: { bookingId, quoteVersion: 1 } });
    assert.equal(count, 1);
  });

  test('reconcileFromStripeProvider settles missing webhook via provider retrieve', async () => {
    const authority = require('../netlify/lib/db/payment-authority-service');
    const { ensureBookingFinancial } = require('../netlify/lib/db/ensure-booking-financial');
    const bookingId = nextId('BK');
    createdBookingIds.push(bookingId);
    await ensureBookingFinancial({
      id: bookingId,
      quoteVersion: 1,
      ledger: { approvedCents: 5000, settledCents: 0 },
    });
    const piId = `pi_${nextId('x')}`;
    const created = await authority.reserveAndCreatePaymentIntent({
      bookingId, quoteVersion: 1, env: FAKE_ENV, fetchImpl: fakeStripeFetch({ piId }),
    });
    assert.equal(created.ok, true);
    // Missing webhook — Admin reconcile retrieves succeeded PI from Stripe.
    const reconciled = await authority.reconcileFromStripeProvider({
      bookingId,
      env: FAKE_ENV,
      fetchImpl: fakeStripeFetch({ piId, getStatus: 'succeeded', amount: 5000 }),
    });
    assert.equal(reconciled.ok, true);
    assert.equal(reconciled.skipped, false);
    assert.equal(reconciled.projection.paymentStatus, 'paid');
    assert.equal(reconciled.projection.remainingCents, 0);
  });

  test('stale quoteVersion refused by prepareEmbeddedPayment', async () => {
    const { ensureBookingFinancial } = require('../netlify/lib/db/ensure-booking-financial');
    const { prepareEmbeddedPayment } = require('../netlify/lib/db/operational-payment');
    const bookingId = nextId('BK');
    createdBookingIds.push(bookingId);
    const blob = { id: bookingId, quoteVersion: 1, ledger: { approvedCents: 2000, settledCents: 0 } };
    await ensureBookingFinancial(blob);
    const result = await prepareEmbeddedPayment({
      booking: blob,
      expectedQuoteVersion: 99,
      env: FAKE_ENV,
      fetchImpl: fakeStripeFetch({ piId: `pi_${nextId('x')}` }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'stale_quote_version');
  });

  test('customer-balance-payment-intent function rejects non-POST', async () => {
    const mod = require('../netlify/functions/customer-balance-payment-intent');
    const res = await mod.handler({ httpMethod: 'GET', headers: {}, body: null });
    assert.equal(res.statusCode, 405);
  });
});

describe('operational payment — pure guards', () => {
  test('postgresPaymentEnabled respects explicit disable flag', () => {
    const { postgresPaymentEnabled } = require('../netlify/lib/db/operational-payment');
    assert.equal(postgresPaymentEnabled({ CD1_POSTGRES_PAYMENT: '0', DATABASE_URL: 'postgres://x' }), false);
    assert.equal(postgresPaymentEnabled({ CD1_POSTGRES_PAYMENT: 'false', DATABASE_URL: 'postgres://x' }), false);
  });

  test('my-garage embeds Payment Element mount and no longer trusts paid toast without settle', () => {
    const fs = require('fs');
    const path = require('path');
    const js = fs.readFileSync(path.join(__dirname, '../assets/my-garage.js'), 'utf8');
    assert.match(js, /customer-balance-payment-intent/);
    assert.match(js, /confirmPayment/);
    assert.match(js, /redirect:\s*'if_required'/);
    assert.doesNotMatch(js, /Payment received by Stripe — balance will update shortly/);
    const html = fs.readFileSync(path.join(__dirname, '../my-garage.html'), 'utf8');
    assert.match(html, /id="payment-element"/);
    assert.match(html, /js\.stripe\.com\/v3/);
  });

  test('admin-ops exposes Reconcile with Stripe action', () => {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(path.join(__dirname, '../admin-ops.html'), 'utf8');
    assert.match(html, /dReconcileStripe/);
    assert.match(html, /reconcile_with_stripe/);
  });
});
