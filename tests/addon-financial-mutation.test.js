/**
 * Stage 1 — authoritative add-on financial mutations.
 * Requires Postgres (PaymentAuthorityService.createAdjustment).
 * Stripe is always fake — never a live network call.
 */
require('dotenv/config');
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { prismaConfigured, getPrisma } = require('../netlify/lib/prisma');

const dbConfigured = prismaConfigured();
const RUN_ID = `TESTDB-ADDON-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
let idCounter = 0;
function nextId(label) {
  idCounter += 1;
  return `${RUN_ID}-${label}-${idCounter}`;
}

const FAKE_ENV = {
  STRIPE_SECRET_KEY: 'sk_test_fake000000000000000000',
  CD1_POSTGRES_PAYMENT: '1',
};

function fakePaymentIntentCreateFetch({ id = 'pi_fake', amountCents = null, calls } = {}) {
  return async (url, opts) => {
    if (calls) calls.push({ url, method: opts?.method, body: opts?.body });
    if (String(url).includes('/payment_intents')) {
      let amount = amountCents;
      const params = new URLSearchParams(String(opts?.body || ''));
      if (amount == null && opts?.body) {
        amount = Number(params.get('amount') || 0);
      }
      return {
        ok: true,
        json: async () => ({
          id: String(id).startsWith('pi_') ? id : `pi_${id}`,
          status: 'requires_payment_method',
          amount: amount || 0,
          currency: 'usd',
          customer: params.get('customer'),
          metadata: {
            bookingId: params.get('metadata[bookingId]'),
            booking_id: params.get('metadata[booking_id]'),
            quoteVersion: params.get('metadata[quoteVersion]'),
            purpose: params.get('metadata[purpose]'),
          },
          client_secret: `${id}_secret`,
        }),
      };
    }
    return { ok: false, json: async () => ({ error: { message: 'unexpected_url' } }) };
  };
}

function createMemoryStore(seed = {}) {
  const data = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const etags = new Map();
  for (const [k] of data) etags.set(k, `etag-${k}-0`);
  return {
    async get(key) {
      if (!data.has(key)) return null;
      return JSON.parse(JSON.stringify(data.get(key)));
    },
    async getWithMetadata(key) {
      if (!data.has(key)) return null;
      return {
        data: JSON.parse(JSON.stringify(data.get(key))),
        etag: etags.get(key) || null,
      };
    },
    async setJSON(key, value, opts = {}) {
      if (opts.onlyIfMatch) {
        const current = etags.get(key);
        if (!current || current !== opts.onlyIfMatch) return { modified: false };
      }
      data.set(key, JSON.parse(JSON.stringify(value)));
      etags.set(key, `etag-${key}-${Date.now()}-${Math.random()}`);
      return { modified: true };
    },
    async list() {
      return { blobs: [...data.keys()].map((key) => ({ key })) };
    },
  };
}

function baseBooking(id, {
  approvedCents = 15000,
  settledCents = 0,
  paymentWorkflowStatus = null,
  addOnIds = [],
  quoteVersion = 1,
} = {}) {
  const entries = settledCents > 0
    ? [{
      kind: 'settlement',
      amountCents: settledCents,
      providerObjectId: `pi_seed_${id}`,
      recordedAt: new Date().toISOString(),
    }]
    : [];
  return {
    id,
    bookingVersion: 1,
    schemaVersion: 1,
    quoteVersion,
    status: settledCents > 0 ? 'Paid' : 'Confirmed',
    appointmentStatus: 'confirmed',
    jobStatus: settledCents > 0 ? 'completed_paid' : 'confirmed',
    paymentStatus: settledCents > 0 && settledCents >= approvedCents ? 'paid' : 'due',
    paymentWorkflowStatus: paymentWorkflowStatus
      || (settledCents > 0 && settledCents >= approvedCents ? 'payment_succeeded' : 'awaiting_customer_payment'),
    zipCode: '07102',
    travelFeeAmount: 0,
    approvedFinalAmount: approvedCents / 100,
    amountPaid: settledCents / 100,
    ledger: {
      currency: 'usd',
      approvedCents,
      settledCents,
      creditedCents: 0,
      entries,
    },
    vehicles: [{
      vehicleId: 'veh_1',
      cat: 'cars',
      category: 'cars',
      tierKey: 'small',
      packageId: 'maint',
      pkgId: 'maint',
      pkgName: 'Maintenance Detail',
      addOnIds: [...addOnIds],
      addons: addOnIds.map((addonId) => ({ id: addonId })),
    }],
    changeRequests: [],
  };
}

describe('Stage 1 addon financial mutations', () => {
  let prisma;
  let setBookingStoreOverride;
  const createdBookingIds = [];

  before(() => {
    // Hard fail — never soft-skip Stage 1 financial invariants when DB is missing.
    assert.equal(
      dbConfigured,
      true,
      'DATABASE_URL/DIRECT_URL required for Stage 1 addon financial mutations'
    );
    prisma = getPrisma();
    ({ setBookingStoreOverride } = require('../netlify/lib/booking-repository'));
  });

  after(async () => {
    setBookingStoreOverride(null);
    for (const id of createdBookingIds) {
      try {
        await prisma.paymentAttempt.deleteMany({ where: { bookingId: id } });
        await prisma.quote.deleteMany({ where: { bookingId: id } });
        await prisma.booking.delete({ where: { id } });
      } catch {
        // Ledger children (FK RESTRICT) keep the booking alive by design.
      }
    }
  });

  beforeEach(() => {
    setBookingStoreOverride(null);
  });

  afterEach(() => {
    setBookingStoreOverride(null);
  });

  async function seedBlob(booking) {
    createdBookingIds.push(booking.id);
    const store = createMemoryStore({ [booking.id]: booking });
    setBookingStoreOverride(store);
    return store;
  }

  it('1) before-pay add: 15000/0/15000 → 19000/0/19000', async () => {
    const { applyAddonFinancialMutation } = require('../netlify/lib/addon-financial-mutation');
    const { financialProjection } = require('../netlify/lib/payment-service');
    const id = nextId('BP-ADD');
    await seedBlob(baseBooking(id));

    const result = await applyAddonFinancialMutation({
      bookingId: id,
      expectedBookingVersion: 1,
      target: { vehicleId: 'veh_1' },
      addOnIdsToAdd: ['ozone'],
      env: FAKE_ENV,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.noop, false);
    assert.equal(result.postgresProjection.approvedCents, 19000);
    assert.equal(result.postgresProjection.settledCents, 0);
    assert.equal(result.postgresProjection.remainingCents, 19000);
    assert.equal(result.financialProjection.approvedCents, 19000);
    assert.equal(result.financialProjection.settledCents, 0);
    assert.equal(result.financialProjection.remainingCents, 19000);
    assert.equal(financialProjection(result.booking).remainingCents, 19000);
    assert.equal(
      result.quoteVersion,
      result.priorQuoteVersion + 1,
      'createAdjustment must advance quoteVersion by exactly 1'
    );
    assert.equal(result.adjustment.ok, true);
    assert.equal(result.adjustment.quote.quoteVersion, result.priorQuoteVersion + 1);
  });

  it('2) before-pay remove: 19000/0/19000 → 15000/0/15000', async () => {
    const { applyAddonFinancialMutation } = require('../netlify/lib/addon-financial-mutation');
    const id = nextId('BP-RM');
    await seedBlob(baseBooking(id, {
      approvedCents: 19000,
      addOnIds: ['ozone'],
      quoteVersion: 2,
    }));

    const result = await applyAddonFinancialMutation({
      bookingId: id,
      expectedBookingVersion: 1,
      target: { vehicleId: 'veh_1' },
      addOnIdsToRemove: ['ozone'],
      env: FAKE_ENV,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.postgresProjection.approvedCents, 15000);
    assert.equal(result.postgresProjection.settledCents, 0);
    assert.equal(result.postgresProjection.remainingCents, 15000);
    assert.equal(result.financialProjection.remainingCents, 15000);
  });

  it('3) after-pay add: 15000/15000/0 → 19000/15000/4000', async () => {
    const { applyAddonFinancialMutation } = require('../netlify/lib/addon-financial-mutation');
    const id = nextId('AP-ADD');
    await seedBlob(baseBooking(id, {
      approvedCents: 15000,
      settledCents: 15000,
      paymentWorkflowStatus: 'payment_succeeded',
    }));

    const result = await applyAddonFinancialMutation({
      bookingId: id,
      expectedBookingVersion: 1,
      target: { vehicleId: 'veh_1' },
      addOnIdsToAdd: ['ozone'],
      env: FAKE_ENV,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.postgresProjection.approvedCents, 19000);
    assert.equal(result.postgresProjection.settledCents, 15000);
    assert.equal(result.postgresProjection.remainingCents, 4000);
    assert.equal(result.financialProjection.approvedCents, 19000);
    assert.equal(result.financialProjection.settledCents, 15000);
    assert.equal(result.financialProjection.remainingCents, 4000);
    assert.ok(
      result.financialProjection.paymentStatus === 'due'
      || result.financialProjection.paymentStatus === 'processing',
      `expected due/processing, got ${result.financialProjection.paymentStatus}`
    );
    assert.equal(result.financialProjection.invoicePaid, false);
    assert.equal(result.quoteVersion, result.priorQuoteVersion + 1);
    assert.equal(result.adjustment.quote.quoteVersion, result.priorQuoteVersion + 1);
    assert.equal(result.adjustment.previousQuote.approvedCents, 15000);
  });

  it('4) next embedded PaymentIntent amount is exactly 4000', async () => {
    const { applyAddonFinancialMutation } = require('../netlify/lib/addon-financial-mutation');
    const { prepareEmbeddedPayment } = require('../netlify/lib/db/operational-payment');
    const id = nextId('PI');
    await seedBlob(baseBooking(id, {
      approvedCents: 15000,
      settledCents: 15000,
      paymentWorkflowStatus: 'payment_succeeded',
    }));

    const mutated = await applyAddonFinancialMutation({
      bookingId: id,
      expectedBookingVersion: 1,
      target: { vehicleId: 'veh_1' },
      addOnIdsToAdd: ['ozone'],
      env: FAKE_ENV,
    });
    assert.equal(mutated.ok, true, mutated.error);

    const calls = [];
    const piId = nextId('pi');
    const prepared = await prepareEmbeddedPayment({
      booking: mutated.booking,
      expectedQuoteVersion: mutated.quoteVersion,
      env: FAKE_ENV,
      fetchImpl: fakePaymentIntentCreateFetch({ id: piId, calls }),
    });
    assert.equal(prepared.ok, true, prepared.error);
    assert.equal(prepared.amountCents, 4000);
    assert.equal(prepared.projection.remainingCents, 4000);
    assert.match(String(calls[0]?.body || ''), /amount=4000/);
  });

  it('5) existing settlement ledger remains exactly one entry for 15000', async () => {
    const { applyAddonFinancialMutation } = require('../netlify/lib/addon-financial-mutation');
    const repo = require('../netlify/lib/db/repositories');
    const id = nextId('LEDGER');
    await seedBlob(baseBooking(id, {
      approvedCents: 15000,
      settledCents: 15000,
      paymentWorkflowStatus: 'payment_succeeded',
    }));

    const result = await applyAddonFinancialMutation({
      bookingId: id,
      expectedBookingVersion: 1,
      target: { vehicleId: 'veh_1' },
      addOnIdsToAdd: ['ozone'],
      env: FAKE_ENV,
    });
    assert.equal(result.ok, true, result.error);

    const ledger = await repo.listLedgerEntries(id);
    const settlements = ledger.filter((e) => e.kind === 'settlement');
    assert.equal(settlements.length, 1);
    assert.equal(settlements[0].amountCents, 15000);

    const blobEntries = (result.booking.ledger?.entries || []).filter((e) => e.kind === 'settlement');
    assert.equal(blobEntries.length, 1);
    assert.equal(blobEntries[0].amountCents, 15000);
  });

  it('6) duplicate add: no duplicate addon, no extra quote, no new PI, no ledger mutation', async () => {
    const { applyAddonFinancialMutation } = require('../netlify/lib/addon-financial-mutation');
    const repo = require('../netlify/lib/db/repositories');
    const { ensureBookingFinancial } = require('../netlify/lib/db/ensure-booking-financial');
    const { getBookingRecord } = require('../netlify/lib/booking-repository');
    const id = nextId('DUP');
    await seedBlob(baseBooking(id, {
      approvedCents: 19000,
      addOnIds: ['ozone'],
      quoteVersion: 2,
    }));

    const rec = await getBookingRecord(id);
    await ensureBookingFinancial(rec.booking);
    const quotesBefore = await prisma.quote.count({ where: { bookingId: id } });
    const ledgerBefore = await repo.listLedgerEntries(id);
    const attemptsBefore = await repo.listPaymentAttempts(id);

    const dup = await applyAddonFinancialMutation({
      bookingId: id,
      expectedBookingVersion: 1,
      target: { vehicleId: 'veh_1' },
      addOnIdsToAdd: ['ozone'],
      env: FAKE_ENV,
    });
    assert.equal(dup.ok, true, dup.error);
    assert.equal(dup.noop, true);
    assert.equal(dup.reason, 'duplicate_addon');

    const quotesAfter = await prisma.quote.count({ where: { bookingId: id } });
    const ledgerAfter = await repo.listLedgerEntries(id);
    const attemptsAfter = await repo.listPaymentAttempts(id);
    assert.equal(quotesAfter, quotesBefore, 'duplicate must not create another quote version');
    assert.equal(ledgerAfter.length, ledgerBefore.length, 'duplicate must not mutate ledger');
    assert.equal(attemptsAfter.length, attemptsBefore.length, 'duplicate must not create PaymentIntent');

    const veh = (dup.booking.service?.vehicles || dup.booking.vehicles || [])[0] || {};
    const ids = veh.addOnIds || (veh.addons || []).map((a) => a.id);
    assert.deepEqual(ids.filter((x) => x === 'ozone'), ['ozone']);
  });

  it('7) removing a fully paid add-on creates explicit credit without auto-refund', async () => {
    const { applyAddonFinancialMutation } = require('../netlify/lib/addon-financial-mutation');
    const repo = require('../netlify/lib/db/repositories');
    const id = nextId('RM-DENY');
    // After a prior post-pay add-on: open delta exists (not fully historically closed).
    const seeded = baseBooking(id, {
      approvedCents: 19000,
      settledCents: 19000,
      addOnIds: ['ozone'],
      paymentWorkflowStatus: 'payment_succeeded',
      quoteVersion: 2,
    });
    await seedBlob(seeded);

    const { ensureBookingFinancial } = require('../netlify/lib/db/ensure-booking-financial');
    const { getBookingRecord } = require('../netlify/lib/booking-repository');
    const beforeRec = await getBookingRecord(id);
    await ensureBookingFinancial(beforeRec.booking);
    const quotesBefore = await prisma.quote.count({ where: { bookingId: id } });
    const ledgerBefore = await repo.listLedgerEntries(id);
    const settledBefore = beforeRec.booking.ledger.settledCents;

    const result = await applyAddonFinancialMutation({
      bookingId: id,
      expectedBookingVersion: 1,
      target: { vehicleId: 'veh_1' },
      addOnIdsToRemove: ['ozone'],
      env: FAKE_ENV,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.postgresProjection.approvedCents, 15000);
    assert.equal(result.postgresProjection.settledCents, 19000);
    assert.equal(result.postgresProjection.remainingCents, 0);
    assert.equal(result.outstandingCreditCents, 4000);

    const afterRec = await getBookingRecord(id);
    assert.equal(afterRec.booking.ledger.approvedCents, 15000);
    assert.equal(afterRec.booking.ledger.settledCents, settledBefore);
    assert.equal(afterRec.booking.ledger.refundedCents || 0, 0);
    assert.equal(await prisma.quote.count({ where: { bookingId: id } }), quotesBefore + 1);
    assert.equal((await repo.listLedgerEntries(id)).length, ledgerBefore.length);
  });

  it('8) browser-supplied price is ignored', async () => {
    const { applyAddonFinancialMutation } = require('../netlify/lib/addon-financial-mutation');
    const id = nextId('PRICE');
    await seedBlob(baseBooking(id));

    const result = await applyAddonFinancialMutation({
      bookingId: id,
      expectedBookingVersion: 1,
      target: { vehicleId: 'veh_1' },
      // Caller might try to smuggle prices via surrounding CR delta; mutation accepts IDs only.
      addOnIdsToAdd: ['ozone'],
      env: FAKE_ENV,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.postgresProjection.approvedCents, 19000, 'catalog ozone=$40 must win over any client price');
    assert.equal(result.postgresProjection.remainingCents, 19000);
  });

  it('9) PostgreSQL and compatibility projection agree', async () => {
    const { applyAddonFinancialMutation } = require('../netlify/lib/addon-financial-mutation');
    const authority = require('../netlify/lib/db/payment-authority-service');
    const { financialProjection } = require('../netlify/lib/payment-service');
    const id = nextId('PARITY');
    await seedBlob(baseBooking(id, {
      approvedCents: 15000,
      settledCents: 15000,
      paymentWorkflowStatus: 'payment_succeeded',
    }));

    const result = await applyAddonFinancialMutation({
      bookingId: id,
      expectedBookingVersion: 1,
      target: { vehicleId: 'veh_1' },
      addOnIdsToAdd: ['ozone'],
      env: FAKE_ENV,
    });
    assert.equal(result.ok, true, result.error);
    const pg = await authority.getFinancialProjection(id);
    const blob = financialProjection(result.booking);
    assert.equal(pg.approvedCents, blob.approvedCents);
    assert.equal(pg.settledCents, blob.settledCents);
    assert.equal(pg.remainingCents, blob.remainingCents);
    assert.equal(pg.quoteVersion, result.booking.quoteVersion);
  });

  it('unknown addon id is rejected', async () => {
    const { applyAddonFinancialMutation } = require('../netlify/lib/addon-financial-mutation');
    const id = nextId('UNK');
    await seedBlob(baseBooking(id));
    const result = await applyAddonFinancialMutation({
      bookingId: id,
      expectedBookingVersion: 1,
      target: { vehicleId: 'veh_1' },
      addOnIdsToAdd: ['not_a_real_addon'],
      env: FAKE_ENV,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'unknown_addon_id');
  });

  it('decideChangeRequestCommand additive post-pay addon uses adjustment path', async () => {
    const {
      submitChangeRequestCommand,
      decideChangeRequestCommand,
    } = require('../netlify/lib/booking-commands');
    const id = nextId('DECIDE');
    await seedBlob(baseBooking(id, {
      approvedCents: 15000,
      settledCents: 15000,
      paymentWorkflowStatus: 'payment_succeeded',
    }));

    const submitted = await submitChangeRequestCommand({
      bookingId: id,
      expectedBookingVersion: 1,
      requestType: 'addon_request',
      target: { vehicleId: 'veh_1' },
      delta: {
        addOnIdsToAdd: ['ozone'],
        addonIds: ['ozone'],
        // Inflated browser total must not become approvedCents
        proposedTotal: 9999,
        price: 999,
      },
    });
    assert.equal(submitted.ok, true, submitted.error);

    const decided = await decideChangeRequestCommand({
      bookingId: id,
      requestId: submitted.changeRequest.requestId,
      decision: 'approve',
      expectedBookingVersion: submitted.booking.bookingVersion,
      acceptRequote: true,
    });
    assert.equal(decided.ok, true, decided.error);
    assert.equal(decided.postgresProjection.approvedCents, 19000);
    assert.equal(decided.postgresProjection.settledCents, 15000);
    assert.equal(decided.postgresProjection.remainingCents, 4000);
  });
});
