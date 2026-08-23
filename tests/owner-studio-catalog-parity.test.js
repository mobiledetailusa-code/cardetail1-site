'use strict';

/**
 * Catalog parity gate — the check the Stage 6 release gate calls for.
 *
 * Runs entirely without a database: it imports the legacy catalog through the real
 * importer, adapts it through the real storefront adapter, and asserts the round
 * trip reproduces the legacy prices exactly. That covers the path a published
 * release would take, so a bug anywhere along importer → draft shape → adapter
 * fails here rather than on the public site.
 *
 * Context: on 2026-08-12 the staging draft had drifted to 0 of 90 prices matching
 * legacy — Premium car packages at $1–$2 against a real $385–$525 — and had been
 * that way for weeks. Nothing was comparing them.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { importLegacyCatalog } = require('../netlify/lib/owner-studio/importer');
const { buildStorefrontPreviewCatalog } = require('../netlify/lib/owner-studio/storefront-preview');
const { adaptStorefrontPreview } = require('../netlify/lib/owner-studio/storefront-preview-adapter');
const { HOMEPAGE_CATEGORIES } = require('../netlify/lib/owner-studio/storefront-preview-adapter');
const { compareCatalogToLegacy, formatParityDifferences } = require('../netlify/lib/owner-studio/catalog-parity');
const { PRICING: LEGACY } = require('../netlify/lib/booking-price-catalog');
const { SITE_ID } = require('../netlify/lib/owner-studio/ids');

const ROOT = path.join(__dirname, '..');

/**
 * Build the draft payload exactly the way scripts/owner-studio-staging-seed-catalog.js
 * does, so this gate exercises the same path a real re-import takes.
 *
 * `report.packages` at the top level holds mapping records (legacyKey → ids), not
 * draft entities; the entities are on `report.draft`, which the importer only fills
 * in when it finalizes. Artifacts are redirected to a temp dir so running the suite
 * never rewrites the tracked artifacts/ files.
 */
function importedCatalog() {
  const report = importLegacyCatalog({
    repoRoot: ROOT,
    siteId: SITE_ID,
    // dryRun defaults to TRUE, and in that mode report.draft is a summary
    // (packageCount, samplePackageIds, …) rather than the entities.
    dryRun: false,
    artifactsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'os-parity-')),
  });
  const d = report.draft;
  const draft = {
    siteId: SITE_ID,
    packages: d.packages || [],
    addOns: (d.addOns || []).map((a, i) => ({ ...a, displayOrder: Number.isInteger(a.displayOrder) ? a.displayOrder : i })),
    vehicleClasses: (d.vehicleClasses || []).map((vc, i) => ({ ...vc, displayOrder: Number.isInteger(vc.displayOrder) ? vc.displayOrder : i })),
    navigation: d.navigation || { siteId: SITE_ID, headerItems: [] },
    footer: d.footer || { siteId: SITE_ID, tagline: '', groups: [], legalLinks: [], copyright: '' },
    pages: d.pages || [], galleries: d.galleries || [], serviceAreas: d.serviceAreas || [], media: d.media || [],
  };
  // adaptStorefrontPreview returns { PRICING, LENGTH_PRICING, meta }; the comparison
  // takes the PRICING shape, not the wrapper.
  return adaptStorefrontPreview(buildStorefrontPreviewCatalog(draft)).PRICING;
}

describe('a freshly imported catalog matches the legacy one exactly', () => {
  it('reproduces every legacy price through importer → adapter', () => {
    const result = compareCatalogToLegacy(importedCatalog(), LEGACY);
    assert.ok(result.compared > 80, `expected a meaningful comparison, got ${result.compared}`);
    assert.deepEqual(result.differences, [],
      'import/adapt round trip drifted:\n' + formatParityDifferences(result.differences).join('\n'));
    assert.equal(result.ok, true);
  });

  it('compares a substantial number of prices, not an empty set', () => {
    // Guards against the check silently passing because it compared nothing —
    // the failure mode that would make this whole gate worthless.
    const { compared } = compareCatalogToLegacy(importedCatalog(), LEGACY);
    assert.ok(compared >= 90, `parity must cover the catalog; compared only ${compared}`);
  });
});

describe('the comparison actually detects drift', () => {
  const base = () => ({
    cars: {
      tiers: { small: { maint: 150, full: 240 } },
      addons: [{ id: 'ozone', price: 40 }],
      packages: [],
    },
  });

  it('reports a changed price with both values', () => {
    const drifted = base();
    drifted.cars.tiers.small.full = 285;
    const out = compareCatalogToLegacy(drifted, base());
    assert.equal(out.ok, false);
    assert.deepEqual(out.differences[0], {
      kind: 'price_differs', category: 'cars', tier: 'small', packageId: 'full', legacy: 240, draft: 285,
    });
  });

  /** The exact shape of the real incident: a package deactivated out of the draft. */
  it('reports a price that disappeared from the draft', () => {
    const drifted = base();
    delete drifted.cars.tiers.small.maint;
    const out = compareCatalogToLegacy(drifted, base());
    assert.equal(out.differences[0].kind, 'price_missing');
    assert.equal(out.differences[0].legacy, 150);
  });

  it('reports a missing category and a missing tier', () => {
    assert.equal(compareCatalogToLegacy({}, base()).differences[0].kind, 'category_missing');
    assert.equal(compareCatalogToLegacy({ cars: { tiers: {} } }, base()).differences[0].kind, 'tier_missing');
  });

  it('reports add-on drift in both directions', () => {
    const changed = base();
    changed.cars.addons = [{ id: 'ozone', price: 99 }];
    assert.equal(compareCatalogToLegacy(changed, base()).differences[0].kind, 'addon_differs');

    const extra = base();
    extra.cars.addons = [{ id: 'ozone', price: 40 }, { id: 'invented', price: 10 }];
    assert.equal(compareCatalogToLegacy(extra, base()).differences[0].kind, 'addon_unexpected');
  });

  it('treats the legacy 0 sentinel as "unavailable", not a price', () => {
    const legacy = base();
    legacy.cars.tiers.small.custom = 0;
    const out = compareCatalogToLegacy(base(), legacy);
    assert.equal(out.ok, true, '0 means unavailable and must not be compared as money');
  });
});

describe('scope', () => {
  it('does not compare fleet, which the homepage adapter deliberately omits', () => {
    assert.equal(HOMEPAGE_CATEGORIES.includes('fleet'), false);
    const out = compareCatalogToLegacy({}, { fleet: { tiers: { vehicle: { maint: 65 } } } });
    assert.deepEqual(out.differences, [], 'fleet has its own page and its own pricing surface');
  });
});
