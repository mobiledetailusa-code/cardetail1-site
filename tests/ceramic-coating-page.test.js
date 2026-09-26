'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function jsonLdBlocks(html) {
  const blocks = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let match;
  while ((match = re.exec(html))) blocks.push(JSON.parse(match[1]));
  return blocks;
}

test('ceramic coating page is a public quote page, not a catalog package', () => {
  const html = read('ceramic-coating.html');
  assert.match(html, /<meta charset="UTF-8">/i);
  assert.match(html, /<title>Mobile Ceramic Coating in Bergen County \| Cardetail1<\/title>/);
  assert.equal((html.match(/<h1[\s>]/gi) || []).length, 1);
  assert.match(html, /rel="canonical" href="https:\/\/cardetail1\.com\/ceramic-coating\.html"/);
  assert.match(html, /content="index,follow/);
  assert.doesNotMatch(html, /noindex/i);
  assert.doesNotMatch(html, /id="bk-ov"/);
  assert.match(html, /href="tel:\+15513893986"/);
  assert.match(html, /index\.html\?book=cars&amp;pkg=refresh/);
  assert.match(html, /assets\/back-to-top\.js/);
  assert.match(html, /id="cd1-public-footer"/);
  assert.match(html, /do not sell a lifetime warranty/i);
  assert.match(html, /\$25 polymer sealant/);
  assert.doesNotMatch(html, /From \$/);
  assert.match(html, /are not ceramic-coating packages/);
  assert.match(html, /This is not ceramic coating/);
});

test('ceramic coating FAQ schema matches the visible questions', () => {
  const html = read('ceramic-coating.html');
  const summaries = [...html.matchAll(/<summary>([^<]+)<\/summary>/g)].map((m) => m[1].trim());
  const graph = jsonLdBlocks(html).flatMap((block) => block['@graph'] || [block]);
  const faq = graph.find((block) => block['@type'] === 'FAQPage');
  assert.ok(faq, 'FAQPage missing');
  assert.deepEqual(faq.mainEntity.map((q) => q.name), summaries);
  const service = graph.find((block) => block['@type'] === 'Service');
  assert.equal(service.name, 'Mobile Ceramic Coating');
  assert.equal(service.offers, undefined);
});

test('sitemap, redirect, footer, and homepage point at the ceramic page', () => {
  assert.match(read('sitemap.xml'), /ceramic-coating\.html/);
  assert.match(read('netlify.toml'), /from = "\/ceramic-coating"/);
  assert.match(read('assets/partials/specialty-public-footer.html'), /href="ceramic-coating\.html">Ceramic Coating</);
  assert.match(read('index.html'), /href="ceramic-coating\.html"/);
  assert.match(read('index.html'), /It is not included in these packages/);
});
