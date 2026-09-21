/**
 * Powersports legacy package-ID financial safety after the +15% catalog uplift.
 *
 * Public bookable packages are maintenance / restore only.
 * Historical wash / essential / full / premium keys remain in the catalog so
 * old bookings keep a resolvable package id — but stored ledger / quote /
 * approvedFinalAmount authority must never be silently replaced by the
 * uplifted catalog amount for that key.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  PRICING,
  computeVehicleSubtotal,
} = require('../netlify/lib/booking-price-catalog');
const { financialProjection } = require('../netlify/lib/payment-service');
const PowersportsCatalog = require('../assets/powersports-model-catalog');

const PUBLIC_KEYS = ['maintenance', 'restore'];
const LEGACY_KEYS = ['wash', 'essential', 'full', 'premium'];

describe('Powersports public vs legacy package surface', () => {
  it('public bookable classes expose only maintenance / restore to new customers', () => {
    for (const classKey of Object.keys(PowersportsCatalog.serviceClasses)) {
      if (!PowersportsCatalog.isPublicBookableServiceClass(classKey)) continue;
      const tier = PRICING.powersports.tiers[classKey];
      assert.ok(tier, `missing tier ${classKey}`);
      for (const key of PUBLIC_KEYS) {
        assert.ok(Number(tier[key]) > 0, `${classKey}.${key} must be priced`);
      }
    }
    // Homepage / specialty public matrix (canonical after +15%)
    assert.equal(PRICING.powersports.tiers.motorcycle.maintenance, 180);
    assert.equal(PRICING.powersports.tiers.motorcycle.restore, 235);
    assert.equal(PRICING.powersports.tiers.motorcycle_large.maintenance, 200);
    assert.equal(PRICING.powersports.tiers.motorcycle_large.restore, 290);
    assert.equal(PRICING.powersports.tiers.motorcycle_trike.maintenance, 205);
    assert.equal(PRICING.powersports.tiers.motorcycle_trike.restore, 285);
    assert.equal(PRICING.powersports.tiers.atv.maintenance, 180);
    assert.equal(PRICING.powersports.tiers.atv.restore, 220);
    assert.equal(PRICING.powersports.tiers.utv_standard.maintenance, 200);
    assert.equal(PRICING.powersports.tiers.utv_standard.restore, 250);
    assert.equal(PRICING.powersports.tiers.utv_large.maintenance, 205);
    assert.equal(PRICING.powersports.tiers.utv_large.restore, 285);
  });

  it('catalog still retains historical wash/essential/full/premium keys', () => {
    const moto = PRICING.powersports.tiers.motorcycle;
    for (const key of LEGACY_KEYS) {
      assert.ok(Object.prototype.hasOwnProperty.call(moto, key), `missing legacy key ${key}`);
      assert.ok(Number(moto[key]) > 0, `legacy ${key} must keep a dollar meaning`);
    }
    // Uplifted historical-key amounts (must NOT be applied to stored bookings)
    assert.equal(moto.wash, 105);
    assert.equal(moto.essential, 165);
    assert.equal(moto.full, 235);
    assert.equal(moto.premium, 325);
  });
});

describe('Powersports legacy booking financial authority', () => {
  function legacyWashBooking(overrides = {}) {
    // Pre-uplift stored wash booking: customer paid / owed the historical $100,
    // not the current catalog wash $105.
    const approvedCents = 10000;
    return {
      id: 'PS-LEGACY-WASH-1',
      status: 'Confirmed',
      paymentStatus: 'due',
      totalPrice: 100,
      approvedFinalAmount: 100,
      amountDueApproved: 100,
      zipCode: '07650',
      ledger: {
        approvedCents,
        settledCents: 0,
        creditedCents: 0,
        entries: [],
      },
      quote: {
        quoteVersion: 1,
        approvedCents,
        currency: 'usd',
        lineItems: [
          {
            kind: 'package',
            packageId: 'wash',
            label: 'Wash & Shine',
            amountCents: approvedCents,
          },
        ],
      },
      service: {
        vehicles: [{
          vehicleId: 'veh_ps_1',
          cat: 'powersports',
          category: 'powersports',
          tierKey: 'motorcycle',
          packageId: 'wash',
          pkgId: 'wash',
          pkgName: 'Wash & Shine',
          basePrice: 100,
          addOnIds: [],
          addons: [],
        }],
      },
      ...overrides,
    };
  }

  it('financialProjection keeps stored $100 — does not jump to catalog wash $105', () => {
    const booking = legacyWashBooking();
    const catalogWash = PRICING.powersports.tiers.motorcycle.wash;
    assert.equal(catalogWash, 105, 'catalog wash is uplifted');
    assert.notEqual(catalogWash * 100, booking.ledger.approvedCents);

    const proj = financialProjection(booking);
    assert.equal(proj.approvedCents, 10000);
    assert.equal(proj.remainingCents, 10000);
    assert.equal(proj.settledCents, 0);
    assert.notEqual(proj.approvedCents, catalogWash * 100);
  });

  it('partially paid legacy wash remaining derives from ledger, not catalog', () => {
    const booking = legacyWashBooking({
      ledger: {
        approvedCents: 10000,
        settledCents: 4000,
        creditedCents: 0,
        entries: [{
          kind: 'settlement',
          amountCents: 4000,
          providerObjectId: 'pi_legacy_wash',
          recordedAt: new Date().toISOString(),
        }],
      },
      paymentStatus: 'due',
    });
    const proj = financialProjection(booking);
    assert.equal(proj.approvedCents, 10000);
    assert.equal(proj.settledCents, 4000);
    assert.equal(proj.remainingCents, 6000);
    assert.notEqual(proj.remainingCents, PRICING.powersports.tiers.motorcycle.wash * 100);
  });

  it('live catalog lookup for wash returns uplifted amount (new quotes only)', () => {
    const live = computeVehicleSubtotal({
      cat: 'powersports',
      pkgId: 'wash',
      tierKey: 'motorcycle',
      addons: [],
    }, '07650');
    assert.equal(live.ok, true);
    assert.equal(live.basePrice, 105);
    assert.equal(live.subtotal, 105);
  });

  it('new public maintenance quote uses current matrix, not legacy wash', () => {
    const live = computeVehicleSubtotal({
      cat: 'powersports',
      pkgId: 'maintenance',
      tierKey: 'motorcycle',
      addons: [],
    }, '07650');
    assert.equal(live.ok, true);
    assert.equal(live.basePrice, 180);
    assert.equal(live.subtotal, 180);
  });
});
