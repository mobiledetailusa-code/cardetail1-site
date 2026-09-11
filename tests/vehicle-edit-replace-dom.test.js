'use strict';

/**
 * BB-01 / BB-02 black-box freeze repair.
 *
 * Previous suites missed BB-01 because they never drove:
 *   Review → Back → edit vehicle → click Continue
 * Sandboxed first-Continue tests (e.g. powersports-second-defect reachReview)
 * assert vehicles.length === 1 after a single push and cannot see append-on-edit.
 *
 * This file clicks the shipped Continue / Back / Add Another Vehicle / homepage
 * specialty CTA nodes. Setting ST.cat in a sandbox is not a substitute for those
 * clicks; fixtures only stand in for ZIP + search confirmation after the public
 * entry has already opened the booking overlay.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const index = read('index.html');
const lineItemsSrc = read('assets/booking-line-items.js');
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

const ACCORD = {
  label: '2021 Honda Accord',
  display: 'Small Car',
  tierKey: 'small',
  price: 240,
};
const CRV = {
  label: '2021 Honda CR-V',
  display: 'SUV 2-Row',
  tierKey: 'suv2',
  price: 260,
};
const PILOT = {
  label: '2021 Honda Pilot',
  display: 'SUV 3-Row',
  tierKey: 'suv3',
  price: 270,
};

function applyCarFixture(win, fixture) {
  Object.assign(win.ST, {
    cat: 'cars',
    pkgId: 'full',
    pkg: { name: 'Premium Full Detail', icon: '🧽' },
    vehicleLabel: fixture.label,
    displayLabel: fixture.display,
    tierKey: fixture.tierKey,
    tier: { label: fixture.display, full: fixture.price },
    basePrice: fixture.price,
    addons: [],
    addonTotal: 0,
    lengthFt: 0,
    units: 1,
  });
}

function reviewSnapshot(win) {
  const cards = [...win.document.querySelectorAll('#c-vehicle-cards .bkli-vehicle')];
  const title = win.document.getElementById('c-service-title');
  const totalText = win.document.getElementById('c-total');
  const labels = win.ST.vehicles.map((v) => v.vehicleLabel);
  const totals = Review.presentationTotals({
    vehicles: win.ST.vehicles.map((v) => ({
      basePrice: v.basePrice,
      addonTotal: v.addonTotal || 0,
      subtotal: v.subtotal,
    })),
    travelFeeAmount: 0,
    totalPrice: win.ST.vehicles.reduce((s, v) => s + (Number(v.subtotal) || 0), 0),
  });
  return {
    cardCount: cards.length,
    cardText: cards.map((el) => el.textContent).join('\n'),
    title: title ? title.textContent : '',
    totalText: totalText ? totalText.textContent : '',
    estimatedTotal: totals.estimatedTotal,
    labels,
    length: win.ST.vehicles.length,
  };
}

function mountBooking() {
  const bs1 = `
    <div class="bsec on" id="bs1">
      <div class="svc-card" id="bkcat-cars">Cars &amp; SUVs</div>
      <div class="bk-cat-specialty">
        <div class="bk-cat-specialty-label">Boats, RVs &amp; powersports</div>
        <div class="svc-card" id="bkcat-boats">Boats</div>
        <div class="svc-card" id="bkcat-rvs">RVs &amp; Trailers</div>
        <div class="svc-card" id="bkcat-powersports">Powersports</div>
      </div>
    </div>`;
  const bs2 = `
    <div class="bsec" id="bs2">
      <div class="pkg" id="pk-full">Premium Full Detail</div>
      <button type="button" class="btn-n" id="next2">Continue to vehicle →</button>
    </div>`;
  const bs3 = extractSection(index, 'bs3');
  const bs4 = extractSection(index, 'bs4');
  const bs5 = extractSection(index, 'bs5');
  const cta = index.match(/<button type="button" class="btn-outline" id="home-specialty-cta"[\s\S]*?<\/button>/);
  assert.ok(cta, 'homepage specialty CTA must exist as a button');
  const nav = index.match(/<nav class="specialty-service-nav"[\s\S]*?<\/nav>/);
  assert.ok(nav, 'specialty nav must exist');

  const dom = new JSDOM(
    `<!DOCTYPE html><html><body>
      ${nav[0]}
      <div class="car-services-cta">
        <button type="button" class="btn-primary" id="home-all-packages">View all packages</button>
        ${cta[0]}
      </div>
      <div id="bk-ov">
        <div class="booking-modal">
          ${bs1}${bs2}${bs3}${bs4}${bs5}
          <input id="f-first" value="Audit"><input id="f-last" value="Tester">
          <input id="f-phone" value="201-555-0199"><input id="f-email" value="audit-test@example.com">
          <input id="f-addr" value="200 Broad Ave"><input id="f-date" value="2026-09-18">
          <input id="f-time" value="anytime">
        </div>
      </div>
      <script>${lineItemsSrc}</script>
    </body></html>`,
    { runScripts: 'dangerously', url: 'https://cardetail1.com/', pretendToBeVisual: true }
  );
  const { window } = dom;
  window.alert = () => {};
  window.ST = {
    cat: '', pkgId: '', pkg: null, tierKey: '', tier: null, vehicleLabel: '',
    displayLabel: '', basePrice: 0, addons: [], addonTotal: 0, lengthFt: 0,
    units: 1, vehicles: [], offerPreview: null, payMethod: '',
    _editingVehicleIndex: null, _startingAdditionalVehicle: false,
  };
  window.currentBkStep = 1;
  window.getTravelFeeAmount = () => 0;
  window.getVehicleVisualKey = () => 'sedan';
  window.VEHICLE_VISUALS = { sedan: { img: '/a.png', alt: 'car' } };
  window.CATEGORY_VISUALS = {};
  window.Cardetail1CheckoutAnalytics = { onStepCompleted() {}, onStepBack() {} };
  window.Cardetail1BookingReview = Review;
  window.Cardetail1WelcomeOffer = null;
  window.CD1BookingProgress = { persist() {} };

  window.bkGoTo = function bkGoTo(n) {
    window.currentBkStep = n;
    window.document.querySelectorAll('.bsec').forEach((s) => {
      s.classList.toggle('on', s.id === 'bs' + n);
    });
    if (n === 3) window.renderVehicleCart();
    if (n === 5) {
      window.fillConfirm();
    }
  };
  window.openBooking = function openBooking(cat) {
    window.__openedBookingCat = cat == null ? null : cat;
    window.document.getElementById('bk-ov').classList.add('open');
    window.document.body.style.overflow = 'hidden';
    if (!cat) window.bkGoTo(1);
  };
  window.selectCategory = function selectCategory(cat) {
    window.ST.cat = cat;
    window.__selectedCat = cat;
    window.bkGoTo(2);
  };
  window.selectPkg = function selectPkg(id) {
    window.ST.pkgId = id;
    window.ST.pkg = { name: 'Premium Full Detail', icon: '🧽' };
    window.__selectedPkg = id;
    window.bkGoTo(3);
  };
  window.goToPayment = function goToPayment() {
    window.bkGoTo(5);
  };
  window.ensureStep5Defaults = function ensureStep5Defaults() {};
  window.renderStep5Summary = function renderStep5Summary() {};
  window.fillStrip5 = function fillStrip5() {};
  window.selectRequestPaymentPreference = function selectRequestPaymentPreference() {};

  const glue = [
    extractFunction(index, 'bkMoney'),
    extractFunction(index, 'bkEsc'),
    extractFunction(index, 'bkProjectVehicles'),
    extractFunction(index, 'bkRenderVehicleSummary'),
    extractFunction(index, 'buildCurrentVehicleItem'),
    extractFunction(index, 'commitCurrentVehicleToCart'),
    extractFunction(index, 'addCurrentVehicleToCart'),
    extractFunction(index, 'addCurrentVehicleAndContinue'),
    extractFunction(index, 'removeVehicleFromCart'),
    extractFunction(index, 'renderVehicleCart'),
    extractFunction(index, 'fillConfirm'),
  ].join('\n');
  window.eval(
    glue +
    '\nwindow.commitCurrentVehicleToCart = commitCurrentVehicleToCart;' +
    '\nwindow.addCurrentVehicleToCart = addCurrentVehicleToCart;' +
    '\nwindow.addCurrentVehicleAndContinue = addCurrentVehicleAndContinue;' +
    '\nwindow.removeVehicleFromCart = removeVehicleFromCart;' +
    '\nwindow.renderVehicleCart = renderVehicleCart;' +
    '\nwindow.fillConfirm = fillConfirm;' +
    '\nwindow.buildCurrentVehicleItem = buildCurrentVehicleItem;'
  );

  window.document.getElementById('bkcat-cars').addEventListener('click', () => window.selectCategory('cars'));
  window.document.getElementById('pk-full').addEventListener('click', () => window.selectPkg('full'));
  return window;
}

function clickContinue(win) {
  const btn = win.document.getElementById('next3');
  assert.ok(btn, '#next3 Continue must exist');
  btn.disabled = false;
  btn.click();
}

function clickReview(win) {
  const btn = [...win.document.querySelectorAll('#bs4 .btn-n')].find((el) => /Review/i.test(el.textContent));
  assert.ok(btn, 'Info Review details button must exist');
  btn.click();
}

function clickBackToVehicle(win) {
  const reviewBack = [...win.document.querySelectorAll('#bs5 .btn-b')].find((el) => /Back/i.test(el.textContent));
  assert.ok(reviewBack, 'Review Back must exist');
  reviewBack.click();
  const infoBack = [...win.document.querySelectorAll('#bs4 .btn-b')].find((el) => /Back/i.test(el.textContent));
  assert.ok(infoBack, 'Info Back must exist');
  infoBack.click();
}

describe('BB-01 Review → Back → edit vehicle replaces instead of appending', () => {
  it('first Continue commits exactly one vehicle and Review matches it', () => {
    const win = mountBooking();
    win.document.getElementById('home-all-packages').click();
    win.openBooking(null);
    win.document.getElementById('bkcat-cars').click();
    win.document.getElementById('pk-full').click();
    applyCarFixture(win, ACCORD);
    clickContinue(win);
    assert.equal(win.currentBkStep, 4);
    clickReview(win);
    const snap = reviewSnapshot(win);
    assert.equal(snap.length, 1);
    assert.equal(snap.cardCount, 1);
    assert.match(snap.cardText, /2021 Honda Accord/);
    assert.doesNotMatch(snap.cardText, /CR-V/);
    assert.equal(snap.estimatedTotal, 240);
    assert.match(snap.totalText, /\$240\.00/);
  });

  it('Back without changing the vehicle does not duplicate it', () => {
    const win = mountBooking();
    win.openBooking(null);
    win.document.getElementById('bkcat-cars').click();
    win.document.getElementById('pk-full').click();
    applyCarFixture(win, ACCORD);
    clickContinue(win);
    clickReview(win);
    clickBackToVehicle(win);
    clickContinue(win);
    clickReview(win);
    const snap = reviewSnapshot(win);
    assert.equal(snap.length, 1);
    assert.equal(snap.cardCount, 1);
    assert.equal(snap.estimatedTotal, 240);
  });

  it('Accord → Review → Back → CR-V → Continue keeps one vehicle and CR-V total only', () => {
    const win = mountBooking();
    win.openBooking(null);
    win.document.getElementById('bkcat-cars').click();
    win.document.getElementById('pk-full').click();
    applyCarFixture(win, ACCORD);
    clickContinue(win);
    clickReview(win);
    clickBackToVehicle(win);
    applyCarFixture(win, CRV);
    clickContinue(win);
    clickReview(win);
    const snap = reviewSnapshot(win);
    assert.equal(snap.length, 1, 'Continue after edit must replace, not append');
    assert.equal(snap.cardCount, 1);
    assert.match(snap.cardText, /2021 Honda CR-V/);
    assert.doesNotMatch(snap.cardText, /Accord/);
    assert.equal(snap.estimatedTotal, 260);
    assert.match(snap.totalText, /\$260\.00/);
    assert.doesNotMatch(snap.totalText, /\$500/);
    assert.doesNotMatch(snap.title, /2 vehicles/);
  });

  it('repeated Back/edit cycles still leave a single vehicle', () => {
    const win = mountBooking();
    win.openBooking(null);
    win.document.getElementById('bkcat-cars').click();
    win.document.getElementById('pk-full').click();
    applyCarFixture(win, ACCORD);
    clickContinue(win);
    clickReview(win);
    clickBackToVehicle(win);
    applyCarFixture(win, CRV);
    clickContinue(win);
    clickReview(win);
    clickBackToVehicle(win);
    applyCarFixture(win, PILOT);
    clickContinue(win);
    clickReview(win);
    const snap = reviewSnapshot(win);
    assert.equal(snap.length, 1);
    assert.equal(snap.cardCount, 1);
    assert.match(snap.cardText, /2021 Honda Pilot/);
    assert.doesNotMatch(snap.cardText, /Accord/);
    assert.doesNotMatch(snap.cardText, /CR-V/);
    assert.equal(snap.estimatedTotal, 270);
  });

  it('explicit Add Another Vehicle still appends a second vehicle', () => {
    const win = mountBooking();
    win.openBooking(null);
    win.document.getElementById('bkcat-cars').click();
    win.document.getElementById('pk-full').click();
    applyCarFixture(win, ACCORD);
    const addBtn = [...win.document.querySelectorAll('.btn-add-veh')].find((el) => /Add Another Vehicle/i.test(el.textContent));
    assert.ok(addBtn, 'Add Another Vehicle must exist');
    addBtn.click();
    assert.equal(win.ST.vehicles.length, 1);
    assert.equal(win.ST._startingAdditionalVehicle, true);
    applyCarFixture(win, CRV);
    clickContinue(win);
    clickReview(win);
    const snap = reviewSnapshot(win);
    assert.equal(snap.length, 2);
    assert.equal(snap.cardCount, 2);
    assert.match(snap.cardText, /Accord/);
    assert.match(snap.cardText, /CR-V/);
    assert.equal(snap.estimatedTotal, 500);
  });
});

describe('BB-02 homepage specialty CTA is not Boats-only', () => {
  it('ships a button that opens booking with no category preselected', () => {
    const ctaBlock = index.slice(
      index.indexOf('class="car-services-cta"'),
      index.indexOf('class="car-services-cta"') + 700
    );
    assert.match(ctaBlock, /id="home-specialty-cta"/);
    assert.match(ctaBlock, /onclick="openBooking\(null\)"/);
    assert.doesNotMatch(ctaBlock, /href="boats-detailing\.html"/);
    assert.match(ctaBlock, /Boats, RVs &amp; powersports/);
  });

  it('clicking the CTA opens category chooser with RV, Boat, and Powersports', () => {
    const win = mountBooking();
    const cta = win.document.getElementById('home-specialty-cta');
    assert.ok(cta);
    assert.equal(cta.tagName, 'BUTTON');
    cta.click();
    assert.equal(win.__openedBookingCat, null);
    assert.equal(win.document.getElementById('bk-ov').classList.contains('open'), true);
    assert.equal(win.document.getElementById('bs1').classList.contains('on'), true);
    assert.ok(win.document.getElementById('bkcat-rvs'));
    assert.ok(win.document.getElementById('bkcat-boats'));
    assert.ok(win.document.getElementById('bkcat-powersports'));
  });

  it('dedicated specialty nav links keep RV / Boat / Powersports destinations', () => {
    const nav = index.match(/<nav class="specialty-service-nav"[\s\S]*?<\/nav>/)[0];
    assert.match(nav, /href="rv-detailing\.html"/);
    assert.match(nav, /href="boats-detailing\.html"/);
    assert.match(nav, /href="powersports-detailing\.html"/);
    const win = mountBooking();
    const hrefs = [...win.document.querySelectorAll('.specialty-service-link')].map((a) => a.getAttribute('href'));
    assert.deepEqual(hrefs, [
      'rv-detailing.html',
      'boats-detailing.html',
      'powersports-detailing.html',
    ]);
  });
});
