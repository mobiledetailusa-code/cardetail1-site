const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('robots.txt blocks portals and points to sitemap', () => {
  const robots = fs.readFileSync(path.join(root, 'robots.txt'), 'utf8');
  assert.match(robots, /Disallow: \/customer\//);
  assert.match(robots, /Disallow: \/admin\//);
  assert.match(robots, /Sitemap: https:\/\/cardetail1\.com\/sitemap\.xml/);
});

test('sitemap.xml lists homepage and public hub URLs', () => {
  const sitemap = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8');
  assert.match(sitemap, /<loc>https:\/\/cardetail1\.com\/<\/loc>/);
  assert.match(sitemap, /new-jersey-hub\.html/);
  assert.match(sitemap, /ny-metro-hub\.html/);
  assert.match(sitemap, /connecticut-hub\.html/);
  assert.match(sitemap, /pennsylvania-hub\.html/);
  assert.match(sitemap, /bergen-county-hub\.html/);
  assert.match(sitemap, /passaic-county-hub\.html/);
  assert.match(sitemap, /boats-detailing\.html/);
  assert.match(sitemap, /rv-detailing\.html/);
  assert.match(sitemap, /powersports-detailing\.html/);
  assert.match(sitemap, /multi-vehicle-detailing\.html/);
  assert.match(sitemap, /fleet-services\.html/);
  assert.match(sitemap, /newark-mobile-detailing\.html/);
  assert.match(sitemap, /blog\.html/);
  assert.match(sitemap, /detailing-vs-car-wash\.html/);
  assert.match(sitemap, /how-often-to-detail\.html/);
  assert.match(sitemap, /mobile-detailing-what-to-expect\.html/);
  assert.doesNotMatch(sitemap, /admin\.html/);
  assert.doesNotMatch(sitemap, /customer\.html/);
});

test('index.html includes Google Search Console verification meta tag', () => {
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(
    index,
    /<meta name="google-site-verification" content="J5dl5bL4P6NqxVkm1zauqfoFghfu2puiXoRWyvFID3c">/
  );
});

test('homepage declares a square crawlable Google search favicon and Organization logo', () => {
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(index, /rel="icon"[^>]+href="\/favicon\.ico"/);
  assert.match(index, /href="\/assets\/favicon-48\.png"/);
  assert.match(index, /cardetail1-logo-square\.png/);

  const files = [
    'favicon.ico',
    'assets/favicon-48.png',
    'assets/favicon-96.png',
    'assets/apple-touch-icon.png',
    'assets/cardetail1-logo-square.png',
  ];
  for (const rel of files) {
    const file = path.join(root, rel);
    assert.equal(fs.existsSync(file), true, `missing ${rel}`);
    assert.ok(fs.statSync(file).size > 500, `${rel} too small`);
  }

  const blocks = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let match;
  while ((match = re.exec(index))) blocks.push(JSON.parse(match[1]));
  const local = blocks.find((b) => [].concat(b['@type'] || []).includes('LocalBusiness'));
  assert.equal(local.logo.url, 'https://cardetail1.com/assets/cardetail1-logo-square.png');
  assert.equal(local.logo.width, 512);
  assert.equal(local.logo.height, 512);
});
