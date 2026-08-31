const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const CITY_PAGES = [
  'palisades-park-mobile-detailing.html',
  'fort-lee-mobile-detailing.html',
  'paramus-mobile-detailing.html',
  'hackensack-mobile-detailing.html',
  'englewood-mobile-detailing.html',
  'teaneck-mobile-detailing.html',
  'ridgewood-mobile-detailing.html',
  'edgewater-mobile-detailing.html',
];

function jsonLdBlocks(html) {
  const blocks = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) blocks.push(JSON.parse(m[1]));
  return blocks;
}

function flatten(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b['@graph']) out.push(...b['@graph']);
    else out.push(b);
  }
  return out;
}

function typesOf(node) {
  return [].concat(node['@type'] || []);
}

test('homepage JSON-LD is valid and includes LocalBusiness, offers, and FAQ', () => {
  const blocks = flatten(jsonLdBlocks(read('index.html')));
  const local = blocks.find((b) => typesOf(b).includes('LocalBusiness'));
  assert.ok(local, 'LocalBusiness missing');
  assert.equal(local.logo.url, 'https://cardetail1.com/assets/cardetail1-logo-square.png');
  assert.equal(local.logo.width, 720);
  assert.equal(local.logo.height, 720);
  assert.ok(local.hasOfferCatalog);
  assert.ok(JSON.stringify(local.areaServed).includes('Fort Lee'));
  assert.ok(blocks.find((b) => typesOf(b).includes('FAQPage')));
  assert.ok(blocks.find((b) => typesOf(b).includes('WebSite')));
  const faq = blocks.find((b) => typesOf(b).includes('FAQPage'));
  assert.ok(faq.mainEntity.length >= 4);
  assert.match(read('index.html'), /id="faq"/);
  assert.doesNotMatch(read('index.html'), /"@type": "AggregateRating"/);
});

test('county hubs have unique titles', () => {
  const titles = [
    'bergen-county-hub.html',
    'hudson-county-hub.html',
    'essex-county-hub.html',
    'passaic-county-hub.html',
    'new-jersey-hub.html',
  ].map((f) => read(f).match(/<title>([^<]+)<\/title>/)[1]);
  assert.equal(new Set(titles).size, titles.length);
  assert.match(titles[0], /Bergen County/);
  assert.match(titles[1], /Hudson County/);
  assert.match(titles[2], /Essex County/);
  assert.match(titles[3], /Passaic County/);
});

for (const page of CITY_PAGES) {
  test(`${page} is a unique city landing with schema, ZIP, and 300+ words`, () => {
    const html = read(page);
    assert.equal((html.match(/<h1\b/gi) || []).length, 1);
    assert.match(html, /<h1>Mobile Car Detailing in /);
    assert.match(html, new RegExp(`<link rel="canonical" href="https://cardetail1.com/${page}">`));
    const about = html.match(/<div class="city-copy">([\s\S]*?)<\/div>/);
    assert.ok(about, 'city copy missing');
    const words = about[1].replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
    assert.ok(words >= 300, `${page} copy has ${words} words`);
    assert.match(html, /name="zip"/);
    assert.match(html, /index\.html\?book=cars/);
    const nodes = flatten(jsonLdBlocks(html));
    assert.ok(nodes.some((b) => typesOf(b).includes('LocalBusiness')));
    assert.ok(nodes.some((b) => typesOf(b).includes('Service')));
    assert.ok(nodes.some((b) => typesOf(b).includes('FAQPage')));
    assert.ok(nodes.some((b) => typesOf(b).includes('BreadcrumbList')));
    const service = nodes.find((b) => typesOf(b).includes('Service'));
    assert.ok(Array.isArray(service.offers) && service.offers.length >= 3);
    assert.equal(service.offers[0].priceCurrency, 'USD');
  });
}

test('city pages do not share titles or H1s', () => {
  const titles = CITY_PAGES.map((f) => read(f).match(/<title>([^<]+)<\/title>/)[1]);
  const h1s = CITY_PAGES.map((f) => read(f).match(/<h1>([^<]+)<\/h1>/)[1]);
  assert.equal(new Set(titles).size, CITY_PAGES.length);
  assert.equal(new Set(h1s).size, CITY_PAGES.length);
});

test('existing city pages self-canonicalize', () => {
  for (const page of ['newark-mobile-detailing.html', 'trenton-mobile-detailing.html', 'westchester-mobile-detailing.html']) {
    const html = read(page);
    assert.match(html, new RegExp(`<link rel="canonical" href="https://cardetail1.com/${page}">`));
  }
});

test('template-city.html is noindexed', () => {
  assert.match(read('template-city.html'), /noindex/);
});

test('before/after gallery uses WebP with descriptive alts', () => {
  const index = read('index.html');
  assert.match(index, /assets\/before-after\/subaru-exterior-after\.webp/);
  assert.doesNotMatch(index, /assets\/before-after\/subaru-exterior-after\.jpg/);
  assert.match(index, /alt="After mobile car detailing Subaru Crosstrek Palisades Park NJ/);
  assert.ok(fs.existsSync(path.join(root, 'assets/before-after/subaru-exterior-after.webp')));
});

test('homepage preloads LCP hero image', () => {
  assert.match(read('index.html'), /rel="preload" as="image" href="assets\/vehicles\/premium\/cars-suvs\.webp"/);
});

test('homepage and Bergen hub link to dedicated city pages', () => {
  const index = read('index.html');
  const bergen = read('bergen-county-hub.html');
  for (const page of CITY_PAGES) {
    assert.match(index, new RegExp(page));
    assert.match(bergen, new RegExp(page));
  }
});

test('llms.txt describes Palisades Park services and prices', () => {
  const txt = read('llms.txt');
  assert.match(txt, /Palisades Park/);
  assert.match(txt, /Interior Detail from \$190/);
  assert.match(txt, /551-373-5668/);
});

test('sitemap lists Bergen city landings', () => {
  const xml = read('sitemap.xml');
  for (const page of CITY_PAGES) {
    assert.match(xml, new RegExp(page));
  }
  assert.doesNotMatch(xml, /template-city/);
  assert.doesNotMatch(xml, /admin\.html/);
});

test('boats/rv/powersports JSON-LD includes Offer and BreadcrumbList', () => {
  for (const page of ['boats-detailing.html', 'rv-detailing.html', 'powersports-detailing.html']) {
    const nodes = flatten(jsonLdBlocks(read(page)));
    assert.ok(nodes.some((b) => typesOf(b).includes('Service')));
    assert.ok(nodes.some((b) => typesOf(b).includes('BreadcrumbList')));
    const service = nodes.find((b) => typesOf(b).includes('Service'));
    assert.ok(service.offers && service.offers.length >= 1);
  }
});
