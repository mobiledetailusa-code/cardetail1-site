const test = require('node:test');
const assert = require('node:assert/strict');
const { calcBidMax, bidWindowForJob, DEFAULT_SETTINGS } = require('../netlify/lib/ops-config');
const { suggestEquipmentForJob } = require('../netlify/lib/ops-workflow');

test('calcBidMax uses percent or override', () => {
  assert.equal(calcBidMax(200, { bidMaxPercent: 85, bidMaxOverride: null }), 170);
  assert.equal(calcBidMax(200, { bidMaxPercent: 85, bidMaxOverride: 150 }), 150);
});

test('bid window longer for boat/rv jobs', () => {
  const settings = { ...DEFAULT_SETTINGS, bidWindowMinutes: 60, bidWindowMinutesBoatRv: 90 };
  assert.equal(bidWindowForJob({ package: 'Full Detail', vehicle: 'Sedan' }, settings), 60);
  assert.equal(bidWindowForJob({ package: 'Boat Detail', vehicle: 'Yacht' }, settings), 90);
});

test('suggestEquipmentForJob returns compound tools for correction', () => {
  const hints = suggestEquipmentForJob({ package: 'Paint correction compound' });
  assert.ok(hints.some(h => /polisher|compound/i.test(h)));
});
