'use strict';

/**
 * Cars optional trim/edition is label-only and never changes pricing class.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const Summary = require('../assets/booking-vehicle-summary.js');

const BOOKING_PAGES = [
  'index.html',
  'bergen-county-hub.html',
  'hudson-county-hub.html',
  'essex-county-hub.html',
  'passaic-county-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
  'new-jersey-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'template-city.html',
];

test('formatCarsVehicleLabel appends optional trim after year/make/model', () => {
  assert.equal(
    Summary.formatCarsVehicleLabel(2019, 'Ford', 'Explorer', 'Interceptor Special Edition'),
    '2019 Ford Explorer · Interceptor Special Edition'
  );
  assert.equal(
    Summary.formatCarsVehicleLabel(2025, 'Lamborghini', 'Urus', 'Anniversary'),
    '2025 Lamborghini Urus · Anniversary'
  );
  assert.equal(
    Summary.formatCarsVehicleLabel(2021, 'Cadillac', 'Escalade', ''),
    '2021 Cadillac Escalade'
  );
  assert.equal(
    Summary.formatCarsVehicleLabel(2021, 'Cadillac', 'Escalade', '  Platinum Edition  '),
    '2021 Cadillac Escalade · Platinum Edition'
  );
});

test('clearCategoryExclusiveFields clears trim', () => {
  const st = {
    make: 'Ford',
    model: 'Explorer',
    year: '2019',
    trim: 'Special Edition',
    vehicleLabel: '2019 Ford Explorer · Special Edition',
    displayLabel: '3-Row SUV',
    tierKey: 'suv3',
    tier: { label: '3-Row SUV' },
    basePrice: 270,
  };
  Summary.clearCategoryExclusiveFields(st, 'boats');
  assert.equal(st.trim, '');
  assert.equal(st.make, '');
  assert.equal(st.vehicleLabel, '');
});

test('every booking page wires optional trim/edition for cars', () => {
  for (const page of BOOKING_PAGES) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    assert.match(html, /id="trim-in"/, `${page} missing trim input`);
    assert.match(html, /function buildCarsVehicleLabel/, `${page} missing label helper`);
    assert.match(html, /ST\.vehicleLabel=buildCarsVehicleLabel\(\)/, `${page} year-sel not using trim helper`);
    assert.match(html, /bindCarsTrimInput/, `${page} missing trim input binder`);
    assert.match(html, /vehicleTrim:\s*ST\.trim/, `${page} cart item missing vehicleTrim`);
    // Pricing path still uses catalog class — trim must not appear in resolveVehicleClassification call args as a pricing key.
    const yearStart = html.indexOf("getElementById('year-sel').addEventListener('change'");
    assert.ok(yearStart > 0, `${page} missing year-sel`);
    const chunk = html.slice(yearStart, yearStart + 2800);
    assert.match(chunk, /resolveVehicleClassification\(\{make:ST\.make,model:ST\.model,year:ST\.year/);
    assert.doesNotMatch(chunk, /resolveVehicleClassification\([^\)]*trim/);
  }
});
