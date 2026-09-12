'use strict';

/**
 * CARDDETAIL1 — specialty booking routing freeze.
 *
 * Shared first broken boundary was tryGenericConfirm() in the authoritative
 * homepage booking modal (index.html). It dispatched on undeclared `cat`
 * instead of ST.cat, so RV / Boat / Powersports vehicle confirmation threw
 * ReferenceError and never enabled Continue. Cars uses a separate search
 * path and was unaffected.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const index = read('index.html');
const boatsPage = read('boats-detailing.html');
const rvPage = read('rv-detailing.html');
const psPage = read('powersports-detailing.html');
const bridge = read('assets/specialty-booking-bridge.js');
const gateSrc = read('assets/booking-routing-gate.js');
const progressSrc = read('assets/booking-progress.js');
const Review = require('../assets/booking-review-runtime');
const { computeVehicleSubtotal } = require('../netlify/lib/booking-price-catalog');
const { applyServerTravelAndTotal } = require('../netlify/lib/travel-fee');
const submitBooking = require('../netlify/functions/submit-booking');

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

function loadTryGenericConfirm(stOverrides, fields) {
  const els = {
    'g-make': { value: fields.make || '' },
    'g-model': { value: fields.model || '' },
    'g-year': { value: fields.year || '' },
    vc: { classList: { add() { els.vc.shown = true; }, contains() { return !!els.vc.shown; } }, shown: false },
    next3: { disabled: true },
  };
  const sandbox = {
    ST: Object.assign({
      cat: '', pkgId: '', pkg: null, tierKey: '', tier: null, vehicleLabel: '',
      basePrice: 0, addons: [], addonTotal: 0, lengthFt: 0, rvType: '', rvLiving: '',
      boatType: '', units: 1,
    }, stOverrides),
    document: {
      getElementById(id) { return els[id] || null; },
    },
    BOAT_TYPE_LABELS: { pontoon: 'Pontoon / Tritoon', jetski: 'Jet Ski / PWC' },
    getLengthPrice(cat, pkgId, ft) { return cat === 'rvs' ? 130 + 9 * Number(ft) : Math.max(170, 10 * Number(ft)); },
    getBoatQuotePrice(pkgId, ft, type) {
      if (type === 'jetski') return 100;
      return Math.max(170, 10 * Number(ft));
    },
    applyRichPrice(n) { return Number(n) || 0; },
    setBasePrice() {
      const t = sandbox.ST.tier || {};
      sandbox.ST.basePrice = sandbox.applyRichPrice(t[sandbox.ST.pkgId] || t.wash || 0);
    },
    setVehicleVisual() { sandbox.visualSet = true; },
    setVcName(label) { sandbox.vcName = label; },
    renderAddons() { sandbox.addonsRendered = true; },
    updateRvServiceSubtotal() { sandbox.rvSubtotalUpdated = true; },
    console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(extractFunction(index, 'tryGenericConfirm'), sandbox);
  return { sandbox, els };
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
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
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

function createMemoryStore() {
  const data = new Map();
  return {
    data,
    async get(key) {
      const value = data.get(key);
      return value == null ? null : structuredClone(value);
    },
    async setJSON(key, value) {
      data.set(key, structuredClone(value));
      return { modified: true };
    },
    async list() {
      return { blobs: [...data.keys()].map((key) => ({ key })) };
    },
  };
}

function basePayload(overrides = {}) {
  return {
    firstName: 'Specialty',
    lastName: 'Customer',
    phone: '2015550177',
    email: 'specialty@example.com',
    address: '1 Main St, Newark, NJ',
    zipCode: '07102',
    preferredDate: '2099-06-16',
    preferredTime: '10:00 AM',
    preferredArrivalWindow: '',
    scheduleFlexibility: 'exact',
    paymentMethod: '',
    paymentMethodPreference: '',
    cardOnFileRequired: false,
    acceptedCardOnFilePolicy: false,
    acceptedCardOnFilePolicyAt: null,
    acceptedBookingPolicy: true,
    policyVersion: '2026-08-booking-request',
    ...overrides,
  };
}

function pricedPayload(overrides) {
  const payload = basePayload(overrides);
  const clone = structuredClone(payload);
  const priced = applyServerTravelAndTotal(clone, { skipMismatchCheck: true });
  assert.equal(priced.ok, true, priced.error || 'pricing failed');
  payload.totalPrice = clone.totalPrice;
  payload.travelFeeAmount = clone.travelFeeAmount;
  payload.zoneSurcharge = clone.zoneSurcharge;
  return payload;
}

async function post(store, body) {
  const response = await submitBooking.handler({
    httpMethod: 'POST',
    headers: { 'x-nf-client-connection-ip': '203.0.113.41' },
    body: JSON.stringify(body),
  });
  return { response, body: JSON.parse(response.body) };
}

const CANONICAL = {
  cars: 'cars',
  rv: 'rvs',
  boat: 'boats',
  powersports: 'powersports',
};

describe('canonical category IDs (not rv/boat aliases)', () => {
  it('authoritative booking state machine accepts cars, rvs, boats, powersports', () => {
    assert.match(index, /allowed=\{cars:1,boats:1,rvs:1,powersports:1\}/);
    assert.match(index, /id="bkcat-cars"/);
    assert.match(index, /id="bkcat-rvs"/);
    assert.match(index, /id="bkcat-boats"/);
    assert.match(index, /id="bkcat-powersports"/);
    assert.equal(CANONICAL.cars, 'cars');
    assert.equal(CANONICAL.rv, 'rvs');
    assert.equal(CANONICAL.boat, 'boats');
    assert.equal(CANONICAL.powersports, 'powersports');
  });

  it('public specialty CTAs send canonical IDs, not rv/boat aliases', () => {
    assert.match(rvPage, /data-booking-category="rvs"/);
    assert.match(rvPage, /book=rvs/);
    assert.doesNotMatch(rvPage, /data-booking-category="rv"/);
    assert.doesNotMatch(rvPage, /book=rv(?:&|"|')/);

    assert.match(boatsPage, /data-booking-category="boats"/);
    assert.match(boatsPage, /book=boats/);
    assert.doesNotMatch(boatsPage, /data-booking-category="boat"/);
    assert.doesNotMatch(boatsPage, /href="index\.html\?book=boat(?:&|")/);

    assert.match(psPage, /data-booking-category="powersports"/);
    assert.match(psPage, /book=powersports/);
  });

  it('specialty pages delegate to homepage booking overlay, not a second wizard', () => {
    assert.match(bridge, /openCategoryPackageBooking/);
    assert.match(bridge, /frame\.src = 'index\.html\?' \+ params\.toString\(\)/);
    assert.match(rvPage, /assets\/specialty-booking-bridge\.js/);
    assert.match(boatsPage, /assets\/specialty-booking-bridge\.js/);
    assert.match(psPage, /assets\/specialty-booking-bridge\.js/);
    for (const page of [rvPage, boatsPage, psPage]) {
      assert.doesNotMatch(page, /id="bk-ov"/);
      assert.doesNotMatch(page, /function tryGenericConfirm/);
      assert.doesNotMatch(page, /function submitBooking/);
    }
  });
});

describe('shared first broken boundary: tryGenericConfirm uses ST.cat', () => {
  it('index.html dispatches specialty vehicle confirm on ST.cat, not undeclared cat', () => {
    const fn = extractFunction(index, 'tryGenericConfirm');
    assert.match(fn, /if\(ST\.cat==='boats'\|\|ST\.cat==='rvs'\)/);
    assert.doesNotMatch(fn, /if\(cat==='boats'\|\|cat==='rvs'\)/);
    assert.match(fn, /if\(ST\.cat==='fleet'\)/);
    assert.match(fn, /if\(!ST\.tierKey\)return/);
  });

  it('RV vehicle input enables Continue and resolves a length price', () => {
    const { sandbox, els } = loadTryGenericConfirm({
      cat: 'rvs', pkgId: 'maint', rvType: 'travel', lengthFt: 20,
    }, { make: 'Airstream', model: 'Flying Cloud', year: '2021' });
    assert.doesNotThrow(() => sandbox.tryGenericConfirm());
    assert.equal(sandbox.ST.vehicleLabel, '2021 Airstream Flying Cloud · 20 ft');
    assert.equal(sandbox.ST.basePrice, 310);
    assert.equal(els.next3.disabled, false);
    assert.equal(els.vc.shown, true);
  });

  it('Boat vehicle input enables Continue and resolves a length price', () => {
    const { sandbox, els } = loadTryGenericConfirm({
      cat: 'boats', pkgId: 'maint', boatType: 'pontoon', lengthFt: 22,
    }, { make: 'Bennington', model: 'L Series', year: '2020' });
    assert.doesNotThrow(() => sandbox.tryGenericConfirm());
    assert.equal(sandbox.ST.vehicleLabel, '2020 Bennington L Series · Pontoon / Tritoon · 22 ft');
    assert.equal(sandbox.ST.basePrice, 220);
    assert.equal(els.next3.disabled, false);
  });

  it('Powersports Motorcycle / ATV / UTV each enable Continue with a tier price', () => {
    for (const [tierKey, label, price] of [
      ['motorcycle', 'Motorcycle', 100],
      ['atv', 'ATV', 100],
      ['utv', 'UTV / Side-by-Side', 125],
    ]) {
      const { sandbox, els } = loadTryGenericConfirm({
        cat: 'powersports', pkgId: 'wash', tierKey,
        tier: { label, wash: price, full: 225, premium: 315 },
      }, { make: 'Honda', model: 'Pioneer 1000', year: '2023' });
      assert.doesNotThrow(() => sandbox.tryGenericConfirm());
      assert.equal(sandbox.ST.vehicleLabel, '2023 Honda Pioneer 1000');
      assert.equal(sandbox.ST.basePrice, price);
      assert.equal(els.next3.disabled, false);
    }
  });

  it('Cars control path does not depend on tryGenericConfirm generic search', () => {
    const fn = extractFunction(index, 'selectMake');
    assert.match(fn, /function selectMake/);
    // Cars must early-return from tryGenericConfirm so leftover g-make never prices cars.
    assert.match(extractFunction(index, 'tryGenericConfirm'), /if\(ST\.cat==='cars'\) return/);
    assert.match(index, /id="make-search-wrap"/);
    assert.match(extractFunction(index, 'renderTierChips'), /const isCar=cat==='cars'/);
  });
});

describe('package compatibility per specialty category', () => {
  it('RV / Boat / Powersports public package IDs exist on the homepage catalog', () => {
    const rvs = catalogPackageIds('rvs');
    const boats = catalogPackageIds('boats');
    const ps = catalogPackageIds('powersports');
    const cars = catalogPackageIds('cars');

    for (const id of ['maint', 'maint_light', 'interior', 'full_basic', 'premium', 'full']) {
      assert.equal(rvs.includes(id), true, 'missing RV pkg ' + id);
    }
    for (const id of ['maint', 'full', 'premium']) {
      assert.equal(boats.includes(id), true, 'missing boat pkg ' + id);
    }
    for (const id of ['wash', 'full', 'premium']) {
      assert.equal(ps.includes(id), true, 'missing powersports pkg ' + id);
    }
    assert.equal(cars.includes('wash'), true);
    assert.equal(ps.includes('interior'), false);
    assert.equal(boats.includes('interior'), false);
  });

  it('specialty page package CTAs match homepage catalog IDs', () => {
    assert.match(rvPage, /data-booking-package="maint"/);
    assert.match(rvPage, /data-booking-package="interior"/);
    assert.match(rvPage, /data-booking-package="full"/);
    assert.match(boatsPage, /data-booking-package="maint"/);
    assert.match(boatsPage, /data-booking-package="full"/);
    assert.match(boatsPage, /data-booking-package="premium"/);
    assert.match(psPage, /data-booking-package="wash"/);
    assert.match(psPage, /data-booking-package="full"/);
    assert.match(psPage, /data-booking-package="premium"/);
  });

  it('resolvePackageIntentForCategory keeps specialty IDs and does not invent Cars packages', () => {
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
    assert.equal(sandbox.resolvePackageIntentForCategory('rvs', 'interior'), 'interior');
    assert.equal(sandbox.resolvePackageIntentForCategory('rvs', 'maint'), 'maint');
    assert.equal(sandbox.resolvePackageIntentForCategory('boats', 'full'), 'full');
    assert.equal(sandbox.resolvePackageIntentForCategory('boats', 'maint'), 'maint');
    assert.equal(sandbox.resolvePackageIntentForCategory('powersports', 'wash'), 'wash');
    assert.equal(sandbox.resolvePackageIntentForCategory('powersports', 'premium'), 'premium');
    assert.equal(sandbox.resolvePackageIntentForCategory('boats', 'interior'), '');
    assert.equal(sandbox.resolvePackageIntentForCategory('powersports', 'interior'), '');
  });

  it('switching category does not retain an incompatible Cars package', () => {
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
    assert.equal(sandbox.resolvePackageIntentForCategory('boats', 'interior'), '');
    assert.equal(sandbox.resolvePackageIntentForCategory('rvs', 'interior'), 'interior');
    assert.equal(sandbox.resolvePackageIntentForCategory('powersports', 'refresh'), 'premium');
  });
});

describe('ZIP gate and resume preserve specialty category', () => {
  it('ZIP unlock auto-selects pending specialty category, never invents Cars', () => {
    const zipFn = extractFunction(index, 'onBkZipInput');
    assert.match(zipFn, /if\(ST\._pendingCat\)/);
    assert.match(zipFn, /selectCategory\(pending\)/);
    assert.doesNotMatch(zipFn, /selectCategory\('cars'\)/);
  });

  it('deep-link pending query keeps rvs / boats / powersports', () => {
    assert.match(index, /ST\._pendingCat=book/);
    assert.match(gateSrc, /ST\._pendingCat = pending\.book/);
    assert.match(gateSrc, /allowed \|\| \{ cars: 1, boats: 1, rvs: 1, powersports: 1 \}/);
  });

  it('resume restores RV / Boat / Powersports snapshots without converting to Cars', () => {
    for (const cat of ['rvs', 'boats', 'powersports']) {
      let selected = null;
      const ctx = loadProgress({
        selectCategory(c) { selected = c; ctx.ST.cat = c; },
        selectPkg(id) { ctx.ST.pkgId = id; },
      });
      const snap = {
        v: 1,
        savedAt: Date.now(),
        pendingCat: '',
        ST: { cat, pkgId: cat === 'powersports' ? 'wash' : 'full', vehicles: [], addons: [] },
        fields: {},
      };
      ctx.CD1BookingProgress.applySnapshot(snap);
      assert.equal(selected, cat, cat + ' resume selected Cars');
      assert.equal(ctx.ST.cat, cat);
      assert.notEqual(ctx.ST.cat, 'cars');
    }
  });
});

describe('pricing + Review render for one fixture per category', () => {
  it('Cars control: small full resolves and Review can render', () => {
    const r = computeVehicleSubtotal({
      cat: 'cars', pkgId: 'full', tierKey: 'small', addons: [],
    }, '07102');
    assert.equal(r.ok, true);
    assert.equal(r.subtotal, 240);
    const totals = Review.presentationTotals({
      vehicles: [{ basePrice: 240, addonTotal: 0, subtotal: 240 }],
      travelFeeAmount: 0,
      totalPrice: 240,
    });
    assert.equal(totals.estimatedTotal, 240);
    assert.equal(Review.money(totals.estimatedTotal), '$240.00');
  });

  it('RV: 20 ft travel maint resolves and Review can render', () => {
    const r = computeVehicleSubtotal({
      cat: 'rvs', pkgId: 'maint', lengthFt: 20, rvType: 'travel', addons: [],
    }, '07102');
    assert.equal(r.ok, true);
    assert.equal(r.subtotal, 310);
    const totals = Review.presentationTotals({
      vehicles: [{ basePrice: 310, addonTotal: 0, subtotal: 310 }],
      travelFeeAmount: 0,
      totalPrice: 310,
    });
    assert.equal(totals.estimatedTotal, 310);
  });

  it('Boat: 22 ft pontoon maint resolves and Review can render', () => {
    const r = computeVehicleSubtotal({
      cat: 'boats', pkgId: 'maint', lengthFt: 22, boatType: 'pontoon', addons: [],
    }, '07102');
    assert.equal(r.ok, true);
    assert.equal(r.subtotal, 220);
    const totals = Review.presentationTotals({
      vehicles: [{ basePrice: 220, addonTotal: 0, subtotal: 220 }],
      travelFeeAmount: 0,
      totalPrice: 220,
    });
    assert.equal(totals.estimatedTotal, 220);
  });

  it('Powersports: motorcycle wash resolves and Review can render', () => {
    const r = computeVehicleSubtotal({
      cat: 'powersports', pkgId: 'wash', tierKey: 'motorcycle', addons: [],
    }, '07102');
    assert.equal(r.ok, true);
    assert.equal(r.subtotal, 100);
    const totals = Review.presentationTotals({
      vehicles: [{ basePrice: 100, addonTotal: 0, subtotal: 100 }],
      travelFeeAmount: 0,
      totalPrice: 100,
    });
    assert.equal(totals.estimatedTotal, 100);
  });
});

describe('Jet Ski stays on Boats, not Powersports', () => {
  it('powersports chips hide jetski; FAQ and boats page route PWC to boats', () => {
    assert.match(index, /filter\(\(\[k\]\)=>!\(cat==='powersports' && k==='jetski'\)\)/);
    assert.match(psPage, /book=boats&amp;boatType=jetski/);
    assert.match(boatsPage, /data-booking-boat-type="jetski"/);
    assert.match(bridge, /if \(boatType === 'jetski' && categoryId === 'powersports'\)/);
  });
});

describe('no card / payment added by this repair', () => {
  it('review submit remains no-card and does not add Stripe', () => {
    const fn = extractFunction(index, 'tryGenericConfirm');
    assert.doesNotMatch(fn, /stripe|create-setup-intent|PaymentIntent/i);
    const bs5 = index.slice(index.indexOf('id="bs5"'), index.indexOf('id="bs6"'));
    assert.match(bs5, /onclick="submitBooking\(\)"/);
    assert.doesNotMatch(bs5, /id="stripe-auth-btn"/);
  });
});

describe('local submit of specialty fixtures persists once', () => {
  const store = createMemoryStore();
  const originalFetch = globalThis.fetch;
  const env = {};
  const envKeys = [
    'DRAFT_TOKEN_SECRET', 'ADMIN_EMAIL', 'RESEND_API_KEY', 'TWILIO_SEND_ENABLED',
    'CONTEXT', 'NETLIFY_DEV', 'STRIPE_SECRET_KEY',
  ];

  before(() => {
    for (const key of envKeys) env[key] = process.env[key];
    process.env.DRAFT_TOKEN_SECRET = 'n'.repeat(40);
    process.env.ADMIN_EMAIL = '';
    process.env.RESEND_API_KEY = '';
    process.env.TWILIO_SEND_ENABLED = 'false';
    process.env.CONTEXT = 'deploy-preview';
    delete process.env.NETLIFY_DEV;
    delete process.env.STRIPE_SECRET_KEY;
    submitBooking.__test.setBlobsStoreOverride(async () => store);
    globalThis.fetch = async () => { throw new Error('unexpected_external_call'); };
  });

  after(() => {
    globalThis.fetch = originalFetch;
    submitBooking.__test.setBlobsStoreOverride(null);
    for (const key of envKeys) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
  });

  const fixtures = [
    {
      name: 'cars control',
      phone: '2015550101',
      payload: {
        preferredDate: '2099-06-16',
        vehicle: '2024 Honda Civic',
        vehicleCategory: 'cars',
        vehicleTier: 'Small Car',
        package: 'Premium Full Detail',
        packageId: 'full',
        vehicles: [{
          vehicleId: 'vehicle-1', cat: 'cars', pkgId: 'full', pkgName: 'Premium Full Detail',
          tierKey: 'small', tierLabel: 'Small Car', vehicleLabel: '2024 Honda Civic',
          addons: [], addonTotal: 0,
        }],
      },
    },
    {
      name: 'RV',
      phone: '2015550102',
      payload: {
        preferredDate: '2099-06-17',
        vehicle: '2021 Airstream Flying Cloud · 20 ft',
        vehicleCategory: 'rvs',
        vehicleTier: '20 ft',
        package: 'Maintenance Detail',
        packageId: 'maint',
        lengthFt: 20,
        rvType: 'travel',
        vehicles: [{
          vehicleId: 'vehicle-1', cat: 'rvs', pkgId: 'maint', pkgName: 'Maintenance Detail',
          tierKey: 'travel', tierLabel: '20 ft', vehicleLabel: '2021 Airstream Flying Cloud · 20 ft',
          lengthFt: 20, rvType: 'travel', addons: [], addonTotal: 0,
        }],
      },
    },
    {
      name: 'Boat',
      phone: '2015550103',
      payload: {
        preferredDate: '2099-06-18',
        vehicle: '2020 Bennington L Series · Pontoon / Tritoon · 22 ft',
        vehicleCategory: 'boats',
        vehicleTier: 'Pontoon / Tritoon · 22 ft',
        package: 'Marine Wash',
        packageId: 'maint',
        lengthFt: 22,
        boatType: 'pontoon',
        vehicles: [{
          vehicleId: 'vehicle-1', cat: 'boats', pkgId: 'maint', pkgName: 'Marine Wash',
          tierKey: 'pontoon', tierLabel: 'Pontoon / Tritoon · 22 ft',
          vehicleLabel: '2020 Bennington L Series · Pontoon / Tritoon · 22 ft',
          lengthFt: 22, boatType: 'pontoon', addons: [], addonTotal: 0,
        }],
      },
    },
    {
      name: 'Powersports',
      phone: '2015550104',
      payload: {
        preferredDate: '2099-06-19',
        vehicle: '2023 Harley-Davidson Street Glide',
        vehicleCategory: 'powersports',
        vehicleTier: 'Motorcycle',
        package: 'Wash & Shine',
        packageId: 'wash',
        vehicles: [{
          vehicleId: 'vehicle-1', cat: 'powersports', pkgId: 'wash', pkgName: 'Wash & Shine',
          tierKey: 'motorcycle', tierLabel: 'Motorcycle',
          vehicleLabel: '2023 Harley-Davidson Street Glide',
          addons: [], addonTotal: 0,
        }],
      },
    },
  ];

  for (const fixture of fixtures) {
    it(`${fixture.name} submits once and retry is idempotent`, async () => {
      const body = pricedPayload({ phone: fixture.phone, ...fixture.payload });
      const draft = await post(store, { ...body, isDraft: true });
      assert.equal(draft.response.statusCode, 200, fixture.name + ' draft ' + draft.body.error);
      assert.equal(draft.body.ok, true);
      assert.equal(draft.body.bookingCreated, false);

      const final = await post(store, {
        ...body,
        draftBookingId: draft.body.id,
        draftSaveToken: draft.body.draftSaveToken,
      });
      assert.equal(final.response.statusCode, 200, fixture.name + ' final ' + final.body.error);
      assert.equal(final.body.ok, true);
      assert.equal(final.body.bookingCreated, true);
      assert.equal(final.body.id, draft.body.id);
      assert.equal(final.body.cardOnFileStatus, 'not_collected');
      assert.equal(final.body.paymentStatus, 'no_payment_required_yet');

      const saved = await store.get(final.body.id);
      assert.equal(saved.isDraft, false);
      assert.equal(saved.vehicleCategory, fixture.payload.vehicleCategory);
      assert.equal(saved.vehicles[0].cat, fixture.payload.vehicleCategory);
      assert.equal(saved.vehicles[0].pkgId, fixture.payload.packageId);
      assert.equal(saved.cardOnFileRequired, false);
      assert.equal('setupIntentId' in saved, false);
      assert.equal('paymentIntentId' in saved, false);

      const beforeCount = store.data.size;
      const replay = await post(store, {
        ...body,
        draftBookingId: saved.id,
        draftSaveToken: 'the-finalized-path-does-not-reissue-this-token',
      });
      assert.equal(replay.response.statusCode, 200);
      assert.equal(replay.body.idempotent, true);
      assert.equal(replay.body.id, saved.id);
      assert.equal(store.data.size, beforeCount);
    });
  }
});
