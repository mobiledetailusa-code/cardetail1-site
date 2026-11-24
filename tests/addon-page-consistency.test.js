'use strict';

// Cross-page consistency of the car booking add-ons.
//
// Loads each of the 13 pages that carry the car booking (the homepage modal and
// the 12 hub / city pages whose inline modal is the fallback when the hub
// bridge cannot run), renders the add-on step for every car package and size
// with the page's own scripts, and checks that:
//   - every page offers the same add-ons at the same prices for the same
//     package and size (documented exceptions only);
//   - every add-on a page shows is accepted by the server at that price;
//   - the decisions of the November 2026 add-on audit hold (Mold Treatment and
//     Trash Can Cleaning, Headlight Restoration on Interior Detail, wax and
//     sealant redundancy, Undercarriage size bands);
//   - the frontend total equals the server total, travel fee included.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, ResourceLoader, VirtualConsole } = require('jsdom');

const Rules = require('../assets/addon-rules');
const { PRICING, computeVehicleSubtotal, computeBookingServiceSubtotal } = require('../netlify/lib/booking-price-catalog');
const { applyServerTravelAndTotal } = require('../netlify/lib/travel-fee');

const ROOT = path.join(__dirname, '..');
const HOME = 'index.html';
const PAGES = [
  HOME, 'bergen-county-hub.html', 'connecticut-hub.html', 'essex-county-hub.html',
  'hudson-county-hub.html', 'new-jersey-hub.html', 'newark-mobile-detailing.html',
  'ny-metro-hub.html', 'passaic-county-hub.html', 'pennsylvania-hub.html', 'template-city.html',
  'trenton-mobile-detailing.html', 'westchester-mobile-detailing.html',
];
const CAR_PACKAGES = ['wash', 'maint', 'interior', 'full', 'refresh', 'premium'];
const TIERS = Object.keys(PRICING.cars.tiers);

// Known, documented page differences. Anything else fails the test.
//   (none: Signature engine bay was resolved on 2026-11-24, see below)
const DOCUMENTED_EXCEPTIONS = [];

class LocalLoader extends ResourceLoader {
  fetch(url) {
    const u = new URL(url);
    if (u.hostname !== 'localhost') return Promise.resolve(Buffer.from(''));
    const file = path.join(ROOT, decodeURIComponent(u.pathname).replace(/^\/+/, ''));
    if (!/\.js$/.test(file) || !fs.existsSync(file)) return Promise.resolve(Buffer.from(''));
    return Promise.resolve(fs.readFileSync(file));
  }
}

function loadPage(file) {
  const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, {
    url: 'http://localhost/' + file,
    runScripts: 'dangerously',
    resources: new LocalLoader(),
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(w) {
      w.fetch = () => Promise.resolve({ ok: false, status: 503, json: async () => ({}), text: async () => '' });
      w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
      w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.scrollTo = () => {};
      w.HTMLElement.prototype.scrollIntoView = function () {};
    },
  });
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(dom.window); } };
    dom.window.addEventListener('load', () => setTimeout(finish, 50));
    setTimeout(finish, 20000);
  });
}

function shown(w, el) {
  for (let n = el; n && n !== w.document.body; n = n.parentElement) {
    // The collapsed "View More Interior Add-ons" panel is one click away.
    if (n.hidden && n.id !== 'cd1-more-panel') return false;
    if (n.classList && (n.classList.contains('cd1-addon-unavailable') || n.classList.contains('cd1-empty'))) return false;
    if (n.style && n.style.display === 'none') return false;
  }
  return true;
}

function render(w, pkgId, tierKey) {
  w.eval(`(function(){
    ST.cat='cars'; ST.tierKey=${JSON.stringify(tierKey)}; ST.tier=PRICING.cars.tiers[${JSON.stringify(tierKey)}];
    ST.vehicleLabel='2022 Test Car'; ST.make='Toyota'; ST.model='Camry';
    ST.pkgId=${JSON.stringify(pkgId)}; ST.pkg=PRICING.cars.packages.find(function(x){return x.id===${JSON.stringify(pkgId)};});
    ST._addonKey=''; ST.addons=[]; ST.addonTotal=0;
    if(typeof setBasePrice==='function') setBasePrice();
    window.renderAddons();
  })()`);
  const offered = new Map();
  for (const card of w.document.querySelectorAll('#addon-grid .addon[data-id]')) {
    if (!shown(w, card)) continue;
    const price = Number(((card.querySelector('.addon-price') || {}).textContent || '').replace(/each$/, '').replace(/[^0-9.]/g, ''));
    offered.set(card.getAttribute('data-id'), price);
  }
  const preselected = w.eval('ST.addons.length') + w.document.querySelectorAll('#addon-grid .addon.sel').length;
  return { base: w.eval('ST.basePrice'), offered, preselected };
}

function serverLine(pkgId, tierKey, id) {
  const vehicle = { cat: 'cars', category: 'cars', pkgId, packageId: pkgId, tierKey, addons: [{ id }] };
  if (!Rules.validateNewBookingAddons({ vehicles: [JSON.parse(JSON.stringify(vehicle))] }).ok) return { ok: false };
  const r = computeVehicleSubtotal(vehicle, '07601', { zipCode: '07601' });
  if (!r.ok) return { ok: false, error: r.error };
  const line = r.addons.find((a) => a.id === id);
  return { ok: true, price: line ? line.price : 0, base: r.basePrice };
}

const MATRIX = {};

test.before(async () => {
  for (const file of PAGES) {
    const w = await loadPage(file);
    MATRIX[file] = {};
    for (const pkg of CAR_PACKAGES) {
      for (const tier of TIERS) MATRIX[file][pkg + '|' + tier] = render(w, pkg, tier);
    }
    // Package inclusion text each page shows for Full, Refresh and Signature.
    MATRIX[file].pkgText = JSON.parse(w.eval("JSON.stringify(Object.fromEntries(['full','refresh','premium'].map(function(id){" +
      "var p = PRICING.cars.packages.find(function(x){ return x.id === id; }) || {};" +
      "return [id, [].concat(p.ext || [], p.feats || []).join(' | ')];})))"));
    // Ceramic checkout panel ("More services") for the 1-year package.
    render(w, 'ceramic_1yr', 'small');
    const more = w.document.getElementById('ceramic-more');
    MATRIX[file].ceramicMore = more ? more.textContent.replace(/\s+/g, ' ') : '';
    // Frontend running total for a mixed selection, read from the page itself.
    MATRIX[file].totals = {};
    for (const [key, pkg, ids] of [
      ['interior+headlight', 'interior', ['headlight']],
      ['full+combo', 'full', ['superint', 'pethair', 'headlight', 'polymer']],
      ['wash+exterior', 'wash', ['wax1yr', 'undercarriage', 'engine', 'claybar']],
      ['maint+floormats', 'maint', ['floormats']],
    ]) {
      render(w, pkg, 'suv2');
      for (const id of ids) {
        const card = w.document.querySelector('#addon-grid .addon[data-id="' + id + '"]');
        if (card && shown(w, card)) w.eval('toggleAddon')(card);
      }
      // Per-unit control: a second floor mat through the page's own stepper.
      if (key === 'maint+floormats') w.eval("addonQty('floormats', 1)");
      MATRIX[file].totals[key + ':qty'] = JSON.parse(w.eval('JSON.stringify(ST.addons.map(function(a){return [a.id, a.qty || 1];}))'));
      MATRIX[file].totals[key] = {
        base: w.eval('ST.basePrice'),
        addonTotal: w.eval('ST.addonTotal'),
        ids: JSON.parse(w.eval('JSON.stringify(ST.addons.map(function(a){return a.id;}))')),
      };
    }
    w.close();
  }
});

function exceptionFor(file, pkg, id) {
  return DOCUMENTED_EXCEPTIONS.find((e) => e.pages.includes(file) && e.packages.includes(pkg) && e.id === id);
}

test('every page offers the same car add-ons at the same prices as the homepage', () => {
  const problems = [];
  for (const file of PAGES.filter((p) => p !== HOME)) {
    for (const key of Object.keys(MATRIX[HOME]).filter((k) => k.includes('|'))) {
      const [pkg] = key.split('|');
      const home = MATRIX[HOME][key];
      const page = MATRIX[file][key];
      if (page.base !== home.base) problems.push(`${file} ${key} base ${page.base} != ${home.base}`);
      for (const [id, price] of home.offered) {
        if (!page.offered.has(id)) problems.push(`${file} ${key} missing ${id}`);
        else if (page.offered.get(id) !== price) problems.push(`${file} ${key} ${id} $${page.offered.get(id)} != $${price}`);
      }
      for (const id of page.offered.keys()) {
        if (!home.offered.has(id) && !exceptionFor(file, pkg, id)) problems.push(`${file} ${key} extra ${id}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('documented exceptions still exist (remove them here once resolved)', () => {
  assert.ok(Array.isArray(DOCUMENTED_EXCEPTIONS));
  for (const e of DOCUMENTED_EXCEPTIONS) {
    for (const pkg of e.packages) {
      assert.equal(MATRIX[HOME][pkg + '|small'].offered.has(e.id), false, `${pkg} home ${e.id}`);
      assert.equal(MATRIX[e.pages[0]][pkg + '|small'].offered.has(e.id), true, `${pkg} ${e.pages[0]} ${e.id}`);
    }
  }
});

test('every add-on a page shows is accepted by the server at the shown price, and package prices match', () => {
  const problems = [];
  for (const file of PAGES) {
    for (const key of Object.keys(MATRIX[file]).filter((k) => k.includes('|'))) {
      const [pkg, tier] = key.split('|');
      const cell = MATRIX[file][key];
      if (cell.base !== PRICING.cars.tiers[tier][pkg]) problems.push(`${file} ${key} base ${cell.base}`);
      for (const [id, price] of cell.offered) {
        const s = serverLine(pkg, tier, id);
        if (!s.ok) problems.push(`${file} ${key} ${id} refused by server (${s.error || 'rules'})`);
        else if (s.price !== price) problems.push(`${file} ${key} ${id} shown $${price} server $${s.price}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

function offeredOnAllPages(pkg, tier, id) {
  return PAGES.map((p) => MATRIX[p][pkg + '|' + tier].offered.get(id));
}

test('Maintenance Detail: no Mold Treatment, Trash Cans or specialized interior treatments', () => {
  for (const id of ['mold', 'trashcans', 'superint', 'biohazard', 'odor', 'sanitize', 'wax1yr']) {
    for (const tier of TIERS) assert.deepEqual(offeredOnAllPages('maint', tier, id).filter(Boolean), [], `maint ${tier} ${id}`);
    assert.equal(Rules.validateNewBookingAddons({ vehicles: [{ cat: 'cars', pkgId: 'maint', addons: [{ id }] }] }).ok, false, id);
    assert.equal(Rules.validateAddedAddons('cars', 'maint', [id]).ok, false, `portal ${id}`);
  }
  // Mold Treatment stays on packages with a real interior procedure.
  for (const pkg of ['interior', 'full', 'premium']) {
    assert.deepEqual(new Set(offeredOnAllPages(pkg, 'small', 'mold')), new Set([149]), pkg);
  }
});

test('Maintenance Detail keeps Floor Mat Deep Clean as a paid $20-per-unit add-on, never preselected', () => {
  for (const tier of TIERS) assert.deepEqual(new Set(offeredOnAllPages('maint', tier, 'floormats')), new Set([20]), tier);
  assert.equal(Rules.validateNewBookingAddons({ vehicles: [{ cat: 'cars', pkgId: 'maint', addons: [{ id: 'floormats', qty: 2 }] }] }).ok, true);
  assert.equal(Rules.validateAddedAddons('cars', 'maint', ['floormats']).ok, true, 'portal may add it');
  for (const file of PAGES) {
    const t = MATRIX[file].totals['maint+floormats'];
    assert.deepEqual(MATRIX[file].totals['maint+floormats:qty'], [['floormats', 2]], file);
    const server = computeBookingServiceSubtotal({ zipCode: '07601', vehicles: [{ cat: 'cars', pkgId: 'maint', tierKey: 'suv2', addons: [{ id: 'floormats', qty: 2 }] }] });
    assert.equal(server.ok, true, server.error);
    assert.equal(server.serviceSubtotal, 195 + 40);
    assert.equal(t.base + t.addonTotal, server.serviceSubtotal, file);
  }
});

test('Full and Refresh include Engine Bay Light Cleaning: no $45 Engine Bay Top Clean line, no duplicate charge', () => {
  for (const pkg of ['full', 'refresh']) {
    for (const tier of TIERS) assert.deepEqual(offeredOnAllPages(pkg, tier, 'engine').filter(Boolean), [], `${pkg} ${tier}`);
    for (const file of PAGES) assert.match(MATRIX[file].pkgText[pkg], /Engine Bay Light Cleaning & Wipe-Down/, `${file} ${pkg} inclusion`);
    // A direct API submission cannot add the separate line.
    const v = Rules.validateNewBookingAddons({ vehicles: [{ cat: 'cars', pkgId: pkg, addons: [{ id: 'engine' }] }] });
    assert.equal(v.ok, false, pkg);
    assert.equal(v.error, 'addon_not_available');
    assert.equal(Rules.validateAddedAddons('cars', pkg, ['engine']).ok, false, `portal ${pkg}`);
  }
  // Shared package modal and portal package list say the same thing.
  const modal = fs.readFileSync(path.join(ROOT, 'assets/car-pkg-detail-modal.js'), 'utf8');
  for (const id of ['full', 'refresh']) {
    const start = modal.indexOf(`  ${id}: {`);
    const may = modal.indexOf('addonsMayApply', start);
    const end = modal.indexOf('],', may);
    assert.match(modal.slice(start, may), /Engine Bay Light Cleaning & Wipe-Down/, `modal ${id} includes`);
    assert.doesNotMatch(modal.slice(may, end), /Engine bay/i, `modal ${id} add-ons`);
  }
  const { CAR_PACKAGES: PORTAL } = require('../netlify/lib/customer-catalog');
  for (const id of ['full', 'refresh']) {
    assert.ok(PORTAL.find((p) => p.id === id).feats.includes('Engine Bay Light Cleaning & Wipe-Down'), `portal ${id}`);
  }
  // Engine Bay Top Clean $45 stays sold where it is not included.
  for (const pkg of ['wash', 'maint']) {
    for (const tier of TIERS) assert.deepEqual(new Set(offeredOnAllPages(pkg, tier, 'engine')), new Set([45]), `${pkg} ${tier}`);
  }
  // Stored bookings keep a $45 line they already carry; base prices are unchanged.
  for (const pkg of ['full', 'refresh']) {
    const old = computeBookingServiceSubtotal({ zipCode: '07601', createdAt: '2026-10-01T12:00:00Z', vehicles: [{ cat: 'cars', pkgId: pkg, tierKey: 'small', addons: [{ id: 'engine' }] }] });
    assert.equal(old.ok, true, pkg);
    assert.equal(old.serviceSubtotal, PRICING.cars.tiers.small[pkg] + 45, pkg);
  }
  assert.equal(PRICING.cars.addons.find((a) => a.id === 'engine').price, 45);
});

test('Signature has the same exterior as Refresh, Engine Bay Light Cleaning included, no $45 line', () => {
  for (const file of PAGES) assert.match(MATRIX[file].pkgText.premium, /Engine Bay Light Cleaning & Wipe-Down/, file);
  for (const tier of TIERS) assert.deepEqual(offeredOnAllPages('premium', tier, 'engine').filter(Boolean), [], tier);
  assert.equal(Rules.validateNewBookingAddons({ vehicles: [{ cat: 'cars', pkgId: 'premium', addons: [{ id: 'engine' }] }] }).error, 'addon_not_available');
  assert.equal(Rules.validateAddedAddons('cars', 'premium', ['engine']).ok, false, 'portal');
  const { CAR_PACKAGES: PORTAL } = require('../netlify/lib/customer-catalog');
  assert.ok(PORTAL.find((p) => p.id === 'premium').feats.includes('Engine Bay Light Cleaning & Wipe-Down'));
  // Stored Signature bookings keep a $45 line they already carry.
  const old = computeBookingServiceSubtotal({ zipCode: '07601', createdAt: '2026-10-01T12:00:00Z', vehicles: [{ cat: 'cars', pkgId: 'premium', tierKey: 'small', addons: [{ id: 'engine' }] }] });
  assert.equal(old.serviceSubtotal, 400 + 45);
});

test('the package modal no longer lists the retired Engine Bay Detail', () => {
  const modal = fs.readFileSync(path.join(ROOT, 'assets/car-pkg-detail-modal.js'), 'utf8');
  assert.doesNotMatch(modal, /Engine bay detail/i, 'retired $125 Engine Bay Detail');
});

test('Interior Detail + Headlight Restoration: offered at its $90 catalog price, never preselected, totals match', () => {
  const headlight = PRICING.cars.addons.find((a) => a.id === 'headlight');
  assert.equal(headlight.price, 90);
  for (const tier of TIERS) assert.deepEqual(new Set(offeredOnAllPages('interior', tier, 'headlight')), new Set([90]), tier);
  // The exception is Headlight only: no other exterior add-on on Interior Detail.
  for (const id of ['engine', 'rainx', 'polymer', 'wax1yr', 'claybar', 'undercarriage', 'heavymud']) {
    assert.deepEqual(offeredOnAllPages('interior', 'small', id).filter(Boolean), [], id);
    assert.equal(Rules.isOfferable('cars', 'interior', id), false, id);
  }
  for (const file of PAGES) {
    const t = MATRIX[file].totals['interior+headlight'];
    assert.deepEqual(t.ids, ['headlight'], file);
    const server = computeBookingServiceSubtotal({ zipCode: '07601', vehicles: [{ cat: 'cars', pkgId: 'interior', tierKey: 'suv2', addons: [{ id: 'headlight' }] }] });
    assert.equal(server.ok, true);
    assert.equal(t.base + t.addonTotal, server.serviceSubtotal, file);
    assert.equal(server.serviceSubtotal, 225 + 90);
  }
  assert.equal(Rules.validateAddedAddons('cars', 'interior', ['headlight']).ok, true, 'portal may add it');
  assert.equal(Rules.validateAddedAddons('cars', 'interior', ['polymer']).ok, false, 'not other exterior add-ons');
  assert.equal(Rules.validatePackageChange('cars', 'interior', ['headlight']).ok, true);
  assert.equal(Rules.validatePackageChange('cars', 'interior', ['wax1yr']).ok, false);
});

test('wax and sealant: Carnauba $75 only where no identical protection is included', () => {
  const where = (id) => CAR_PACKAGES.filter((pkg) => MATRIX[HOME][pkg + '|small'].offered.has(id));
  assert.deepEqual(where('wax1yr'), ['wash', 'premium']);
  assert.deepEqual(where('polymer'), ['wash', 'maint', 'full']);
  for (const pkg of where('wax1yr')) assert.deepEqual(new Set(offeredOnAllPages(pkg, 'small', 'wax1yr')), new Set([75]), pkg);
  const wax = PRICING.cars.addons.find((a) => a.id === 'wax1yr');
  const pageWax = MATRIX[HOME]; // name and copy come from the page catalog
  assert.ok(pageWax);
  const html = fs.readFileSync(path.join(ROOT, HOME), 'utf8');
  const row = html.match(/\{id:'wax1yr',[^\n]*name:'Carnauba Wax'[^\n]*/);
  assert.ok(row, 'car Carnauba Wax row');
  assert.doesNotMatch(row[0], /1[- ]year|12 months/i, 'no unproven one-year durability promise');
  assert.equal(wax.price, 75);
});

test('Trash Can Cleaning is not a car add-on for new bookings; other categories keep it', () => {
  for (const pkg of CAR_PACKAGES) {
    for (const tier of TIERS) assert.deepEqual(offeredOnAllPages(pkg, tier, 'trashcans').filter(Boolean), [], `${pkg} ${tier}`);
    assert.equal(Rules.validateAddedAddons('cars', pkg, ['trashcans']).ok, false, pkg);
  }
  assert.ok(PRICING.cars.addons.some((a) => a.id === 'trashcans'), 'catalog line kept for history');
  assert.equal(Rules.isOfferable('rvs', 'maint', 'trashcans'), true);
  // History: an older car booking with trash cans reprices unchanged.
  const old = computeBookingServiceSubtotal({ zipCode: '07601', createdAt: '2026-10-01T12:00:00Z', vehicles: [{ cat: 'cars', pkgId: 'full', tierKey: 'small', addons: [{ id: 'trashcans', qty: 2 }, { id: 'mold' }] }] });
  assert.equal(old.ok, true);
  assert.equal(old.serviceSubtotal, 250 + 50 + 149);
});

test('retired and preserved lines: Driveway, Mobile Water, Engine Bay $125 absent; Engine Top Clean $45 and Super Interior $125 kept', () => {
  const retired = ['seasonal_driveway_cleanup', 'walkway_steps', 'porch_entry', 'small_patio', 'heavy_wet_leaf', 'bag_place_property', 'pressure_surface_wash', 'mobile_water', 'engine_bay'];
  for (const file of PAGES) {
    for (const key of Object.keys(MATRIX[file]).filter((k) => k.includes('|'))) {
      for (const id of retired) assert.equal(MATRIX[file][key].offered.has(id), false, `${file} ${key} ${id}`);
    }
  }
  for (const pkg of ['wash', 'maint']) assert.deepEqual(new Set(offeredOnAllPages(pkg, 'small', 'engine')), new Set([45]), pkg);
  for (const pkg of ['interior', 'full', 'premium']) assert.deepEqual(new Set(offeredOnAllPages(pkg, 'small', 'superint')), new Set([125]), pkg);
  for (const pkg of ['wash', 'maint', 'refresh']) assert.deepEqual(offeredOnAllPages(pkg, 'small', 'superint').filter(Boolean), [], pkg);
  const prices = Object.fromEntries(CAR_PACKAGES.map((p) => [p, PRICING.cars.tiers.small[p]]));
  assert.deepEqual(prices, { wash: 125, maint: 160, interior: 200, full: 250, refresh: 335, premium: 400 });
});

test('ceramic checkout does not offer the retired Engine Bay Detail ($125)', () => {
  for (const file of PAGES) {
    assert.match(MATRIX[file].ceramicMore, /More services/, file);
    assert.doesNotMatch(MATRIX[file].ceramicMore, /Engine Bay Detail/, file);
    assert.match(MATRIX[file].ceramicMore, /Water Spot Removal/, file);
  }
  assert.equal(Rules.validateNewBookingAddons({ vehicles: [{ cat: 'cars', pkgId: 'ceramic_1yr', addons: [{ id: 'engine_bay' }] }] }).ok, false);
});

test('Accessible Undercarriage Cleaning is suspended: hidden everywhere, refused for new bookings, history keeps its size-band price', () => {
  for (const file of PAGES) {
    for (const key of Object.keys(MATRIX[file]).filter((k) => k.includes('|'))) {
      assert.equal(MATRIX[file][key].offered.has('undercarriage'), false, `${file} ${key}`);
    }
    assert.doesNotMatch(MATRIX[file].ceramicMore, /Undercarriage/, `${file} ceramic`);
  }
  for (const pkg of ['wash', 'refresh', 'full', 'premium', 'ceramic_1yr']) {
    assert.equal(Rules.validateNewBookingAddons({ vehicles: [{ cat: 'cars', pkgId: pkg, addons: [{ id: 'undercarriage' }] }] }).ok, false, pkg);
    assert.equal(Rules.validateAddedAddons('cars', pkg, ['undercarriage']).ok, false, `portal ${pkg}`);
  }
  // Stored bookings keep the contracted line at the existing size-band price.
  const expected = { small: 125, suv2: 150, suv3: 175, truck: 175, compact_van: 175, midsize_van: 175, full_size_van_passenger: 225 };
  for (const [tier, price] of Object.entries(expected)) {
    const old = computeBookingServiceSubtotal({ zipCode: '07601', createdAt: '2026-10-01T12:00:00Z', vehicles: [{ cat: 'cars', pkgId: 'wash', tierKey: tier, addons: [{ id: 'undercarriage' }] }] });
    assert.equal(old.ok, true, tier);
    assert.equal(old.serviceSubtotal, PRICING.cars.tiers[tier].wash + price, tier);
  }
  // No booking surface still advertises it: package modal (incl. Ceramic) and Heavy Mud copy.
  const modal = fs.readFileSync(path.join(ROOT, 'assets/car-pkg-detail-modal.js'), 'utf8');
  assert.doesNotMatch(modal, /undercarriage/i, 'package details modal');
  for (const file of PAGES) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const mud = html.match(/\{id:'heavymud', scope:'ext'[^\n]*/);
    assert.ok(mud, file);
    assert.doesNotMatch(mud[0], /undercarriage/i, `${file} Heavy Mud copy`);
  }
  // A stored booking may still change package without losing the line.
  assert.equal(Rules.validatePackageChange('cars', 'full', ['undercarriage']).ok, true);
});

test('frontend totals equal server totals for add-on combinations on every page', () => {
  for (const [key, pkg] of [['full+combo', 'full'], ['wash+exterior', 'wash']]) {
    for (const file of PAGES) {
      const t = MATRIX[file].totals[key];
      const server = computeBookingServiceSubtotal({ zipCode: '07601', vehicles: [{ cat: 'cars', pkgId: pkg, tierKey: 'suv2', addons: t.ids.map((id) => ({ id })) }] });
      assert.equal(server.ok, true, `${file} ${key} ${server.error}`);
      assert.equal(t.base + t.addonTotal, server.serviceSubtotal, `${file} ${key}`);
    }
  }
  // Full 285 + Super Interior 125 + Pet Hair 95 + Headlight 90 + Polymer 25
  assert.equal(MATRIX[HOME].totals['full+combo'].base + MATRIX[HOME].totals['full+combo'].addonTotal, 620);
  // Wash 145 + Carnauba 75 + Engine 45 + Clay 45 (Undercarriage is suspended)
  assert.equal(MATRIX[HOME].totals['wash+exterior'].base + MATRIX[HOME].totals['wash+exterior'].addonTotal, 310);
});

test('ZIP change recalculates the travel fee and nothing else; no add-on is added automatically', () => {
  const vehicles = () => [{ cat: 'cars', pkgId: 'interior', tierKey: 'small', addons: [{ id: 'headlight' }] }];
  for (const [zip, fee] of [['07601', 0], ['07030', 0], ['10001', 35], ['08608', 30]]) {
    const booking = { zipCode: zip, totalPrice: 290 + fee, vehicles: vehicles() };
    const r = applyServerTravelAndTotal(booking);
    assert.equal(r.ok, true, `${zip} ${r.error}`);
    assert.equal(booking.travelFeeAmount, fee, zip);
    assert.equal(booking.totalPrice, 290 + fee, zip);
  }
  for (const file of PAGES) {
    for (const key of Object.keys(MATRIX[file]).filter((k) => k.includes('|'))) {
      // A fresh package selection starts with no paid add-on selected.
      assert.equal(MATRIX[file][key].preselected, 0, `${file} ${key}`);
    }
  }
});

test('customer portal offers only what the rules allow for the booked package', () => {
  const html = fs.readFileSync(path.join(ROOT, 'my-garage.html'), 'utf8');
  const rulesAt = html.indexOf('assets/addon-rules.js');
  assert.ok(rulesAt > 0 && rulesAt < html.indexOf('assets/my-garage.js'), 'rules load before the portal script');
  const src = fs.readFileSync(path.join(ROOT, 'assets/my-garage.js'), 'utf8');
  assert.match(src, /rules\.isOfferable\(targetCat, targetPackageId, a\.id\)/);
  assert.match(src, /driveway\.hiddenFromNewBookings\(a\.id\)/);
});
