'use strict';
/**
 * Cardetail1 — category-aware booking vehicle summary helpers.
 *
 * Owns two protections against cross-category classification leaks:
 *  1) clearCategoryExclusiveFields — drop prior-category-only vehicle metadata
 *     when the customer switches cars ↔ rvs ↔ boats ↔ powersports.
 *  2) formatAddonHeaderSummary / categoryTierLabel — never append cars or
 *     powersports classification labels onto RV/boat package summaries.
 *
 * Pricing remains category-local (cars tierKey / RV length / boat type+length /
 * powersports machine tier). These helpers do not read or write prices.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CD1BookingVehicleSummary = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var CLASS_SUFFIX_CATS = { cars: true, powersports: true };

  /**
   * Clear fields that belong only to the previous category / vehicle selection.
   * Preserves intentionally reusable booking state (contact, ZIP, pay method).
   * Specialty subtype fields are kept only when staying in that specialty cat.
   */
  function clearCategoryExclusiveFields(st, nextCat) {
    if (!st) return st;
    st.displayLabel = '';
    st.classNeedsConfirm = false;
    st.make = '';
    st.model = '';
    st.year = '';
    if (nextCat !== 'rvs') {
      st.rvType = '';
      st.rvLiving = '';
    }
    if (nextCat !== 'boats') {
      st.boatType = '';
    }
    return st;
  }

  /** Cars / powersports may show classification; RV / boat / fleet must not. */
  function categoryClassSuffix(st) {
    if (!st) return '';
    if (!CLASS_SUFFIX_CATS[st.cat]) return '';
    return String(st.displayLabel || (st.tier && st.tier.label) || '').trim();
  }

  /**
   * Line beneath the package name on the add-on / package summary header.
   * RV & boat vehicleLabel already encodes subtype/length — return as-is.
   */
  function formatAddonHeaderSummary(st) {
    var base = String((st && st.vehicleLabel) || '').trim();
    var suffix = categoryClassSuffix(st);
    if (!suffix) return base;
    if (base && base.indexOf(suffix) !== -1) return base;
    return base ? base + ' · ' + suffix : suffix;
  }

  /**
   * Cart / submit tierLabel metadata.
   * Specialty categories use the local tier label only (never a stale
   * cars/powersports displayLabel).
   */
  function categoryTierLabel(st) {
    if (!st) return '';
    if (CLASS_SUFFIX_CATS[st.cat]) {
      return String(st.displayLabel || (st.tier && st.tier.label) || '').trim();
    }
    return String((st.tier && st.tier.label) || '').trim();
  }

  return {
    clearCategoryExclusiveFields: clearCategoryExclusiveFields,
    categoryClassSuffix: categoryClassSuffix,
    formatAddonHeaderSummary: formatAddonHeaderSummary,
    categoryTierLabel: categoryTierLabel,
  };
});
