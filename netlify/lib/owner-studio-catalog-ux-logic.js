'use strict';

/**
 * Owner Studio — Catalog Manager UX logic (pure, DOM-free, framework-free).
 *
 * Loaded in the browser as `window.CatalogUxLogic` (via `<script src>`, same pattern
 * as admin-session-client.js) AND required directly by Node tests. It contains only
 * deterministic helpers — no DOM, no fetch, no persistence, no catalog authority.
 * The server (netlify/lib/owner-studio/*) remains the single catalog authority; this
 * module never validates, stores, or mutates the authoritative draft.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.CatalogUxLogic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // -- Money boundary ---------------------------------------------------------
  // The server enforces integer / finite / non-negative cents
  // (netlify/lib/owner-studio/money.js) and imposes no commercial upper bound.
  // This UI parser therefore adds no business maximum either — only the technical
  // Number.isSafeInteger representation limit so cents never lose precision.
  const MONEY_MIN_CENTS = 0;

  // Whole dollars, optionally 1–2 decimal places. No sign, no exponent, no thousands
  // separators, no whitespace (trimmed before test). This is what makes the parser
  // strict: a leading '-' is NOT matched (so it can never be stripped and flipped
  // positive), 'Infinity'/'NaN'/alphabetic text never match, and a third decimal
  // place is rejected rather than silently truncated.
  const PRICE_RE = /^\d+(?:\.\d{1,2})?$/;

  /**
   * Strict USD → integer cents conversion at the UI boundary. Returns a result
   * object and NEVER throws. On failure `cents` is absent so a caller can never
   * accidentally persist a fallback zero.
   *
   * Accepts: "0", "5", "5.5", "5.50", "125", "125.99".
   * Rejects: "" (required), "-5" (negative — never flipped positive), "abc",
   *          "5abc", "5.005" (>2 dp), "Infinity", "NaN", "1e3", "1,250",
   *          currency symbols, and values whose cents are not a safe integer.
   *
   * @param {string|number} raw
   * @param {{allowZero?: boolean}} [opts] allowZero defaults true; pass false where
   *        the catalog rules do not permit a free item.
   * @returns {{ok: true, cents: number} | {ok: false, error: string}}
   */
  function parsePriceToCents(raw, opts) {
    const options = opts || {};
    const allowZero = options.allowZero !== false;
    if (raw == null) return { ok: false, error: 'required' };
    const s = String(raw).trim();
    if (s === '') return { ok: false, error: 'required' };
    if (!PRICE_RE.test(s)) return { ok: false, error: 'invalid' };
    // Digit-string cents: append fractional digits (pad to 2) — never multiply a
    // float by 100 (avoids 19.99 * 100 drift and commercial UI caps).
    const dot = s.indexOf('.');
    const centsDigits = dot === -1
      ? s + '00'
      : s.slice(0, dot) + (s.slice(dot + 1) + '00').slice(0, 2);
    const cents = Number(centsDigits);
    if (!Number.isSafeInteger(cents)) return { ok: false, error: 'out_of_range' };
    if (cents < MONEY_MIN_CENTS) return { ok: false, error: 'negative' };
    if (!allowZero && cents === 0) return { ok: false, error: 'required' };
    return { ok: true, cents: cents };
  }

  function centsToUsd(cents) {
    return (Number(cents || 0) / 100).toFixed(2);
  }

  // Human-readable, field-level message for each parser error code.
  function priceErrorMessage(code) {
    switch (code) {
      case 'required': return 'Enter a price.';
      case 'negative': return 'Price cannot be negative.';
      case 'out_of_range': return 'Amount exceeds the safe numeric representation limit.';
      case 'invalid':
      default: return 'Enter a valid dollar amount (up to 2 decimals).';
    }
  }

  // -- Safe rendering ---------------------------------------------------------
  // Identical semantics to the page's inline escapeHtml; exported so a hostile-string
  // regression test can prove catalog-controlled values render inert.
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // -- Deterministic canonical serialization ---------------------------------
  function sortValue(v) {
    if (Array.isArray(v)) return v.map(sortValue);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = sortValue(v[k]);
      return out;
    }
    return v;
  }
  function stableStringify(v) { return JSON.stringify(sortValue(v)); }
  function byJson(a, b) {
    const sa = stableStringify(a);
    const sb = stableStringify(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }
  function byKey(key) {
    return function (a, b) {
      const ka = String(a[key] == null ? '' : a[key]);
      const kb = String(b[key] == null ? '' : b[key]);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    };
  }

  // -- Editable projections (dirty detection) --------------------------------
  // These whitelist ONLY editable catalog data. Server-managed metadata
  // (draftId / version / updatedAt / lastSaved*) and transient UI (search text,
  // expanded accordion set, selected tab, filters) are excluded by construction, so
  // neither a version bump nor a UI interaction can produce dirty state. Entity arrays
  // and nested price/compatibility arrays are order-normalized so payload array order
  // is never mistaken for an edit — while real per-item fields like displayOrder are.
  function projPackage(p) {
    return {
      packageId: p.packageId,
      category: p.category,
      name: p.name,
      slug: p.slug,
      shortDescription: p.shortDescription || '',
      description: p.description || '',
      active: !!p.active,
      featured: !!p.featured,
      displayOrder: Number(p.displayOrder) || 0,
      features: (p.features || []).map(function (f) {
        return { kind: f.kind, label: f.label, sortOrder: Number(f.sortOrder) || 0 };
      }),
      prices: (p.prices || []).map(function (pr) {
        return {
          packageId: pr.packageId,
          vehicleClassId: pr.vehicleClassId || null,
          currency: pr.currency,
          amountCents: Number(pr.amountCents),
          priceModel: pr.priceModel,
        };
      }).sort(byJson),
      compatibleVehicleClassIds: (p.compatibleVehicleClassIds || []).slice().sort(),
      compatibleAddOnIds: (p.compatibleAddOnIds || []).slice().sort(),
    };
  }
  function projAddOn(a) {
    return {
      addOnId: a.addOnId,
      name: a.name,
      slug: a.slug || '',
      description: a.description || '',
      active: a.active !== false,
      allowQuantity: !!a.allowQuantity,
      displayOrder: Number(a.displayOrder) || 0,
      prices: (a.prices || []).map(function (pr) {
        return { category: pr.category || null, currency: pr.currency, amountCents: Number(pr.amountCents) };
      }).sort(byJson),
      compatibility: (a.compatibility || []).map(function (c) {
        return { category: c.category || null };
      }).sort(byJson),
    };
  }
  function projVc(v) {
    return {
      vehicleClassId: v.vehicleClassId,
      label: v.label,
      category: v.category,
      active: v.active !== false,
      displayOrder: Number(v.displayOrder) || 0,
    };
  }
  function projConflict(c) {
    return { conflictId: c.conflictId, status: c.status, resolution: c.resolution || null };
  }

  /** Deterministic signature string of ONLY the editable catalog model. */
  function editableCatalogSignature(draft) {
    const d = draft || {};
    return stableStringify({
      packages: (d.packages || []).map(projPackage).sort(byKey('packageId')),
      addOns: (d.addOns || []).map(projAddOn).sort(byKey('addOnId')),
      vehicleClasses: (d.vehicleClasses || []).map(projVc).sort(byKey('vehicleClassId')),
      priceConflicts: (d.priceConflicts || []).map(projConflict).sort(byKey('conflictId')),
    });
  }

  /**
   * Meaningful catalog-data difference between the current draft and a canonical
   * baseline. Pure comparison — mutates neither argument. Reverting every edited value
   * back to its baseline value returns false (clean) by construction.
   */
  function isCatalogDirty(draft, baseline) {
    return editableCatalogSignature(draft) !== editableCatalogSignature(baseline);
  }

  // -- Package search parity --------------------------------------------------
  /**
   * Client-side package match. Searches name, id, slug, description, short
   * description, category, and (via ctx.vehicleClasses) compatible vehicle-class
   * label + category. Empty query matches everything. Never mutates anything.
   */
  function packageMatchesQuery(pkg, q, ctx) {
    const query = String(q == null ? '' : q).trim().toLowerCase();
    if (!query) return true;
    const context = ctx || {};
    const vcById = {};
    for (const vc of (context.vehicleClasses || [])) vcById[vc.vehicleClassId] = vc;
    const parts = [
      pkg.name, pkg.packageId, pkg.slug, pkg.description, pkg.shortDescription, pkg.category,
    ];
    for (const id of (pkg.compatibleVehicleClassIds || [])) {
      const vc = vcById[id];
      parts.push(vc ? (vc.label + ' ' + (vc.category || '')) : id);
    }
    return parts.filter(Boolean).join(' ').toLowerCase().includes(query);
  }

  // -- Canonical response validation -----------------------------------------
  /**
   * True only for a well-formed catalog draft payload (GET draft / save / restore /
   * reload). A malformed success body must be treated as failure, never as an empty
   * catalog and never as a successful save.
   */
  function isCanonicalDraftResponse(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    const d = data.draft;
    if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
    if (!Array.isArray(d.packages) || !Array.isArray(d.addOns) || !Array.isArray(d.vehicleClasses)) return false;
    if (typeof d.version !== 'number' || !Number.isFinite(d.version)) return false;
    return true;
  }

  // -- Explicit page-state model ---------------------------------------------
  // A minimal, closed set of states — not a generic state-management framework.
  const PAGE_STATES = Object.freeze([
    'loading',
    'ready-clean',
    'ready-dirty',
    'saving',
    'saved',
    'validation-error',
    'authentication-error',
    'authorization-error',
    'network-error',
    'catalog-unavailable',
    'stale-conflict',
    'rate-limit',
  ]);

  /**
   * The Save button is enabled ONLY while dirty, locally valid, not saving, and in an
   * editable state. loading/saving/auth states hard-disable it; note the true
   * "catalog-unavailable at load" case is already covered by !dirty (no local edits),
   * so a transient error that still holds a valid dirty draft keeps retry available.
   */
  function isSaveEnabled(model) {
    const m = model || {};
    if (m.saving) return false;
    if (!m.dirty) return false;
    if (m.valid === false) return false;
    if (m.state === 'loading'
      || m.state === 'saving'
      || m.state === 'authentication-error'
      || m.state === 'authorization-error') return false;
    return true;
  }

  /** Guards against contradictory visual states (Saved-while-dirty, Saving-with-save-enabled, etc.). */
  function isContradictoryModel(model) {
    const m = model || {};
    if (m.state === 'saved' && m.dirty) return true;
    if (m.state === 'saving' && isSaveEnabled(m)) return true;
    if (m.state === 'ready-clean' && m.dirty) return true;
    if (m.state === 'ready-dirty' && !m.dirty) return true;
    return false;
  }

  // -- Add-on edit buffer (Apply/Cancel gate; never mutates draft on keystroke) --
  /**
   * Deep-clone editable add-on fields into a local buffer. Price rows keep both
   * the last-known integer cents and a raw USD string for the input. Typing must
   * update only this buffer — never the canonical draft — until Apply succeeds.
   */
  function cloneAddonEditBuffer(addon) {
    const a = addon || {};
    return {
      addOnId: a.addOnId,
      name: String(a.name == null ? '' : a.name),
      description: String(a.description == null ? '' : a.description),
      displayOrder: Number(a.displayOrder) || 0,
      active: a.active !== false,
      prices: (a.prices || []).map(function (pr) {
        const cents = Number(pr.amountCents);
        return {
          category: pr.category || null,
          currency: pr.currency || 'usd',
          amountCents: Number.isFinite(cents) ? cents : 0,
          rawUsd: centsToUsd(Number.isFinite(cents) ? cents : 0),
        };
      }),
    };
  }

  /**
   * Validate every price rawUsd on a buffer. Does not mutate the draft.
   * @returns {{ok: true, prices: Array} | {ok: false, errors: Array<{index:number, error:string}>}}
   */
  function validateAddonBufferPrices(buffer, opts) {
    const options = opts || {};
    const allowZero = options.allowZero !== false;
    const buf = buffer || {};
    const prices = Array.isArray(buf.prices) ? buf.prices : [];
    const errors = [];
    const validated = [];
    for (let i = 0; i < prices.length; i++) {
      const row = prices[i] || {};
      const parsed = parsePriceToCents(row.rawUsd, { allowZero: allowZero });
      if (!parsed.ok) {
        errors.push({ index: i, error: parsed.error });
        continue;
      }
      validated.push({
        category: row.category || null,
        currency: row.currency || 'usd',
        amountCents: parsed.cents,
      });
    }
    if (errors.length) return { ok: false, errors: errors };
    return { ok: true, prices: validated };
  }

  /**
   * Apply a validated buffer onto the matching add-on inside `draft`. Mutates
   * that one add-on only. Returns false when the add-on is missing or prices
   * fail validation (draft untouched on failure).
   */
  function applyAddonBufferToDraft(draft, buffer, opts) {
    if (!draft || !Array.isArray(draft.addOns) || !buffer || !buffer.addOnId) return { ok: false, error: 'missing' };
    const target = draft.addOns.find(function (a) { return a && a.addOnId === buffer.addOnId; });
    if (!target) return { ok: false, error: 'missing_addon' };
    const checked = validateAddonBufferPrices(buffer, opts);
    if (!checked.ok) return { ok: false, error: 'invalid_price', errors: checked.errors };
    target.name = String(buffer.name == null ? '' : buffer.name);
    target.description = String(buffer.description == null ? '' : buffer.description);
    target.displayOrder = Number(buffer.displayOrder) || 0;
    target.active = buffer.active !== false;
    target.prices = checked.prices.map(function (pr) {
      return { category: pr.category, currency: pr.currency, amountCents: pr.amountCents };
    });
    return { ok: true, addOn: target };
  }

  /** Collapsed-row summary cents (first price), or null when no price rows. */
  function addonSummaryAmountCents(addon) {
    const prices = addon && Array.isArray(addon.prices) ? addon.prices : [];
    if (!prices.length) return null;
    const cents = Number(prices[0].amountCents);
    return Number.isFinite(cents) ? cents : null;
  }

  /**
   * True when the local edit buffer differs from the canonical add-on (unapplied
   * keystrokes, including invalid price text that cannot yet commit).
   * Does not mutate either side.
   */
  function addonBufferHasUnappliedChanges(buffer, addon) {
    if (!buffer || !addon) return false;
    if (String(buffer.name == null ? '' : buffer.name) !== String(addon.name == null ? '' : addon.name)) return true;
    if (String(buffer.description == null ? '' : buffer.description) !== String(addon.description == null ? '' : addon.description)) return true;
    if ((Number(buffer.displayOrder) || 0) !== (Number(addon.displayOrder) || 0)) return true;
    if ((buffer.active !== false) !== (addon.active !== false)) return true;
    const bPrices = Array.isArray(buffer.prices) ? buffer.prices : [];
    const aPrices = Array.isArray(addon.prices) ? addon.prices : [];
    if (bPrices.length !== aPrices.length) return true;
    for (let i = 0; i < bPrices.length; i++) {
      const row = bPrices[i] || {};
      const canonical = aPrices[i] || {};
      if ((row.category || null) !== (canonical.category || null)) return true;
      if ((row.currency || 'usd') !== (canonical.currency || 'usd')) return true;
      const parsed = parsePriceToCents(row.rawUsd, { allowZero: true });
      // Invalid / incomplete input still counts as unapplied (must Apply or Cancel).
      if (!parsed.ok) return true;
      if (parsed.cents !== Number(canonical.amountCents)) return true;
    }
    return false;
  }

  return {
    MONEY_MIN_CENTS: MONEY_MIN_CENTS,
    PRICE_RE: PRICE_RE,
    parsePriceToCents: parsePriceToCents,
    centsToUsd: centsToUsd,
    priceErrorMessage: priceErrorMessage,
    escapeHtml: escapeHtml,
    editableCatalogSignature: editableCatalogSignature,
    isCatalogDirty: isCatalogDirty,
    packageMatchesQuery: packageMatchesQuery,
    isCanonicalDraftResponse: isCanonicalDraftResponse,
    PAGE_STATES: PAGE_STATES,
    isSaveEnabled: isSaveEnabled,
    isContradictoryModel: isContradictoryModel,
    cloneAddonEditBuffer: cloneAddonEditBuffer,
    validateAddonBufferPrices: validateAddonBufferPrices,
    applyAddonBufferToDraft: applyAddonBufferToDraft,
    addonSummaryAmountCents: addonSummaryAmountCents,
    addonBufferHasUnappliedChanges: addonBufferHasUnappliedChanges,
  };
});
