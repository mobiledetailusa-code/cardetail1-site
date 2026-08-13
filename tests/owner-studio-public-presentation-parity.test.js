'use strict';

/**
 * Public-content presentation parity for the Owner Studio adapter.
 *
 * PR #191 proved price parity. This proves the rest of the public contract: the
 * fields the shipped renderer actually reads. Owner Studio stays authoritative for
 * identity, price, ordering, availability and `popular`; merchandising metadata the
 * catalog does not model is bridged from the legacy object by stable id.
 *
 * The legacy package metadata lives in index.html's own PRICING literal — not in
 * booking-price-catalog.js, which carries tiers and add-ons only.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  bridgePresentationMetadata, bridgeCategoryPackages, PRESENTATION_FIELDS, BEHAVIOUR_FIELDS,
} = require('../netlify/lib/owner-studio/legacy-presentation-bridge');

const ROOT = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** Evaluate index.html's own PRICING literal — the only home of package metadata. */
function legacyPricing() {
  const start = indexHtml.search(/(?:const|let)\s+PRICING\s*=/);
  assert.notEqual(start, -1, 'PRICING literal not found in index.html');
  const open = indexHtml.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < indexHtml.length; i += 1) {
    if (indexHtml[i] === '{') depth += 1;
    else if (indexHtml[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return vm.runInNewContext('(' + indexHtml.slice(open, i + 1) + ')');
      }
    }
  }
  assert.fail('PRICING literal not closed');
  return null;
}

const LEGACY = legacyPricing();

/** Adapter-shaped packages: exactly the fields adaptStorefrontPreview emits. */
function adaptedFrom(legacy, cat) {
  return {
    [cat]: {
      tiers: legacy[cat].tiers,
      addons: legacy[cat].addons,
      packages: (legacy[cat].packages || []).map((p) => ({
        id: p.id,
        name: p.name,
        description: '',
        shortDescription: '',
        feats: [],
        miss: [],
        popular: !!p.popular,
        displayOrder: 0,
      })),
    },
  };
}

describe('the renderer reads fields the adapter does not emit', () => {
  it('index.html reads note, tag, dur, icon and scope off a package', () => {
    assert.match(indexHtml, /p\.note\s*\|\|\s*'price set by vehicle size\/type'/);
    assert.match(indexHtml, /class="pkg-tag">\$\{p\.tag\}/);
    assert.match(indexHtml, /class="pkg-time">⏱ \$\{p\.dur\}/);
    assert.match(indexHtml, /ST\.pkg\.icon\s*\|\|/);
    assert.match(indexHtml, /ST\.pkg\?\.scope\s*\|\|\s*'both'/);
  });

  /**
   * scope is NOT decorative: it selects which add-ons a package offers. Defaulting it
   * to 'both' opens every add-on to every package.
   */
  it('scope filters the offered add-ons', () => {
    assert.match(indexHtml, /return pkgScope==='both' \|\| s==='any' \|\| s===pkgScope;/);
  });

  /** ext/int/feats feed the guard that stops an included add-on being sold again. */
  it('ext/int/feats feed the double-charge guard', () => {
    assert.match(indexHtml, /_pkgInclTxt=\[\]\.concat\(ST\.pkg\?\.feats\|\|\[\],ST\.pkg\?\.ext\|\|\[\],ST\.pkg\?\.int\|\|\[\]\)/);
    assert.match(indexHtml, /_pkgIncludesAddon=\{rainx:/);
  });
});

describe('the bridge restores exactly those fields, by stable id', () => {
  for (const cat of ['cars', 'boats', 'rvs', 'powersports']) {
    it(`${cat}: every adapted package regains its legacy metadata`, () => {
      const { pricing, report } = bridgePresentationMetadata(adaptedFrom(LEGACY, cat), LEGACY, [cat]);
      assert.equal(report.ok, true, JSON.stringify(report));
      assert.equal(report.unmatched.length, 0);

      for (const legacyPkg of LEGACY[cat].packages || []) {
        const got = pricing[cat].packages.find((p) => p.id === legacyPkg.id);
        assert.ok(got, `${cat}.${legacyPkg.id} missing from bridged output`);
        for (const field of PRESENTATION_FIELDS.concat(BEHAVIOUR_FIELDS)) {
          if (legacyPkg[field] == null) continue;
          assert.deepEqual(got[field], legacyPkg[field],
            `${cat}.${legacyPkg.id}.${field} did not survive the bridge`);
        }
      }
    });
  }

  it('a package with a legacy note never falls into the generic fallback', () => {
    const withNote = [];
    for (const cat of ['cars', 'boats', 'rvs', 'powersports']) {
      const { pricing } = bridgePresentationMetadata(adaptedFrom(LEGACY, cat), LEGACY, [cat]);
      for (const p of pricing[cat].packages) if (p.note) withNote.push(cat + '.' + p.id);
    }
    // The legacy catalog only notes a couple of packages; the point is that the ones
    // it does note keep them rather than collapsing to the placeholder.
    assert.ok(withNote.length > 0, 'no package carried a note through the bridge');
  });

  it('preserves Owner Studio authority — name, popular and order are untouched', () => {
    const adapted = adaptedFrom(LEGACY, 'cars');
    adapted.cars.packages[0].name = 'OWNER STUDIO NAME';
    adapted.cars.packages[0].popular = !LEGACY.cars.packages[0].popular;
    adapted.cars.packages[0].displayOrder = 99;
    const { pricing } = bridgePresentationMetadata(adapted, LEGACY, ['cars']);
    const got = pricing.cars.packages[0];
    assert.equal(got.name, 'OWNER STUDIO NAME', 'legacy name must never win');
    assert.equal(got.popular, adapted.cars.packages[0].popular);
    assert.equal(got.displayOrder, 99);
  });

  it('never lets the bridge supply money', () => {
    const adapted = adaptedFrom(LEGACY, 'cars');
    const { pricing } = bridgePresentationMetadata(adapted, LEGACY, ['cars']);
    for (const p of pricing.cars.packages) {
      for (const key of Object.keys(p)) {
        assert.equal(/price|cents|amount|total/i.test(key), false,
          `bridged package carries a money-shaped field: ${key}`);
      }
    }
  });
});

describe('identity mapping fails safely', () => {
  const legacy = { cars: { packages: [{ id: 'full', note: 'REAL', tag: 'T' }] } };

  it('does not borrow another package\'s metadata when there is no match', () => {
    const adapted = { cars: { packages: [{ id: 'unknown_pkg', name: 'X' }] } };
    const { pricing, report } = bridgePresentationMetadata(adapted, legacy, ['cars']);
    assert.equal(pricing.cars.packages[0].note, undefined, 'must not inherit REAL');
    assert.equal(report.ok, false);
    assert.deepEqual(report.unmatched, [{ category: 'cars', packageId: 'unknown_pkg' }]);
  });

  it('refuses an ambiguous duplicate id rather than picking one', () => {
    const dup = { cars: { packages: [{ id: 'full', note: 'A' }, { id: 'full', note: 'B' }] } };
    const adapted = { cars: { packages: [{ id: 'full', name: 'Full' }] } };
    const { pricing, report } = bridgePresentationMetadata(adapted, dup, ['cars']);
    assert.equal(pricing.cars.packages[0].note, undefined);
    assert.equal(report.ok, false);
    assert.deepEqual(report.duplicates, [{ category: 'cars', packageId: 'full' }]);
  });

  it('never matches by position, order, name or price', () => {
    const adapted = { cars: { packages: [{ id: 'other', name: 'Full', displayOrder: 0 }] } };
    const { pricing } = bridgePresentationMetadata(adapted, legacy, ['cars']);
    assert.equal(pricing.cars.packages[0].tag, undefined, 'same position/name must not match');
  });
});

describe('index.html wiring', () => {
  it('loads the bridge and applies it before the shell defaults', () => {
    assert.match(indexHtml, /legacy-presentation-bridge\.js/);
    const bridgeAt = indexHtml.indexOf('osBridgeLegacyPresentation(adapted.PRICING');
    const shellAt = indexHtml.indexOf('PRICING=osApplyPreviewShell(bridged)');
    assert.ok(bridgeAt > -1 && shellAt > bridgeAt, 'bridge must run before the defaults');
  });

  it('no longer fakes tag from shortDescription, nor forces scope to both', () => {
    assert.doesNotMatch(indexHtml, /if\(p\.tag==null\)p\.tag=p\.shortDescription/);
    assert.doesNotMatch(indexHtml, /if\(p\.scope==null\)p\.scope='both'/);
  });

  it('snapshots the legacy catalog before PRICING is replaced', () => {
    const snapAt = indexHtml.indexOf('OS_LEGACY_PRESENTATION = (function()');
    const replaceAt = indexHtml.indexOf('PRICING=osApplyPreviewShell(bridged)');
    assert.ok(snapAt > -1 && snapAt < replaceAt);
  });
});
