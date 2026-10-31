/**
 * Ensure a Blob booking has a Postgres Booking + Quote row so
 * PaymentAuthorityService / FinancialProjection can operate.
 *
 * Does not delete Blobs. Seeds settlement ledger rows only when Blob already
 * shows settled money and Postgres has none (idempotent import of history).
 */

const { prismaConfigured, getPrisma } = require('../prisma');
const repo = require('./repositories');
const foundation = require('./foundation-services');
const { isUniqueConstraintError } = foundation;

const IMPORT_TRANSACTION_ATTEMPTS = 3;

function approvedCentsFromBlob(booking) {
  try {
    const { materialProjection } = require('../booking-aggregate');
    const material = materialProjection(booking) || {};
    const ledger = (booking && booking.ledger) || {};
    const cents = Math.round(
      Number(
        material.approvedCents != null
          ? material.approvedCents
          : ledger.approvedCents != null
            ? ledger.approvedCents
            : (Number(booking.amountDueApproved || booking.totalPrice || booking.price || 0) * 100)
      ) || 0
    );
    return Math.max(0, cents);
  } catch {
    const dollars = Number(booking?.amountDueApproved || booking?.totalPrice || booking?.price || 0) || 0;
    return Math.max(0, Math.round(dollars * 100));
  }
}

function settledCentsFromBlob(booking) {
  try {
    const { materialProjection } = require('../booking-aggregate');
    const material = materialProjection(booking) || {};
    const ledger = (booking && booking.ledger) || {};
    return Math.max(
      0,
      Math.round(Number(material.settledCents != null ? material.settledCents : ledger.settledCents) || 0)
    );
  } catch {
    return 0;
  }
}

function quoteVersionFromBlob(booking) {
  const v = Math.round(Number(booking?.quoteVersion) || 1);
  return v > 0 ? v : 1;
}

function quoteItemsFromBooking(booking, approvedCents) {
  const snapshot = booking?.quote && typeof booking.quote === 'object' ? booking.quote : {};
  const rawItems = Array.isArray(snapshot.lineItems) ? snapshot.lineItems : [];
  const vehicles = Array.isArray(booking?.service?.vehicles)
    ? booking.service.vehicles
    : (Array.isArray(booking?.vehicles) ? booking.vehicles : []);
  const vehicleById = new Map(vehicles
    .filter((vehicle) => vehicle && vehicle.vehicleId)
    .map((vehicle) => [String(vehicle.vehicleId), vehicle]));

  const items = rawItems.map((item) => {
    const amountCents = Math.round(Number(item?.amountCents));
    if (!item || !Number.isFinite(amountCents) || amountCents === 0) return null;
    const kind = String(item.kind || 'service').trim().toLowerCase() || 'service';
    const vehicle = item.vehicleId ? vehicleById.get(String(item.vehicleId)) : null;
    const vehicleLabel = String(
      vehicle?.vehicleLabel
      || vehicle?.label
      || [vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean).join(' ')
      || ''
    ).trim();
    let label = String(item.label || '').trim();
    if (!label && kind === 'package') {
      label = String(vehicle?.packageName || vehicle?.pkgName || item.packageId || 'Package');
    }
    if (!label && kind === 'addon') {
      const addon = (Array.isArray(vehicle?.addons) ? vehicle.addons : [])
        .find((entry) => String(entry?.id || '') === String(item.addonId || ''));
      label = String(addon?.name || item.addonId || 'Add-on');
    }
    if (!label && (kind === 'travel' || kind === 'travel_fee')) label = 'Travel fee';
    if (!label && (kind === 'offer' || kind === 'discount')) label = 'Discount';
    if (!label && (kind === 'tax' || kind === 'taxes')) label = 'Taxes';
    if (!label && kind.startsWith('adjustment')) label = 'Approved price adjustment';
    if (!label) label = 'Service';
    if (vehicleLabel && (kind === 'package' || kind === 'addon')) label += ` — ${vehicleLabel}`;
    return { kind, label: label.slice(0, 220), amountCents };
  }).filter(Boolean);

  const snapshotTotal = items.reduce((sum, item) => sum + item.amountCents, 0);
  if (items.length && snapshotTotal === approvedCents) return items;
  // Older Blob bookings may have no item snapshot. Preserve the approved total
  // exactly and label the limitation instead of re-pricing from today's catalog.
  return approvedCents > 0
    ? [{ kind: 'service', label: 'Approved booking total (legacy snapshot)', amountCents: approvedCents }]
    : [];
}

function blocksFinancialImport(state) {
  if (state == null || state === '' || state === 'closed') return false;
  return true;
}

function importFailureKind(error) {
  const adapter = error?.meta?.driverAdapterError?.cause;
  const text = [
    error?.code,
    error?.message,
    error?.cause?.code,
    error?.cause?.message,
    error?.meta?.code,
    adapter?.originalCode,
    adapter?.message,
  ].filter(Boolean).join(' ');
  if (/\b(?:P2034|P2002|40001|40P01)\b|serialization failure|deadlock detected|unique constraint/i.test(text)) {
    return 'retry';
  }
  if (/ECONNRESET|EPIPE|connection terminated|server closed the connection|closed the connection/i.test(text)) {
    return 'reread';
  }
  return 'failed';
}

async function ensureBookingRow(booking, bookingId) {
  let row = await repo.getBooking(bookingId);
  if (row) return row;
  const status = booking.isDraft ? 'draft' : 'confirmed';
  try {
    await repo.createBooking({
      id: bookingId,
      status,
      isDraft: !!booking.isDraft,
    });
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
  }
  row = await repo.getBooking(bookingId);
  if (!row) {
    const error = new Error('booking_not_ensured');
    error.code = 'booking_not_ensured';
    throw error;
  }
  return row;
}

async function backfillQuoteItems(tx, quoteId, items) {
  if (!quoteId || !items.length) return;
  const count = await tx.quoteItem.count({ where: { quoteId } });
  if (count > 0) return;
  await tx.quoteItem.createMany({
    data: items.map((item) => ({ ...item, quoteId })),
  });
}

async function resolveQuote(tx, { bookingId, quoteVersion, approvedCents, settledBlob, quoteItems, blocks }) {
  let quote = await tx.quote.findFirst({
    where: { bookingId },
    orderBy: { quoteVersion: 'desc' },
  });
  const settleStatus = !blocks && settledBlob > 0 && settledBlob >= approvedCents && approvedCents > 0
    ? 'settled'
    : 'approved';
  if (!quote) {
    quote = await tx.quote.create({
      data: {
        bookingId,
        quoteVersion,
        approvedCents,
        status: settleStatus,
        ...(quoteItems.length ? { items: { create: quoteItems } } : {}),
      },
    });
    return { quote, amountChangeBlocked: false };
  }

  const sameVersionDifferentAmount = quote.quoteVersion === quoteVersion
    && quote.approvedCents !== approvedCents
    && quote.status !== 'settled'
    && approvedCents > 0;
  if (sameVersionDifferentAmount) {
    if (blocks) return { quote, amountChangeBlocked: true };
    const nextVersion = quote.quoteVersion + 1;
    const created = await tx.quote.create({
      data: {
        bookingId,
        quoteVersion: nextVersion,
        approvedCents,
        status: 'approved',
        ...(quoteItems.length ? { items: { create: quoteItems } } : {}),
      },
    });
    return { quote: created, amountChangeBlocked: false };
  }

  if (quote.quoteVersion < quoteVersion && approvedCents > 0) {
    const existing = await tx.quote.findUnique({
      where: { bookingId_quoteVersion: { bookingId, quoteVersion } },
    });
    if (existing) return { quote: existing, amountChangeBlocked: false };
    if (blocks) return { quote, amountChangeBlocked: true };
    quote = await tx.quote.create({
      data: {
        bookingId,
        quoteVersion,
        approvedCents,
        status: 'approved',
        ...(quoteItems.length ? { items: { create: quoteItems } } : {}),
      },
    });
  }
  return { quote, amountChangeBlocked: false };
}

async function importFinancialUnderLock({
  booking,
  bookingId,
  approvedCents,
  quoteVersion,
  settledBlob,
  quoteItems,
}) {
  const prisma = getPrisma();
  const { Prisma } = require('@prisma/client');
  let decision = null;
  for (let attempt = 1; attempt <= IMPORT_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const lockedRows = await tx.$queryRaw`
          SELECT "id", "manualCollectionState"
          FROM "Booking" WHERE "id" = ${bookingId} FOR UPDATE
        `;
        const locked = Array.isArray(lockedRows) ? lockedRows[0] : null;
        if (!locked) return { ok: false, error: 'booking_not_ensured', statusCode: 503 };
        const manualState = locked.manualCollectionState == null
          ? null
          : String(locked.manualCollectionState);
        const blocks = blocksFinancialImport(manualState);
        const resolved = await resolveQuote(tx, {
          bookingId,
          quoteVersion,
          approvedCents,
          settledBlob,
          quoteItems,
          blocks,
        });
        const quote = resolved.quote;
        if (!quote) return { ok: false, error: 'quote_not_ensured', statusCode: 503 };
        await backfillQuoteItems(tx, quote.id, quoteItems);

        const ledger = await tx.ledgerEntry.findMany({ where: { bookingId } });
        const hasSettlement = ledger.some((entry) => entry.kind === 'settlement');
        const wantsSeed = settledBlob > 0 && !hasSettlement;
        if (blocks && (wantsSeed || resolved.amountChangeBlocked)) {
          return {
            ok: true,
            bookingId,
            ensured: true,
            seededSettlement: false,
            duplicate: false,
            importBlocked: 'manual_collection_active',
            synchronizationBlocked: true,
            manualCollectionState: manualState,
            quoteVersion: quote.quoteVersion,
          };
        }

        let seededSettlement = false;
        let duplicate = false;
        if (wantsSeed) {
          const seedId = `blob_seed_${bookingId}_${settledBlob}`;
          const existingSeed = await tx.ledgerEntry.findUnique({ where: { providerEventId: seedId } });
          if (existingSeed) {
            duplicate = true;
          } else {
            await tx.ledgerEntry.create({
              data: {
                bookingId,
                quoteId: quote.id,
                kind: 'settlement',
                amountCents: settledBlob,
                quoteVersion: quote.quoteVersion,
                providerEventId: seedId,
                providerObjectId: booking.paymentIntentId || booking.stripeCheckoutSessionId || null,
                actor: 'blob_import_seed',
              },
            });
            seededSettlement = true;
            if (settledBlob >= approvedCents && approvedCents > 0 && quote.status !== 'settled') {
              await tx.quote.update({
                where: { id: quote.id },
                data: { status: 'settled' },
              });
            }
          }
        }

        return {
          ok: true,
          bookingId,
          ensured: true,
          seededSettlement,
          duplicate,
          importBlocked: null,
          synchronizationBlocked: false,
          manualCollectionState: manualState,
          quoteVersion: quote.quoteVersion,
        };
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      });
    } catch (error) {
      decision = importFailureKind(error);
      if (error?.code === 'booking_not_ensured') {
        return { ok: false, error: 'booking_not_ensured', statusCode: 503 };
      }
      if ((decision === 'retry' || decision === 'reread') && attempt < IMPORT_TRANSACTION_ATTEMPTS) {
        continue;
      }
      if (decision === 'reread') {
        return { ok: false, error: 'financial_import_outcome_unknown', statusCode: 503 };
      }
      return { ok: false, error: 'financial_import_failed', statusCode: 503 };
    }
  }
  return {
    ok: false,
    error: decision === 'reread' ? 'financial_import_outcome_unknown' : 'financial_import_failed',
    statusCode: 503,
  };
}

/**
 * @param {object} booking Blob aggregate
 * @returns {Promise<{ ok: boolean, bookingId?: string, ensured?: boolean, seededSettlement?: boolean, importBlocked?: string|null, error?: string }>}
 */
async function ensureBookingFinancial(booking) {
  if (!prismaConfigured()) {
    return { ok: false, error: 'database_not_configured' };
  }
  const bookingId = String(booking?.id || booking?.bookingId || '').trim();
  if (!bookingId) return { ok: false, error: 'missing_booking_id' };

  const approvedCents = approvedCentsFromBlob(booking);
  const quoteVersion = quoteVersionFromBlob(booking);
  const settledBlob = settledCentsFromBlob(booking);
  const quoteItems = quoteItemsFromBooking(booking, approvedCents);

  try {
    await ensureBookingRow(booking, bookingId);
  } catch (err) {
    if (err?.code === 'booking_not_ensured') {
      return { ok: false, error: 'booking_not_ensured', statusCode: 503 };
    }
    throw err;
  }

  return importFinancialUnderLock({
    booking,
    bookingId,
    approvedCents,
    quoteVersion,
    settledBlob,
    quoteItems,
  });
}

/**
 * Read-only: a Postgres Booking row already exists. Never creates, seeds, or
 * backfills. Blob-only history must fail this check.
 */
async function hasAuthoritativePostgresFinancial(bookingId) {
  if (!prismaConfigured()) return false;
  const id = String(bookingId || '').trim();
  if (!id) return false;
  try {
    const row = await repo.getBooking(id);
    return !!(row && !row.isDraft);
  } catch {
    return false;
  }
}

module.exports = {
  IMPORT_TRANSACTION_ATTEMPTS,
  blocksFinancialImport,
  importFailureKind,
  ensureBookingFinancial,
  hasAuthoritativePostgresFinancial,
  approvedCentsFromBlob,
  settledCentsFromBlob,
  quoteVersionFromBlob,
  quoteItemsFromBooking,
};
