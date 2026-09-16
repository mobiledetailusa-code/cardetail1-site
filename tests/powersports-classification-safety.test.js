'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const Catalog = require('../assets/powersports-model-catalog');
const Safety = require('../assets/powersports-booking-safety');
const LineItems = require('../assets/booking-line-items');
const VehicleSummary = require('../assets/booking-vehicle-summary');
const ServerPricing = require('../netlify/lib/booking-price-catalog');

const CLIENT_PRICING = {
  tiers: ServerPricing.PRICING.powersports.tiers,
};

const SIX_FAMILIES = new Set([
  'motorcycle', 'motorcycle_large', 'motorcycle_trike',
  'atv', 'utv_standard', 'utv_large',
]);
const OUTSIDE_FAMILIES = new Set(['golfcart', 'pwc', 'equipment', 'boat']);

function resolveInto(st, make, model) {
  Safety.resetForIdentityChange(st, make, model);
  return Safety.resolveAndApply(st, CLIENT_PRICING, make, model);
}

describe('canonical 336-row Powersports metadata', () => {
  it('classifies every unique row explicitly with complete metadata and no regex fallback', () => {
    assert.equal(Catalog.records.length, 336);
    const identities = new Set();
    for (const record of Catalog.records) {
      for (const key of ['make', 'model', 'physicalFamily', 'displaySubtype', 'publicStatus']) {
        assert.equal(typeof record[key], 'string', `${record.make} ${record.model} missing ${key}`);
        assert.notEqual(record[key].trim(), '', `${record.make} ${record.model} blank ${key}`);
      }
      assert.equal(
        SIX_FAMILIES.has(record.serviceClass) || (record.serviceClass === null && OUTSIDE_FAMILIES.has(record.physicalFamily)),
        true,
        `${record.make} ${record.model} has an invalid route`
      );
      assert.equal(
        record.configuration === null || ['string', 'object'].includes(typeof record.configuration),
        true,
        `${record.make} ${record.model} has invalid configuration metadata`
      );
      const key = `${record.make}\u0000${record.model}`.toLowerCase();
      assert.equal(identities.has(key), false, `duplicate ${record.make} ${record.model}`);
      identities.add(key);
      assert.strictEqual(Catalog.resolve(record.make, record.model), record);
      const classified = Safety.classify({}, CLIENT_PRICING, record.make, record.model);
      assert.strictEqual(classified.record, record);
      assert.notEqual(classified.source, 'manual');
      assert.notEqual(classified.status, 'unknown');
    }
    assert.equal(identities.size, 336);
  });

  it('returns the audited family and out-of-scope counts', () => {
    assert.deepEqual(Catalog.counts(), {
      total: 336,
      motorcycle: 117,
      atv: 33,
      utv_standard: 73,
      motorcycle_large: 29,
      equipment: 10,
      utv_large: 10,
      motorcycle_trike: 4,
      golfcart: 32,
      pwc: 26,
      boat: 2,
    });
  });

  it('keeps style subtype separate from physical service workload', () => {
    const rebel300 = Catalog.resolve('Honda', 'Rebel 300');
    const rebel1100 = Catalog.resolve('Honda', 'Rebel 1100');
    assert.equal(rebel300.displaySubtype, 'Cruiser');
    assert.equal(rebel1100.displaySubtype, 'Cruiser');
    assert.equal(rebel300.serviceClass, 'motorcycle');
    assert.equal(rebel1100.serviceClass, 'motorcycle_large');
  });
});

describe('exact hard-error corrections', () => {
  it('classifies Harley, trikes, ATV collision cases and explicit UTV sizes', () => {
    const expected = [
      ['Indian Motorcycle', 'Challenger', 'motorcycle_large'],
      ['Polaris', 'ACE', 'atv'],
      ['Massimo', 'MSA 550', 'atv'],
      ['Massimo', 'MSA 750', 'atv'],
      ['Segway', 'Snarler AT6', 'atv'],
      ['Tracker Off Road', '300', 'atv'],
      ['Tracker Off Road', '500', 'utv_standard'],
      ['Tracker Off Road', '800SX', 'utv_standard'],
      ['Tracker Off Road', '800SX Crew', 'utv_large'],
      ['Polaris', 'General XP 4', 'utv_large'],
      ['Polaris', 'RZR Trail', 'utv_standard'],
      ['Can-Am', 'Ryker', 'motorcycle_trike'],
      ['Can-Am', 'Spyder F3', 'motorcycle_trike'],
      ['Can-Am', 'Spyder RT', 'motorcycle_trike'],
      ['Polaris', 'Slingshot', 'motorcycle_trike'],
    ];
    for (const [make, model, serviceClass] of expected) {
      assert.equal(Catalog.resolve(make, model).serviceClass, serviceClass, `${make} ${model}`);
    }
  });

  it('classifies all 15 Harley rows correctly and none as ATV or UTV', () => {
    const rows = Catalog.records.filter((record) => record.make === 'Harley-Davidson');
    assert.equal(rows.length, 15);
    for (const record of rows) {
      assert.equal(record.serviceClass, record.model === 'Pan America' ? 'motorcycle' : 'motorcycle_large');
      assert.equal(record.serviceClass.includes('utv'), false);
      assert.notEqual(record.serviceClass, 'atv');
    }
  });
});

describe('identity reset and deterministic recomputation', () => {
  it('repairs RZR → Harley and the reverse without retaining tier, label or price', () => {
    const st = { tierKey: '', tier: null, displayLabel: '', vehicleLabel: '', basePrice: 0 };
    let result = resolveInto(st, 'Polaris', 'RZR Trail');
    assert.equal(result.status, 'bookable');
    assert.equal(st.tierKey, 'utv_standard');
    st.vehicleLabel = '2025 Polaris RZR Trail';
    st.basePrice = 395;

    assert.equal(Safety.resetForIdentityChange(st, 'Harley-Davidson', ''), true);
    assert.equal(st.tierKey, '');
    assert.equal(st.tier, null);
    assert.equal(st.displayLabel, '');
    assert.equal(st.vehicleLabel, '');
    assert.equal(st.basePrice, 0);
    result = resolveInto(st, 'Harley-Davidson', 'Road Glide');
    assert.equal(result.status, 'bookable');
    assert.equal(st.tierKey, 'motorcycle_large');
    assert.equal(st.displayLabel, 'Large Motorcycle');
    assert.equal(st.tier.priceTierKey, 'motorcycle_large');

    result = resolveInto(st, 'Polaris', 'RZR Trail');
    assert.equal(result.status, 'bookable');
    assert.equal(st.tierKey, 'utv_standard');
    assert.equal(st.displayLabel, 'Side-by-Side / UTV');
    assert.equal(st.tier.priceTierKey, 'utv_standard');
  });

  it('recomputes ATV → Motorcycle → UTV → Trike → ATV with a safe Trike stop', () => {
    const st = {};
    for (const [make, model, expectedClass, expectedStatus] of [
      ['Honda', 'FourTrax Rancher', 'atv', 'bookable'],
      ['Honda', 'Rebel 500', 'motorcycle', 'bookable'],
      ['Polaris', 'General XP 4', 'utv_large', 'bookable'],
      ['Can-Am', 'Spyder RT', 'motorcycle_trike', 'bookable'],
      ['Massimo', 'MSA 550', 'atv', 'bookable'],
    ]) {
      const result = resolveInto(st, make, model);
      assert.equal(result.status, expectedStatus, `${make} ${model}`);
      assert.equal(st.tierKey, expectedClass, `${make} ${model}`);
      if (expectedStatus !== 'bookable') {
        assert.equal(st.basePrice, 0);
        assert.equal(st.tier, null);
      }
    }
  });
});

describe('safe fallback and explicit quarantine', () => {
  it('never guesses an unknown/freeform model, but accepts bounded manual class selection', () => {
    const st = {};
    let result = resolveInto(st, 'Polaris-ish Unknown Make', 'RZR-looking Freeform');
    assert.equal(result.status, 'unknown');
    assert.equal(st.tierKey, '');
    assert.equal(st.basePrice, 0);
    assert.equal(Safety.chooseManualClass(st, 'atv'), true);
    result = Safety.resolveAndApply(st, CLIENT_PRICING, 'Polaris-ish Unknown Make', 'RZR-looking Freeform');
    assert.equal(result.status, 'bookable');
    assert.equal(result.source, 'manual');
    assert.equal(st.tierKey, 'atv');
  });

  it('routes PWC/pontoon to Boats and stops Golf and Equipment before numeric pricing', () => {
    for (const [make, model, status] of [
      ['Sea-Doo', 'Spark', 'route_boats'],
      ['Sea-Doo', 'Switch', 'route_boats'],
      ['Club Car', 'Onward', 'contact'],
      ['Bobcat', 'S70 Skid Steer', 'contact'],
    ]) {
      const st = { basePrice: 999, tierKey: 'utv_large', tier: { label: 'stale' } };
      const result = resolveInto(st, make, model);
      assert.equal(result.status, status, `${make} ${model}`);
      assert.equal(st.basePrice, 0);
      assert.equal(st.tierKey, '');
      assert.equal(st.tier, null);
    }
    assert.equal(Catalog.records.filter((r) => r.publicStatus === 'route_boats').length, 28);
    assert.equal(Catalog.records.filter((r) => r.publicStatus === 'contact').length, 42);
  });

  it('removes a previously rendered numeric price from every non-bookable DOM stop', () => {
    const elements = {
      'g-custom-note': { style: {}, textContent: '' },
      'tier-chips-wrap': { style: {} },
      'tier-chips-note': { hidden: true, textContent: '' },
      vc: { classList: { add() {}, remove() {} } },
      next3: { disabled: false },
      'vc-price': { style: { display: 'block' }, textContent: '$395' },
      'vc-name': { textContent: '' },
    };
    const doc = { getElementById(id) { return elements[id] || null; } };
    const st = { basePrice: 395 };
    const result = Safety.classify(st, CLIENT_PRICING, 'Club Car', 'Onward');
    assert.equal(Safety.presentResolution(st, result, 'Club Car', 'Onward', '2025', doc), false);
    assert.equal(elements.next3.disabled, true);
    assert.equal(elements['vc-price'].style.display, 'none');
    assert.equal(elements['vc-price'].textContent, '');
    assert.equal(st.basePrice, 0);
  });
});

describe('client/server/review parity with frozen money', () => {
  it('aligns every publicly bookable service key and maps only to frozen price tiers', () => {
    assert.deepEqual([...Safety.publicServiceClassKeys].sort(), [...ServerPricing.POWERSPORTS_PUBLIC_TIER_KEYS].sort());
    assert.deepEqual([...Safety.publicServiceClassKeys].sort(), [
      'atv', 'motorcycle', 'motorcycle_large', 'motorcycle_trike', 'utv_large', 'utv_standard',
    ]);
    const expectedPriceTier = {
      motorcycle: 'motorcycle', motorcycle_large: 'motorcycle_large',
      motorcycle_trike: 'motorcycle_trike',
      atv: 'atv', utv_standard: 'utv_standard', utv_large: 'utv_large',
    };
    for (const [serviceClass, priceTier] of Object.entries(expectedPriceTier)) {
      assert.equal(Catalog.priceTierForServiceClass(serviceClass), priceTier);
      const pkgId = serviceClass === 'motorcycle_trike' ? 'maintenance' : 'premium';
      const result = ServerPricing.computeVehicleSubtotal({
        cat: 'powersports', pkgId, tierKey: serviceClass, addons: [],
      }, '07102');
      assert.equal(result.ok, true, serviceClass);
      assert.equal(result.basePrice, CLIENT_PRICING.tiers[priceTier][pkgId]);
      assert.equal(result.tierKey, serviceClass);
    }
    for (const unsafeKey of ['golfcart', 'equipment', 'pwc', 'boat']) {
      assert.equal(ServerPricing.computeVehicleSubtotal({
        cat: 'powersports', pkgId: 'wash', tierKey: unsafeKey, addons: [],
      }, '07102').ok, false, unsafeKey);
    }
  });

  it('preserves every Powersports package and add-on dollar value exactly', () => {
    assert.deepEqual(ServerPricing.PRICING.powersports.tiers, CLIENT_PRICING.tiers);
    assert.deepEqual(
      ServerPricing.PRICING.powersports.addons.map(({ id, price }) => [id, price]),
      [
        ['polymer', 25], ['wax1yr', 75], ['rainx', 25], ['heavymud', 55],
        ['seatdeep', 45], ['storage', 35], ['wheeldet', 35], ['waterspot', 35],
        ['saltwash', 35], ['trimprot', 35], ['lightdeg', 45], ['chrome_restore', 75],
      ]
    );
  });

  it('shows the customer-facing class on Powersports Review only', () => {
    const projection = LineItems.projectBooking({ vehicles: [{
      cat: 'powersports', vehicleLabel: '2025 Harley-Davidson Road Glide',
      tierLabel: 'Large Motorcycle', pkgName: 'Wash & Shine', basePrice: 100,
      addons: [], addonTotal: 0, subtotal: 100,
    }] });
    const html = LineItems.renderSummaryHtml(projection.items);
    assert.match(html, /bkli-vehicle-class/);
    assert.match(html, />Large Motorcycle</);
    assert.doesNotMatch(html, /motorcycle_large/);

    const carHtml = LineItems.renderSummaryHtml(LineItems.projectBooking({ vehicles: [{
      cat: 'cars', vehicleLabel: '2025 Honda Civic', tierLabel: 'Small Car',
      pkgName: 'Wash', basePrice: 110, addons: [], subtotal: 110,
    }] }).items);
    assert.doesNotMatch(carHtml, /bkli-vehicle-class/);
  });

  it('clears classification state for all six cross-category directions', () => {
    for (const [from, to] of [
      ['cars', 'powersports'], ['rvs', 'powersports'], ['boats', 'powersports'],
      ['powersports', 'cars'], ['powersports', 'rvs'], ['powersports', 'boats'],
    ]) {
      const st = {
        cat: from, tierKey: 'utv_large', tier: { label: 'Large UTV' },
        displayLabel: 'Large / Crew Side-by-Side / UTV', vehicleLabel: 'old', basePrice: 395,
        make: 'Polaris', model: 'General XP 4', year: '2025',
        _powersportsIdentity: 'old', _powersportsManualClass: 'utv_large',
        _powersportsResolutionStatus: 'bookable', rvType: 'travel', rvLiving: 'yes', boatType: 'pontoon',
      };
      VehicleSummary.clearCategoryExclusiveFields(st, to);
      assert.equal(st.tierKey, '', `${from} → ${to}`);
      assert.equal(st.tier, null, `${from} → ${to}`);
      assert.equal(st.vehicleLabel, '', `${from} → ${to}`);
      assert.equal(st.basePrice, 0, `${from} → ${to}`);
      assert.equal(st._powersportsIdentity, '', `${from} → ${to}`);
    }
  });

  it('keeps all 13 booking surfaces on the same canonical source and resolver', () => {
    const pages = [
      'index.html', 'bergen-county-hub.html', 'hudson-county-hub.html',
      'essex-county-hub.html', 'passaic-county-hub.html', 'ny-metro-hub.html',
      'connecticut-hub.html', 'pennsylvania-hub.html', 'new-jersey-hub.html',
      'newark-mobile-detailing.html', 'trenton-mobile-detailing.html',
      'westchester-mobile-detailing.html', 'template-city.html',
    ];
    for (const page of pages) {
      const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
      assert.match(html, /assets\/powersports-model-catalog\.js/, page);
      assert.match(html, /assets\/powersports-booking-safety\.js/, page);
      assert.match(html, /powersports: window\.CD1PowersportsCatalog\.powersportsModelsByMake\(\)/, page);
      assert.match(html, /CD1PowersportsBookingSafety\.resetForIdentityChange\(ST,make,model\)/, page);
      assert.match(html, /CD1PowersportsBookingSafety\.resolveAndApply\(ST,PRICING\.powersports,make,model\)/, page);
    }
  });
});
