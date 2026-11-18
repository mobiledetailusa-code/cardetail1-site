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

// The real customer-facing size wording helper from index.html (display only).
function sizeWordingBlock() {
  const start = index.indexOf('const CAR_SIZE_WORDING=');
  const end = index.indexOf('function updateVcPriceDisplay', start);
  assert.ok(start > 0 && end > start, 'size wording helper not found');
  return index.slice(start, end).replace('const CAR_SIZE_WORDING=', 'var CAR_SIZE_WORDING=');
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
  w.eval(sizeWordingBlock());
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

  it('finds every catalog make (56) by its own name, exact match first', () => {
    assert.equal(MAKES.length, 56);
    for (const m of ['Pontiac', 'Saturn', 'Mercury', 'Scion', 'Saab', 'Suzuki', 'Hummer', 'Isuzu', 'Oldsmobile', 'Plymouth', 'smart', 'Fisker']) {
      assert.ok(MAKES.includes(m), m);
    }
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
    assert.deepEqual(MakeSearch.searchMakes('studebaker', MAKES), []);
    assert.equal(MakeSearch.exactMake('studebaker', MAKES), null);
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

  it('EQS/EQE: sedan and SUV are separate choices, each priced automatically at its own size', () => {
    const sb = makeSandbox();
    sb.fns.selectMake('Mercedes-Benz');
    const values = [...sb.doc.getElementById('model-sel').options].map((o) => o.value);
    for (const m of ['EQS Sedan', 'EQS SUV', 'EQE Sedan', 'EQE SUV']) assert.ok(values.includes(m), m);
    assert.equal(values.includes('EQS'), false, 'no ambiguous bare name in the selector');
    assert.equal(values.includes('EQE'), false, 'no ambiguous bare name in the selector');

    const pick = (model, year) => { choose(sb, 'model-sel', model); choose(sb, 'year-sel', year); return sb.ST().tierKey; };
    assert.equal(pick('EQS Sedan', 2024), 'small');
    assert.equal(pick('EQS SUV', 2024), 'suv3');
    assert.equal(sb.doc.getElementById('next3').disabled, false, 'recognized SUV reaches packages with no extra step');
    assert.equal(sb.doc.getElementById('car-year-note').hidden, true);
    assert.equal(pick('EQE Sedan', 2024), 'small');
    assert.equal(pick('EQE SUV', 2024), 'suv2');
    assert.equal(sb.doc.getElementById('next3').disabled, false);
  });

  it('owner-approved sizes reach the package step priced automatically', () => {
    const sb = makeSandbox();
    const cases = [
      ['Kia', 'EV6', 2024, 'suv2'], ['Porsche', 'Cayenne', 2022, 'suv3'], ['Toyota', '4Runner', 2022, 'suv3'],
      ['Mazda', 'CX-70', 2025, 'suv3'], ['BMW', 'X5', 2023, 'suv3'], ['Mercedes-Benz', 'GLE', 2023, 'suv3'], ['Audi', 'Q8', 2023, 'suv3'],
      ['GMC', 'Hummer EV Pickup', 2023, 'truck'], ['GMC', 'Hummer EV SUV', 2024, 'suv3'],
      ['Land Rover', 'Defender 90', 2022, 'suv2'], ['Land Rover', 'Defender 110', 2022, 'suv3'], ['Land Rover', 'Defender 130', 2024, 'suv3'],
      ['Porsche', 'Cayenne Electric', 2026, 'suv3'],
      ['Hyundai', 'Santa Fe', 2012, 'suv2'], ['Hyundai', 'Santa Fe', 2015, 'suv3'], ['Hyundai', 'Santa Fe', 2019, 'suv2'],
      ['Hyundai', 'Santa Fe', 2022, 'suv2'], ['Hyundai', 'Santa Fe', 2025, 'suv3'],
      ['Hyundai', 'Santa Fe Sport', 2016, 'suv2'], ['Hyundai', 'Santa Fe XL', 2019, 'suv3'],
      ['Pontiac', 'Grand Prix', 2007, 'small'], ['Honda', 'Prelude', 2001, 'small'], ['Ford', 'Excursion', 2004, 'suv3'],
      ['Toyota', 'bZ Woodland', 2027, 'suv2'],
    ];
    for (const [make, model, year, tier] of cases) {
      sb.fns.selectMake(make); choose(sb, 'model-sel', model); choose(sb, 'year-sel', year);
      assert.equal(sb.ST().tierKey, tier, `${year} ${make} ${model}`);
      assert.equal(sb.doc.getElementById('next3').disabled, false, `${make} ${model} can continue`);
      assert.equal(sb.doc.getElementById('car-year-note').hidden, true, `${make} ${model} has no quote note`);
    }
  });

  it('"No make found" offers the not-listed form, prefilled with what was typed', () => {
    const sb = makeSandbox();
    type(sb, 'studebaker');
    const btn = sb.doc.querySelector('#make-dd .srch-empty-btn');
    assert.ok(btn, 'not-listed button inside the empty dropdown');
    sb.fns.openCarUnlisted();
    assert.equal(sb.doc.getElementById('car-unlisted').hidden, false);
    assert.equal(sb.doc.getElementById('cu-make').value, 'studebaker');
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
    assert.equal(body.zip, '07650');
    assert.deepEqual(body.vehicle, { category: 'car_suv', year: '2007', make: 'Pontiac', model: 'Grand Prix', notes: '' });
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

describe('customer-facing size wording (display only)', () => {
  it('the vehicle card shows Car / SUV / Crossover / Large SUV / Truck / Minivan', () => {
    const sb = makeSandbox();
    const card = (make, model, year) => { sb.fns.selectMake(make); choose(sb, 'model-sel', model); choose(sb, 'year-sel', year); return sb.calls.vcName; };
    assert.equal(card('Toyota', 'Camry', 2024), '2024 Toyota Camry · Car');
    assert.equal(card('Kia', 'EV6', 2024), '2024 Kia EV6 · SUV / Crossover');
    assert.equal(card('Porsche', 'Cayenne', 2022), '2022 Porsche Cayenne · Large SUV');
    assert.equal(card('Ford', 'F-150', 2022), '2022 Ford F-150 · Truck');
    assert.equal(card('Honda', 'Odyssey', 2022), '2022 Honda Odyssey · Minivan');
  });

  it('internal tier and stored label are unchanged by the wording', () => {
    const sb = makeSandbox();
    sb.fns.selectMake('Porsche'); choose(sb, 'model-sel', 'Cayenne'); choose(sb, 'year-sel', 2022);
    assert.equal(sb.ST().tierKey, 'suv3');
    assert.equal(sb.ST().displayLabel, '3-Row SUV', 'ST.displayLabel (saved/admin) keeps the catalog label');
  });

  it('the wording stays out of server, analytics and summary modules', () => {
    for (const f of ['netlify/functions/submit-booking.js', 'netlify/lib/car-catalog-tier.js', 'assets/booking-vehicle-summary.js', 'assets/revops-booking-hooks.js']) {
      assert.equal(fs.readFileSync(path.join(ROOT, f), 'utf8').includes('customerSizeLabel'), false, f);
    }
  });
});

describe('held-back models classified from an existing tier', () => {
  it('prices each one at the tier of the catalog vehicle it matches', () => {
    const legacy = Catalog.toLegacyModelsMap();
    const cases = [
      ['Chevrolet', 'HHR', 2008, 'suv2'],
      ['Chrysler', 'PT Cruiser', 2006, 'suv2'],
      ['Scion', 'xB', 2005, 'suv2'],
      ['Scion', 'xB', 2012, 'suv2'],
      ['Nissan', 'Cube', 2011, 'suv2'],
      ['Audi', 'A4 allroad', 2020, 'suv2'],
      ['Volkswagen', 'Touareg', 2012, 'suv3'],
      ['Isuzu', 'Ascender', 2006, 'suv2'],
      ['Isuzu', 'Ascender EXT', 2005, 'suv3'],
    ];
    for (const [make, model, year, tier] of cases) {
      const resolved = Catalog.resolveVehicle({ make, model, year });
      assert.equal(resolved.ok, true, model);
      assert.equal(resolved.tierKey, tier, model);
      assert.equal(legacy[make].t[model], tier, model + ' selector');
    }
    // The wrong tier is refused. Touareg follows the Cayenne, not the smaller crossover price.
    const pub = { catalogTierMode: 'require_identity' };
    const server = (make, model, year, tier) => assertCarCatalogTier({ make, model, year }, tier, pub);
    assert.deepEqual(server('Volkswagen', 'Touareg', 2012, 'suv3'), { ok: true });
    assert.deepEqual(server('Volkswagen', 'Touareg', 2012, 'suv2'), { ok: false, error: 'tier_mismatch' });
    assert.deepEqual(server('Chevrolet', 'HHR', 2008, 'suv2'), { ok: true });
    assert.deepEqual(server('Chevrolet', 'HHR', 2008, 'small'), { ok: false, error: 'tier_mismatch' });
    assert.deepEqual(server('Isuzu', 'Ascender EXT', 2005, 'suv3'), { ok: true });
    assert.deepEqual(server('Isuzu', 'Ascender', 2006, 'suv3'), { ok: false, error: 'tier_mismatch' });
  });
});

describe('models that still have two defensible tiers stay on the quote form', () => {
  it('uncertain models stay out of the catalog and the selector', () => {
    const legacy = Catalog.toLegacyModelsMap();
    for (const [make, model] of [['Kia', 'Rondo'], ['Mazda', 'Mazda5'], ['Audi', 'A6 allroad'], ['INFINITI', 'FX35'], ['INFINITI', 'QX70'],
      ['Buick', 'Rendezvous'], ['Chevrolet', 'Astro']]) {
      assert.equal(Catalog.resolveVehicle({ make, model }).ok, false, model);
      assert.equal(Boolean(legacy[make] && legacy[make].m.includes(model)), false, model + ' in selector');
    }
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
    assert.deepEqual(check('Studebaker', 'Champion', 1990, 'small'), { ok: false, error: 'vehicle_unresolved' });
    assert.deepEqual(check('Honda', 'Accord Crossroad Concept', 2001, 'small'), { ok: false, error: 'vehicle_unresolved' });
  });

  it('EQS/EQE: the server prices each variant at its own size and rejects the sedan size for the SUV', () => {
    assert.deepEqual(check('Mercedes-Benz', 'EQS SUV', 2024, 'suv3'), { ok: true });
    assert.deepEqual(check('Mercedes-Benz', 'EQS SUV', 2024, 'small'), { ok: false, error: 'tier_mismatch' });
    assert.deepEqual(check('Mercedes-Benz', 'EQE SUV', 2024, 'suv2'), { ok: true });
    assert.deepEqual(check('Mercedes-Benz', 'EQE SUV', 2024, 'small'), { ok: false, error: 'tier_mismatch' });
    assert.deepEqual(check('Mercedes-Benz', 'EQS Sedan', 2024, 'small'), { ok: true });
    assert.deepEqual(check('Mercedes-Benz', 'EQE Sedan', 2024, 'small'), { ok: true });
    // Bookings stored before the split ("EQS", "EQE") still resolve to the sedan.
    assert.deepEqual(check('Mercedes-Benz', 'EQS', 2024, 'small'), { ok: true });
    assert.deepEqual(check('Mercedes-Benz', 'EQE', 2024, 'small'), { ok: true });
    assert.deepEqual(check('Mercedes-Benz', 'EQS', 2024, 'suv3'), { ok: false, error: 'tier_mismatch' });
  });

  it('reclassified and split models are enforced on the server', () => {
    const cases = [
      ['Kia', 'EV6', 'suv2', 'small'], ['Porsche', 'Cayenne', 'suv3', 'suv2'], ['Toyota', '4Runner', 'suv3', 'suv2'],
      ['Mazda', 'CX-70', 'suv3', 'suv2'], ['GMC', 'Hummer EV Pickup', 'truck', 'suv3'], ['GMC', 'Hummer EV SUV', 'suv3', 'truck'],
      ['Land Rover', 'Defender 90', 'suv2', 'suv3'], ['Land Rover', 'Defender 130', 'suv3', 'suv2'],
      ['Porsche', 'Cayenne Electric', 'suv3', 'suv2'], ['Hyundai', 'Santa Fe Sport', 'suv2', 'suv3'],
    ];
    for (const [make, model, right, wrong] of cases) {
      assert.deepEqual(check(make, model, 2024, right), { ok: true }, `${model} ${right}`);
      assert.deepEqual(check(make, model, 2024, wrong), { ok: false, error: 'tier_mismatch' }, `${model} ${wrong}`);
    }
    // Santa Fe size follows the model year; the wrong size for the year is rejected.
    assert.deepEqual(check('Hyundai', 'Santa Fe', 2015, 'suv3'), { ok: true });
    assert.deepEqual(check('Hyundai', 'Santa Fe', 2015, 'suv2'), { ok: false, error: 'tier_mismatch' });
    assert.deepEqual(check('Hyundai', 'Santa Fe', 2021, 'suv2'), { ok: true });
    assert.deepEqual(check('Hyundai', 'Santa Fe', 2021, 'suv3'), { ok: false, error: 'tier_mismatch' });
    assert.deepEqual(check('Hyundai', 'Santa Fe', 2025, 'suv3'), { ok: true });
    assert.deepEqual(check('Hyundai', 'Santa Fe XL', 2019, 'suv3'), { ok: true });
    // Old single names keep their previous size (no silent price change for stored labels).
    assert.deepEqual(check('GMC', 'Hummer EV', 2024, 'suv3'), { ok: true });
    assert.deepEqual(check('Land Rover', 'Defender', 2022, 'suv3'), { ok: true });
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

  it('no quote-only list remains; recognized variants are catalog vehicles', () => {
    assert.equal(catalogJson.quoteOnlyModels, undefined);
    for (const [model, tier] of [['EQS Sedan', 'small'], ['EQS SUV', 'suv3'], ['EQE Sedan', 'small'], ['EQE SUV', 'suv2']]) {
      assert.equal(Catalog.resolveVehicle({ make: 'Mercedes-Benz', model }).tierKey, tier, model);
    }
  });

  it('package prices follow the catalog size for the changed models (prices themselves unchanged)', () => {
    const row = (tier) => {
      const m = index.match(new RegExp(`\\n\\s*${tier}:\\s*\\{label:[^}]*\\}`));
      assert.ok(m, tier);
      const num = (k) => Number(m[0].match(new RegExp(`\\b${k}:(\\d+)`))[1]);
      return { wash: num('wash'), full: num('full'), premium: num('premium') };
    };
    assert.deepEqual(row('small'), { wash: 125, full: 250, premium: 400 });
    assert.deepEqual(row('suv2'), { wash: 145, full: 285, premium: 495 });
    assert.deepEqual(row('suv3'), { wash: 165, full: 310, premium: 570 });
    assert.deepEqual(row('truck'), { wash: 165, full: 300, premium: 555 });
    const full = (make, model) => row(Catalog.resolveVehicle({ make, model, year: 2024 }).tierKey).full;
    assert.equal(full('Mercedes-Benz', 'EQS SUV'), 310);
    assert.equal(full('Mercedes-Benz', 'EQS Sedan'), 250);
    assert.equal(full('Mercedes-Benz', 'EQE SUV'), 285);
    assert.equal(full('Kia', 'EV6'), 285);
    assert.equal(full('Porsche', 'Cayenne'), 310);
    assert.equal(full('Toyota', '4Runner'), 310);
    assert.equal(full('GMC', 'Hummer EV Pickup'), 300);
    assert.equal(full('Porsche', 'Cayenne Electric'), 310);
    assert.equal(full('Land Rover', 'Defender 90'), 285);
    assert.equal(full('Land Rover', 'Defender 110'), 310);
    assert.equal(row(Catalog.resolveVehicle({ make: 'Hyundai', model: 'Santa Fe', year: 2015 }).tierKey).full, 310);
    assert.equal(row(Catalog.resolveVehicle({ make: 'Hyundai', model: 'Santa Fe', year: 2021 }).tierKey).full, 285);
    assert.equal(row(Catalog.resolveVehicle({ make: 'Hyundai', model: 'Santa Fe XL', year: 2019 }).tierKey).full, 310);
  });

  it('the browser runtime carries the same verification data as the JSON', () => {
    const generated = require('../assets/generated/cars-vehicle-catalog.generated.js');
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
