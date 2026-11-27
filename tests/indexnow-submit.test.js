'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  KEY, KEY_LOCATION, ENDPOINT, parseSitemap, parseDisallow, isDisallowed, urlForFile, buildPlan, payload, parseArgs,
  filterRecent, describeStatus,
} = require('../scripts/indexnow-submit');
const { ROOT_FILES } = require('../scripts/build-public-dist');

const ROOT = path.join(__dirname, '..');
const sitemapUrls = parseSitemap(fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8'));
const disallow = parseDisallow(fs.readFileSync(path.join(ROOT, 'robots.txt'), 'utf8'));

test('the key file is committed, published, and holds exactly the key', () => {
  assert.match(KEY, /^[a-f0-9]{32}$/);
  assert.equal(fs.readFileSync(path.join(ROOT, `${KEY}.txt`), 'utf8'), KEY);
  assert.ok(ROOT_FILES.includes(`${KEY}.txt`));
  assert.equal(KEY_LOCATION, `https://cardetail1.com/${KEY}.txt`);
});

test('root apple-touch-icon.png is published for pages that do not declare one', () => {
  assert.ok(ROOT_FILES.includes('apple-touch-icon.png'));
  assert.ok(fs.readFileSync(path.join(ROOT, 'apple-touch-icon.png')).equals(
    fs.readFileSync(path.join(ROOT, 'assets/apple-touch-icon.png')),
  ));
});

test('root pages map to the pretty URLs the sitemap uses', () => {
  assert.equal(urlForFile('index.html'), 'https://cardetail1.com/');
  assert.equal(urlForFile('mahwah-mobile-detailing.html'), 'https://cardetail1.com/mahwah-mobile-detailing');
  assert.equal(urlForFile('assets/app.js'), null);
  assert.equal(urlForFile('docs/x.html'), null);
  for (const u of sitemapUrls) assert.ok(!u.endsWith('.html'), `${u} should be a pretty URL`);
});

test('private and non-indexable pages are never submitted', () => {
  const changedFiles = [
    'admin.html', 'admin-ops.html', 'customer.html', 'technician.html', 'template-city.html',
    'receipt.html', 'authorize.html', 'bid.html', 'resume.html', 'my-garage.html',
    'franklin-lakes-mobile-detailing.html', 'netlify/functions/submit-booking.js',
  ];
  const plan = buildPlan({ sitemapUrls, disallow, changedFiles });
  assert.deepEqual(plan.changed, ['https://cardetail1.com/franklin-lakes-mobile-detailing']);
  for (const s of plan.skipped) assert.ok(!plan.changed.includes(s.url));
  assert.ok(isDisallowed('https://cardetail1.com/admin/owner-studio', disallow));
  assert.ok(isDisallowed('https://cardetail1.com/?utm_source=x&book=full', disallow));
  assert.ok(!isDisallowed('https://cardetail1.com/tenafly-mobile-detailing', disallow));
});

test('other hosts and duplicate URLs are dropped', () => {
  const plan = buildPlan({
    sitemapUrls,
    disallow,
    urls: [
      'https://cardetail1.com/', 'https://cardetail1.com/', 'http://cardetail1.com/',
      'https://www.cardetail1.com/', 'https://evil.example/', 'not a url',
    ],
    changedFiles: ['index.html'],
  });
  assert.deepEqual(plan.changed, ['https://cardetail1.com/']);
});

test('a removed URL is accepted only once it left the sitemap', () => {
  const plan = buildPlan({
    sitemapUrls,
    disallow,
    deletedFiles: ['old-city-mobile-detailing.html'],
    removedUrls: ['https://cardetail1.com/mahwah-mobile-detailing', 'https://cardetail1.com/admin.html'],
  });
  assert.deepEqual(plan.removed, ['https://cardetail1.com/old-city-mobile-detailing']);
});

test('--all covers every sitemap URL and the payload follows the protocol', () => {
  const plan = buildPlan({ sitemapUrls, disallow, all: true });
  assert.equal(plan.changed.length, sitemapUrls.length);
  const body = payload(plan.changed);
  assert.deepEqual(Object.keys(body), ['host', 'key', 'keyLocation', 'urlList']);
  assert.equal(body.host, 'cardetail1.com');
});

test('dry run is the default; --submit must be explicit', () => {
  assert.equal(parseArgs(['--all']).submit, false);
  assert.equal(parseArgs(['--all', '--submit']).submit, true);
  assert.equal(parseArgs(['--all', '--submit']).force, false);
  assert.throws(() => parseArgs(['--yes']), /unknown argument/);
});

test('uses the official shared IndexNow endpoint over https', () => {
  assert.equal(ENDPOINT, 'https://api.indexnow.org/indexnow');
});

test('URLs sent from this machine in the last 24 h are not resent unless forced', () => {
  const now = Date.parse('2026-11-27T12:00:00Z');
  const log = {
    'https://cardetail1.com/': '2026-11-27T02:00:00Z', // 10 h ago
    'https://cardetail1.com/mahwah-mobile-detailing': '2026-11-25T12:00:00Z', // 2 days ago
  };
  const urls = ['https://cardetail1.com/', 'https://cardetail1.com/mahwah-mobile-detailing', 'https://cardetail1.com/tenafly-mobile-detailing'];
  assert.deepEqual(filterRecent(urls, log, now), {
    send: ['https://cardetail1.com/mahwah-mobile-detailing', 'https://cardetail1.com/tenafly-mobile-detailing'],
    recent: ['https://cardetail1.com/'],
  });
  assert.deepEqual(filterRecent(urls, log, now, true).send, urls);
  assert.deepEqual(filterRecent(urls, {}, now).send, urls);
});

test('every documented IndexNow status has an operator message', () => {
  for (const s of [200, 202, 400, 403, 422, 429]) assert.notEqual(describeStatus(s), 'unexpected response');
  assert.equal(describeStatus(500), 'unexpected response');
});

test('the local submission log is never committed', () => {
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(gi, /^\/\.indexnow-log\.json$/m);
});

test('IndexNow stays manual: no build hook, Function or schedule', () => {
  const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
  assert.doesNotMatch(toml, /indexnow/i);
  const fnDir = path.join(ROOT, 'netlify/functions');
  assert.ok(!fs.readdirSync(fnDir).some((f) => /indexnow/i.test(f)));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
    if (/^(build|postbuild|prebuild|deploy|postdeploy)$/.test(name)) assert.doesNotMatch(cmd, /indexnow/i);
  }
});
