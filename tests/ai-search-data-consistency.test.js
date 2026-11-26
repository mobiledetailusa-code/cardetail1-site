// AI-search data consistency: one business entity, a standard-service areaServed
// backed by the production ZIP travel gate, and public price statements that
// match the canonical server catalog.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const CATALOG = require('../netlify/lib/booking-price-catalog.js').PRICING;
const travel = require('../netlify/lib/travel-fee.js');

const PRIVATE = /^(admin|technician|customer|my-garage|receipt|resume|bid|authorize)/;
const PUBLIC_PAGES = fs.readdirSync(root).filter((f) => f.endsWith('.html') && !PRIVATE.test(f)).sort();

const loadEntityLib = () => import(pathToFileURL(path.join(root, 'scripts/lib/canonical-business-entity.mjs')).href);

function homepagePackages() {
  const src = read('index.html');
  const a = src.indexOf('const CAR_INTERIOR_SERVICE_ITEMS');
  const b = src.indexOf('window.PRICING = PRICING;');
  assert.ok(a >= 0 && b > a, 'index.html PRICING block not found');
  const ctx = {};
  require('node:vm').runInNewContext(`${src.slice(a, b)}\n;globalThis.__P = PRICING;`, ctx);
  return Object.fromEntries(ctx.__P.cars.packages.map((p) => [p.id, p]));
}

/** One ZIP inside each place the canonical entity names. All must be no-fee. */
const STANDARD_AREA_ZIP = {
  'Bergen County, NJ': '07601',
  'Hudson County, NJ': '07302',
  'Essex County, NJ': '07102',
  'Passaic County, NJ': '07505',
  'Union County, NJ': '07201',
  'Morris County, NJ': '07960',
  'Rockland County, NY': '10956',
  'Westchester County, NY': '10601',
  'Fairfield County, CT': '06901',
  'Palisades Park, NJ': '07650',
  'Fort Lee, NJ': '07024',
  'Paramus, NJ': '07652',
  'Hackensack, NJ': '07601',
  'Englewood, NJ': '07631',
  'Teaneck, NJ': '07666',
  'Ridgewood, NJ': '07450',
  'Edgewater, NJ': '07020',
};

test('every public JSON-LD block parses', async () => {
  const { jsonLdBlocks } = await loadEntityLib();
  for (const f of PUBLIC_PAGES) {
    const src = read(f);
    const total = (src.match(/application\/ld\+json/g) || []).length;
    const parsed = jsonLdBlocks(src);
    assert.equal(parsed.length, total, `${f}: a JSON-LD block is not in the expected <script> form`);
  }
});

test('every page that defines /#business carries the identical homepage entity', async () => {
  const { loadCanonicalBusiness, syncBusinessEntity, jsonLdBlocks, definesBusiness } = await loadEntityLib();
  const canonical = loadCanonicalBusiness(root);
  let definitions = 0;
  for (const f of PUBLIC_PAGES) {
    const src = read(f);
    for (const block of jsonLdBlocks(src)) {
      definitions += (block.data['@graph'] || [block.data]).filter(definesBusiness).length;
    }
    if (f === 'index.html') continue;
    assert.equal(syncBusinessEntity(src, canonical, f).changed, 0, `${f}: /#business differs from index.html`);
  }
  assert.ok(definitions >= 21, `expected the entity on the homepage, hubs and city pages (found ${definitions})`);
});

test('the business entity has one name and phone, and no conflicting @id types', async () => {
  const { loadCanonicalBusiness } = await loadEntityLib();
  const b = loadCanonicalBusiness(root);
  assert.equal(b.name, 'Cardetail1');
  assert.equal(b.legalName, 'Detailing Zone L.L.C.');
  assert.equal(b.telephone, '+15513893986');
  // Service-area business: identity is Bergen County, NJ; no locality, ZIP or coordinates.
  assert.equal(b.address.addressLocality, undefined);
  assert.equal(b.address.postalCode, undefined);
  assert.equal(b.geo, undefined);
  assert.match(b.description, /based in Bergen County, NJ/);
  assert.equal(b.address.streetAddress, undefined, 'a mobile business must not publish a street address');
  assert.equal(b.aggregateRating, undefined);
});

test('canonical areaServed names only places in the no-fee production zone', async () => {
  const { loadCanonicalBusiness } = await loadEntityLib();
  const names = loadCanonicalBusiness(root).areaServed.map((a) => (typeof a === 'string' ? a : a.name));
  for (const name of names) {
    const zip = STANDARD_AREA_ZIP[name];
    assert.ok(zip, `${name}: add a representative ZIP to STANDARD_AREA_ZIP before naming it in areaServed`);
    const r = travel.resolveTravelForZip(zip);
    assert.ok(r && r.inRange, `${name} (${zip}) is outside the ZIP gate`);
    assert.equal(r.fee, 0, `${name} (${zip}) carries a travel fee or surcharge; it is not standard service`);
  }
  for (const banned of ['New York City', 'Hartford', 'New Haven', 'Waterbury', 'Philadelphia', 'Bucks', 'Montgomery County, PA', 'Delaware County']) {
    assert.ok(!names.some((n) => n.includes(banned)), `areaServed must not claim ${banned}`);
  }
});

test('llms.txt car prices and names match the canonical server catalog', () => {
  const txt = read('llms.txt');
  const t = CATALOG.cars.tiers;
  const pkg = homepagePackages();
  assert.match(txt, new RegExp(`- ${pkg.interior.name} from \\$${t.small.interior}\\n`));
  assert.match(txt, new RegExp(`- ${pkg.full.name} from \\$${t.small.full} \\(SUVs from \\$${t.suv2.full}, 3-row from \\$${t.suv3.full}\\)`));
  assert.match(txt, new RegExp(`- ${pkg.refresh.name} from \\$${t.small.refresh}\\n`));
});

test('public "SUVs from / 3-row from" claims match the catalog Premium Full Detail tiers', () => {
  const t = CATALOG.cars.tiers;
  const re = /SUVs from \$(\d+)(?: ·|,) 3-row from \$(\d+)/g;
  let seen = 0;
  for (const f of [...PUBLIC_PAGES, 'llms.txt']) {
    for (const m of read(f).matchAll(re)) {
      seen += 1;
      assert.deepEqual([Number(m[1]), Number(m[2])], [t.suv2.full, t.suv3.full], `${f}: ${m[0]}`);
    }
  }
  assert.ok(seen > 0, 'no SUV price claims found; the pattern is stale');
});

test('the $335 exterior package is named the same everywhere', () => {
  const name = homepagePackages().refresh.name;
  assert.equal(name, 'Exterior Refresh & Protect');
  for (const f of [...PUBLIC_PAGES, 'llms.txt']) {
    assert.doesNotMatch(read(f), /Exterior Detail (?:&|&amp;|and) Paint Enhancement/, f);
  }
});
