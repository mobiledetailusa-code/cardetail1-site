'use strict';

/**
 * Stage 4B-2 — pure storefront preview adapter (browser + node).
 *
 * Converts the sanitized owner-studio-catalog-preview payload into the
 * PRICING / LENGTH_PRICING shapes consumed by index.html.
 *
 * Contract:
 *  - integer cents are authoritative INSIDE the adapter; dollar values are
 *    derived only at the output (presentation) boundary — no floating persistence;
 *  - deterministic mapping via `legacyKey` (homepage id === catalog legacyKey);
 *  - unsupported / missing required mappings FAIL CLOSED (throw) — never a silent
 *    fallback that mixes draft and legacy values;
 *  - never mutates the input payload;
 *  - no booking, payment, DOM, fetch, or Stripe imports (pure function).
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.StorefrontPreviewAdapter = api;
}(typeof self !== 'undefined' ? self : this, function () {
  // Homepage booking categories, in render order.
  const HOMEPAGE_CATEGORIES = ['cars', 'boats', 'rvs', 'powersports'];
  const LENGTH_MODELS = ['per_foot', 'base_plus_per_foot'];

  function adapterError(code, message) {
    const e = new Error(message || code);
    e.code = code;
    e.adapter = true;
    return e;
  }

  function assertSafeCents(cents, ctx) {
    if (typeof cents !== 'number' || !Number.isInteger(cents) || cents < 0 || !Number.isSafeInteger(cents)) {
      throw adapterError('preview_bad_cents', 'invalid integer cents at ' + ctx);
    }
    return cents;
  }

  // Presentation boundary: integer cents -> dollars. Exact value, not rounded.
  function centsToDollars(cents) {
    return cents / 100;
  }

  function byDisplayOrder(a, b) {
    const da = Number.isInteger(a.displayOrder) ? a.displayOrder : 0;
    const db = Number.isInteger(b.displayOrder) ? b.displayOrder : 0;
    if (da !== db) return da - db;
    return String(a.legacyKey || a.slug || '').localeCompare(String(b.legacyKey || b.slug || ''));
  }

  function isActive(x) {
    return x && x.active !== false;
  }

  function addOnCategories(addon) {
    const compat = Array.isArray(addon.compatibility) ? addon.compatibility : [];
    const cats = new Set();
    for (const c of compat) {
      if (c && typeof c.category === 'string' && c.category) cats.add(c.category);
    }
    return cats;
  }

  /**
   * @param {object} payload  sanitized preview payload (preview === true required)
   * @returns {{ PRICING: object, LENGTH_PRICING: object, meta: object }}
   */
  function adaptStorefrontPreview(payload) {
    if (!payload || payload.preview !== true) {
      throw adapterError('preview_not_confirmed', 'payload.preview must be true');
    }
    const allPackages = Array.isArray(payload.packages) ? payload.packages : [];
    const allAddOns = Array.isArray(payload.addOns) ? payload.addOns : [];
    const allVcs = Array.isArray(payload.vehicleClasses) ? payload.vehicleClasses : [];

    const PRICING = {};
    const LENGTH_PRICING = {};

    for (const cat of HOMEPAGE_CATEGORIES) {
      const vcs = allVcs.filter((v) => v.category === cat && isActive(v)).slice().sort(byDisplayOrder);
      const pkgs = allPackages.filter((p) => p.category === cat && isActive(p)).slice().sort(byDisplayOrder);
      const addOns = allAddOns.filter((a) => isActive(a) && addOnCategories(a).has(cat)).slice().sort(byDisplayOrder);

      if (!vcs.length && !pkgs.length && !addOns.length) continue; // absent from draft — no legacy fallback

      // vehicleClassId -> tier legacyKey
      const vcTier = {};
      const tiers = {};
      for (const vc of vcs) {
        const tierKey = String(vc.legacyKey || '');
        if (!tierKey) throw adapterError('preview_unmapped_vehicle_class', 'vehicle class missing legacyKey: ' + vc.vehicleClassId);
        vcTier[vc.vehicleClassId] = tierKey;
        tiers[tierKey] = { label: vc.label || tierKey };
      }

      const outPackages = [];
      for (const p of pkgs) {
        const pkgId = String(p.legacyKey || '');
        if (!pkgId) throw adapterError('preview_unmapped_package', 'package missing legacyKey: ' + p.packageId);
        const feats = Array.isArray(p.features) ? p.features : [];
        outPackages.push({
          id: pkgId,
          name: p.name || pkgId,
          description: p.description || '',
          shortDescription: p.shortDescription || '',
          feats: feats.filter((f) => f && f.kind !== 'excluded').map((f) => String(f.label || '')),
          miss: feats.filter((f) => f && f.kind === 'excluded').map((f) => String(f.label || '')),
          popular: !!p.featured,
          displayOrder: Number.isInteger(p.displayOrder) ? p.displayOrder : 0,
        });

        for (const pr of (Array.isArray(p.prices) ? p.prices : [])) {
          // Flat matrix cell: tier x package -> dollars, matched by vehicle class.
          const tierKey = vcTier[pr.vehicleClassId];
          if (tierKey) {
            tiers[tierKey][pkgId] = centsToDollars(assertSafeCents(pr.amountCents, cat + '.' + tierKey + '.' + pkgId));
          }
          // Length pricing (boats/rvs/fleet-style per-foot rules).
          if (LENGTH_MODELS.indexOf(pr.priceModel) >= 0) {
            if (!LENGTH_PRICING[cat]) LENGTH_PRICING[cat] = { packages: {} };
            const rule = {};
            if (pr.perFootCents != null) rule.perFt = centsToDollars(assertSafeCents(pr.perFootCents, cat + '.' + pkgId + '.perFootCents'));
            if (pr.minCents != null) rule.min = centsToDollars(assertSafeCents(pr.minCents, cat + '.' + pkgId + '.minCents'));
            if (pr.baseCents != null) {
              rule.base = centsToDollars(assertSafeCents(pr.baseCents, cat + '.' + pkgId + '.baseCents'));
              rule.ratePerFoot = rule.perFt != null ? rule.perFt : 0;
            }
            LENGTH_PRICING[cat].packages[pkgId] = rule;
          }
        }
      }

      const outAddOns = [];
      for (const a of addOns) {
        const addonId = String(a.legacyKey || '');
        if (!addonId) throw adapterError('preview_unmapped_addon', 'add-on missing legacyKey: ' + a.addOnId);
        const prices = Array.isArray(a.prices) ? a.prices : [];
        const priceRow = prices.find((pr) => pr.category === cat) || prices[0];
        if (!priceRow) throw adapterError('preview_addon_no_price', 'add-on missing price: ' + a.addOnId);
        outAddOns.push({
          id: addonId,
          name: a.name || addonId,
          desc: a.description || '',
          price: centsToDollars(assertSafeCents(priceRow.amountCents, cat + '.addon.' + addonId)),
          qty: !!a.allowQuantity,
          displayOrder: Number.isInteger(a.displayOrder) ? a.displayOrder : 0,
        });
      }

      PRICING[cat] = { tiers, packages: outPackages, addons: outAddOns };
    }

    if (!Object.keys(PRICING).length) {
      throw adapterError('preview_empty_catalog', 'no mappable categories in preview draft');
    }

    return {
      PRICING,
      LENGTH_PRICING,
      meta: {
        draftVersion: payload.draftVersion != null ? payload.draftVersion : null,
        savedAt: payload.savedAt || null,
        banner: payload.banner || 'DRAFT PREVIEW — NOT PUBLISHED',
      },
    };
  }

  return {
    adaptStorefrontPreview,
    centsToDollars,
    HOMEPAGE_CATEGORIES,
  };
}));
