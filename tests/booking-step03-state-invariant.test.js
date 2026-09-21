'use strict';

/**
 * Step 03 Package — sticky vs cart state invariant.
 *
 * Sticky / current configuration must derive from live ST.
 * Cart must show committed vehicles (with the editing slot live-synced from ST).
 * Starting an additional vehicle must not leak vehicle A into the sticky footer.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const summarySrc = fs.readFileSync(path.join(ROOT, 'assets/booking-vehicle-summary.js'), 'utf8');

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

function extractConstObject(src, name) {
  const start = src.indexOf('const ' + name + ' = {');
  assert.ok(start >= 0, 'missing const ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1) + ';';
    }
  }
  throw new Error('unterminated const ' + name);
}

function money(n) {
  return '$' + Number(n).toFixed(2);
}

function makeSandbox() {
  const dom = new JSDOM(`<!DOCTYPE html><body>
    <div id="bs2-sticky" class="bs2-sticky" hidden>
      <div class="bs2-sticky-info">
        <strong id="bs2-sticky-pkg">—</strong>
        <span id="bs2-sticky-car">—</span>
      </div>
      <div class="bs2-sticky-price" id="bs2-sticky-price">$0</div>
      <button type="button" id="bs2-sticky-next" disabled>Continue</button>
    </div>
    <div class="vcart" id="vcart">
      <div class="vcart-title">Vehicles in this booking</div>
      <div id="vcart-items"></div>
      <div class="vcart-total" id="vcart-total" style="display:none">
        <span>Cart Total</span><span id="vcart-sum">$0</span>
      </div>
    </div>
  </body>`, { url: 'http://localhost/' });

  const sandbox = {
    window: dom.window,
    document: dom.window.document,
    currentBkStep: 2,
    ST: {
      cat: 'cars',
      pkgId: '',
      pkg: null,
      tierKey: '',
      tier: null,
      vehicleLabel: '',
      displayLabel: '',
      basePrice: 0,
      addons: [],
      addonTotal: 0,
      vehicles: [],
      _startingAdditionalVehicle: false,
      _editingVehicleIndex: null,
    },
    PKG_COMPACT_META: {
      full: { shortName: 'Premium Full Detail' },
      refresh: { shortName: 'Exterior Refresh & Protect' },
      premium: { shortName: 'Signature Restoration' },
    },
    VEHICLE_VISUALS: { sedan: { img: '/x.webp', alt: 'car' } },
    CATEGORY_VISUALS: { cars: { img: '/c.webp', alt: 'cars' } },
    getTravelFeeAmount: () => 0,
    bkMoney: money,
    console,
  };
  sandbox.window.ST = sandbox.ST;
  sandbox.global = sandbox;
  sandbox.window.CD1BookingVehicleSummary = undefined;

  vm.createContext(sandbox);
  vm.runInContext(summarySrc, sandbox);
  if (!sandbox.CD1BookingVehicleSummary && sandbox.window.CD1BookingVehicleSummary) {
    sandbox.CD1BookingVehicleSummary = sandbox.window.CD1BookingVehicleSummary;
  }

  vm.runInContext(
    'function getVehicleVisualKey(){ return "sedan"; }\n' +
    'function carsVehicleFirstFlow(){ return ST.cat === "cars"; }\n' +
    extractFunction(index, 'getActiveBookingConfig') + '\n' +
    extractFunction(index, 'getCommittedCartVehicles') + '\n' +
    extractFunction(index, 'syncActiveConfigIntoEditingCartSlot') + '\n' +
    extractFunction(index, 'bookingServiceTotalForSticky') + '\n' +
    extractFunction(index, 'syncBs2StickyBar') + '\n' +
    extractFunction(index, 'buildCurrentVehicleItem') + '\n' +
    extractFunction(index, 'commitCurrentVehicleToCart') + '\n' +
    extractFunction(index, 'renderVehicleCart') + '\n' +
    extractFunction(index, 'removeVehicleFromCart') + '\n',
    sandbox
  );

  return sandbox;
}

function setCarConfig(ST, { pkgId, pkgName, label, tierKey, tierLabel, price, addons }) {
  Object.assign(ST, {
    cat: 'cars',
    pkgId,
    pkg: { name: pkgName, icon: '🚗' },
    vehicleLabel: label,
    displayLabel: tierLabel,
    tierKey,
    tier: { label: tierLabel },
    basePrice: price,
    addons: addons || [],
    addonTotal: (addons || []).reduce((s, a) => s + (a.price * (a.qty || 1)), 0),
  });
}

describe('Step 03 sticky/cart state invariant', () => {
  let box;

  beforeEach(() => {
    box = makeSandbox();
  });

  it('exposes canonical helpers in index.html', () => {
    assert.match(index, /function getActiveBookingConfig\(/);
    assert.match(index, /function getCommittedCartVehicles\(/);
    assert.match(index, /function syncActiveConfigIntoEditingCartSlot\(/);
    assert.match(index, /function bookingServiceTotalForSticky\(/);
    assert.match(index, /addon-grid-cols/);
    assert.match(index, /repeat\(auto-fit,\s*minmax\(230px,\s*1fr\)\)/);
  });

  it('keeps sticky and cart aligned while editing a single committed vehicle', () => {
    const { ST } = box;
    setCarConfig(ST, {
      pkgId: 'full',
      pkgName: 'Premium Full Detail',
      label: '2019 Ferrari Amalfi Spider',
      tierKey: 'small',
      tierLabel: 'Small Car',
      price: 240,
    });
    box.commitCurrentVehicleToCart();
    box.renderVehicleCart();
    box.syncBs2StickyBar();

    assert.equal(box.document.getElementById('bs2-sticky-pkg').textContent, 'Premium Full Detail');
    assert.match(box.document.getElementById('bs2-sticky-car').textContent, /2019 Ferrari Amalfi Spider/);
    assert.match(box.document.getElementById('vcart-items').textContent, /Premium Full Detail/);
    assert.match(box.document.getElementById('vcart-items').textContent, /2019 Ferrari Amalfi Spider/);
    assert.equal(box.document.getElementById('bs2-sticky-price').textContent, '$240.00');

    // Change package on the same active vehicle — must not leave Premium in sticky while cart updates, or vice versa
    setCarConfig(ST, {
      pkgId: 'refresh',
      pkgName: 'Exterior Refresh & Protect',
      label: '2019 Ferrari Amalfi Spider',
      tierKey: 'small',
      tierLabel: 'Small Car',
      price: 355,
    });
    box.syncActiveConfigIntoEditingCartSlot();
    box.renderVehicleCart();
    box.syncBs2StickyBar();

    assert.equal(box.document.getElementById('bs2-sticky-pkg').textContent, 'Exterior Refresh & Protect');
    assert.match(box.document.getElementById('vcart-items').textContent, /Exterior Refresh/);
    assert.doesNotMatch(box.document.getElementById('vcart-items').textContent, /Premium Full Detail/);
    assert.equal(box.document.getElementById('bs2-sticky-price').textContent, '$355.00');
    assert.equal(ST.vehicles[0].pkgId, 'refresh');
    assert.equal(ST.vehicles[0].subtotal, 355);
  });

  it('does not leak vehicle A into sticky while configuring vehicle B', () => {
    const { ST } = box;
    setCarConfig(ST, {
      pkgId: 'full',
      pkgName: 'Premium Full Detail',
      label: '2019 Ferrari Amalfi Spider',
      tierKey: 'small',
      tierLabel: 'Small Car',
      price: 240,
    });
    box.commitCurrentVehicleToCart();
    ST._editingVehicleIndex = null;
    ST._startingAdditionalVehicle = true;

    setCarConfig(ST, {
      pkgId: 'refresh',
      pkgName: 'Exterior Refresh & Protect',
      label: '2021 Ferrari GTC4Lusso',
      tierKey: 'small',
      tierLabel: 'Small Car',
      price: 355,
    });
    box.renderVehicleCart();
    box.syncBs2StickyBar();

    const stickyPkg = box.document.getElementById('bs2-sticky-pkg').textContent;
    const stickyCar = box.document.getElementById('bs2-sticky-car').textContent;
    const cartText = box.document.getElementById('vcart-items').textContent;

    assert.equal(stickyPkg, 'Exterior Refresh & Protect');
    assert.match(stickyCar, /2021 Ferrari GTC4Lusso/);
    assert.doesNotMatch(stickyCar, /Amalfi/);
    assert.match(cartText, /Premium Full Detail/);
    assert.match(cartText, /2019 Ferrari Amalfi Spider/);
    assert.doesNotMatch(cartText, /GTC4Lusso/);
    assert.doesNotMatch(cartText, /Exterior Refresh/);
    // Booking total = committed A + current B
    assert.equal(box.document.getElementById('bs2-sticky-price').textContent, '$595.00');
    assert.equal(box.bookingServiceTotalForSticky(), 595);
  });

  it('updates sticky when package B changes again', () => {
    const { ST } = box;
    setCarConfig(ST, {
      pkgId: 'full',
      pkgName: 'Premium Full Detail',
      label: '2019 Ferrari Amalfi Spider',
      tierKey: 'small',
      tierLabel: 'Small Car',
      price: 240,
    });
    box.commitCurrentVehicleToCart();
    ST._editingVehicleIndex = null;
    ST._startingAdditionalVehicle = true;
    setCarConfig(ST, {
      pkgId: 'refresh',
      pkgName: 'Exterior Refresh & Protect',
      label: '2021 Ferrari GTC4Lusso',
      tierKey: 'small',
      tierLabel: 'Small Car',
      price: 355,
    });
    box.syncBs2StickyBar();
    assert.equal(box.document.getElementById('bs2-sticky-pkg').textContent, 'Exterior Refresh & Protect');

    setCarConfig(ST, {
      pkgId: 'premium',
      pkgName: 'Signature Detail',
      label: '2021 Ferrari GTC4Lusso',
      tierKey: 'small',
      tierLabel: 'Small Car',
      price: 420,
    });
    box.syncBs2StickyBar();
    assert.equal(box.document.getElementById('bs2-sticky-pkg').textContent, 'Signature Restoration');
    assert.equal(box.document.getElementById('bs2-sticky-price').textContent, '$660.00');
  });

  it('clears sticky when active config is reset after add-another', () => {
    const { ST } = box;
    setCarConfig(ST, {
      pkgId: 'full',
      pkgName: 'Premium Full Detail',
      label: '2019 Ferrari Amalfi Spider',
      tierKey: 'small',
      tierLabel: 'Small Car',
      price: 240,
    });
    box.commitCurrentVehicleToCart();
    ST._startingAdditionalVehicle = true;
    Object.assign(ST, {
      pkgId: '', pkg: null, tierKey: '', tier: null, vehicleLabel: '',
      displayLabel: '', basePrice: 0, addons: [], addonTotal: 0,
    });
    box.syncBs2StickyBar();
    assert.equal(box.document.getElementById('bs2-sticky').hidden, true);
    assert.equal(box.document.getElementById('bs2-sticky-pkg').textContent, '—');
    box.renderVehicleCart();
    assert.match(box.document.getElementById('vcart-items').textContent, /Amalfi/);
  });

  it('recomputes sticky after cart vehicle removal and addon total changes', () => {
    const { ST } = box;
    setCarConfig(ST, {
      pkgId: 'full',
      pkgName: 'Premium Full Detail',
      label: '2019 Ferrari Amalfi Spider',
      tierKey: 'small',
      tierLabel: 'Small Car',
      price: 240,
    });
    box.commitCurrentVehicleToCart();
    ST._editingVehicleIndex = null;
    ST._startingAdditionalVehicle = true;
    setCarConfig(ST, {
      pkgId: 'refresh',
      pkgName: 'Exterior Refresh & Protect',
      label: '2021 Ferrari GTC4Lusso',
      tierKey: 'small',
      tierLabel: 'Small Car',
      price: 355,
      addons: [{ id: 'sealant', name: 'Polymer Sealant', price: 25 }],
    });
    box.syncBs2StickyBar();
    assert.equal(box.bookingServiceTotalForSticky(), 620); // 240 + 355 + 25

    box.removeVehicleFromCart(0);
    // After removing A, only current B remains in sticky math (cart empty while starting additional)
    assert.equal(ST.vehicles.length, 0);
    box.syncBs2StickyBar();
    assert.equal(box.bookingServiceTotalForSticky(), 380); // 355 + 25
    assert.equal(box.document.getElementById('bs2-sticky-pkg').textContent, 'Exterior Refresh & Protect');
  });

  it('getActiveBookingConfig never reads ST.vehicles for package/vehicle identity', () => {
    const { ST } = box;
    ST.vehicles = [{
      pkgId: 'full',
      pkgName: 'Premium Full Detail',
      vehicleLabel: '2019 Ferrari Amalfi Spider',
      subtotal: 240,
      addons: [],
    }];
    setCarConfig(ST, {
      pkgId: 'refresh',
      pkgName: 'Exterior Refresh & Protect',
      label: '2021 Ferrari GTC4Lusso',
      tierKey: 'small',
      tierLabel: 'Small Car',
      price: 355,
    });
    const active = box.getActiveBookingConfig();
    assert.equal(active.pkgId, 'refresh');
    assert.equal(active.pkgName, 'Exterior Refresh & Protect');
    assert.equal(active.vehicleLabel, '2021 Ferrari GTC4Lusso');
    assert.notEqual(active.pkgName, ST.vehicles[0].pkgName);
  });
});
