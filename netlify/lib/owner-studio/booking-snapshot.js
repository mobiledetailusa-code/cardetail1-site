'use strict';

const { SITE_ID, assertSiteId, isStableId } = require('./ids');
const { assertIntegerCents, assertCurrency } = require('./money');

/**
 * Build an immutable booking catalog snapshot (forward-looking contract).
 * Does not mutate booking aggregates.
 */
function buildBookingCatalogSnapshot(input) {
  const siteId = assertSiteId(input.siteId || SITE_ID);
  if (!isStableId(input.packageId)) {
    const err = new Error('invalid_package_id');
    err.code = 'invalid_package_id';
    throw err;
  }
  const currency = assertCurrency(input.currency || 'usd');
  const basePriceCents = assertIntegerCents(input.basePriceCents, 'basePriceCents');
  const approvedTotalCents = assertIntegerCents(input.approvedTotalCents, 'approvedTotalCents');
  const selectedAddOns = (input.selectedAddOns || []).map((a, i) => ({
    addOnId: a.addOnId,
    addOnRevisionId: a.addOnRevisionId || null,
    name: String(a.name || ''),
    unitPriceCents: assertIntegerCents(a.unitPriceCents, `selectedAddOns[${i}].unitPriceCents`),
    quantity: Number.isInteger(a.quantity) && a.quantity > 0 ? a.quantity : 1,
    lineTotalCents: assertIntegerCents(a.lineTotalCents, `selectedAddOns[${i}].lineTotalCents`),
  }));

  return Object.freeze({
    schemaVersion: 1,
    siteId,
    packageId: input.packageId,
    packageRevisionId: input.packageRevisionId || null,
    publishedCatalogReleaseId: input.publishedCatalogReleaseId || null,
    packageName: String(input.packageName || ''),
    packageShortLabel: String(input.packageShortLabel || input.packageName || ''),
    vehicleClassId: input.vehicleClassId || null,
    vehicleClassLabel: String(input.vehicleClassLabel || ''),
    basePriceCents,
    currency,
    selectedAddOns,
    discounts: input.discounts || [],
    adjustments: input.adjustments || [],
    approvedTotalCents,
    tax: {
      taxable: !!(input.tax && input.tax.taxable),
      taxCents: assertIntegerCents((input.tax && input.tax.taxCents) || 0, 'taxCents'),
      metadata: (input.tax && input.tax.metadata) || {},
    },
    payment: {
      currency,
      notes: String((input.payment && input.payment.notes) || ''),
    },
    createdAt: input.createdAt || new Date().toISOString(),
  });
}

/**
 * Resolve display/commercial fields for a booking without re-quoting live catalog.
 */
function resolveBookingCommercial(booking) {
  const snap = booking && booking.bookingCatalogSnapshot;
  if (snap && snap.schemaVersion === 1 && snap.packageId) {
    return {
      source: 'bookingCatalogSnapshot',
      packageId: snap.packageId,
      packageName: snap.packageName,
      approvedTotalCents: snap.approvedTotalCents,
      currency: snap.currency,
      releaseId: snap.publishedCatalogReleaseId,
    };
  }
  const ledger = booking?.ledger || {};
  return {
    source: 'legacy-aggregate',
    packageId: booking?.packageId || booking?.pkgId || null,
    packageName: booking?.package || booking?.packageName || booking?.service?.package || '',
    approvedTotalCents: Math.max(0, Math.round(Number(ledger.approvedCents) || 0)),
    currency: ledger.currency || 'usd',
    releaseId: null,
  };
}

module.exports = {
  buildBookingCatalogSnapshot,
  resolveBookingCommercial,
};
