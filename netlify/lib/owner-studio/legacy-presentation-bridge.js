'use strict';

// UMD: required by Node tests, and loaded as a plain <script> by index.html — the
// same pattern storefront-preview-adapter.js uses.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.OwnerStudioLegacyBridge = api;
}(typeof self !== 'undefined' ? self : this, function () {

/**
 * TEMPORARY COMPATIBILITY LAYER — legacy presentation metadata bridge.
 *
 * Owner Studio is authoritative for everything it models: package identity, prices,
 * the tier matrix, availability, ordering, `popular`, names and descriptions. This
 * bridge NEVER supplies any of those, and never supplies money of any kind — no
 * package price, tier price, add-on price, discount, total or Stripe amount.
 *
 * What it does supply is the merchandising metadata the public renderer reads but
 * the Owner Studio catalog does not yet model:
 *
 *   note   card subtitle          index.html: (p.note || 'price set by vehicle size/type')
 *   tag    card badge line        index.html: <div class="pkg-tag">${p.tag}</div>
 *   icon   package icon           index.html: ST.pkg.icon || '🚗'
 *   dur    duration line          index.html: <div class="pkg-time">⏱ ${p.dur}</div>
 *
 * and two fields that are NOT decorative and must not be defaulted blindly:
 *
 *   scope        filters which add-ons a package offers (pkgScope vs addon scope)
 *   ext / int    feed the included-features text that suppresses an add-on the
 *                package already contains — the double-charge guard
 *
 * Removal condition: delete this module once Owner Studio (Stage 5 content editing,
 * or explicit catalog fields) becomes authoritative for merchandising metadata and
 * for package↔add-on eligibility. `compatibleAddOnIds` already exists on the Owner
 * Studio package and is consumed by nothing; wiring it is the real replacement for
 * `scope`.
 *
 * Matching is by the stable legacy package id only. Never by array position,
 * display order, name similarity or price — a mismatch must fail loudly rather than
 * dress one package in another's metadata.
 */

const PRESENTATION_FIELDS = ['note', 'tag', 'icon', 'dur'];
const BEHAVIOUR_FIELDS = ['scope', 'ext', 'int'];

function indexLegacyPackages(legacyCategory) {
  const map = new Map();
  const duplicates = new Set();
  for (const pkg of (legacyCategory && legacyCategory.packages) || []) {
    if (!pkg || !pkg.id) continue;
    if (map.has(pkg.id)) duplicates.add(pkg.id);
    map.set(pkg.id, pkg);
  }
  // An ambiguous id cannot be matched safely, so it is matched not at all.
  for (const id of duplicates) map.delete(id);
  return { map, duplicates: [...duplicates] };
}

/**
 * Merge legacy merchandising metadata onto adapted packages of one category.
 *
 * Returns the merged packages plus a report. The report is the point: a caller must
 * be able to tell the difference between "the legacy catalog genuinely has no note
 * for this package" and "this package lost its note because nothing matched".
 *
 * @param {Array}  adaptedPackages  packages from adaptStorefrontPreview (authoritative)
 * @param {object} legacyCategory   the legacy PRICING[category] object
 */
function bridgeCategoryPackages(adaptedPackages, legacyCategory) {
  const { map, duplicates } = indexLegacyPackages(legacyCategory);
  const unmatched = [];
  const missingBehaviour = [];

  const packages = (adaptedPackages || []).map((pkg) => {
    const legacy = map.get(pkg.id);
    if (!legacy) {
      unmatched.push(pkg.id);
      // No safe source. Leave the fields absent so the renderer's own fallback runs
      // and the gap is visible, rather than borrowing another package's metadata.
      return { ...pkg };
    }
    const merged = { ...pkg };
    for (const field of PRESENTATION_FIELDS) {
      if (legacy[field] != null) merged[field] = legacy[field];
    }
    for (const field of BEHAVIOUR_FIELDS) {
      if (legacy[field] != null) merged[field] = legacy[field];
    }
    // scope decides which add-ons are offered; ext/int feed the double-charge guard.
    // Their absence is a functional gap, not a cosmetic one.
    if (legacy.scope == null) missingBehaviour.push({ packageId: pkg.id, field: 'scope' });
    return merged;
  });

  return { packages, unmatched, duplicates, missingBehaviour };
}

/**
 * Bridge every homepage category. Money and ordering are untouched: only the fields
 * listed above are ever written, and only onto packages Owner Studio already emitted.
 */
function bridgePresentationMetadata(adaptedPricing, legacyPricing, categories) {
  const cats = categories || Object.keys(adaptedPricing || {});
  const out = {};
  const report = { unmatched: [], duplicates: [], missingBehaviour: [], matched: 0 };

  for (const cat of cats) {
    const adaptedCat = (adaptedPricing || {})[cat];
    if (!adaptedCat) continue;
    const result = bridgeCategoryPackages(adaptedCat.packages, (legacyPricing || {})[cat]);
    out[cat] = { ...adaptedCat, packages: result.packages };
    report.matched += result.packages.length - result.unmatched.length;
    for (const id of result.unmatched) report.unmatched.push({ category: cat, packageId: id });
    for (const id of result.duplicates) report.duplicates.push({ category: cat, packageId: id });
    for (const m of result.missingBehaviour) report.missingBehaviour.push({ category: cat, ...m });
  }

  // Categories the bridge did not touch are passed through unchanged.
  for (const cat of Object.keys(adaptedPricing || {})) {
    if (!(cat in out)) out[cat] = adaptedPricing[cat];
  }

  report.ok = report.unmatched.length === 0 && report.duplicates.length === 0;
  return { pricing: out, report };
}

  return {
    bridgePresentationMetadata: bridgePresentationMetadata,
    bridgeCategoryPackages: bridgeCategoryPackages,
    PRESENTATION_FIELDS: PRESENTATION_FIELDS,
    BEHAVIOUR_FIELDS: BEHAVIOUR_FIELDS,
  };
}));
