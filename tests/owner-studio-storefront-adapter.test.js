'use strict';

/**
 * Stage 4B-2 — pure storefront preview adapter unit tests.
 * Payloads mimic the sanitized owner-studio-catalog-preview output (with legacyKey).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { adaptStorefrontPreview, centsToDollars } = require('../netlify/lib/owner-studio/storefront-preview-adapter');

const vc = (id, legacyKey, category, order, active = true) =>
  ({ vehicleClassId: id, legacyKey, category, label: legacyKey, active, displayOrder: order });
const price = (vehicleClassId, amountCents, priceModel = 'flat', extra = {}) =>
  ({ vehicleClassId, currency: 'usd', amountCents, priceModel, ...extra });
const pkg = (id, legacyKey, category, order, prices, opts = {}) =>
  ({ packageId: id, legacyKey, category, name: opts.name || legacyKey, description: opts.description || '',
     shortDescription: '', active: opts.active !== false, featured: !!opts.featured, displayOrder: order,
     features: opts.features || [], prices, compatibleVehicleClassIds: [], compatibleAddOnIds: [] });
const addon = (id, legacyKey, order, prices, opts = {}) =>
  ({ addOnId: id, legacyKey, name: opts.name || legacyKey, description: opts.description || '',
     active: opts.active !== false, allowQuantity: !!opts.qty, displayOrder: order, prices,
     compatibility: opts.compat || [] });

function payload(over = {}) {
  return {
    ok: true, preview: true, siteId: 'detailing-zone', draftVersion: 7, savedAt: '2026-07-31T00:00:00.000Z',
    banner: 'DRAFT PREVIEW — NOT PUBLISHED',
    vehicleClasses: [
      vc('vc_sedan', 'small', 'cars', 0),
      vc('vc_suv2', 'suv2', 'cars', 1),
      vc('vc_under20', 'under20', 'boats', 0),
      vc('vc_rv_travel', 'travel', 'rvs', 0),
      vc('vc_moto', 'motorcycle', 'powersports', 0),
    ],
    packages: [
      pkg('pkg_full', 'full', 'cars', 2, [price('vc_sedan', 28500), price('vc_suv2', 30500)],
        { name: 'Full Detail', featured: true, features: [{ kind: 'included', label: 'Wash' }, { kind: 'excluded', label: 'Polish' }] }),
      pkg('pkg_maint', 'maint', 'cars', 0, [price('vc_sedan', 17500), price('vc_suv2', 21500)], { name: 'Maintenance' }),
      pkg('pkg_boat_full', 'full', 'boats', 1, [price('vc_under20', 59900)], { name: 'Full Marine' }),
      pkg('pkg_rv_full', 'full', 'rvs', 1,
        [price('vc_rv_travel', 140000, 'base_plus_per_foot', { baseCents: 40000, perFootCents: 3600 })], { name: 'RV Full' }),
      pkg('pkg_ps_wash', 'wash', 'powersports', 0, [price('vc_moto', 11900)], { name: 'Wash & Shine' }),
    ],
    addOns: [
      addon('addon_pet', 'pethair', 0, [{ category: 'cars', currency: 'usd', amountCents: 9500 }],
        { name: 'Pet Hair Removal', compat: [{ category: 'cars' }] }),
      addon('addon_rainx', 'rainx', 1,
        [{ category: 'cars', currency: 'usd', amountCents: 2500 }, { category: 'boats', currency: 'usd', amountCents: 2500 }],
        { name: 'Rain-X', compat: [{ category: 'cars' }, { category: 'boats' }] }),
      addon('addon_mats', 'floormats', 2, [{ category: 'cars', currency: 'usd', amountCents: 2000 }],
        { name: 'Floor Mats', qty: true, compat: [{ category: 'cars' }] }),
    ],
    priceConflicts: { count: 0 },
    ...over,
  };
}

describe('storefront preview adapter (4B-2)', () => {
  it('cars: builds the tier x package dollar matrix from integer cents', () => {
    const { PRICING } = adaptStorefrontPreview(payload());
    assert.equal(PRICING.cars.tiers.small.full, 285);
    assert.equal(PRICING.cars.tiers.small.maint, 175);
    assert.equal(PRICING.cars.tiers.suv2.full, 305);
    assert.equal(PRICING.cars.tiers.suv2.maint, 215);
    // package projection keyed by legacyKey, ordered
    assert.deepEqual(PRICING.cars.packages.map((p) => p.id), ['maint', 'full']);
    assert.equal(PRICING.cars.packages.find((p) => p.id === 'full').feats[0], 'Wash');
    assert.equal(PRICING.cars.packages.find((p) => p.id === 'full').miss[0], 'Polish');
  });

  it('boats: maps a single-tier boat matrix', () => {
    const { PRICING } = adaptStorefrontPreview(payload());
    assert.equal(PRICING.boats.tiers.under20.full, 599);
  });

  it('rv length pricing: base_plus_per_foot -> LENGTH_PRICING base + ratePerFoot', () => {
    const { LENGTH_PRICING } = adaptStorefrontPreview(payload());
    assert.equal(LENGTH_PRICING.rvs.packages.full.base, 400);
    assert.equal(LENGTH_PRICING.rvs.packages.full.ratePerFoot, 36);
  });

  it('powersports: maps its own tier keys', () => {
    const { PRICING } = adaptStorefrontPreview(payload());
    assert.equal(PRICING.powersports.tiers.motorcycle.wash, 119);
  });

  it('add-ons: mapped by legacyKey with the category-specific price and qty flag', () => {
    const { PRICING } = adaptStorefrontPreview(payload());
    const cars = PRICING.cars.addons;
    assert.deepEqual(cars.map((a) => a.id), ['pethair', 'rainx', 'floormats']);
    assert.equal(cars.find((a) => a.id === 'pethair').price, 95);
    assert.equal(cars.find((a) => a.id === 'floormats').qty, true);
    // rainx is shared to boats too, at the boats price row
    assert.equal(PRICING.boats.addons.find((a) => a.id === 'rainx').price, 25);
  });

  it('inactive items are excluded', () => {
    const p = payload({
      packages: [
        pkg('pkg_maint', 'maint', 'cars', 0, [price('vc_sedan', 17500)]),
        pkg('pkg_dead', 'refresh', 'cars', 1, [price('vc_sedan', 37500)], { active: false }),
      ],
      addOns: [
        addon('addon_pet', 'pethair', 0, [{ category: 'cars', amountCents: 9500 }], { compat: [{ category: 'cars' }] }),
        addon('addon_dead', 'odor', 1, [{ category: 'cars', amountCents: 9000 }], { active: false, compat: [{ category: 'cars' }] }),
      ],
      vehicleClasses: [vc('vc_sedan', 'small', 'cars', 0)],
    });
    const { PRICING } = adaptStorefrontPreview(p);
    assert.deepEqual(PRICING.cars.packages.map((x) => x.id), ['maint']);
    assert.equal(PRICING.cars.tiers.small.refresh, undefined);
    assert.deepEqual(PRICING.cars.addons.map((x) => x.id), ['pethair']);
  });

  it('missing legacyKey fails closed (no silent legacy fallback)', () => {
    const p = payload({
      packages: [pkg('pkg_x', '', 'cars', 0, [price('vc_sedan', 17500)])],
      vehicleClasses: [vc('vc_sedan', 'small', 'cars', 0)],
      addOns: [],
    });
    assert.throws(() => adaptStorefrontPreview(p), (e) => e.code === 'preview_unmapped_package');

    const p2 = payload({
      vehicleClasses: [vc('vc_sedan', '', 'cars', 0)],
      packages: [pkg('pkg_m', 'maint', 'cars', 0, [price('vc_sedan', 17500)])],
      addOns: [],
    });
    assert.throws(() => adaptStorefrontPreview(p2), (e) => e.code === 'preview_unmapped_vehicle_class');
  });

  it('malformed cents fail closed', () => {
    for (const bad of [-100, 12.5, NaN, '900']) {
      const p = payload({
        vehicleClasses: [vc('vc_sedan', 'small', 'cars', 0)],
        packages: [pkg('pkg_m', 'maint', 'cars', 0, [price('vc_sedan', bad)])],
        addOns: [],
      });
      assert.throws(() => adaptStorefrontPreview(p), (e) => e.code === 'preview_bad_cents', 'cents=' + bad);
    }
  });

  it('deterministic ordering by displayOrder then legacyKey', () => {
    const p = payload({
      vehicleClasses: [vc('vc_sedan', 'small', 'cars', 0)],
      packages: [
        pkg('b', 'full', 'cars', 5, [price('vc_sedan', 28500)]),
        pkg('a', 'maint', 'cars', 1, [price('vc_sedan', 17500)]),
        pkg('c', 'interior', 'cars', 1, [price('vc_sedan', 22500)]),
      ],
      addOns: [],
    });
    const { PRICING } = adaptStorefrontPreview(p);
    // order 1 (interior<maint by legacyKey), 1 (maint), 5 (full)
    assert.deepEqual(PRICING.cars.packages.map((x) => x.id), ['interior', 'maint', 'full']);
  });

  it('does not mutate the input payload', () => {
    const p = payload();
    const before = JSON.parse(JSON.stringify(p));
    adaptStorefrontPreview(p);
    assert.deepEqual(p, before);
  });

  it('rejects a payload that is not a confirmed preview', () => {
    assert.throws(() => adaptStorefrontPreview({ preview: false }), (e) => e.code === 'preview_not_confirmed');
    assert.throws(() => adaptStorefrontPreview(null), (e) => e.code === 'preview_not_confirmed');
  });

  it('integer cents stay authoritative; dollars only at the boundary', () => {
    assert.equal(centsToDollars(17550), 175.5);
    assert.equal(centsToDollars(28500), 285);
    const { PRICING } = adaptStorefrontPreview(payload({
      vehicleClasses: [vc('vc_sedan', 'small', 'cars', 0)],
      packages: [pkg('pkg_m', 'maint', 'cars', 0, [price('vc_sedan', 17550)])],
      addOns: [],
    }));
    assert.equal(PRICING.cars.tiers.small.maint, 175.5);
  });

  it('is a pure module — no booking / payment / stripe / fetch imports', () => {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'netlify', 'lib', 'owner-studio', 'storefront-preview-adapter.js'), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); // strip comments
    assert.doesNotMatch(code, /require\s*\(/);
    assert.doesNotMatch(code, /\bfetch\s*\(|\bStripe\b|stripe\.|PaymentIntent|submit-booking|create-setup-intent|document\.|window\.addEventListener/i);
  });
});
