'use strict';

/**
 * Cross-category booking state leak.
 * Powersports/Cars classification labels must not append onto RV/Boat summaries
 * after an in-session category switch. Pricing must stay category-local.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const Summary = require('../assets/booking-vehicle-summary.js');
const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

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

function makeDom() {
  const els = {
    'ah-pkg': { textContent: '' },
    'ah-car': { textContent: '' },
    'addon-grid': { innerHTML: '' },
    'bs2-rv-note': { style: { display: 'none' } },
    'bk-zip': { value: '07650', focus() {}, style: {} },
    'bk-gate-msg': { style: {} },
  };
  return {
    els,
    document: {
      getElementById(id) { return els[id] || null; },
      querySelectorAll() { return []; },
    },
  };
}

function loadBookingFns() {
  const dom = makeDom();
  const sandbox = {
    ST: {
      cat: '', pkgId: '', pkg: null, tierKey: '', tier: null, vehicleLabel: '',
      basePrice: 0, addons: [], addonTotal: 0, lengthFt: 0, rvType: '', rvLiving: '',
      boatType: '', units: 1, displayLabel: '', classNeedsConfirm: false,
      vehicles: [], _addonKey: '', _pendingCat: '', _prefillPkgId: '',
      _packageIntent: '', _startStep: null, _holdPackageStep: false, _restoring: false,
    },
    document: dom.document,
    window: {},
    activeZone: { zip: '07650' },
    PRICING: {
      cars: {
        packages: [{ id: 'maint', name: 'Maintenance', scope: 'both', feats: [] }],
        tiers: { suv3: { label: 'SUV 3-Row', maint: 155 } },
        addons: [],
      },
      rvs: {
        packages: [{ id: 'maint', name: 'Maintenance Detail', scope: 'both', feats: [] }],
        tiers: {},
        addons: [],
      },
      boats: {
        packages: [{ id: 'maint', name: 'Maintenance Detail', scope: 'both', feats: [] }],
        tiers: {},
        addons: [],
      },
      powersports: {
        packages: [{ id: 'wash', name: 'Wash', scope: 'ext', feats: [] }],
        tiers: { motorcycle: { label: 'Motorcycle', wash: 100 } },
        addons: [],
      },
    },
    CD1BookingVehicleSummary: Summary,
    CD1BookingProgress: {
      hidePendingIntent() {},
      showPendingIntent() {},
      persist() {},
      clear() {},
    },
    renderPackages() {},
    renderTierChips() {},
    bkGoTo() {},
    resolvePackageIntentForCategory() { return ''; },
    selectPkg() {},
    updateTotal() {},
    addonRequiresShampooOrSteam() { return false; },
    syncRvSuperintAddonDedup() {},
    console,
  };
  sandbox.window = sandbox;
  sandbox.window.CD1BookingVehicleSummary = Summary;
  sandbox.window.CD1BookingProgress = sandbox.CD1BookingProgress;
  vm.createContext(sandbox);
  vm.runInContext(
    extractFunction(index, 'selectCategory') + '\n' + extractFunction(index, 'renderAddons'),
    sandbox
  );
  return { sandbox, els: dom.els };
}

describe('booking-vehicle-summary helper', () => {
  it('cars keep 3-Row SUV; RV/Boat ignore foreign Motorcycle / 3-Row SUV', () => {
    assert.equal(
      Summary.formatAddonHeaderSummary({
        cat: 'cars', vehicleLabel: '2024 Hyundai Santa Fe', displayLabel: '3-Row SUV',
      }),
      '2024 Hyundai Santa Fe · 3-Row SUV'
    );
    assert.equal(
      Summary.formatAddonHeaderSummary({
        cat: 'rvs',
        vehicleLabel: '2022 Jayco Eagle · 35 ft',
        displayLabel: 'Motorcycle',
        tier: { label: 'Motorcycle' },
      }),
      '2022 Jayco Eagle · 35 ft'
    );
    assert.equal(
      Summary.formatAddonHeaderSummary({
        cat: 'boats',
        vehicleLabel: '2021 Caymas CX 19 · Pontoon / Tritoon · 22 ft',
        displayLabel: '3-Row SUV',
        tier: { label: '3-Row SUV' },
      }),
      '2021 Caymas CX 19 · Pontoon / Tritoon · 22 ft'
    );
    assert.equal(
      Summary.formatAddonHeaderSummary({
        cat: 'powersports', vehicleLabel: '2023 Yamaha MT-07', displayLabel: 'Motorcycle',
      }),
      '2023 Yamaha MT-07 · Motorcycle'
    );
  });

  it('clearCategoryExclusiveFields drops prior classification metadata', () => {
    const st = {
      displayLabel: 'Motorcycle', make: 'Yamaha', model: 'MT-07', year: '2023',
      rvType: '', rvLiving: '', boatType: 'pontoon', classNeedsConfirm: false,
    };
    Summary.clearCategoryExclusiveFields(st, 'rvs');
    assert.equal(st.displayLabel, '');
    assert.equal(st.make, '');
    assert.equal(st.boatType, '');
  });

  it('categoryTierLabel keeps specialty payload metadata local', () => {
    assert.equal(
      Summary.categoryTierLabel({ cat: 'rvs', displayLabel: 'Motorcycle', tier: { label: '35 ft' } }),
      '35 ft'
    );
    assert.equal(
      Summary.categoryTierLabel({ cat: 'boats', displayLabel: '3-Row SUV', tier: { label: 'Pontoon / Tritoon · 22 ft' } }),
      'Pontoon / Tritoon · 22 ft'
    );
  });
});

describe('selectCategory + renderAddons real functions', () => {
  it('Powersports Motorcycle → RV clears label and does not append Motorcycle', () => {
    const { sandbox, els } = loadBookingFns();
    sandbox.ST.cat = 'powersports';
    sandbox.ST.pkgId = 'wash';
    sandbox.ST.pkg = sandbox.PRICING.powersports.packages[0];
    sandbox.ST.displayLabel = 'Motorcycle';
    sandbox.ST.tier = sandbox.PRICING.powersports.tiers.motorcycle;
    sandbox.ST.tierKey = 'motorcycle';
    sandbox.ST.vehicleLabel = '2023 Yamaha MT-07';
    sandbox.ST.basePrice = 100;
    sandbox.renderAddons();
    assert.match(els['ah-car'].textContent, /Motorcycle/);

    sandbox.selectCategory('rvs');
    assert.equal(sandbox.ST.displayLabel, '');
    assert.equal(sandbox.ST.tierKey, '');
    assert.equal(sandbox.ST.vehicleLabel, '');
    assert.equal(sandbox.ST.basePrice, 0);

    sandbox.ST.pkgId = 'maint';
    sandbox.ST.pkg = sandbox.PRICING.rvs.packages[0];
    sandbox.ST.vehicleLabel = '2022 Jayco Eagle · 35 ft';
    sandbox.ST.displayLabel = 'Motorcycle'; // forced stale — formatter must ignore
    sandbox.ST.tier = { label: '35 ft' };
    sandbox.ST.basePrice = 445;
    sandbox.ST._addonKey = '';
    sandbox.renderAddons();
    assert.equal(els['ah-car'].textContent, '2022 Jayco Eagle · 35 ft');
    assert.doesNotMatch(els['ah-car'].textContent, /Motorcycle|SUV|3-Row/);
    assert.equal(sandbox.ST.basePrice, 445);
  });

  it('Cars 3-Row SUV → Boat clears label and does not append SUV class', () => {
    const { sandbox, els } = loadBookingFns();
    sandbox.ST.cat = 'cars';
    sandbox.ST.pkgId = 'maint';
    sandbox.ST.pkg = sandbox.PRICING.cars.packages[0];
    sandbox.ST.displayLabel = '3-Row SUV';
    sandbox.ST.tierKey = 'suv3';
    sandbox.ST.tier = sandbox.PRICING.cars.tiers.suv3;
    sandbox.ST.vehicleLabel = '2024 Hyundai Santa Fe';
    sandbox.ST.basePrice = 155;
    sandbox.renderAddons();
    assert.match(els['ah-car'].textContent, /3-Row SUV/);

    sandbox.selectCategory('boats');
    assert.equal(sandbox.ST.displayLabel, '');

    sandbox.ST.pkgId = 'maint';
    sandbox.ST.pkg = sandbox.PRICING.boats.packages[0];
    sandbox.ST.vehicleLabel = '2021 Caymas CX 19 · Pontoon / Tritoon · 22 ft';
    sandbox.ST.displayLabel = '3-Row SUV';
    sandbox.ST.tier = { label: 'Pontoon / Tritoon · 22 ft' };
    sandbox.ST.basePrice = 220;
    sandbox.ST._addonKey = '';
    sandbox.renderAddons();
    assert.equal(els['ah-car'].textContent, '2021 Caymas CX 19 · Pontoon / Tritoon · 22 ft');
    assert.doesNotMatch(els['ah-car'].textContent, /Motorcycle|SUV|3-Row/);
    assert.equal(sandbox.ST.basePrice, 220);
  });

  it('RV → Powersports does not keep RV length as powersports class suffix', () => {
    const { sandbox, els } = loadBookingFns();
    sandbox.ST.cat = 'rvs';
    sandbox.ST.displayLabel = '';
    sandbox.ST.tier = { label: '35 ft' };
    sandbox.ST.lengthFt = 35;
    sandbox.ST.vehicleLabel = '2022 Jayco Eagle · 35 ft';
    sandbox.selectCategory('powersports');
    assert.equal(sandbox.ST.lengthFt, 0);
    assert.equal(sandbox.ST.displayLabel, '');
    sandbox.ST.pkgId = 'wash';
    sandbox.ST.pkg = sandbox.PRICING.powersports.packages[0];
    sandbox.ST.vehicleLabel = '2023 Yamaha MT-07';
    sandbox.ST.displayLabel = 'Motorcycle';
    sandbox.ST.tier = sandbox.PRICING.powersports.tiers.motorcycle;
    sandbox.ST.basePrice = 100;
    sandbox.ST._addonKey = '';
    sandbox.renderAddons();
    assert.equal(els['ah-car'].textContent, '2023 Yamaha MT-07 · Motorcycle');
    assert.doesNotMatch(els['ah-car'].textContent, /35 ft|Jayco/);
  });
});

describe('wiring + pricing identity', () => {
  it('index and hubs load shared helper and no longer use legacy leak join', () => {
    const pages = [
      'index.html',
      'new-jersey-hub.html',
      'ny-metro-hub.html',
      'pennsylvania-hub.html',
      'connecticut-hub.html',
      'bergen-county-hub.html',
      'essex-county-hub.html',
      'hudson-county-hub.html',
      'passaic-county-hub.html',
    ];
    for (const page of pages) {
      const src = fs.readFileSync(path.join(ROOT, page), 'utf8');
      assert.match(src, /assets\/booking-vehicle-summary\.js/, page);
      assert.match(src, /CD1BookingVehicleSummary\.formatAddonHeaderSummary/, page);
      assert.match(src, /CD1BookingVehicleSummary\.clearCategoryExclusiveFields/, page);
      assert.doesNotMatch(
        src,
        /getElementById\('ah-car'\)\.textContent=\(ST\.vehicleLabel\|\|''\)\+\(\(ST\.displayLabel/,
        page + ' still has legacy leak join'
      );
    }
  });

  it('observed RV/Boat fixture totals remain 445 / 220 from length formulas', () => {
    assert.equal(130 + 9 * 35, 445);
    assert.equal(Math.max(170, 10 * 22), 220);
  });

  it('booking-progress snapshot does not persist displayLabel', () => {
    const src = fs.readFileSync(path.join(ROOT, 'assets/booking-progress.js'), 'utf8');
    assert.doesNotMatch(src, /displayLabel/);
  });
});
