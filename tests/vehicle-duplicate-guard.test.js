/**
 * Semantic duplicate guard for vehicle_add + Admin listJobs logical-id dedupe.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

describe('vehicle_add semantic duplicate guard', () => {
  it('rejects a second boat with the same length + package', () => {
    const { applyVehicleOperation } = require('../netlify/lib/vehicle-financial-mutation');
    const service = {
      vehicles: [{
        vehicleId: 'v1',
        category: 'boats',
        cat: 'boats',
        year: '2023',
        make: 'Yamaha',
        model: '222S',
        lengthFt: 22,
        packageId: 'full_basic',
        packageName: 'Full Detail',
      }],
    };
    const first = applyVehicleOperation(service, {
      op: 'add',
      vehicle: {
        category: 'boats',
        year: '2024',
        make: 'Other',
        model: 'Boat',
        lengthFt: 22,
        packageId: 'full_basic',
        packageName: 'Full Detail',
      },
    });
    assert.equal(first.ok, false);
    assert.equal(first.error, 'duplicate_vehicle');
    assert.equal(first.statusCode, 409);
  });

  it('allows a boat with different length or package', () => {
    const { applyVehicleOperation } = require('../netlify/lib/vehicle-financial-mutation');
    const service = {
      vehicles: [{
        vehicleId: 'v1',
        category: 'boats',
        year: '2023',
        make: 'Yamaha',
        model: '222S',
        lengthFt: 22,
        packageId: 'full_basic',
      }],
    };
    const longer = applyVehicleOperation(service, {
      op: 'add',
      vehicle: {
        category: 'boats',
        year: '2023',
        make: 'Yamaha',
        model: '242',
        lengthFt: 24,
        packageId: 'full_basic',
      },
    });
    assert.equal(longer.ok, true);
    assert.equal(longer.service.vehicles.length, 2);

    const otherPkg = applyVehicleOperation(service, {
      op: 'add',
      vehicle: {
        category: 'boats',
        year: '2023',
        make: 'Yamaha',
        model: '222S',
        lengthFt: 22,
        packageId: 'interior',
      },
    });
    assert.equal(otherPkg.ok, true);
  });

  it('rejects a second car with same year/make/model + package', () => {
    const { applyVehicleOperation } = require('../netlify/lib/vehicle-financial-mutation');
    const service = {
      vehicles: [{
        vehicleId: 'v1',
        category: 'cars',
        year: '2021',
        make: 'Cadillac',
        model: 'Escalade',
        packageId: 'full',
        tierKey: 'suv3',
      }],
    };
    const dup = applyVehicleOperation(service, {
      op: 'add',
      vehicle: {
        category: 'cars',
        year: '2021',
        make: 'Cadillac',
        model: 'Escalade',
        packageId: 'full',
        tierKey: 'suv3',
      },
    });
    assert.equal(dup.ok, false);
    assert.equal(dup.error, 'duplicate_vehicle');
  });
});

describe('admin listJobs logical-id dedupe', () => {
  it('listJobs collapses twin Blob keys that share payload.id', () => {
    const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/admin-ops-jobs.js'), 'utf8');
    const listStart = src.indexOf('async function listJobs');
    assert.ok(listStart >= 0);
    const listEnd = src.indexOf('\nasync function persistMutation', listStart);
    const body = src.slice(listStart, listEnd > 0 ? listEnd : listStart + 8000);
    assert.match(body, /byLogicalId/);
    assert.match(body, /_dedupedBlobKeys/);
    assert.match(body, /Collapse twin Blob keys/);
  });

  it('my-garage keeps vehicle_add idempotency key after success', () => {
    const src = fs.readFileSync(path.join(ROOT, 'assets/my-garage.js'), 'utf8');
    assert.match(src, /action !== 'vehicle_add_request'/);
    assert.match(src, /duplicate_vehicle/);
  });
});
