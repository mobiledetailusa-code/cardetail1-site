require('dotenv/config');

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { prismaConfigured, getPrisma } = require('../netlify/lib/prisma');
const authority = require('../netlify/lib/db/payment-authority-service');
const { computeFinancialProjection } = require('../netlify/lib/db/financial-projection');
const receipts = require('../netlify/lib/receipt-projection');
const { ensureBookingFinancial } = require('../netlify/lib/db/ensure-booking-financial');
const { handleWebhookDelivery } = require('../netlify/lib/db/webhook-inbox');

const RUN = `PR2-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
const STRIPE_ENV = { STRIPE_SECRET_KEY: 'sk_test_pr2_fake000000000000000' };
let counter = 0;

function unique(label) {
  counter += 1;
  return `${label}_${RUN}_${counter}`;
}

function refundObjectFromForm(params, id = unique('re'), status = 'succeeded') {
  const safeId = String(id).replace(/[^A-Za-z0-9]/g, '');
  return {
    id: `re_${safeId}`,
    object: 'refund',
    status,
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
  };
}

function refundFetch({ calls = [], status = 'succeeded' } = {}) {
  return async (url, opts = {}) => {
    assert.match(String(url), /\/v1\/refunds$/);
    const params = new URLSearchParams(opts.body || '');
    const object = refundObjectFromForm(params, unique('re'), status);
    calls.push({ url, opts, params, object });
    return { ok: true, json: async () => object };
  };
}

describe('PR2 — quote adjustment, refund, and receipt invariants', {
  skip: !prismaConfigured() && 'DATABASE_URL/DIRECT_URL required',
}, () => {
  let prisma;

  before(() => { prisma = getPrisma(); });

  async function seedBooking({ approvedCents = 10000, settledCents = 0 } = {}) {
    const bookingId = unique('BK');
    const quote = await prisma.quote.create({
      data: {
        booking: {
          create: { id: bookingId, status: 'confirmed', isDraft: false },
        },
        quoteVersion: 1,
        approvedCents,
        status: settledCents >= approvedCents && approvedCents > 0 ? 'settled' : 'approved',
        items: {
          create: [{ kind: 'service', label: 'Complete detail', amountCents: approvedCents }],
        },
      },
    });
    let attempt = null;
    if (settledCents > 0) {
      attempt = await prisma.paymentAttempt.create({
        data: {
          bookingId,
          quoteId: quote.id,
          quoteVersion: 1,
          generation: 1,
          provider: 'stripe',
          purpose: 'customer_balance',
          providerObjectType: 'payment_intent',
          providerObjectId: `pi_${unique('PAY')}`,
          status: 'succeeded',
          amountCents: settledCents,
          currency: 'usd',
          idempotencyKey: unique('pi_key'),
        },
      });
      await prisma.ledgerEntry.create({
        data: {
          bookingId,
          quoteId: quote.id,
          paymentAttemptId: attempt.id,
          kind: 'settlement',
          amountCents: settledCents,
          currency: 'usd',
          quoteVersion: 1,
          providerObjectId: attempt.providerObjectId,
          providerEventId: unique('settlement'),
          actor: 'test_webhook',
        },
      });
    }
    return { bookingId, quote, attempt };
  }

  test('two stale Admin tabs cannot both mint quote version 2', async () => {
    const { bookingId } = await seedBooking({ approvedCents: 10000 });
    const [left, right] = await Promise.all([
      authority.createAdjustment({
        bookingId,
        newApprovedCents: 12000,
        reason: 'approved add-on A',
        adjustmentId: unique('ADJ'),
        expectedQuoteVersion: 1,
      }),
      authority.createAdjustment({
        bookingId,
        newApprovedCents: 13000,
        reason: 'approved add-on B',
        adjustmentId: unique('ADJ'),
        expectedQuoteVersion: 1,
      }),
    ]);
    assert.equal([left, right].filter((row) => row.ok).length, 1);
    assert.equal([left, right].filter((row) => row.error === 'stale_quote_version').length, 1);
    assert.equal(await prisma.quote.count({ where: { bookingId, quoteVersion: 2 } }), 1);
  });

  test('same adjustment id is idempotent and a paid increase creates only the delta', async () => {
    const { bookingId } = await seedBooking({ approvedCents: 10000, settledCents: 10000 });
    const adjustmentId = unique('ADJ');
    const first = await authority.createAdjustment({
      bookingId,
      newApprovedCents: 12500,
      reason: 'customer-approved pet hair service',
      adjustmentId,
      expectedQuoteVersion: 1,
    });
    const replay = await authority.createAdjustment({
      bookingId,
      newApprovedCents: 12500,
      reason: 'customer-approved pet hair service',
      adjustmentId,
      expectedQuoteVersion: 1,
    });
    assert.equal(first.ok, true);
    assert.equal(first.after.remainingCents, 2500);
    assert.equal(replay.ok, true);
    assert.equal(replay.idempotent, true);
    assert.equal(await prisma.quote.count({ where: { bookingId } }), 2);
  });

  test('paid decrease creates explicit credit due without a negative ledger entry', async () => {
    const { bookingId } = await seedBooking({ approvedCents: 10000, settledCents: 10000 });
    const adjusted = await authority.createAdjustment({
      bookingId,
      newApprovedCents: 7000,
      reason: 'approved service credit',
      adjustmentId: unique('ADJ'),
      expectedQuoteVersion: 1,
    });
    assert.equal(adjusted.ok, true);
    assert.equal(adjusted.outstandingCreditCents, 3000);
    assert.equal(adjusted.after.remainingCents, 0);
    assert.equal(await prisma.ledgerEntry.count({ where: { bookingId, kind: 'adjustment' } }), 0);
    assert.equal(await prisma.ledgerEntry.count({ where: { bookingId, kind: 'refund' } }), 0);
  });

  test('network timeout retry reuses one refund request and one idempotency key', async () => {
    const { bookingId } = await seedBooking({ approvedCents: 10000, settledCents: 10000 });
    const requestKey = unique('REQ');
    const timedOut = await authority.createRefund({
      bookingId,
      amountCents: 1000,
      reason: 'approved partial refund',
      requestKey,
      expectedQuoteVersion: 1,
      env: STRIPE_ENV,
      fetchImpl: async () => { throw new Error('simulated timeout'); },
    });
    assert.equal(timedOut.error, 'stripe_network_error');
    const calls = [];
    const retried = await authority.createRefund({
      bookingId,
      amountCents: 1000,
      reason: 'approved partial refund',
      requestKey,
      expectedQuoteVersion: 1,
      env: STRIPE_ENV,
      fetchImpl: refundFetch({ calls }),
    });
    assert.equal(retried.ok, true);
    assert.equal(await prisma.refundRequest.count({ where: { bookingId } }), 1);
    assert.equal(
      calls[0].opts.headers['Idempotency-Key'],
      `${authority.buildRefundIdempotencyKey({ bookingId, requestKey })}_p0`
    );
  });

  test('same refund key with changed money is rejected before a second Stripe call', async () => {
    const { bookingId } = await seedBooking({ approvedCents: 10000, settledCents: 10000 });
    const requestKey = unique('REQ');
    await authority.createRefund({
      bookingId,
      amountCents: 1000,
      reason: 'approved partial refund',
      requestKey,
      expectedQuoteVersion: 1,
      env: STRIPE_ENV,
      fetchImpl: async () => { throw new Error('simulated timeout'); },
    });
    let calls = 0;
    const conflict = await authority.createRefund({
      bookingId,
      amountCents: 2000,
      reason: 'approved partial refund',
      requestKey,
      expectedQuoteVersion: 1,
      env: STRIPE_ENV,
      fetchImpl: async () => { calls += 1; },
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error, 'refund_request_conflict');
    assert.equal(calls, 0);
    assert.equal(await prisma.refundRequest.count({ where: { bookingId } }), 1);
  });

  test('a full booking refund is split safely across the original and delta PaymentIntents', async () => {
    const { bookingId } = await seedBooking({ approvedCents: 10000, settledCents: 10000 });
    const adjusted = await authority.createAdjustment({
      bookingId,
      newApprovedCents: 12500,
      reason: 'approved paint protection add-on',
      adjustmentId: unique('ADJ'),
      expectedQuoteVersion: 1,
    });
    const deltaAttempt = await prisma.paymentAttempt.create({
      data: {
        bookingId,
        quoteId: adjusted.quote.id,
        quoteVersion: 2,
        generation: 1,
        provider: 'stripe',
        purpose: 'customer_balance',
        providerObjectType: 'payment_intent',
        providerObjectId: `pi_${unique('DELTA')}`,
        status: 'succeeded',
        amountCents: 2500,
        currency: 'usd',
        idempotencyKey: unique('pi_key'),
      },
    });
    await prisma.ledgerEntry.create({
      data: {
        bookingId,
        quoteId: adjusted.quote.id,
        paymentAttemptId: deltaAttempt.id,
        kind: 'settlement',
        amountCents: 2500,
        currency: 'usd',
        quoteVersion: 2,
        providerObjectId: deltaAttempt.providerObjectId,
        providerEventId: unique('settlement'),
        actor: 'test_webhook',
      },
    });

    const calls = [];
    const issued = await authority.createRefund({
      bookingId,
      amountCents: 12500,
      reason: 'approved full cancellation',
      requestKey: unique('REQ'),
      expectedQuoteVersion: 2,
      env: STRIPE_ENV,
      fetchImpl: refundFetch({ calls }),
    });
    assert.equal(issued.ok, true);
    assert.equal(issued.splitAcrossPayments, true);
    assert.equal(issued.refundRequests.length, 2);
    assert.equal(calls.length, 2);
    assert.equal(issued.refundRequests.reduce((sum, row) => sum + row.amountCents, 0), 12500);
    assert.equal(new Set(calls.map((call) => call.opts.headers['Idempotency-Key'])).size, 2);

    for (let index = 0; index < calls.length; index += 1) {
      const reconciled = await authority.reconcileRefundEvent({
        stripeEventId: unique('EVT'),
        type: 'refund.created',
        refund: calls[index].object,
        eventCreatedAt: 250 + index,
      });
      assert.equal(reconciled.ok, true);
    }
    const projection = await authority.getFinancialProjection(bookingId);
    assert.equal(projection.paymentStatus, 'refunded');
    assert.equal(projection.refundedCents, 12500);
    assert.equal(projection.refundableCents, 0);
    assert.equal(await prisma.ledgerEntry.count({ where: { bookingId, kind: 'refund' } }), 2);
  });

  test('success is terminal, duplicate delivery is neutral, and older failure cannot regress it', async () => {
    const { bookingId, attempt } = await seedBooking({ approvedCents: 10000, settledCents: 10000 });
    const calls = [];
    const created = await authority.createRefund({
      bookingId,
      amountCents: 2500,
      reason: 'approved partial cancellation',
      requestKey: unique('REQ'),
      expectedQuoteVersion: 1,
      env: STRIPE_ENV,
      fetchImpl: refundFetch({ calls }),
    });
    const refund = calls[0].object;
    const succeeded = await authority.reconcileRefundEvent({
      stripeEventId: unique('EVT'),
      type: 'refund.created',
      refund,
      eventCreatedAt: 200,
    });
    assert.equal(succeeded.ok, true);
    const duplicate = await authority.reconcileRefundEvent({
      stripeEventId: unique('EVT'),
      type: 'refund.updated',
      refund,
      eventCreatedAt: 201,
    });
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.ledger.created, false);
    const staleFailure = await authority.reconcileRefundEvent({
      stripeEventId: unique('EVT'),
      type: 'refund.failed',
      refund: { ...refund, status: 'failed', failure_reason: 'expired_or_canceled_card' },
      eventCreatedAt: 199,
    });
    assert.equal(staleFailure.ok, true);
    assert.equal(staleFailure.ignored, true);
    const request = await prisma.refundRequest.findUnique({ where: { id: created.refundRequest.id } });
    assert.equal(request.status, 'succeeded');
    assert.equal(await prisma.ledgerEntry.count({
      where: { bookingId, paymentAttemptId: attempt.id, kind: 'refund' },
    }), 1);
  });

  test('signed refund webhook dispatches to the PostgreSQL reconciler', async () => {
    const { bookingId } = await seedBooking({ approvedCents: 8000, settledCents: 8000 });
    const calls = [];
    await authority.createRefund({
      bookingId,
      amountCents: 1500,
      reason: 'signed webhook test',
      requestKey: unique('REQ'),
      expectedQuoteVersion: 1,
      env: STRIPE_ENV,
      fetchImpl: refundFetch({ calls }),
    });
    const event = {
      id: unique('EVT'),
      type: 'refund.created',
      created: Math.floor(Date.now() / 1000),
      data: { object: calls[0].object },
    };
    const rawBody = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000);
    const secret = 'whsec_pr2_test';
    const signature = crypto.createHmac('sha256', secret)
      .update(`${timestamp}.${rawBody}`, 'utf8')
      .digest('hex');
    const handled = await handleWebhookDelivery({
      rawBody,
      sigHeader: `t=${timestamp},v1=${signature}`,
      secret,
    });
    assert.equal(handled.ok, true);
    assert.equal(handled.dispatched, 'refund');
    assert.equal(await prisma.ledgerEntry.count({ where: { bookingId, kind: 'refund' } }), 1);
  });

  test('receipt itemizes service, add-on, travel, discount, and taxes from the approved quote', () => {
    const projected = receipts.buildReceiptProjection({
      id: unique('BK'),
      firstName: 'Itemized',
      lastName: 'Customer',
      jobStatus: 'completed_paid',
      completedAt: '2026-08-05T10:00:00.000Z',
      vehicles: [{
        vehicleLabel: '2024 Toyota RAV4',
        packageName: 'Complete detail',
        basePrice: 100,
        addons: [{ name: 'Pet hair', qty: 1, price: 20 }],
        subtotal: 120,
      }],
      travelFeeAmount: 10,
      discountAmount: 20,
      taxCents: 300,
    }, 'final', {
      projection: {
        quoteVersion: 2,
        approvedCents: 11300,
        grossSettledCents: 11300,
        refundedCents: 0,
        remainingCents: 0,
      },
      quote: {
        quoteVersion: 2,
        items: [
          { kind: 'service', label: 'Complete detail', amountCents: 10000 },
          { kind: 'addon', label: 'Pet hair', amountCents: 2000 },
          { kind: 'travel', label: 'Travel fee', amountCents: 1000 },
          { kind: 'discount', label: 'Discount', amountCents: -2000 },
          { kind: 'tax', label: 'Taxes', amountCents: 300 },
        ],
      },
      ledgerEntries: [{
        kind: 'settlement',
        amountCents: 11300,
        providerObjectId: 'pi_itemized123456',
        recordedAt: new Date('2026-08-05T09:00:00.000Z'),
      }],
    });
    assert.equal(projected.ok, true);
    assert.equal(projected.receipt.status, 'Paid');
    assert.equal(projected.receipt.quoteVersion, 2);
    assert.deepEqual(projected.receipt.lineItems.map((item) => item.kind), [
      'service', 'addon', 'travel', 'discount', 'tax',
    ]);
    assert.deepEqual(projected.receipt.lineItems.map((item) => item.amount.cents), [
      10000, 2000, 1000, -2000, 300,
    ]);
    assert.equal(projected.receipt.financialSummary.approvedTotal.cents, 11300);
    assert.equal(projected.receipt.financialSummary.remainingBalance.cents, 0);
  });

  test('legacy PR1 quotes backfill one immutable item snapshot without duplicate rows', async () => {
    const bookingId = unique('BK');
    await prisma.quote.create({
      data: {
        booking: { create: { id: bookingId, status: 'confirmed', isDraft: false } },
        quoteVersion: 1,
        approvedCents: 12000,
        status: 'approved',
      },
    });
    const blobBooking = {
      id: bookingId,
      quoteVersion: 1,
      approvedFinalAmount: 120,
      quote: {
        quoteVersion: 1,
        approvedCents: 12000,
        lineItems: [
          { kind: 'package', vehicleId: 'veh-1', packageId: 'complete', amountCents: 10000 },
          { kind: 'addon', vehicleId: 'veh-1', addonId: 'pet', amountCents: 2000 },
        ],
      },
      service: {
        vehicles: [{
          vehicleId: 'veh-1',
          vehicleLabel: '2024 Toyota RAV4',
          packageName: 'Complete detail',
          addons: [{ id: 'pet', name: 'Pet hair' }],
        }],
      },
      ledger: { approvedCents: 12000, settledCents: 0, entries: [] },
    };
    const [left, right] = await Promise.all([
      ensureBookingFinancial(blobBooking),
      ensureBookingFinancial(blobBooking),
    ]);
    assert.equal(left.ok, true);
    assert.equal(right.ok, true);
    const quote = await prisma.quote.findUnique({
      where: { bookingId_quoteVersion: { bookingId, quoteVersion: 1 } },
      include: { items: { orderBy: { createdAt: 'asc' } } },
    });
    assert.equal(quote.items.length, 2);
    assert.equal(quote.items.reduce((sum, item) => sum + item.amountCents, 0), 12000);
    assert.match(quote.items[0].label, /Complete detail.*Toyota RAV4/);
    assert.match(quote.items[1].label, /Pet hair.*Toyota RAV4/);
  });

  test('non-cash ledger adjustments never inflate amount paid or Stripe-refundable money', () => {
    const projection = computeFinancialProjection({
      booking: { id: unique('BK') },
      quote: { quoteVersion: 2, approvedCents: 12000 },
      ledgerEntries: [
        { kind: 'settlement', amountCents: 10000 },
        { kind: 'adjustment', amountCents: 2000 },
      ],
    });
    assert.equal(projection.settledCents, 12000);
    assert.equal(projection.grossSettledCents, 10000);
    assert.equal(projection.refundableCents, 10000);
    assert.equal(projection.paymentStatus, 'paid');
  });

  test('full cancellation refund produces Refunded and a safe itemized receipt', async () => {
    const { bookingId } = await seedBooking({ approvedCents: 10000, settledCents: 10000 });
    await authority.createAdjustment({
      bookingId,
      newApprovedCents: 0,
      reason: 'approved cancellation',
      adjustmentId: unique('ADJ'),
      expectedQuoteVersion: 1,
    });
    const calls = [];
    const requested = await authority.createRefund({
      bookingId,
      amountCents: 10000,
      reason: 'approved cancellation',
      requestKey: unique('REQ'),
      expectedQuoteVersion: 2,
      env: STRIPE_ENV,
      fetchImpl: refundFetch({ calls }),
    });
    await authority.reconcileRefundEvent({
      stripeEventId: unique('EVT'),
      type: 'refund.created',
      refund: calls[0].object,
      eventCreatedAt: 300,
    });
    const data = await authority.getReceiptAuthorityData(bookingId);
    assert.equal(data.projection.paymentStatus, 'refunded');
    const projected = receipts.buildReceiptProjection({
      id: bookingId,
      firstName: 'Receipt',
      lastName: 'Customer',
      jobStatus: 'completed_paid',
      completedAt: '2026-08-05T10:00:00.000Z',
      vehicles: [{ vehicleLabel: '2022 Honda Civic', packageName: 'Complete detail', basePrice: 100, subtotal: 100 }],
    }, 'final', data);
    assert.equal(projected.ok, true);
    assert.equal(projected.receipt.status, 'Refunded');
    assert.equal(projected.receipt.financialSummary.amountPaid.cents, 10000);
    assert.equal(projected.receipt.financialSummary.amountRefunded.cents, 10000);
    assert.equal(projected.receipt.quoteVersion, 2);
    assert.ok(projected.receipt.lineItems.length >= 2);
    const serialized = JSON.stringify(projected.receipt);
    assert.doesNotMatch(serialized, /client_secret|paymentMethodId|billing_details|rawPayload/i);
    assert.doesNotMatch(serialized, new RegExp(requested.refundRequest.providerRefundId));
    assert.match(serialized, /re_••••/);
  });
});
