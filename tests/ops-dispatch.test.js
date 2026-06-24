const test = require('node:test');
const assert = require('node:assert/strict');
const { calcBidMax, bidWindowForJob, DEFAULT_SETTINGS, matchServicePackage } = require('../netlify/lib/ops-config');
const { suggestEquipmentForJob, projectJobForTech, resolvePackageInfo } = require('../netlify/lib/ops-workflow');

test('DEFAULT_SETTINGS bidMaxPercent is 62', () => {
  assert.equal(DEFAULT_SETTINGS.bidMaxPercent, 62);
});

test('calcBidMax uses percent or override', () => {
  assert.equal(calcBidMax(200, { bidMaxPercent: 62, bidMaxOverride: null }), 124);
  assert.equal(calcBidMax(200, { bidMaxPercent: 62, bidMaxOverride: 150 }), 150);
  assert.equal(calcBidMax(200, { bidMaxOverride: null }), 124);
});

test('bid window longer for boat/rv jobs', () => {
  const settings = { ...DEFAULT_SETTINGS, bidWindowMinutes: 60, bidWindowMinutesBoatRv: 90 };
  assert.equal(bidWindowForJob({ package: 'Full Detail', vehicle: 'Sedan' }, settings), 60);
  assert.equal(bidWindowForJob({ package: 'Boat Detail', vehicle: 'Yacht' }, settings), 90);
});

test('matchServicePackage resolves common pack names', () => {
  assert.equal(matchServicePackage('Maintenance Detail').name, 'Maintenance Detail');
  assert.equal(matchServicePackage('Full Detail').name, 'Premium Detail');
  assert.equal(matchServicePackage('Paint Correction / Enhancement').name, 'Paint Correction');
});

test('suggestEquipmentForJob returns pack-specific tools', () => {
  const maint = suggestEquipmentForJob({ package: 'Maintenance Detail', vehicle: 'Sedan' });
  assert.ok(maint.some(h => /pressure washer|microfiber/i.test(h)));

  const compound = suggestEquipmentForJob({ package: 'Paint Correction', vehicle: 'Sedan' });
  assert.ok(compound.some(h => /polisher|compound/i.test(h)));
});

test('projectJobForTech includes packageDescription and equipmentHints', () => {
  const job = projectJobForTech({
    id: 'CD1-1',
    firstName: 'Alex',
    package: 'Maintenance Detail',
    vehicleLabel: '2020 Honda Civic',
    jobStatus: 'assigned',
  });
  assert.equal(job.package, 'Maintenance Detail');
  assert.ok(job.packageDescription);
  assert.ok(Array.isArray(job.equipmentHints) && job.equipmentHints.length > 0);
});

test('resolvePackageInfo returns description for known packs', () => {
  const info = resolvePackageInfo({ package: 'Interior Detail' });
  assert.match(info.packageDescription, /vacuum|shampoo/i);
});
