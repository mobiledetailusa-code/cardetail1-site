/**
 * Ensure a Blob booking has a Postgres Booking + Quote row so
 * PaymentAuthorityService / FinancialProjection can operate.
 *
 * Does not delete Blobs. Seeds settlement ledger rows only when Blob already
 * shows settled money and Postgres has none (idempotent import of history).
 */

const { prismaConfigured } = require('../prisma');
const repo = require('./repositories');
const foundation = require('./foundation-services');

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

/**
 * @param {object} booking Blob aggregate
 * @returns {Promise<{ ok: boolean, bookingId?: string, ensured?: boolean, seededSettlement?: boolean, error?: string }>}
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

  let row = await repo.getBooking(bookingId);
  if (!row) {
    const status = booking.isDraft ? 'draft' : 'confirmed';
    await repo.createBooking({
      id: bookingId,
      status,
      isDraft: !!booking.isDraft,
    });
    row = await repo.getBooking(bookingId);
  }

  let quote = await repo.getLatestQuote(bookingId);
  if (!quote) {
    quote = await repo.createQuote({
      bookingId,
      quoteVersion,
      approvedCents,
      status: settledBlob > 0 && settledBlob >= approvedCents && approvedCents > 0 ? 'settled' : 'approved',
    });
  } else if (
    quote.quoteVersion === quoteVersion
    && quote.approvedCents !== approvedCents
    && quote.status !== 'settled'
  ) {
    // Unpaid quote may track Blob-approved total via a new version when Blob advanced.
    if (approvedCents !== quote.approvedCents && approvedCents > 0) {
      const { quote: next } = await repo.createAdjustmentQuote({
        bookingId,
        approvedCents,
        status: 'approved',
      });
      quote = next;
    }
  } else if (quote.quoteVersion < quoteVersion && approvedCents > 0) {
    const existing = await repo.getQuote({ bookingId, quoteVersion });
    if (!existing) {
      quote = await repo.createQuote({
        bookingId,
        quoteVersion,
        approvedCents,
        status: 'approved',
      });
    } else {
      quote = existing;
    }
  }

  let seededSettlement = false;
  const ledger = await repo.listLedgerEntries(bookingId);
  const hasSettlement = ledger.some((e) => e.kind === 'settlement');
  if (settledBlob > 0 && !hasSettlement) {
    const seedId = `blob_seed_${bookingId}_${settledBlob}`;
    await foundation.appendLedgerEntry({
      bookingId,
      kind: 'settlement',
      amountCents: settledBlob,
      quoteVersion: quote.quoteVersion,
      providerEventId: seedId,
      providerObjectId: booking.paymentIntentId || booking.stripeCheckoutSessionId || null,
      actor: 'blob_import_seed',
    });
    seededSettlement = true;
    if (settledBlob >= approvedCents && approvedCents > 0) {
      await repo.markQuoteStatus({
        bookingId,
        quoteVersion: quote.quoteVersion,
        status: 'settled',
      }).catch(() => {});
    }
  }

  return { ok: true, bookingId, ensured: true, seededSettlement, quoteVersion: quote.quoteVersion };
}

module.exports = {
  ensureBookingFinancial,
  approvedCentsFromBlob,
  settledCentsFromBlob,
  quoteVersionFromBlob,
};
