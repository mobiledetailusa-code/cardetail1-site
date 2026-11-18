'use strict';

/**
 * Booking vehicle step (cars): make nicknames, exact-match acceptance, stale
 * model clearing, the "My vehicle isn't listed" quote request, and 2027 model
 * years that are priced only when the manufacturer confirmed them.
 *
 * The browser code under test is the real CAR SEARCH block from index.html,
 * run in jsdom against the real catalog. Server checks use car-catalog-tier.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const MakeSearch = require('../assets/vehicle-make-search.js');
const Catalog = require('../assets/vehicle-catalog.js');
const { assertCarCatalogTier } = require('../netlify/lib/car-catalog-tier');
const catalogJson = require('../data/cars-vehicle-catalog.json');

const MAKES = Catalog.getMakes();

function carSearchBlock() {
  const start = index.indexOf('// ── CAR SEARCH');
  const end = index.indexOf('// ── STEP 4: ADD-ONS');
  assert.ok(start > 0 && end > start, 'CAR SEARCH block not found in index.html');
  return index.slice(start, end);
}

function vehicleStepMarkup() {
  const start = index.indexOf('<div id="make-search-wrap"');
  const end = index.indexOf('<!-- Size chips only when auto-class needs confirmation');
  assert.ok(start > 0 && end > start, 'vehicle step markup not found');
  return index.slice(start, end).replace('style="display:none"', '');
}

function makeSandbox(opts = {}) {
  const dom = new JSDOM(`<!DOCTYPE html><body>
    <input id="bk-zip" value="07650">
    ${vehicleStepMarkup()}
    <div id="tier-chips-wrap" style="display:none"></div>
    <div id="vc"><div id="vc-ico"></div></div>
    <button id="next3" disabled></button>
  </body>`, { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window;
  const calls = { fetch: [], basePrice: 0, gate: 0, vcName: '' };
  const legacy = Catalog.toLegacyModelsMap();
  Object.assign(w, {
    CD1MakeSearch: MakeSearch,
    CD1VehicleCatalog: Catalog,
    CD1VehicleClass: {
      resolveVehicleClassification: ({ make, model, year }) => Catalog.resolveVehicle({ make, model, year }),
    },
    MAKES,
    MODELS: legacy,
    PRICING: { cars: { tiers: { small: { label: 'Small Car' }, suv2: { label: '2-Row SUV' }, suv3: { label: '3-Row SUV' }, truck: { label: 'Truck' } } } },
    INQUIRY_URL: '/.netlify/functions/submit-inquiry',
    ADMIN_SMS: '+15513893986',
    syncTierChipsVisibility() {},
    setBasePrice() { calls.basePrice += 1; },
    setVehicleVisual() {},
    setVcName(s) { calls.vcName = s; },
    renderAddons() {},
    syncContinueGate() {
      calls.gate += 1;
      w.document.getElementById('next3').disabled = !(w.ST.vehicleLabel && w.ST.tierKey && !w.ST.classNeedsConfirm);
    },
    fetch: async (url, init) => {
      calls.fetch.push({ url, body: JSON.parse(init.body) });
      if (opts.fetchFails) throw new Error('offline');
      return { ok: true, json: async () => ({ ok: true, id: 'INQ-TEST' }) };
    },
  });
  w.eval('var ST={cat:"cars",make:"",model:"",year:"",tierKey:"",tier:null,vehicleLabel:"",classNeedsConfirm:false,basePrice:0};');
  w.eval(carSearchBlock().replace(/^const (makeIn|makeDd)=/gm, 'var $1=') + '\n;window.__fns={selectMake,openCarUnlisted,submitCarUnlisted,findMakeHits};');
  return { w, doc: w.document, calls, ST: () => w.ST, fns: w.__fns };
}

function type(sb, value) {
  const el = sb.doc.getElementById('make-in');
  el.value = value;
  el.dispatchEvent(new sb.w.Event('input', { bubbles: true }));
}
function key(sb, k) {
  sb.doc.getElementById('make-in').dispatchEvent(new sb.w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
}
function choose(sb, id, value) {
  const el = sb.doc.getElementById(id);
  el.value = String(value);
  el.dispatchEvent(new sb.w.Event('change', { bubbles: true }));
}

describe('make search matching (assets/vehicle-make-search.js)', () => {
  const first = (q) => (MakeSearch.searchMakes(q, MAKES)[0] || {}).make;

  it('resolves common nicknames to the canonical catalog make', () => {
    assert.equal(first('chevy'), 'Chevrolet');
    assert.equal(first('Chevy'), 'Chevrolet');
    assert.equal(first('vw'), 'Volkswagen');
    assert.equal(first('VW'), 'Volkswagen');
    assert.equal(first('benz'), 'Mercedes-Benz');
    assert.equal(first('mercedes'), 'Mercedes-Benz');
    assert.equal(first('range rover'), 'Land Rover');
    assert.equal(first('rangerover'), 'Land Rover');
    assert.equal(first('land rover'), 'Land Rover');
    assert.equal(first('caddy'), 'Cadillac');
    assert.equal(first('infinity'), 'INFINITI');
  });

  it('every nickname points at a make that exists in the catalog', () => {
    for (const [alias, make] of Object.entries(MakeSearch.ALIASES)) {
      assert.ok(MAKES.includes(make), `${alias} → ${make} is not a catalog make`);
    }
  });

  it('finds all 44 makes by their own name, exact match first', () => {
    assert.equal(MAKES.length, 44);
    for (const m of MAKES) {
      assert.equal(first(m), m, m);
      assert.equal(MakeSearch.exactMake(m.toLowerCase(), MAKES), m);
    }
  });

  it('never returns a make twice or a make outside the catalog', () => {
    for (const q of ['m', 'me', 'merc', 'ro', 'range', 'land', 'ch', 'v', 'ca']) {
      const hits = MakeSearch.searchMakes(q, MAKES).map((h) => h.make);
      assert.equal(new Set(hits).size, hits.length, q);
      for (const h of hits) assert.ok(MAKES.includes(h), `${q}: ${h}`);
    }
  });

  it('a make that is not in the catalog finds nothing (fallback path)', () => {
    assert.deepEqual(MakeSearch.searchMakes('pontiac', MAKES), []);
    assert.equal(MakeSearch.exactMake('pontiac', MAKES), null);
    assert.equal(MakeSearch.exactMake('chev', MAKES), 'Chevrolet');
    assert.equal(MakeSearch.exactMake('che', MAKES), null, 'partial text is not an exact make');
  });
});

describe('vehicle step behavior (index.html CAR SEARCH block)', () => {
  it('typing a nickname lists the canonical make and Enter selects it', () => {
    const sb = makeSandbox();
    type(sb, 'chevy');
    assert.match(sb.doc.getElementById('make-dd').textContent, /Chevrolet/);
    key(sb, 'Enter');
    assert.equal(sb.ST().make, 'Chevrolet');
    const models = [...sb.doc.getElementById('model-sel').options].map((o) => o.value);
    assert.ok(models.includes('Tahoe'));
    assert.equal(sb.doc.getElementById('model-sel').disabled, false);
  });

  it('arrow keys move the highlighted suggestion and Escape closes the list', () => {
    const sb = makeSandbox();
    type(sb, 'm');
    key(sb, 'ArrowDown');
    key(sb, 'ArrowDown');
    const active = sb.doc.querySelector('.srch-item.is-active');
    assert.ok(active);
    assert.equal(sb.doc.getElementById('make-in').getAttribute('aria-activedescendant'), active.id);
    key(sb, 'Escape');
    assert.equal(sb.doc.getElementById('make-dd').classList.contains('open'), false);
    assert.equal(sb.doc.getElementById('make-in').getAttribute('aria-expanded'), 'false');
  });

  it('an exact make typed without tapping a suggestion is accepted on change', () => {
    const sb = makeSandbox();
    type(sb, 'honda');
    sb.doc.getElementById('make-in').dispatchEvent(new sb.w.Event('change', { bubbles: true }));
    assert.equal(sb.ST().make, 'Honda');
    assert.equal(sb.doc.getElementById('make-in').value, 'Honda');
  });

  it('tapping a suggestion selects it (one delegated handler, no inline JS)', () => {
    const sb = makeSandbox();
    type(sb, 'toy');
    const item = sb.doc.querySelector('.srch-item[data-make="Toyota"]');
    assert.ok(item);
    assert.equal(item.getAttribute('onclick'), null);
    item.dispatchEvent(new sb.w.MouseEvent('click', { bubbles: true }));
    assert.equal(sb.ST().make, 'Toyota');
  });

  it('changing the make clears the old model, year, size and price', () => {
    const sb = makeSandbox();
    sb.fns.selectMake('Chevrolet');
    choose(sb, 'model-sel', 'Tahoe');
    choose(sb, 'year-sel', 2018);
    assert.equal(sb.ST().tierKey, 'suv3');
    assert.equal(sb.doc.getElementById('next3').disabled, false);
    type(sb, 'hon');
    assert.equal(sb.ST().make, '');
    assert.equal(sb.ST().model, '');
    assert.equal(sb.ST().tierKey, '');
    assert.equal(sb.ST().vehicleLabel, '');
    assert.equal(sb.doc.getElementById('model-sel').disabled, true);
    assert.equal(sb.doc.getElementById('model-sel').options.length, 1);
    assert.equal(sb.doc.getElementById('next3').disabled, true);
  });

  it('keeps approved classes: 2005–2008 Dodge Magnum small, 2006 Sequoia suv3', () => {
    const sb = makeSandbox();
    sb.fns.selectMake('Dodge'); choose(sb, 'model-sel', 'Magnum'); choose(sb, 'year-sel', 2006);
    assert.equal(sb.ST().tierKey, 'small');
    sb.fns.selectMake('Toyota'); choose(sb, 'model-sel', 'Sequoia'); choose(sb, 'year-sel', 2006);
    assert.equal(sb.ST().tierKey, 'suv3');
  });

  it('offers 2027 in the year list (from the catalog policy)', () => {
    const sb = makeSandbox();
    sb.fns.selectMake('Honda'); choose(sb, 'model-sel', 'Civic');
    const years = [...sb.doc.getElementById('year-sel').options].map((o) => o.value).filter(Boolean);
    assert.equal(years[0], String(Math.max(new Date().getFullYear(), catalogJson.yearPolicy.selectableMax)));
    assert.ok(years.includes('2027'));
    assert.equal(years[years.length - 1], '1990');
  });

  it('a manufacturer-confirmed 2027 model is priced with its catalog class', () => {
    const sb = makeSandbox();
    sb.fns.selectMake('Toyota'); choose(sb, 'model-sel', 'Camry'); choose(sb, 'year-sel', 2027);
    assert.equal(sb.ST().tierKey, 'small');
    assert.equal(sb.doc.getElementById('car-year-note').hidden, true);
    assert.equal(sb.doc.getElementById('next3').disabled, false);
  });

  it('an unconfirmed 2027 model gets no size, no price and a quote offer', () => {
    const sb = makeSandbox();
    sb.fns.selectMake('Honda'); choose(sb, 'model-sel', 'Civic'); choose(sb, 'year-sel', 2027);
    assert.equal(sb.ST().tierKey, '');
    assert.equal(sb.ST().tier, null);
    assert.equal(sb.ST().basePrice, 0);
    assert.equal(sb.ST().classNeedsConfirm, false, 'size chips must not open a priced path');
    assert.equal(sb.doc.getElementById('next3').disabled, true);
    assert.equal(sb.doc.getElementById('car-year-note').hidden, false);
    assert.match(sb.calls.vcName, /not confirmed/);
    // Same model, verified year: priced again and the note goes away.
    choose(sb, 'year-sel', 2026);
    assert.equal(sb.ST().tierKey, 'small');
    assert.equal(sb.doc.getElementById('car-year-note').hidden, true);
  });

  it('EQS/EQE: sedans are labelled as sedans and the SUVs go to a quote, never a sedan price', () => {
    const sb = makeSandbox();
    sb.fns.selectMake('Mercedes-Benz');
    const opts = [...sb.doc.getElementById('model-sel').options];
    const byValue = (v) => opts.find((o) => o.value === v);
    assert.equal(byValue('EQS').textContent, 'EQS Sedan');
    assert.equal(byValue('EQE').textContent, 'EQE Sedan');
    assert.equal(byValue('EQS SUV').dataset.quoteOnly, '1');
    assert.equal(byValue('EQE SUV').dataset.quoteOnly, '1');
    assert.equal(opts.indexOf(byValue('EQS SUV')), opts.indexOf(byValue('EQS')) + 1, 'SUV sits next to the sedan');

    choose(sb, 'model-sel', 'EQS SUV');
    assert.equal(sb.ST().tierKey, '');
    assert.equal(sb.ST().basePrice, 0);
    assert.equal(sb.doc.getElementById('year-sel').disabled, true);
    assert.equal(sb.doc.getElementById('next3').disabled, true);
    assert.equal(sb.doc.getElementById('car-year-note').hidden, false);
    sb.fns.openCarUnlisted();
    assert.equal(sb.doc.getElementById('cu-model').value, 'EQS SUV');
    assert.equal(sb.doc.getElementById('cu-make').value, 'Mercedes-Benz');

    // The sedan keeps its existing class.
    choose(sb, 'model-sel', 'EQS'); choose(sb, 'year-sel', 2024);
    assert.equal(sb.ST().tierKey, 'small');
    assert.equal(sb.doc.getElementById('car-year-note').hidden, true);
  });

  it('"No make found" offers the not-listed form, prefilled with what was typed', () => {
    const sb = makeSandbox();
    type(sb, 'pontiac');
    const btn = sb.doc.querySelector('#make-dd .srch-empty-btn');
    assert.ok(btn, 'not-listed button inside the empty dropdown');
    sb.fns.openCarUnlisted();
    assert.equal(sb.doc.getElementById('car-unlisted').hidden, false);
    assert.equal(sb.doc.getElementById('cu-make').value, 'pontiac');
  });

  it('the not-listed form validates, sends a quote request with no price, and never sets a size', async () => {
    const sb = makeSandbox();
    sb.fns.openCarUnlisted();
    const set = (id, v) => { sb.doc.getElementById(id).value = v; };
    const status = () => sb.doc.getElementById('cu-status').textContent;
    await sb.fns.submitCarUnlisted({ preventDefault() {} });
    assert.match(status(), /make/i);
    set('cu-make', 'Pontiac'); set('cu-model', 'Grand Prix'); set('cu-year', '07');
    await sb.fns.submitCarUnlisted({ preventDefault() {} });
    assert.match(status(), /Year/);
    set('cu-year', '2007'); set('cu-name', 'Test Person'); set('cu-phone', '555');
    await sb.fns.submitCarUnlisted({ preventDefault() {} });
    assert.match(status(), /phone/i);
    assert.equal(sb.calls.fetch.length, 0);
    set('cu-phone', '(201) 555-0100');
    await sb.fns.submitCarUnlisted({ preventDefault() {} });
    assert.equal(sb.calls.fetch.length, 1);
    const { url, body } = sb.calls.fetch[0];
    assert.equal(url, '/.netlify/functions/submit-inquiry');
    assert.equal(body.source, 'Booking - vehicle not listed');
    assert.equal(body.name, 'Test Person');
    assert.match(body.message, /2007 Pontiac Grand Prix/);
    assert.match(body.message, /ZIP: 07650/);
    assert.doesNotMatch(body.message, /\$\s?\d/, 'no price in the request');
    for (const k of ['price', 'tierKey', 'basePrice', 'total', 'amount']) assert.equal(body[k], undefined, k);
    assert.equal(sb.ST().tierKey, '');
    assert.equal(sb.doc.getElementById('next3').disabled, true);
    assert.match(status(), /Nothing has been booked or charged/);
  });

  it('a failed quote request shows the phone number instead of claiming success', async () => {
    const sb = makeSandbox({ fetchFails: true });
    sb.fns.openCarUnlisted();
    for (const [id, v] of [['cu-make', 'Saab'], ['cu-model', '9-3'], ['cu-name', 'A'], ['cu-phone', '2015550100']]) sb.doc.getElementById(id).value = v;
    await sb.fns.submitCarUnlisted({ preventDefault() {} });
    assert.match(sb.doc.getElementById('cu-status').textContent, /389-3986/);
    assert.equal(sb.doc.querySelector('#cu-status a').getAttribute('href'), 'tel:+15513893986');
  });
});

describe('server: model year verification and tier validation (car-catalog-tier)', () => {
  const pub = { catalogTierMode: 'require_identity' };
  const check = (make, model, year, tier, opts = pub) => assertCarCatalogTier({ make, model, year }, tier, opts);

  it('years up to 2026 behave exactly as before', () => {
    assert.deepEqual(check('Honda', 'Civic', 2026, 'small'), { ok: true });
    assert.deepEqual(check('Dodge', 'Magnum', 2006, 'small'), { ok: true });
    assert.deepEqual(check('Toyota', 'Sequoia', 2006, 'suv3'), { ok: true });
    assert.deepEqual(check('Toyota', 'Sequoia', 2006, 'small'), { ok: false, error: 'tier_mismatch' });
  });

  it('a confirmed 2027 model is accepted only with its catalog class', () => {
    assert.deepEqual(check('Toyota', 'Camry', 2027, 'small'), { ok: true });
    assert.deepEqual(check('Toyota', 'Camry', 2027, 'suv2'), { ok: false, error: 'tier_mismatch' });
    assert.deepEqual(check('Chevrolet', 'Silverado 1500', 2027, 'truck'), { ok: true });
    assert.deepEqual(check('Kia', 'Telluride', 2027, 'suv3'), { ok: true });
    assert.deepEqual(check('Kia', 'Telluride', 2027, 'suv2'), { ok: false, error: 'tier_mismatch' });
  });

  it('an unconfirmed 2027 model gets no price, whatever size the client claims', () => {
    for (const tier of ['small', 'suv2', 'suv3', 'truck']) {
      assert.deepEqual(check('Honda', 'Civic', 2027, tier), { ok: false, error: 'vehicle_unresolved' }, tier);
    }
    assert.deepEqual(check('Toyota', 'Camry', 2028, 'small'), { ok: false, error: 'vehicle_unresolved' });
    // The year can also arrive only inside the vehicle label.
    assert.deepEqual(
      assertCarCatalogTier({ vehicleLabel: '2027 Honda Civic' }, 'small', pub),
      { ok: false, error: 'vehicle_unresolved' },
    );
  });

  it('a vehicle outside the catalog is never priced on a public booking', () => {
    assert.deepEqual(check('Pontiac', 'Grand Prix', 2007, 'small'), { ok: false, error: 'vehicle_unresolved' });
    assert.deepEqual(check('Honda', 'Prelude', 2001, 'small'), { ok: false, error: 'vehicle_unresolved' });
  });

  it('EQS SUV / EQE SUV are never priced as the sedan on the server', () => {
    for (const tier of ['small', 'suv2', 'suv3']) {
      assert.deepEqual(check('Mercedes-Benz', 'EQS SUV', 2024, tier), { ok: false, error: 'vehicle_unresolved' }, tier);
      assert.deepEqual(check('Mercedes-Benz', 'EQE SUV', 2024, tier), { ok: false, error: 'vehicle_unresolved' }, tier);
    }
    assert.deepEqual(check('Mercedes-Benz', 'EQS', 2024, 'small'), { ok: true });
    assert.deepEqual(check('Mercedes-Benz', 'EQE', 2024, 'small'), { ok: true });
  });

  it('discontinued models get no 2027 price', () => {
    assert.deepEqual(check('Chevrolet', 'Camaro', 2027, 'small'), { ok: false, error: 'vehicle_unresolved' });
    assert.deepEqual(check('Chevrolet', 'Malibu', 2027, 'small'), { ok: false, error: 'vehicle_unresolved' });
    assert.deepEqual(check('Chevrolet', 'Camaro', 2024, 'small'), { ok: true });
  });

  it('staff (known_only) mode is unchanged for future years', () => {
    assert.deepEqual(check('Honda', 'Civic', 2027, 'small', { catalogTierMode: 'known_only' }), { ok: true });
  });
});

describe('catalog data (single source: data/cars-vehicle-catalog.json)', () => {
  const mv = catalogJson.modelYearVerification;

  it('every confirmed 2027 vehicle exists in the catalog, with a source per make', () => {
    assert.equal(mv.verifiedThrough, 2026);
    const keys = new Set(catalogJson.vehicles.filter((v) => v.public !== false).map((v) => v.make + '|' + v.model));
    const list = mv.years['2027'].vehicles;
    assert.equal(new Set(list).size, list.length, 'no duplicates');
    for (const k of list) {
      assert.ok(keys.has(k), k);
      assert.ok(mv.years['2027'].sources[k.split('|')[0]], 'source for ' + k);
    }
  });

  it('quote-only body variants are not catalog vehicles and point at an existing sedan', () => {
    const keys = new Set(catalogJson.vehicles.map((v) => v.make + '|' + v.model));
    const q = catalogJson.quoteOnlyModels.models;
    assert.deepEqual(q.map((m) => m.model).sort(), ['EQE SUV', 'EQS SUV']);
    for (const m of q) {
      assert.equal(keys.has(m.make + '|' + m.model), false, m.model + ' must not be priced');
      assert.ok(keys.has(m.make + '|' + m.sameNameAs), m.sameNameAs);
      assert.equal(Catalog.resolveVehicle({ make: m.make, model: m.model }).ok, false);
    }
    assert.equal(Catalog.resolveVehicle({ make: 'Mercedes-Benz', model: 'EQS' }).tierKey, 'small');
  });

  it('the browser runtime carries the same verification data as the JSON', () => {
    const generated = require('../assets/generated/cars-vehicle-catalog.generated.js');
    assert.deepEqual(generated.quoteOnlyModels, catalogJson.quoteOnlyModels);
    assert.deepEqual(generated.modelYearVerification, mv);
    assert.deepEqual(generated.vehicles, catalogJson.vehicles);
  });

  it('the year policy offers 2027 and keeps 1990 as the floor', () => {
    assert.deepEqual(Catalog.getYearPolicy(), { selectableMin: 1990, selectableMax: 2027 });
  });

  it('index.html loads the make search before the booking code uses it', () => {
    const i = index.indexOf('<script src="assets/vehicle-make-search.js"></script>');
    assert.ok(i > 0);
    assert.ok(i < index.indexOf('// ── CAR SEARCH'));
  });

  it('the quote form has no path to a size chip or a price', () => {
    const block = carSearchBlock();
    const fallback = block.slice(block.indexOf('// ── VEHICLE NOT LISTED'), block.indexOf('function selectMake('));
    for (const forbidden of ['selectTier', 'setBasePrice', 'ST.tierKey=', 'basePrice=', 'PRICING']) {
      assert.equal(fallback.includes(forbidden), false, forbidden);
    }
  });
});

// vm is imported for parity with sibling tests; keep it referenced.
void vm;
