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

function extractAddonBlocks(html) {
  const blocks = [];
  const re = /addons:\[([\s\S]*?)\](?:,|\n  \})/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

test('add-on catalog entries do not define icon fields', () => {
  for (const f of BOOKING_PAGES) {
    const blocks = extractAddonBlocks(read(f));
    assert.ok(blocks.length >= 5, `${f} should include multiple add-on blocks`);
    for (const block of blocks) {
      assert.ok(!/\bicon:/.test(block), `${f} add-on block still has icon fields`);
    }
  }
});

test('booking add-on UI uses 3D icons, not catalog emoji fields', () => {
  for (const f of BOOKING_PAGES) {
    const s = read(f);
    assert.ok(!s.includes('${a.icon}'), `${f} still interpolates add-on catalog emoji icons`);
    assert.match(s, /icon3dAddon\(a\.id\)/, `${f} missing 3D add-on icon helper`);
    assert.match(s, /class="addon-ico"/, `${f} missing 3D add-on icon markup`);
  }
});

test('Mold Treatment appears with estimate copy and price', () => {
  const s = read('index.html');
  assert.match(s, /id:'mold'[^}]*price:149/);
  assert.match(s, /id:'mold'[^}]*estimate/i);
  const def = PRICING.cars.addons.find((a) => a.id === 'mold');
  assert.equal(def.price, 149);
});

test('Interior Sanitizing appears with correct price', () => {
  const s = read('index.html');
  assert.match(s, /id:'sanitize'[^}]*name:'Interior Sanitizing'/);
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
    const html = read(f);
    const m = html.match(/powersports:\s*\{[\s\S]*?addons:\[([\s\S]*?)\],/);
    assert.ok(m, `${f} powersports addons block`);
    const block = m[1];
    assert.ok(!block.includes("id:'chain'"), `${f} still has chain add-on`);
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

test('all booking pages share sanitize; mold remains on cars/boats only', () => {
  for (const f of BOOKING_PAGES) {
    const s = read(f);
    assert.ok(s.includes("id:'sanitize'"), `${f} missing sanitize`);
    assert.ok(s.includes("id:'mold'"), `${f} missing cars/boats mold`);
    assert.ok(!s.includes("id:'chain'"), `${f} still has chain`);
    const rv = s.match(/rvs:\s*\{[\s\S]*?addons:\[([\s\S]*?)\],/);
    assert.ok(rv, `${f} missing rvs addons`);
    assert.ok(!rv[1].includes("id:'mold'"), `${f} RV addons still include mold`);
    assert.match(rv[1], /id:'superint'[^}]*price:135/);
  }
  assert.ok(!PRICING.rvs.addons.some((a) => a.id === 'mold'));
  assert.equal(PRICING.rvs.addons.find((a) => a.id === 'superint').price, 135);
  assert.equal(PRICING.cars.addons.find((a) => a.id === 'mold').price, 149);
});

test('client and server add-on ids/prices stay synced for cars', () => {
  const clientIds = [...read('index.html').matchAll(/cars:[\s\S]*?addons:\[([\s\S]*?)\],/g)][0][1]
    .matchAll(/id:'([^']+)'[^}]*price:(\d+)/g);
  const clientMap = Object.fromEntries([...clientIds].map((m) => [m[1], Number(m[2])]));
  // Server-only Stage 1 financial fixture ($40 / 4000¢). Not exposed on public
  // booking UI yet — Stage 1 deliberately does not edit customer-facing catalog HTML.
  const serverOnlyStage1Fixtures = new Set(['ozone']);
  for (const a of PRICING.cars.addons) {
    if (serverOnlyStage1Fixtures.has(a.id)) {
      assert.equal(a.price, 40, 'ozone Stage 1 fixture must remain $40');
      continue;
    }
    assert.equal(clientMap[a.id], a.price, `cars.${a.id} price mismatch`);
  }
  for (const [id, price] of Object.entries(clientMap)) {
    const server = PRICING.cars.addons.find((a) => a.id === id);
    assert.ok(server, `client cars addon ${id} missing from booking-price-catalog`);
    assert.equal(server.price, price, `cars.${id} server price must match client`);
  }
});
