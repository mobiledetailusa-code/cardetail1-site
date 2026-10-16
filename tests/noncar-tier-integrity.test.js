'use strict';

/**
 * Non-car tier integrity.
 *
 * A known Powersports catalog identity cannot be repriced by a cheaper class,
 * a different category, or a Jet Ski flag. Vehicles the catalog does not list
 * keep the explicit tier or length already on the request. Dollar tables are
 * not edited.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { computeVehicleSubtotal, PRICING, LENGTH_PRICING } = require('../netlify/lib/booking-price-catalog');
const { applyServerTravelAndTotal } = require('../netlify/lib/travel-fee');
const root = path.resolve(__dirname, '..');

function quote(vehicle) {
  return computeVehicleSubtotal({ addons: [], ...vehicle }, '07102');
}

describe('known Powersports identities', () => {
  it('prices a large motorcycle only at its catalog class', () => {
    const correct = quote({
      cat: 'powersports',
      pkgId: 'maintenance',
      tierKey: 'motorcycle_large',
      make: 'Yamaha',
      model: 'FJR1300',
    });
    assert.equal(correct.ok, true);
    assert.equal(correct.basePrice, PRICING.powersports.tiers.motorcycle_large.maintenance);
    assert.equal(correct.tierKey, 'motorcycle_large');

    const cheaper = quote({
      cat: 'powersports',
      pkgId: 'maintenance',
      tierKey: 'motorcycle',
      make: 'Yamaha',
      model: 'FJR1300',
    });
    assert.equal(cheaper.ok, false);
    assert.equal(cheaper.error, 'tier_mismatch');

    const fromLabel = quote({
      cat: 'powersports',
      pkgId: 'maintenance',
      tierKey: 'motorcycle',
      vehicleLabel: '2024 Yamaha FJR1300',
    });
    assert.equal(fromLabel.ok, false);
    assert.equal(fromLabel.error, 'tier_mismatch');
  });

  it('rejects a crew UTV submitted as the smaller side-by-side class', () => {
    const cheaper = quote({
      cat: 'powersports',
      pkgId: 'maintenance',
      tierKey: 'utv_standard',
      make: 'Can-Am',
      model: 'Defender MAX',
    });
    assert.equal(cheaper.ok, false);
    assert.equal(cheaper.error, 'tier_mismatch');
    const correct = quote({
      cat: 'powersports',
      pkgId: 'maintenance',
      tierKey: 'utv_large',
      make: 'Can-Am',
      model: 'Defender MAX',
    });
    assert.equal(correct.basePrice, PRICING.powersports.tiers.utv_large.maintenance);
  });

  it('does not give a catalog contact vehicle an instant Powersports price', () => {
    const golf = quote({
      cat: 'powersports',
      pkgId: 'maintenance',
      tierKey: 'motorcycle',
      make: 'Club Car',
      model: 'Onward',
    });
    assert.equal(golf.ok, false);
    assert.equal(golf.error, 'vehicle_unresolved');
  });

  it('keeps an unlisted motorcycle on the explicit tier', () => {
    const custom = quote({
      cat: 'powersports',
      pkgId: 'maintenance',
      tierKey: 'motorcycle',
      make: 'Not A Catalog Make',
      model: 'Custom',
    });
    assert.equal(custom.ok, true);
    assert.equal(custom.basePrice, PRICING.powersports.tiers.motorcycle.maintenance);
  });

  it('resolves make, model, and year, plus a case-insensitive catalog match', () => {
    const withYear = quote({
      cat: 'powersports',
      pkgId: 'maintenance',
      tierKey: 'motorcycle_large',
      make: 'Yamaha',
      model: 'FJR1300',
      year: 2024,
    });
    assert.equal(withYear.ok, true);
    assert.equal(withYear.basePrice, PRICING.powersports.tiers.motorcycle_large.maintenance);

    const aliased = quote({
      cat: 'powersports',
      pkgId: 'maintenance',
      tierKey: 'motorcycle',
      make: 'YAMAHA',
      model: 'fjr1300',
    });
    assert.equal(aliased.ok, false);
    assert.equal(aliased.error, 'tier_mismatch');
  });

  it('rejects moving a known motorcycle onto boat, truck, or car pricing', () => {
    const asBoat = quote({
      cat: 'boats',
      pkgId: 'maint',
      lengthFt: 12,
      make: 'Yamaha',
      model: 'FJR1300',
    });
    assert.equal(asBoat.ok, false);
    assert.equal(asBoat.error, 'tier_mismatch');

    const asJetSki = quote({
      cat: 'boats',
      boatType: 'jetski',
      pkgId: 'maint',
      make: 'Yamaha',
      model: 'FJR1300',
    });
    assert.equal(asJetSki.ok, false);
    assert.equal(asJetSki.error, 'tier_mismatch');

    const asTruck = quote({
      cat: 'trucks',
      pkgId: 'interior',
      tierKey: 'day_cab',
      make: 'Yamaha',
      model: 'FJR1300',
    });
    assert.equal(asTruck.ok, false);
    assert.equal(asTruck.error, 'tier_mismatch');
  });
});

describe('PWC and pontoon routes', () => {
  it('keeps a known PWC on the existing Jet Ski wash price', () => {
    const pwc = quote({
      cat: 'boats',
      boatType: 'jetski',
      pkgId: 'maint',
      make: 'Kawasaki',
      model: 'Jet Ski Ultra 310',
      lengthFt: 12,
    });
    assert.equal(pwc.ok, true);
    assert.equal(pwc.basePrice, PRICING.powersports.tiers.jetski.wash);
    assert.equal(pwc.tierKey, 'jetski');

    const asPowersports = quote({
      cat: 'powersports',
      pkgId: 'wash',
      tierKey: 'motorcycle',
      make: 'Kawasaki',
      model: 'Jet Ski Ultra 310',
    });
    assert.equal(asPowersports.ok, false);
    assert.equal(asPowersports.error, 'tier_mismatch');
  });

  it('rejects a known pontoon submitted as a Jet Ski and does not invent a replacement price', () => {
    const asJetSki = quote({
      cat: 'boats',
      boatType: 'jetski',
      pkgId: 'maint',
      make: 'Sea-Doo',
      model: 'Switch',
      lengthFt: 22,
    });
    assert.equal(asJetSki.ok, false);
    assert.equal(asJetSki.error, 'tier_mismatch');
    assert.equal(asJetSki.basePrice, undefined);

    const asPontoon = quote({
      cat: 'boats',
      boatType: 'pontoon',
      pkgId: 'maint',
      make: 'Sea-Doo',
      model: 'Switch',
      lengthFt: 22,
    });
    assert.equal(asPontoon.ok, true);
    assert.equal(asPontoon.basePrice, 242);
  });

  it('still prices an unnamed Jet Ski and an in-range boat length', () => {
    const unnamed = quote({
      cat: 'boats',
      boatType: 'jetski',
      pkgId: 'maint',
      lengthFt: '',
    });
    assert.equal(unnamed.ok, true);
    assert.equal(unnamed.basePrice, 105);

    const runabout = quote({
      cat: 'boats',
      boatType: 'runabout',
      pkgId: 'maint',
      lengthFt: 22,
    });
    assert.equal(runabout.ok, true);
    assert.equal(runabout.basePrice, 242);
  });
});

describe('lengths, truck tiers, and client totals that are not underpricing', () => {
  it('does not price a boat below the package floor, and rejects a negative length', () => {
    const floor = quote({ cat: 'boats', pkgId: 'maint', lengthFt: LENGTH_PRICING.boats.min });
    const tooShort = quote({ cat: 'boats', pkgId: 'maint', lengthFt: 1 });
    const justUnder = quote({ cat: 'boats', pkgId: 'maint', lengthFt: 11 });
    const negative = quote({ cat: 'boats', pkgId: 'maint', lengthFt: -5 });
    assert.equal(floor.basePrice, LENGTH_PRICING.boats.packages.maint.min);
    assert.equal(tooShort.basePrice, floor.basePrice);
    assert.equal(justUnder.basePrice, floor.basePrice);
    assert.equal(negative.ok, false);
    assert.equal(negative.error, 'invalid_pricing');
  });

  it('prices an RV from the published per-foot formula, including a short Class A length', () => {
    const shortClassA = quote({ cat: 'rvs', pkgId: 'full', rvType: 'classA', lengthFt: 16 });
    const minClassA = quote({ cat: 'rvs', pkgId: 'full', rvType: 'classA', lengthFt: 24 });
    const negative = quote({ cat: 'rvs', pkgId: 'full', rvType: 'classA', lengthFt: -4 });
    const overMax = quote({ cat: 'rvs', pkgId: 'full', rvType: 'travel', lengthFt: 90 });
    assert.equal(shortClassA.ok, true);
    assert.ok(shortClassA.basePrice < minClassA.basePrice);
    assert.equal(negative.ok, false);
    assert.equal(overMax.ok, false);
  });

  it('keeps the two truck cab prices and ignores a cheaper total in the payload', () => {
    const day = quote({
      cat: 'trucks',
      pkgId: 'interior',
      tierKey: 'day_cab',
      vehicleLabel: 'Freightliner Cascadia sleeper',
    });
    const sleeper = quote({
      cat: 'trucks',
      pkgId: 'interior',
      tierKey: 'sleeper_cab',
    });
    assert.equal(day.basePrice, 295);
    assert.equal(sleeper.basePrice, 350);

    const mismatch = applyServerTravelAndTotal({
      zipCode: '07102',
      vehicleCategory: 'trucks',
      vehicles: [{ cat: 'trucks', pkgId: 'interior', tierKey: 'day_cab', addons: [] }],
      totalPrice: 1,
    }, { catalogTierMode: 'require_identity' });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.error, 'price_mismatch');
    assert.equal(mismatch.clientTotal, 1);
    assert.ok(mismatch.serverTotal > 1);
  });
});

describe('standard classes, ATV, golf cart, and published tables', () => {
  it('prices a standard motorcycle and ATV only on their own class', () => {
    const moto = quote({
      cat: 'powersports',
      pkgId: 'maintenance',
      tierKey: 'motorcycle',
      make: 'Aprilia',
      model: 'RS 660',
    });
    assert.equal(moto.ok, true);
    assert.equal(moto.basePrice, PRICING.powersports.tiers.motorcycle.maintenance);

    const asLarge = quote({
      cat: 'powersports',
      pkgId: 'maintenance',
      tierKey: 'motorcycle_large',
      make: 'Aprilia',
      model: 'RS 660',
    });
    assert.equal(asLarge.ok, false);
    assert.equal(asLarge.error, 'tier_mismatch');

    const atv = quote({
      cat: 'powersports',
      pkgId: 'maintenance',
      tierKey: 'atv',
      make: 'Can-Am',
      model: 'Outlander',
    });
    assert.equal(atv.ok, true);
    assert.equal(atv.basePrice, PRICING.powersports.tiers.atv.maintenance);

    const atvAsMoto = quote({
      cat: 'powersports',
      pkgId: 'maintenance',
      tierKey: 'motorcycle',
      make: 'Can-Am',
      model: 'Outlander',
    });
    assert.equal(atvAsMoto.ok, false);
  });

  it('prices a non-crew Defender on utv_standard and rejects utv_large', () => {
    const standard = quote({
      cat: 'powersports',
      pkgId: 'maintenance',
      tierKey: 'utv_standard',
      make: 'Can-Am',
      model: 'Defender',
    });
    assert.equal(standard.ok, true);
    assert.equal(standard.basePrice, PRICING.powersports.tiers.utv_standard.maintenance);
    const asLarge = quote({
      cat: 'powersports',
      pkgId: 'maintenance',
      tierKey: 'utv_large',
      make: 'Can-Am',
      model: 'Defender',
    });
    assert.equal(asLarge.ok, false);
  });

  it('does not invent a golf-cart public price for a contact-only Club Car', () => {
    const onward = quote({
      cat: 'powersports',
      pkgId: 'maintenance',
      tierKey: 'utv_standard',
      make: 'Club Car',
      model: 'Onward',
    });
    assert.equal(onward.ok, false);
    assert.equal(onward.error, 'vehicle_unresolved');
    assert.equal(onward.basePrice, undefined);
  });

  it('there is no bookable public golf-cart tier in the published catalog', () => {
    assert.equal(PRICING.powersports.tiers.golf_cart, undefined);
    assert.equal(PRICING.powersports.tiers.golfcart, undefined);
    const catalog = require('../assets/powersports-model-catalog');
    const golf = catalog.records.filter((row) => row.physicalFamily === 'golfcart');
    assert.ok(golf.length > 0);
    assert.ok(golf.every((row) => row.publicStatus === 'contact' && !row.serviceClass));
  });

  it('keeps a stored packageSnapshot display price without repricing it', () => {
    const { resolvePackageDetailsForVehicle } = require('../netlify/lib/package-details-resolve');
    const details = resolvePackageDetailsForVehicle({
      cat: 'powersports',
      pkgId: 'maintenance',
      tierKey: 'motorcycle',
      make: 'Yamaha',
      model: 'FJR1300',
      basePrice: 180,
      subtotal: 180,
      packageSnapshot: {
        name: 'Maintenance Detail',
        description: 'Historical motorcycle maintenance booked before class enforcement.',
        price: 180,
        includedServices: ['Wash'],
      },
    });
    assert.equal(details.source, 'snapshot');
    assert.equal(details.packagePrice, 180);
  });

  it('does not treat a Jet Ski as hull-length Marine Wash', () => {
    const longPwc = quote({
      cat: 'boats',
      boatType: 'jetski',
      pkgId: 'maint',
      lengthFt: 30,
    });
    assert.equal(longPwc.ok, true);
    assert.equal(longPwc.basePrice, PRICING.powersports.tiers.jetski.wash);
  });

  it('rejects a non-numeric boat length', () => {
    const invalid = quote({ cat: 'boats', pkgId: 'maint', lengthFt: 'abc' });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error, 'invalid_pricing');
  });

  it('keeps published RV per-foot rates, mins, and type multiplier 1', () => {
    assert.equal(LENGTH_PRICING.rvs.packages.full.ratePerFoot, 32);
    assert.equal(LENGTH_PRICING.rvs.packages.full.base, 350);
    assert.equal(LENGTH_PRICING.rvs.packages.exterior_wash.perFt, 9);
    assert.equal(LENGTH_PRICING.rvs.packages.exterior_wash.min, 199);
    assert.equal(LENGTH_PRICING.rvs.packages.maint.ratePerFoot, 9);
    assert.equal(LENGTH_PRICING.rvs.packages.premium.ratePerFoot, 25);
    const classA = quote({ cat: 'rvs', pkgId: 'full', rvType: 'classA', lengthFt: 24 });
    const travel = quote({ cat: 'rvs', pkgId: 'full', rvType: 'travel', lengthFt: 24 });
    assert.equal(classA.ok, true);
    assert.equal(travel.ok, true);
    assert.equal(classA.basePrice, travel.basePrice);
  });

  it('keeps published car Sequoia and Magnum enforcement', () => {
    const sequoiaCheap = applyServerTravelAndTotal({
      zipCode: '07601',
      totalPrice: 250,
      vehicles: [{
        cat: 'cars', pkgId: 'full', tierKey: 'small', addons: [],
        make: 'Toyota', model: 'Sequoia', year: 2006, vehicleLabel: '2006 Toyota Sequoia',
      }],
    }, { catalogTierMode: 'require_identity' });
    assert.equal(sequoiaCheap.ok, false);

    const magnum = quote({
      cat: 'cars',
      pkgId: 'full',
      tierKey: 'small',
      make: 'Dodge',
      model: 'Magnum',
      year: 2006,
    });
    assert.equal(magnum.ok, true);
    assert.equal(magnum.basePrice, PRICING.cars.tiers.small.full);
  });
});

describe('concurrency, preview, and mutations', () => {
  it('two concurrent quotes with different classes do not leak a cheaper FJR price', async () => {
    const [cheap, correct] = await Promise.all([
      Promise.resolve(quote({
        cat: 'powersports', pkgId: 'maintenance', tierKey: 'motorcycle',
        make: 'Yamaha', model: 'FJR1300',
      })),
      Promise.resolve(quote({
        cat: 'powersports', pkgId: 'maintenance', tierKey: 'motorcycle_large',
        make: 'Yamaha', model: 'FJR1300',
      })),
    ]);
    assert.equal(cheap.ok, false);
    assert.equal(cheap.error, 'tier_mismatch');
    assert.equal(correct.ok, true);
    assert.equal(correct.basePrice, PRICING.powersports.tiers.motorcycle_large.maintenance);
    const again = quote({
      cat: 'powersports', pkgId: 'maintenance', tierKey: 'motorcycle_large',
      make: 'Yamaha', model: 'FJR1300',
    });
    assert.equal(again.basePrice, correct.basePrice);
  });

  it('preview still refuses a booking before catalog pricing', async () => {
    process.env.CONTEXT = 'deploy-preview';
    const fn = require.resolve('../netlify/functions/submit-booking');
    delete require.cache[fn];
    const submit = require(fn);
    submit.__test.setBlobsStoreOverride(null);
    try {
      const res = await submit.handler({
        httpMethod: 'POST',
        headers: { host: 'cardetail1.com', 'x-nf-client-connection-ip': '203.0.113.80' },
        body: JSON.stringify({
          enabled: true,
          totalPrice: 1,
          appointmentDurationMinutes: 15,
          firstName: 'Preview',
          phone: '2015550148',
          zipCode: '07601',
          vehicleCategory: 'powersports',
          vehicles: [{
            cat: 'powersports', pkgId: 'maintenance', tierKey: 'motorcycle',
            make: 'Yamaha', model: 'FJR1300', addons: [],
          }],
        }),
      });
      const body = JSON.parse(res.body);
      assert.equal(res.statusCode, 403);
      assert.equal(body.error, 'preview_booking_disabled');
      assert.equal(body.bookingCreated, false);
    } finally {
      delete process.env.CONTEXT;
      submit.__test.setBlobsStoreOverride(null);
    }
  });

  it('a mismatched known identity does not persist a booking', async () => {
    const fn = require.resolve('../netlify/functions/submit-booking');
    delete require.cache[fn];
    const submit = require(fn);
    const store = {
      data: new Map(),
      async get(key) {
        const value = this.data.get(key);
        return value == null ? null : structuredClone(value);
      },
      async setJSON(key, value) {
        this.data.set(key, structuredClone(value));
        return { modified: true };
      },
      async list() {
        return { blobs: [...this.data.keys()].map((key) => ({ key })) };
      },
    };
    const env = {};
    const keys = ['CONTEXT', 'DRAFT_TOKEN_SECRET', 'ADMIN_EMAIL', 'RESEND_API_KEY', 'TWILIO_SEND_ENABLED', 'STRIPE_SECRET_KEY'];
    for (const key of keys) env[key] = process.env[key];
    const originalFetch = globalThis.fetch;
    process.env.CONTEXT = 'production';
    process.env.DRAFT_TOKEN_SECRET = 'n'.repeat(40);
    process.env.ADMIN_EMAIL = '';
    process.env.RESEND_API_KEY = '';
    process.env.TWILIO_SEND_ENABLED = 'false';
    delete process.env.STRIPE_SECRET_KEY;
    submit.__test.setBlobsStoreOverride(async () => store);
    globalThis.fetch = async () => { throw new Error('unexpected_external_call'); };
    try {
      const res = await submit.handler({
        httpMethod: 'POST',
        headers: { 'x-nf-client-connection-ip': '203.0.113.81' },
        body: JSON.stringify({
          firstName: 'Mismatch',
          lastName: 'Probe',
          phone: '2015550149',
          email: 'mismatch@example.com',
          address: '1 Main St, Newark, NJ',
          zipCode: '07102',
          preferredDate: '2099-08-01',
          preferredTime: '10:00 AM',
          acceptedBookingPolicy: true,
          vehicleCategory: 'powersports',
          vehicles: [{
            cat: 'powersports', pkgId: 'maintenance', tierKey: 'motorcycle',
            make: 'Yamaha', model: 'FJR1300', addons: [],
          }],
        }),
      });
      const body = JSON.parse(res.body);
      assert.equal(res.statusCode, 400);
      assert.equal(body.error, 'tier_mismatch');
      assert.equal(body.bookingCreated, undefined);
      assert.equal(store.data.size, 0);
    } finally {
      globalThis.fetch = originalFetch;
      submit.__test.setBlobsStoreOverride(null);
      for (const key of keys) {
        if (env[key] === undefined) delete process.env[key];
        else process.env[key] = env[key];
      }
    }
  });

  it('published dollar tables, package ids, and add-ons match origin/master', () => {
    const shown = spawnSync('git', ['show', 'origin/master:netlify/lib/booking-price-catalog.js'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(shown.status, 0, shown.stderr);
    function sliceBetween(src, startToken, endToken) {
      const start = src.indexOf(startToken);
      const end = src.indexOf(endToken, start);
      assert.ok(start >= 0 && end > start, startToken);
      return src.slice(start, end);
    }
    const current = fs.readFileSync(path.join(root, 'netlify/lib/booking-price-catalog.js'), 'utf8');
    assert.equal(
      sliceBetween(current, 'const PRICING = {', 'const PACKAGE_INCLUDED_ADDONS'),
      sliceBetween(shown.stdout, 'const PRICING = {', 'const PACKAGE_INCLUDED_ADDONS'),
    );
    assert.equal(
      sliceBetween(current, 'const LENGTH_PRICING = {', 'const RICH_ZIPS'),
      sliceBetween(shown.stdout, 'const LENGTH_PRICING = {', 'const RICH_ZIPS'),
    );
    assert.equal(
      sliceBetween(current, 'const PKG_ID_ALIASES = {', 'function inferPkgId(vehicle, booking)'),
      sliceBetween(shown.stdout, 'const PKG_ID_ALIASES = {', 'function inferPkgId(vehicle, booking)'),
    );
  });

  it('mutations of catalog identity checks go red then restore', () => {
    const catalogPath = path.join(root, 'netlify/lib/booking-price-catalog.js');
    const original = fs.readFileSync(catalogPath, 'utf8');
    function probe(script) {
      return spawnSync(process.execPath, ['-e', script], {
        cwd: root,
        encoding: 'utf8',
        timeout: 15_000,
      });
    }
    try {
      fs.writeFileSync(catalogPath, original.replace(
        'function assertKnownNonCarIdentity(vehicle, cat, tierKey, boatKind) {',
        'function assertKnownNonCarIdentity(vehicle, cat, tierKey, boatKind) {\n  return { ok: true };',
      ));
      const trustBrowser = probe(`
        const assert = require('node:assert/strict');
        const { computeVehicleSubtotal } = require('./netlify/lib/booking-price-catalog');
        const r = computeVehicleSubtotal({
          cat: 'powersports', pkgId: 'maintenance', tierKey: 'motorcycle',
          make: 'Yamaha', model: 'FJR1300', addons: [],
        }, '07102');
        assert.equal(r.ok, false);
        assert.equal(r.error, 'tier_mismatch');
      `);
      assert.notEqual(trustBrowser.status, 0, trustBrowser.stdout + trustBrowser.stderr);

      fs.writeFileSync(catalogPath, original.replace(
        "if (record.physicalFamily === 'boat') {",
        "if (record.physicalFamily === 'boat') {\n    return { ok: true };",
      ));
      const switchAsSki = probe(`
        const assert = require('node:assert/strict');
        const { computeVehicleSubtotal } = require('./netlify/lib/booking-price-catalog');
        const r = computeVehicleSubtotal({
          cat: 'boats', boatType: 'jetski', pkgId: 'maint',
          make: 'Sea-Doo', model: 'Switch', lengthFt: 22, addons: [],
        }, '07102');
        assert.equal(r.ok, false);
        assert.equal(r.error, 'tier_mismatch');
      `);
      assert.notEqual(switchAsSki.status, 0, switchAsSki.stdout + switchAsSki.stderr);

      fs.writeFileSync(catalogPath, original.replace(
        "if (cat === 'powersports' && tierKey === record.serviceClass) return { ok: true };",
        "if (cat === 'powersports') return { ok: true };",
      ));
      const cheaperClass = probe(`
        const assert = require('node:assert/strict');
        const { computeVehicleSubtotal } = require('./netlify/lib/booking-price-catalog');
        const r = computeVehicleSubtotal({
          cat: 'powersports', pkgId: 'maintenance', tierKey: 'motorcycle',
          make: 'Yamaha', model: 'FJR1300', addons: [],
        }, '07102');
        assert.equal(r.ok, false);
      `);
      assert.notEqual(cheaperClass.status, 0, cheaperClass.stdout + cheaperClass.stderr);

      fs.writeFileSync(catalogPath, original.replace(
        'if (!record) return { ok: true };',
        "if (!record) return { ok: true };\n  if (record.publicStatus === 'contact') return { ok: true };",
      ));
      const onwardPriced = probe(`
        const assert = require('node:assert/strict');
        const { computeVehicleSubtotal } = require('./netlify/lib/booking-price-catalog');
        const r = computeVehicleSubtotal({
          cat: 'powersports', pkgId: 'maintenance', tierKey: 'motorcycle',
          make: 'Club Car', model: 'Onward', addons: [],
        }, '07102');
        assert.equal(r.ok, false);
        assert.equal(r.error, 'vehicle_unresolved');
      `);
      assert.notEqual(onwardPriced.status, 0, onwardPriced.stdout + onwardPriced.stderr);

      fs.writeFileSync(catalogPath, original.replace(
        'return { ok: false, error: \'tier_mismatch\' };',
        'return { ok: true };',
      ));
      const ignoreCategory = probe(`
        const assert = require('node:assert/strict');
        const { computeVehicleSubtotal } = require('./netlify/lib/booking-price-catalog');
        const r = computeVehicleSubtotal({
          cat: 'trucks', pkgId: 'interior', tierKey: 'day_cab',
          make: 'Yamaha', model: 'FJR1300', addons: [],
        }, '07102');
        assert.equal(r.ok, false);
        assert.equal(r.error, 'tier_mismatch');
      `);
      assert.notEqual(ignoreCategory.status, 0, ignoreCategory.stdout + ignoreCategory.stderr);
    } finally {
      fs.writeFileSync(catalogPath, original);
    }

    const travelPath = path.join(root, 'netlify/lib/travel-fee.js');
    const travelOriginal = fs.readFileSync(travelPath, 'utf8');
    try {
      fs.writeFileSync(travelPath, travelOriginal.replace(
        'if (!opts.skipMismatchCheck && clientTotal > 0 && Math.abs(clientTotal - serverTotal) > 1)',
        'if (false && !opts.skipMismatchCheck && clientTotal > 0 && Math.abs(clientTotal - serverTotal) > 1)',
      ));
      const acceptClientTotal = probe(`
        const assert = require('node:assert/strict');
        const { applyServerTravelAndTotal } = require('./netlify/lib/travel-fee');
        const r = applyServerTravelAndTotal({
          zipCode: '07102',
          vehicleCategory: 'trucks',
          vehicles: [{ cat: 'trucks', pkgId: 'interior', tierKey: 'day_cab', addons: [] }],
          totalPrice: 1,
        }, { catalogTierMode: 'require_identity' });
        assert.equal(r.ok, false);
        assert.equal(r.error, 'price_mismatch');
      `);
      assert.notEqual(acceptClientTotal.status, 0, acceptClientTotal.stdout + acceptClientTotal.stderr);
    } finally {
      fs.writeFileSync(travelPath, travelOriginal);
    }
  });
});
