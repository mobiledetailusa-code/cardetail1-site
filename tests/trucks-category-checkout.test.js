/**
 * Trucks (commercial semis) category — pricing + checkout coercion smoke.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  PRICING,
  computeVehicleSubtotal,
  coerceVehicleForCategory,
  validateAndRecalculateBookingPricing,
} = require('../netlify/lib/booking-price-catalog');

const root = path.join(__dirname, '..');

describe('trucks category pricing authority', () => {
  it('exposes day_cab and sleeper_cab at $325 / $400 / $500', () => {
    assert.ok(PRICING.trucks);
    assert.equal(PRICING.trucks.tiers.day_cab.interior, 325);
    assert.equal(PRICING.trucks.tiers.day_cab.int_wash, 400);
    assert.equal(PRICING.trucks.tiers.day_cab.int_wash_wax, 500);
    assert.equal(PRICING.trucks.tiers.sleeper_cab.interior, 325);
    assert.equal(PRICING.trucks.tiers.sleeper_cab.int_wash, 400);
    assert.equal(PRICING.trucks.tiers.sleeper_cab.int_wash_wax, 500);
  });

  it('prices sleeper interior detail at $325 for ZIP 07601', () => {
    const r = computeVehicleSubtotal(
      {
        cat: 'trucks',
        pkgId: 'interior',
        tierKey: 'sleeper_cab',
        addons: [],
      },
      '07601'
    );
    assert.equal(r.ok, true);
    assert.equal(r.subtotal, 325);
  });

  it('prices day cab int_wash_wax with superint add-on', () => {
    const r = computeVehicleSubtotal(
      {
        cat: 'trucks',
        pkgId: 'int_wash_wax',
        tierKey: 'day_cab',
        addons: [{ id: 'superint' }],
      },
      '07601'
    );
    assert.equal(r.ok, true);
    assert.equal(r.subtotal, 500 + 125);
  });
});

describe('trucks coerce keeps semis out of cars pickup tier', () => {
  it('maps sleeper labels to sleeper_cab under trucks', () => {
    const coerced = coerceVehicleForCategory(
      { vehicleLabel: '2021 Peterbilt 389 Sleep Cab', packageId: 'full' },
      'trucks'
    );
    assert.equal(coerced.category, 'trucks');
    assert.equal(coerced.packageId, 'interior');
    assert.equal(coerced.tierKey, 'sleeper_cab');
  });

  it('does not coerce Freightliner / semi labels to cars.truck pickup tier', () => {
    const coerced = coerceVehicleForCategory(
      { vehicleLabel: 'Freightliner Cascadia sleeper', packageId: 'interior' },
      'cars'
    );
    assert.equal(coerced.category, 'cars');
    assert.notEqual(coerced.tierKey, 'truck');
  });

  it('still maps consumer pickups to cars.truck', () => {
    const coerced = coerceVehicleForCategory(
      { vehicleLabel: 'Ford F-150 SuperCrew pickup', packageId: 'interior' },
      'cars'
    );
    assert.equal(coerced.tierKey, 'truck');
  });
});

describe('trucks booking checkout recalculation', () => {
  it('validateAndRecalculateBookingPricing accepts a trucks cart', () => {
    const result = validateAndRecalculateBookingPricing({
      zipCode: '07601',
      totalPrice: 400,
      vehicles: [
        {
          cat: 'trucks',
          pkgId: 'int_wash',
          tierKey: 'sleeper_cab',
          vehicleLabel: '2021 Peterbilt 389 · Sleep / Sleeper Cab',
          addons: [],
        },
      ],
    });
    assert.equal(result.ok, true);
    assert.equal(result.serviceSubtotal, 400);
  });
});

describe('trucks public surface english-only + home option', () => {
  it('homepage specialty nav and footer expose trucks outside cars', () => {
    const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.match(index, /href="trucks-detailing\.html">Trucks</);
    assert.match(index, /href="trucks-detailing\.html">Trucks \/ Semis</);
    assert.match(index, /id="bkcat-trucks"/);
    assert.match(index, /svc-name[^>]*>Cars &amp; SUVs</);
    assert.doesNotMatch(index, /carretas/i);
    assert.doesNotMatch(index, /Cars, SUVs &amp; Trucks/);
  });

  it('home location carousel includes trucks after cars with refined icon assets', () => {
    const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.match(index, /ZONE_POPULAR[\s\S]*nj_a:\s*\['cars','trucks'/);
    assert.match(index, /cats = \['cars','trucks'/);
    assert.match(index, /cat === 'trucks' \? 'trucks-detailing\.html'/);
    assert.ok(fs.existsSync(path.join(root, 'assets/icons/3d/cat-trucks.webp')));
    assert.ok(fs.existsSync(path.join(root, 'assets/icons/3d/pack-trucks-family.webp')));
    const icon3d = fs.readFileSync(path.join(root, 'assets/icon-3d.js'), 'utf8');
    assert.match(icon3d, /tractor-trailer|Day cab semi and sleeper tractor with trailer/);
  });

  it('trucks specialty page bridges to book=trucks packages', () => {
    const html = fs.readFileSync(path.join(root, 'trucks-detailing.html'), 'utf8');
    assert.match(html, /data-booking-category="trucks"/);
    assert.match(html, /data-booking-package="interior"/);
    assert.match(html, /data-booking-package="int_wash"/);
    assert.match(html, /data-booking-package="int_wash_wax"/);
    assert.doesNotMatch(html, /carretas/i);
    assert.doesNotMatch(html, /data-booking-category="cars"/);
  });

  it('specialty booking bridge allows trucks packages', () => {
    const js = fs.readFileSync(path.join(root, 'assets/specialty-booking-bridge.js'), 'utf8');
    assert.match(js, /trucks:\s*\{\s*interior:\s*1,\s*int_wash:\s*1,\s*int_wash_wax:\s*1\s*\}/);
  });
});
