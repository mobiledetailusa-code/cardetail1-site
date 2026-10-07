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
  for (const stem of [
    'new-jersey-hub',
    'ny-metro-hub',
    'connecticut-hub',
    'pennsylvania-hub',
    'bergen-county-hub',
    'passaic-county-hub',
    'boats-detailing',
    'rv-detailing',
    'powersports-detailing',
    'trucks-detailing',
    'multi-vehicle-detailing',
    'fleet-services',
    'newark-mobile-detailing',
    'palisades-park-mobile-detailing',
    'fort-lee-mobile-detailing',
    'paramus-mobile-detailing',
    'hackensack-mobile-detailing',
    'blog',
    'detailing-vs-car-wash',
    'how-often-to-detail',
    'mobile-detailing-what-to-expect',
  ]) {
    assert.match(sitemap, new RegExp(`<loc>https://cardetail1.com/${stem}</loc>`));
    assert.doesNotMatch(sitemap, new RegExp(`${stem}\\.html`));
  }
  assert.doesNotMatch(sitemap, /\.html/);
  assert.doesNotMatch(sitemap, /admin/);
  assert.doesNotMatch(sitemap, /customer/);
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
    'assets/google-business-logo.jpg',
    'assets/google-business-logo.png',
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
  assert.equal(local.logo.width, 720);
  assert.equal(local.logo.height, 720);
  assert.ok(fs.statSync(path.join(root, 'assets/google-business-logo.jpg')).size > 10000);
});
