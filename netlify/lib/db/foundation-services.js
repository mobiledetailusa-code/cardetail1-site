/**
 * Phase 2 transactional foundation — domain-level operations that enforce
 * the target financial invariants on the new relational tables:
 *   - at most one active payment obligation per bookingId+quoteVersion
 *     (DB-enforced by a partial unique index; see migration.sql)
 *   - idempotent Stripe event ingestion (UNIQUE stripeEventId)
 *   - append-only ledger (UNIQUE providerEventId + DB trigger blocks UPDATE/DELETE)
 *
 * Not wired into any live endpoint yet. This is the foundation Phase 3's
 * authoritative PaymentService will be built on, not that service itself.
 */

const { getPrisma } = require('../prisma');
const { Prisma } = require('@prisma/client');
const { sanitizeStripeEventPayload } = require('./stripe-event-data');

function isUniqueConstraintError(err) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function isForeignKeyError(err) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003';
}

/**
 * Reserve (or idempotently retrieve) the single active payment obligation
 * for bookingId+quoteVersion. Never creates a second active obligation:
 * the partial unique index makes the second concurrent insert fail, and
 * this function converts that failure into "return the existing one".
 */
async function reservePaymentObligation({
  bookingId,
  quoteId = null,
  quoteVersion,
  amountCents,
  providerObjectType,
  providerObjectId = null,
  providerCustomerId = null,
  purpose = 'customer_balance',
  idempotencyKey,
  generation = 1,
  prisma: prismaOverride = null,
  prelocked = false,
}) {
  const prisma = prismaOverride || getPrisma();

  // Callers holding the booking+quote advisory lock must avoid deliberately
  // tripping a unique constraint: PostgreSQL marks the whole surrounding
  // transaction aborted before Prisma can query the winning row. The lock
  // makes these reads authoritative for this reservation key.
  if (prelocked) {
    const byKey = await prisma.paymentAttempt.findUnique({ where: { idempotencyKey } });
    if (byKey) return { ok: true, created: false, reason: 'idempotent_replay', attempt: byKey };

    const existing = await prisma.paymentAttempt.findFirst({
      where: { bookingId, quoteVersion, status: { in: ['creating', 'open', 'requires_action'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      return { ok: true, created: false, reason: 'existing_active_obligation', attempt: existing };
    }
  }

  try {
    const attempt = await prisma.paymentAttempt.create({
      data: {
        bookingId,
        quoteId,
        quoteVersion,
        amountCents,
        purpose,
        providerCustomerId,
        providerObjectType,
        providerObjectId,
        idempotencyKey,
        generation,
        status: providerObjectId ? 'open' : 'creating',
      },
    });
    return { ok: true, created: true, attempt };
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;

    // Same idempotency key replayed (e.g. client retry after a timeout).
    const byKey = await prisma.paymentAttempt.findUnique({ where: { idempotencyKey } });
    if (byKey) return { ok: true, created: false, reason: 'idempotent_replay', attempt: byKey };

    // Someone else already holds the active obligation for this bookingId+quoteVersion.
    const existing = await prisma.paymentAttempt.findFirst({
      where: { bookingId, quoteVersion, status: { in: ['creating', 'open', 'requires_action'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return { ok: true, created: false, reason: 'existing_active_obligation', attempt: existing };

    return { ok: false, error: 'duplicate_constraint', code: err.code };
  }
}

/**
 * Insert-first-then-process inbox pattern: returns duplicate:true instead of
 * throwing when the same Stripe event is delivered more than once.
 */
async function recordStripeEvent({ stripeEventId, type, bookingId = null, payload }) {
  const prisma = getPrisma();
  const minimizedPayload = sanitizeStripeEventPayload(payload);
  try {
    const event = await prisma.stripeEvent.create({
      data: { stripeEventId, type, bookingId, payload: minimizedPayload, status: 'received' },
    });
    return { ok: true, created: true, duplicate: false, event };
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const existing = await prisma.stripeEvent.findUnique({ where: { stripeEventId } });
    return { ok: true, created: false, duplicate: true, event: existing };
  }
}

async function markStripeEventProcessed(stripeEventId) {
  const prisma = getPrisma();
  return prisma.stripeEvent.update({
    where: { stripeEventId },
    data: { status: 'processed', processedAt: new Date() },
  });
}

/**
 * Append one ledger credit/debit. Idempotent on providerEventId when given
 * (one Stripe event -> at most one ledger entry). LedgerEntry rows can never
 * be updated or deleted afterward (DB trigger; see migration.sql).
 */
async function appendLedgerEntry({
  bookingId,
  quoteId = null,
  paymentAttemptId = null,
  kind,
  amountCents,
  quoteVersion,
  providerObjectId = null,
  providerEventId = null,
  stripeEventId = null,
  actor = null,
}) {
  const prisma = getPrisma();
  try {
    const entry = await prisma.ledgerEntry.create({
      data: {
        bookingId,
        quoteId,
        paymentAttemptId,
        kind,
        amountCents,
        quoteVersion,
        providerObjectId,
        providerEventId,
        stripeEventId,
        actor,
      },
    });
    return { ok: true, created: true, duplicate: false, entry };
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const existing = providerEventId
      ? await prisma.ledgerEntry.findUnique({ where: { providerEventId } })
      : null;
    return { ok: true, created: false, duplicate: true, entry: existing };
  }
}

async function sumLedgerForQuote({ bookingId, quoteVersion }) {
  const prisma = getPrisma();
  const rows = await prisma.ledgerEntry.findMany({ where: { bookingId, quoteVersion } });
  return rows.reduce((sum, r) => sum + (r.kind === 'refund' ? -r.amountCents : r.amountCents), 0);
}

module.exports = {
  isUniqueConstraintError,
  isForeignKeyError,
  reservePaymentObligation,
  recordStripeEvent,
  markStripeEventProcessed,
  appendLedgerEntry,
  sumLedgerForQuote,
};
