'use strict';

/**
 * CARDDETAIL1 — cross-category cart + price resolution repair.
 *
 * Proves:
 * A) Normal category switch REPLACES cart (RV Dutchmen must not survive Cars)
 * B) Explicit Add Another Vehicle still APPENDS
 * C) Explorer + Exterior Refresh resolves numeric suv3 price (never "Estimate")
 * D) Published package price miss shows retry error, not Estimate
 * E) Catalog integrity: every public package × tier has a numeric price
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const {
  PRICING,
  LENGTH_PRICING,
  getLengthPrice,
  computeVehicleSubtotal,
} = require('../netlify/lib/booking-price-catalog');
const CD1 = require('../assets/vehicle-class-resolver');

const ROOT = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const lineItemsSrc = fs.readFileSync(path.join(ROOT, 'assets/booking-line-items.js'), 'utf8');
const Review = require('../assets/booking-review-runtime');

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'missing ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unterminated ' + name);
}

function extractAssignedObject(source, name) {
  const declaration = new RegExp('(?:const|let)\\s+' + name + '\\s*=');
  const declarationMatch = declaration.exec(source);
  assert.ok(declarationMatch, name + ' missing');
  const start = source.indexOf('{', declarationMatch.index + declarationMatch[0].length);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unterminated object ' + name);
}

const MODELS = vm.runInNewContext('(' + extractAssignedObject(index, 'MODELS') + ')');

describe('catalog integrity — all public package/tier mappings numeric', () => {
  it('CATALOG COMPLETE for cars / boats / rvs / powersports', () => {
    const missing = [];
    const cats = {
      cars: ['wash', 'maint', 'interior', 'full', 'refresh', 'premium'],
      boats: ['maint', 'essential', 'full', 'premium'],
      rvs: ['maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full'],
      powersports: ['wash', 'essential', 'full', 'premium'],
    };
    for (const [cat, pkgs] of Object.entries(cats)) {
      if (cat === 'boats' || cat === 'rvs') {
        for (const pkg of pkgs) {
          const price = getLengthPrice(cat, pkg, cat === 'rvs' ? 27 : 22, cat === 'rvs' ? 'travel' : 'runabout');
          if (!(price > 0)) missing.push({ cat, pkg, price });
        }
      } else {
        for (const [tierKey, tier] of Object.entries(PRICING[cat].tiers)) {
          if (cat === 'powersports' && tierKey === 'jetski') continue;
          for (const pkg of pkgs) {
            const n = Number(tier[pkg]);
            if (!(n > 0)) missing.push({ cat, pkg, tier: tierKey, price: n });
          }
        }
      }
    }
    assert.deepEqual(missing, [], 'CATALOG COMPLETE — resolver/state defect if empty expected');
  });

  it('Explorer Exterior Refresh canonical mapping', () => {
    const resolved = CD1.resolveVehicleClassification({
      make: 'Ford',
      model: 'Explorer',
      year: '2023',
      catalogTierKey: MODELS.Ford.t.Explorer,
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.tierKey, 'suv3');
    assert.equal(PRICING.cars.tiers.suv3.refresh, 405);
    const priced = computeVehicleSubtotal({ cat: 'cars', pkgId: 'refresh', tierKey: 'suv3', addons: [] }, '07666');
    assert.equal(priced.ok, true);
    assert.equal(priced.basePrice, 405);
  });
});

describe('source contracts', () => {
  it('selectCategory clears cart on normal switch and keeps append flag path', () => {
    const src = extractFunction(index, 'selectCategory');
    assert.match(src, /_startingAdditionalVehicle/);
    assert.match(src, /ST\.vehicles\s*=\s*\[\]/);
    assert.match(src, /resetVehicleEntryFields/);
  });

  it('setBasePrice uses canonical tier matrix without wash/maint fallback', () => {
    const src = extractFunction(index, 'setBasePrice');
    assert.match(src, /resolveTierPackagePrice/);
    assert.doesNotMatch(src, /ST\.tier\['wash'\]\|\|ST\.tier\['maint'\]/);
    assert.match(src, /_priceResolveFailed/);
  });

  it('updateTotal never falls back to Estimate for published package misses', () => {
    const src = extractFunction(index, 'updateTotal');
    assert.doesNotMatch(src, /: 'Estimate'/);
    assert.match(src, /couldn't load this package price/);
  });

  it('tryGenericConfirm does not price cars from leftover g-make fields', () => {
    const src = extractFunction(index, 'tryGenericConfirm');
    assert.match(src, /if\(ST\.cat==='cars'\) return;/);
  });

  it('line-items null package price is not Estimate', () => {
    assert.doesNotMatch(lineItemsSrc, /packagePrice === null \? 'Estimate'/);
    assert.match(lineItemsSrc, /couldn't load this package price/);
  });
});

describe('cart intent + price resolution (function sandbox)', () => {
  function loadCartFns(stOverrides) {
    const els = {
      'ah-total': { textContent: '' },
      'ah-total-lbl': { textContent: '' },
      'ah-total-est': { textContent: '', style: { display: 'none' } },
      'ah-pkg': { textContent: '' },
      'ah-car': { textContent: '' },
      next3: { disabled: true },
      vc: { classList: { add() {}, remove() {}, contains() { return false; } } },
      'vc-price': { style: { display: 'none' }, innerHTML: '' },
      'vc-urgency': { style: { display: 'none' }, textContent: '' },
      'vcart-items': { innerHTML: '' },
      'vcart-total': { style: { display: 'none' } },
      'vcart-sum': { textContent: '' },
      'make-in': { value: '' },
      'make-dd': { classList: { remove() {}, add() {} } },
      'model-sel': { value: '', disabled: true, innerHTML: '' },
      'year-sel': { value: '', disabled: true, innerHTML: '' },
      'g-make': { value: '', disabled: false },
      'g-model': { value: '', disabled: true },
      'g-year': { value: '', innerHTML: '', onchange: null, appendChild() {} },
      'g-make-dd': { classList: { remove() {} } },
      'g-model-dd': { classList: { remove() {} } },
      'g-custom-note': { style: { display: 'none' } },
      'bs2-rv-note': { style: { display: 'none' } },
      'bk-zip': { value: '07666', focus() {}, style: {} },
      'bk-cat-grid': null,
      'bk-gate-msg': null,
      'pkg-grid': { innerHTML: '', querySelectorAll() { return []; } },
      'tier-chips': { innerHTML: '' },
      'tier-chips-wrap': { style: {} },
      'make-search-wrap': { style: {} },
      'generic-search-wrap': { style: {} },
      'length-box': { classList: { add() {}, remove() {} } },
      'unit-box': { classList: { add() {}, remove() {} } },
      'addon-grid': { innerHTML: '' },
    };
    const sandbox = {
      ST: Object.assign({
        cat: '', pkgId: '', pkg: null, tierKey: '', tier: null, vehicleLabel: '',
        displayLabel: '', basePrice: 0, addons: [], addonTotal: 0, lengthFt: 0,
        rvType: '', rvLiving: '', boatType: '', units: 1, vehicles: [],
        _editingVehicleIndex: null, _startingAdditionalVehicle: false,
        _priceResolveFailed: false, classNeedsConfirm: false,
        make: '', model: '', year: '',
      }, stOverrides),
      PRICING: structuredClone(PRICING),
      // Hub/server PRICING omits package name lists used by renderPackages — stub minimal cars/rvs packages for selectCategory side effects.
      document: {
        getElementById(id) { return els[id] || { style: {}, classList: { add() {}, remove() {}, contains() { return false; } }, value: '', innerHTML: '', disabled: false, textContent: '', focus() {}, appendChild() {} }; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        createElement() { return { value: '', textContent: '' }; },
      },
      activeZone: { zip: '07666' },
      window: {},
      MAKES: Object.keys(MODELS),
      MODELS,
      CD1VehicleClass: CD1,
      VEHICLE_VISUALS: { sedan: { img: '/a.png', alt: 'a' }, rv: { img: '/r.png', alt: 'r' } },
      CATEGORY_VISUALS: { cars: { img: '/c.png', alt: 'c' }, rvs: { img: '/r.png', alt: 'r' } },
      TIER_VISUAL_KEYS: {},
      applyRichPrice(n) { return Number(n) || 0; },
      getTravelFeeAmount() { return 0; },
      getVehicleVisualKey() { return 'sedan'; },
      bkMoney(n) { return '$' + (Number(n) || 0).toFixed(2); },
      bkGoTo() {},
      renderPackages() {},
      renderTierChips() {},
      setupBoatTypeControls() {},
      setupRvTypeControls() {},
      setupLengthSelector() {},
      setupUnitSelector() {},
      initSpecialtySearch() {},
      resolvePackageIntentForCategory() { return ''; },
      openCommercialInquiry() {},
      setVehicleVisual() {},
      setVcName() {},
      renderAddons() { sandbox.updateTotal(); },
      updateVcPriceDisplay() {},
      updateRvServiceSubtotal() {},
      console,
    };
    // Attach package metadata used by buildCurrentVehicleItem
    sandbox.PRICING.cars.packages = [
      { id: 'refresh', name: 'Exterior Refresh & Protect', icon: '🛡️', scope: 'ext' },
      { id: 'full', name: 'Premium Full Detail', icon: '🧽', scope: 'both' },
    ];
    sandbox.PRICING.rvs.packages = [
      { id: 'maint_light', name: 'Maintenance Wash + Light Interior', icon: '🪣', scope: 'both' },
    ];
    sandbox.PRICING.powersports.packages = [
      { id: 'full', name: 'Full Detail', icon: '🧼' },
      { id: 'wash', name: 'Wash & Shine', icon: '🪣' },
    ];
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    const code = [
      extractFunction(index, 'resetVehicleEntryFields'),
      extractFunction(index, 'resolveTierPackagePrice'),
      extractFunction(index, 'isPublishedPricedPackage'),
      extractFunction(index, 'syncContinueGate'),
      extractFunction(index, 'setBasePrice'),
      extractFunction(index, 'updateTotal'),
      extractFunction(index, 'buildCurrentVehicleItem'),
      extractFunction(index, 'commitCurrentVehicleToCart'),
      extractFunction(index, 'addCurrentVehicleToCart'),
      extractFunction(index, 'renderVehicleCart'),
    ].join('\n');
    vm.runInContext(code, sandbox);
    sandbox.selectCategoryCartIntent = function (cat) {
      if (!sandbox.ST._startingAdditionalVehicle) {
        sandbox.ST.vehicles = [];
        sandbox.ST._editingVehicleIndex = null;
      } else {
        sandbox.ST._editingVehicleIndex = null;
      }
      sandbox.ST.cat = cat;
      sandbox.ST.pkgId = '';
      sandbox.ST.pkg = null;
      sandbox.ST.tierKey = '';
      sandbox.ST.tier = null;
      sandbox.ST.vehicleLabel = '';
      sandbox.ST.displayLabel = '';
      sandbox.ST.basePrice = 0;
      sandbox.ST.addons = [];
      sandbox.ST.addonTotal = 0;
      sandbox.ST.lengthFt = 0;
      sandbox.ST.rvType = '';
      sandbox.ST.boatType = '';
      sandbox.ST.make = '';
      sandbox.ST.model = '';
      sandbox.ST.year = '';
      sandbox.ST.classNeedsConfirm = false;
      sandbox.ST._priceResolveFailed = false;
      sandbox.resetVehicleEntryFields(cat);
      sandbox.renderVehicleCart();
      sandbox.updateTotal();
    };
    sandbox.els = els;
    return sandbox;
  }

  it('A) RV → Cars normal switch clears Dutchmen from ST.vehicles', () => {
    const box = loadCartFns({
      vehicles: [{
        cat: 'rvs', pkgId: 'maint_light', pkgName: 'Maintenance Wash + Light Interior',
        pkgIcon: '🪣', visualKey: 'rv', vehicleLabel: '2022 Dutchmen Astoria · 27 ft',
        basePrice: 593, addons: [], addonTotal: 0, subtotal: 593, tierKey: 'travel',
      }],
      _editingVehicleIndex: 0,
      _startingAdditionalVehicle: false,
      cat: 'rvs', pkgId: 'maint_light', basePrice: 593,
      vehicleLabel: '2022 Dutchmen Astoria · 27 ft',
    });
    box.selectCategoryCartIntent('cars');
    assert.equal(box.ST.vehicles.length, 0);
    assert.equal(box.ST._editingVehicleIndex, null);
    assert.equal(box.ST._startingAdditionalVehicle, false);
    assert.equal(box.ST.cat, 'cars');
  });

  it('B) Add Another Vehicle keeps prior vehicle then appends', () => {
    const box = loadCartFns({
      cat: 'cars',
      pkgId: 'full',
      pkg: { name: 'Premium Full Detail', icon: '🧽' },
      vehicleLabel: '2021 Honda Accord',
      displayLabel: 'Small Car',
      tierKey: 'small',
      tier: PRICING.cars.tiers.small,
      basePrice: 240,
      addons: [],
      addonTotal: 0,
    });
    box.addCurrentVehicleToCart();
    assert.equal(box.ST.vehicles.length, 1);
    assert.equal(box.ST._startingAdditionalVehicle, true);
    box.selectCategoryCartIntent('rvs');
    assert.equal(box.ST.vehicles.length, 1, 'append mode must keep first vehicle');
    assert.match(box.ST.vehicles[0].vehicleLabel, /Accord/);
    // Simulate second vehicle commit
    Object.assign(box.ST, {
      cat: 'rvs',
      pkgId: 'maint_light',
      pkg: { name: 'Maintenance Wash + Light Interior', icon: '🪣' },
      vehicleLabel: '2022 Dutchmen Astoria · 27 ft',
      tierKey: 'travel',
      tier: { label: '27 ft' },
      basePrice: 593,
      addons: [],
      addonTotal: 0,
      lengthFt: 27,
      rvType: 'travel',
      _startingAdditionalVehicle: true,
      _editingVehicleIndex: null,
    });
    box.commitCurrentVehicleToCart();
    assert.equal(box.ST.vehicles.length, 2);
    assert.equal(box.ST.vehicles[0].cat, 'cars');
    assert.equal(box.ST.vehicles[1].cat, 'rvs');
  });

  it('C) Explorer + refresh resolves 405 and Continue enables', () => {
    const box = loadCartFns({ cat: 'cars' });
    box.selectCategoryCartIntent('cars');
    box.ST.pkgId = 'refresh';
    box.ST.pkg = { id: 'refresh', name: 'Exterior Refresh & Protect', icon: '🛡️' };
    box.ST.make = 'Ford';
    box.ST.model = 'Explorer';
    box.ST.year = '2023';
    const catalogTierKey = MODELS.Ford.t.Explorer;
    const resolved = CD1.resolveVehicleClassification({
      make: box.ST.make, model: box.ST.model, year: box.ST.year, catalogTierKey,
    });
    assert.equal(resolved.tierKey, 'suv3');
    box.ST.tierKey = resolved.tierKey;
    box.ST.tier = box.PRICING.cars.tiers[resolved.tierKey];
    box.ST.displayLabel = resolved.displayLabel;
    box.ST.vehicleLabel = '2023 Ford Explorer';
    box.ST.classNeedsConfirm = false;
    box.setBasePrice();
    assert.equal(box.ST.basePrice, 405);
    assert.equal(box.ST._priceResolveFailed, false);
    assert.match(box.els['ah-total'].textContent, /\$405/);
    assert.equal(box.els.next3.disabled, false);
    assert.doesNotMatch(box.els['ah-total'].textContent, /Estimate/i);
  });

  it('D) published package price miss shows retry error, not Estimate', () => {
    const box = loadCartFns({
      cat: 'cars',
      pkgId: 'refresh',
      pkg: { id: 'refresh', name: 'Exterior Refresh & Protect' },
      vehicleLabel: '2023 Ford Explorer',
      tierKey: 'not_a_real_tier',
      tier: { label: 'Broken' },
      basePrice: 0,
    });
    box.setBasePrice();
    assert.equal(box.ST.basePrice, 0);
    assert.equal(box.ST._priceResolveFailed, true);
    assert.match(box.els['ah-total'].textContent, /couldn't load this package price/i);
    assert.doesNotMatch(box.els['ah-total'].textContent, /Estimate/i);
    assert.equal(box.els.next3.disabled, true);
  });

  it('E) after replace switch, commit yields Explorer-only cart', () => {
    const box = loadCartFns({
      vehicles: [{
        cat: 'rvs', pkgId: 'maint_light', pkgName: 'Maintenance Wash + Light Interior',
        pkgIcon: '🪣', visualKey: 'rv', vehicleLabel: '2022 Dutchmen Astoria · 27 ft',
        basePrice: 593, addons: [], addonTotal: 0, subtotal: 593,
      }],
      _editingVehicleIndex: 0,
      _startingAdditionalVehicle: false,
    });
    box.selectCategoryCartIntent('cars');
    Object.assign(box.ST, {
      cat: 'cars',
      pkgId: 'refresh',
      pkg: { name: 'Exterior Refresh & Protect', icon: '🛡️' },
      vehicleLabel: '2023 Ford Explorer',
      displayLabel: '3-Row SUV',
      tierKey: 'suv3',
      tier: box.PRICING.cars.tiers.suv3,
      basePrice: 405,
      addons: [],
      addonTotal: 0,
    });
    box.commitCurrentVehicleToCart();
    assert.equal(box.ST.vehicles.length, 1);
    assert.equal(box.ST.vehicles[0].pkgId, 'refresh');
    assert.match(box.ST.vehicles[0].vehicleLabel, /Explorer/);
    assert.equal(box.ST.vehicles[0].basePrice, 405);
    assert.doesNotMatch(box.ST.vehicles.map((v) => v.vehicleLabel).join(' '), /Dutchmen/);
  });
});

describe('price regression matrix (representative fixtures)', () => {
  const fixtures = [
    { cat: 'cars', pkgId: 'full', tierKey: 'small', label: 'sedan' },
    { cat: 'cars', pkgId: 'full', tierKey: 'suv2', label: '2-row SUV' },
    { cat: 'cars', pkgId: 'refresh', tierKey: 'suv3', label: '3-row SUV Explorer' },
    { cat: 'rvs', pkgId: 'maint_light', lengthFt: 27, rvType: 'travel', label: 'RV' },
    { cat: 'boats', pkgId: 'full', lengthFt: 22, boatType: 'runabout', label: 'Boat' },
    { cat: 'powersports', pkgId: 'full', tierKey: 'motorcycle', label: 'Motorcycle' },
    { cat: 'powersports', pkgId: 'full', tierKey: 'atv', label: 'ATV' },
    { cat: 'powersports', pkgId: 'full', tierKey: 'utv', label: 'UTV' },
  ];

  for (const fx of fixtures) {
    it(`${fx.label} package price is numeric`, () => {
      let price;
      if (fx.cat === 'rvs' || fx.cat === 'boats') {
        price = getLengthPrice(fx.cat, fx.pkgId, fx.lengthFt, fx.rvType || fx.boatType);
      } else {
        price = Number(PRICING[fx.cat].tiers[fx.tierKey][fx.pkgId]);
      }
      assert.ok(price > 0, fx.label + ' must be numeric, got ' + price);
      assert.notEqual(String(price).toLowerCase(), 'estimate');
    });
  }
});

describe('Review presentation after clean single-vehicle car booking', () => {
  it('Review total matches Explorer refresh price', () => {
    const vehicles = [{
      basePrice: 405,
      addonTotal: 0,
      subtotal: 405,
      pkgId: 'refresh',
      vehicleLabel: '2023 Ford Explorer',
      cat: 'cars',
      tierKey: 'suv3',
    }];
    const totals = Review.presentationTotals({
      vehicles,
      travelFeeAmount: 0,
      totalPrice: 405,
    });
    assert.equal(totals.estimatedTotal, 405);
  });
});
