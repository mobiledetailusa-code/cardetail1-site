'use strict';

/**
 * Owner Studio — catalog parity against the legacy booking catalog.
 *
 * The Stage 6 release gate requires parity sign-off before
 * PUBLIC_CONTENT_SOURCE=owner-studio. Until this existed there was no way to answer
 * "would publishing this draft change what customers are charged?" except by eye —
 * and on 2026-08-12 the staging draft had drifted to 0 of 90 prices matching, with
 * Premium car packages sitting at $1–$2 against a real $385–$525. Nobody noticed,
 * because nothing was looking.
 *
 * Pure: takes an already-adapted catalog (PRICING shape) and the legacy PRICING, and
 * reports every difference. No IO, no database.
 */

const { HOMEPAGE_CATEGORIES } = require('./storefront-preview-adapter');

/**
 * Compare an adapted catalog against the legacy one.
 *
 * Scoped to HOMEPAGE_CATEGORIES: the adapter deliberately does not emit `fleet`,
 * which has its own page and its own pricing surface. Comparing it here would
 * report a permanent false difference.
 *
 * @param {object} adapted  PRICING shape from adaptStorefrontPreview
 * @param {object} legacy   PRICING from booking-price-catalog
 * @returns {{ok: boolean, compared: number, differences: Array}}
 */
function compareCatalogToLegacy(adapted, legacy) {
  const differences = [];
  let compared = 0;

  for (const cat of HOMEPAGE_CATEGORIES) {
    const legacyCat = legacy && legacy[cat];
    const draftCat = adapted && adapted[cat];
    if (!legacyCat) continue;
    if (!draftCat) {
      differences.push({ kind: 'category_missing', category: cat });
      continue;
    }

    for (const [tier, row] of Object.entries(legacyCat.tiers || {})) {
      const draftTier = draftCat.tiers && draftCat.tiers[tier];
      if (!draftTier) {
        differences.push({ kind: 'tier_missing', category: cat, tier });
        continue;
      }
      for (const [packageId, price] of Object.entries(row)) {
        // A 0 in the legacy catalog is the "unavailable" sentinel, not a price,
        // and `label` is not a price at all.
        if (typeof price !== 'number' || price === 0) continue;
        compared += 1;
        const got = draftTier[packageId];
        if (got == null) {
          differences.push({ kind: 'price_missing', category: cat, tier, packageId, legacy: price });
        } else if (got !== price) {
          differences.push({ kind: 'price_differs', category: cat, tier, packageId, legacy: price, draft: got });
        }
      }
    }

    // Add-ons are per-category lists keyed by legacy id.
    const legacyAddOns = new Map((legacyCat.addons || []).map((a) => [a.id, a.price]));
    const draftAddOns = new Map((draftCat.addons || []).map((a) => [a.id, a.price]));
    for (const [id, price] of legacyAddOns) {
      if (typeof price !== 'number' || price === 0) continue;
      compared += 1;
      const got = draftAddOns.get(id);
      if (got == null) differences.push({ kind: 'addon_missing', category: cat, addOnId: id, legacy: price });
      else if (got !== price) differences.push({ kind: 'addon_differs', category: cat, addOnId: id, legacy: price, draft: got });
    }
    for (const [id] of draftAddOns) {
      if (!legacyAddOns.has(id)) differences.push({ kind: 'addon_unexpected', category: cat, addOnId: id });
    }
  }

  return { ok: differences.length === 0, compared, differences };
}

/** One line per difference, for a CLI or a test failure message. */
function formatParityDifferences(differences, limit = 20) {
  return (differences || []).slice(0, limit).map((d) => {
    const where = [d.category, d.tier, d.packageId || d.addOnId].filter(Boolean).join('.');
    if (d.kind === 'price_differs' || d.kind === 'addon_differs') return `${where}: legacy $${d.legacy} -> draft $${d.draft}`;
    if (d.kind === 'price_missing' || d.kind === 'addon_missing') return `${where}: legacy $${d.legacy} -> missing from draft`;
    return `${where}: ${d.kind}`;
  });
}

module.exports = {
  compareCatalogToLegacy,
  formatParityDifferences,
};
