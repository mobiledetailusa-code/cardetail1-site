'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Catalog = require('../assets/powersports-model-catalog');
const Safety = require('../assets/powersports-booking-safety');
const ServerPricing = require('../netlify/lib/booking-price-catalog');

const ROOT = path.resolve(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function extractPowersportsPackages() {
  const match = INDEX.match(/powersports:\s*\{[\s\S]*?packages:\[([\s\S]*?)\],\s*addons:/);
  assert.ok(match, 'powersports packages missing');
  const ids = [...match[1].matchAll(/id:'([^']+)'/g)].map((row) => row[1]);
  const publicIds = ids.filter((id) => !new RegExp(`id:'${id}'[\\s\\S]{0,220}legacy:true`).test(match[1]));
  return { ids, publicIds };
}

describe('Powersports commercial two-package model', () => {
  it('keeps historical package IDs while exposing only two new public packages', () => {
    const { ids, publicIds } = extractPowersportsPackages();
    assert.deepEqual(publicIds, ['maintenance', 'restore']);
    for (const id of ['wash', 'essential', 'full', 'premium']) {
      assert.equal(ids.includes(id), true, id);
    }
    const mutation = fs.readFileSync(path.join(ROOT, 'netlify/lib/package-financial-mutation.js'), 'utf8');
    assert.match(mutation, /wash: 'Wash & Shine'/);
    assert.match(mutation, /premium: 'Premium Detail'/);
    assert.match(mutation, /maintenance: 'Maintenance Detail'/);
    assert.match(mutation, /restore: 'Correction \/ Restoration Detail'/);
  });

  it('preserves historical dollar meaning for old package IDs', () => {
    const historical = {
      motorcycle: { wash:105, essential:165, full:235, premium:325 },
      atv: { wash:105, essential:165, full:235, premium:325 },
      utv: { wash:130, essential:200, full:290, premium:410 },
    };
    for (const [tierKey, prices] of Object.entries(historical)) {
      for (const [pkgId, amount] of Object.entries(prices)) {
        const result = ServerPricing.computeVehicleSubtotal({
          cat: 'powersports', pkgId, tierKey, addons: [],
        }, '07102');
        assert.equal(result.ok, true, `${tierKey} ${pkgId}`);
        assert.equal(result.basePrice, amount);
      }
    }
  });

  it('prices the approved public matrix on client and server', () => {
    const matrix = {
      motorcycle: { maintenance:180, restore:250 },
      motorcycle_large: { maintenance:200, restore:275 },
      motorcycle_trike: { maintenance:225, restore:310 },
      atv: { maintenance:180, restore:240 },
      utv_standard: { maintenance:210, restore:275 },
      utv_large: { maintenance:235, restore:325 },
    };
    for (const [serviceClass, prices] of Object.entries(matrix)) {
      assert.equal(Catalog.priceTierForServiceClass(serviceClass), serviceClass);
      for (const [pkgId, amount] of Object.entries(prices)) {
        assert.equal(ServerPricing.PRICING.powersports.tiers[serviceClass][pkgId], amount);
        const result = ServerPricing.computeVehicleSubtotal({
          cat: 'powersports', pkgId, tierKey: serviceClass, addons: [],
        }, '07102');
        assert.equal(result.ok, true, `${serviceClass} ${pkgId}`);
        assert.equal(result.basePrice, amount);
      }
    }
    assert.equal(ServerPricing.PRICING.powersports.addons.find((a) => a.id === 'heavymud').price, 55);
    const withMud = ServerPricing.computeVehicleSubtotal({
      cat: 'powersports',
      pkgId: 'maintenance',
      tierKey: 'utv_large',
      addons: [{ id: 'heavymud', qty: 1 }],
    }, '07102');
    assert.equal(withMud.ok, true);
    assert.equal(withMud.basePrice, 235);
    assert.equal(withMud.addonTotal, 55);
    assert.equal(withMud.subtotal, 290);

    const cart = ServerPricing.computeBookingServiceSubtotal({
      zipCode: '07102',
      vehicles: [
        { cat: 'powersports', pkgId: 'maintenance', tierKey: 'motorcycle', addons: [] },
        { cat: 'powersports', pkgId: 'maintenance', tierKey: 'utv_large', addons: [] },
      ],
    });
    assert.equal(cart.ok, true);
    assert.equal(cart.serviceSubtotal, 415);
  });

  it('books supported trikes at the approved numeric prices', () => {
    for (const [make, model] of [['Can-Am', 'Spyder RT'], ['Can-Am', 'Ryker'], ['Polaris', 'Slingshot']]) {
      const record = Catalog.resolve(make, model);
      assert.equal(record.serviceClass, 'motorcycle_trike');
      assert.equal(record.publicStatus, 'bookable');
      const st = {};
      const result = Safety.resolveAndApply(st, ServerPricing.PRICING.powersports, make, model);
      assert.equal(result.status, 'bookable', `${make} ${model}`);
      assert.equal(st.tierKey, 'motorcycle_trike');
    }
  });

  it('does not invent Golf, Equipment, or PWC numeric Powersports prices', () => {
    assert.equal(Catalog.resolve('Club Car', 'Onward').publicStatus, 'contact');
    assert.equal(Catalog.resolve('Bobcat', 'S70 Skid Steer').publicStatus, 'contact');
    assert.equal(Catalog.resolve('Sea-Doo', 'Spark').publicStatus, 'route_boats');
    assert.equal(Catalog.resolve('Sea-Doo', 'Switch').publicStatus, 'route_boats');
    assert.equal(ServerPricing.PRICING.powersports.tiers.jetski.wash, 105);
    assert.equal(ServerPricing.PRICING.powersports.tiers.jetski.maintenance, undefined);
  });

  it('maps Powersports Maintenance Detail names to the new ID, not cars maint', () => {
    assert.equal(ServerPricing.inferPkgId({
      cat: 'powersports',
      pkgName: 'Maintenance Detail',
    }, {}), 'maintenance');
    assert.equal(ServerPricing.inferPkgId({
      cat: 'cars',
      pkgName: 'Maintenance Detail',
    }, {}), 'maint');
    assert.equal(ServerPricing.inferPkgId({
      cat: 'powersports',
      pkgName: 'Wash & Shine',
    }, {}), 'wash');
    assert.equal(ServerPricing.inferPkgId({
      cat: 'powersports',
      pkgName: 'Deep Detail & Restore',
    }, {}), 'restore');
  });
});
