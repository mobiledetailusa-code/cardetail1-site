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
  const quoteItems = quoteItemsFromBooking(booking, approvedCents);

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
      items: quoteItems,
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
        items: quoteItems,
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
        items: quoteItems,
      });
    } else {
      quote = existing;
    }
  }

  // PR1 databases may already have Quote rows created before item snapshots
  // became mandatory. Backfill only when the quote has no children.
  await repo.ensureQuoteItems({ quoteId: quote.id, items: quoteItems });

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
  quoteItemsFromBooking,
};
