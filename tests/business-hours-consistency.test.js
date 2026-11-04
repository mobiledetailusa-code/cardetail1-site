'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const OFFICIAL_HOURS = 'Monday–Saturday · By Appointment Only';

const COMMERCIAL_PAGES = [
  'index.html',
  'new-jersey-hub.html',
  'bergen-county-hub.html',
  'essex-county-hub.html',
  'hudson-county-hub.html',
  'passaic-county-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
  'ny-metro-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'palisades-park-mobile-detailing.html',
  'fort-lee-mobile-detailing.html',
  'paramus-mobile-detailing.html',
  'hackensack-mobile-detailing.html',
  'englewood-mobile-detailing.html',
  'teaneck-mobile-detailing.html',
  'ridgewood-mobile-detailing.html',
  'edgewater-mobile-detailing.html',
  'boats-detailing.html',
  'rv-detailing.html',
  'powersports-detailing.html',
  'trucks-detailing.html',
  'fleet-services.html',
  'multi-vehicle-detailing.html',
  'blog.html',
  'reviews.html',
  'detailing-vs-car-wash.html',
  'how-often-to-detail.html',
  'mobile-detailing-what-to-expect.html',
  'terms-conditions.html',
  'template-city.html',
  'assets/partials/specialty-public-footer.html',
];

const STRUCTURED_DATA_PAGES = [
  'index.html',
  'new-jersey-hub.html',
  'bergen-county-hub.html',
  'essex-county-hub.html',
  'hudson-county-hub.html',
  'passaic-county-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
  'ny-metro-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'template-city.html',
];

function jsonLdBlocks(html) {
  const blocks = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let match;
  while ((match = re.exec(html))) blocks.push(JSON.parse(match[1]));
  return blocks;
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((item) => walk(item, visit));
    return;
  }
  visit(node);
  Object.values(node).forEach((value) => walk(value, visit));
}

test('commercial pages use the official appointment-only hours and no legacy fixed hours', () => {
  const legacy = /(?:Mon(?:day)?)[–-]Fri(?:day)?[,]?\s*8AM[–-]5PM/i;

  for (const file of COMMERCIAL_PAGES) {
    const html = read(file);
    assert.match(html, new RegExp(OFFICIAL_HOURS), `${file} missing official hours`);
    assert.doesNotMatch(html, legacy, `${file} still publishes legacy fixed hours`);
  }
});

test('LocalBusiness structured data does not invent fixed opening intervals', () => {
  for (const file of STRUCTURED_DATA_PAGES) {
    const blocks = jsonLdBlocks(read(file));
    let localBusinessCount = 0;

    walk(blocks, (node) => {
      const types = [].concat(node['@type'] || []);
      if (!types.includes('LocalBusiness')) return;
      localBusinessCount += 1;
      assert.equal(
        Object.prototype.hasOwnProperty.call(node, 'openingHoursSpecification'),
        false,
        `${file} still publishes openingHoursSpecification`,
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(node, 'openingHours'),
        false,
        `${file} still publishes openingHours`,
      );
    });

    assert.ok(localBusinessCount > 0, `${file} missing LocalBusiness structured data`);
  }
});

// Maintenance generators rewrite the pages above. If they still carried the old
// Monday–Friday 8AM–5PM text or an openingHoursSpecification, the next run would
// silently undo this fix (apply-onpage-seo.mjs re-injects its LocalBusiness graph
// whenever index.html loses its schema markers).
const SEO_GENERATORS = [
  'scripts/apply-onpage-seo.mjs',
  'scripts/generate-bergen-city-pages.mjs',
  'scripts/patch-hub-seo-audit.mjs',
];
const LEGACY_HOURS_ANY = /Mon(?:day)?[–-]Fri(?:day)?|8\s?AM[–-]5\s?PM|8:00[–-]17:00|opens:\s*'08:00'|closes:\s*'17:00'/i;

test('SEO maintenance generators cannot reintroduce legacy fixed hours', () => {
  for (const file of SEO_GENERATORS) {
    const src = read(file);
    assert.doesNotMatch(src, LEGACY_HOURS_ANY, `${file} still emits legacy fixed hours`);
    assert.doesNotMatch(src, /openingHoursSpecification\s*:|openingHours\s*:/, `${file} still emits opening hours schema`);
  }
  assert.match(read('scripts/apply-onpage-seo.mjs'), new RegExp(`- Hours: ${OFFICIAL_HOURS}`));
  assert.match(read('scripts/generate-bergen-city-pages.mjs'), new RegExp(OFFICIAL_HOURS));
});

test('llms.txt publishes the official appointment-only hours', () => {
  const llms = read('llms.txt');
  assert.match(llms, new RegExp(`- Hours: ${OFFICIAL_HOURS}`));
  assert.doesNotMatch(llms, LEGACY_HOURS_ANY);
});
