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
  const id = `${RUN_ID}-${label}-${idCounter}`;
  return label === 'pi' ? `pi_${id}` : id;
}

const FAKE_ENV = { STRIPE_SECRET_KEY: 'sk_test_fake000000000000000000' };

function fakePaymentIntentCreateFetch({ id = 'pi_fake', calls } = {}) {
  return async (url, opts) => {
    if (calls) calls.push({ url, method: opts?.method, body: opts?.body });
    if (String(url).includes('/payment_intents')) {
      const params = new URLSearchParams(opts?.body || '');
      return {
        ok: true,
        json: async () => ({
          id,
          status: 'requires_payment_method',
          amount: Number(params.get('amount')),
          currency: params.get('currency'),
          customer: params.get('customer'),
          metadata: {
            bookingId: params.get('metadata[bookingId]'),
            booking_id: params.get('metadata[booking_id]'),
            quoteVersion: params.get('metadata[quoteVersion]'),
            purpose: params.get('metadata[purpose]'),
          },
        }),
      };
    }
    if (String(url).includes('/refunds')) {
      const params = new URLSearchParams(opts?.body || '');
      return {
        ok: true,
        json: async () => ({
          id: `re_${nextId('RF')}`,
          object: 'refund',
          status: 'succeeded',
          amount: Number(params.get('amount')),
          currency: 'usd',
          payment_intent: params.get('payment_intent'),
          metadata: {
            bookingId: params.get('metadata[bookingId]'),
            booking_id: params.get('metadata[booking_id]'),
            quoteVersion: params.get('metadata[quoteVersion]'),
            purpose: params.get('metadata[purpose]'),
            refundRequestId: params.get('metadata[refundRequestId]'),
            refund_request_id: params.get('metadata[refund_request_id]'),
          },
        }),
      };
    }
    return { ok: false, json: async () => ({ error: { message: 'unexpected_url' } }) };
  };
}

function boundPaymentIntent({ bookingId, id, status, amount, customer = null, extra = {} }) {
  return {
    id,
    status,
    amount,
    amount_received: status === 'succeeded' ? amount : 0,
    currency: 'usd',
    customer,
    metadata: {
      bookingId,
      booking_id: bookingId,
      quoteVersion: '1',
      purpose: 'customer_balance',
    },
    ...extra,
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
        await prisma.refundRequest.deleteMany({ where: { bookingId: id } });
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
    assert.equal(retry.ok, true, JSON.stringify(retry));
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
      paymentIntent: boundPaymentIntent({ bookingId, id: piId, status: 'succeeded', amount: 4200 }),
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
    const payload = boundPaymentIntent({ bookingId, id: piId, status: 'succeeded', amount: 1000 });

    const first = await svc.reconcilePaymentIntentEvent({ stripeEventId, type: 'payment_intent.succeeded', paymentIntent: payload });
    const second = await svc.reconcilePaymentIntentEvent({ stripeEventId, type: 'payment_intent.succeeded', paymentIntent: payload });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);

    const projection = await svc.getFinancialProjection(bookingId);
    assert.equal(projection.settledCents, 1000, 'duplicate delivery must not double the settled amount');
  });

  test('failed inbox event is minimized and reprocessable after the local attempt catches up', async () => {
    const svc = require('../netlify/lib/db/payment-authority-service');
    const { bookingId } = await makeBookingWithQuote(2600);
    const piId = nextId('pi');
    const stripeEventId = nextId('EVT');
    const payload = boundPaymentIntent({
      bookingId,
      id: piId,
      status: 'succeeded',
      amount: 2600,
      extra: {
        client_secret: 'must_never_be_persisted',
        billing_details: { name: 'Never Persist' },
        charges: { data: [{ payment_method_details: { card: { last4: '4242' } } }] },
      },
    });

    const beforeAttempt = await svc.reconcilePaymentIntentEvent({
      stripeEventId,
      type: 'payment_intent.succeeded',
      paymentIntent: payload,
      eventCreatedAt: 1_780_000_000,
    });
    assert.equal(beforeAttempt.ok, false);
    assert.equal(beforeAttempt.error, 'no_matching_payment_attempt');
    assert.equal(beforeAttempt.failureRecorded, true);

    const failedInbox = await prisma.stripeEvent.findUnique({ where: { stripeEventId } });
    assert.equal(failedInbox.status, 'failed');
    assert.equal(failedInbox.attemptCount, 1);
    const stored = JSON.stringify(failedInbox.payload);
    assert.doesNotMatch(stored, /client_secret|billing_details|payment_method_details|4242|Never Persist/);
    assert.match(stored, /customer_balance/);

    const created = await svc.reserveAndCreatePaymentIntent({
      bookingId,
      quoteVersion: 1,
      env: FAKE_ENV,
      fetchImpl: fakePaymentIntentCreateFetch({ id: piId }),
    });
    assert.equal(created.ok, true, JSON.stringify(created));

    const retried = await svc.reconcilePaymentIntentEvent({
      stripeEventId,
      type: 'payment_intent.succeeded',
      paymentIntent: payload,
      eventCreatedAt: 1_780_000_000,
    });
    assert.equal(retried.ok, true, JSON.stringify(retried));
    assert.equal(retried.duplicate, false);
    const processedInbox = await prisma.stripeEvent.findUnique({ where: { stripeEventId } });
    assert.equal(processedInbox.status, 'processed');
    assert.equal(processedInbox.attemptCount, 2);
    assert.equal(processedInbox.errorCode, null);
    assert.equal((await svc.getFinancialProjection(bookingId)).remainingCents, 0);
  });

  test('wrong purpose, booking, quote, currency, customer, status, or amount cannot settle', async () => {
    const svc = require('../netlify/lib/db/payment-authority-service');
    const { bookingId } = await makeBookingWithQuote(4100);
    const piId = nextId('pi');
    const customer = 'cus_bindingtest';
    const created = await svc.reserveAndCreatePaymentIntent({
      bookingId,
      quoteVersion: 1,
      stripeCustomerId: customer,
      env: FAKE_ENV,
      fetchImpl: fakePaymentIntentCreateFetch({ id: piId }),
    });
    assert.equal(created.ok, true, JSON.stringify(created));

    const valid = boundPaymentIntent({ bookingId, id: piId, status: 'succeeded', amount: 4100, customer });
    const invalidCases = [
      ['payment_purpose_mismatch', { ...valid, metadata: { ...valid.metadata, purpose: 'policy_fee' } }],
      ['payment_booking_mismatch', { ...valid, metadata: { ...valid.metadata, bookingId: 'OTHER', booking_id: 'OTHER' } }],
      ['payment_quote_mismatch', { ...valid, metadata: { ...valid.metadata, quoteVersion: '2' } }],
      ['payment_currency_mismatch', { ...valid, currency: 'eur' }],
      ['payment_customer_mismatch', { ...valid, customer: 'cus_wrongcustomer' }],
      ['payment_event_status_mismatch', { ...valid, status: 'requires_action' }],
      ['payment_amount_mismatch', { ...valid, amount: 4000, amount_received: 4000 }],
    ];
    for (const [expectedError, paymentIntent] of invalidCases) {
      const result = await svc.reconcilePaymentIntentEvent({
        stripeEventId: nextId('EVT'),
        type: 'payment_intent.succeeded',
        paymentIntent,
      });
      assert.equal(result.ok, false, expectedError);
      assert.equal(result.error, expectedError);
      assert.equal((await svc.getFinancialProjection(bookingId)).settledCents, 0);
    }
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
      paymentIntent: boundPaymentIntent({ bookingId, id: piId, status: 'succeeded', amount: 1500 }),
      eventCreatedAt: 1_780_000_200,
    });
    // A late/out-of-order requires_action event for the same (now-succeeded) PI.
    const stale = await svc.reconcilePaymentIntentEvent({
      stripeEventId: nextId('EVT'), type: 'payment_intent.requires_action',
      paymentIntent: boundPaymentIntent({ bookingId, id: piId, status: 'requires_action', amount: 1500 }),
      eventCreatedAt: 1_780_000_100,
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
      paymentIntent: boundPaymentIntent({
        bookingId,
        id: piId,
        status: 'requires_payment_method',
        amount: 6000,
        extra: { last_payment_error: { code: 'card_declined' } },
      }),
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

  test('refund API response reserves state but only the webhook debits the ledger', async () => {
    const svc = require('../netlify/lib/db/payment-authority-service');
    const { bookingId } = await makeBookingWithQuote(10000);
    const piId = nextId('pi');
    await svc.reserveAndCreatePaymentIntent({
      bookingId, quoteVersion: 1, env: FAKE_ENV, fetchImpl: fakePaymentIntentCreateFetch({ id: piId }),
    });
    await svc.reconcilePaymentIntentEvent({
      stripeEventId: nextId('EVT'), type: 'payment_intent.succeeded',
      paymentIntent: boundPaymentIntent({ bookingId, id: piId, status: 'succeeded', amount: 10000 }),
    });

    const refund = await svc.createRefund({
      bookingId,
      amountCents: 3000,
      reason: 'approved goodwill credit',
      requestKey: nextId('REQ'),
      expectedQuoteVersion: 1,
      env: FAKE_ENV,
      fetchImpl: fakePaymentIntentCreateFetch(),
    });
    assert.equal(refund.ok, true);
    assert.equal(refund.refundRequest.status, 'pending_webhook');

    const beforeWebhook = await svc.getFinancialProjection(bookingId);
    assert.equal(beforeWebhook.refundedCents, 0);
    assert.equal(beforeWebhook.pendingRefundCents, 3000);

    const request = refund.refundRequest;
    const refundObject = {
      id: request.providerRefundId,
      object: 'refund',
      status: 'succeeded',
      amount: 3000,
      currency: 'usd',
      payment_intent: piId,
      metadata: {
        bookingId,
        booking_id: bookingId,
        quoteVersion: '1',
        purpose: 'customer_refund',
        refundRequestId: request.id,
        refund_request_id: request.id,
      },
    };
    const reconciled = await svc.reconcileRefundEvent({
      stripeEventId: nextId('EVT'),
      type: 'refund.created',
      refund: refundObject,
    });
    assert.equal(reconciled.ok, true);
    assert.equal(reconciled.ledger.created, true);
    const duplicate = await svc.reconcileRefundEvent({
      stripeEventId: nextId('EVT'),
      type: 'refund.updated',
      refund: refundObject,
    });
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.ledger.created, false);
    const projection = await svc.getFinancialProjection(bookingId);
    assert.equal(projection.refundedCents, 3000);
    assert.equal(projection.settledCents, 7000);
    assert.equal(await prisma.ledgerEntry.count({ where: { bookingId, kind: 'refund' } }), 1);
  });

  test('refund ceiling rejects an excessive caller amount before any Stripe call', async () => {
    const svc = require('../netlify/lib/db/payment-authority-service');
    const { bookingId } = await makeBookingWithQuote(1000);
    const piId = nextId('pi');
    await svc.reserveAndCreatePaymentIntent({
      bookingId, quoteVersion: 1, env: FAKE_ENV, fetchImpl: fakePaymentIntentCreateFetch({ id: piId }),
    });
    await svc.reconcilePaymentIntentEvent({
      stripeEventId: nextId('EVT'), type: 'payment_intent.succeeded',
      paymentIntent: boundPaymentIntent({ bookingId, id: piId, status: 'succeeded', amount: 1000 }),
    });
    let networkCalls = 0;
    const refund = await svc.createRefund({
      bookingId,
      amountCents: 999999,
      reason: 'invalid excessive request',
      requestKey: nextId('REQ'),
      expectedQuoteVersion: 1,
      env: FAKE_ENV,
      fetchImpl: async () => { networkCalls += 1; throw new Error('must not call Stripe'); },
    });
    assert.equal(refund.ok, false);
    assert.equal(refund.error, 'refund_exceeds_available_payment');
    assert.equal(networkCalls, 0);
    const projection = await svc.getFinancialProjection(bookingId);
    assert.equal(projection.refundedCents, 0);
    assert.equal(projection.settledCents, 1000);
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
      paymentIntent: boundPaymentIntent({ bookingId, id: piId, status: 'succeeded', amount: 5000 }),
    });
    const paidProjection = await svc.getFinancialProjection(bookingId);
    assert.equal(paidProjection.paymentStatus, 'paid');

    const adjustment = await svc.createAdjustment({
      bookingId,
      newApprovedCents: 8000,
      reason: 'added add-on after service began',
      adjustmentId: nextId('ADJ'),
      expectedQuoteVersion: 1,
    });
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
      paymentIntent: boundPaymentIntent({ bookingId, id: piId, status: 'succeeded', amount: 2000 }),
    });
    await svc.createAdjustment({
      bookingId,
      newApprovedCents: 2750,
      reason: 'approved add-on',
      adjustmentId: nextId('ADJ'),
      expectedQuoteVersion: 1,
    });

    const deltaAttempt = await svc.reserveAndCreatePaymentIntent({
      bookingId, quoteVersion: 2, env: FAKE_ENV, fetchImpl: fakePaymentIntentCreateFetch({ id: nextId('pi') }),
    });
    assert.equal(deltaAttempt.ok, true);
    assert.equal(deltaAttempt.paymentAttempt.amountCents, 750, 'must charge only the 750-cent delta, not the full 2750');
  });

  test('network timeout after Stripe creates the PI: retry with same Idempotency-Key attaches the same PI (no orphan)', async () => {
    const svc = require('../netlify/lib/db/payment-authority-service');
    const { bookingId } = await makeBookingWithQuote(3300);
    const piId = nextId('pi');
    let stripeCalls = 0;
    // First call: Stripe "succeeds" server-side but the response never reaches us.
    const timeoutThenSucceedFetch = async (url, opts) => {
      if (!String(url).includes('/payment_intents')) {
        return { ok: false, json: async () => ({ error: { message: 'unexpected_url' } }) };
      }
      stripeCalls += 1;
      if (stripeCalls === 1) {
        throw new Error('simulated_timeout_after_stripe_accept');
      }
      // Second call: Stripe idempotency returns the same PI that was created
      // on the timed-out request (same Idempotency-Key).
      return {
        ok: true,
        json: async () => ({
          id: piId,
          status: 'requires_payment_method',
          amount: 3300,
          currency: 'usd',
          metadata: {
            bookingId,
            booking_id: bookingId,
            quoteVersion: '1',
            purpose: 'customer_balance',
          },
        }),
      };
    };

    const first = await svc.reserveAndCreatePaymentIntent({
      bookingId, quoteVersion: 1, env: FAKE_ENV, fetchImpl: timeoutThenSucceedFetch,
    });
    assert.equal(first.ok, false);
    assert.equal(first.error, 'stripe_network_error');

    const stuck = await prisma.paymentAttempt.findFirst({ where: { bookingId, quoteVersion: 1 } });
    assert.ok(stuck, 'obligation must remain reserved after the timeout');
    assert.equal(stuck.status, 'creating');
    assert.equal(stuck.providerObjectId, null);

    const retry = await svc.reserveAndCreatePaymentIntent({
      bookingId, quoteVersion: 1, env: FAKE_ENV, fetchImpl: timeoutThenSucceedFetch,
    });
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.equal(retry.recoveredFromTimeout, true);
    assert.equal(retry.stripePaymentIntentId, piId);
    assert.equal(retry.paymentAttempt.id, stuck.id, 'must attach to the same attempt row, not create a second');
    assert.equal(retry.paymentAttempt.providerObjectId, piId);
    assert.equal(retry.paymentAttempt.status, 'open');
    assert.equal(stripeCalls, 2, 'exactly two Stripe calls: timed-out create + idempotent replay');

    const count = await prisma.paymentAttempt.count({ where: { bookingId, quoteVersion: 1 } });
    assert.equal(count, 1, 'timeout recovery must not create a second PaymentAttempt');
  });

  test('requires_action then succeeded: 3DS/auth path settles exactly once and blocks a concurrent second PI', async () => {
    const svc = require('../netlify/lib/db/payment-authority-service');
    const { bookingId } = await makeBookingWithQuote(4800);
    const piId = nextId('pi');
    const created = await svc.reserveAndCreatePaymentIntent({
      bookingId, quoteVersion: 1, env: FAKE_ENV, fetchImpl: fakePaymentIntentCreateFetch({ id: piId }),
    });
    assert.equal(created.ok, true);

    const authRequired = await svc.reconcilePaymentIntentEvent({
      stripeEventId: nextId('EVT'), type: 'payment_intent.requires_action',
      paymentIntent: boundPaymentIntent({ bookingId, id: piId, status: 'requires_action', amount: 4800 }),
    });
    assert.equal(authRequired.ok, true);
    assert.equal(authRequired.terminal, 'requires_action');

    const duringAuth = await prisma.paymentAttempt.findUnique({ where: { id: created.paymentAttempt.id } });
    assert.equal(duringAuth.status, 'requires_action');

    // While auth is outstanding, a second create must collapse to the same
    // active obligation — not open a parallel PaymentIntent.
    const concurrent = await svc.reserveAndCreatePaymentIntent({
      bookingId, quoteVersion: 1, env: FAKE_ENV, fetchImpl: fakePaymentIntentCreateFetch({ id: nextId('pi') }),
    });
    assert.equal(concurrent.ok, true);
    assert.equal(concurrent.created, false);
    assert.equal(concurrent.paymentAttempt.id, created.paymentAttempt.id);

    const settled = await svc.reconcilePaymentIntentEvent({
      stripeEventId: nextId('EVT'), type: 'payment_intent.succeeded',
      paymentIntent: boundPaymentIntent({ bookingId, id: piId, status: 'succeeded', amount: 4800 }),
    });
    assert.equal(settled.ok, true);
    assert.equal(settled.duplicate, false);

    const projection = await svc.getFinancialProjection(bookingId);
    assert.equal(projection.paymentStatus, 'paid');
    assert.equal(projection.remainingCents, 0);
    assert.equal(projection.settledCents, 4800);

    const attempt = await prisma.paymentAttempt.findUnique({ where: { id: created.paymentAttempt.id } });
    assert.equal(attempt.status, 'succeeded');
    const count = await prisma.paymentAttempt.count({ where: { bookingId, quoteVersion: 1 } });
    assert.equal(count, 1);
  });

  test('signed webhook commits once, retries neutrally, and persists only minimized event data', async () => {
    const crypto = require('crypto');
    const svc = require('../netlify/lib/db/payment-authority-service');
    const operational = require('../netlify/lib/db/operational-payment');
    const { bookingId } = await makeBookingWithQuote(3700);
    const piId = nextId('pi');
    const created = await svc.reserveAndCreatePaymentIntent({
      bookingId,
      quoteVersion: 1,
      env: FAKE_ENV,
      fetchImpl: fakePaymentIntentCreateFetch({ id: piId }),
    });
    assert.equal(created.ok, true, JSON.stringify(created));

    const eventId = nextId('EVT');
    const event = {
      id: eventId,
      type: 'payment_intent.succeeded',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: boundPaymentIntent({
          bookingId,
          id: piId,
          status: 'succeeded',
          amount: 3700,
          extra: {
            object: 'payment_intent',
            client_secret: 'pi_secret_never_store',
            billing_details: { name: 'Private Name' },
          },
        }),
      },
    };
    const raw = JSON.stringify(event);
    const secret = 'whsec_pr1_test';
    const timestamp = Math.floor(Date.now() / 1000);
    const valid = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`, 'utf8').digest('hex');
    const previousSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const originalSync = operational.syncBlobCompatibilityFromProjection;
    operational.syncBlobCompatibilityFromProjection = async () => ({ ok: true, noop: true });
    process.env.STRIPE_WEBHOOK_SECRET = secret;
    try {
      delete require.cache[require.resolve('../netlify/functions/stripe-webhook')];
      const { handler } = require('../netlify/functions/stripe-webhook');
      const request = {
        httpMethod: 'POST',
        headers: { 'stripe-signature': `t=${timestamp},v1=invalid,v1=${valid}` },
        body: raw,
      };
      const first = await handler(request);
      const second = await handler(request);
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(second.statusCode, 200, second.body);
      assert.equal(JSON.parse(first.body).duplicate, false);
      assert.equal(JSON.parse(second.body).duplicate, true);
    } finally {
      operational.syncBlobCompatibilityFromProjection = originalSync;
      if (previousSecret == null) delete process.env.STRIPE_WEBHOOK_SECRET;
      else process.env.STRIPE_WEBHOOK_SECRET = previousSecret;
      delete require.cache[require.resolve('../netlify/functions/stripe-webhook')];
    }

    const ledger = await prisma.ledgerEntry.findMany({ where: { bookingId, kind: 'settlement' } });
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].amountCents, 3700);
    const inbox = await prisma.stripeEvent.findUnique({ where: { stripeEventId: eventId } });
    assert.equal(inbox.status, 'processed');
    assert.equal(inbox.attemptCount, 1);
    const stored = JSON.stringify(inbox.payload);
    assert.doesNotMatch(stored, /client_secret|Private Name|billing_details/);
    assert.match(stored, /customer_balance/);
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

  test('reserveAndCreatePaymentIntent uses Accelerate-safe interactive transaction timeouts', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '../netlify/lib/db/payment-authority-service.js'),
      'utf8'
    );
    assert.match(src, /ACCELERATE_SAFE_TX_TIMEOUT_MS\s*=\s*14_000/);
    assert.match(src, /ACCELERATE_SAFE_TX_MAX_WAIT_MS\s*=\s*5_000/);
    assert.doesNotMatch(src, /timeout:\s*30_000/);
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
