const test = require('node:test');
const assert = require('node:assert/strict');
const {
  travelFeeFromMiles,
  resolveTravelForZip,
  TRAVEL_MAX_MILES,
} = require('../netlify/lib/travel-fee');

test('travel fee tier boundaries', () => {
  assert.equal(travelFeeFromMiles(0), 0);
  assert.equal(travelFeeFromMiles(30), 0);
  assert.equal(travelFeeFromMiles(31), 15);
  assert.equal(travelFeeFromMiles(50), 15);
  assert.equal(travelFeeFromMiles(51), 25);
  assert.equal(travelFeeFromMiles(65), 25);
  assert.equal(travelFeeFromMiles(66), 35);
  assert.equal(travelFeeFromMiles(85), 35);
  assert.equal(travelFeeFromMiles(86), 40);
  assert.equal(travelFeeFromMiles(100), 40);
  assert.equal(travelFeeFromMiles(101), 55);
  assert.equal(travelFeeFromMiles(150), 55);
  assert.equal(travelFeeFromMiles(151), null);
});

test('resolveTravelForZip covers core and extended zips', () => {
  const local = resolveTravelForZip('07601');
  assert.ok(local);
  assert.equal(local.fee, 0);
  assert.ok(local.miles <= 30);

  const mid = resolveTravelForZip('10501');
  assert.ok(mid);
  assert.equal(mid.fee, 15);

  const far = resolveTravelForZip('12401');
  assert.ok(far);
  assert.equal(far.fee, 55);
  assert.ok(far.miles <= TRAVEL_MAX_MILES);
});

test('out of range zip returns null', () => {
  assert.equal(resolveTravelForZip('90210'), null);
  assert.equal(resolveTravelForZip('123'), null);
});
