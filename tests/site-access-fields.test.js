const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const bookingPages = [
  'index.html',
  'bergen-county-hub.html', 'hudson-county-hub.html', 'essex-county-hub.html',
  'passaic-county-hub.html', 'ny-metro-hub.html', 'connecticut-hub.html',
  'pennsylvania-hub.html', 'new-jersey-hub.html', 'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html', 'westchester-mobile-detailing.html', 'template-city.html',
];

const required = [
  'id="f-water"',
  'id="f-electric"',
  'id="f-location"',
  'id="f-access-notes"',
  'readSiteAccessFields',
  'waterAvailable',
  'electricityAvailable',
  'serviceLocation',
  'accessNotes',
  'water spigot/hose access available',
  'Garage / parking deck',
  'Gate code, parking instructions',
];

for (const page of bookingPages) {
  test(`${page} includes site access fields in Step 4`, () => {
    const html = read(page);
    for (const s of required) assert.match(html, new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
}

test('submit-booking email text includes site access fields', () => {
  const js = read('netlify/functions/submit-booking.js');
  assert.match(js, /waterAvailable/);
  assert.match(js, /electricityAvailable/);
  assert.match(js, /serviceLocation/);
  assert.match(js, /accessNotes/);
  assert.match(js, /formatSiteAccessLines/);
});

const { formatSiteAccessLines, techEquipmentHintsForSiteAccess } = require('../netlify/lib/site-access');
const { projectJobForTech } = require('../netlify/lib/ops-workflow');
const { projectBookingForCustomer } = require('../netlify/lib/ops-schema');

test('formatSiteAccessLines renders booking site access', () => {
  const lines = formatSiteAccessLines({
    waterAvailable: 'yes',
    electricityAvailable: 'no',
    serviceLocation: 'driveway',
    accessNotes: 'Gate code 1234',
  });
  assert.match(lines.join('\n'), /Water:.*spigot/i);
  assert.match(lines.join('\n'), /Electricity:.*No electricity/i);
  assert.match(lines.join('\n'), /Service location: Driveway/);
  assert.match(lines.join('\n'), /Access notes: Gate code 1234/);
});

test('projectJobForTech exposes site access for technician portal', () => {
  const j = projectJobForTech({
    id: 'CD1-X',
    firstName: 'Jane',
    waterAvailable: 'unsure',
    electricityAvailable: 'yes',
    serviceLocation: 'garage',
    accessNotes: 'Level P2',
  });
  assert.equal(j.waterAvailable, 'unsure');
  assert.equal(j.electricityAvailable, 'yes');
  assert.equal(j.serviceLocation, 'garage');
  assert.equal(j.accessNotes, 'Level P2');
  assert.ok(j.equipmentHints.some(h => /water/i.test(h) || /power/i.test(h) || /Microfiber/i.test(h)));
});

test('techEquipmentHintsForSiteAccess adds water/power hints', () => {
  const hints = techEquipmentHintsForSiteAccess({ waterAvailable: 'no', electricityAvailable: 'no' });
  assert.ok(hints.some(h => /water/i.test(h)));
  assert.ok(hints.some(h => /power/i.test(h)));
});

test('projectBookingForCustomer exposes site access fields', () => {
  const p = projectBookingForCustomer({
    id: 'CD1-Y',
    waterAvailable: 'yes',
    electricityAvailable: 'unsure',
    serviceLocation: 'street',
    accessNotes: 'Metered parking',
  });
  assert.equal(p.waterAvailable, 'yes');
  assert.equal(p.serviceLocation, 'street');
  assert.equal(p.accessNotes, 'Metered parking');
});

test('admin-ops and technician portals display site access', () => {
  assert.match(read('admin-ops.html'), /site-access-client\.js/);
  assert.match(read('admin-ops.html'), /SiteAccess\.adminSection/);
  assert.match(read('technician.html'), /site-access-client\.js/);
  assert.match(read('technician.html'), /SiteAccess\.techCells/);
});
