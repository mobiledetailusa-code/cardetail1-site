const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const NJ_HUB_ZIP3 = new Set([
  '070', '071', '072', '073', '074', '075', '076', '077', '078', '079',
  '080', '081', '082', '083', '084', '085', '086', '087', '088', '089',
]);

function resolveHubPageForHero(zip) {
  const zip5 = String(zip).replace(/\D/g, '').slice(0, 5);
  if (zip5.length < 5) return null;
  const zip3 = zip5.slice(0, 3);
  const zip2 = zip5.slice(0, 2);
  if (NJ_HUB_ZIP3.has(zip3)) return 'new-jersey-hub.html';
  if (zip2 === '10' || zip2 === '11') return 'ny-metro-hub.html';
  if (zip2 === '06') return 'connecticut-hub.html';
  if (zip2 === '19') return 'pennsylvania-hub.html';
  return null;
}

const cases = [
  ['07650', 'new-jersey-hub.html'],
  ['07302', 'new-jersey-hub.html'],
  ['07102', 'new-jersey-hub.html'],
  ['07501', 'new-jersey-hub.html'],
  ['07030', 'new-jersey-hub.html'],
  ['07060', 'new-jersey-hub.html'],
  ['07901', 'new-jersey-hub.html'],
  ['08001', 'new-jersey-hub.html'],
  ['08901', 'new-jersey-hub.html'],
  ['08540', 'new-jersey-hub.html'],
  ['10001', 'ny-metro-hub.html'],
  ['10583', 'ny-metro-hub.html'],
  ['06710', 'connecticut-hub.html'],
  ['19104', 'pennsylvania-hub.html'],
  ['90210', null],
];

for (const [zip, expected] of cases) {
  test(`resolveHubPageForHero(${zip}) → ${expected ?? 'null'}`, () => {
    const result = resolveHubPageForHero(zip);
    if (expected === null) assert.equal(result, null);
    else assert.equal(result, expected);
  });
}

test('index.html NJ_HUB_ZIP3 includes 080–089 prefixes', () => {
  const index = read('index.html');
  for (const p of ['080', '081', '085', '089']) {
    assert.match(index, new RegExp(`'${p}'`));
  }
});

test('index.html car pricing values unchanged (refresh tiers still present)', () => {
  const index = read('index.html');
  assert.ok(index.includes('refresh:320, premium:385'));
  assert.ok(index.includes('refresh:360, premium:470'));
});

test('ZIP routing change is isolated to index.html hero resolver', () => {
  const index = read('index.html');
  assert.ok(index.includes('function resolveHubPageForHero'));
  assert.ok(index.includes("return 'new-jersey-hub.html'"));
  for (const f of [
    'netlify/functions/stripe-webhook.js',
    'netlify/functions/submit-booking.js',
    'admin.html',
    'technician.html',
    'customer.html',
    'netlify/lib/travel-fee.js',
    'netlify/lib/booking-price-catalog.js',
  ]) {
    assert.ok(!read(f).includes('NJ_HUB_ZIP3'), `${f} must not contain homepage routing set`);
  }
});
