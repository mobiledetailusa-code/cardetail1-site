'use strict';

/**
 * Stage 4B-1 — sanitize OsCatalogDraft into a customer-storefront preview catalog.
 * Presentation-only: no booking, payment processors, ledger, or publication side effects.
 */

const { SITE_ID } = require('./ids');
const { assertIntegerCents, assertCurrency, rejectFloatingMoney } = require('./money');
const { validateCompleteCatalogDraft } = require('./schemas');

function previewError(code, message, statusCode = 400) {
  const err = new Error(message || code);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

function sortByDisplayOrder(a, b) {
  const da = Number.isInteger(a.displayOrder) ? a.displayOrder : 0;
  const db = Number.isInteger(b.displayOrder) ? b.displayOrder : 0;
  if (da !== db) return da - db;
  const ia = String(a.packageId || a.addOnId || a.vehicleClassId || '');
  const ib = String(b.packageId || b.addOnId || b.vehicleClassId || '');
  return ia.localeCompare(ib);
}

function sanitizePackagePrice(price, packageId) {
  rejectFloatingMoney(price.amountCents);
  const amountCents = assertIntegerCents(price.amountCents, 'amountCents');
  const currency = assertCurrency(price.currency || 'usd');
  const priceModel = String(price.priceModel || 'flat');
  if (!['flat', 'per_foot', 'base_plus_per_foot'].includes(priceModel)) {
    throw previewError('invalid_price_model', 'invalid_price_model');
  }
  const out = {
    vehicleClassId: price.vehicleClassId || null,
    currency,
    amountCents,
    priceModel,
  };
  if (price.perFootCents != null) {
    rejectFloatingMoney(price.perFootCents);
    out.perFootCents = assertIntegerCents(price.perFootCents, 'perFootCents');
  }
  if (price.minCents != null) {
    rejectFloatingMoney(price.minCents);
    out.minCents = assertIntegerCents(price.minCents, 'minCents');
  }
  if (price.baseCents != null) {
    rejectFloatingMoney(price.baseCents);
    out.baseCents = assertIntegerCents(price.baseCents, 'baseCents');
  }
  // packageId is retained on the parent only; do not echo DB-ish extras
  void packageId;
  return out;
}

function sanitizeFeature(feature, index) {
  const kind = feature.kind === 'excluded' ? 'excluded' : 'included';
  return {
    kind,
    label: String(feature.label || '').slice(0, 200),
    sortOrder: Number.isInteger(feature.sortOrder) ? feature.sortOrder : index,
  };
}

function sanitizePackage(pkg) {
  const features = Array.isArray(pkg.features)
    ? pkg.features.map(sanitizeFeature).sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label))
    : [];
  const prices = Array.isArray(pkg.prices)
    ? pkg.prices.map((p) => sanitizePackagePrice(p, pkg.packageId))
    : [];
  return {
    packageId: pkg.packageId,
    legacyKey: pkg.legacyKey || '',
    slug: pkg.slug,
    name: pkg.name,
    description: pkg.description || '',
    shortDescription: pkg.shortDescription || '',
    category: pkg.category,
    active: pkg.active !== false,
    featured: !!pkg.featured,
    displayOrder: Number.isInteger(pkg.displayOrder) ? pkg.displayOrder : 0,
    durationMinutes: pkg.durationMinutes == null ? null : pkg.durationMinutes,
    features,
    prices,
    compatibleVehicleClassIds: Array.isArray(pkg.compatibleVehicleClassIds)
      ? pkg.compatibleVehicleClassIds.slice()
      : [],
    compatibleAddOnIds: Array.isArray(pkg.compatibleAddOnIds) ? pkg.compatibleAddOnIds.slice() : [],
  };
}

function sanitizeAddOn(addon) {
  const prices = Array.isArray(addon.prices)
    ? addon.prices.map((p) => {
      rejectFloatingMoney(p.amountCents);
      return {
        category: String(p.category || ''),
        currency: assertCurrency(p.currency || 'usd'),
        amountCents: assertIntegerCents(p.amountCents, 'amountCents'),
      };
    })
    : [];
  const compatibility = Array.isArray(addon.compatibility)
    ? addon.compatibility.map((c) => {
      const row = {};
      if (c.category) row.category = String(c.category);
      if (c.packageId) row.packageId = String(c.packageId);
      return row;
    })
    : [];
  return {
    addOnId: addon.addOnId,
    legacyKey: addon.legacyKey || '',
    slug: addon.slug,
    name: addon.name,
    description: addon.description || '',
    active: addon.active !== false,
    allowQuantity: !!addon.allowQuantity,
    displayOrder: Number.isInteger(addon.displayOrder) ? addon.displayOrder : 0,
    prices,
    compatibility,
  };
}

function sanitizeVehicleClass(vc) {
  return {
    vehicleClassId: vc.vehicleClassId,
    label: vc.label,
    category: vc.category,
    legacyKey: vc.legacyKey || '',
    active: vc.active !== false,
    displayOrder: Number.isInteger(vc.displayOrder) ? vc.displayOrder : 0,
  };
}

/**
 * Build a sanitized storefront preview catalog from an OsCatalogDraft API shape
 * (or raw payload). Throws previewError on missing/invalid money or structure.
 *
 * @param {object|null} draft
 * @param {{ includeInactive?: boolean }} [options]
 */
function buildStorefrontPreviewCatalog(draft, options = {}) {
  if (!draft) {
    throw previewError('draft_not_found', 'Catalog draft not found', 404);
  }

  const includeInactive = options.includeInactive === true;

  let validated;
  try {
    validated = validateCompleteCatalogDraft({
      ...draft,
      siteId: draft.siteId || SITE_ID,
    });
  } catch (err) {
    const wrapped = previewError(
      err.code || 'invalid_catalog_draft',
      String(err.message || 'invalid_catalog_draft').slice(0, 200),
      400
    );
    wrapped.cause = err;
    throw wrapped;
  }

  const packages = (validated.packages || [])
    .filter((p) => includeInactive || p.active !== false)
    .map(sanitizePackage)
    .sort(sortByDisplayOrder);

  const addOns = (validated.addOns || [])
    .filter((a) => includeInactive || a.active !== false)
    .map(sanitizeAddOn)
    .sort(sortByDisplayOrder);

  const vehicleClasses = (validated.vehicleClasses || [])
    .filter((v) => includeInactive || v.active !== false)
    .map(sanitizeVehicleClass)
    .sort(sortByDisplayOrder);

  // Re-assert every exposed money field is integer cents (fail closed).
  for (const pkg of packages) {
    for (const price of pkg.prices) {
      assertIntegerCents(price.amountCents, 'amountCents');
      if (price.perFootCents != null) assertIntegerCents(price.perFootCents, 'perFootCents');
      if (price.minCents != null) assertIntegerCents(price.minCents, 'minCents');
      if (price.baseCents != null) assertIntegerCents(price.baseCents, 'baseCents');
    }
  }
  for (const addon of addOns) {
    for (const price of addon.prices) {
      assertIntegerCents(price.amountCents, 'amountCents');
    }
  }

  const conflicts = Array.isArray(draft.priceConflicts) ? draft.priceConflicts : (validated.priceConflicts || []);
  const unresolvedCount = conflicts.filter((c) => c && c.status === 'unresolved').length;

  const draftVersion = Number(draft.version != null ? draft.version : draft.draftVersion) || 1;
  const savedAt = draft.lastSavedAt || draft.updatedAt || null;

  return {
    ok: true,
    preview: true,
    siteId: SITE_ID,
    draftVersion,
    savedAt,
    banner: 'DRAFT PREVIEW — NOT PUBLISHED',
    packages,
    addOns,
    vehicleClasses,
    priceConflicts: {
      count: unresolvedCount,
    },
  };
}

module.exports = {
  buildStorefrontPreviewCatalog,
  previewError,
  sanitizePackage,
  sanitizeAddOn,
};
