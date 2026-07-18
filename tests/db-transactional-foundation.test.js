// Phase 2 — transactional-foundation invariant tests against the real
// Postgres database configured by DIRECT_URL/DATABASE_URL.
//
// These tests exercise netlify/lib/db/* directly. They do not touch any
// Netlify Blob store and do not go through any live endpoint — the new
// tables are not wired into production traffic yet.
//
// Skips (does not fail) when no database is configured, matching the
// existing scripts/prisma-smoke.js convention, so `npm test` stays green
// in environments without DATABASE_URL.
require('dotenv/config');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prismaConfigured, getPrisma, _resetPrismaForTests } = require('../netlify/lib/prisma');

const RUN_ID = `TESTDB-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
let idCounter = 0;
function nextId(label) {
  idCounter += 1;
  return `${RUN_ID}-${label}-${idCounter}`;
}

const dbConfigured = prismaConfigured();

describe('Phase 2 transactional foundation (Postgres)', { skip: !dbConfigured && 'DATABASE_URL/DIRECT_URL not configured' }, () => {
  let prisma;
  const createdBookingIds = [];

  before(() => {
    prisma = getPrisma();
  });

  after(async () => {
    // Best-effort cleanup. Bookings that ended up with a LedgerEntry child
    // (immutability tests) cannot be deleted — that is the intended
    // behavior of the append-only ledger, not a test bug. Everything else
    // created under this run's TESTDB- prefix is removed.
    for (const id of createdBookingIds) {
      try {
        await prisma.paymentAttempt.deleteMany({ where: { bookingId: id } });
        await prisma.quoteItem.deleteMany({ where: { quote: { bookingId: id } } });
        await prisma.changeRequest.deleteMany({ where: { bookingId: id } });
        await prisma.vehicle.deleteMany({ where: { bookingId: id } });
        await prisma.quote.deleteMany({ where: { bookingId: id } });
        await prisma.auditEvent.deleteMany({ where: { bookingId: id } });
        await prisma.booking.delete({ where: { id } });
      } catch {
        // Ledger children (FK RESTRICT) keep the booking row alive by design.
      }
    }
    // StripeEvent has no FK relation to Booking, so it isn't covered by the
    // per-booking cascade above; sweep this run's rows directly.
    try {
      await prisma.stripeEvent.deleteMany({ where: { stripeEventId: { startsWith: RUN_ID } } });
    } catch { /* best-effort */ }
  });

  test('referential integrity: creating a Vehicle for a nonexistent booking is rejected', async () => {
    const { createVehicle } = require('../netlify/lib/db/repositories');
    await assert.rejects(
      () => createVehicle({ bookingId: nextId('NOBOOKING'), category: 'suv' }),
      /Foreign key constraint|P2003/i
    );
  });

  test('transaction rollback: re-initializing an existing booking fails atomically, no partial rows left behind', async () => {
    const { createBookingWithInitialQuote } = require('../netlify/lib/db/repositories');
    const id = nextId('ROLLBACK');
    createdBookingIds.push(id);

    const first = await createBookingWithInitialQuote({ id, approvedCents: 1000 });
    assert.equal(first.booking.id, id);

    // Second call's booking.create hits the existing primary key and fails;
    // the quote.create in the same transaction must never execute/persist.
    await assert.rejects(() => createBookingWithInitialQuote({ id, approvedCents: 2000 }));

    const bookingCount = await prisma.booking.count({ where: { id } });
    assert.equal(bookingCount, 1, 'duplicate init attempt must not create a second booking row');
    const quoteCount = await prisma.quote.count({ where: { bookingId: id } });
    assert.equal(quoteCount, 1, 'duplicate init attempt must not create a second quote row');
    const quote = await prisma.quote.findUnique({ where: { bookingId_quoteVersion: { bookingId: id, quoteVersion: 1 } } });
    assert.equal(quote.approvedCents, 1000, 'original quote must be unchanged by the rolled-back second attempt');
  });

  test('concurrent quote update / stale version: CAS rejects a write against a stale expected version', async () => {
    const { createBooking, casUpdateBooking, getBooking } = require('../netlify/lib/db/repositories');
    const id = nextId('CAS');
    await createBooking({ id });
    createdBookingIds.push(id);

    const first = await casUpdateBooking({ id, expectedVersion: 0, data: { status: 'submitted' } });
    assert.equal(first.ok, true);
    assert.equal(first.booking.bookingVersion, 1);

    // Simulate two concurrent writers both starting from bookingVersion 0.
    const stale = await casUpdateBooking({ id, expectedVersion: 0, data: { status: 'confirmed' } });
    assert.equal(stale.ok, false);
    assert.equal(stale.error, 'version_conflict');

    const current = await getBooking(id);
    assert.equal(current.status, 'submitted', 'the stale writer must not have applied its update');
    assert.equal(current.bookingVersion, 1);
  });

  test('duplicate PaymentIntent reservation: second reservation for the same bookingId+quoteVersion returns the existing obligation', async () => {
    const { createBooking } = require('../netlify/lib/db/repositories');
    const { reservePaymentObligation } = require('../netlify/lib/db/foundation-services');
    const id = nextId('PAYRESV');
    await createBooking({ id, isDraft: false, status: 'confirmed' });
    createdBookingIds.push(id);

    const first = await reservePaymentObligation({
      bookingId: id,
      quoteVersion: 1,
      amountCents: 12345,
      providerObjectType: 'payment_intent',
      providerObjectId: `pi_${id}_1`,
      idempotencyKey: `${id}_v1_gen1`,
    });
    assert.equal(first.ok, true);
    assert.equal(first.created, true);

    const second = await reservePaymentObligation({
      bookingId: id,
      quoteVersion: 1,
      amountCents: 12345,
      providerObjectType: 'payment_intent',
      providerObjectId: `pi_${id}_2`, // different provider id — must still be blocked
      idempotencyKey: `${id}_v1_gen2`, // different idempotency key too
    });
    assert.equal(second.ok, true);
    assert.equal(second.created, false);
    assert.equal(second.reason, 'existing_active_obligation');
    assert.equal(second.attempt.id, first.attempt.id, 'must return the same obligation, not create a second one');

    const count = await prisma.paymentAttempt.count({ where: { bookingId: id, quoteVersion: 1 } });
    assert.equal(count, 1, 'exactly one PaymentAttempt row must exist for this bookingId+quoteVersion');
  });

  test('duplicate PaymentIntent reservation: identical idempotency-key retry replays the same row', async () => {
    const { createBooking } = require('../netlify/lib/db/repositories');
    const { reservePaymentObligation } = require('../netlify/lib/db/foundation-services');
    const id = nextId('IDEMPO');
    await createBooking({ id, isDraft: false, status: 'confirmed' });
    createdBookingIds.push(id);

    const key = `${id}_v1_gen1`;
    const first = await reservePaymentObligation({
      bookingId: id, quoteVersion: 1, amountCents: 500,
      providerObjectType: 'payment_intent', providerObjectId: `pi_${id}`, idempotencyKey: key,
    });
    const replay = await reservePaymentObligation({
      bookingId: id, quoteVersion: 1, amountCents: 500,
      providerObjectType: 'payment_intent', providerObjectId: `pi_${id}`, idempotencyKey: key,
    });
    assert.equal(replay.created, false);
    assert.equal(replay.attempt.id, first.attempt.id);
  });

  test('duplicate webhook event: the same stripeEventId is only ever recorded once', async () => {
    const { recordStripeEvent } = require('../netlify/lib/db/foundation-services');
    const stripeEventId = nextId('EVT');

    const first = await recordStripeEvent({ stripeEventId, type: 'checkout.session.completed', payload: { a: 1 } });
    assert.equal(first.ok, true);
    assert.equal(first.duplicate, false);

    const dup = await recordStripeEvent({ stripeEventId, type: 'checkout.session.completed', payload: { a: 1 } });
    assert.equal(dup.ok, true);
    assert.equal(dup.duplicate, true);
    assert.equal(dup.event.id, first.event.id);

    const count = await prisma.stripeEvent.count({ where: { stripeEventId } });
    assert.equal(count, 1);
  });

  test('ledger immutability: UPDATE and DELETE on a LedgerEntry are rejected by the database', async () => {
    const { createBooking } = require('../netlify/lib/db/repositories');
    const { appendLedgerEntry } = require('../netlify/lib/db/foundation-services');
    const id = nextId('LEDGER');
    await createBooking({ id, isDraft: false, status: 'confirmed' });
    createdBookingIds.push(id);

    const appended = await appendLedgerEntry({
      bookingId: id,
      kind: 'settlement',
      amountCents: 999,
      quoteVersion: 1,
      providerEventId: `${id}_evt`,
    });
    assert.equal(appended.ok, true);
    assert.equal(appended.created, true);

    // The DB trigger's RAISE EXCEPTION message doesn't reliably pass through
    // the Accelerate proxy verbatim, so only assert that the mutation is
    // rejected (not the exact wrapped error text) — the row-unchanged check
    // below is what actually proves immutability held.
    await assert.rejects(
      () => prisma.ledgerEntry.update({ where: { id: appended.entry.id }, data: { amountCents: 1 } }),
    );
    await assert.rejects(
      () => prisma.ledgerEntry.delete({ where: { id: appended.entry.id } }),
    );

    const stillThere = await prisma.ledgerEntry.findUnique({ where: { id: appended.entry.id } });
    assert.equal(stillThere.amountCents, 999, 'row must be unchanged after the rejected UPDATE attempt');
  });

  test('ledger dedup: re-delivering the same providerEventId does not double-credit', async () => {
    const { createBooking } = require('../netlify/lib/db/repositories');
    const { appendLedgerEntry, sumLedgerForQuote } = require('../netlify/lib/db/foundation-services');
    const id = nextId('LEDGERDEDUP');
    await createBooking({ id, isDraft: false, status: 'confirmed' });
    createdBookingIds.push(id);

    const providerEventId = `${id}_evt`;
    await appendLedgerEntry({ bookingId: id, kind: 'settlement', amountCents: 5000, quoteVersion: 1, providerEventId });
    const dup = await appendLedgerEntry({ bookingId: id, kind: 'settlement', amountCents: 5000, quoteVersion: 1, providerEventId });
    assert.equal(dup.duplicate, true);

    const total = await sumLedgerForQuote({ bookingId: id, quoteVersion: 1 });
    assert.equal(total, 5000, 'duplicate webhook delivery must not double the settled amount');
  });

  test('partial failure: a ledger append inside a failing transaction does not persist', async () => {
    const { createBooking } = require('../netlify/lib/db/repositories');
    const id = nextId('PARTIALFAIL');
    await createBooking({ id, isDraft: false, status: 'confirmed' });
    createdBookingIds.push(id);

    const providerEventId = `${id}_evt`;
    await assert.rejects(() => prisma.$transaction(async (tx) => {
      await tx.ledgerEntry.create({
        data: { bookingId: id, kind: 'settlement', amountCents: 100, quoteVersion: 1, providerEventId },
      });
      // Force the transaction to fail after the ledger insert has been staged.
      await tx.booking.update({ where: { id: nextId('DOES-NOT-EXIST') }, data: { status: 'confirmed' } });
    }));

    const row = await prisma.ledgerEntry.findUnique({ where: { providerEventId } });
    assert.equal(row, null, 'ledger insert staged inside a rolled-back transaction must not persist');
  });
});
