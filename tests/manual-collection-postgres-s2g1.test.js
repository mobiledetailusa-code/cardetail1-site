/**
 * S2G.1 manual collection coordination.
 * The lock double serializes one Booking row in this process.
 * It does not establish real PostgreSQL behavior.
 */
'use strict';

delete process.env.DATABASE_URL;
delete process.env.DIRECT_URL;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
delete process.env.SQUARE_ACCESS_TOKEN;
delete process.env.SQUARE_APPLICATION_ID;
delete process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  onSiteSettlementManualCollectionConflict,
  reserveManualCollection,
  recordManualCollectionUrl,
  closeManualCollection,
  manualCollectionHttpResult,
} = require('../netlify/lib/db/manual-collection');
const { computeFinancialProjection } = require('../netlify/lib/db/financial-projection');
const {
  buildOnSiteFullBalanceProviderEventId,
} = require('../netlify/lib/db/payment-authority-service');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const ENV = {
  CD1_POSTGRES_PAYMENT: '1',
  DATABASE_URL: 'postgres://manual-collection-test.invalid/cardetail1',
  MANUAL_SQUARE_COLLECTION_ENABLED: 'true',
};
const UNPAID = {
  inspected: true,
  noCompletedPayment: true,
  deactivated: true,
  responsibilityAccepted: true,
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createHarness() {
  const world = {
    booking: {
      id: 'CD1-S2G1',
      status: 'confirmed',
      manualCollectionState: null,
      manualCollectionOperationId: null,
      manualCollectionQuoteVersion: null,
      manualCollectionUrl: null,
      manualCollectionDetail: null,
    },
    quote: { quoteVersion: 3, approvedCents: 17500, currency: 'usd' },
    ledger: [],
    attempts: [],
    blob: {
      id: 'CD1-S2G1',
      jobStatus: 'confirmed',
      manualPayLink: 'https://legacy.example/not-necessarily-square',
    },
  };
  let sequence = 0;
  let tail = Promise.resolve();
  let ensureCalls = 0;
  let lockCalls = 0;

  function project(booking, ledger) {
    return computeFinancialProjection({
      booking,
      quote: world.quote,
      paymentAttempts: world.attempts,
      ledgerEntries: ledger,
    });
  }

  function withBookingLock(_bookingId, operation) {
    lockCalls += 1;
    const run = tail.then(async () => {
      const bookingDraft = clone(world.booking);
      const ledgerDraft = world.ledger.map((entry) => clone(entry));
      const ctx = {
        async readBooking() { return clone(bookingDraft); },
        async readProjection() { return project(bookingDraft, ledgerDraft); },
        async writeCollection(patch) { Object.assign(bookingDraft, clone(patch)); },
        async readLedger() { return ledgerDraft.map((entry) => clone(entry)); },
        async appendLedger(entry) { ledgerDraft.push(clone(entry)); },
      };
      const result = await operation(ctx);
      world.booking = bookingDraft;
      world.ledger = ledgerDraft;
      return result;
    });
    tail = run.then(() => undefined, () => undefined);
    return run;
  }

  const deps = {
    ensureBookingFinancial: async () => {
      ensureCalls += 1;
      return { ok: true, bookingId: world.booking.id };
    },
    withBookingLock,
    createOperationId: () => {
      sequence += 1;
      return `op-${sequence}`;
    },
  };

  function input(extra = {}) {
    return {
      booking: world.blob,
      bookingId: world.booking.id,
      actorId: 'ada',
      env: ENV,
      now: '2026-10-30T20:00:00.000Z',
      ...extra,
    };
  }

  async function reserve(extra = {}, depExtra = {}) {
    return reserveManualCollection(input(extra), { ...deps, ...depExtra });
  }

  async function record(url, operationId, extra = {}, depExtra = {}) {
    return recordManualCollectionUrl({
      ...input(),
      operationId,
      url,
      ...extra,
    }, { ...deps, ...depExtra });
  }

  async function close(operationId, extra = {}, depExtra = {}) {
    return closeManualCollection({
      ...input(),
      operationId,
      outcome: 'unpaid_withdrawn',
      reason: 'Link deactivated in Square Dashboard',
      confirmation: UNPAID,
      ...extra,
    }, { ...deps, ...depExtra });
  }

  async function settle(method = 'cash') {
    return withBookingLock(world.booking.id, async (ctx) => {
      const row = await ctx.readBooking();
      const conflict = onSiteSettlementManualCollectionConflict(row);
      if (conflict) return conflict;
      const projection = await ctx.readProjection();
      const remaining = Math.round(Number(projection.remainingCents) || 0);
      const settledCents = Math.round(Number(projection.settledCents) || 0);
      const providerEventId = buildOnSiteFullBalanceProviderEventId({
        method,
        bookingId: row.id,
        quoteVersion: projection.quoteVersion,
        settledCents,
        remainingCents: remaining,
      });
      const existingForMethod = (await ctx.readLedger()).find((entry) => (
        entry.providerObjectId === method
        || String(entry.providerEventId || '').startsWith(`${method}_full_balance:`)
      ));
      if (remaining <= 0) {
        return existingForMethod
          ? { ok: true, created: false, duplicate: true, entry: existingForMethod, ledgerEntryCreated: false }
          : { ok: false, error: 'not_due', statusCode: 409, ledgerEntryCreated: false, paid: false };
      }
      if (existingForMethod && existingForMethod.providerEventId === providerEventId) {
        return { ok: true, created: false, duplicate: true, entry: existingForMethod, ledgerEntryCreated: false };
      }
      const entry = {
        kind: 'settlement',
        amountCents: remaining,
        providerEventId,
        providerObjectId: method,
      };
      await ctx.appendLedger(entry);
      return { ok: true, created: true, duplicate: false, entry, ledgerEntryCreated: true };
    });
  }

  function blocks() {
    return !!onSiteSettlementManualCollectionConflict(world.booking);
  }

  return {
    world, deps, reserve, record, close, settle, blocks,
    counts: () => ({ ensureCalls, lockCalls, sequence }),
  };
}

function assertExclusive(world) {
  const blocking = !!onSiteSettlementManualCollectionConflict(world.booking);
  assert.equal(
    blocking && world.ledger.length > 0,
    false,
    'an active manual collection and a committed on-site settlement both exist'
  );
}

test('reservation and cash settlement cannot both commit', async () => {
  const harness = createHarness();
  const reserved = await harness.reserve();
  const cash = await harness.settle('cash');
  assert.equal(reserved.ok, true);
  assert.equal(reserved.paid, false);
  assert.equal(cash.ok, false);
  assert.equal(cash.error, 'manual_collection_active');
  assert.equal(cash.ledgerEntryCreated, false);
  assert.equal(harness.world.ledger.length, 0);
  assertExclusive(harness.world);

  const reverse = createHarness();
  const settled = await reverse.settle('cash');
  const denied = await reverse.reserve();
  assert.equal(settled.created, true);
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'zero_remaining_balance');
  assert.equal(reverse.world.booking.manualCollectionState, null);
  assert.equal(reverse.world.ledger.length, 1);
  assertExclusive(reverse.world);
});

test('reservation and card settlement cannot both commit', async () => {
  const harness = createHarness();
  await harness.reserve();
  const card = await harness.settle('card_on_site');
  assert.equal(card.error, 'manual_collection_active');
  assert.equal(harness.world.ledger.length, 0);

  const reverse = createHarness();
  assert.equal((await reverse.settle('card_on_site')).created, true);
  assert.equal((await reverse.reserve()).error, 'zero_remaining_balance');
  assertExclusive(reverse.world);
});

test('two concurrent reservations create one operation', async () => {
  const harness = createHarness();
  const [first, second] = await Promise.all([harness.reserve(), harness.reserve()]);
  assert.equal(first.operationId, second.operationId);
  assert.equal(first.operationId, 'op-1');
  assert.equal([first, second].filter((result) => result.created).length, 1);
  assert.equal(harness.world.booking.manualCollectionState, 'reserved');
  assert.equal(harness.counts().sequence, 1);
  assertExclusive(harness.world);
});

test('two URL recordings keep one URL', async () => {
  const harness = createHarness();
  const reserved = await harness.reserve();
  const [first, second] = await Promise.all([
    harness.record('https://square.example/a', reserved.operationId),
    harness.record('https://square.example/b', reserved.operationId),
  ]);
  const urls = [first, second].filter((result) => result.ok);
  assert.equal(urls.length, 1);
  assert.equal([first, second].some((result) => result.error === 'manual_collection_url_conflict'), true);
  assert.equal(harness.world.booking.manualCollectionUrl, 'https://square.example/a');
  assert.equal(harness.world.booking.manualCollectionState, 'recorded');
  assert.equal(harness.world.blob.manualPayLink, 'https://legacy.example/not-necessarily-square');
});

test('URL recording versus closure cannot revive a closed reservation', async () => {
  const closedFirst = createHarness();
  const reserved = await closedFirst.reserve();
  const closed = await closedFirst.close(reserved.operationId);
  const lateUrl = await closedFirst.record('https://square.example/late', reserved.operationId);
  assert.equal(closed.manualCollection.state, 'closed');
  assert.equal(lateUrl.error, 'manual_collection_not_recordable');
  assert.equal(closedFirst.world.booking.manualCollectionUrl, null);

  const recordedFirst = createHarness();
  const open = await recordedFirst.reserve();
  await recordedFirst.record('https://square.example/kept', open.operationId);
  const attestation = await recordedFirst.close(open.operationId);
  assert.equal(attestation.manualCollection.state, 'closed');
  assert.equal(recordedFirst.world.booking.manualCollectionUrl, 'https://square.example/kept');
  assert.equal(recordedFirst.blocks(), false);
});

test('closure versus settlement does not settle a blocking reservation', async () => {
  const harness = createHarness();
  const reserved = await harness.reserve();
  await harness.record('https://square.example/pay', reserved.operationId);
  const [settlement, closure] = await Promise.all([
    harness.settle('cash'),
    harness.close(reserved.operationId),
  ]);
  assert.equal(settlement.error, 'manual_collection_active');
  assert.equal(closure.manualCollection.state, 'closed');
  assert.equal(harness.world.ledger.length, 0);
  assertExclusive(harness.world);
});

test('settlement after a confirmed unpaid closure can commit once', async () => {
  const harness = createHarness();
  const reserved = await harness.reserve();
  await harness.close(reserved.operationId);
  const settled = await harness.settle('cash');
  assert.equal(harness.world.booking.manualCollectionState, 'closed');
  assert.equal(settled.created, true);
  assert.equal(harness.world.ledger.length, 1);
  assert.equal(settled.entry.providerEventId, 'cash_full_balance:CD1-S2G1:3:0:17500');
  assertExclusive(harness.world);
});

test('a lost reservation response retries the same operation', async () => {
  const harness = createHarness();
  const first = await harness.reserve();
  const retry = await harness.reserve();
  assert.equal(first.created, true);
  assert.equal(retry.idempotent, true);
  assert.equal(retry.operationId, first.operationId);
  assert.equal(harness.counts().sequence, 1);
  assert.equal(retry.paid, false);
});

test('a lost settlement response does not append a second ledger entry', async () => {
  const harness = createHarness();
  const first = await harness.settle('cash');
  const retry = await harness.settle('cash');
  assert.equal(first.created, true);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.entry.providerEventId, first.entry.providerEventId);
  assert.equal(harness.world.ledger.length, 1);
});

test('a stale caller balance cannot reserve against a committed zero balance', async () => {
  const harness = createHarness();
  await harness.settle('cash');
  const denied = await harness.reserve({ staleRemainingCents: 17500 });
  assert.equal(denied.error, 'zero_remaining_balance');
  assert.equal(harness.world.booking.manualCollectionState, null);
  assert.equal(harness.world.ledger.length, 1);
});

test('a quote version change leaves the manual reservation in force', async () => {
  const harness = createHarness();
  const reserved = await harness.reserve();
  harness.world.quote = { quoteVersion: 9, approvedCents: 22000, currency: 'usd' };
  assert.equal(harness.world.booking.manualCollectionQuoteVersion, 3);
  assert.equal(harness.world.booking.manualCollectionState, 'reserved');
  const cash = await harness.settle('cash');
  assert.equal(cash.error, 'manual_collection_active');
  assert.equal(harness.world.ledger.length, 0);
  const again = await harness.reserve();
  assert.equal(again.operationId, reserved.operationId);
  assert.equal(harness.world.booking.manualCollectionQuoteVersion, 3);
});

test('cancellation does not release an active manual reservation', async () => {
  const harness = createHarness();
  const reserved = await harness.reserve();
  harness.world.blob = { ...harness.world.blob, jobStatus: 'cancelled', status: 'Cancelled' };
  const again = await harness.reserve();
  assert.equal(again.error, 'booking_canceled');
  assert.equal(harness.world.booking.manualCollectionOperationId, reserved.operationId);
  assert.equal((await harness.settle('cash')).error, 'manual_collection_active');
  assert.equal(harness.world.ledger.length, 0);

  const fresh = createHarness();
  fresh.world.blob = { ...fresh.world.blob, jobStatus: 'cancelled' };
  const denied = await fresh.reserve();
  assert.equal(denied.error, 'booking_canceled');
  assert.equal(fresh.world.booking.manualCollectionState, null);
  assert.equal(fresh.counts().ensureCalls, 0);
});

test('blob failure after reservation keeps the PostgreSQL restriction', async () => {
  const harness = createHarness();
  const result = await harness.reserve({}, {
    syncBlob: async () => { throw new Error('blob down'); },
  });
  const http = manualCollectionHttpResult(result);
  assert.equal(result.manualCollection.state, 'reserved');
  assert.equal(http.statusCode, 503);
  assert.equal(http.body.ok, false);
  assert.equal(http.body.error, 'blob_sync_failed');
  assert.equal(http.body.collectionRecorded, true);
  assert.equal(http.body.restrictionHeld, true);
  assert.equal(http.body.paid, false);
  assert.equal(harness.world.blob.manualPayLink, 'https://legacy.example/not-necessarily-square');
  assert.equal((await harness.settle('cash')).error, 'manual_collection_active');
});

test('blob failure after URL recording does not erase the legacy URL or the restriction', async () => {
  const harness = createHarness();
  const reserved = await harness.reserve();
  const result = await harness.record('https://square.example/new', reserved.operationId, {}, {
    syncBlob: async () => { throw new Error('blob down'); },
  });
  assert.equal(result.blobSyncFailed, true);
  assert.equal(harness.world.booking.manualCollectionUrl, 'https://square.example/new');
  assert.equal(harness.world.booking.manualCollectionState, 'recorded');
  assert.equal(harness.world.blob.manualPayLink, 'https://legacy.example/not-necessarily-square');
  assert.equal((await harness.settle('card_on_site')).ledgerEntryCreated, false);
});

test('closure without confirmation does not change collection state', async () => {
  const harness = createHarness();
  const reserved = await harness.reserve();
  const denied = await harness.close(reserved.operationId, {
    confirmation: { inspected: true },
  });
  assert.equal(denied.error, 'manual_collection_confirmation_required');
  assert.equal(denied.field, 'noCompletedPayment');
  assert.equal(harness.world.booking.manualCollectionState, 'reserved');
  assert.equal((await harness.settle('cash')).error, 'manual_collection_active');
});

test('a reported Square payment stays blocked and unpaid', async () => {
  const harness = createHarness();
  const reserved = await harness.reserve();
  await harness.record('https://square.example/paid', reserved.operationId);
  const reported = await harness.close(reserved.operationId, {
    outcome: 'payment_reported',
    reason: 'Square Dashboard showed a completed payment',
    confirmation: { inspected: true },
  });
  assert.equal(reported.paid, false);
  assert.equal(reported.paymentEvidence, false);
  assert.equal(reported.manualCollection.providerVerified, false);
  assert.equal(reported.manualCollection.state, 'payment_reported');
  assert.equal(reported.manualCollection.attestation.closedBy, 'ada');
  assert.equal(harness.world.ledger.length, 0);
  assert.equal((await harness.settle('cash')).error, 'manual_collection_active');
  assert.equal((await harness.reserve()).error, 'manual_collection_conflict');
  const released = await harness.close(reserved.operationId, { outcome: 'unpaid_withdrawn' });
  assert.equal(released.error, 'manual_collection_payment_unreconciled');
  assert.equal(harness.world.booking.manualCollectionState, 'payment_reported');
});

test('settlement retry stays idempotent when no manual collection exists', async () => {
  const harness = createHarness();
  const first = await harness.settle('cash');
  const second = await harness.settle('cash');
  assert.equal(harness.world.ledger.length, 1);
  assert.equal(second.duplicate, true);
  assert.equal(first.entry.providerEventId, buildOnSiteFullBalanceProviderEventId({
    method: 'cash',
    bookingId: 'CD1-S2G1',
    quoteVersion: 3,
    settledCents: 0,
    remainingCents: 17500,
  }));
});

test('a blocked settlement does not insert a ledger entry', async () => {
  const harness = createHarness();
  await harness.reserve();
  await harness.settle('cash');
  await harness.settle('card_on_site');
  assert.equal(harness.world.ledger.length, 0);
});

test('missing PostgreSQL authority does not lock or create collection state', async () => {
  const harness = createHarness();
  let locked = false;
  const result = await harness.reserve({
    env: { CD1_POSTGRES_PAYMENT: '0', DATABASE_URL: ENV.DATABASE_URL },
  }, {
    withBookingLock: async () => { locked = true; },
  });
  assert.equal(result.error, 'postgres_payment_disabled');
  assert.equal(locked, false);
  assert.equal(harness.counts().ensureCalls, 0);
  assert.equal(harness.world.booking.manualCollectionState, null);
});

test('a definite lock failure is not reported as an unknown commit', async () => {
  const harness = createHarness();
  const result = await harness.reserve({}, {
    withBookingLock: async () => { throw new Error('database unavailable'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'manual_collection_persist_failed');
  assert.equal(result.paid, false);
  assert.equal(harness.world.booking.manualCollectionState, null);
});

test('a missing projection and an empty balance fail closed', async () => {
  const missing = createHarness();
  const noProjection = await missing.reserve({}, {
    withBookingLock: async (_id, operation) => operation({
      async readBooking() { return clone(missing.world.booking); },
      async readProjection() { return null; },
      async writeCollection() { throw new Error('should not write'); },
    }),
  });
  assert.equal(noProjection.error, 'financial_projection_missing');

  const zero = createHarness();
  zero.world.quote = { quoteVersion: 3, approvedCents: 0, currency: 'usd' };
  const denied = await zero.reserve();
  assert.equal(denied.error, 'zero_remaining_balance');
  assert.equal(zero.world.booking.manualCollectionState, null);
});

test('an active Stripe attempt is not represented by a manual reservation', async () => {
  const harness = createHarness();
  harness.world.attempts.push({ status: 'open', provider: 'stripe', providerObjectType: 'payment_intent' });
  const projection = computeFinancialProjection({
    booking: { ...harness.world.booking, manualCollectionState: 'reserved' },
    quote: harness.world.quote,
    paymentAttempts: harness.world.attempts,
    ledgerEntries: [],
  });
  assert.equal(projection.paymentStatus, 'processing');
  const denied = await harness.reserve();
  assert.equal(denied.error, 'payment_attempt_in_progress');
  assert.equal(harness.world.booking.manualCollectionState, null);
  const due = computeFinancialProjection({
    booking: { id: 'CD1-S2G1', manualCollectionState: 'reserved' },
    quote: harness.world.quote,
    paymentAttempts: [],
    ledgerEntries: [],
  });
  assert.equal(due.paymentStatus, 'due');
});

test('recording requires the reservation and does not migrate a legacy URL', async () => {
  const harness = createHarness();
  let synced = false;
  const denied = await harness.record('https://square.example/new', 'op-1', {}, {
    syncBlob: async () => { synced = true; },
  });
  assert.equal(denied.error, 'manual_collection_reservation_required');
  assert.equal(synced, false);
  assert.equal(harness.world.blob.manualPayLink, 'https://legacy.example/not-necessarily-square');
  const settled = await harness.settle('cash');
  assert.equal(settled.created, true);
  assert.equal(harness.world.booking.manualCollectionState, null);
});

test('an audit failure does not become payment success or release the reservation', async () => {
  const harness = createHarness();
  const result = await harness.reserve({}, {
    audit: async () => { throw new Error('audit down'); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.auditFailed, true);
  assert.equal(result.paid, false);
  assert.equal(harness.world.booking.manualCollectionState, 'reserved');
});

test('the same URL record is idempotent and a replacement is rejected', async () => {
  const harness = createHarness();
  const reserved = await harness.reserve();
  const first = await harness.record('https://square.example/same', reserved.operationId);
  const retry = await harness.record('https://square.example/same', reserved.operationId);
  const replaced = await harness.record('https://square.example/other', reserved.operationId);
  assert.equal(first.created, true);
  assert.equal(retry.idempotent, true);
  assert.equal(replaced.error, 'manual_collection_url_conflict');
  assert.equal(harness.world.booking.manualCollectionUrl, 'https://square.example/same');
  assert.equal(first.paid, false);
});

test('a closed cycle can be reserved again without erasing its history', async () => {
  const harness = createHarness();
  const first = await harness.reserve();
  await harness.record('https://square.example/old', first.operationId);
  await harness.close(first.operationId);
  const second = await harness.reserve();
  assert.equal(second.created, true);
  assert.notEqual(second.operationId, first.operationId);
  assert.equal(harness.world.booking.manualCollectionUrl, null);
  assert.equal(harness.world.booking.manualCollectionDetail.history[0].url, 'https://square.example/old');
  assert.equal((await harness.settle('cash')).error, 'manual_collection_active');
});

test('schema, migration, settlement guard, and provider isolation stay narrow', () => {
  const schema = read('prisma/schema.prisma');
  const migration = read('prisma/migrations/20261030220000_manual_collection_booking_s2g1/migration.sql');
  const settlement = read('netlify/lib/db/payment-authority-service.js');
  const projection = read('netlify/lib/db/financial-projection.js');
  const coordinator = read('netlify/lib/db/manual-collection.js');
  const admin = read('netlify/functions/admin-ops-jobs.js');
  const cancel = read('netlify/lib/booking-cancel.js');
  const issuance = read('netlify/lib/square-prepared-issuance.js');

  assert.match(schema, /isDraft\s+Boolean\s+@default\(true\)/);
  assert.match(schema, /manualCollectionState\s+String\?/);
  assert.match(schema, /manualCollectionDetail\s+Json\?/);
  assert.match(migration, /ADD COLUMN "manualCollectionState" TEXT/);
  assert.doesNotMatch(migration, /\b(UPDATE|DELETE|DROP|INSERT)\b/i);

  const settlementStart = settlement.indexOf('async function recordFullBalanceOnSiteSettlement');
  const settlementEnd = settlement.indexOf('async function recordFullBalanceCashSettlement');
  const settlementBody = settlement.slice(settlementStart, settlementEnd);
  const lockAt = settlementBody.indexOf('FOR UPDATE');
  const guardAt = settlementBody.indexOf('onSiteSettlementManualCollectionConflict');
  const ledgerAt = settlementBody.indexOf('tx.ledgerEntry.create');
  assert.ok(lockAt >= 0 && guardAt > lockAt && ledgerAt > guardAt);

  const recorderStart = settlement.indexOf('async function recordSucceededAttemptLedger');
  const recorderEnd = settlement.indexOf('async function reconcileStalePaymentAttempts');
  const recorder = settlement.slice(recorderStart, recorderEnd);
  const conflictAt = recorder.indexOf('preserveExternalEventCollectionConflict');
  const ledgerWriteAt = recorder.indexOf('ledgerEntry.create');
  const attemptWriteAt = recorder.indexOf('paymentAttempt.update');
  assert.ok(conflictAt >= 0 && ledgerWriteAt > conflictAt);
  assert.ok(attemptWriteAt > ledgerWriteAt);
  assert.match(recorder, /settlement_\$\{providerObjectId\}/);
  assert.doesNotMatch(recorder, /retrievePaymentIntentClientSecret/);
  const reconcileStart = settlement.indexOf('async function reconcileStalePaymentAttempts');
  const supersedeStart = settlement.indexOf('async function supersedeOutdatedAttempts');
  assert.match(settlement.slice(reconcileStart, supersedeStart), /recordSucceededAttemptLedger/);
  const supersedeEnd = settlement.indexOf('function paymentAttemptInProgressResponse');
  assert.match(settlement.slice(supersedeStart, supersedeEnd), /recordSucceededAttemptLedger/);
  assert.doesNotMatch(projection, /manualCollection/);

  const adjustmentStart = settlement.indexOf('async function createAdjustment');
  const adjustmentEnd = settlement.indexOf('function isOnSiteSettlementEntry');
  const adjustmentBody = settlement.slice(adjustmentStart, adjustmentEnd);
  const adjustmentLock = adjustmentBody.indexOf('manualCollectionState');
  const adjustmentGuard = adjustmentBody.indexOf('onSiteSettlementManualCollectionConflict');
  const adjustmentQuote = adjustmentBody.indexOf('tx.quote.create');
  assert.ok(adjustmentLock >= 0 && adjustmentGuard > adjustmentLock && adjustmentQuote > adjustmentGuard);
  assert.doesNotMatch(cancel, /manualCollection/);
  assert.doesNotMatch(issuance, /manualCollection/);

  assert.doesNotMatch(coordinator, /paymentAttempt\.create|squareup\.com|api\.stripe\.com|fetch\(|\bpi_/);
  assert.match(coordinator, /Administrative attestation does not prove Square/);

  const link = admin.slice(admin.indexOf("action === 'set_payment_link'"), admin.indexOf("action === 'prepare_square_payment_link'"));
  assert.match(link, /recordManualCollectionUrl/);
  assert.match(link, /postgresPaymentEnabled/);
  assert.match(link, /manualPayLink/);
  assert.match(link, /authoritative: false/);
  assert.doesNotMatch(link, /paymentStatus:\s*'paid'/);
  assert.match(admin, /action === 'reserve_manual_collection'/);
  assert.match(admin, /action === 'close_manual_collection'/);
  assert.match(read('admin-ops.html'), /Attest Square link deactivated/);
  assert.match(read('admin-ops.html'), /Administrative attestation only/);
});

test('a missing flag refuses a new reservation and a new URL, and an existing reservation still blocks cash', async () => {
  const harness = createHarness();
  const disabledEnv = {
    CD1_POSTGRES_PAYMENT: '1',
    DATABASE_URL: ENV.DATABASE_URL,
  };
  const refused = await harness.reserve({ env: disabledEnv });
  assert.equal(refused.error, 'manual_square_collection_disabled');
  assert.equal(harness.world.booking.manualCollectionState, null);
  assert.equal(harness.world.blob.manualPayLink, 'https://legacy.example/not-necessarily-square');

  const reserved = await harness.reserve();
  assert.equal(reserved.ok, true);
  const urlRefused = await harness.record('https://square.example/new', reserved.operationId, { env: disabledEnv });
  assert.equal(urlRefused.error, 'manual_square_collection_disabled');
  const replay = await harness.reserve({ env: disabledEnv });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.operationId, reserved.operationId);
  assert.equal((await harness.settle('cash')).error, 'manual_collection_active');
  assert.equal((await harness.settle('card_on_site')).error, 'manual_collection_active');
});
