'use strict';

/**
 * CARDDETAIL1 — multi-vehicle hard limit + optional Fleet Pricing.
 *
 * Proves:
 * - No cart hard limit at 5
 * - Vehicle #6 / #7 remain on standard booking
 * - Backend accepts 6+ personal vehicles
 * - Optional Fleet callout appears at 6 without blocking Continue / Add Another Vehicle
 * - Explicit commercial / fleet category still routes to fleet quote
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { validateBookingRouting } = require('../netlify/lib/booking-routing-validation');
const { classifySegment, SEGMENTS } = require('../netlify/lib/revenue-segments');
const strategy = require('../netlify/lib/universal-customer-strategy');
const { recommendNextAction } = require('../netlify/lib/next-best-action');

const ROOT = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const lineItemsSrc = fs.readFileSync(path.join(ROOT, 'assets/booking-line-items.js'), 'utf8');
const calloutSrc = fs.readFileSync(path.join(ROOT, 'assets/multi-vehicle-fleet-callout.js'), 'utf8');
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

function extractSection(src, id) {
  const re = new RegExp(`<div class="bsec[^"]*"\\s+id="${id}"[^>]*>`);
  const m = src.match(re);
  assert.ok(m && m.index >= 0, '#' + id + ' should exist');
  const start = m.index;
  const ids = ['bs1', 'bs2', 'bs3', 'bs4', 'bs5', 'bs6'];
  const nextId = ids[ids.indexOf(id) + 1];
  const next = nextId ? src.indexOf(`id="${nextId}"`, start + 10) : -1;
  const cut = next > start ? src.lastIndexOf('<div', next) : src.length;
  return src.slice(start, cut > start ? cut : src.length);
}

function mountBooking() {
  const bs3 = extractSection(index, 'bs3');
  const bs4 = extractSection(index, 'bs4');
  const bs5 = extractSection(index, 'bs5');
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head></head><body>
      <div id="bk-ov" class="open"><div class="booking-modal">
        <div class="bsec on" id="bs1"><div class="svc-card" id="bkcat-cars">Cars</div></div>
        <div class="bsec" id="bs2"><div class="pkg" id="pk-full">Full</div></div>
        ${bs3}${bs4}${bs5}
      </div></div>
      <script>${lineItemsSrc}</script>
    </body></html>`,
    { runScripts: 'dangerously', url: 'https://cardetail1.com/', pretendToBeVisual: true }
  );
  const win = dom.window;
  win.alert = () => {};
  win.ST = {
    cat: '', pkgId: '', pkg: null, tierKey: '', tier: null, vehicleLabel: '',
    displayLabel: '', basePrice: 0, addons: [], addonTotal: 0, lengthFt: 0,
    units: 1, vehicles: [], _editingVehicleIndex: null, _startingAdditionalVehicle: false,
    offerPreview: null, payMethod: '',
  };
  win.currentBkStep = 1;
  win.getTravelFeeAmount = () => 0;
  win.getVehicleVisualKey = () => 'sedan';
  win.VEHICLE_VISUALS = { sedan: { img: '/a.png', alt: 'car' } };
  win.CATEGORY_VISUALS = {};
  win.Cardetail1CheckoutAnalytics = { onStepCompleted() {}, onStepBack() {} };
  win.Cardetail1BookingReview = Review;
  win.Cardetail1WelcomeOffer = null;
  win.openCommercialInquiry = function () { win.__fleetAsk = true; };
  win.bkGoTo = function (n) {
    win.currentBkStep = n;
    win.document.querySelectorAll('.bsec').forEach((s) => {
      s.classList.toggle('on', s.id === 'bs' + n);
    });
    if (n === 3) win.renderVehicleCart();
    if (n === 5) win.fillConfirm();
  };
  const glue = [
    'bkMoney', 'bkEsc', 'bkProjectVehicles', 'bkRenderVehicleSummary',
    'buildCurrentVehicleItem', 'commitCurrentVehicleToCart', 'addCurrentVehicleToCart',
    'addCurrentVehicleAndContinue', 'removeVehicleFromCart', 'renderVehicleCart', 'fillConfirm',
  ].map((n) => extractFunction(index, n)).join('\n');
  win.eval(
    glue +
    ';window.addCurrentVehicleToCart=addCurrentVehicleToCart;' +
    'window.addCurrentVehicleAndContinue=addCurrentVehicleAndContinue;' +
    'window.renderVehicleCart=renderVehicleCart;' +
    'window.commitCurrentVehicleToCart=commitCurrentVehicleToCart;' +
    'window.removeVehicleFromCart=removeVehicleFromCart;' +
    'window.fillConfirm=fillConfirm;' +
    'window.buildCurrentVehicleItem=buildCurrentVehicleItem;'
  );
  const script = win.document.createElement('script');
  script.textContent = calloutSrc;
  win.document.body.appendChild(script);
  if (win.CD1OptionalFleetCallout) win.CD1OptionalFleetCallout.install();
  return win;
}

function configureCar(win, i) {
  Object.assign(win.ST, {
    cat: 'cars',
    pkgId: 'full',
    pkg: { name: 'Premium Full Detail', icon: '🧽' },
    vehicleLabel: '2020 Honda Civic #' + (i + 1),
    displayLabel: 'Small Car',
    tierKey: 'small',
    tier: { label: 'Small Car', full: 240 },
    basePrice: 240 + i * 10,
    addons: i === 0 ? [{ id: 'polymer', name: 'Polymer', price: 25, qty: 1 }] : [],
    addonTotal: i === 0 ? 25 : 0,
    lengthFt: 0,
    units: 1,
  });
  win.bkGoTo(3);
  const next3 = win.document.getElementById('next3');
  if (next3) next3.disabled = false;
}

function cartSnapshot(win, label) {
  const addBtn = [...win.document.querySelectorAll('.btn-add-veh')].find((el) => /Add Another Vehicle/i.test(el.textContent));
  const cont = win.document.getElementById('next3');
  const callout = win.document.getElementById('cd1-optional-fleet-callout');
  const items = win.document.querySelectorAll('#vcart-items .vcart-item').length;
  const totalText = (win.document.getElementById('vcart-sum') || {}).textContent || '';
  const sum = win.ST.vehicles.reduce((s, v) => s + (Number(v.subtotal) || 0), 0);
  return {
    label,
    stLen: win.ST.vehicles.length,
    visibleCart: items,
    cartTotal: totalText,
    expectedTotal: '$' + sum,
    addVisible: !!addBtn,
    addDisabled: !!(addBtn && addBtn.disabled),
    contVisible: !!cont,
    contDisabled: !!(cont && cont.disabled),
    fleetCallout: !!(callout && callout.classList.contains('show')),
    step: win.currentBkStep,
  };
}

describe('multi-vehicle optional fleet — classification + backend', () => {
  it('does not force commercial fleet from personal vehicle count alone', () => {
    for (const n of [5, 6, 7, 8, 10, 50, 100]) {
      const seg = classifySegment({ vehicleCount: n, ownership: 'personal', assetCategories: ['cars'] });
      assert.equal(seg.segment, SEGMENTS.MULTI_VEHICLE_HOUSEHOLD, 'n=' + n);
      const route = strategy.routeServiceIntent({
        category: 'cars',
        vehicleCount: n,
        vehicles: Array.from({ length: Math.min(n, 12) }, () => ({ cat: 'cars' })),
      });
      assert.equal(route.allowed, true, 'n=' + n);
      assert.equal(route.routing.standardBookingAllowed, true, 'n=' + n);
      assert.notEqual(route.route, 'fleet_quote', 'n=' + n);
    }
  });

  it('backend accepts large personal carts (50 and 100) at full-price standard booking', () => {
    for (const n of [50, 100]) {
      const booking = {
        zipCode: '07650',
        vehicleCategory: 'cars',
        vehicles: Array.from({ length: n }, (_, i) => ({
          cat: 'cars',
          pkgId: 'full',
          vehicleLabel: '2020 Honda Civic #' + (i + 1),
          basePrice: 240,
          addonTotal: 0,
          subtotal: 240,
        })),
      };
      const r = validateBookingRouting(booking);
      assert.equal(r.ok, true, 'n=' + n + ' ' + JSON.stringify(r));
      assert.equal(r.route, 'standard_booking');
      const nba = recommendNextAction({ vehicleCount: n });
      assert.equal(nba.action, 'recommend_optional_fleet_pricing');
      assert.equal(nba.optional, true);
      assert.equal(nba.continueBookingAllowed, true);
    }
  });

  it('backend accepts 6 and 7 vehicle residential payloads', () => {
    for (const n of [6, 7]) {
      const booking = {
        zipCode: '07650',
        vehicleCategory: 'cars',
        vehicles: Array.from({ length: n }, (_, i) => ({
          cat: 'cars',
          pkgId: 'full',
          vehicleLabel: '2020 Honda Civic #' + (i + 1),
          basePrice: 240 + i * 10,
          addonTotal: 0,
          subtotal: 240 + i * 10,
        })),
      };
      const r = validateBookingRouting(booking);
      assert.equal(r.ok, true, 'n=' + n + ' ' + JSON.stringify(r));
      assert.equal(r.route, 'standard_booking');
      const payloadBytes = JSON.stringify(booking).length;
      assert.ok(payloadBytes < 20000, 'payload unexpectedly large: ' + payloadBytes);
    }
  });

  it('optional fleet recommendation does not block booking', () => {
    const n = recommendNextAction({ vehicleCount: 6 });
    assert.equal(n.action, 'recommend_optional_fleet_pricing');
    assert.equal(n.optional, true);
    assert.equal(n.continueBookingAllowed, true);
  });

  it('explicit commercial still blocks standard booking', () => {
    const r = validateBookingRouting({
      zipCode: '07650',
      vehicleCategory: 'cars',
      isCommercial: true,
      vehicles: Array.from({ length: 6 }, () => ({ cat: 'cars', pkgId: 'full', vehicleLabel: 'Fleet unit', subtotal: 200 })),
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'fleet_quote_required');
  });
});

describe('multi-vehicle optional fleet — real-DOM cart progression', () => {
  it('supports sequential Add Another Vehicle through 7 with correct totals and optional fleet at 6+', () => {
    const win = mountBooking();
    const rows = [];
    for (let i = 0; i < 7; i++) {
      configureCar(win, i);
      if (i < 6) {
        win.addCurrentVehicleToCart();
      } else {
        win.addCurrentVehicleAndContinue();
      }
      const snap = cartSnapshot(win, 'after-' + (i + 1));
      rows.push(snap);
      assert.equal(snap.stLen, i + 1, snap.label);
      assert.equal(snap.visibleCart, i + 1, snap.label);
      assert.equal(snap.cartTotal, snap.expectedTotal, snap.label);
      assert.equal(snap.addVisible, true, snap.label);
      assert.equal(snap.addDisabled, false, snap.label);
      if (i + 1 >= 6) assert.equal(snap.fleetCallout, true, 'fleet callout at ' + (i + 1));
      else assert.equal(snap.fleetCallout, false, 'no fleet callout at ' + (i + 1));
    }

    // Continue Booking dismisses callout without clearing cart / changing total
    const beforeTotal = rows[6].cartTotal;
    const beforeLen = win.ST.vehicles.length;
    win.document.getElementById('cd1-fleet-continue').click();
    assert.equal(win.document.getElementById('cd1-optional-fleet-callout').classList.contains('show'), false);
    assert.equal(win.ST.vehicles.length, beforeLen);
    win.renderVehicleCart();
    assert.equal((win.document.getElementById('vcart-sum') || {}).textContent, beforeTotal);
    assert.equal(win.__fleetAsk, undefined);

    // Review includes all 7 vehicles
    win.bkGoTo(5);
    const cards = win.document.querySelectorAll('#c-vehicle-cards .bkli-vehicle');
    assert.equal(cards.length, 7);
    const title = win.document.getElementById('c-service-title');
    assert.match(title.textContent, /7 vehicles/);
  });

  it('Ask About Fleet Pricing is optional secondary action', () => {
    const win = mountBooking();
    for (let i = 0; i < 6; i++) {
      configureCar(win, i);
      win.addCurrentVehicleToCart();
    }
    assert.equal(win.ST.vehicles.length, 6);
    win.document.getElementById('cd1-fleet-ask').click();
    assert.equal(win.__fleetAsk, true);
    assert.equal(win.ST.vehicles.length, 6);
  });
});

describe('multi-vehicle optional fleet — page wiring', () => {
  it('index and hubs load optional fleet callout after routing gate', () => {
    const pages = [
      'index.html',
      'new-jersey-hub.html',
      'bergen-county-hub.html',
      'multi-vehicle-detailing.html',
      'boats-detailing.html',
    ];
    for (const page of pages) {
      const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
      assert.match(html, /booking-routing-gate\.js[\s\S]*multi-vehicle-fleet-callout\.js/, page);
    }
  });
});
