'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('cars booking has no Trim/Edition field on any booking surface', () => {
  const pages = fs.readdirSync(root)
    .filter((file) => file.endsWith('.html'))
    .filter((file) => read(file).includes('id="bk-ov"'));

  assert.equal(pages.length, 13, 'expected all 13 booking surfaces');
  for (const page of pages) {
    const html = read(page);
    assert.doesNotMatch(html, /id="trim-in"/, `${page} still has #trim-in`);
    assert.doesNotMatch(html, /Trim \/ Edition/, `${page} still labels Trim / Edition`);
  }

  const helper = read('assets/booking-vehicle-summary.js');
  assert.doesNotMatch(helper, /formatCarsVehicleLabel/);
  assert.doesNotMatch(helper, /st\.trim\s*=/);

  const index = read('index.html');
  assert.match(index, /ST\.vehicleLabel=`\$\{ST\.year\} \$\{ST\.make\} \$\{ST\.model\}`/);
  assert.doesNotMatch(index, /formatCarsVehicleLabel/);
});
