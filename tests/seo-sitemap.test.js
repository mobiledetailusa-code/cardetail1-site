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
  assert.match(sitemap, /bergen-county-hub\.html/);
  assert.match(sitemap, /passaic-county-hub\.html/);
});
