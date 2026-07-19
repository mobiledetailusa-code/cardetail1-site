/**
 * Auto-apply customer changes + trailer→SUV pricing coercion.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

function createMemoryStore(seed = {}) {
  const data = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const etags = new Map();
  for (const [k] of data) etags.set(k, `etag-${k}-0`);
  return {
    async get(key) {
      if (!data.has(key)) return null;
      return JSON.parse(JSON.stringify(data.get(key)));
    },
    async getWithMetadata(key) {
      if (!data.has(key)) return null;
      return { data: JSON.parse(JSON.stringify(data.get(key))), etag: etags.get(key) || null };
    },
    async setJSON(key, value, opts = {}) {
      if (opts.onlyIfMatch) {
        const current = etags.get(key);
        if (!current || current !== opts.onlyIfMatch) return { modified: false };
      }
      data.set(key, JSON.parse(JSON.stringify(value)));
      etags.set(key, `etag-${key}-${Date.now()}-${Math.random()}`);
      return { modified: true };
    },
    async list() {
      return { blobs: [...data.keys()].map((key) => ({ key })) };
    },
  };
}

describe('portal auto-apply + vehicle coerce', () => {
  let setBookingStoreOverride;

  beforeEach(() => {
    ({ setBookingStoreOverride } = require('../netlify/lib/booking-repository'));
  });

  afterEach(() => {
    setBookingStoreOverride(null);
  });

  it('coerceVehicleForCategory maps RV leftovers to car tier/package', () => {
    const { coerceVehicleForCategory } = require('../netlify/lib/booking-price-catalog');
    const coerced = coerceVehicleForCategory({
      category: 'rvs',
      packageId: 'full_basic',
      tierKey: 'travel',
      lengthFt: 28,
      addOnIds: ['odor', 'chrome'],
      addons: [{ id: 'odor' }, { id: 'chrome' }],
    }, 'cars', { tierKey: 'suv2', packageId: 'full' });
    assert.equal(coerced.cat, 'cars');
    assert.equal(coerced.packageId, 'full');
    assert.equal(coerced.tierKey, 'suv2');
    assert.equal(coerced.lengthFt, 0);
    assert.deepEqual(coerced.addOnIds, ['odor']); // chrome is boat/RV-only
  });

  it('approve trailer→SUV replace prices without invalid_pricing', async () => {
    const {
      submitChangeRequestCommand,
      decideChangeRequestCommand,
    } = require('../netlify/lib/booking-commands');
    const { getBookingRecord } = require('../netlify/lib/booking-repository');

    const store = createMemoryStore({
      'CD1-TRAILER': {
        id: 'CD1-TRAILER',
        bookingVersion: 2,
        quoteVersion: 1,
        status: 'Confirmed',
        appointmentStatus: 'confirmed',
        jobStatus: 'confirmed',
        zipCode: '07102',
        travelFeeAmount: 0,
        ledger: { approvedCents: 90000, settledCents: 0, creditedCents: 0, entries: [] },
        vehicles: [{
          vehicleId: 'veh_1',
          category: 'rvs',
          cat: 'rvs',
          packageId: 'full_basic',
          pkgId: 'full_basic',
          lengthFt: 24,
          rvType: 'travel',
          tierKey: 'travel',
          addOnIds: [],
          addons: [],
        }],
        changeRequests: [],
      },
    });
    setBookingStoreOverride(store);

    const submitted = await submitChangeRequestCommand({
      bookingId: 'CD1-TRAILER',
      expectedBookingVersion: 2,
      requestType: 'vehicle_replace_request',
      target: { vehicleId: 'veh_1' },
      delta: {
        category: 'cars',
        vehicleCategory: 'cars',
        year: '2022',
        make: 'Toyota',
        model: 'Highlander',
        vehicleLabel: '2022 Toyota Highlander',
        packageId: 'full',
        packageName: 'Full Detail',
        tierKey: 'suv2',
      },
    });
    assert.equal(submitted.ok, true, submitted.error);

    const decided = await decideChangeRequestCommand({
      bookingId: 'CD1-TRAILER',
      requestId: submitted.changeRequest.requestId,
      decision: 'approve',
      expectedBookingVersion: submitted.booking.bookingVersion,
      acceptRequote: true,
    });
    assert.equal(decided.ok, true, `${decided.error} ${decided.message || ''}`);
    const final = await getBookingRecord('CD1-TRAILER');
    assert.equal(final.booking.vehicleCategory, 'cars');
    assert.ok(Number(final.booking.ledger.approvedCents) > 0);
    assert.notEqual(decided.error, 'invalid_pricing');
  });

  it('addon submit+decide updates ledger approvedCents', async () => {
    const {
      submitChangeRequestCommand,
      decideChangeRequestCommand,
    } = require('../netlify/lib/booking-commands');
    const { getBookingRecord } = require('../netlify/lib/booking-repository');

    const store = createMemoryStore({
      'CD1-ADD': {
        id: 'CD1-ADD',
        bookingVersion: 1,
        quoteVersion: 1,
        status: 'Confirmed',
        appointmentStatus: 'confirmed',
        jobStatus: 'confirmed',
        zipCode: '07102',
        travelFeeAmount: 0,
        ledger: { approvedCents: 31500, settledCents: 0, creditedCents: 0, entries: [] },
        vehicles: [{
          vehicleId: 'veh_1',
          category: 'cars',
          cat: 'cars',
          tierKey: 'suv3',
          packageId: 'full',
          addOnIds: [],
          addons: [],
        }],
        changeRequests: [],
      },
    });
    setBookingStoreOverride(store);

    const submitted = await submitChangeRequestCommand({
      bookingId: 'CD1-ADD',
      expectedBookingVersion: 1,
      requestType: 'addon_request',
      target: { vehicleId: 'veh_1' },
      delta: { addOnIdsToAdd: ['odor'], addonIds: ['odor'] },
    });
    assert.equal(submitted.ok, true);

    const decided = await decideChangeRequestCommand({
      bookingId: 'CD1-ADD',
      requestId: submitted.changeRequest.requestId,
      decision: 'approve',
      expectedBookingVersion: submitted.booking.bookingVersion,
    });
    assert.equal(decided.ok, true, decided.error);
    const final = await getBookingRecord('CD1-ADD');
    assert.ok(Number(final.booking.ledger.approvedCents) > 31500);
    assert.equal(Number(final.booking.approvedFinalAmount) > 315, true);
  });
});
