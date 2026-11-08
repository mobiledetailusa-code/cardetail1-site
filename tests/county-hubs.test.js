const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const HUBS = [
  { file: 'rockland-county-hub.html', county: 'Rockland County, NY', region: 'US-NY' },
  { file: 'union-county-hub.html', county: 'Union County, NJ', region: 'US-NJ' },
  { file: 'morris-county-hub.html', county: 'Morris County, NJ', region: 'US-NJ' },
  { file: 'fairfield-county-hub.html', county: 'Fairfield County, CT', region: 'US-CT' },
];

test('each nearby county hub is one indexable page for that county', () => {
  const sitemap = read('sitemap.xml');
  for (const hub of HUBS) {
    const html = read(hub.file);
    const stem = hub.file.replace(/\.html$/, '');
    assert.equal((html.match(/<h1[\s>]/gi) || []).length, 1, hub.file);
    assert.match(html, new RegExp(`<link rel="canonical" href="https://cardetail1.com/${stem}">`));
    assert.match(html, new RegExp(`name="geo.region" content="${hub.region}"`));
    assert.match(sitemap, new RegExp(`<loc>https://cardetail1.com/${stem}</loc>`));
    assert.doesNotMatch(html, /"@type": "LocalBusiness"/);
    assert.doesNotMatch(html, /GeoCircle/);

    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map((match) => JSON.parse(match[1]));
    const nodes = blocks.flatMap((block) => block['@graph'] || [block]);
    const service = nodes.find((node) => node['@type'] === 'Service');
    assert.ok(service, `${hub.file} missing Service`);
    const areas = [].concat(service.areaServed || []);
    assert.deepEqual(areas.map((area) => area.name), [hub.county]);
    assert.ok(nodes.some((node) => node['@type'] === 'FAQPage'));
    assert.ok(nodes.some((node) => node['@type'] === 'BreadcrumbList'));
  }
});
