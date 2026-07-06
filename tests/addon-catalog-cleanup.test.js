// Add-on catalog cleanup regression tests (production add-ons pass).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const { PRICING, computeVehicleSubtotal } = require('../netlify/lib/booking-price-catalog');

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

const MECH_RE = /\b(repair|lubricat|chain adjustment|oil change|brake service|drivetrain|electrical inspection|mechanical inspection|engine repair)\b/i;

function extractPowersportsAddons(html) {
  const m = html.match(/powersports:\s*\{[\s\S]*?addons:\[([\s\S]*?)\],\s*\n\s*\},/);
  assert.ok(m, 'powersports addons block');
  return m[1];
}

test('Mold Treatment appears in cars catalog with icon and estimate copy', () => {
  const s = read('index.html');
  assert.match(s, /id:'mold'[^}]*icon:'🦠'/);
  assert.match(s, /id:'mold'[^}]*price:149/);
  assert.match(s, /id:'mold'[^}]*estimate confirmation/i);
  const def = PRICING.cars.addons.find((a) => a.id === 'mold');
  assert.equal(def.price, 149);
});

test('Interior Sanitizing appears in cars catalog with icon and price', () => {
  const s = read('index.html');
  assert.match(s, /id:'sanitize'[^}]*name:'Interior Sanitizing'/);
  assert.match(s, /id:'sanitize'[^}]*icon:'🛡️'/);
  assert.match(s, /id:'sanitize'[^}]*price:65/);
  const def = PRICING.cars.addons.find((a) => a.id === 'sanitize');
  assert.equal(def.price, 65);
});

test('Odor Treatment price is $90 in client and server catalogs', () => {
  const s = read('index.html');
  assert.match(s, /id:'odor'[^}]*name:'Odor Treatment & Sanitize'[^}]*price:90/);
  const odor = PRICING.cars.addons.find((a) => a.id === 'odor');
  assert.equal(odor.price, 90);
  const rvOdor = PRICING.rvs.addons.find((a) => a.id === 'odor');
  assert.equal(rvOdor.price, 90);
});

test('RV roof and awning are $50 each with quantity support', () => {
  const roof = PRICING.rvs.addons.find((a) => a.id === 'roof');
  const awning = PRICING.rvs.addons.find((a) => a.id === 'awning');
  assert.equal(roof.price, 50);
  assert.equal(awning.price, 50);
  assert.equal(roof.qty, true);
  assert.equal(awning.qty, true);
  const s = read('index.html');
  assert.match(s, /id:'roof'[^}]*price:50[^}]*qty:true/);
  assert.match(s, /id:'awning'[^}]*price:50[^}]*qty:true/);
});

test('powersports add-ons have no mechanical-service language', () => {
  for (const f of BOOKING_PAGES) {
    const block = extractPowersportsAddons(read(f));
    assert.ok(!block.includes("id:'chain'"), `${f} still has chain add-on`);
    assert.ok(!block.includes('Chain & Sprocket'), `${f} still has chain add-on name`);
    assert.ok(!MECH_RE.test(block), `${f} powersports addons contain mechanical language`);
  }
});

test('addon quantity and totals still compute correctly', () => {
  const mats = computeVehicleSubtotal({
    cat: 'cars',
    pkgId: 'maint',
    tierKey: 'small',
    addons: [{ id: 'floormats', qty: 3 }],
  }, '07601');
  assert.equal(mats.addonTotal, 60);

  const rvRoof = computeVehicleSubtotal({
    cat: 'rvs',
    pkgId: 'full',
    tierKey: 'travel',
    lengthFt: 24,
    addons: [{ id: 'roof', qty: 2 }, { id: 'awning', qty: 1 }],
  }, '07601');
  assert.equal(rvRoof.ok, true);
  assert.equal(rvRoof.addonTotal, 150);

  const combo = computeVehicleSubtotal({
    cat: 'cars',
    pkgId: 'interior',
    tierKey: 'small',
    addons: [{ id: 'odor' }, { id: 'sanitize' }, { id: 'mold' }],
  }, '07601');
  assert.equal(combo.addonTotal, 90 + 65 + 149);
});

test('all booking pages share the same new add-on ids', () => {
  for (const f of BOOKING_PAGES) {
    const s = read(f);
    for (const id of ['mold', 'sanitize']) {
      assert.ok(s.includes(`id:'${id}'`), `${f} missing ${id}`);
    }
    assert.ok(!s.includes("id:'chain'"), `${f} still has chain`);
  }
});
