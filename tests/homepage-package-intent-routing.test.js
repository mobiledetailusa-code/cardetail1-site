'use strict';

/**
 * Homepage Popular Services: package intent ≠ vehicle category.
 * Homepage CTAs must not silently choose Cars.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const index = read('index.html');
const progressSrc = read('assets/booking-progress.js');
const gateSrc = read('assets/booking-routing-gate.js');
const hubBridge = read('assets/hub-booking-bridge.js');
const modalJs = read('assets/car-pkg-detail-modal.js');

const { PRICING } = require('../netlify/lib/booking-price-catalog');

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

function catalogPackageIds(cat) {
  const pricingStart = index.indexOf('let PRICING = {');
  const pricingEnd = index.indexOf('\nlet LENGTH_PRICING', pricingStart);
  const block = index.slice(pricingStart, pricingEnd > 0 ? pricingEnd : pricingStart + 40000);
  const catStart = block.search(new RegExp('\\n  ' + cat + ':\\s*\\{'));
  assert.ok(catStart >= 0, 'missing PRICING.' + cat);
  const fromCat = block.slice(catStart);
  const pkgs = fromCat.indexOf('packages:[');
  const end = fromCat.indexOf('\n    ],', pkgs);
  const pkgBlock = fromCat.slice(pkgs, end);
  return [...pkgBlock.matchAll(/\{id:'([^']+)'/g)].map((m) => m[1]);
}

function loadProgress(overrides) {
  const store = {};
  const ctx = {
    window: {},
    document: {
      readyState: 'complete',
      addEventListener() {},
      getElementById() { return null; },
    },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    sessionStorage: {
      getItem() { return null; },
      setItem() {},
      removeItem() {},
    },
    location: { search: '', pathname: '/' },
    URLSearchParams,
    ST: { cat: '', pkgId: '', vehicles: [], addons: [] },
    currentBkStep: 1,
    activeZone: { key: 'nj_a' },
    setTimeout(fn) { if (typeof fn === 'function') fn(); return 0; },
    console,
  };
  Object.assign(ctx, overrides);
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(progressSrc, ctx);
  ctx.__store = store;
  return ctx;
}

function loadResolver() {
  const sandbox = {
    PRICING: {
      cars: { packages: catalogPackageIds('cars').map((id) => ({ id })) },
      boats: { packages: catalogPackageIds('boats').map((id) => ({ id })) },
      rvs: { packages: catalogPackageIds('rvs').map((id) => ({ id })) },
      powersports: { packages: catalogPackageIds('powersports').map((id) => ({ id })) },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction(index, 'resolvePackageIntentForCategory'), sandbox);
  return sandbox;
}

function loadSelectCategory() {
  const sandbox = {
    ST: {
      cat: '', pkgId: '', pkg: null, tierKey: '', tier: null, vehicleLabel: '',
      basePrice: 0, addons: [], addonTotal: 0, lengthFt: 0, rvType: '', rvLiving: '',
      boatType: '', units: 1, _addonKey: '', _packageIntent: '', _prefillPkgId: '',
      _startStep: null, _pendingCat: '', _holdPackageStep: false,
    },
    PRICING: {
      cars: { packages: catalogPackageIds('cars').map((id) => ({ id })) },
      boats: { packages: catalogPackageIds('boats').map((id) => ({ id })) },
      rvs: { packages: catalogPackageIds('rvs').map((id) => ({ id })) },
      powersports: { packages: catalogPackageIds('powersports').map((id) => ({ id })) },
    },
    activeZone: { key: 'nj_a' },
    currentBkStep: 1,
    steps: [],
    selected: [],
    advanced: false,
    document: {
      getElementById(id) {
        if (id === 'bk-zip') return { value: '07650', focus() {}, style: {} };
        if (id === 'bs2-rv-note') return { style: {} };
        if (id === 'bk-gate-msg') return { style: {}, offsetWidth: 0 };
        if (String(id).startsWith('pk-')) return { id };
        if (String(id).startsWith('bkcat-')) return { classList: { add() {} } };
        return null;
      },
      querySelectorAll() { return []; },
    },
    openCommercialInquiry() {},
    renderPackages() {},
    renderTierChips() {},
    bkGoTo(n) { sandbox.steps.push(n); sandbox.currentBkStep = n; },
    requestAnimationFrame(fn) { fn(); },
    bkContinueFromPackage() { sandbox.advanced = true; },
    setTimeout(fn) { fn(); return 0; },
    CD1BookingProgress: {
      showPendingIntent() {},
      hidePendingIntent() {},
      persist() {},
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    extractFunction(index, 'resolvePackageIntentForCategory') + '\n' +
    extractFunction(index, 'selectCategory') + '\n' +
    'function selectPkg(id){ ST.pkgId=id; ST.pkg=(PRICING[ST.cat].packages||[]).find(function(p){return p.id===id;})||{id:id}; selected.push(id); if(ST.pkg && currentBkStep < 3 && !ST._restoring && !ST._holdPackageStep) bkContinueFromPackage(); }',
    sandbox
  );
  return sandbox;
}

describe('canonical package ids (no invented products)', () => {
  it('homepage featured ids exist on cars; full exists across categories; interior exists on RV', () => {
    const cars = catalogPackageIds('cars');
    const rvs = catalogPackageIds('rvs');
    const boats = catalogPackageIds('boats');
    const ps = catalogPackageIds('powersports');
    assert.deepEqual(['interior', 'full', 'refresh'].every((id) => cars.includes(id)), true);
    assert.equal(rvs.includes('interior'), true);
    assert.equal(rvs.includes('full'), true);
    assert.equal(rvs.includes('premium'), true);
    assert.equal(rvs.includes('refresh'), false);
    assert.equal(boats.includes('full'), true);
    assert.equal(boats.includes('premium'), true);
    assert.equal(boats.includes('interior'), false);
    assert.equal(ps.includes('full'), true);
    assert.equal(ps.includes('premium'), true);
    assert.equal(ps.includes('interior'), false);
  });
});

describe('1–3 homepage package CTA keeps intent, not Cars', () => {
  for (const pkgId of ['interior', 'full', 'refresh']) {
    it(`Homepage ${pkgId} CTA retains package intent and does not force Cars`, () => {
      assert.match(index, new RegExp(`class="car-pkg-cta" onclick="openBookingCarPkg\\('${pkgId}'\\)"`));
      const fn = extractFunction(index, 'openBookingCarPkg');
      assert.match(fn, /ST\._packageIntent\s*=\s*pkgId/);
      assert.match(fn, /openBookingFromHome\(null\)/);
      assert.doesNotMatch(fn, /openBookingFromHome\('cars'\)/);
      assert.doesNotMatch(fn, /ST\._startStep\s*=\s*3/);
      assert.match(fn, /ST\.cat\s*=\s*''/);

      const opened = [];
      const sandbox = {
        ST: { cat: 'cars', pkgId: 'wash', pkg: { id: 'wash' }, _pendingCat: 'cars', _startStep: 3 },
        window: {},
        CD1BookingProgress: {
          showPendingIntent(cat, pkg) { sandbox.shown = [cat, pkg]; },
          persist() { sandbox.persisted = true; },
        },
        openBookingFromHome(cat) { opened.push(cat); },
      };
      sandbox.window = sandbox;
      vm.createContext(sandbox);
      vm.runInContext(fn, sandbox);
      sandbox.openBookingCarPkg(pkgId);
      assert.equal(sandbox.ST.cat, '');
      assert.equal(sandbox.ST._pendingCat, '');
      assert.equal(sandbox.ST._packageIntent, pkgId);
      assert.equal(sandbox.ST._prefillPkgId, pkgId);
      assert.equal(sandbox.ST._startStep, null);
      assert.deepEqual(opened, [null]);
      assert.deepEqual(sandbox.shown, ['', pkgId]);
      assert.equal(sandbox.persisted, true);
    });
  }

  it('See what\'s included still books through openBookingCarPkg (same intent path)', () => {
    assert.match(modalJs, /openBookingCarPkg\(pkgId\)/);
    assert.doesNotMatch(modalJs, /openBookingFromHome\('cars'\)/);
  });

  it('routing gate no longer classifies homepage package CTAs as Cars', () => {
    assert.match(gateSrc, /source: 'openBookingCarPkg'/);
    assert.doesNotMatch(gateSrc, /category: 'cars', source: 'openBookingCarPkg'/);
    assert.match(gateSrc, /category: '', source: 'openBookingCarPkg'/);
    assert.match(hubBridge, /openDelegatedBooking\(null, args\[0\]/);
    assert.doesNotMatch(hubBridge, /openDelegatedBooking\('cars', args\[0\]/);
  });
});

describe('4–5 customer chooses category after homepage intent', () => {
  it('Cars keeps the intended package selected and does not skip past package step', () => {
    const box = loadSelectCategory();
    box.ST._packageIntent = 'interior';
    box.ST._prefillPkgId = 'interior';
    box.selectCategory('cars');
    assert.equal(box.ST.cat, 'cars');
    assert.equal(box.ST.pkgId, 'interior');
    assert.equal(box.advanced, false);
    assert.ok(box.steps.includes(2));
    assert.ok(!box.steps.includes(3));
  });

  it('Full Detail stays selected on Cars', () => {
    const box = loadSelectCategory();
    box.ST._packageIntent = 'full';
    box.selectCategory('cars');
    assert.equal(box.ST.cat, 'cars');
    assert.equal(box.ST.pkgId, 'full');
    assert.equal(box.advanced, false);
  });

  it('Exterior Refresh stays selected on Cars', () => {
    const box = loadSelectCategory();
    box.ST._packageIntent = 'refresh';
    box.selectCategory('cars');
    assert.equal(box.ST.cat, 'cars');
    assert.equal(box.ST.pkgId, 'refresh');
  });

  it('RV path does not force Cars; interior and full map to real RV packages', () => {
    const r = loadResolver();
    assert.equal(r.resolvePackageIntentForCategory('rvs', 'interior'), 'interior');
    assert.equal(r.resolvePackageIntentForCategory('rvs', 'full'), 'full');
    assert.equal(r.resolvePackageIntentForCategory('rvs', 'refresh'), 'premium');
    const box = loadSelectCategory();
    box.ST._packageIntent = 'interior';
    box.selectCategory('rvs');
    assert.equal(box.ST.cat, 'rvs');
    assert.notEqual(box.ST.cat, 'cars');
    assert.equal(box.ST.pkgId, 'interior');
    assert.equal(box.advanced, false);
  });

  it('Boat and powersports keep full; interior has no fake package', () => {
    const r = loadResolver();
    assert.equal(r.resolvePackageIntentForCategory('boats', 'full'), 'full');
    assert.equal(r.resolvePackageIntentForCategory('powersports', 'full'), 'full');
    assert.equal(r.resolvePackageIntentForCategory('boats', 'interior'), '');
    assert.equal(r.resolvePackageIntentForCategory('powersports', 'interior'), '');
    assert.equal(r.resolvePackageIntentForCategory('boats', 'refresh'), 'premium');
    assert.equal(r.resolvePackageIntentForCategory('powersports', 'refresh'), 'premium');
    const box = loadSelectCategory();
    box.ST._packageIntent = 'interior';
    box.selectCategory('boats');
    assert.equal(box.ST.cat, 'boats');
    assert.equal(box.ST.pkgId, '');
    assert.equal(box.advanced, false);
    assert.ok(box.steps.includes(2));
  });
});

describe('6–7 explicit category deep links stay preselected', () => {
  it('RV deep-link still pending-selects rvs', () => {
    assert.match(index, /ST\._pendingCat=book/);
    assert.match(index, /allowed=\{cars:1,boats:1,rvs:1,powersports:1\}/);
    const q = index.slice(index.indexOf('function openBookingFromQuery'), index.indexOf('__cd1PendingBookQuery={book:book'));
    assert.match(q, /if\(pkg\)/);
    assert.doesNotMatch(index, /ST\._pendingCat\s*=\s*'cars'/);
  });

  it('Boat deep-link and specialty openBookingPkg still preselect category', () => {
    const pkgFn = extractFunction(index, 'openBookingPkg');
    assert.match(pkgFn, /openBookingFromHome\(cat\)/);
    assert.match(pkgFn, /ST\._startStep=3/);
    assert.match(index, /params\.get\('book'\)/);
    assert.match(gateSrc, /ST\._pendingCat = pending\.book/);
  });
});

describe('8 ZIP gate does not erase package/category intent', () => {
  it('ZIP unlock only auto-selects a pending category, never invents Cars', () => {
    const zipFn = extractFunction(index, 'onBkZipInput');
    assert.match(zipFn, /if\(ST\._pendingCat\)/);
    assert.match(zipFn, /selectCategory\(pending\)/);
    assert.doesNotMatch(zipFn, /selectCategory\('cars'\)/);
    assert.match(index, /CD1BookingProgress\.showPendingIntent\(cat, ST\._packageIntent\)/);
  });

  it('package-only snapshot survives persist/load without becoming Cars', () => {
    const ctx = loadProgress();
    ctx.ST._packageIntent = 'interior';
    ctx.ST.cat = '';
    ctx.ST.pkgId = '';
    const snap = ctx.CD1BookingProgress.persist();
    assert.equal(snap.packageIntent, 'interior');
    assert.equal(snap.ST.cat, '');
    ctx.ST._packageIntent = '';
    const loaded = ctx.CD1BookingProgress.load();
    assert.equal(loaded.packageIntent, 'interior');
    assert.equal(loaded.ST.cat, '');
    ctx.CD1BookingProgress.applySnapshot(loaded);
    assert.equal(ctx.ST.cat, '');
    assert.equal(ctx.ST._packageIntent, 'interior');
  });
});

describe('9 resume does not convert non-car intent to Cars', () => {
  it('RV snapshot resumes as RV', () => {
    let selected = null;
    const ctx = loadProgress({
      selectCategory(cat) { selected = cat; ctx.ST.cat = cat; },
      selectPkg(id) { ctx.ST.pkgId = id; },
    });
    const snap = {
      v: 1,
      savedAt: Date.now(),
      packageIntent: 'interior',
      pendingCat: '',
      ST: { cat: 'rvs', pkgId: 'interior', vehicles: [], addons: [] },
      fields: {},
    };
    ctx.CD1BookingProgress.applySnapshot(snap);
    assert.equal(selected, 'rvs');
    assert.equal(ctx.ST.cat, 'rvs');
    assert.notEqual(ctx.ST.cat, 'cars');
    assert.equal(ctx.ST._packageIntent, 'interior');
  });

  it('package-only resume does not invent Cars', () => {
    let selected = 'unset';
    const ctx = loadProgress({
      selectCategory(cat) { selected = cat; ctx.ST.cat = cat; },
      location: { search: '?resume=1', pathname: '/' },
      openBooking(cat) { ctx._opened = cat; },
      bkGoTo() {},
    });
    ctx.__store.cd1_booking_progress = JSON.stringify({
      v: 1,
      savedAt: Date.now(),
      packageIntent: 'full',
      ST: { cat: '', pkgId: '', vehicles: [], addons: [] },
      fields: {},
    });
    const result = ctx.CD1BookingProgress.resumeFromQuery();
    assert.equal(result.opened, true);
    assert.equal(ctx._opened, null);
    assert.equal(selected, 'unset');
    assert.equal(ctx.ST.cat, '');
    assert.equal(ctx.ST._packageIntent, 'full');
  });

  it('resume routing gate does not hard-code Cars', () => {
    assert.doesNotMatch(gateSrc, /category: 'cars', source: 'resume_link'/);
    assert.match(gateSrc, /source: 'resume_link'/);
  });
});

describe('10 pricing / payment behavior unchanged', () => {
  it('car, RV, boat, and powersports dollar amounts are unchanged', () => {
    assert.equal(PRICING.cars.tiers.small.interior, 190);
    assert.equal(PRICING.cars.tiers.small.full, 240);
    assert.equal(PRICING.cars.tiers.small.refresh, 320);
    assert.match(index, /interior:\s*190/);
    assert.match(index, /full:\s*240/);
    assert.match(index, /refresh:\s*320/);
    assert.match(index, /maint:\s*\{perFt:\s*10,\s*min:\s*170\}/);
    const bs5 = index.slice(index.indexOf('id="bs5"'), index.indexOf('id="bs6"'));
    assert.match(bs5, /onclick="submitBooking\(\)"/);
    assert.doesNotMatch(bs5, /id="stripe-auth-btn"/);
    assert.doesNotMatch(bs5, /create-setup-intent/);
  });
});
