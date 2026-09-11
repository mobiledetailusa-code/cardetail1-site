'use strict';

/**
 * CARDDETAIL1 — Powersports second defect (post-#260).
 *
 * Production still blocked after the shared `cat` → ST.cat repair because
 * Powersports has no dedicated tryGenericConfirm branch. Public CTAs leave
 * ST.tierKey empty (chips render unselected). Continue requires tierKey,
 * so ymm alone never enabled #next3.
 *
 * These tests run the real inferPowersportsTier + tryGenericConfirm
 * dispatcher with empty tierKey — the customer landing state — not a
 * pre-injected machine type.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const index = read('index.html');
const psPage = read('powersports-detailing.html');
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

const PS_TIERS = {
  motorcycle: { label: 'Motorcycle', wash: 100, essential: 160, full: 225, premium: 315 },
  atv: { label: 'ATV', wash: 100, essential: 160, full: 225, premium: 315 },
  utv: { label: 'UTV / Side-by-Side', wash: 125, essential: 190, full: 280, premium: 395 },
};

const MACHINES = {
  motorcycle: { make: 'Honda', model: 'Rebel 500', year: '2023', tierKey: 'motorcycle', price: { wash: 100, full: 225, premium: 315 } },
  atv: { make: 'Honda', model: 'FourTrax Rancher', year: '2022', tierKey: 'atv', price: { wash: 100, full: 225, premium: 315 } },
  utv: { make: 'Honda', model: 'Pioneer 1000', year: '2024', tierKey: 'utv', price: { wash: 125, full: 280, premium: 395 } },
};

function loadDispatcher(stOverrides, fields) {
  const chips = {};
  for (const key of Object.keys(PS_TIERS)) {
    chips[key] = {
      classList: {
        _sel: false,
        add(c) { if (c === 'sel') this._sel = true; },
        remove(c) { if (c === 'sel') this._sel = false; },
        contains(c) { return c === 'sel' && this._sel; },
      },
    };
  }
  const els = {
    'g-make': { value: fields.make || '' },
    'g-model': { value: fields.model || '' },
    'g-year': { value: fields.year || '' },
    vc: { classList: { add() { els.vc.shown = true; }, contains() { return !!els.vc.shown; } }, shown: false },
    next3: { disabled: true },
  };
  const sandbox = {
    ST: Object.assign({
      cat: 'powersports',
      pkgId: '',
      pkg: null,
      tierKey: '',
      tier: null,
      vehicleLabel: '',
      displayLabel: '',
      basePrice: 0,
      addons: [],
      addonTotal: 0,
      lengthFt: 0,
      rvType: '',
      rvLiving: '',
      boatType: '',
      units: 1,
      vehicles: [],
    }, stOverrides),
    PRICING: { powersports: { tiers: structuredClone(PS_TIERS) } },
    document: {
      getElementById(id) { return els[id] || null; },
      querySelector(sel) {
        const m = String(sel).match(/data-tier="([^"]+)"/);
        return m ? chips[m[1]] || null : null;
      },
      querySelectorAll(sel) {
        if (sel === '.tchip') return Object.values(chips);
        return [];
      },
    },
    BOAT_TYPE_LABELS: { pontoon: 'Pontoon / Tritoon', jetski: 'Jet Ski / PWC' },
    getLengthPrice() { throw new Error('powersports must not use length pricing'); },
    getBoatQuotePrice() { throw new Error('powersports must not use boat quote pricing'); },
    applyRichPrice(n) { return Number(n) || 0; },
    setBasePrice() {
      const t = sandbox.ST.tier || {};
      sandbox.ST.basePrice = sandbox.applyRichPrice(t[sandbox.ST.pkgId] || 0);
    },
    setVehicleVisual() { sandbox.visualSet = true; },
    setVcName(label) { sandbox.vcName = label; },
    renderAddons() { sandbox.addonsRendered = true; },
    updateRvServiceSubtotal() { sandbox.rvSubtotalUpdated = true; },
    console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    extractFunction(index, 'inferPowersportsTier') + '\n' + extractFunction(index, 'tryGenericConfirm'),
    sandbox
  );
  return { sandbox, els, chips };
}

function confirmPackagePath(pkgId, machine) {
  const { sandbox, els } = loadDispatcher({
    cat: 'powersports',
    pkgId,
    pkg: { id: pkgId, name: pkgId === 'wash' ? 'Wash & Shine' : pkgId === 'full' ? 'Full Detail' : 'Premium Detail' },
    tierKey: '',
    tier: null,
  }, { make: machine.make, model: machine.model, year: machine.year });
  assert.equal(sandbox.ST.tierKey, '', 'customer landing state must start with empty tierKey');
  assert.doesNotThrow(() => sandbox.tryGenericConfirm());
  assert.equal(els.next3.disabled, false, pkgId + ' ' + machine.tierKey + ' Continue stayed disabled');
  assert.equal(sandbox.ST.tierKey, machine.tierKey);
  assert.equal(sandbox.ST.basePrice, machine.price[pkgId]);
  assert.equal(sandbox.ST.vehicleLabel, machine.year + ' ' + machine.make + ' ' + machine.model);
  assert.equal(sandbox.ST.vehicleLabel.includes(' ft'), false);
  return { sandbox, els };
}

function reachReview(pkgId, machine) {
  const { sandbox } = confirmPackagePath(pkgId, machine);
  sandbox.getVehicleVisualKey = () => 'motorcycle';
  sandbox.bkGoTo = (n) => { sandbox.wentTo = n; };
  sandbox.renderVehicleCart = () => { sandbox.cartRendered = true; };
  sandbox.Cardetail1CheckoutAnalytics = { onStepCompleted() {} };
  vm.runInContext(
    extractFunction(index, 'buildCurrentVehicleItem') + '\n' +
    extractFunction(index, 'commitCurrentVehicleToCart') + '\n' +
    extractFunction(index, 'addCurrentVehicleAndContinue'),
    sandbox
  );
  sandbox.addCurrentVehicleAndContinue();
  assert.equal(sandbox.wentTo, 4, 'Continue must leave vehicle step');
  assert.equal(sandbox.ST.vehicles.length, 1);
  const item = sandbox.ST.vehicles[0];
  assert.equal(item.cat, 'powersports');
  assert.equal(item.pkgId, pkgId);
  assert.equal(item.tierKey, machine.tierKey);
  const priced = computeVehicleSubtotal({
    cat: 'powersports', pkgId, tierKey: machine.tierKey, addons: [],
  }, '07102');
  assert.equal(priced.ok, true);
  assert.equal(priced.subtotal, machine.price[pkgId]);
  const totals = Review.presentationTotals({
    vehicles: [{ basePrice: item.basePrice, addonTotal: 0, subtotal: item.basePrice }],
    travelFeeAmount: 0,
    totalPrice: item.basePrice,
  });
  assert.equal(totals.estimatedTotal, machine.price[pkgId]);
  return item;
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
    phone: '2015550277',
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
    headers: { 'x-nf-client-connection-ip': '203.0.113.77' },
    body: JSON.stringify(body),
  });
  return { response, body: JSON.parse(response.body) };
}

describe('Powersports public entry + package IDs', () => {
  it('generic Book This Service opens powersports without a package id', () => {
    assert.match(psPage, /data-booking-category="powersports">Book This Service/);
    assert.match(psPage, /href="index\.html\?book=powersports"/);
    assert.doesNotMatch(
      psPage.slice(psPage.indexOf('Book This Service') - 180, psPage.indexOf('Book This Service') + 40),
      /data-booking-package=/
    );
  });

  it('Wash / Full / Premium public CTAs use canonical catalog IDs', () => {
    assert.match(psPage, /data-booking-package="wash"/);
    assert.match(psPage, /data-booking-package="full"/);
    assert.match(psPage, /data-booking-package="premium"/);
    assert.match(index, /id:'wash',\s+name:'Wash & Shine'/);
    assert.match(index, /id:'full',\s+name:'Full Detail'/);
    assert.match(index, /id:'premium',\s+name:'Premium Detail'/);
  });
});

describe('second defect: empty tierKey is the Continue gate', () => {
  it('does not fold Powersports into the RV/Boat length branch', () => {
    const fn = extractFunction(index, 'tryGenericConfirm');
    assert.match(fn, /if\(ST\.cat==='boats'\|\|ST\.cat==='rvs'\)/);
    assert.doesNotMatch(fn, /ST\.cat==='powersports' && \(ST\.cat==='boats'|ST\.cat==='boats'\|\|ST\.cat==='rvs'\|\|ST\.cat==='powersports'/);
    assert.match(fn, /if\(ST\.cat==='powersports' && !ST\.tierKey\)/);
    assert.match(fn, /inferPowersportsTier/);
  });

  it('ymm + package with no chip selected used to die on !ST.tierKey; now infers machine', () => {
    const { sandbox, els } = loadDispatcher({
      cat: 'powersports', pkgId: 'wash', pkg: { id: 'wash', name: 'Wash & Shine' },
      tierKey: '', tier: null,
    }, { make: 'Honda', model: 'Rebel 500', year: '2023' });
    sandbox.tryGenericConfirm();
    assert.equal(sandbox.ST.tierKey, 'motorcycle');
    assert.equal(els.next3.disabled, false);
  });

  it('chip click still wins over model inference', () => {
    const { sandbox } = loadDispatcher({
      cat: 'powersports', pkgId: 'wash',
      tierKey: 'motorcycle',
      tier: PS_TIERS.motorcycle,
    }, { make: 'Honda', model: 'Pioneer 1000', year: '2024' });
    sandbox.tryGenericConfirm();
    assert.equal(sandbox.ST.tierKey, 'motorcycle');
    assert.equal(sandbox.ST.basePrice, 100);
  });
});

describe('generic + Wash + Full + Premium package paths', () => {
  it('generic entry still requires a package before Continue', () => {
    const { sandbox, els } = loadDispatcher({
      cat: 'powersports', pkgId: '', pkg: null, tierKey: '',
    }, { make: 'Honda', model: 'Rebel 500', year: '2023' });
    sandbox.tryGenericConfirm();
    assert.equal(els.next3.disabled, true);
    assert.equal(sandbox.ST.tierKey, '');
  });

  it('Wash package path infers machine and enables Continue', () => {
    confirmPackagePath('wash', MACHINES.motorcycle);
  });

  it('Full package path infers machine and enables Continue', () => {
    confirmPackagePath('full', MACHINES.atv);
  });

  it('Premium package path infers machine and enables Continue', () => {
    confirmPackagePath('premium', MACHINES.utv);
  });
});

describe('Motorcycle / ATV / UTV Continue transition without injected tierKey', () => {
  it('Motorcycle Rebel 500 Continue transition', () => {
    const { sandbox, els } = confirmPackagePath('wash', MACHINES.motorcycle);
    assert.equal(sandbox.ST.tierKey, 'motorcycle');
    assert.equal(els.next3.disabled, false);
  });

  it('ATV FourTrax Rancher Continue transition', () => {
    const { sandbox, els } = confirmPackagePath('wash', MACHINES.atv);
    assert.equal(sandbox.ST.tierKey, 'atv');
    assert.equal(els.next3.disabled, false);
  });

  it('UTV Pioneer 1000 Continue transition', () => {
    const { sandbox, els } = confirmPackagePath('wash', MACHINES.utv);
    assert.equal(sandbox.ST.tierKey, 'utv');
    assert.equal(els.next3.disabled, false);
  });
});

describe('each machine reaches Review from the real cart handoff', () => {
  it('Motorcycle reaches Review', () => {
    const item = reachReview('wash', MACHINES.motorcycle);
    assert.equal(item.pkgName, 'Wash & Shine');
  });

  it('ATV reaches Review', () => {
    const item = reachReview('full', MACHINES.atv);
    assert.equal(item.pkgName, 'Full Detail');
  });

  it('UTV reaches Review', () => {
    const item = reachReview('premium', MACHINES.utv);
    assert.equal(item.pkgName, 'Premium Detail');
  });
});

describe('Cars / RV / Boat dispatcher regression', () => {
  it('Cars still does not route through tryGenericConfirm', () => {
    assert.doesNotMatch(extractFunction(index, 'tryGenericConfirm'), /ST\.cat==='cars'/);
    assert.match(extractFunction(index, 'selectMake'), /function selectMake/);
  });

  it('RV length branch still enables Continue and is unchanged', () => {
    const { sandbox, els } = loadDispatcher({
      cat: 'rvs', pkgId: 'maint', rvType: 'travel', lengthFt: 20, tierKey: '',
    }, { make: 'Airstream', model: 'Flying Cloud', year: '2021' });
    sandbox.getLengthPrice = (cat, pkgId, ft) => {
      assert.equal(cat, 'rvs');
      return 130 + 9 * Number(ft);
    };
    sandbox.tryGenericConfirm();
    assert.equal(sandbox.ST.vehicleLabel, '2021 Airstream Flying Cloud · 20 ft');
    assert.equal(sandbox.ST.basePrice, 310);
    assert.equal(els.next3.disabled, false);
    assert.equal(sandbox.ST.tierKey, 'travel');
  });

  it('Boat length branch still enables Continue and is unchanged', () => {
    const { sandbox, els } = loadDispatcher({
      cat: 'boats', pkgId: 'maint', boatType: 'pontoon', lengthFt: 22, tierKey: '',
    }, { make: 'Bennington', model: 'L Series', year: '2020' });
    sandbox.getBoatQuotePrice = (pkgId, ft, type) => {
      assert.equal(type, 'pontoon');
      return Math.max(170, 10 * Number(ft));
    };
    sandbox.tryGenericConfirm();
    assert.equal(sandbox.ST.vehicleLabel, '2020 Bennington L Series · Pontoon / Tritoon · 22 ft');
    assert.equal(sandbox.ST.basePrice, 220);
    assert.equal(els.next3.disabled, false);
  });
});

describe('test submit persists once and retry is idempotent', () => {
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
      name: 'Powersports Motorcycle wash',
      phone: '2015550281',
      payload: {
        preferredDate: '2099-06-16',
        vehicle: '2023 Honda Rebel 500',
        vehicleCategory: 'powersports',
        vehicleTier: 'Motorcycle',
        package: 'Wash & Shine',
        packageId: 'wash',
        vehicles: [{
          vehicleId: 'vehicle-1', cat: 'powersports', pkgId: 'wash', pkgName: 'Wash & Shine',
          tierKey: 'motorcycle', tierLabel: 'Motorcycle',
          vehicleLabel: '2023 Honda Rebel 500',
          addons: [], addonTotal: 0,
        }],
      },
    },
    {
      name: 'Cars Honda Civic',
      phone: '2015550282',
      payload: {
        preferredDate: '2099-06-17',
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
      name: 'RV representative',
      phone: '2015550283',
      payload: {
        preferredDate: '2099-06-18',
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
      name: 'Boat representative',
      phone: '2015550284',
      payload: {
        preferredDate: '2099-06-19',
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

      const saved = await store.get(final.body.id);
      assert.equal(saved.isDraft, false);
      assert.equal(saved.vehicleCategory, fixture.payload.vehicleCategory);
      assert.equal(saved.vehicles[0].cat, fixture.payload.vehicleCategory);
      assert.equal(saved.vehicles[0].pkgId, fixture.payload.packageId);

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
