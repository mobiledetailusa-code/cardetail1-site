'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const LEGACY = [
  {
    path: '/personal-watercraft-packages',
    destination: 'https://cardetail1.com/boats-detailing',
    file: 'boats-detailing.html',
  },
  {
    path: '/rv-detailing-packages',
    destination: 'https://cardetail1.com/rv-detailing',
    file: 'rv-detailing.html',
  },
];

const UNMAPPED = ['/app/cms', '/submit-inquiry', "/'+mailto+'", '/+mailto+'];
const BANNED = [
  'personal-watercraft-packages',
  'rv-detailing-packages',
  'app/cms',
  '+mailto+',
  "'+mailto+'",
];

function parseRedirects(toml) {
  return toml.split('[[redirects]]').slice(1).map((block) => {
    const body = block.split('[[')[0];
    const from = body.match(/from = "([^"]+)"/);
    const to = body.match(/to = "([^"]+)"/);
    const status = body.match(/status = (\d+)/);
    if (!from || !to || !status) return null;
    return {
      from: from[1],
      to: to[1],
      status: Number(status[1]),
      force: /force = true/.test(body),
    };
  }).filter(Boolean);
}

function origins(pathname) {
  return [
    pathname,
    `http://cardetail1.com${pathname}`,
    `http://www.cardetail1.com${pathname}`,
    `https://www.cardetail1.com${pathname}`,
  ];
}

function locationFor(rule, requestUrl) {
  const current = new URL(requestUrl, 'https://cardetail1.com');
  const target = new URL(rule.to, current);
  if (!rule.to.includes('?')) target.search = current.search;
  return target;
}

test('legacy package slugs 301 once to the HTTPS apex page and keep the query', () => {
  const rules = parseRedirects(read('netlify.toml'));
  const query = '?utm_source=gsc&utm_medium=organic&gclid=fictitious-audit-not-a-click&gbraid=fictitious-gbraid&wbraid=fictitious-wbraid';

  for (const legacy of LEGACY) {
    assert.equal(fs.existsSync(path.join(root, legacy.file)), true, legacy.file);
    const stem = legacy.file.replace(/\.html$/, '');
    assert.match(read(legacy.file), new RegExp(`<link rel="canonical" href="${legacy.destination}">`));
    const destinationPath = new URL(legacy.destination).pathname;
    assert.equal(rules.some((rule) => rule.from === destinationPath), false, `${destinationPath} must stay 200`);

    for (const origin of origins(legacy.path)) {
      const rule = rules.find((item) => item.from === origin);
      assert.ok(rule, `missing 301 for ${origin}`);
      assert.equal(rule.status, 301, origin);
      assert.equal(rule.force, true, origin);
      assert.equal(rule.to, legacy.destination, origin);
      assert.equal(rule.to.includes('?'), false, origin);

      const landed = locationFor(rule, `${origin}${query}`);
      assert.equal(landed.origin + landed.pathname, legacy.destination);
      assert.equal(landed.protocol, 'https:');
      assert.equal(landed.hostname, 'cardetail1.com');
      assert.equal(landed.searchParams.get('utm_source'), 'gsc');
      assert.equal(landed.searchParams.get('utm_medium'), 'organic');
      assert.equal(landed.searchParams.get('gclid'), 'fictitious-audit-not-a-click');
      assert.equal(landed.searchParams.get('gbraid'), 'fictitious-gbraid');
      assert.equal(landed.searchParams.get('wbraid'), 'fictitious-wbraid');
      assert.equal(rules.some((item) => item.from === landed.href.split('?')[0]), false);
    }
  }
});

test('app/cms, submit-inquiry, and the mailto path stay 404', () => {
  const rules = parseRedirects(read('netlify.toml'));
  for (const pathname of UNMAPPED) {
    assert.equal(
      rules.some((rule) => rule.from === pathname || rule.from.endsWith(pathname)),
      false,
      pathname,
    );
    assert.equal(fs.existsSync(path.join(root, pathname.replace(/^\//, ''))), false, pathname);
  }
});

test('legacy Search Console paths stay out of the sitemap and canonical tags', () => {
  const sitemap = read('sitemap.xml');
  for (const token of BANNED) assert.equal(sitemap.includes(token), false, `sitemap has ${token}`);

  for (const file of fs.readdirSync(root).filter((name) => name.endsWith('.html'))) {
    const html = read(file);
    assert.equal(html.includes('+mailto+'), false, `${file} still has +mailto+`);
    assert.equal(html.includes("'/submit-inquiry'"), false, `${file} still quotes /submit-inquiry`);
    for (const tag of html.match(/<link rel="canonical" href="[^"]*"/g) || []) {
      for (const token of BANNED) assert.equal(tag.includes(token), false, `${file} ${tag}`);
    }
  }
});
