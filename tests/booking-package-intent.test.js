'use strict';

/**
 * Book-this-package keeps the chosen category and catalog package.
 * The URL and the DOM do not set price. These tests do not submit,
 * charge, send SMS, or fire a booking conversion.
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

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'missing ' + name);
  let i = start;
  let paren = 0;
  let seenParen = false;
  for (; i < src.length; i++) {
    if (src[i] === '(') { paren++; seenParen = true; }
    else if (src[i] === ')') {
      paren--;
      if (seenParen && paren === 0) { i++; break; }
    }
  }
  while (src[i] === ' ' || src[i] === '\n' || src[i] === '\r') i++;
  assert.equal(src[i], '{', name + ' body');
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

function classList() {
  const set = new Set();
  return {
    add(...names) { names.forEach((n) => set.add(n)); },
    remove(...names) { names.forEach((n) => set.delete(n)); },
    toggle(name, on) {
      const force = on === undefined ? !set.has(name) : !!on;
      if (force) set.add(name); else set.delete(name);
      return force;
    },
    contains(name) { return set.has(name); },
  };
}

function makeEl(id) {
  return {
    id,
    classList: classList(),
    hidden: false,
    value: '',
    textContent: '',
    innerHTML: '',
    style: {},
    disabled: false,
    type: '',
    tabIndex: 0,
    onclick: null,
    children: [],
    setAttribute(name, value) { this[name] = value; },
    getAttribute(name) { return this[name] == null ? null : String(this[name]); },
    scrollIntoView() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

const CARS_PACKAGES = [
  { id: 'interior', name: 'Interior Detail', dur: '~1.5–2h' },
  { id: 'full', name: 'Premium Full Detail', dur: '~2.5–3h' },
  { id: 'refresh', name: 'Exterior Refresh & Protect', dur: '~3.5–4h' },
  { id: 'ceramic_1yr', name: 'Professional Ceramic Protection — Up to 1 Year', dur: '8 hours' },
  { id: 'ceramic_3yr', name: 'Professional Ceramic Protection — Up to 3 Years', dur: '10 hours' },
];

const PRICING = {
  cars: {
    packages: CARS_PACKAGES,
    tiers: {
      small: { interior: 200, full: 250, refresh: 335, ceramic_1yr: 650, ceramic_3yr: 1050, label: 'Small Car' },
      suv3: { interior: 255, full: 310, refresh: 430, ceramic_1yr: 825, ceramic_3yr: 1275, label: 'SUV 3-Row' },
    },
  },
  boats: {
    packages: [
      { id: 'maint', name: 'Marine Wash', dur: '~1.5–2h' },
      { id: 'full', name: 'Full Marine Detail', dur: '~4–6h' },
    ],
    tiers: { under20: { maint: 235, full: 525 } },
  },
  rvs: {
    packages: [
      { id: 'interior', name: 'Interior Detail', dur: 'Planning estimate' },
      { id: 'exterior_wash', name: 'Exterior Wash', dur: 'Planning estimate' },
    ],
    tiers: { travel: { interior: 405 } },
  },
  powersports: {
    packages: [
      { id: 'maintenance', name: 'Maintenance Detail', dur: 'Service duration depends on machine type and condition.' },
      { id: 'restore', name: 'Correction / Restoration Detail', dur: 'Service duration depends on machine type and condition.' },
    ],
    tiers: { motorcycle: { maintenance: 180, restore: 250 } },
  },
  trucks: {
    packages: [
      { id: 'interior', name: 'Interior Detail', dur: '~2–3h' },
      { id: 'int_wash', name: 'Interior + Wash', dur: '~3–4h' },
    ],
    tiers: { day_cab: { interior: 295, int_wash: 415, label: 'Day Cab / Single Cab' } },
  },
};

function boot(opts) {
  opts = opts || {};
  const posts = [];
  const logs = [];
  const focusState = { current: null, log: [] };
  const timers = [];
  const frames = [];
  const els = {};
  function el(id) {
    if (!els[id]) {
      const node = makeEl(id);
      node.focus = function focus() { focusState.current = node; focusState.log.push(node.id); };
      els[id] = node;
    }
    return els[id];
  }

  const titles = {
    bs1: el('bs1-title'),
    bs2: el('bs2-title'),
    bs3: el('bs3-title'),
  };
  titles.bs1.textContent = 'WHAT ARE WE DETAILING?';
  titles.bs2.textContent = 'CHOOSE YOUR PACKAGE';
  titles.bs3.textContent = 'YOUR VEHICLE';
  const sections = {
    bs1: el('bs1'),
    bs2: el('bs2'),
    bs3: el('bs3'),
  };
  sections.bs1.querySelector = (sel) => (sel === '.btitle' ? titles.bs1 : sel === '.beye' ? el('bs1-eye') : sel === '.bdesc' ? el('bs1-desc') : null);
  sections.bs2.querySelector = (sel) => (sel === '.btitle' ? titles.bs2 : null);
  sections.bs3.querySelector = (sel) => (sel === '.btitle' ? titles.bs3 : null);
  const grid = el('bk-cat-grid');
  const pkgGrid = el('pkg-grid');
  const cards = {};
  for (const cat of Object.keys(PRICING)) {
    for (const pkg of PRICING[cat].packages) cards[pkg.id] = el('pk-' + pkg.id);
  }
  pkgGrid.querySelectorAll = () => Object.values(cards);

  const api = {
    posts,
    logs,
    get focused() { return focusState.current; },
    get focusLog() { return focusState.log; },
    flushFrames() {
      const queued = frames.splice(0);
      queued.forEach((fn) => fn());
    },
    flushTimers() {
      const queued = timers.splice(0);
      queued.forEach((fn) => fn());
    },
    activate(node, key) {
      node.focus();
      if (node.type === 'button' && !node.disabled && (key === 'Enter' || key === ' ')) node.onclick();
    },
  };

  const session = { cd1_zip: opts.zip || '' };
  const store = {};
  const sandbox = {
    ST: {
      cat: '', pkgId: '', pkg: null, tierKey: '', tier: null, vehicleLabel: '', displayLabel: '',
      basePrice: 0, addons: [], addonTotal: 0, lengthFt: 0, rvType: '', rvLiving: '', boatType: '',
      truckCab: '', units: 1, _addonKey: '', _packageIntent: '', _prefillPkgId: '', _startStep: null,
      _pendingCat: '', _holdPackageStep: false, _intentLocked: false, _forceMultiVehicle: false,
      vehicles: [], bookingId: '', draftSaveToken: null, cardToken: '', cardLast4: '', cardBrand: '',
      _restoring: false, _startingAdditionalVehicle: false, _editingVehicleIndex: null,
    },
    PRICING,
    activeZone: opts.zone === undefined ? { key: 'nj_a' } : opts.zone,
    currentBkStep: 1,
    _bkPrevStep: 1,
    BK_VISIBLE_STEPS: 6,
    richMultiplier: 1,
    posts,
    console: { info(...args) { logs.push(args); }, warn() {}, error() {} },
    CD1PowersportsBookingSafety: { resolvePriceTier(key) { return key; } },
    CD1BookingProgress: {
      showPendingIntent() {},
      hidePendingIntent() {},
      persist() { sandbox.persisted = true; },
    },
    CD1BookingVehicleSummary: { clearCategoryExclusiveFields() {} },
    requestAnimationFrame(fn) { frames.push(fn); return frames.length; },
    setTimeout(fn) { timers.push(fn); return timers.length; },
    document: {
      body: { style: {}, children: [] },
      documentElement: { classList: classList() },
      getElementById(id) { return el(id); },
      querySelector(sel) {
        const m = /^#bs(\d) \.btitle$/.exec(sel);
        if (m) return titles['bs' + m[1]] || null;
        return null;
      },
      querySelectorAll(sel) {
        if (sel === '.bsec') return [sections.bs1, sections.bs2, sections.bs3];
        if (sel === '.bpt') return [el('bpt1'), el('bpt2'), el('bpt3')];
        if (sel === '#bk-cat-grid .svc-card') return [el('bkcat-cars'), el('bkcat-boats')];
        if (sel === '.tchip') return [];
        return [];
      },
    },
    sessionStorage: {
      getItem(k) { return session[k] == null ? null : session[k]; },
      setItem(k, v) { session[k] = String(v); },
      removeItem(k) { delete session[k]; },
    },
    localStorage: {
      getItem(k) { return store[k] == null ? null : store[k]; },
      setItem(k, v) { store[k] = String(v); posts.push(['storage', k]); },
      removeItem(k) { delete store[k]; },
    },
    history: { replaceState() { posts.push(['replaceState']); } },
    fetch() { posts.push(['fetch']); return Promise.resolve({ ok: true, json() { return {}; } }); },
    gtag() { posts.push(['gtag', ...arguments]); },
    navigator: { sendBeacon() { posts.push(['beacon']); return true; } },
    XMLHttpRequest: function XMLHttpRequest() { posts.push(['xhr']); },
    alert() { posts.push(['alert']); },
    applyRichPrice(base) { return base ? Math.round(base) : 0; },
    updateVcPriceDisplay() {},
    updateTotal() {},
    getTravelFeeAmount() { return 0; },
    resetVehicleEntryFields() {},
    renderPackages() {},
    renderTierChips() {},
    renderVehicleCart() {},
    syncBookingProgressLabels() {},
    syncPackageStepChrome() {},
    syncVehicleStepChrome() {},
    syncBs2StickyBar() {},
    syncActiveConfigIntoEditingCartSlot() {},
    updateRvServiceSubtotal() {},
    openCommercialInquiry() { posts.push(['commercial']); },
    setupLengthSelector() {},
    setupUnitSelector() {},
    setVcName() {},
    syncContinueGate() {},
    renderAddons() {},
    tryGenericConfirm() {},
    syncTierChipsVisibility() {},
    MODELS: {},
    __store: store,
    __session: session,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  el('bk-zip').value = opts.zip || '';
  el('bk-ov');
  el('back2').type = 'button';
  el('back3').type = 'button';
  el('next2').type = 'button';
  el('bs2-rv-note').style = {};
  el('bk-gate-msg').style = { animation: '' };
  el('bk-gate-msg').offsetWidth = 0;

  const names = [
    'clearPendingCategoryForDirectOpen',
    'setZipOnlyGate',
    'logBookingIntent',
    'syncBookingZipFromHero',
    'bkPanelsForStep',
    'carsVehicleFirstFlow',
    'progressTabForPanel',
    'bkGoTo',
    'bkContinueFromPackage',
    'bkBackFromPackage',
    'bkBackFromVehicle',
    'resolvePackageIntentForCategory',
    'applyBookingQueryIntent',
    'selectCategory',
    'selectPkg',
    'resolveTierPackagePrice',
    'isPublishedPricedPackage',
    'setBasePrice',
    'selectTier',
    'openBooking',
    'openBookingFromHome',
    'openBookingCarPkg',
    'openHomeCeramic',
    'openBookingPkg',
  ];
  vm.createContext(sandbox);
  vm.runInContext(names.map((name) => extractFunction(index, name)).join('\n'), sandbox);
  sandbox.document.getElementById('back3').onclick = () => sandbox.bkBackFromVehicle();
  sandbox.document.getElementById('back2').onclick = () => sandbox.bkBackFromPackage();
  sandbox.api = api;
  sandbox.logs = logs;
  sandbox.sections = sections;
  sandbox.cards = cards;
  sandbox.titles = titles;
  return sandbox;
}

function land(box) {
  box.api.flushFrames();
  box.api.flushTimers();
}

function openPackage(box, cat, pkgId) {
  box.ST._packageIntent = pkgId;
  box.ST._prefillPkgId = pkgId;
  box.ST._startStep = 3;
  box.ST._intentLocked = true;
  box.ST.basePrice = 99999;
  box.selectCategory(cat);
  land(box);
}

describe('catalog authority for the audited CTAs', () => {
  it('browser catalog still owns the sedan and 3-row prices used below', () => {
    assert.match(index, /label:'Small Car'[^}]*interior:200[^}]*full:250[^}]*refresh:335[^}]*ceramic_1yr:650[^}]*ceramic_3yr:1050/);
    assert.match(index, /label:'SUV 3-Row'[^}]*interior:255[^}]*full:310[^}]*refresh:430[^}]*ceramic_1yr:825[^}]*ceramic_3yr:1275/);
    assert.match(index, /day_cab:[^}]*interior:295/);
    assert.match(index, /id:'maintenance'/);
    assert.match(index, /id:'maint',\s*name:'Marine Wash'/);
    assert.doesNotMatch(extractFunction(index, 'applyBookingQueryIntent'), /basePrice|params\.get\('price'\)/);
    assert.doesNotMatch(extractFunction(index, 'openBookingCarPkg'), /gtag|submit-booking|PaymentIntent|fetch\(/);
  });
});

describe('1 Interior CTA without ZIP', () => {
  it('asks for ZIP, keeps the package, then opens the vehicle step', () => {
    const box = boot({ zip: '', zone: null });
    box.openBookingCarPkg('interior');
    assert.equal(box.posts.length, 0);
    assert.equal(box.currentBkStep, 1);
    assert.equal(box.ST._pendingCat, 'cars');
    assert.equal(box.ST._packageIntent, 'interior');
    assert.equal(box.ST._startStep, 3);
    assert.equal(box.ST.pkgId, '');
    assert.equal(box.ST.basePrice, 0);
    assert.equal(box.document.getElementById('bk-cat-grid').hidden, true);
    assert.equal(box.document.getElementById('bs1-title').textContent, 'Confirm your ZIP');
    assert.equal(box.api.focused.id, 'bk-zip');

    box.document.getElementById('bk-zip').value = '07601';
    box.activeZone = { key: 'nj_a' };
    box.selectCategory(box.ST._pendingCat);
    land(box);
    assert.equal(box.ST.cat, 'cars');
    assert.equal(box.ST.pkgId, 'interior');
    assert.equal(box.ST.pkg.dur, '~1.5–2h');
    assert.equal(box.currentBkStep, 3);
    assert.equal(box.ST.basePrice, 0);
    assert.equal(box.posts.filter((p) => p[0] === 'fetch' || p[0] === 'gtag' || p[0] === 'beacon' || p[0] === 'xhr').length, 0);
  });
});

describe('2 Interior CTA with ZIP already valid', () => {
  it('opens on the vehicle step with Interior selected', () => {
    const box = boot({ zip: '07601' });
    box.ST._pendingCat = 'cars';
    box.openBookingCarPkg('interior');
    land(box);
    assert.equal(box.ST.cat, 'cars');
    assert.equal(box.ST.pkgId, 'interior');
    assert.equal(box.currentBkStep, 3);
    assert.equal(box.sections.bs3.classList.contains('on'), true);
    assert.equal(box.sections.bs1.classList.contains('on'), false);
    assert.equal(box.sections.bs2.classList.contains('on'), false);
    assert.equal(box.api.focused.id, 'bs3-title');
    assert.equal(box.api.focused.textContent, 'YOUR VEHICLE');
    assert.equal(box.posts.length, 0);
  });
});

describe('3–6 car package CTAs', () => {
  for (const [pkgId, dur] of [
    ['full', '~2.5–3h'],
    ['refresh', '~3.5–4h'],
    ['ceramic_1yr', '8 hours'],
    ['ceramic_3yr', '10 hours'],
  ]) {
    it(`${pkgId} opens on the vehicle step and keeps that package`, () => {
      const box = boot({ zip: '07601' });
      const opener = pkgId.startsWith('ceramic') ? 'openHomeCeramic' : 'openBookingCarPkg';
      box[opener](pkgId);
      land(box);
      assert.equal(box.ST.cat, 'cars');
      assert.equal(box.ST.pkgId, pkgId);
      assert.equal(box.ST.pkg.dur, dur);
      assert.equal(box.currentBkStep, 3);
      assert.equal(box.ST.basePrice, 0);
      assert.equal(box.posts.length, 0);
    });
  }
});

describe('7–10 specialty category and package', () => {
  for (const [cat, pkgId] of [
    ['boats', 'maint'],
    ['rvs', 'interior'],
    ['powersports', 'maintenance'],
    ['trucks', 'interior'],
  ]) {
    it(`${cat} + ${pkgId} opens that category's package on the vehicle step`, () => {
      const box = boot({ zip: '07601' });
      const intent = box.applyBookingQueryIntent(cat, pkgId, '');
      assert.equal(intent.open, true);
      assert.equal(intent.pkg, pkgId);
      assert.equal(box.ST._startStep, 3);
      box.ST.basePrice = 99999;
      box.selectCategory(cat);
      land(box);
      assert.equal(box.ST.cat, cat);
      assert.equal(box.ST.pkgId, pkgId);
      assert.equal(box.currentBkStep, 3);
      assert.equal(box.ST.basePrice, 0);
      assert.equal(box.posts.length, 0);
    });
  }
});

describe('11 category without a package', () => {
  it('opens that category package list and does not invent a package', () => {
    const box = boot({ zip: '07601' });
    const intent = box.applyBookingQueryIntent('boats', '', '');
    assert.equal(intent.open, true);
    assert.equal(intent.pkg, '');
    assert.equal(box.ST._startStep, 2);
    box.selectCategory('boats');
    land(box);
    assert.equal(box.ST.cat, 'boats');
    assert.equal(box.ST.pkgId, '');
    assert.equal(box.currentBkStep, 2);
    assert.equal(box.api.focused.textContent, 'CHOOSE YOUR PACKAGE');
    assert.equal(box.ST.basePrice, 0);
  });
});

describe('12 invalid package', () => {
  it('falls back to the package list with no price and no exception', () => {
    const box = boot({ zip: '07601' });
    const intent = box.applyBookingQueryIntent('cars', 'not-a-package', '');
    assert.equal(intent.open, true);
    assert.equal(intent.pkg, '');
    assert.equal(box.ST._packageIntent, '');
    assert.equal(box.ST._startStep, 2);
    assert.equal(box.ST.basePrice, 0);
    box.ST.basePrice = 99999;
    box.selectCategory('cars');
    land(box);
    assert.equal(box.ST.cat, 'cars');
    assert.equal(box.ST.pkgId, '');
    assert.equal(box.ST.basePrice, 0);
    assert.equal(box.currentBkStep, 2);
    assert.ok(box.logs.some((row) => row[1] && row[1].code === 'package_intent_rejected' && row[1].packageId === 'not-a-package'));
    assert.equal(JSON.stringify(box.logs).includes('07601'), false);
  });
});

describe('13 category incompatible with package', () => {
  it('does not select the car package on a boat', () => {
    const box = boot({ zip: '07601' });
    const intent = box.applyBookingQueryIntent('boats', 'interior', 'vehicle');
    assert.equal(intent.pkg, '');
    assert.equal(box.ST._packageIntent, '');
    assert.equal(box.ST._startStep, 2);
    box.ST.basePrice = 99999;
    box.selectCategory('boats');
    land(box);
    assert.equal(box.ST.cat, 'boats');
    assert.equal(box.ST.pkgId, '');
    assert.equal(box.ST.basePrice, 0);
    assert.equal(box.currentBkStep, 2);
  });
});

describe('14 Back', () => {
  it('returns to the selected package, then can reach the category grid', () => {
    const box = boot({ zip: '07601' });
    openPackage(box, 'cars', 'interior');
    assert.equal(box.currentBkStep, 3);
    box.api.activate(box.document.getElementById('back3'), 'Enter');
    assert.equal(box.currentBkStep, 2);
    assert.equal(box.ST.pkgId, 'interior');
    assert.equal(box.document.getElementById('pk-interior').classList.contains('sel'), true);
    assert.equal(box.api.focused.id, 'bs2-title');
    assert.equal(box.sections.bs1.classList.contains('on'), false);

    box.api.activate(box.document.getElementById('back2'), ' ');
    assert.equal(box.currentBkStep, 1);
    assert.equal(box.document.getElementById('bk-cat-grid').hidden, false);
    assert.match(box.document.getElementById('bs1-title').innerHTML, /WHAT ARE WE/);
    assert.match(index, /id="back3" onclick="bkBackFromVehicle\(\)"/);
    assert.match(index, /id="back2" onclick="bkBackFromPackage\(\)"/);
  });
});

describe('15 package change recalculates price and duration', () => {
  it('Interior sedan price becomes the Full Detail price and duration', () => {
    const box = boot({ zip: '07601' });
    openPackage(box, 'cars', 'interior');
    box.ST.tierKey = 'small';
    box.ST.tier = PRICING.cars.tiers.small;
    box.setBasePrice();
    assert.equal(box.ST.basePrice, 200);
    assert.equal(box.ST.pkg.dur, '~1.5–2h');
    box.bkGoTo(2);
    box.selectPkg('full');
    assert.equal(box.ST.pkgId, 'full');
    assert.equal(box.ST.basePrice, 250);
    assert.equal(box.ST.pkg.dur, '~2.5–3h');
    assert.notEqual(box.ST.basePrice, 200);
  });
});

describe('16 three-row SUV reprices off the sedan floor', () => {
  it('Interior moves from 200 to 255 when the class becomes SUV 3-Row', () => {
    const box = boot({ zip: '07601' });
    openPackage(box, 'cars', 'interior');
    box.ST.vehicleLabel = '2022 Palisade';
    box.ST.tierKey = 'small';
    box.ST.tier = PRICING.cars.tiers.small;
    box.setBasePrice();
    assert.equal(box.ST.basePrice, 200);
    box.selectTier('suv3');
    assert.equal(box.ST.tierKey, 'suv3');
    assert.equal(box.ST.basePrice, 255);
    box.selectPkg('ceramic_3yr');
    box.selectTier('suv3');
    assert.equal(box.ST.pkgId, 'ceramic_3yr');
    assert.equal(box.ST.basePrice, 1275);
    assert.notEqual(box.ST.basePrice, 1050);
  });
});

describe('17 refresh preserves only allowed state', () => {
  it('stores ZIP, category, and package, and does not store a card or create a booking', () => {
    const box = boot({ zip: '07601' });
    openPackage(box, 'cars', 'interior');
    box.ST.cardToken = 'tok_secret_should_not_persist';
    box.ST.cardLast4 = '4242';
    box.ST.bookingId = '';
    const store = {};
    const ctx = {
      window: {},
      document: {
        readyState: 'complete',
        addEventListener() {},
        getElementById(id) {
          if (id === 'bk-zip') return { value: '07601' };
          if (id === 'f-card') return { value: '4242424242424242', type: 'text' };
          return null;
        },
      },
      localStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; },
      },
      sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
      location: { search: '', pathname: '/' },
      URLSearchParams,
      ST: box.ST,
      currentBkStep: box.currentBkStep,
      activeZone: { key: 'nj_a' },
      setTimeout(fn) { fn(); return 0; },
      fetch() { throw new Error('refresh must not fetch'); },
      console,
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(progressSrc, ctx);
    const snap = ctx.CD1BookingProgress.persist();
    const raw = store.cd1_booking_progress;
    assert.equal(snap.zip, '07601');
    assert.equal(snap.ST.cat, 'cars');
    assert.equal(snap.ST.pkgId, 'interior');
    assert.equal(snap.packageIntent, 'interior');
    assert.equal(snap.draft.bookingId, '');
    assert.equal(raw.includes('tok_secret_should_not_persist'), false);
    assert.equal(raw.includes('4242'), false);
    assert.equal(raw.includes('4242424242424242'), false);
    assert.equal(box.posts.filter((p) => p[0] === 'fetch').length, 0);
  });
});

describe('18 preview cannot submit or send a production conversion', () => {
  it('the intent path does not submit, and preview refusal remains in place', () => {
    const box = boot({ zip: '07601' });
    box.location = { hostname: 'deploy-preview-349--cardetail1.netlify.app', href: 'https://deploy-preview-349--cardetail1.netlify.app/?book=cars&pkg=interior' };
    box.openHomeCeramic('ceramic_3yr');
    land(box);
    assert.equal(box.ST.pkgId, 'ceramic_3yr');
    assert.equal(box.posts.some((p) => p[0] === 'gtag' || p[0] === 'fetch' || p[0] === 'beacon'), false);
    assert.match(index, /osDisableBookingButtons\(/);
    assert.match(index, /Preview mode — bookings and payments are disabled/);
    assert.match(read('netlify/functions/submit-booking.js'), /refuseSharedPreviewBooking/);
    assert.doesNotMatch(extractFunction(index, 'openHomeCeramic'), /yrODCJGL998YEO7GypYq/);
    assert.doesNotMatch(extractFunction(index, 'applyBookingQueryIntent'), /yrODCJGL998YEO7GypYq/);
  });
});

describe('19 interface steps do not POST', () => {
  it('ZIP, package, vehicle, and back create no booking, SMS, or payment', () => {
    const box = boot({ zip: '', zone: null });
    box.openBookingCarPkg('interior');
    box.document.getElementById('bk-zip').value = '07601';
    box.activeZone = { key: 'nj_a' };
    box.selectCategory('cars');
    land(box);
    box.api.activate(box.document.getElementById('back3'), 'Enter');
    box.selectPkg('full');
    land(box);
    assert.equal(box.posts.filter((p) => ['fetch', 'xhr', 'beacon', 'gtag'].includes(p[0])).length, 0);
    assert.equal(box.ST.bookingId, '');
  });
});

describe('20 accessibility of the skipped steps', () => {
  it('focus and heading follow the visible step, and Back is a keyboard button', () => {
    const box = boot({ zip: '07601' });
    openPackage(box, 'cars', 'interior');
    assert.equal(box.api.focused.id, 'bs3-title');
    assert.equal(box.sections.bs1.classList.contains('on'), false);
    assert.equal(box.sections.bs2.classList.contains('on'), false);
    assert.equal(box.api.focusLog.includes('bs1-title'), false);
    assert.equal(box.api.focusLog.includes('bs2-title'), false);
    const back = box.document.getElementById('back3');
    assert.equal(back.type, 'button');
    box.api.activate(back, 'Enter');
    assert.equal(box.currentBkStep, 2);
    assert.equal(box.api.focused.id, 'bs2-title');
    assert.equal(box.sections.bs3.classList.contains('on'), false);
  });
});

describe('query string', () => {
  it('rejects an unknown category and does not keep its package', () => {
    const box = boot({ zip: '07601' });
    const intent = box.applyBookingQueryIntent('yacht', 'interior', '');
    assert.equal(intent.open, false);
    assert.equal(box.ST._packageIntent, '');
    assert.equal(box.ST._prefillPkgId, '');
    assert.equal(box.ST._startStep, null);
    assert.equal(box.ST.basePrice, 0);
    assert.ok(box.logs.some((row) => row[1] && row[1].code === 'category_intent_rejected' && row[1].categoryId === 'yacht'));
  });

  it('ceramic and interior URLs infer the vehicle step without reading a price', () => {
    const box = boot({ zip: '' });
    let intent = box.applyBookingQueryIntent('cars', 'interior', '');
    assert.equal(intent.pkg, 'interior');
    assert.equal(box.ST._startStep, 3);
    intent = box.applyBookingQueryIntent('cars', 'ceramic_3yr', '');
    assert.equal(intent.pkg, 'ceramic_3yr');
    assert.equal(box.ST._startStep, 3);
    assert.equal(box.ST.basePrice, 0);
    const ceramic = read('assets/ceramic-coating-page.js');
    assert.match(ceramic, /ceramic_3yr/);
    assert.match(ceramic, /params\.set\('book', 'cars'\)/);
    assert.doesNotMatch(ceramic, /[?&]price=/);
  });

  it('a direct open does not select the category twice when ZIP is already pending', () => {
    const box = boot({ zip: '07601' });
    let pendingSeen = 'unset';
    box.onBkZipInput = (val) => { pendingSeen = box.ST._pendingCat; box.__zipCalls = (box.__zipCalls || 0) + 1; box.__zip = val; };
    box.ST._pendingCat = 'cars';
    box.ST._packageIntent = 'interior';
    box.ST._prefillPkgId = 'interior';
    box.ST._startStep = 3;
    box.ST._intentLocked = true;
    box.openBooking('cars');
    land(box);
    assert.equal(pendingSeen, '');
    assert.equal(box.ST.cat, 'cars');
    assert.equal(box.ST.pkgId, 'interior');
    assert.equal(box.currentBkStep, 3);
  });
});

describe('CTA map stays on existing ids', () => {
  it('homepage, hub, and specialty bridges pass catalog ids and no price', () => {
    assert.match(index, /openBookingCarPkg\('interior'\)/);
    assert.match(index, /openBookingCarPkg\('full'\)/);
    assert.match(index, /openBookingCarPkg\('refresh'\)/);
    assert.match(index, /openHomeCeramic\('ceramic_1yr'\)/);
    assert.match(index, /openHomeCeramic\('ceramic_3yr'\)/);
    const hub = read('assets/hub-booking-bridge.js');
    assert.match(hub, /openDelegatedBooking\('cars', args\[0\] \|\| null\)/);
    assert.match(hub, /params\.set\('start', 'vehicle'\)/);
    assert.doesNotMatch(hub, /price/);
    const specialty = read('assets/specialty-booking-bridge.js');
    assert.match(specialty, /maintenance: 1, restore: 1/);
    assert.match(specialty, /params\.set\('start', 'vehicle'\)/);
    assert.match(specialty, /trucks: \{ interior: 1, int_wash: 1, int_wash_wax: 1 \}/);
    assert.doesNotMatch(read('ceramic-coating.html'), /pkg=not-a-package/);
  });
});
