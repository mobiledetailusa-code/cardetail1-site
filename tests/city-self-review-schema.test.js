'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

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

const LOCAL_TEMPLATES = ['template-city.html', 'bergen-county-hub.html'];

function jsonLdBlocks(html) {
  const blocks = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let match;
  while ((match = re.exec(html))) blocks.push(JSON.parse(match[1]));
  return blocks;
}

function flatten(blocks) {
  const out = [];
  for (const block of blocks) {
    if (Array.isArray(block['@graph'])) out.push(...block['@graph']);
    else out.push(block);
  }
  return out;
}

function typesOf(node) {
  return [].concat(node && node['@type'] ? node['@type'] : []);
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((item) => walk(item, visit));
    return;
  }
  visit(node);
  for (const value of Object.values(node)) walk(value, visit);
}

function schemaFacts(html) {
  const nodes = flatten(jsonLdBlocks(html));
  const types = [];
  const snippetKeys = [];
  walk(nodes, (node) => {
    types.push(...typesOf(node));
    for (const key of ['review', 'reviewRating', 'aggregateRating', 'itemReviewed']) {
      if (Object.prototype.hasOwnProperty.call(node, key)) snippetKeys.push(key);
    }
  });
  return { nodes, types, snippetKeys };
}

test('local template and generated city pages do not emit self-serving Review snippets', () => {
  const files = [...LOCAL_TEMPLATES, ...CITY_PAGES, 'newark-mobile-detailing.html', 'trenton-mobile-detailing.html', 'westchester-mobile-detailing.html'];
  for (const file of files) {
    const facts = schemaFacts(read(file));
    assert.equal(facts.types.filter((type) => type === 'Review').length, 0, `${file} still has Review`);
    assert.equal(facts.types.includes('AggregateRating'), false, `${file} still has AggregateRating`);
    assert.deepEqual(facts.snippetKeys, [], `${file} still has ${facts.snippetKeys.join(',')}`);
  }
});

test('Bergen city pages keep LocalBusiness, address, phone, breadcrumbs, and visible reviews', () => {
  for (const file of CITY_PAGES) {
    const html = read(file);
    const stem = file.replace(/\.html$/, '');
    const facts = schemaFacts(html);
    const business = facts.nodes.find((node) => typesOf(node).includes('LocalBusiness'));
    assert.ok(business, `${file} missing LocalBusiness`);
    assert.equal(business.name, 'Cardetail1');
    assert.equal(business.telephone, '+15513893986');
    assert.equal(business.address['@type'], 'PostalAddress');
    assert.equal(business.address.addressLocality, 'Palisades Park');
    assert.equal(business.address.addressRegion, 'NJ');
    assert.ok(business.areaServed, `${file} missing service area`);
    assert.equal(business.image, 'https://cardetail1.com/assets/cardetail1-logo.webp');
    assert.match(html, new RegExp(`<link rel="canonical" href="https://cardetail1.com/${stem}">`));

    const crumbs = facts.nodes.find((node) => typesOf(node).includes('BreadcrumbList'));
    assert.ok(crumbs, `${file} missing BreadcrumbList`);
    assert.equal(crumbs.itemListElement.length, 3, file);
    crumbs.itemListElement.forEach((item, index) => {
      assert.equal(item['@type'], 'ListItem');
      assert.equal(item.position, index + 1);
      assert.equal(typeof item.name, 'string');
      assert.match(item.item, /^https:\/\/cardetail1\.com\//);
    });
    assert.equal(crumbs.itemListElement[0].name, 'Home');
    assert.equal(crumbs.itemListElement[0].item, 'https://cardetail1.com/');
    assert.equal(crumbs.itemListElement[2].item, `https://cardetail1.com/${stem}`);

    assert.equal((html.match(/<article class="city-review">/g) || []).length, 2, file);
    assert.match(html, /John Daquila · Google review/);
    assert.match(html, /Gerard Baltazar · Google review/);
    assert.match(html, /href="https:\/\/g\.page\/r\/CTJwfJerrQeCEAI\/review"/);
  }
});

test('local templates keep the business identity fields without review markup', () => {
  for (const file of LOCAL_TEMPLATES) {
    const facts = schemaFacts(read(file));
    const business = facts.nodes.find((node) => typesOf(node).includes('LocalBusiness'));
    assert.ok(business, `${file} missing LocalBusiness`);
    assert.equal(business.telephone, '+15513893986');
    assert.equal(business.address['@type'], 'PostalAddress');
    assert.equal(business.address.addressLocality, 'Palisades Park');
    assert.ok(Array.isArray(business.openingHoursSpecification));
    assert.equal(business.openingHoursSpecification[0].opens, '08:00');
    assert.equal(business.openingHoursSpecification[0].closes, '17:00');
    assert.equal(facts.types.includes('BreadcrumbList'), false, `${file} unexpectedly gained breadcrumbs`);
  }
});
