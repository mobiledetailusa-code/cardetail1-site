const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  subscriberPrice, fleetMonthlyPrice, matchPackFromBooking, catalogForClient,
} = require('../netlify/lib/customer-catalog');

describe('customer-catalog', () => {
  it('applies 10% subscriber discount', () => {
    assert.equal(subscriberPrice(175), 157.5);
    assert.equal(subscriberPrice(300), 270);
  });

  it('fleet pricing stacks fleet discount on subscriber price', () => {
    const fleet = { id: 'fleet-2', vehicleCount: 2, extraDiscountPct: 0.08 };
    const total = fleetMonthlyPrice(175, fleet);
    assert.equal(total, 289.8);
  });

  it('matchPackFromBooking finds maintenance', () => {
    const p = matchPackFromBooking({ package: 'Maintenance Detail — Small Car' });
    assert.equal(p.id, 'maint');
  });

  it('catalogForClient exposes monthly prices', () => {
    const cat = catalogForClient();
    assert.equal(cat.subscriberDiscountPct, 10);
    assert.ok(cat.packages.some(p => p.id === 'full' && p.monthlyPrice === 270));
  });
});
