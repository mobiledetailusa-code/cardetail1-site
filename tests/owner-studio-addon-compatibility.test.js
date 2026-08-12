'use strict';

/**
 * Add-on ↔ category compatibility editing.
 *
 * `addOn.compatibility[].category` is the side of the relation the storefront
 * adapter actually reads, so it is the side the Catalog Manager edits. The
 * package-side `compatibleAddOnIds` is stored and validated but consumed by
 * nothing today — see docs/owner-studio-catalog-contract.md.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Ux = require('../netlify/lib/owner-studio-catalog-ux-logic');
const { adaptStorefrontPreview } = require('../netlify/lib/owner-studio/storefront-preview-adapter');

const ROOT = path.join(__dirname, '..');
const catalogHtml = fs.readFileSync(path.join(ROOT, 'admin-owner-studio-catalog.html'), 'utf8');

function addon(over) {
  return Object.assign({
    addOnId: 'addon_ozone',
    legacyKey: 'ozone',
    name: 'Ozone Treatment',
    description: '',
    active: true,
    displayOrder: 1,
    prices: [{ category: 'cars', currency: 'usd', amountCents: 4000 }],
    compatibility: [{ category: 'cars' }],
  }, over);
}

describe('compatibility buffer', () => {
  it('splits category rows from package-scoped rows', () => {
    const split = Ux.splitAddonCompatibility(addon({
      compatibility: [{ category: 'cars' }, { packageId: 'pkg_full' }, { category: 'rvs' }],
    }));
    assert.deepEqual(split.categories, ['cars', 'rvs']);
    assert.deepEqual(split.other, [{ packageId: 'pkg_full' }]);
  });

  it('round-trips package-scoped rows the editor cannot show', () => {
    const draft = { addOns: [addon({ compatibility: [{ category: 'cars' }, { packageId: 'pkg_full' }] })] };
    const buf = Ux.cloneAddonEditBuffer(draft.addOns[0]);
    const res = Ux.applyAddonBufferToDraft(draft, buf);
    assert.equal(res.ok, true);
    // The rule the UI never rendered must survive an unrelated edit.
    assert.deepEqual(draft.addOns[0].compatibility, [{ category: 'cars' }, { packageId: 'pkg_full' }]);
  });

  it('treats a category toggle as an unapplied change', () => {
    const a = addon();
    const buf = Ux.cloneAddonEditBuffer(a);
    assert.equal(Ux.addonBufferHasUnappliedChanges(buf, a), false);
    buf.categories = ['cars', 'rvs'];
    assert.equal(Ux.addonBufferHasUnappliedChanges(buf, a), true);
  });

  it('is order-insensitive — reordering categories is not an edit', () => {
    const a = addon({
      prices: [{ category: 'cars', currency: 'usd', amountCents: 4000 }, { category: 'rvs', currency: 'usd', amountCents: 9000 }],
      compatibility: [{ category: 'cars' }, { category: 'rvs' }],
    });
    const buf = Ux.cloneAddonEditBuffer(a);
    buf.categories = ['rvs', 'cars'];
    assert.equal(Ux.addonBufferHasUnappliedChanges(buf, a), false);
  });
});

describe('a category can never be offered without its own price', () => {
  it('flags categories that have no exact price row', () => {
    const buf = Ux.cloneAddonEditBuffer(addon());
    buf.categories = ['cars', 'rvs'];
    assert.deepEqual(Ux.addonCategoriesMissingPrice(buf), ['rvs']);
  });

  it('refuses the apply instead of writing a silently mispriced add-on', () => {
    const draft = { addOns: [addon()] };
    const buf = Ux.cloneAddonEditBuffer(draft.addOns[0]);
    buf.categories = ['cars', 'rvs'];
    const res = Ux.applyAddonBufferToDraft(draft, buf);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'category_without_price');
    assert.deepEqual(res.categories, ['rvs']);
    // Draft untouched — a rejected apply must not partially commit.
    assert.deepEqual(draft.addOns[0].compatibility, [{ category: 'cars' }]);
  });

  it('accepts the same edit once the category has a price row', () => {
    const draft = { addOns: [addon()] };
    const buf = Ux.cloneAddonEditBuffer(draft.addOns[0]);
    buf.categories = ['cars', 'rvs'];
    buf.prices.push({ category: 'rvs', currency: 'usd', amountCents: 9000, rawUsd: '90.00' });
    const res = Ux.applyAddonBufferToDraft(draft, buf);
    assert.equal(res.ok, true);
    assert.deepEqual(draft.addOns[0].compatibility, [{ category: 'cars' }, { category: 'rvs' }]);
  });

  /**
   * Defence in depth. The buffer guard stops the Catalog Manager creating this state;
   * the adapter refuses to render it whatever produced it (hand-edited draft, seed
   * script, direct DB write). It previously resolved the price with
   * `prices.find(cat) || prices[0]` and silently billed another category's amount.
   */
  it('refuses to render an add-on offered in a category it has no price for', () => {
    assert.throws(() => adaptStorefrontPreview(previewWithUnpricedRvAddon()), (err) => {
      assert.equal(err.code, 'preview_addon_no_price');
      assert.match(err.message, /addon_ozone.*rvs/);
      return true;
    });
  });

  function previewWithUnpricedRvAddon() {
    return {
      preview: true,
      vehicleClasses: [
        { vehicleClassId: 'vc_small', legacyKey: 'small', category: 'cars', label: 'Small', active: true, displayOrder: 1 },
        { vehicleClassId: 'vc_travel', legacyKey: 'travel', category: 'rvs', label: 'Travel', active: true, displayOrder: 1 },
      ],
      packages: [
        { packageId: 'pkg_c', legacyKey: 'full', category: 'cars', name: 'Full', active: true, displayOrder: 1, features: [], prices: [{ vehicleClassId: 'vc_small', currency: 'usd', amountCents: 24000, priceModel: 'flat' }] },
        { packageId: 'pkg_r', legacyKey: 'full', category: 'rvs', name: 'Full RV', active: true, displayOrder: 1, features: [], prices: [{ vehicleClassId: 'vc_travel', currency: 'usd', amountCents: 119000, priceModel: 'flat' }] },
      ],
      // Offered on rvs but priced only for cars.
      addOns: [addon({ compatibility: [{ category: 'cars' }, { category: 'rvs' }] })],
    };
  }

  it('still renders normally once every offered category carries its own price', () => {
    const payload = previewWithUnpricedRvAddon();
    payload.addOns[0].prices.push({ category: 'rvs', currency: 'usd', amountCents: 9000 });
    const out = adaptStorefrontPreview(payload);
    assert.equal(out.PRICING.cars.addons[0].price, 40);
    assert.equal(out.PRICING.rvs.addons[0].price, 90, 'each category bills its own amount');
  });
});

describe('Catalog Manager exposes the control', () => {
  it('renders a category picker inside the add-on editor', () => {
    assert.match(catalogHtml, /data-compat\b/);
    assert.match(catalogHtml, /function renderAddonCompatibility\(/);
    assert.match(catalogHtml, /data-compat-cat=/);
    assert.match(catalogHtml, /Offered on/);
  });

  it('derives the category list from the draft rather than hardcoding it', () => {
    assert.match(catalogHtml, /function catalogCategories\(/);
    assert.match(catalogHtml, /state\.draft\.packages \|\| \[\]\)\.map\(\(p\) => p\.category\)/);
  });

  it('surfaces the unpriced-category refusal to the operator', () => {
    assert.match(catalogHtml, /category_without_price/);
    assert.match(catalogHtml, /before offering this add-on there/);
  });
});
