/**
 * Phase 2 transactional foundation — thin Prisma repositories for the new
 * relational models (Customer/Booking/Vehicle/Quote/QuoteItem/ChangeRequest/
 * PaymentAttempt/LedgerEntry/StripeEvent/AuditEvent).
 *
 * These are additive only: no existing Netlify function calls this module
 * yet. netlify/lib/booking-repository.js + the Blob aggregate (cd1-bookings)
 * remain the sole authority for live traffic until a Phase 3+ cutover.
 *
 * Every write here requires a real Prisma client (getPrisma() throws if
 * DATABASE_URL/DIRECT_URL is not configured) — callers own fail-open
 * behavior; this module does not silently swallow errors like the Blob
 * mirror does, because these tables are meant to become authoritative.
 */

const { getPrisma } = require('../prisma');

async function createBooking({ id, customerId = null, status = 'draft', isDraft = true }) {
  const prisma = getPrisma();
  return prisma.booking.create({ data: { id, customerId, status, isDraft } });
}

async function getBooking(id, prismaOverride = null) {
  const prisma = prismaOverride || getPrisma();
  return prisma.booking.findUnique({ where: { id } });
}

/**
 * Optimistic concurrency control: only applies `data` (and bumps
 * bookingVersion) if the row is still at `expectedVersion`. Returns
 * { ok:false, error:'version_conflict' } instead of throwing so callers can
 * retry-on-conflict the same way the Blob CAS layer does.
 */
async function casUpdateBooking({ id, expectedVersion, data = {} }) {
  const prisma = getPrisma();
  const result = await prisma.booking.updateMany({
    where: { id, bookingVersion: expectedVersion },
    data: { ...data, bookingVersion: expectedVersion + 1 },
  });
  if (result.count === 0) {
    return { ok: false, error: 'version_conflict' };
  }
  const booking = await prisma.booking.findUnique({ where: { id } });
  return { ok: true, booking };
}

async function createQuote({ bookingId, quoteVersion, approvedCents, status = 'draft' }) {
  const prisma = getPrisma();
  return prisma.quote.create({ data: { bookingId, quoteVersion, approvedCents, status } });
}

async function getQuote({ bookingId, quoteVersion }) {
  const prisma = getPrisma();
  return prisma.quote.findUnique({ where: { bookingId_quoteVersion: { bookingId, quoteVersion } } });
}

/** Highest quoteVersion for a booking — the currently active quote. */
async function getLatestQuote(bookingId, prismaOverride = null) {
  const prisma = prismaOverride || getPrisma();
  return prisma.quote.findFirst({ where: { bookingId }, orderBy: { quoteVersion: 'desc' } });
}

/**
 * Post-payment/pre-payment adjustment: create quoteVersion = current+1.
 * Never mutates the prior quote row (settled quotes are immutable by
 * convention — nothing in this codebase updates Quote.approvedCents in
 * place). Errors if a quote already exists at the target version (caller
 * raced another adjustment) rather than silently overwriting.
 */
async function createAdjustmentQuote({ bookingId, approvedCents, status = 'approved' }) {
  const prisma = getPrisma();
  return prisma.$transaction(async (tx) => {
    const current = await tx.quote.findFirst({ where: { bookingId }, orderBy: { quoteVersion: 'desc' } });
    const nextVersion = (current?.quoteVersion || 0) + 1;
    const quote = await tx.quote.create({
      data: { bookingId, quoteVersion: nextVersion, approvedCents, status },
    });
    return { previousQuote: current, quote };
  });
}

async function listPaymentAttempts(bookingId, prismaOverride = null) {
  const prisma = prismaOverride || getPrisma();
  return prisma.paymentAttempt.findMany({ where: { bookingId }, orderBy: { createdAt: 'asc' } });
}

async function listLedgerEntries(bookingId, prismaOverride = null) {
  const prisma = prismaOverride || getPrisma();
  return prisma.ledgerEntry.findMany({ where: { bookingId }, orderBy: { recordedAt: 'asc' } });
}

async function findPaymentAttemptByProviderObjectId(providerObjectId) {
  const prisma = getPrisma();
  return prisma.paymentAttempt.findUnique({ where: { providerObjectId } });
}

async function updatePaymentAttempt(id, data, prismaOverride = null) {
  const prisma = prismaOverride || getPrisma();
  return prisma.paymentAttempt.update({ where: { id }, data });
}

async function markQuoteStatus({ bookingId, quoteVersion, status }) {
  const prisma = getPrisma();
  return prisma.quote.update({ where: { bookingId_quoteVersion: { bookingId, quoteVersion } }, data: { status } });
}

/**
 * Atomic: create a booking and its first quote in one transaction. If quote
 * creation fails (e.g. a caller passes a duplicate version), the booking
 * insert is rolled back too — used to prove Phase 2's transaction-rollback
 * invariant in tests/db-transactional-foundation.test.js.
 */
async function createBookingWithInitialQuote({ id, customerId = null, approvedCents }) {
  const prisma = getPrisma();
  return prisma.$transaction(async (tx) => {
    const booking = await tx.booking.create({
      data: { id, customerId, status: 'draft', isDraft: true },
    });
    const quote = await tx.quote.create({
      data: { bookingId: id, quoteVersion: 1, approvedCents, status: 'draft' },
    });
    return { booking, quote };
  });
}

async function createVehicle({ bookingId, category = null, make = null, model = null, lengthFeet = null, label = null }) {
  const prisma = getPrisma();
  return prisma.vehicle.create({ data: { bookingId, category, make, model, lengthFeet, label } });
}

async function createChangeRequest({ bookingId, quoteVersion = null, kind, status = 'pending', payload, requiresAdminReview = false }) {
  const prisma = getPrisma();
  return prisma.changeRequest.create({
    data: { bookingId, quoteVersion, kind, status, payload, requiresAdminReview },
  });
}

module.exports = {
  createBooking,
  getBooking,
  casUpdateBooking,
  createQuote,
  getQuote,
  getLatestQuote,
  createAdjustmentQuote,
  createBookingWithInitialQuote,
  createVehicle,
  createChangeRequest,
  listPaymentAttempts,
  listLedgerEntries,
  findPaymentAttemptByProviderObjectId,
  updatePaymentAttempt,
  markQuoteStatus,
};
