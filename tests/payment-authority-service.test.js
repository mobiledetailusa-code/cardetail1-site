// Phase 3 — authoritative PaymentService foundation tests, run against the
// real configured Postgres database (see tests/db-transactional-foundation.test.js
// for the convention this follows). Stripe is always a fake fetchImpl —
// never a real network call, matching this repo's existing test pattern
// (tests/release-a-acceptance.test.js).
//
// Scope note: this exercises netlify/lib/db/payment-authority-service.js and
// webhook-inbox.js directly. Neither is wired into any live endpoint yet —
// see docs/audit/phase1-delta-audit-2026-07-18.md.
require('dotenv/config');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prismaConfigured, getPrisma } = require('../netlify/lib/prisma');

const RUN_ID = `TESTDB-PAY-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
let idCounter = 0;
function nextId(label) {
  idCounter += 1;
  return `${RUN_ID}-${label}-${idCounter}`;
}

const FAKE_ENV = { STRIPE_SECRET_KEY: 'sk_test_fake000000000000000000' };

function fakePaymentIntentCreateFetch({ id = 'pi_fake', calls } = {}) {
  return async (url, opts) => {
    if (calls) calls.push({ url, method: opts?.method, body: opts?.body });
    if (String(url).includes('/payment_intents')) {
      return { ok: true, json: async () => ({ id, status: 'requires_payment_method', amount: 0 }) };
    }
    if (String(url).includes('/refunds')) {
      // Unique per call — a static id would collide with the global
      // providerEventId uniqueness constraint across unrelated tests.
      return { ok: true, json: async () => ({ id: nextId('rf') }) };
    }
    return { ok: false, json: async () => ({ error: { message: 'unexpected_url' } }) };
  };
}

const dbConfigured = prismaConfigured();

describe('Phase 3 payment-authority-service (Postgres, fake Stripe)', { skip: !dbConfigured && 'DATABASE_URL/DIRECT_URL not configured' }, () => {
  let prisma;
  const createdBookingIds = [];

  before(() => {
    prisma = getPrisma();
  });

  after(async () => {
    for (const id of createdBookingIds) {
      try {
        await prisma.paymentAttempt.deleteMany({ where: { bookingId: id } });
        await prisma.quote.deleteMany({ where: { bookingId: id } });
        await prisma.booking.delete({ where: { id } });
      } catch {
        // Ledger children (FK RESTRICT) keep the booking alive by design.
      }
    }
    try {
      await prisma.stripeEvent.deleteMany({ where: { stripeEventId: { startsWith: RUN_ID } } });
    } catch { /* best-effort */ }
  });

  async function makeBookingWithQuote(approvedCents, { status = 'draft', isDraft = false } = {}) {
    const repo = require('../netlify/lib/db/repositories');
    const id = nextId('BK');
    createdBookingIds.push(id);
    await repo.createBooking({ id, status: 'confirmed', isDraft });
    const quote = await repo.createQuote({ bookingId: id, quoteVersion: 1, approvedCents, status });
    return { bookingId: id, quote };
  }

  test('reserveAndCreatePaymentIntent creates exactly one PaymentIntent for a fresh quote', async () => {
    const svc = require('../netlify/lib/db/payment-authority-service');
    const { bookingId } = await makeBookingWithQuote(5000);
    const calls = [];
    const piId = nextId('pi');
    const result = await svc.reserveAndCreatePaymentIntent({
      bookingId, quoteVersion: 1, env: FAKE_ENV, fetchImpl: fakePaymentIntentCreateFetch({ id: piId, calls }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.created, true);
    assert.equal(result.stripePaymentIntentId, piId);
    assert.equal(result.paymentAttempt.amountCents, 5000);
    assert.equal(calls.length, 1, 'exactly one Stripe API call must have been made');
  });

  test('reserveAndCreatePaymentIntent is idempotent under concurrent/duplicate calls (double click, browser retry)', async () => {
    const svc = require('../netlify/lib/db/payment-authority-service');
    const { bookingId } = await makeBookingWithQuote(7500);
    const calls = [];
    const fetchImpl = fakePaymentIntentCreateFetch({ id: nextId('pi'), calls });

    const [a, b, c] = await Promise.all([
      svc.reserveAndCreatePaymentIntent({ bookingId, quoteVersion: 1, env: FAKE_ENV, fetchImpl }),
      svc.reserveAndCreatePaymentIntent({ bookingId, quoteVersion: 1, env: FAKE_ENV, fetchImpl }),
      svc.reserveAndCreatePaymentIntent({ bookingId, quoteVersion: 1, env: FAKE_ENV, fetchImpl }),
    ]);
    assert.ok([a, b, c].every((r) => r.ok), 'all three concurrent calls must succeed (none should error)');
    const attemptIds = new Set([a, b, c].map((r) => r.paymentAttempt.id));
    assert.equal(attemptIds.size, 1, 'all three concurrent calls must resolve to the same single PaymentAttempt');
    assert.ok(calls.length <= 1, `at most one real Stripe call should have fired, got ${calls.length}`);

    const count = await prisma.paymentAttempt.count({ where: { bookingId, quoteVersion: 1 } });
    assert.equal(count, 1, 'exactly one PaymentAttempt row must exist — no duplicate obligation');

    const retry = await svc.reserveAndCreatePaymentIntent({ bookingId, quoteVersion: 1, env: FAKE_ENV, fetchImpl });
    assert.equal(retry.ok, true);
    assert.equal(retry.created, false);
    assert.equal(retry.paymentAttempt.id, [...attemptIds][0]);
  });

  test('reserveAndCreatePaymentIntent refuses a stale quoteVersion (stale tab)', async () => {
    const svc = require('../netlify/lib/db/payment-authority-service');
    const { bookingId } = await makeBookingWithQuote(3000);
    const result = await svc.reserveAndCreatePaymentIntent({
      bookingId, quoteVersion: 99, env: FAKE_ENV, fetchImpl: fakePaymentIntentCreateFetch(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'stale_quote_version');
    assert.equal(result.statusCode, 409);
  });

  test('reserveAndCreatePaymentIntent refuses when already paid (no double charge after settlement)', async () => {
    const svc = require('../netlify/lib/db/payment-authority-service');
    const foundation = require('../netlify/lib/db/foundation-services');
    const { bookingId } = await makeBookingWithQuote(2000);
    await foundation.appendLedgerEntry({
      bookingId, kind: 'settlement', amountCents: 2000, quoteVersion: 1, providerEventId: nextId('EVT'),
    });
    const result = await svc.reserveAndCreatePaymentIntent({
      bookingId, quoteVersion: 1, env: FAKE_ENV, fetchImpl: fakePaymentIntentCreateFetch(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'already_paid');
  });

  test('reconcilePaymentIntentEvent: succeeded settles the quote and matches the authoritative projection', async () => {
    const svc = require('../netlify/lib/db/payment-authority-service');
    const { bookingId } = await makeBookingWithQuote(4200);
    const piId = nextId('pi');
    const created = await svc.reserveAndCreatePaymentIntent({
      bookingId, quoteVersion: 1, env: FAKE_ENV, fetchImpl: fakePaymentIntentCreateFetch({ id: piId }),
    });
    assert.equal(created.ok, true);

    const stripeEventId = nextId('EVT');
    const result = await svc.reconcilePaymentIntentEvent({
      stripeEventId, type: 'payment_intent.succeeded',
      paymentIntent: { id: piId, status: 'succeeded', amount_received: 4200 },
    });
    assert.equal(result.ok, true);
    assert.equal(result.duplicate, false);

    const projection = await svc.getFinancialProjection(bookingId);
    assert.equal(projection.paymentStatus, 'paid');
    assert.equal(projection.remainingCents, 0);
    assert.equal(projection.settledCents, 4200);

    const quote = await prisma.quote.findUnique({ where: { bookingId_quoteVersion: { bookingId, quoteVersion: 1 } } });
    assert.equal(quote.status, 'settled');
  });

  test('reconcilePaymentIntentEvent: duplicate webhook delivery does not double-credit', async () => {
    const svc = require('../netlify/lib/db/payment-authority-service');
    const { bookingId } = await makeBookingWithQuote(1000);
    const piId = nextId('pi');
    await svc.reserveAndCreatePaymentIntent({
      bookingId, quoteVersion: 1, env: FAKE_ENV, fetchImpl: fakePaymentIntentCreateFetch({ id: piId }),
    });
    const stripeEventId = nextId('EVT');
    const payload = { id: piId, status: 'succeeded', amount_received: 1000 };

    const first = await svc.reconcilePaymentIntentEvent({ stripeEventId, type: 'payment_intent.succeeded', paymentIntent: payload });
    const second = await svc.reconcilePaymentIntentEvent({ stripeEventId, type: 'payment_intent.succeeded', paymentIntent: payload });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);

    const projection = await svc.getFinancialProjection(bookingId);
    assert.equal(projection.settledCents, 1000, 'duplicate delivery must not double the settled amount');
  });

  test('reconcilePaymentIntentEvent: out-of-order delivery (a stale requires_action after succeeded) does not un-settle', async () => {
    const svc = require('../netlify/lib/db/payment-authority-service');
    const { bookingId } = await makeBookingWithQuote(1500);
    const piId = nextId('pi');
    await svc.reserveAndCreatePaymentIntent({
      bookingId, quoteVersion: 1, env: FAKE_ENV, fetchImpl: fakePaymentIntentCreateFetch({ id: piId }),
    });
    await svc.reconcilePaymentIntentEvent({
      stripeEventId: nextId('EVT'), type: 'payment_intent.succeeded',
      paymentIntent: { id: piId, status: 'succeeded', amount_received: 1500 },
    });
    // A late/out-of-order requires_action event for the same (now-succeeded) PI.
    const stale = await svc.reconcilePaymentIntentEvent({
      stripeEventId: nextId('EVT'), type: 'payment_intent.requires_action',
      paymentIntent: { id: piId, status: 'requires_action' },
    });
    assert.equal(stale.ok, true);
    // The attempt row's status can move, but the ledger is append-only and
    // the projection is driven by ledger entries, not attempt.status alone.
    const projection = await svc.getFinancialProjection(bookingId);
    assert.equal(projection.paymentStatus, 'paid', 'a stale post-succeeded event must not revert the paid projection');
    assert.equal(projection.settledCents, 1500);
  });

  test('reconcilePaymentIntentEvent: payment succeeded before the local PaymentAttempt row exists is quarantined, not silently dropped', async () => {
    const svc = require('../netlify/lib/db/payment-authority-service');
    const result = await svc.reconcilePaymentIntentEvent({
      stripeEventId: nextId('EVT'), type: 'payment_intent.succeeded',
      paymentIntent: { id: 'pi_never_reserved_' + nextId('X'), status: 'succeeded', amount_received: 999 },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'no_matching_payment_attempt');
    assert.equal(result.quarantined, true);
  });

  test('declined card (requires_payment_method) allows a controlled retry — new PaymentIntent for the same quote', async () => {
    const svc = require('../netlify/lib/db/payment-authority-service');
    const { bookingId } = await makeBookingWithQuote(6000);
    const piId = nextId('pi');
    const first = await svc.reserveAndCreatePaymentIntent({
      bookingId, quoteVersion: 1, env: FAKE_ENV, fetchImpl: fakePaymentIntentCreateFetch({ id: piId }),
    });
    await svc.reconcilePaymentIntentEvent({
      stripeEventId: nextId('EVT'), type: 'payment_intent.payment_failed',
      paymentIntent: { id: piId, status: 'requires_payment_method' },
    });

    const retry = await svc.reserveAndCreatePaymentIntent({
      bookingId, quoteVersion: 1, generation: 2, env: FAKE_ENV, fetchImpl: fakePaymentIntentCreateFetch({ id: nextId('pi') }),
    });
    assert.equal(retry.ok, true);
    assert.equal(retry.created, true);
    assert.notEqual(retry.paymentAttempt.id, first.paymentAttempt.id, 'retry after a decline must be a new attempt row');

    const active = await prisma.paymentAttempt.count({
      where: { bookingId, quoteVersion: 1, status: { in: ['creating', 'open', 'requires_action'] } },
    });
    assert.equal(active, 1, 'exactly one active obligation after the retry — the failed one does not linger as active');
  });

  test('partial refund reduces settled and reopens the correct remaining amount', async () => {
    const svc = require('../netlify/lib/db/payment-authority-service');
    const { bookingId } = await makeBookingWithQuote(10000);
    const piId = nextId('pi');
    await svc.reserveAndCreatePaymentIntent({
      bookingId, quoteVersion: 1, env: FAKE_ENV, fetchImpl: fakePaymentIntentCreateFetch({ id: piId }),
    });
    await svc.reconcilePaymentIntentEvent({
      stripeEventId: nextId('EVT'), type: 'payment_intent.succeeded',
      paymentIntent: { id: piId, status: 'succeeded', amount_received: 10000 },
    });

    const refund = await svc.createRefund({ bookingId, amountCents: 3000, env: FAKE_ENV, fetchImpl: fakePaymentIntentCreateFetch() });
    assert.equal(refund.ok, true);

    const projection = await svc.getFinancialProjection(bookingId);
    assert.equal(projection.refundedCents, 3000);
    assert.equal(projection.settledCents, 7000);
    assert.equal(projection.remainingCents, 3000);
  });

  test('refund amount is clamped to the refundable ceiling, never trusts a caller-supplied excess', async () => {
    const svc = require('../netlify/lib/db/payment-authority-service');
    const { bookingId } = await makeBookingWithQuote(1000);
    const piId = nextId('pi');
    await svc.reserveAndCreatePaymentIntent({
      bookingId, quoteVersion: 1, env: FAKE_ENV, fetchImpl: fakePaymentIntentCreateFetch({ id: piId }),
    });
    await svc.reconcilePaymentIntentEvent({
      stripeEventId: nextId('EVT'), type: 'payment_intent.succeeded',
      paymentIntent: { id: piId, status: 'succeeded', amount_received: 1000 },
    });
    const refund = await svc.createRefund({ bookingId, amountCents: 999999, env: FAKE_ENV, fetchImpl: fakePaymentIntentCreateFetch() });
    assert.equal(refund.ok, true);
    const projection = await svc.getFinancialProjection(bookingId);
    assert.equal(projection.refundedCents, 1000, 'refund must be clamped to what was actually settled');
  });

  test('booking paid then financial adjustment: new quote version, remaining is only the delta', async () => {
    const svc = require('../netlify/lib/db/payment-authority-service');
    const { bookingId } = await makeBookingWithQuote(5000);
    const piId = nextId('pi');
    await svc.reserveAndCreatePaymentIntent({
      bookingId, quoteVersion: 1, env: FAKE_ENV, fetchImpl: fakePaymentIntentCreateFetch({ id: piId }),
    });
    await svc.reconcilePaymentIntentEvent({
      stripeEventId: nextId('EVT'), type: 'payment_intent.succeeded',
      paymentIntent: { id: piId, status: 'succeeded', amount_received: 5000 },
    });
    const paidProjection = await svc.getFinancialProjection(bookingId);
    assert.equal(paidProjection.paymentStatus, 'paid');

    const adjustment = await svc.createAdjustment({ bookingId, newApprovedCents: 8000, reason: 'added add-on after service began' });
    assert.equal(adjustment.ok, true);
    assert.equal(adjustment.quote.quoteVersion, 2);
    assert.equal(adjustment.after.approvedCents, 8000);
    assert.equal(adjustment.after.settledCents, 5000, 'prior settlement must still count toward the new quote');
    assert.equal(adjustment.after.remainingCents, 3000, 'remaining must be only the delta, not the full new total');

    // The original settled quote row must be untouched (immutable).
    const originalQuote = await prisma.quote.findUnique({ where: { bookingId_quoteVersion: { bookingId, quoteVersion: 1 } } });
    assert.equal(originalQuote.approvedCents, 5000);
    assert.equal(originalQuote.status, 'settled');
  });

  test('a new PaymentIntent for the adjusted quote charges only the remaining delta', async () => {
    const svc = require('../netlify/lib/db/payment-authority-service');
    const { bookingId } = await makeBookingWithQuote(2000);
    const piId = nextId('pi');
    await svc.reserveAndCreatePaymentIntent({
      bookingId, quoteVersion: 1, env: FAKE_ENV, fetchImpl: fakePaymentIntentCreateFetch({ id: piId }),
    });
    await svc.reconcilePaymentIntentEvent({
      stripeEventId: nextId('EVT'), type: 'payment_intent.succeeded',
      paymentIntent: { id: piId, status: 'succeeded', amount_received: 2000 },
    });
    await svc.createAdjustment({ bookingId, newApprovedCents: 2750 });

    const deltaAttempt = await svc.reserveAndCreatePaymentIntent({
      bookingId, quoteVersion: 2, env: FAKE_ENV, fetchImpl: fakePaymentIntentCreateFetch({ id: nextId('pi') }),
    });
    assert.equal(deltaAttempt.ok, true);
    assert.equal(deltaAttempt.paymentAttempt.amountCents, 750, 'must charge only the 750-cent delta, not the full 2750');
  });
});

describe('Phase 3 webhook-inbox signature verification', () => {
  test('valid signature is accepted', () => {
    const { verifyStripeSignature } = require('../netlify/lib/db/webhook-inbox');
    const crypto = require('crypto');
    const secret = 'whsec_test_fake';
    const rawBody = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' });
    const t = Math.floor(Date.now() / 1000);
    const v1 = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
    const sigHeader = `t=${t},v1=${v1}`;
    assert.equal(verifyStripeSignature(rawBody, sigHeader, secret), true);
  });

  test('tampered body is rejected', () => {
    const { verifyStripeSignature } = require('../netlify/lib/db/webhook-inbox');
    const crypto = require('crypto');
    const secret = 'whsec_test_fake';
    const rawBody = JSON.stringify({ id: 'evt_1', amount: 100 });
    const t = Math.floor(Date.now() / 1000);
    const v1 = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
    const tamperedBody = JSON.stringify({ id: 'evt_1', amount: 999999 });
    assert.equal(verifyStripeSignature(tamperedBody, `t=${t},v1=${v1}`, secret), false);
  });

  test('stale timestamp (>300s) is rejected — replay protection', () => {
    const { verifyStripeSignature } = require('../netlify/lib/db/webhook-inbox');
    const crypto = require('crypto');
    const secret = 'whsec_test_fake';
    const rawBody = JSON.stringify({ id: 'evt_old' });
    const t = Math.floor(Date.now() / 1000) - 400;
    const v1 = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
    assert.equal(verifyStripeSignature(rawBody, `t=${t},v1=${v1}`, secret), false);
  });

  test('missing signature header is rejected', () => {
    const { verifyStripeSignature } = require('../netlify/lib/db/webhook-inbox');
    assert.equal(verifyStripeSignature('{}', null, 'whsec_test'), false);
  });

  test(
    'handleWebhookDelivery: bad signature is rejected before touching the database',
    { skip: !dbConfigured && 'DATABASE_URL/DIRECT_URL not configured' },
    async () => {
      const { handleWebhookDelivery } = require('../netlify/lib/db/webhook-inbox');
      const result = await handleWebhookDelivery({
        rawBody: JSON.stringify({ id: 'evt_bad', type: 'payment_intent.succeeded', data: { object: {} } }),
        sigHeader: 't=1,v1=deadbeef',
        secret: 'whsec_test_fake',
      });
      assert.equal(result.ok, false);
      assert.equal(result.statusCode, 400);
      assert.equal(result.error, 'bad_signature');
    }
  );
});
